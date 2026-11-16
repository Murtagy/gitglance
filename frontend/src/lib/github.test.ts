import { buildPullRequestActivity, buildThreadPreview, fetchNotifications, fetchReviewRequests, fetchReviewSnoozeActivity, hasAuthorResponseSince, notificationSubjectPayloadToWebUrl, parsePullRequestApiUrl, shouldWakeReviewSnooze, sortNotificationThreadsOldestFirst } from './github'
import type { NotificationThread, PullRequestData, ReviewSnooze } from './types'

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

describe('fetchReviewRequests', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('searches pending user and team requests without relying on notifications', async () => {
    const pullRequest = {
      __typename: 'PullRequest', id: 'pr1', number: 42, title: 'Requested PR',
      url: 'https://github.com/octo/repo/pull/42', updatedAt: '2026-05-07T10:00:00Z',
      repository: { nameWithOwner: 'octo/repo' }, author: null,
      state: 'OPEN', isDraft: false, merged: false, reviewDecision: 'APPROVED', headRefOid: 'head1',
      reviews: { nodes: [{ state: 'APPROVED', createdAt: '2026-05-07T09:00:00Z', author: { login: 'reviewer' } }] },
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: 'User', login: 'viewer' } },
          { requestedReviewer: { __typename: 'Team' } },
        ],
        pageInfo: { hasNextPage: false },
      },
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: {
      search: { issueCount: 2, pageInfo: { hasNextPage: true, endCursor: 'cursor-1' }, nodes: [pullRequest, null] },
    } })))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchReviewRequests('token')
    expect(result).toEqual({ pullRequests: [pullRequest], totalCount: 2, nextCursor: 'cursor-1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.github.com/graphql')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer token' })
    const { query, variables } = JSON.parse(String(init?.body))
    expect(query).toContain('first: 20')
    expect(query).toContain('reviewDecision')
    expect(query).toContain('latestOpinionatedReviews(last: 100)')
    expect(query).toContain('reviewRequests(first: 100)')
    expect(query).toContain('... on User { login }')
    expect(query).not.toContain('... on Team')
    expect(query).not.toContain('organization { login }')
    expect(variables).toEqual({ search: 'is:pr is:open review-requested:@me sort:updated-desc', after: null })
  })

  it('passes the search cursor and stops at the final page', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: {
      search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: 'last' }, nodes: [] },
    } })))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchReviewRequests('token', 'cursor-1')).toEqual({ pullRequests: [], totalCount: 0, nextCursor: null })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).variables.after).toBe('cursor-1')
  })

  it('keeps accessible requests and reports partial access errors', async () => {
    const pullRequest = {
      __typename: 'PullRequest', id: 'pr1', number: 42, title: 'Accessible PR',
      url: 'https://github.com/octo/repo/pull/42', updatedAt: '2026-05-07T10:00:00Z',
      repository: { nameWithOwner: 'octo/repo' }, author: null,
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { search: { issueCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [pullRequest, null] } },
      errors: [{ message: 'Authorize your token for SSO' }],
    }))))
    expect(await fetchReviewRequests('token')).toEqual({
      pullRequests: [pullRequest], totalCount: 2, nextCursor: null, warning: 'Authorize your token for SSO',
    })
  })

  it('rejects GraphQL errors rather than returning an empty queue', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { search: null }, errors: [{ message: 'API rate limit exceeded' }],
    }))))
    await expect(fetchReviewRequests('token')).rejects.toThrow('API rate limit exceeded')
  })
})

describe('review snooze wake rules', () => {
  const since = '2026-05-07T10:00:00Z'
  const snooze: ReviewSnooze = {
    pullRequest: { id: 'pr1', number: 1, title: 'PR', url: 'https://github.com/octo/repo/pull/1', repository: { nameWithOwner: 'octo/repo' } },
    snoozedAt: since, headRefOid: 'head1',
  }

  it.each([
    { response: { createdAt: '2026-05-07T11:00:00Z', author: { login: 'AUTHOR' } }, expected: true },
    { response: { createdAt: '2026-05-07T09:00:00Z', submittedAt: '2026-05-07T11:00:00Z', author: { login: 'author' } }, expected: true },
    { response: { createdAt: '2026-05-07T11:00:00Z', author: { login: 'teammate' } }, expected: false },
    { response: { createdAt: '2026-05-07T09:00:00Z', author: { login: 'author' } }, expected: false },
    { response: { createdAt: '2026-05-07T11:00:00Z', submittedAt: null, author: { login: 'author' } }, expected: false },
    { response: { createdAt: '2026-05-07T11:00:00Z', author: null }, expected: false },
    { response: null, expected: false },
  ])('only counts newly published responses from the author ($expected)', ({ response, expected }) => {
    expect(hasAuthorResponseSince([response], 'author', since)).toBe(expected)
  })

  it.each([
    { headRefOid: 'head1', authorReplied: false, isClosed: false, expected: false },
    { headRefOid: 'head2', authorReplied: false, isClosed: false, expected: true },
    { headRefOid: 'head1', authorReplied: true, isClosed: false, expected: true },
    { headRefOid: null, authorReplied: false, isClosed: false, expected: false },
    { headRefOid: 'head1', authorReplied: false, isClosed: true, expected: true },
  ])('only wakes for author replies or a changed commit ($expected)', ({ expected, ...activity }) => {
    expect(shouldWakeReviewSnooze(snooze, activity)).toBe(expected)
  })
})

