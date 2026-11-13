import { useEffect, useMemo, useState } from 'react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '../lib/app-context'
import { buildPullRequestActivity, fetchPullRequestFiles, latestReviewAuthors, submitPullRequestReview } from '../lib/github'
import { formatDateTime, formatShortDateTime, truncateText } from '../lib/format'
import { clearPreviewCaches } from '../lib/storage'
import type { PullRequestData, ReviewDraft, ThreadPreview } from '../lib/types'
import { ExpandableText } from './expandable-text'

export const EMPTY_REVIEW_DRAFT: ReviewDraft = { mode: null, body: '' }

export function ApprovalBadge({ approvedByViewer }: { approvedByViewer: boolean }) {
  return <span className={`badge ${approvedByViewer ? 'blue' : 'green'}`} title={approvedByViewer ? 'Approved by you' : 'Approved'}>Approved</span>
}

export function PullRequestStateBadge({ pullRequest: pr }: { pullRequest: Pick<PullRequestData, 'state' | 'isDraft' | 'merged'> }) {
  if (pr.merged) return <span className="badge purple">MERGED</span>
  if (pr.state.toUpperCase() === 'CLOSED') return <span className="badge red">CLOSED</span>
  if (pr.isDraft) return <span className="badge gray">DRAFT</span>
  if (pr.state.toUpperCase() === 'OPEN') return <span className="badge green">OPEN</span>
  return <span className="badge gray">{pr.state}</span>
}

