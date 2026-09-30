import { buildThreadPreview, fetchNotifications, notificationSubjectPayloadToWebUrl, parsePullRequestApiUrl, sortNotificationThreadsOldestFirst } from './github'
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

describe('sortNotificationThreadsOldestFirst', () => {
  it('orders oldest updates first without mutating input', () => {
    const threads: NotificationThread[] = [
      { id: 'newest', updatedAt: '2026-05-07T12:00:00Z', unread: true, reason: 'mention', repoFullName: 'octo/repo', subjectType: 'Issue', subjectTitle: 'Newest' },
      { id: 'oldest', updatedAt: '2026-05-07T10:00:00Z', unread: true, reason: 'mention', repoFullName: 'octo/repo', subjectType: 'Issue', subjectTitle: 'Oldest' },
      { id: 'middle', updatedAt: '2026-05-07T11:00:00Z', unread: true, reason: 'mention', repoFullName: 'octo/repo', subjectType: 'Issue', subjectTitle: 'Middle' },
    ]

    expect(sortNotificationThreadsOldestFirst(threads).map((thread) => thread.id)).toEqual(['oldest', 'middle', 'newest'])
    expect(threads.map((thread) => thread.id)).toEqual(['newest', 'oldest', 'middle'])
  })
})

describe('fetchNotifications', () => {
  function pageResponse(ids: string[], hasNext: boolean): Response {
    return new Response(JSON.stringify(ids.map((id: string) => ({
      id, unread: true, reason: 'mention', updated_at: `2026-05-07T0${id}:00:00Z`, last_read_at: null,
      repository: { full_name: 'octo/repo', html_url: 'https://github.com/octo/repo' },
      subject: { type: 'Issue', title: `Thread ${id}`, url: null, latest_comment_url: null },
    }))), { headers: hasNext ? { Link: '<https://api.github.com/notifications?page=2>; rel="next"' } : {} })
  }

  afterEach(() => { vi.unstubAllGlobals() })

  it('reports next page without fetching it by default', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(pageResponse(['2'], true))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchNotifications('token', 'unread')
    expect(result.nextPage).toBe(2)
    expect(result.pagesLoaded).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('loads requested pages, deduplicates, sorts, and detects final page', async () => {
    const requestedPages: Array<string | null> = []
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input: RequestInfo | URL): Promise<Response> => {
      const page = new URL(String(input)).searchParams.get('page')
      requestedPages.push(page)
      return page === '1' ? pageResponse(['2'], true) : pageResponse(['2', '1'], false)
    }))
    const result = await fetchNotifications('token', 'all', 3)
    expect(requestedPages).toEqual(['1', '2'])
    expect(result.threads.map((thread) => thread.id)).toEqual(['1', '2'])
    expect(result.nextPage).toBeNull()
    expect(result.pagesLoaded).toBe(2)
  })

  it('rejects failed later pages rather than replacing inbox with partial data', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(pageResponse(['2'], true))
      .mockResolvedValueOnce(new Response('rate limited', { status: 403 })))
    await expect(fetchNotifications('token', 'unread', 2)).rejects.toThrow('GitHub request failed (403)')
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
    isDraft: false,
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
