import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useMutationState, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { inboxRoute } from '../router'
import { useAppContext } from '../lib/app-context'
import { useInboxSnoozes } from '../lib/use-inbox-snoozes'
import { GitHubTokenControls } from '../components/github-token-controls'
import { ApprovalBadge, EMPTY_REVIEW_DRAFT, PullRequestPreview, PullRequestStateBadge } from '../components/pull-request-preview'
import { buildThreadPreview, fetchNotifications, fetchPullRequestDetails, fetchViewer, isViewerRequested, latestReviewAuthors, markThreadRead, parsePullRequestApiUrl, resolveNotificationWebUrl, sortNotificationThreadsOldestFirst } from '../lib/github'
import { formatDateTime, formatRelativeTime, formatStaleness } from '../lib/format'
import { clearPreviewCaches, deleteInboxSnooze, loadInboxSnapshot, loadPreviewSnapshot, saveInboxSnapshot, savePreviewSnapshot } from '../lib/storage'
import type { InboxShow, InboxSnapshot, InboxSnooze, InboxTab, NotificationThread, PullRequestData, ReviewDraft, ThreadPreview } from '../lib/types'

const PREVIEW_CACHE_TTL_MS = 60_000
const TAB_LABELS: Record<InboxTab, string> = { 'for-me': 'For me', watching: 'Watching', drafts: 'Drafts', snoozed: 'Snoozed' }

function activeTabFor(pr?: PullRequestData, viewerLogin?: string): Exclude<InboxTab, 'snoozed'> {
  const isOpen = pr && !pr.merged && pr.state.toUpperCase() === 'OPEN'
  const isAuthor = viewerLogin && pr?.author?.login?.toLowerCase() === viewerLogin.toLowerCase()
  if (isAuthor || (isOpen && isViewerRequested(pr, viewerLogin))) return 'for-me'
  return isOpen && pr.isDraft ? 'drafts' : 'watching'
}

type MarkReadRequest = { thread: NotificationThread; token: string; show: InboxShow; viewerId?: string; restored?: InboxSnooze }

async function fetchInboxSnapshot(token: string, show: InboxShow, pages: number): Promise<InboxSnapshot> {
  const page = await fetchNotifications(token, show, pages)
  const snapshot: InboxSnapshot = { ...page, show, savedAt: new Date().toISOString(), source: 'network' }
  await saveInboxSnapshot(snapshot)
  return snapshot
}

function isRefreshOverdue(savedAt: string | undefined, autoRefreshSeconds: number): boolean {
  if (!savedAt) return true
  const savedAtMs = new Date(savedAt).getTime()
  if (Number.isNaN(savedAtMs)) return true
  return (Date.now() - savedAtMs) >= Math.max(autoRefreshSeconds, 30) * 1000
}

function prStateIconClass(pr?: PullRequestData) {
  if (!pr) return 'pr-state-icon gray'
  if (pr.merged) return 'pr-state-icon purple'
  if (pr.state.toUpperCase() === 'CLOSED') return 'pr-state-icon red'
  if (pr.isDraft) return 'pr-state-icon gray'
  if (pr.state.toUpperCase() === 'OPEN') return 'pr-state-icon green'
  return 'pr-state-icon gray'
}

function prStateIconLabel(pr?: PullRequestData) {
  if (!pr) return 'PR state unknown'
  if (pr.merged) return 'Merged pull request'
  if (pr.state.toUpperCase() === 'CLOSED') return 'Closed pull request'
  if (pr.isDraft) return 'Draft pull request'
  if (pr.state.toUpperCase() === 'OPEN') return 'Open pull request'
  return `${pr.state} pull request`
}

function formatBadgeText(value: string) {
  const normalized = value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : value
}

function notificationReasonTone(reason: string): 'amber' | 'gray' | 'blue' {
  if (reason === 'review_requested') return 'amber'
  if (reason === 'subscribed') return 'gray'
  return 'blue'
}

function formatSubjectType(value: string) {
  if (value === 'PullRequest') return 'Pull Request'
  return formatBadgeText(value)
}

