import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { inboxRoute } from '../router'
import { useAppContext } from '../lib/app-context'
import { GitHubTokenControls } from '../components/github-token-controls'
import { buildThreadPreview, fetchNotifications, fetchPullRequestDetails, fetchPullRequestFiles, markThreadRead, parsePullRequestApiUrl, resolveNotificationWebUrl, submitPullRequestReview } from '../lib/github'
import { formatDateTime, formatShortDateTime, formatStaleness, truncateText } from '../lib/format'
import { clearPreviewCaches, loadInboxSnapshot, loadPreviewSnapshot, saveInboxSnapshot, savePreviewSnapshot } from '../lib/storage'
import type { InboxShow, NotificationThread, PRFile, PullRequestData, ThreadPreview } from '../lib/types'

const PREVIEW_CACHE_TTL_MS = 60_000

function isRefreshOverdue(savedAt: string | undefined, autoRefreshSeconds: number): boolean {
  if (!savedAt) return true
  const savedAtMs = new Date(savedAt).getTime()
  if (Number.isNaN(savedAtMs)) return true
  return (Date.now() - savedAtMs) >= Math.max(autoRefreshSeconds, 30) * 1000
}

function activityBadge(value: string) {
  return <span className="badge blue">{value}</span>
}

function stateBadge(pr?: PullRequestData) {
  if (!pr) return <span className="badge gray">Unknown</span>
  if (pr.merged) return <span className="badge purple">MERGED</span>
  if (pr.state.toUpperCase() === 'OPEN') return <span className="badge green">OPEN</span>
  if (pr.state.toUpperCase() === 'CLOSED') return <span className="badge red">CLOSED</span>
  return <span className="badge gray">{pr.state}</span>
}

function reviewDecisionBadge(value?: string | null) {
  if (value === 'APPROVED') return <span className="badge green">Approved</span>
  if (value === 'CHANGES_REQUESTED') return <span className="badge red">Changes requested</span>
  if (value === 'REVIEW_REQUIRED') return <span className="badge amber">Review required</span>
  if (!value) return <span className="badge gray">None</span>
  return <span className="badge gray">{value}</span>
}

function reviewStateBadge(value?: string | null) {
  if (value === 'APPROVED') return <span className="badge green">APPROVED</span>
  if (value === 'CHANGES_REQUESTED') return <span className="badge red">CHANGES_REQUESTED</span>
  if (value === 'COMMENTED') return <span className="badge blue">COMMENTED</span>
  if (value === 'REVIEW_REQUIRED') return <span className="badge amber">REVIEW_REQUIRED</span>
  if (!value) return null
  return <span className="badge gray">{value}</span>
}

