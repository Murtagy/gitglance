import { buildThreadPreview, notificationSubjectPayloadToWebUrl, parsePullRequestApiUrl } from './github'
import type { NotificationThread, PullRequestData } from './types'

describe('parsePullRequestApiUrl', () => {
  it('parses GitHub pull request API URL', () => {
    expect(parsePullRequestApiUrl('https://api.github.com/repos/octo/repo/pulls/42')).toEqual({
      owner: 'octo',
      repo: 'repo',
      number: 42,
    })
  })

  it('rejects non PR urls', () => {
    expect(parsePullRequestApiUrl('https://github.com/octo/repo/pull/42')).toBeNull()
  })
})

describe('notificationSubjectPayloadToWebUrl', () => {
  it('prefers PR url from check-suite style payloads', () => {
    expect(notificationSubjectPayloadToWebUrl({
      html_url: 'https://github.com/octo/repo/actions/runs/123',
      pull_requests: [{ html_url: 'https://github.com/octo/repo/pull/42' }],
    })).toBe('https://github.com/octo/repo/pull/42')
  })

  it('falls back to payload html_url when no PR attached', () => {
    expect(notificationSubjectPayloadToWebUrl({
      html_url: 'https://github.com/octo/repo/actions/runs/123',
      pull_requests: [],
    })).toBe('https://github.com/octo/repo/actions/runs/123')
  })
})

describe('buildThreadPreview', () => {
  const thread: NotificationThread = {
    id: '1',
    unread: true,
    reason: 'review_requested',
    updatedAt: '2026-05-07T10:00:00Z',
    lastReadAt: '2026-05-07T09:00:00Z',
    repoFullName: 'octo/repo',
    subjectType: 'PullRequest',
    subjectTitle: 'Test PR',
    subjectUrl: 'https://api.github.com/repos/octo/repo/pulls/42',
    webUrl: 'https://github.com/octo/repo/pull/42',
  }

  const pr: PullRequestData = {
    id: 'pr1',
    number: 42,
    title: 'Test PR',
    body: 'This is a test PR body',
    url: 'https://github.com/octo/repo/pull/42',
    state: 'OPEN',
    merged: false,
    createdAt: '2026-05-07T08:00:00Z',
    repository: { nameWithOwner: 'octo/repo' },
    author: { login: 'octocat' },
    commits: {
      totalCount: 1,
      nodes: [{ commit: { oid: 'abc123456789', message: 'commit title\nbody', authoredDate: '2026-05-07T09:30:00Z' } }],
    },
    reviews: {
      nodes: [{
        state: 'APPROVED',
        id: 'review1',
        databaseId: 99,
        createdAt: '2026-05-07T09:40:00Z',
        author: { login: 'reviewer' },
        body: '',
        comments: { nodes: [] },
      }],
    },
    reviewThreads: { nodes: [] },
    comments: {
      totalCount: 1,
      nodes: [{ id: 'comment1', databaseId: 77, body: 'Looks good', createdAt: '2026-05-07T09:35:00Z', author: { login: 'alice' } }],
    },
    files: { nodes: [] },
    changedFiles: 1,
    additions: 10,
    deletions: 2,
    reviewDecision: 'APPROVED',
  }

  it('counts new activity since last read', () => {
    const preview = buildThreadPreview(thread, pr)
    expect(preview.commitsCount).toBe(1)
    expect(preview.commentsCount).toBe(1)
    expect(preview.reviewsCount).toBe(1)
    expect(preview.events).toHaveLength(3)
    expect(preview.events[0].type).toBe('review')
  })
})
