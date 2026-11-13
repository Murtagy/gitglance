import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { reviewsRoute } from '../router'
import { GitHubTokenControls } from '../components/github-token-controls'
import { ApprovalBadge, EMPTY_REVIEW_DRAFT, PullRequestPreview, PullRequestStateBadge } from '../components/pull-request-preview'
import { useAppContext } from '../lib/app-context'
import { fetchPullRequestDetails, fetchReviewRequests, fetchViewer, REVIEW_REQUESTS_SEARCH } from '../lib/github'
import { formatDateTime, formatRelativeTime } from '../lib/format'
import type { RequestedPullRequest, ReviewDraft } from '../lib/types'

const SEARCH_URL = `https://github.com/search?type=pullrequests&q=${encodeURIComponent(REVIEW_REQUESTS_SEARCH)}`

function isViewerRequested(pr: RequestedPullRequest, viewerLogin?: string): boolean {
  return Boolean(viewerLogin && pr.reviewRequests?.nodes.some((request) => {
    const reviewer = request?.requestedReviewer
    return reviewer?.__typename === 'User' && reviewer.login.toLowerCase() === viewerLogin.toLowerCase()
  }))
}

function reviewCardStatus(pr: RequestedPullRequest, approvedByViewer: boolean, viewerLogin?: string) {
  const opinions = pr.reviews?.nodes ?? []
  const approvedByOthers = opinions.some((review) => review?.state === 'APPROVED' && review.author?.login?.toLowerCase() !== viewerLogin?.toLowerCase())
  const reviewDecision = pr.reviewDecision || (
    opinions.some((review) => review?.state === 'CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' :
    approvedByOthers ? 'APPROVED' : null
  )
  if (pr.merged || pr.state.toUpperCase() === 'MERGED') return { tone: 'purple', label: 'Merged' }
  if (pr.state.toUpperCase() === 'CLOSED') return { tone: 'red', label: 'Closed' }
  if (pr.isDraft) return { tone: 'gray', label: 'Draft' }
  if (reviewDecision === 'CHANGES_REQUESTED') return { tone: 'red', label: 'Changes requested' }
  if (approvedByViewer) return { tone: 'blue', label: 'Approved by you' }
  if (reviewDecision === 'APPROVED' && (!isViewerRequested(pr, viewerLogin) || approvedByOthers)) return { tone: 'green', label: 'Approved' }
  return null
}

function ReviewRequestBadges({ pullRequest: pr, viewerLogin }: { pullRequest: RequestedPullRequest; viewerLogin?: string }) {
  const reviewers = pr.reviewRequests?.nodes.flatMap((request) => request?.requestedReviewer ? [request.requestedReviewer] : []) ?? []
  const requestedFromViewer = isViewerRequested(pr, viewerLogin)
  const requestedFromTeam = reviewers.some((reviewer) => reviewer.__typename === 'Team' || reviewer.__typename === 'EnterpriseTeam')
  return (
    <>
      {requestedFromViewer ? <span className="badge blue" title="Review requested from you">Your review</span> : null}
      {requestedFromTeam ? <span className="badge gray" title="Review requested from a team">Team review</span> : null}
      {!pr.reviewRequests || (viewerLogin && !requestedFromViewer && !requestedFromTeam) ? <span className="badge gray">Request details unavailable</span> : null}
      {pr.reviewRequests?.pageInfo.hasNextPage ? <span className="badge gray">More reviewers on GitHub</span> : null}
    </>
  )
}

export function ReviewsPage() {
  const { token, preferences } = useAppContext()
  const { selected } = reviewsRoute.useSearch()
  const navigate = useNavigate({ from: reviewsRoute.fullPath })
  const queryClient = useQueryClient()
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [reviewDrafts, setReviewDrafts] = useState<Readonly<Record<string, ReviewDraft>>>({})

  useEffect(() => { setReviewDrafts({}) }, [token])

  const viewerQuery = useQuery({
    queryKey: ['viewer', token],
    enabled: Boolean(token),
    staleTime: 10 * 60_000,
    queryFn: () => fetchViewer(token),
  })

  const requestsQuery = useInfiniteQuery({
    queryKey: ['review-requests', token],
    enabled: Boolean(token),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchReviewRequests(token, pageParam),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: Math.max(preferences.autoRefreshSeconds, 30) * 1000,
    refetchOnWindowFocus: true,
  })

  const pullRequests = useMemo(() => {
    const entries = requestsQuery.data?.pages.flatMap((page) => page.pullRequests.map((pr) => [pr.id, pr] as const)) ?? []
    return [...new Map(entries).values()]
  }, [requestsQuery.data])
  const selectedPR = pullRequests.find((pr) => pr.id === selected) ?? pullRequests[0]
  const totalCount = requestsQuery.data?.pages[0]?.totalCount ?? 0
  const warnings = [...new Set(requestsQuery.data?.pages.flatMap((page) => page.warning ? [page.warning] : []) ?? [])]

  useEffect(() => {
    if (!requestsQuery.data) return
    if (selected !== (selectedPR?.id ?? '')) {
      navigate({ search: { selected: selectedPR?.id ?? '' }, replace: true })
    }
    const visibleIds = new Set(pullRequests.map((pr) => pr.id))
    for (const id of Object.keys(rowRefs.current)) {
      if (!visibleIds.has(id)) delete rowRefs.current[id]
    }
  }, [navigate, pullRequests, requestsQuery.data, selected, selectedPR?.id])

  useEffect(() => { if (selectedPR) rowRefs.current[selectedPR.id]?.focus() }, [selectedPR?.id])

  const detailsQuery = useQuery({
    queryKey: ['pull-request', token, selectedPR?.id, selectedPR?.updatedAt],
    enabled: Boolean(token && selectedPR),
    staleTime: 60_000,
    placeholderData: (previousData, previousQuery) => previousQuery?.queryKey[1] === token && previousQuery.queryKey[2] === selectedPR?.id ? previousData : undefined,
    queryFn: () => {
      if (!selectedPR) throw new Error('Missing selected pull request')
      const [owner, repo] = selectedPR.repository.nameWithOwner.split('/')
      return fetchPullRequestDetails(token, owner, repo, selectedPR.number)
    },
  })

  const refresh = () => {
    if (!token || requestsQuery.isFetching || detailsQuery.isFetching) return
    void requestsQuery.refetch()
    void queryClient.invalidateQueries({ queryKey: ['viewer', token] })
    void queryClient.invalidateQueries({ queryKey: ['pull-request', token] })
    void queryClient.invalidateQueries({ queryKey: ['pr-files', token] })
  }

  useEffect(() => {
    if (!token) return
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag && ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const currentIndex = pullRequests.findIndex((pr) => pr.id === selectedPR?.id)
      if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(event.key) && pullRequests.length) {
        event.preventDefault()
        const delta = event.key === 'j' || event.key === 'ArrowDown' ? 1 : -1
        const next = pullRequests[Math.max(0, Math.min(pullRequests.length - 1, currentIndex + delta))]
        navigate({ search: { selected: next.id } })
      } else if (event.key.toLowerCase() === 'o' && selectedPR) {
        event.preventDefault()
        window.open(selectedPR.url, '_blank', 'noopener,noreferrer')
      } else if (event.key.toLowerCase() === 'r') {
        event.preventDefault()
        refresh()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [navigate, pullRequests, selectedPR, requestsQuery.isFetching, detailsQuery.isFetching, token])

  if (!token) return <div className="card" style={{ padding: 24, maxWidth: 860 }}><GitHubTokenControls /></div>

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="space-between" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h1 className="title">Reviews</h1>
          <p className="subtitle">Open, ready-for-review PRs requesting you or your teams. Limited to repositories your token can access.</p>
        </div>
        <div className="controls">
          <button type="button" className="btn success" onClick={refresh} disabled={requestsQuery.isFetching || detailsQuery.isFetching}>Refresh Reviews</button>
          <a className="btn secondary" href={SEARCH_URL} target="_blank" rel="noreferrer">View search on GitHub</a>
        </div>
      </div>
      <div className="controls small muted">
        <span>{pullRequests.length} of {totalCount} loaded</span>
        <span>Auto refresh: every {Math.max(preferences.autoRefreshSeconds, 30)}s</span>
        <span>Keys: j/k move, o open GitHub, r refresh.</span>
        <span>GitHub search can take a moment to reflect submitted reviews.</span>
      </div>
      {viewerQuery.isError ? <div className="notice" role="status">Could not identify your account. Personal review labels are unavailable. Refresh Reviews to retry.</div> : null}
      {warnings.length ? <div className="notice" role="status">Some review requests could not be loaded. {warnings.join('; ')}</div> : null}
      {totalCount > 1000 ? <div className="notice">GitHub search exposes at most 1,000 results. Refine the search on GitHub to see more.</div> : null}
      {requestsQuery.isError ? (
        <div className="error controls" role="alert">
          <span>Could not load review requests. {requestsQuery.error.message}</span>
          <button type="button" className="btn secondary" onClick={refresh} disabled={requestsQuery.isFetching || detailsQuery.isFetching}>Retry</button>
        </div>
      ) : null}
      <div className="grid-main">
        <div className="inbox-list">
          {requestsQuery.isLoading ? <div className="card empty loading">Loading review requests…</div> : null}
          {!requestsQuery.isLoading && !requestsQuery.isError && !warnings.length && !pullRequests.length ? <div className="card empty">No pending review requests.</div> : null}
          {pullRequests.map((pr) => {
            const viewerLogin = viewerQuery.data?.login
            const approvedByViewer = Boolean(viewerLogin && pr.reviewRequests && !pr.reviewRequests.pageInfo.hasNextPage && !isViewerRequested(pr, viewerLogin) && pr.reviews?.nodes.some((review) => review?.state === 'APPROVED' && review.author?.login?.toLowerCase() === viewerLogin.toLowerCase()))
            const status = reviewCardStatus(pr, approvedByViewer, viewerLogin)
            return (
              <button
                type="button"
                key={pr.id}
                ref={(value) => { rowRefs.current[pr.id] = value }}
                className={`card inbox-item ${status ? `review-state-${status.tone}` : ''} ${selectedPR?.id === pr.id ? 'selected' : ''}`}
                style={{ padding: 20, textAlign: 'left' }}
                aria-pressed={selectedPR?.id === pr.id}
                onClick={() => navigate({ search: { selected: pr.id } })}
              >
                <div className="stack" style={{ gap: 6 }}>
                  <div className="split">
                    <strong>{pr.repository.nameWithOwner} #{pr.number}</strong>
                    {status ? <span className={`badge ${status.tone}`}>{status.label}</span> : null}
                    {approvedByViewer && status?.label !== 'Approved by you' ? <ApprovalBadge approvedByViewer /> : null}
                    <ReviewRequestBadges pullRequest={pr} viewerLogin={viewerQuery.data?.login} />
                  </div>
                  <div className="inbox-item-title">{pr.title}</div>
                  <div className="small muted">{pr.author?.login ?? 'Unknown author'} · <time dateTime={pr.updatedAt} title={formatDateTime(pr.updatedAt)}>Updated {formatRelativeTime(pr.updatedAt)}</time></div>
                </div>
              </button>
            )
          })}
          {requestsQuery.hasNextPage ? (
            <button type="button" className="btn secondary" disabled={requestsQuery.isFetching} onClick={() => { void requestsQuery.fetchNextPage() }}>
              {requestsQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </div>
        <div className="card preview-pane">
          {!selectedPR ? <div className="empty">Select a pull request to preview.</div> : (
            <div className="stack" style={{ gap: 16 }}>
              <div className="space-between" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div className="stack" style={{ gap: 4 }}>
                  <div className="split small muted">
                    <span>{selectedPR.repository.nameWithOwner} #{selectedPR.number}</span>
                    <PullRequestStateBadge pullRequest={detailsQuery.data ?? selectedPR} />
                    <span>Updated {formatDateTime(selectedPR.updatedAt)}</span>
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800 }}>{selectedPR.title}</div>
                </div>
                <a className="btn" href={selectedPR.url} target="_blank" rel="noreferrer">Open in GitHub</a>
              </div>
              {detailsQuery.isLoading ? <div className="loading">Loading preview…</div> : null}
              {detailsQuery.isError ? (
                <div className="error controls" role="alert">
                  <span>Could not load preview. {detailsQuery.error.message}</span>
                  <button type="button" className="btn secondary" disabled={detailsQuery.isFetching} onClick={() => { void detailsQuery.refetch() }}>Retry preview</button>
                </div>
              ) : null}
              {detailsQuery.data ? (
                <PullRequestPreview
                  key={selectedPR.id}
                  pullRequest={detailsQuery.data}
                  viewerLogin={viewerQuery.data?.login}
                  reviewDraft={reviewDrafts[selectedPR.id] ?? EMPTY_REVIEW_DRAFT}
                  onReviewDraftChange={(draft) => setReviewDrafts((current) => ({ ...current, [selectedPR.id]: draft }))}
                />
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