function latestReviewAuthors(pr: PullRequestData, state: 'APPROVED' | 'CHANGES_REQUESTED'): string[] {
  const latestByAuthor = new Map<string, { state: string; createdAt: string }>()

  for (const review of pr.reviews.nodes) {
    const login = review.author?.login?.trim()
    if (!login) continue
    const existing = latestByAuthor.get(login)
    if (!existing || new Date(review.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      latestByAuthor.set(login, { state: review.state, createdAt: review.createdAt })
    }
  }

  return [...latestByAuthor.entries()]
    .filter(([, review]) => review.state === state)
    .map(([login]) => login)
    .sort((a, b) => a.localeCompare(b))
}

function patchLineClass(line: string) {
  if (line.startsWith('@@')) return 'patch-line patch-line-hunk'
  if (line.startsWith('+')) return 'patch-line patch-line-add'
  if (line.startsWith('-')) return 'patch-line patch-line-del'
  return 'patch-line'
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
  const { token, clearToken, preferences, setShow } = useAppContext()
  const { show, selected } = inboxRoute.useSearch() as { show: InboxShow; selected: string }
  const navigate = useNavigate({ from: inboxRoute.fullPath })
  const queryClient = useQueryClient()
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const lastSeenSignatureRef = useRef('')
  const hiddenBaselineSignatureRef = useRef<string | null>(null)
  const [stalenessNow, setStalenessNow] = useState(() => Date.now())
  const [hasUnseenChanges, setHasUnseenChanges] = useState(false)

  useEffect(() => {
    if (preferences.show !== show) {
      setShow(show)
    }
  }, [preferences.show, setShow, show])

  const notificationsQuery = useQuery({
    queryKey: ['notifications', token, show],
    enabled: Boolean(token),
    queryFn: async () => {
      try {
        const threads = await fetchNotifications(token, show)
        const snapshot = { show, threads, savedAt: new Date().toISOString(), source: 'network' as const }
        await saveInboxSnapshot(snapshot)
        return snapshot
      } catch (error) {
        const cached = await loadInboxSnapshot(show)
        if (cached) return { ...cached, source: 'cache' as const }
        throw error
      }
    },
  })

  const threads = notificationsQuery.data?.threads ?? []
  const inboxSignature = useMemo(() => threads.map((thread) => `${thread.id}:${thread.updatedAt}:${thread.unread ? 'u' : 'r'}`).join('|'), [threads])

  useEffect(() => {
    const visibleIds = new Set(threads.map((thread) => thread.id))
    for (const id of Object.keys(rowRefs.current)) {
      if (!visibleIds.has(id)) {
        delete rowRefs.current[id]
      }
    }
  }, [threads])

  useEffect(() => {
    if (!threads.length) {
      if (selected) navigate({ search: (prev) => ({ ...prev, selected: '' }), replace: true })
      return
    }
    if (!selected || !threads.some((thread) => thread.id === selected)) {
      navigate({ search: (prev) => ({ ...prev, selected: threads[0].id }), replace: true })
    }
  }, [navigate, selected, threads])

  const selectedThread = useMemo(() => threads.find((thread) => thread.id === selected) ?? threads[0], [selected, threads])

  const previewQuery = useQuery({
    queryKey: ['preview', token, selectedThread?.id],
    enabled: Boolean(token && selectedThread),
    queryFn: async () => {
      if (!selectedThread) throw new Error('Missing selected thread')

      const cached = await loadPreviewSnapshot(selectedThread.id)
      const cachedMatches = cached && cached.preview.thread.updatedAt === selectedThread.updatedAt && (cached.preview.thread.lastReadAt ?? null) === (selectedThread.lastReadAt ?? null)
      if (cached && cachedMatches && (Date.now() - new Date(cached.savedAt).getTime()) <= PREVIEW_CACHE_TTL_MS) {
        return cached.preview
      }

      try {
        const parsed = parsePullRequestApiUrl(selectedThread.subjectUrl)
        let pr: PullRequestData | undefined
        if (selectedThread.subjectType === 'PullRequest' && parsed) {
          pr = await fetchPullRequestDetails(token, parsed.owner, parsed.repo, parsed.number)
        }
        const resolvedWebUrl = await resolveNotificationWebUrl(token, selectedThread)
        const preview = buildThreadPreview({ ...selectedThread, webUrl: resolvedWebUrl || selectedThread.webUrl }, pr)
        await savePreviewSnapshot(selectedThread.id, { savedAt: new Date().toISOString(), preview })
        return preview
      } catch (error) {
        if (cached && cachedMatches) return cached.preview
        throw error
      }
    },
  })

  const refreshMutation = useMutation({
    mutationFn: async () => {
      await clearPreviewCaches()
      return notificationsQuery.refetch()
    },
  })

  const runRefresh = () => {
    if (refreshMutation.isPending || notificationsQuery.isFetching) return
    refreshMutation.mutate()
  }

  const markReadMutation = useMutation({
    mutationFn: async (thread: NotificationThread) => {
      await markThreadRead(token, thread.id)
      await clearPreviewCaches()
      return thread
    },
    onMutate: async (thread) => {
      await queryClient.cancelQueries({ queryKey: ['notifications', token] })
      const previous = queryClient.getQueryData<{ show: InboxShow; threads: NotificationThread[]; savedAt: string; source: 'network' | 'cache' }>(['notifications', token, show])

      if (previous) {
        const currentIndex = previous.threads.findIndex((item) => item.id === thread.id)
        const nextThreads = show === 'unread'
          ? previous.threads.filter((item) => item.id !== thread.id)
          : previous.threads.map((item) => item.id === thread.id ? { ...item, unread: false, lastReadAt: new Date().toISOString() } : item)
        const next = { ...previous, threads: nextThreads, savedAt: new Date().toISOString() }
        queryClient.setQueryData(['notifications', token, show], next)
        void saveInboxSnapshot(next)

        if (selected === thread.id) {
          const fallback = nextThreads[Math.min(currentIndex, Math.max(0, nextThreads.length - 1))]
          navigate({ search: (prev) => ({ ...prev, selected: fallback?.id ?? '' }), replace: true })
        }
      }

      return { previous }
    },
    onError: async (_error, _thread, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['notifications', token, show], context.previous)
        await saveInboxSnapshot(context.previous)
      }
    },
    onSuccess: async () => {
      window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['notifications', token] })
      }, 5000)
    },
  })

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
  }, [notificationsQuery.data?.savedAt, preferences.autoRefreshSeconds, notificationsQuery.isFetching, refreshMutation.isPending, token])

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
  }, [inboxSignature, selectedThread?.id, notificationsQuery.data?.savedAt, preferences.autoRefreshSeconds, notificationsQuery.isFetching, refreshMutation.isPending, token])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag && ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const currentIndex = selectedThread ? threads.findIndex((thread) => thread.id === selectedThread.id) : -1
      const move = (delta: number) => {
        const nextIndex = Math.max(0, Math.min(threads.length - 1, (currentIndex === -1 ? 0 : currentIndex) + delta))
        const next = threads[nextIndex]
        navigate({ search: (prev) => ({ ...prev, selected: next.id }) })
      }

      if ((event.key === 'j' || event.key === 'ArrowDown') && threads.length) {
        event.preventDefault()
        move(1)
      } else if ((event.key === 'k' || event.key === 'ArrowUp') && threads.length) {
        event.preventDefault()
        move(-1)
      } else if ((event.key === 'o' || event.key === 'O') && threads.length) {
        event.preventDefault()
        const url = (previewQuery.data?.thread.id === selectedThread?.id ? previewQuery.data.thread.webUrl : undefined) ?? selectedThread?.webUrl
        if (url) window.open(url, '_blank', 'noopener,noreferrer')
      } else if ((event.key === 'm' || event.key === 'M') && threads.length) {
        event.preventDefault()
        if (selectedThread && selectedThread.unread) {
          markReadMutation.mutate(selectedThread)
        }
      } else if (event.key === 'r' || event.key === 'R' || event.code === 'KeyR') {
        event.preventDefault()
        runRefresh()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [markReadMutation, navigate, notificationsQuery.isFetching, previewQuery.data, refreshMutation, selectedThread, threads])

  if (!token) {
    return <TokenSetupCard />
  }

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

  void stalenessNow
  const staleness = formatStaleness(notificationsQuery.data?.savedAt, preferences.autoRefreshSeconds)

  useEffect(() => {
    updateFavicon(Boolean(token) && hasUnseenChanges, refreshMutation.isPending || notificationsQuery.isFetching)
  }, [token, hasUnseenChanges, refreshMutation.isPending, notificationsQuery.isFetching])

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
          <button className="btn success" onClick={runRefresh} disabled={refreshMutation.isPending || notificationsQuery.isFetching}>Refresh Inbox</button>
          <button className="btn secondary" onClick={clearToken}>Clear local token</button>
        </div>
      </div>

      <div className="controls">
        <label className="split">
          <span>Show:</span>
          <select className="form-control" value={show} onChange={(event) => navigate({ search: (prev) => ({ ...prev, show: (event.target.value === 'all' ? 'all' : 'unread') as InboxShow }) })}>
            <option value="unread">Unread</option>
            <option value="all">All active</option>
          </select>
        </label>
        <span className="muted small">Keys: j/k move, o open GitHub, m mark read, r refresh.</span>
      </div>

      {notificationsQuery.isError ? <div className="error">{notificationsQuery.error instanceof Error ? notificationsQuery.error.message : 'Failed to load notifications'}</div> : null}

      <div className="grid-main">
        <div className="inbox-list">
          {notificationsQuery.isLoading ? <div className="card empty loading">Loading inbox…</div> : null}
          {!notificationsQuery.isLoading && !threads.length ? <div className="card empty">No inbox threads found.</div> : null}
          {threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              ref={(value) => { rowRefs.current[thread.id] = value }}
              className={`card inbox-item ${selectedThread?.id === thread.id ? 'selected' : ''}`}
              onClick={() => {
                if (selectedThread?.id === thread.id) return
                startTransition(() => {
                  navigate({ search: (prev) => ({ ...prev, selected: thread.id }) })
                })
              }}
            >
              <div className="space-between" style={{ alignItems: 'flex-start' }}>
                <div className="stack" style={{ gap: 6, textAlign: 'left' }}>
                  <div className="split">
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{thread.repoFullName}</span>
                    <span className={`badge ${thread.unread ? 'blue' : 'gray'}`}>{thread.unread ? 'Unread' : 'Read'}</span>
                    <span className="badge amber">{thread.reason}</span>
                    <span className="badge gray">{thread.subjectType}</span>
                  </div>
                  <div className="inbox-item-title">{thread.subjectTitle}</div>
                  <div className="muted small">Updated {formatDateTime(thread.updatedAt)}</div>
                </div>
                {thread.unread ? (
                  <button
                    type="button"
                    className="btn mark-read-btn"
                    onClick={(event) => {
                      event.stopPropagation()
                      markReadMutation.mutate(thread)
                    }}
                    disabled={markReadMutation.isPending}
                    aria-label={`Mark ${thread.subjectTitle} as read`}
                    title="Mark read"
                  >
                    ✓
                  </button>
                ) : null}
              </div>
            </button>
          ))}
        </div>

        <div className="card preview-pane">
          {!selectedThread ? <div className="empty">Select thread to preview.</div> : null}
          {selectedThread ? (
            <PreviewSection
              thread={selectedThread}
              preview={previewQuery.data}
              isLoading={previewQuery.isLoading}
              error={previewQuery.error instanceof Error ? previewQuery.error.message : ''}
              onMarkRead={() => markReadMutation.mutate(selectedThread)}
              markingRead={markReadMutation.isPending}
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
  isLoading,
  error,
  onMarkRead,
  markingRead,
}: {
  thread: NotificationThread
  preview?: ThreadPreview
  isLoading: boolean
  error: string
  onMarkRead: () => void
  markingRead: boolean
}) {
  const { token, preferences } = useAppContext()
  const queryClient = useQueryClient()
  const pr = preview?.pullRequest
  const [filesMode, setFilesMode] = useState<'files' | 'lines'>('files')
  const [reviewMode, setReviewMode] = useState<'approve' | 'comment' | 'request_changes' | null>(null)
  const [reviewBody, setReviewBody] = useState('')
  const [reviewError, setReviewError] = useState('')
  const parsed = useMemo(() => parsePullRequestApiUrl(thread.subjectUrl), [thread.subjectUrl])
  const defaultFilesMode = useMemo<'files' | 'lines'>(() => {
    if (!pr) return 'files'
    return (pr.additions + pr.deletions) <= preferences.autoOpenLinesThreshold ? 'lines' : 'files'
  }, [pr, preferences.autoOpenLinesThreshold])

  const patchesQuery = useQuery({
    queryKey: ['pr-files', thread.id],
    enabled: Boolean(filesMode === 'lines' && pr && parsed),
    staleTime: PREVIEW_CACHE_TTL_MS,
    queryFn: () => fetchPullRequestFiles(token, parsed!.owner, parsed!.repo, parsed!.number),
  })

  const filesWithPatches = useMemo(() => {
    if (!pr) return [] as PRFile[]
    if (!patchesQuery.data?.length) return pr.files.nodes
    const patchByPath = new Map(patchesQuery.data.map((file) => [file.path, file]))
    return pr.files.nodes.map((file) => ({
      ...file,
      patch: patchByPath.get(file.path)?.patch ?? null,
      blobUrl: patchByPath.get(file.path)?.blobUrl ?? null,
    }))
  }, [patchesQuery.data, pr])

  const approvedBy = useMemo(() => pr ? latestReviewAuthors(pr, 'APPROVED') : [], [pr])
  const changesRequestedBy = useMemo(() => pr ? latestReviewAuthors(pr, 'CHANGES_REQUESTED') : [], [pr])

  const reviewMutation = useMutation({
    mutationFn: async ({ event, body }: { event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'; body: string }) => {
      if (!pr) throw new Error('No pull request loaded')
      await submitPullRequestReview(token, pr.id, event, body)
      await clearPreviewCaches()
    },
    onSuccess: async () => {
      setReviewError('')
      setReviewBody('')
      setReviewMode(null)
      await queryClient.invalidateQueries({ queryKey: ['preview', token, thread.id] })
      await queryClient.invalidateQueries({ queryKey: ['notifications', token] })
    },
    onError: (mutationError) => {
      setReviewError(mutationError instanceof Error ? mutationError.message : 'Failed to submit review')
    },
  })

  useEffect(() => {
    setFilesMode(defaultFilesMode)
  }, [defaultFilesMode, thread.id])

  useEffect(() => {
    setReviewMode(null)
    setReviewBody('')
    setReviewError('')
  }, [thread.id])

  const submitReview = (mode: 'approve' | 'comment' | 'request_changes') => {
    const normalizedBody = reviewBody.trim()
    if ((mode === 'comment' || mode === 'request_changes') && !normalizedBody) {
      setReviewError(mode === 'comment' ? 'Comment body required.' : 'Request changes body required.')
      return
    }
    setReviewError('')
    reviewMutation.mutate({
      event: mode === 'approve' ? 'APPROVE' : mode === 'comment' ? 'COMMENT' : 'REQUEST_CHANGES',
      body: normalizedBody,
    })
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="space-between" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div className="stack" style={{ gap: 4 }}>
          <div className="split small muted">
            <span style={{ fontWeight: 700, color: '#111827' }}>{thread.repoFullName}{pr ? ` #${pr.number}` : ''}</span>
            <span>Updated {formatDateTime(thread.updatedAt)}</span>
          </div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{thread.subjectTitle}</div>
        </div>
        <div className="controls">
          {thread.unread ? <button className="btn warn" onClick={onMarkRead} disabled={markingRead}>{markingRead ? 'Marking…' : 'Mark read'}</button> : null}
          {((preview?.thread.webUrl ?? thread.webUrl) || undefined) ? <a className="btn" href={(preview?.thread.webUrl ?? thread.webUrl) || undefined} target="_blank" rel="noreferrer">Open in GitHub</a> : null}
        </div>
      </div>

      {isLoading ? <div className="loading">Loading preview…</div> : null}
      {error ? <div className="error">{error}</div> : null}

      {preview ? (
        <>
          <div className="table-wrap">
            <div className="table-header space-between" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div className="stack" style={{ gap: 6 }}>
                <div style={{ fontWeight: 700 }}>New activity{preview.changesSinceIsAll ? '' : ' since last read'}</div>
                <div className="split">
                  {activityBadge(`${preview.commitsCount} commit${preview.commitsCount === 1 ? '' : 's'}`)}
                  {activityBadge(`${preview.commentsCount} comment${preview.commentsCount === 1 ? '' : 's'}`)}
                  {activityBadge(`${preview.reviewsCount} review${preview.reviewsCount === 1 ? '' : 's'}`)}
                </div>
              </div>
              <div className="muted tiny">{preview.changesSince ? formatDateTime(preview.changesSince) : 'All visible activity'}</div>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Who</th>
                    <th>Summary</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.events.length ? preview.events.map((event, index) => (
                    <tr key={`${event.type}-${event.createdAt}-${index}`}>
                      <td>
                        <div className="stack" style={{ gap: 4 }}>
                          <span className="badge blue">{event.type}</span>
                          {reviewStateBadge(event.state)}
                        </div>
                      </td>
                      <td>{event.author || '—'}</td>
                      <td>
                        <div>{truncateText(event.body, 90)}</div>
                        <div className="split tiny muted">
                          {event.path ? <span>{truncateText(event.path, 36)}</span> : null}
                          {event.commitSHA ? <code>{truncateText(event.commitSHA, 10)}</code> : null}
                        </div>
                      </td>
                      <td className="tiny muted">{formatShortDateTime(event.createdAt)}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={4} className="muted">No new PR activity in fetched window.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {pr ? (
            <div className="summary-box">
              <div className="summary-box-header">
                <div style={{ fontWeight: 700 }}>PR summary</div>
              </div>
              <div className="summary-box-body">
                {pr.body.trim() ? <div style={{ marginBottom: 12, fontSize: 14, lineHeight: 1.5, color: '#4b5563' }}>{truncateText(pr.body.replace(/\s+/g, ' ').trim(), 256)}</div> : null}
                <div className="summary-line"><span className="muted">Author</span><span>{pr.author?.login || '—'}</span></div>
                <div className="summary-line"><span className="muted">Files changed</span><span>{pr.changedFiles}</span></div>
                <div className="summary-line"><span className="muted">Lines</span><span><span style={{ color: '#166534', fontWeight: 700 }}>+{pr.additions}</span> <span className="muted">/</span> <span style={{ color: '#991b1b', fontWeight: 700 }}>-{pr.deletions}</span></span></div>
                <div className="summary-line"><span className="muted">State</span>{stateBadge(pr)}</div>
                <div className="summary-line">
                  <span className="muted">Review decision</span>
                  {reviewDecisionBadge(pr.reviewDecision)}
                  {pr.reviewDecision === 'APPROVED' && approvedBy.length ? <span className="muted small">by {approvedBy.join(', ')}</span> : null}
                  {pr.reviewDecision === 'CHANGES_REQUESTED' && changesRequestedBy.length ? <span className="muted small">by {changesRequestedBy.join(', ')}</span> : null}
                </div>
                {pr.state.toUpperCase() === 'OPEN' && !pr.merged ? (
                  <div className="review-actions">
                    <div className="controls">
                      <button type="button" className={`btn ${reviewMode === 'approve' ? '' : 'secondary'}`} onClick={() => setReviewMode('approve')}>Approve</button>
                      <button type="button" className={`btn ${reviewMode === 'comment' ? '' : 'secondary'}`} onClick={() => setReviewMode('comment')}>Comment</button>
                      <button type="button" className={`btn ${reviewMode === 'request_changes' ? 'warn' : 'secondary'}`} onClick={() => setReviewMode('request_changes')}>Request changes</button>
                    </div>
                    {reviewMode ? (
                      <div className="stack" style={{ marginTop: 10 }}>
                        <textarea
                          className="form-control"
                          value={reviewBody}
                          onChange={(event) => setReviewBody(event.target.value)}
                          placeholder={reviewMode === 'approve' ? 'Optional approval note' : reviewMode === 'comment' ? 'Required review comment' : 'Required change request'}
                        />
                        <div className="controls">
                          <button
                            type="button"
                            className={`btn ${reviewMode === 'request_changes' ? 'warn' : reviewMode === 'approve' ? 'success' : ''}`}
                            onClick={() => submitReview(reviewMode)}
                            disabled={reviewMutation.isPending}
                          >
                            {reviewMutation.isPending ? 'Submitting…' : reviewMode === 'approve' ? 'Submit approval' : reviewMode === 'comment' ? 'Submit comment' : 'Submit change request'}
                          </button>
                          <button type="button" className="btn secondary" onClick={() => { setReviewMode(null); setReviewBody(''); setReviewError('') }} disabled={reviewMutation.isPending}>Cancel</button>
                        </div>
                        {reviewError ? <div className="error">{reviewError}</div> : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="stack" style={{ marginTop: 12 }}>
                  <div className="space-between" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <div className="small muted" style={{ fontWeight: 700 }}>Files modified</div>
                    <div className="controls">
                      <button type="button" className={`btn ${filesMode === 'files' ? '' : 'secondary'}`} onClick={() => setFilesMode('files')}>Per-file</button>
                      <button type="button" className={`btn ${filesMode === 'lines' ? '' : 'secondary'}`} onClick={() => setFilesMode('lines')}>Show lines</button>
                    </div>
                  </div>
                  {filesMode === 'files' ? (
                    <div className="file-list">
                      {pr.files.nodes.length ? pr.files.nodes.map((file) => (
                        <div className="file-item" key={file.path}>
                          <div className="stack" style={{ gap: 2 }}>
                            <div>{file.path}</div>
                            <div className="tiny muted">{file.changeType}</div>
                          </div>
                          <div className="tiny"><span style={{ color: '#166534', fontWeight: 700 }}>+{file.additions}</span> <span className="muted">/</span> <span style={{ color: '#991b1b', fontWeight: 700 }}>-{file.deletions}</span></div>
                        </div>
                      )) : <div className="muted small">No file list loaded.</div>}
                    </div>
                  ) : (
                    <div className="patch-list">
                      {patchesQuery.isLoading ? <div className="loading">Loading file patches…</div> : null}
                      {filesWithPatches.length ? filesWithPatches.map((file) => (
                        <div className="patch-item" key={file.path}>
                          <div className="file-item" style={{ border: 'none', padding: 0 }}>
                            <div className="stack" style={{ gap: 2 }}>
                              <div>{file.path}</div>
                              <div className="tiny muted">{file.changeType}</div>
                            </div>
                            <div className="tiny"><span style={{ color: '#166534', fontWeight: 700 }}>+{file.additions}</span> <span className="muted">/</span> <span style={{ color: '#991b1b', fontWeight: 700 }}>-{file.deletions}</span></div>
                          </div>
                          {file.patch ? (
                            <div className="patch-view">
                              {file.patch.split('\n').map((line, index) => (
                                <div key={`${file.path}-${index}`} className={patchLineClass(line)}>
                                  <code>{line || ' '}</code>
                                </div>
                              ))}
                            </div>
                          ) : <div className="muted small">No patch available from GitHub API for this file.</div>}
                          {file.blobUrl ? <div><a className="btn secondary" href={file.blobUrl} target="_blank" rel="noreferrer">Open file on GitHub</a></div> : null}
                        </div>
                      )) : <div className="muted small">No file list loaded.</div>}
                    </div>
                  )}
                </div>
                <div className="controls" style={{ marginTop: 12 }}>
                  <a className="btn secondary" href={`${pr.url}/files`} target="_blank" rel="noreferrer">Open changes</a>
                  <a className="btn secondary" href={`${pr.url}.diff`} target="_blank" rel="noreferrer">Open raw diff</a>
                </div>
              </div>
            </div>
          ) : (
            <div className="notice">No enriched PR preview yet for this notification. Works best for pull request notifications with accessible subject URL.</div>
          )}
        </>
      ) : null}
    </div>
  )
}