function reviewDecisionBadge(value: string | null | undefined, approvedByViewer: boolean) {
  if (value === 'APPROVED') return <ApprovalBadge approvedByViewer={approvedByViewer} />
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

export function PullRequestPreview({
  pullRequest: pr,
  changesSince,
  viewerLogin,
  reviewDraft,
  onReviewDraftChange,
}: {
  pullRequest: PullRequestData
  changesSince?: string | null
  viewerLogin?: string
  reviewDraft: ReviewDraft
  onReviewDraftChange: (draft: ReviewDraft) => void
}) {
  const { token, preferences } = useAppContext()
  const queryClient = useQueryClient()
  const preview = useMemo(() => buildPullRequestActivity(pr, changesSince), [pr, changesSince])
  const defaultFilesMode = (pr.additions + pr.deletions) <= preferences.autoOpenLinesThreshold ? 'lines' : 'files'
  const [filesMode, setFilesMode] = useState<'files' | 'lines'>(defaultFilesMode)
  const { mode: reviewMode, body: reviewBody } = reviewDraft
  const [reviewError, setReviewError] = useState('')

  const patchesQuery = useQuery({
    queryKey: ['pr-files', token, pr.id, pr.commits.nodes.at(-1)?.commit.oid],
    enabled: Boolean(token && filesMode === 'lines'),
    staleTime: 60_000,
    queryFn: () => {
      const [owner, repo] = pr.repository.nameWithOwner.split('/')
      return fetchPullRequestFiles(token, owner, repo, pr.number)
    },
  })

  const filesWithPatches = useMemo(() => {
    if (!patchesQuery.data?.length) return pr.files.nodes
    const patchByPath = new Map(patchesQuery.data.map((file) => [file.path, file]))
    return pr.files.nodes.map((file) => ({
      ...file,
      patch: patchByPath.get(file.path)?.patch ?? null,
      blobUrl: patchByPath.get(file.path)?.blobUrl ?? null,
    }))
  }, [patchesQuery.data, pr])

  const approvedBy = useMemo(() => latestReviewAuthors(pr, 'APPROVED'), [pr])
  const approvedByViewer = Boolean(viewerLogin && approvedBy.includes(viewerLogin))
  const changesRequestedBy = useMemo(() => latestReviewAuthors(pr, 'CHANGES_REQUESTED'), [pr])

  const reviewPending = useIsMutating({ mutationKey: ['review', token, pr.id] }) > 0
  const reviewMutation = useMutation({
    mutationKey: ['review', token, pr.id],
    mutationFn: async ({ event, body }: { event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'; body: string }) => {
      await submitPullRequestReview(token, pr.id, event, body)
      await clearPreviewCaches()
    },
    onSuccess: async () => {
      setReviewError('')
      onReviewDraftChange(EMPTY_REVIEW_DRAFT)
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['preview', token],
          predicate: (query) => (query.state.data as ThreadPreview | undefined)?.pullRequest?.id === pr.id,
        }),
        queryClient.invalidateQueries({ queryKey: ['pull-request', token, pr.id] }),
        queryClient.invalidateQueries({ queryKey: ['notifications', token] }),
        queryClient.invalidateQueries({ queryKey: ['review-requests', token] }),
      ])
    },
    onError: (mutationError) => {
      setReviewError(mutationError instanceof Error ? mutationError.message : 'Failed to submit review')
    },
  })

  useEffect(() => { setFilesMode(defaultFilesMode) }, [defaultFilesMode, pr.id])

  const submitReview = (mode: 'approve' | 'comment' | 'request_changes') => {
    if (reviewPending) return
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
      <div className="table-wrap">
        <div className="table-header space-between" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div className="stack" style={{ gap: 6 }}>
            <div style={{ fontWeight: 700 }}>{changesSince ? 'New activity since last read' : 'Recent activity'}</div>
            <div className="split">
              <span className="badge blue">{preview.commitsCount} commit{preview.commitsCount === 1 ? '' : 's'}</span>
              <span className="badge blue">{preview.commentsCount} comment{preview.commentsCount === 1 ? '' : 's'}</span>
              <span className="badge blue">{preview.reviewsCount} review{preview.reviewsCount === 1 ? '' : 's'}</span>
            </div>
          </div>
          <div className="muted tiny">{changesSince ? formatDateTime(changesSince) : 'All visible activity'}</div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Type</th><th>Who</th><th>Summary</th><th>When</th></tr>
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
                    <div><ExpandableText text={event.body} limit={90} /></div>
                    <div className="split tiny muted">
                      {event.path ? <span>{truncateText(event.path, 36)}</span> : null}
                      {event.commitSHA ? <code>{truncateText(event.commitSHA, 10)}</code> : null}
                    </div>
                  </td>
                  <td className="tiny muted">{formatShortDateTime(event.createdAt)}</td>
                </tr>
              )) : (
                <tr><td colSpan={4} className="muted">No PR activity in fetched window.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="summary-box">
        <div className="summary-box-header"><div style={{ fontWeight: 700 }}>PR summary</div></div>
        <div className="summary-box-body">
          {pr.body.trim() ? <div style={{ marginBottom: 12, fontSize: 14, lineHeight: 1.5, color: '#4b5563' }}><ExpandableText text={pr.body.trim()} limit={256} /></div> : null}
          <div className="summary-line"><span className="muted">Author</span><span>{pr.author?.login || '—'}</span></div>
          <div className="summary-line"><span className="muted">Lines</span><span><span style={{ color: '#166534', fontWeight: 700 }}>+{pr.additions}</span> <span className="muted">/</span> <span style={{ color: '#991b1b', fontWeight: 700 }}>-{pr.deletions}</span></span></div>
          <div className="summary-line"><span className="muted">State</span><PullRequestStateBadge pullRequest={pr} /></div>
          <div className="summary-line">
            <span className="muted">Review decision</span>
            {pr.isDraft ? <span className="badge gray">Not ready for review</span> : reviewDecisionBadge(pr.reviewDecision, approvedByViewer)}
            {!pr.isDraft && pr.reviewDecision === 'APPROVED' && approvedBy.length ? <span className="muted small">by {approvedBy.join(', ')}</span> : null}
            {!pr.isDraft && pr.reviewDecision === 'CHANGES_REQUESTED' && changesRequestedBy.length ? <span className="muted small">by {changesRequestedBy.join(', ')}</span> : null}
          </div>
          {pr.state.toUpperCase() === 'OPEN' && !pr.merged && !pr.isDraft ? (
            <div className="review-actions">
              <div className="controls">
                <button type="button" className={`btn ${reviewMode === 'approve' ? '' : 'secondary'}`} disabled={reviewPending} onClick={() => onReviewDraftChange({ ...reviewDraft, mode: 'approve' })}>Approve</button>
                <button type="button" className={`btn ${reviewMode === 'comment' ? '' : 'secondary'}`} disabled={reviewPending} onClick={() => onReviewDraftChange({ ...reviewDraft, mode: 'comment' })}>Comment</button>
                <button type="button" className={`btn ${reviewMode === 'request_changes' ? 'warn' : 'secondary'}`} disabled={reviewPending} onClick={() => onReviewDraftChange({ ...reviewDraft, mode: 'request_changes' })}>Request changes</button>
              </div>
              {reviewMode ? (
                <div className="stack" style={{ marginTop: 10 }}>
                  <textarea
                    className="form-control"
                    value={reviewBody}
                    disabled={reviewPending}
                    onChange={(event) => onReviewDraftChange({ ...reviewDraft, body: event.target.value })}
                    placeholder={reviewMode === 'approve' ? 'Optional approval note' : reviewMode === 'comment' ? 'Required review comment' : 'Required change request'}
                  />
                  <div className="controls">
                    <button
                      type="button"
                      className={`btn ${reviewMode === 'request_changes' ? 'warn' : reviewMode === 'approve' ? 'success' : ''}`}
                      onClick={() => submitReview(reviewMode)}
                      disabled={reviewPending}
                    >
                      {reviewPending ? 'Submitting…' : reviewMode === 'approve' ? 'Submit approval' : reviewMode === 'comment' ? 'Submit comment' : 'Submit change request'}
                    </button>
                    <button type="button" className="btn secondary" onClick={() => { onReviewDraftChange(EMPTY_REVIEW_DRAFT); setReviewError('') }} disabled={reviewPending}>Cancel</button>
                  </div>
                  {reviewError ? <div className="error" role="alert">{reviewError}</div> : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="summary-line"><span className="muted">Files changed</span><span>{pr.changedFiles}</span></div>
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
                    <div className="stack" style={{ gap: 2 }}><div>{file.path}</div><div className="tiny muted">{file.changeType}</div></div>
                    <div className="tiny"><span style={{ color: '#166534', fontWeight: 700 }}>+{file.additions}</span> <span className="muted">/</span> <span style={{ color: '#991b1b', fontWeight: 700 }}>-{file.deletions}</span></div>
                  </div>
                )) : <div className="muted small">No file list loaded.</div>}
              </div>
            ) : (
              <div className="patch-list">
                {patchesQuery.isLoading ? <div className="loading">Loading file patches…</div> : null}
                {patchesQuery.isError ? <div className="error" role="alert">{patchesQuery.error.message}</div> : null}
                {filesWithPatches.length ? filesWithPatches.map((file) => (
                  <div className="patch-item" key={file.path}>
                    <div className="file-item" style={{ border: 'none', padding: 0 }}>
                      <div className="stack" style={{ gap: 2 }}><div>{file.path}</div><div className="tiny muted">{file.changeType}</div></div>
                      <div className="tiny"><span style={{ color: '#166534', fontWeight: 700 }}>+{file.additions}</span> <span className="muted">/</span> <span style={{ color: '#991b1b', fontWeight: 700 }}>-{file.deletions}</span></div>
                    </div>
                    {file.patch ? (
                      <div className="patch-view">
                        {file.patch.split('\n').map((line, index) => (
                          <div key={`${file.path}-${index}`} className={patchLineClass(line)}><code>{line || ' '}</code></div>
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
    </div>
  )
}