describe('fetchReviewSnoozeActivity', () => {
  function page(nodes: unknown[], next: string | null = null, headRefOid = 'head1', state = 'OPEN'): Response {
    return new Response(JSON.stringify({ data: { node: {
      headRefOid, state, number: 1, repository: { nameWithOwner: 'octo/repo' }, author: { login: 'author' },
      timelineItems: { nodes, pageInfo: { hasNextPage: Boolean(next), endCursor: next } },
    } } }))
  }
  afterEach(() => { vi.unstubAllGlobals() })

  it('checks author comments and published review replies across activity pages', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page([{ createdAt: '2026-05-07T11:00:00Z', author: { login: 'teammate' } }], 'next'))
      .mockResolvedValueOnce(page([{ submittedAt: '2026-05-07T12:00:00Z', author: { login: 'author' } }]))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchReviewSnoozeActivity('token', 'pr1', '2026-05-07T10:00:00Z')).toEqual({ headRefOid: 'head1', authorReplied: true, isClosed: false })
    const { query, variables } = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(query).toContain('itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW]')
    expect(variables).toEqual({ id: 'pr1', since: '2026-05-07T10:00:00Z', after: 'next' })
  })

  it('reports unchanged activity without treating other authors as a response', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page([null, { createdAt: '2026-05-07T11:00:00Z', author: { login: 'teammate' } }]))
      .mockResolvedValueOnce(new Response('[]')))
    expect(await fetchReviewSnoozeActivity('token', 'pr1', '2026-05-07T10:00:00Z')).toEqual({ headRefOid: 'head1', authorReplied: false, isClosed: false })
  })

  it('detects inline author replies on existing submitted reviews across comment pages', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ created_at: '2026-05-07T11:00:00Z', user: { login: 'teammate' } }]), { headers: { Link: '<https://api.github.com/repos/octo/repo/pulls/1/comments?page=2>; rel="next"' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ created_at: '2026-05-07T12:00:00Z', user: { login: 'author' } }])))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchReviewSnoozeActivity('token', 'pr1', '2026-05-07T10:00:00Z')).toEqual({ headRefOid: 'head1', authorReplied: true, isClosed: false })
    const url = new URL(String(fetchMock.mock.calls[2][0]))
    expect(url.pathname).toBe('/repos/octo/repo/pulls/1/comments')
    expect(url.searchParams.get('since')).toBe('2026-05-07T10:00:00Z')
    expect(url.searchParams.get('page')).toBe('2')
  })

  it('wakes on a new head without requiring inline-comment requests to succeed', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(page([], null, 'head2')).mockRejectedValue(new Error('Comments unavailable'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchReviewSnoozeActivity('token', 'pr1', '2026-05-07T10:00:00Z', 'head1')).toEqual({ headRefOid: 'head2', authorReplied: false, isClosed: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retires closed PRs without polling their comments forever', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(page([], null, 'head1', 'CLOSED'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchReviewSnoozeActivity('token', 'pr1', '2026-05-07T10:00:00Z')).toEqual({ headRefOid: 'head1', authorReplied: false, isClosed: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects missing PRs rather than waking them on incomplete data', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: { node: null } }))))
    await expect(fetchReviewSnoozeActivity('token', 'pr1', '2026-05-07T10:00:00Z')).rejects.toThrow('Snoozed pull request is unavailable')
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

  it('builds recent PR activity without notification state', () => {
    const preview = buildPullRequestActivity(pr)
    expect(preview.events).toHaveLength(3)
    expect(preview.changesSince).toBeNull()
    expect(preview.changesSinceIsAll).toBe(true)
    expect(preview.latestCommentWebUrl).toBe(`${pr.url}#pullrequestreview-99`)
  })

  it('keeps last-read filtering when building an inbox preview', () => {
    const preview = buildThreadPreview({ ...thread, lastReadAt: '2026-05-07T09:36:00Z' }, pr)
    expect(preview.events.map((event) => event.type)).toEqual(['review'])
    expect(preview.commitsCount).toBe(0)
    expect(preview.commentsCount).toBe(0)
    expect(preview.reviewsCount).toBe(1)
    expect(preview.changesSinceIsAll).toBe(false)
  })

  it('counts new activity since last read', () => {
    const preview = buildThreadPreview(thread, pr)
    expect(preview.commitsCount).toBe(1)
    expect(preview.commentsCount).toBe(1)
    expect(preview.reviewsCount).toBe(1)
    expect(preview.events).toHaveLength(3)
    expect(preview.events[0].type).toBe('review')
  })
})