function updateFavicon(hasUnseenChanges: boolean, syncing: boolean) {
  const backgroundFill = hasUnseenChanges ? '%23facc15' : 'white'
  const backgroundStroke = hasUnseenChanges ? '%23a16207' : '%23111827'
  const badge = syncing
    ? "%3Ccircle cx='47' cy='17' r='8' fill='%233b82f6' stroke='white' stroke-width='3'/%3E"
    : ''
  const href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='22' fill='${backgroundFill}' stroke='${backgroundStroke}' stroke-width='4'/%3E%3Cpath d='M32 16c-6.6 0-12 5.4-12 12v7.2c0 2.2-.8 4.4-2.3 6l-2.9 3.2c-.7.8-.1 2 1 2h32.4c1.1 0 1.7-1.2 1-2l-2.9-3.2c-1.5-1.6-2.3-3.8-2.3-6V28c0-6.6-5.4-12-12-12Z' fill='%23111827'/%3E%3Cpath d='M27 49a5 5 0 0 0 10 0' fill='none' stroke='%23111827' stroke-width='3.5' stroke-linecap='round'/%3E${badge}%3C/svg%3E`
  let link = document.querySelector("link[rel='icon']") as HTMLLinkElement | null
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.href = href
}

async function loadThreadPreview(token: string, thread: NotificationThread): Promise<ThreadPreview> {
  const cached = await loadPreviewSnapshot(thread.id)
  const cachedMatches = cached && cached.preview.thread.updatedAt === thread.updatedAt && (cached.preview.thread.lastReadAt ?? null) === (thread.lastReadAt ?? null)
  const hasReviewRequests = !cached?.preview.pullRequest || cached.preview.pullRequest.reviewRequests !== undefined
  if (cached && cachedMatches && hasReviewRequests && (Date.now() - new Date(cached.savedAt).getTime()) <= PREVIEW_CACHE_TTL_MS) {
    return cached.preview
  }

  try {
    const parsed = parsePullRequestApiUrl(thread.subjectUrl)
    let pr: PullRequestData | undefined
    if (thread.subjectType === 'PullRequest' && parsed) {
      pr = await fetchPullRequestDetails(token, parsed.owner, parsed.repo, parsed.number)
    }
    const resolvedWebUrl = await resolveNotificationWebUrl(token, thread)
    const preview = buildThreadPreview({ ...thread, webUrl: resolvedWebUrl || thread.webUrl }, pr)
    await savePreviewSnapshot(thread.id, { savedAt: new Date().toISOString(), preview })
    return preview
  } catch (error) {
    if (cached && cachedMatches) return cached.preview
    throw error
  }
}

function TokenSetupCard() {
  return (
    <div className="card" style={{ padding: 24, maxWidth: 860 }}>
      <div className="stack">
        <h1 className="title" style={{ fontSize: 28 }}>Local-only GitHub token setup</h1>
        <p className="subtitle">GitHub OAuth via minimal auth broker. Final token stays in browser storage only.</p>
        <div className="notice">
          GitHub login endpoints need tiny proxy because they are not browser-CORS friendly. Proxy should stay stateless and open source.
        </div>
        <GitHubTokenControls showConnectedUser={false} />
      </div>
    </div>
  )
}

export function InboxPage() {
  const { token, preferences, setShow } = useAppContext()
  const { show, selected, tab } = inboxRoute.useSearch()
  const isSnoozedTab = tab === 'snoozed'
  const navigate = useNavigate({ from: inboxRoute.fullPath })
  const queryClient = useQueryClient()
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const lastSeenSignatureRef = useRef('')
  const hiddenBaselineSignatureRef = useRef<string | null>(null)
  const [stalenessNow, setStalenessNow] = useState(() => Date.now())
  const [hasUnseenChanges, setHasUnseenChanges] = useState(false)
  const [reviewDrafts, setReviewDrafts] = useState<Readonly<Record<string, ReviewDraft>>>({})

  useEffect(() => { setReviewDrafts({}) }, [token])

  useEffect(() => {
    if (preferences.show !== show) {
      setShow(show)
    }
  }, [preferences.show, setShow, show])

  const viewerQuery = useQuery({
    queryKey: ['viewer', token],
    enabled: Boolean(token),
    staleTime: 10 * 60_000,
    queryFn: () => fetchViewer(token),
  })

  const notificationsQuery = useQuery({
    queryKey: ['notifications', token, show],
    enabled: Boolean(token),
    queryFn: async () => {
      try {
        const pages = queryClient.getQueryData<InboxSnapshot>(['notifications', token, show])?.pagesLoaded ?? 1
        return await fetchInboxSnapshot(token, show, pages)
      } catch (error) {
        const cached = await loadInboxSnapshot(show)
        if (cached) return { ...cached, source: 'cache' as const }
        throw error
      }
    },
  })

  const snoozes = useInboxSnoozes(token, viewerQuery.data, preferences.autoRefreshSeconds, (threadId) => {
    if (selectedThread?.id !== threadId) return
    const index = threads.findIndex((thread) => thread.id === threadId)
    const next = threads[index + 1] ?? threads[index - 1]
    navigate({ search: (prev) => 'tab' in prev && prev.tab === tab ? { ...prev, selected: next?.id ?? '' } : prev, replace: true, resetScroll: false })
  })
  const isInitializingSnoozes = Boolean(token && ((!viewerQuery.isSuccess && !viewerQuery.isError) || snoozes.isLoading))
  const loadedThreads = useMemo(() => {
    const merged = new Map((notificationsQuery.data?.threads ?? []).map((thread) => [thread.id, thread]))
    // Own comments and reviews can wake a PR while GitHub keeps its notification read.
    for (const record of snoozes.restored) {
      const thread = merged.get(record.thread.id) ?? record.thread
      const updatedAt = new Date(thread.updatedAt) > new Date(record.restoredAt) ? thread.updatedAt : record.restoredAt
      merged.set(thread.id, { ...thread, unread: true, lastReadAt: record.snoozedAt, updatedAt })
    }
    return sortNotificationThreadsOldestFirst([...merged.values()])
  }, [notificationsQuery.data?.threads, snoozes.restored])
  const activeThreads = useMemo(() => {
    const hiddenIds = new Set(snoozes.snoozes.map((snooze) => snooze.thread.id))
    return isInitializingSnoozes ? [] : loadedThreads.filter((thread) => !hiddenIds.has(thread.id))
  }, [isInitializingSnoozes, loadedThreads, snoozes.snoozes])
  const snoozedThreads = useMemo(() => sortNotificationThreadsOldestFirst(snoozes.snoozes.map(({ thread, snoozedAt, pullRequest }) => ({
    ...thread, unread: false, lastReadAt: snoozedAt, webUrl: pullRequest.url,
  }))), [snoozes.snoozes])
  const inboxSignature = useMemo(() => activeThreads.map((thread) => `${thread.id}:${thread.updatedAt}:${thread.unread ? 'u' : 'r'}`).join('|'), [activeThreads])
  const candidates = isSnoozedTab ? snoozedThreads : activeThreads
  const pagePreviewQueries = useQueries({
    queries: candidates.map((thread) => ({
      queryKey: isSnoozedTab ? ['preview', token, thread.id, 'snoozed', thread.lastReadAt] : ['preview', token, thread.id],
      enabled: Boolean(token),
      queryFn: () => loadThreadPreview(token, thread),
      staleTime: PREVIEW_CACHE_TTL_MS,
    })),
  })
  const previewByThreadId = new Map(candidates.map((thread, index) => [thread.id, pagePreviewQueries[index]]))
  const threads = isSnoozedTab ? candidates : candidates.filter((thread, index) => {
    if (thread.subjectType !== 'PullRequest') return tab === 'watching'
    const preview = pagePreviewQueries[index]
    return !preview.isPending && activeTabFor(preview.data?.pullRequest, viewerQuery.data?.login) === tab
  })
  const isLoadingThreads = isInitializingSnoozes || (!isSnoozedTab && (notificationsQuery.isLoading || candidates.some((thread, index) => thread.subjectType === 'PullRequest' && pagePreviewQueries[index].isPending)))
  const selectedThread = threads.find((thread) => thread.id === selected) ?? threads[0]
  const selectedThreadId = selectedThread?.id ?? ''
  const previewQuery = selectedThread ? previewByThreadId.get(selectedThread.id) : undefined
  const selectedSnooze = isSnoozedTab ? snoozes.snoozes.find((record) => record.thread.id === selectedThread?.id) : undefined

  useEffect(() => {
    const visibleIds = new Set(threads.map((thread) => thread.id))
    for (const id of Object.keys(rowRefs.current)) {
      if (!visibleIds.has(id)) {
        delete rowRefs.current[id]
      }
    }
  }, [threads])

  useEffect(() => {
    if (!isLoadingThreads && selected !== selectedThreadId) {
      navigate({ search: (prev) => ({ ...prev, selected: selectedThreadId }), replace: true, resetScroll: false })
    }
  }, [isLoadingThreads, navigate, selected, selectedThreadId])

  const loadMoreMutation = useMutation({
    mutationFn: async () => {
      const nextPage = notificationsQuery.data?.nextPage
      if (!nextPage) return
      await queryClient.fetchQuery({
        queryKey: ['notifications', token, show],
        staleTime: 0,
        queryFn: () => fetchInboxSnapshot(token, show, nextPage),
      })
    },
  })

  const refreshMutation = useMutation({
    mutationFn: async () => {
      await clearPreviewCaches()
      await Promise.all([notificationsQuery.refetch(), queryClient.invalidateQueries({ queryKey: ['preview', token] })])
    },
  })

  const runRefresh = (manual = false) => {
    if (refreshMutation.isPending || notificationsQuery.isFetching || snoozes.isSnoozing || queryClient.isMutating({ mutationKey: ['mark-read', token] })) return
    if (manual) {
      snoozes.refresh()
      if (viewerQuery.isError) void viewerQuery.refetch()
    }
    refreshMutation.mutate()
  }

  const pendingReadIds = useMutationState({
    filters: { mutationKey: ['mark-read', token], status: 'pending' },
    select: (mutation) => (mutation.state.variables as MarkReadRequest).thread.id,
  })
  const [readErrors, setReadErrors] = useState<{ request: MarkReadRequest; message: string }[]>([])
  const markReadMutation = useMutation({
    mutationKey: ['mark-read', token],
    scope: { id: 'mark-read' },
    mutationFn: async ({ thread, token: accountToken, viewerId, restored }: MarkReadRequest) => {
      await markThreadRead(accountToken, thread.id)
      if (viewerId && restored) {
        await deleteInboxSnooze(viewerId, restored)
        await queryClient.invalidateQueries({ queryKey: ['inbox-snoozes', viewerId] })
      }
      await clearPreviewCaches()
      return thread
    },
    onMutate: async ({ thread, token: accountToken, show: accountShow }) => {
      setReadErrors((errors) => errors.filter(({ request }) => request.token !== accountToken || request.thread.id !== thread.id))
      await queryClient.cancelQueries({ queryKey: ['notifications', accountToken] })
      const previous = queryClient.getQueryData<InboxSnapshot>(['notifications', accountToken, accountShow])

      if (previous) {
        const currentIndex = threads.findIndex((item) => item.id === thread.id)
        const visibleAfterRead = accountShow === 'unread' ? threads.filter((item) => item.id !== thread.id) : threads
        const nextThreads = accountShow === 'unread'
          ? previous.threads.filter((item) => item.id !== thread.id)
          : previous.threads.map((item) => item.id === thread.id ? { ...item, unread: false, lastReadAt: new Date().toISOString() } : item)
        const next = { ...previous, threads: nextThreads, savedAt: new Date().toISOString() }
        queryClient.setQueryData(['notifications', accountToken, accountShow], next)
        void saveInboxSnapshot(next)

        if (selected === thread.id) {
          const fallback = visibleAfterRead[Math.min(currentIndex, Math.max(0, visibleAfterRead.length - 1))]
          navigate({ search: (prev) => 'tab' in prev && prev.tab === tab ? { ...prev, selected: fallback?.id ?? '' } : prev, replace: true, resetScroll: false })
        }
      }

      return { previousThread: previous?.threads.find((item) => item.id === thread.id) }
    },
    onError: async (error, request, context) => {
      const { token: accountToken, show: accountShow, thread } = request
      setReadErrors((errors) => [...errors, { request, message: error.message }])
      if (context?.previousThread) {
        const previousThread = context.previousThread
        const current = queryClient.getQueryData<InboxSnapshot>(['notifications', accountToken, accountShow])
        if (current) {
          const next = { ...current, threads: sortNotificationThreadsOldestFirst([...current.threads.filter((item) => item.id !== thread.id), previousThread]) }
          queryClient.setQueryData(['notifications', accountToken, accountShow], next)
          await saveInboxSnapshot(next)
        }
      }
    },
    onSuccess: async (_data, { token: accountToken }) => {
      window.setTimeout(() => {
        if (!queryClient.isMutating({ mutationKey: ['mark-read', accountToken] })) {
          void queryClient.invalidateQueries({ queryKey: ['notifications', accountToken] })
        }
      }, 5000)
    },
  })
  const markRead = (thread: NotificationThread) => markReadMutation.mutate({ thread, token, show, viewerId: viewerQuery.data?.id, restored: snoozes.restored.find((record) => record.thread.id === thread.id) })

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStalenessNow(Date.now())
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!token) return
    if (isRefreshOverdue(notificationsQuery.data?.savedAt, preferences.autoRefreshSeconds)) {
      runRefresh()
    }

    const timer = window.setInterval(() => {
      runRefresh()
    }, Math.max(preferences.autoRefreshSeconds, 30) * 1000)
    return () => window.clearInterval(timer)
  }, [notificationsQuery.data?.savedAt, preferences.autoRefreshSeconds, notificationsQuery.isFetching, refreshMutation.isPending, snoozes.isSnoozing, token])

  useEffect(() => {
    if (!selectedThread) return
    rowRefs.current[selectedThread.id]?.focus()
  }, [selectedThread?.id])

  useEffect(() => {
    const onVisibilityOrFocus = () => {
      if (document.hidden) {
        hiddenBaselineSignatureRef.current = inboxSignature
        return
      }
      hiddenBaselineSignatureRef.current = null
      lastSeenSignatureRef.current = inboxSignature
      setHasUnseenChanges(false)
      if (selectedThread) {
        window.setTimeout(() => rowRefs.current[selectedThread.id]?.focus(), 0)
      }
      if (token && isRefreshOverdue(notificationsQuery.data?.savedAt, preferences.autoRefreshSeconds)) {
        runRefresh()
      }
    }

    window.addEventListener('focus', onVisibilityOrFocus)
    document.addEventListener('visibilitychange', onVisibilityOrFocus)
    return () => {
      window.removeEventListener('focus', onVisibilityOrFocus)
      document.removeEventListener('visibilitychange', onVisibilityOrFocus)
    }
  }, [inboxSignature, selectedThread?.id, notificationsQuery.data?.savedAt, preferences.autoRefreshSeconds, notificationsQuery.isFetching, refreshMutation.isPending, snoozes.isSnoozing, token])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag && ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const currentIndex = selectedThread ? threads.findIndex((thread) => thread.id === selectedThread.id) : -1
      const move = (delta: number) => {
        const nextIndex = Math.max(0, Math.min(threads.length - 1, (currentIndex === -1 ? 0 : currentIndex) + delta))
        const next = threads[nextIndex]
        navigate({ search: (prev) => ({ ...prev, selected: next.id }), resetScroll: false })
      }

      if ((event.key === 'j' || event.key === 'ArrowDown') && threads.length) {
        event.preventDefault()
        move(1)
      } else if ((event.key === 'k' || event.key === 'ArrowUp') && threads.length) {
        event.preventDefault()
        move(-1)
      } else if ((event.key === 'o' || event.key === 'O') && threads.length) {
        event.preventDefault()
        const url = previewQuery?.data?.thread.webUrl ?? selectedThread?.webUrl
        if (url) window.open(url, '_blank', 'noopener,noreferrer')
      } else if ((event.key === 'm' || event.key === 'M') && threads.length) {
        event.preventDefault()
        if (selectedThread?.unread && !pendingReadIds.includes(selectedThread.id) && !snoozes.isSnoozing && !notificationsQuery.isFetching) {
          markRead(selectedThread)
        }
      } else if (event.key === 'r' || event.key === 'R' || event.code === 'KeyR') {
        event.preventDefault()
        runRefresh(true)
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [markReadMutation, pendingReadIds, navigate, notificationsQuery.isFetching, previewQuery?.data, refreshMutation, selectedThread, snoozes.isSnoozing, threads])

  useEffect(() => {
    if (!notificationsQuery.dataUpdatedAt || !inboxSignature) return
    if (document.hidden) {
      const baseline = hiddenBaselineSignatureRef.current ?? lastSeenSignatureRef.current
      if (baseline && baseline !== inboxSignature) {
        setHasUnseenChanges(true)
      }
      return
    }
    hiddenBaselineSignatureRef.current = null
    lastSeenSignatureRef.current = inboxSignature
    setHasUnseenChanges(false)
  }, [inboxSignature, notificationsQuery.dataUpdatedAt])

  const staleness = formatStaleness(notificationsQuery.data?.savedAt, preferences.autoRefreshSeconds)

  useEffect(() => {
    updateFavicon(Boolean(token) && hasUnseenChanges, refreshMutation.isPending || notificationsQuery.isFetching)
  }, [token, hasUnseenChanges, refreshMutation.isPending, notificationsQuery.isFetching])

  if (!token) return <TokenSetupCard />

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="space-between" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="title">Inbox</h1>
          <p className="subtitle">GitHub notifications inbox. Exact PR changes, compact triage, local-only token.</p>
          <div className="split">
            <span className={`badge staleness-${staleness.tone}`}>{staleness.label}</span>
            <span className="muted small">Auto refresh: every {Math.floor(preferences.autoRefreshSeconds / 60)} min</span>
            {notificationsQuery.data?.source === 'cache' ? <span className="badge amber">Showing cached snapshot</span> : null}
          </div>
        </div>
        <div className="controls">
          <button className="btn success" onClick={() => runRefresh(true)} disabled={refreshMutation.isPending || notificationsQuery.isFetching || snoozes.isSnoozing || pendingReadIds.length > 0}>Refresh Inbox</button>
        </div>
      </div>

      <div className="controls" role="group" aria-label="Inbox categories">
        {(Object.keys(TAB_LABELS) as InboxTab[]).map((category) => (
          <button key={category} type="button" className={category === tab ? 'btn' : 'btn secondary'} aria-pressed={category === tab}
            onClick={() => { if (category !== tab) navigate({ search: (prev) => ({ ...prev, tab: category, selected: '' }), resetScroll: false }) }}>
            {TAB_LABELS[category]}{category === 'snoozed' ? ` (${snoozes.snoozes.length})` : ''}
          </button>
        ))}
      </div>
      <div className="controls">
        {isSnoozedTab ? (
          <button type="button" className="btn secondary" disabled={!snoozes.snoozes.length || snoozes.isRestoring} onClick={snoozes.clearAll}>Clear all</button>
        ) : (
          <label className="split">
            <span>Show:</span>
            <select className="form-control" value={show} onChange={(event) => navigate({ search: (prev) => ({ ...prev, show: event.target.value === 'all' ? 'all' : 'unread' }) })}>
              <option value="unread">Unread</option>
              <option value="all">All active</option>
            </select>
          </label>
        )}
        <span className="muted small">{threads.length} loaded</span>
        <span className="muted small">Keys: j/k move, o open GitHub, {isSnoozedTab ? '' : 'm mark read, '}r refresh.</span>
      </div>

      {notificationsQuery.isError ? <div className="error">{notificationsQuery.error instanceof Error ? notificationsQuery.error.message : 'Failed to load notifications'}</div> : null}

      {viewerQuery.isError ? <div className="notice" role="status">Could not identify your account. Inbox snoozing is unavailable. Refresh Inbox to retry.</div> : null}
      {snoozes.error ? <div className="error" role="alert">{snoozes.error}</div> : null}
      {isSnoozedTab ? <div className="notice">Snoozes end on a new comment, submitted review, or review request. Clear all ends snoozes without changing GitHub read status.</div> : null}

      {!isSnoozedTab && readErrors.filter(({ request }) => request.token === token).map(({ request, message }) => (
        <div key={request.thread.id} className="error controls" role="alert">
          <span>Could not mark “{request.thread.subjectTitle}” as read. {message}</span>
          <button type="button" className="btn secondary" disabled={notificationsQuery.isFetching} onClick={() => markReadMutation.mutate(request)}>Retry</button>
        </div>
      ))}

      <div className="grid-main">
        <div className="inbox-list">
          {isLoadingThreads && !threads.length ? <div className="card empty loading">Loading inbox…</div> : null}
          {!isLoadingThreads && !threads.length ? <div className="card empty">{isSnoozedTab ? 'No snoozed threads.' : 'No inbox threads in this tab.'}</div> : null}
          {threads.map((thread) => {
            const prefetchedPreview = previewByThreadId.get(thread.id)?.data
            const pr = prefetchedPreview?.pullRequest
            const isClosed = Boolean(pr && !pr.merged && pr.state.toUpperCase() === 'CLOSED')
            const isDraft = Boolean(pr?.isDraft && !pr.merged && pr.state.toUpperCase() === 'OPEN')
            const viewerLogin = viewerQuery.data?.login
            const approvedByViewer = Boolean(viewerLogin && pr && latestReviewAuthors(pr, 'APPROVED').includes(viewerLogin))
            const hasApproval = approvedByViewer || pr?.reviewDecision === 'APPROVED'
            const reasonTone = notificationReasonTone(thread.reason)
            return (
              <div key={thread.id} className="inbox-row">
                <button
                  type="button"
                  ref={(value) => { rowRefs.current[thread.id] = value }}
                  className={`card inbox-item reason-${reasonTone} ${isClosed ? 'pr-closed' : isDraft ? 'pr-draft' : ''} ${selectedThread?.id === thread.id ? 'selected' : ''}`}
                  onClick={() => {
                    if (selectedThread?.id === thread.id) return
                    startTransition(() => {
                      navigate({ search: (prev) => ({ ...prev, selected: thread.id }), resetScroll: false })
                    })
                  }}
                >
                  <div className="stack" style={{ gap: 6, textAlign: 'left' }}>
                    <div className="split">
                      {thread.subjectType === 'PullRequest' ? <span className={prStateIconClass(pr)} title={prStateIconLabel(pr)} aria-label={prStateIconLabel(pr)} /> : null}
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{thread.repoFullName}</span>
                      {snoozes.restored.some((record) => record.thread.id === thread.id) ? <span className="badge blue">Woken locally</span> : null}
                      {thread.unread ? <span className="unread-dot" role="img" aria-label="Unread" title="Unread" /> : null}
                      <span className={`badge ${reasonTone}`}>{thread.reason === 'subscribed' ? 'Watching / subscribed' : formatBadgeText(thread.reason)}</span>
                      {isClosed ? <span className="badge red">Closed</span> : isDraft ? <span className="badge gray">Draft</span> : pr?.state.toUpperCase() === 'OPEN' ? <span className="badge green">Open</span> : null}
                      {hasApproval ? <ApprovalBadge approvedByViewer={approvedByViewer} /> : null}
                      {thread.subjectType !== 'PullRequest' ? <span className="badge gray">{formatSubjectType(thread.subjectType)}</span> : null}
                    </div>
                    <div className="inbox-item-title">{thread.subjectTitle}</div>
                    <time className="muted small" dateTime={thread.updatedAt} title={formatDateTime(thread.updatedAt)}>Updated {formatRelativeTime(thread.updatedAt, stalenessNow)}</time>
                  </div>
                </button>
                {thread.unread ? (
                  <button
                    type="button"
                    className="btn mark-read-btn"
                    onClick={() => markRead(thread)}
                    disabled={pendingReadIds.includes(thread.id) || snoozes.isSnoozing || notificationsQuery.isFetching}
                    aria-label={`Mark ${thread.subjectTitle} as read`}
                    title="Mark read"
                  >
                    ✓
                  </button>
                ) : null}
              </div>
            )
          })}
          {!isSnoozedTab && notificationsQuery.data?.nextPage ? (
            <button type="button" className="btn secondary" disabled={notificationsQuery.isFetching || pendingReadIds.length > 0 || snoozes.isSnoozing || loadMoreMutation.isPending} onClick={() => loadMoreMutation.mutate()}>
              {loadMoreMutation.isPending ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </div>

        <div className="card preview-pane">
          {!selectedThread ? <div className="empty">Select thread to preview.</div> : null}
          {selectedThread ? (
            <PreviewSection
              key={selectedThread.id}
              thread={selectedThread}
              reviewDraft={reviewDrafts[selectedThread.id] ?? EMPTY_REVIEW_DRAFT}
              onReviewDraftChange={(draft: ReviewDraft): void => setReviewDrafts((current) => ({ ...current, [selectedThread.id]: draft }))}
              preview={previewQuery?.data}
              viewerLogin={viewerQuery.data?.login}
              isLoading={Boolean(previewQuery?.isLoading)}
              error={previewQuery?.error instanceof Error ? previewQuery.error.message : ''}
              onMarkRead={() => markRead(selectedThread)}
              markingRead={pendingReadIds.includes(selectedThread.id)}
              onSnooze={isSnoozedTab ? undefined : () => { if (previewQuery?.data?.pullRequest) snoozes.snooze(selectedThread, previewQuery.data.pullRequest) }}
              onRestore={selectedSnooze ? () => snoozes.restore(selectedSnooze) : undefined}
              restoring={snoozes.isRestoring}
              canSnooze={snoozes.canSnooze && pendingReadIds.length === 0}
              snoozing={snoozes.isSnoozing}
              syncing={notificationsQuery.isFetching}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function PreviewSection({
  thread,
  preview,
  viewerLogin,
  isLoading,
  error,
  onMarkRead,
  markingRead,
  onSnooze,
  onRestore,
  restoring,
  canSnooze,
  snoozing,
  syncing,
  reviewDraft,
  onReviewDraftChange,
}: {
  thread: NotificationThread
  preview?: ThreadPreview
  viewerLogin?: string
  isLoading: boolean
  error: string
  onMarkRead: () => void
  markingRead: boolean
  onSnooze?: () => void
  onRestore?: () => void
  restoring: boolean
  canSnooze: boolean
  snoozing: boolean
  syncing: boolean
  reviewDraft: ReviewDraft
  onReviewDraftChange: (draft: ReviewDraft) => void
}) {
  const pr = preview?.pullRequest

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="controls" role="group" aria-label="Inbox actions" style={{ justifyContent: 'flex-end' }}>
          {thread.unread ? <button className="btn warn" onClick={onMarkRead} disabled={markingRead || snoozing || syncing}>{markingRead ? 'Marking…' : 'Mark read'}</button> : null}
          {pr && onSnooze ? <button type="button" className="btn secondary" style={{ minWidth: 200 }} onClick={onSnooze} disabled={!canSnooze || syncing}>{snoozing ? 'Snoozing…' : 'Mark read and Snooze'}</button> : null}
          {onRestore ? <button type="button" className="btn secondary" onClick={onRestore} disabled={restoring} aria-label={`Restore ${thread.subjectTitle}`}>Restore</button> : null}
          {((preview?.thread.webUrl ?? thread.webUrl) || undefined) ? <a className="btn" href={(preview?.thread.webUrl ?? thread.webUrl) || undefined} target="_blank" rel="noreferrer">Open in GitHub</a> : null}
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <div className="split small muted">
            <span style={{ fontWeight: 700, color: '#111827' }}>{thread.repoFullName}{pr ? ` #${pr.number}` : ''}</span>
            {pr ? <PullRequestStateBadge pullRequest={pr} /> : null}
            <span>Updated {formatDateTime(thread.updatedAt)}</span>
          </div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{thread.subjectTitle}</div>
        </div>
      </div>

      {isLoading ? <div className="loading">Loading preview…</div> : null}
      {error ? <div className="error">{error}</div> : null}

      {preview ? (
        pr ? (
          <PullRequestPreview
            pullRequest={pr}
            changesSince={thread.lastReadAt ?? null}
            viewerLogin={viewerLogin}
            reviewDraft={reviewDraft}
            onReviewDraftChange={onReviewDraftChange}
          />
        ) : (
          <div className="notice">No enriched PR preview yet for this notification. Works best for pull request notifications with accessible subject URL.</div>
        )
      ) : null}
    </div>
  )
}
