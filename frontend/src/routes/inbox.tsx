import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { inboxRoute } from '../router'
import { useAppContext } from '../lib/app-context'
import { GitHubTokenControls } from '../components/github-token-controls'
import { buildThreadPreview, fetchNotifications, fetchPullRequestDetails, fetchPullRequestFiles, markThreadRead, parsePullRequestApiUrl } from '../lib/github'
import { formatDateTime, formatShortDateTime, formatStaleness, truncateText } from '../lib/format'
import { clearPreviewCaches, loadInboxSnapshot, loadPreviewSnapshot, saveInboxSnapshot, savePreviewSnapshot } from '../lib/storage'
import type { InboxShow, NotificationThread, PRFile, PullRequestData, ThreadPreview } from '../lib/types'

const PREVIEW_CACHE_TTL_MS = 60_000

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

function patchLineClass(line: string) {
  if (line.startsWith('@@')) return 'patch-line patch-line-hunk'
  if (line.startsWith('+')) return 'patch-line patch-line-add'
  if (line.startsWith('-')) return 'patch-line patch-line-del'
  return 'patch-line'
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
  const [stalenessNow, setStalenessNow] = useState(() => Date.now())

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
        const preview = buildThreadPreview(selectedThread, pr)
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
    const timer = window.setInterval(() => {
      if (document.hidden || refreshMutation.isPending) return
      refreshMutation.mutate()
    }, Math.max(preferences.autoRefreshSeconds, 30) * 1000)
    return () => window.clearInterval(timer)
  }, [preferences.autoRefreshSeconds, refreshMutation, token])

  useEffect(() => {
    if (!selectedThread) return
    rowRefs.current[selectedThread.id]?.focus()
  }, [selectedThread?.id])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag && ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (!threads.length) return
      const currentIndex = selectedThread ? threads.findIndex((thread) => thread.id === selectedThread.id) : -1
      const move = (delta: number) => {
        const nextIndex = Math.max(0, Math.min(threads.length - 1, (currentIndex === -1 ? 0 : currentIndex) + delta))
        const next = threads[nextIndex]
        navigate({ search: (prev) => ({ ...prev, selected: next.id }) })
      }

      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        move(1)
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        move(-1)
      } else if (event.key === 'o' || event.key === 'O') {
        event.preventDefault()
        const url = selectedThread?.webUrl
        if (url) window.open(url, '_blank', 'noopener,noreferrer')
      } else if (event.key === 'm' || event.key === 'M') {
        event.preventDefault()
        if (selectedThread && selectedThread.unread) {
          markReadMutation.mutate(selectedThread)
        }
      } else if (event.key === 'r' || event.key === 'R') {
        event.preventDefault()
        refreshMutation.mutate()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [markReadMutation, navigate, refreshMutation, selectedThread, threads])

  if (!token) {
    return <TokenSetupCard />
  }

  void stalenessNow
  const staleness = formatStaleness(notificationsQuery.data?.savedAt, preferences.autoRefreshSeconds)

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
          <button className="btn success" onClick={() => refreshMutation.mutate()} disabled={refreshMutation.isPending || notificationsQuery.isFetching}>Refresh Inbox</button>
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
  const { token } = useAppContext()
  const pr = preview?.pullRequest
  const [filesMode, setFilesMode] = useState<'files' | 'lines'>('files')
  const parsed = useMemo(() => parsePullRequestApiUrl(thread.subjectUrl), [thread.subjectUrl])

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

  useEffect(() => {
    setFilesMode('files')
  }, [thread.id])

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
          {thread.webUrl ? <a className="btn" href={thread.webUrl} target="_blank" rel="noreferrer">Open in GitHub</a> : null}
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
                <div className="summary-line"><span className="muted">Files changed</span><span>{pr.changedFiles}</span></div>
                <div className="summary-line"><span className="muted">Lines</span><span><span style={{ color: '#166534', fontWeight: 700 }}>+{pr.additions}</span> <span className="muted">/</span> <span style={{ color: '#991b1b', fontWeight: 700 }}>-{pr.deletions}</span></span></div>
                <div className="summary-line"><span className="muted">State</span>{stateBadge(pr)}</div>
                <div className="summary-line"><span className="muted">Review decision</span>{reviewDecisionBadge(pr.reviewDecision)}</div>
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
