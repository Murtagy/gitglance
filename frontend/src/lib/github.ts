import { hasGitHubMarkReadProxy, proxyMarkThreadRead } from './github-auth'
import type { NotificationThread, NotificationsPage, PRFile, PullRequestActivity, PullRequestData, RequestedPullRequest, ReviewRequestsPage, ThreadPreview, Viewer } from './types'

const GITHUB_API_URL = 'https://api.github.com'
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql'
const RECENTLY_READ_TTL_MS = 2 * 60_000
const recentlyReadThreads = new Map<string, number>()

function authHeaders(token: string, extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  }
}

function pruneRecentlyReadThreads() {
  const now = Date.now()
  for (const [threadId, expiresAt] of recentlyReadThreads.entries()) {
    if (expiresAt <= now) {
      recentlyReadThreads.delete(threadId)
    }
  }
}

function rememberRecentlyReadThread(threadId: string) {
  recentlyReadThreads.set(threadId, Date.now() + RECENTLY_READ_TTL_MS)
}

function isRecentlyReadThread(threadId: string): boolean {
  pruneRecentlyReadThreads()
  const expiresAt = recentlyReadThreads.get(threadId)
  return typeof expiresAt === 'number' && expiresAt > Date.now()
}

async function fetchResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, {
    cache: 'no-store',
    ...init,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub request failed (${response.status}): ${text || response.statusText}`)
  }
  return response
}

async function fetchJSON<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetchResponse(input, init)
  return response.json()
}

export function apiUrlToWebUrl(apiUrl: string): string {
  return apiUrl.replace('https://api.github.com/repos/', 'https://github.com/').replace('/pulls/', '/pull/')
}

export function notificationSubjectPayloadToWebUrl(payload: any): string | null {
  const directPR = payload?.pull_request?.html_url
  if (typeof directPR === 'string' && directPR) return directPR

  const pullRequests = [
    ...(Array.isArray(payload?.pull_requests) ? payload.pull_requests : []),
    ...(Array.isArray(payload?.check_suite?.pull_requests) ? payload.check_suite.pull_requests : []),
  ]
  const firstPR = pullRequests.find((pr: any) => typeof pr?.html_url === 'string' && pr.html_url)
  if (firstPR?.html_url) return firstPR.html_url

  if (typeof payload?.html_url === 'string' && payload.html_url) return payload.html_url
  return null
}

export async function resolveNotificationWebUrl(token: string, thread: Pick<NotificationThread, 'subjectType' | 'subjectUrl' | 'webUrl' | 'repoUrl'>): Promise<string> {
  if (thread.subjectType === 'PullRequest') {
    return thread.webUrl ?? thread.repoUrl ?? ''
  }
  if (!thread.subjectUrl) {
    return thread.webUrl ?? thread.repoUrl ?? ''
  }

  try {
    const payload = await fetchJSON<any>(thread.subjectUrl, {
      headers: authHeaders(token),
    })
    return notificationSubjectPayloadToWebUrl(payload) ?? thread.webUrl ?? thread.repoUrl ?? ''
  } catch {
    return thread.webUrl ?? thread.repoUrl ?? ''
  }
}

export function parsePullRequestApiUrl(apiUrl?: string | null): { owner: string; repo: string; number: number } | null {
  if (!apiUrl) return null
  const prefix = 'https://api.github.com/repos/'
  if (!apiUrl.startsWith(prefix)) return null
  const parts = apiUrl.slice(prefix.length).split('/')
  if (parts.length !== 4 || parts[2] !== 'pulls') return null
  const number = Number(parts[3])
  if (!Number.isFinite(number)) return null
  return { owner: parts[0], repo: parts[1], number }
}

export async function fetchViewer(token: string): Promise<Viewer> {
  const query = `query { viewer { id login } }`
  const data = await fetchGraphQL<{ viewer: Viewer }>(token, query)
  return data.viewer
}

// GitHub includes requests to the viewer's teams, not just direct requests.
export const REVIEW_REQUESTS_SEARCH = 'is:pr is:open draft:false review-requested:@me sort:updated-desc'

export async function fetchReviewRequests(token: string, after: string | null = null): Promise<ReviewRequestsPage> {
  const query = `
    query($search: String!, $after: String) {
      search(query: $search, type: ISSUE, first: 20, after: $after) {
        issueCount
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on PullRequest {
            id
            number
            title
            url
            updatedAt
            repository { nameWithOwner }
            author { login }
          }
        }
      }
    }
  `
  type SearchNode = (RequestedPullRequest & { __typename: 'PullRequest' }) | { __typename: 'Issue' } | null
  const response = await fetchGraphQLResponse<{
    search: {
      issueCount: number
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: SearchNode[]
    }
  }>(token, query, { search: REVIEW_REQUESTS_SEARCH, after })
  // Cross-organization searches can return accessible PRs alongside SSO errors.
  const search = response.data?.search
  const warning = response.errors?.map((error) => error.message).join('; ')
  if (!search) throw new Error(warning || 'Missing review search data')

  return {
    ...(warning ? { warning } : {}),
    pullRequests: search.nodes.filter((node): node is RequestedPullRequest & { __typename: 'PullRequest' } => node?.__typename === 'PullRequest'),
    totalCount: search.issueCount,
    nextCursor: search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null,
  }
}

export function sortNotificationThreadsOldestFirst(threads: NotificationThread[]): NotificationThread[] {
  return [...threads].sort((a, b) => {
    const byUpdatedAt = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()
    return byUpdatedAt || a.id.localeCompare(b.id)
  })
}

type GitHubNotification = {
  id: string
  unread: boolean
  reason: string
  updated_at: string
  last_read_at: string | null
  repository: { full_name: string; html_url: string }
  subject: { type: string; title: string; url: string | null; latest_comment_url: string | null }
}

export async function fetchNotifications(token: string, show: 'unread' | 'all', pageCount: number = 1): Promise<NotificationsPage> {
  const url = new URL(`${GITHUB_API_URL}/notifications`)
  url.searchParams.set('all', show === 'all' ? 'true' : 'false')
  url.searchParams.set('participating', 'false')
  url.searchParams.set('per_page', '20')
  const threads = new Map<string, NotificationThread>()
  let pagesLoaded = 0
  let nextPage: number | null = 1

  while (nextPage !== null && pagesLoaded < pageCount) {
    url.searchParams.set('page', String(nextPage))
    const response = await fetchResponse(url, { headers: authHeaders(token) })
    const data: GitHubNotification[] = await response.json()
    pagesLoaded += 1
    nextPage = /<[^>]+>;\s*rel="next"/.test(response.headers.get('Link') ?? '') ? pagesLoaded + 1 : null

    for (const thread of data) {
      const recentlyRead = isRecentlyReadThread(thread.id)
      if (show === 'unread' && recentlyRead) continue
      threads.set(thread.id, {
        id: thread.id,
        unread: recentlyRead ? false : thread.unread,
        reason: thread.reason,
        updatedAt: thread.updated_at,
        lastReadAt: recentlyRead ? new Date().toISOString() : thread.last_read_at,
        repoFullName: thread.repository.full_name,
        repoUrl: thread.repository.html_url,
        subjectType: thread.subject.type,
        subjectTitle: thread.subject.title,
        subjectUrl: thread.subject.url,
        webUrl: thread.subject.url ? apiUrlToWebUrl(thread.subject.url) : thread.repository.html_url,
        latestCommentUrl: thread.subject.latest_comment_url,
      })
    }
  }

  return { threads: sortNotificationThreadsOldestFirst([...threads.values()]), pagesLoaded, nextPage }
}

export async function markThreadRead(token: string, threadId: string): Promise<void> {
  if (hasGitHubMarkReadProxy()) {
    await proxyMarkThreadRead(token, threadId)
    rememberRecentlyReadThread(threadId)
    return
  }

  const response = await fetch(`${GITHUB_API_URL}/notifications/threads/${threadId}`, {
    method: 'PATCH',
    cache: 'no-store',
    headers: authHeaders(token, {
      'Cache-Control': 'no-store, no-cache, max-age=0',
      Pragma: 'no-cache',
    }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Mark read failed (${response.status}): ${text || response.statusText}`)
  }
  rememberRecentlyReadThread(threadId)
}

export async function fetchPullRequestDetails(token: string, owner: string, repo: string, number: number): Promise<PullRequestData> {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          number
          title
          body
          url
          state
          isDraft
          merged
          createdAt
          repository { nameWithOwner }
          author { login }
          commits(last: 20) {
            totalCount
            nodes { commit { oid message authoredDate } }
          }
          reviews(last: 20) {
            nodes {
              state
              id
              databaseId
              createdAt
              author { login }
              body
              comments(last: 20) {
                nodes {
                  id
                  databaseId
                  createdAt
                  path
                  diffHunk
                  body
                  author { login }
                }
              }
            }
          }
          reviewThreads(last: 20) {
            nodes {
              path
              id
              comments(last: 20) {
                nodes {
                  id
                  databaseId
                  createdAt
                  body
                  diffHunk
                  author { login }
                }
              }
            }
          }
          comments(last: 20) {
            totalCount
            nodes {
              id
              databaseId
              body
              createdAt
              author { login }
            }
          }
          files(first: 50) {
            nodes {
              path
              additions
              deletions
              changeType
            }
          }
          changedFiles
          additions
          deletions
          reviewDecision
        }
      }
    }
  `

  const data = await fetchGraphQL<{ repository: { pullRequest: PullRequestData | null } }>(token, query, {
    owner,
    repo,
    number,
  })

  if (!data.repository.pullRequest) {
    throw new Error('Pull request not found')
  }

  return data.repository.pullRequest
}

export async function fetchPullRequestFiles(token: string, owner: string, repo: string, number: number): Promise<PRFile[]> {
  const allFiles: PRFile[] = []
  let page = 1

  while (page <= 3) {
    const url = new URL(`${GITHUB_API_URL}/repos/${owner}/${repo}/pulls/${number}/files`)
    url.searchParams.set('per_page', '100')
    url.searchParams.set('page', String(page))

    const data = await fetchJSON<Array<{
      filename: string
      additions: number
      deletions: number
      status: string
      patch?: string
      blob_url?: string
    }>>(url, {
      headers: authHeaders(token),
    })

    allFiles.push(...data.map((file) => ({
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status.toUpperCase(),
      patch: file.patch ?? null,
      blobUrl: file.blob_url ?? null,
    })))

    if (data.length < 100) break
    page += 1
  }

  return allFiles
}

type GraphQLResponse<T> = {
  data?: T
  errors?: Array<{ message: string }>
}

async function fetchGraphQLResponse<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<GraphQLResponse<T>> {
  return fetchJSON<GraphQLResponse<T>>(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ query, variables }),
  })
}

async function fetchGraphQL<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetchGraphQLResponse<T>(token, query, variables)
  if (response.errors?.length) {
    throw new Error(response.errors.map((error) => error.message).join('; '))
  }
  if (!response.data) {
    throw new Error('Missing GraphQL data')
  }
  return response.data
}

export async function submitPullRequestReview(token: string, pullRequestId: string, event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES', body?: string): Promise<void> {
  const mutation = `
    mutation($pullRequestId: ID!, $event: PullRequestReviewEvent!, $body: String) {
      addPullRequestReview(input: { pullRequestId: $pullRequestId, event: $event, body: $body }) {
        pullRequestReview { id }
      }
    }
  `

  await fetchGraphQL(token, mutation, {
    pullRequestId,
    event,
    body: body?.trim() || null,
  })
}

export function latestReviewAuthors(pr: PullRequestData, state: 'APPROVED' | 'CHANGES_REQUESTED'): string[] {
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

export function buildThreadPreview(thread: NotificationThread, pr?: PullRequestData): ThreadPreview {
  return { thread, pullRequest: pr, ...buildPullRequestActivity(pr, thread.lastReadAt) }
}

export function buildPullRequestActivity(pr?: PullRequestData, since?: string | null): PullRequestActivity {
  const preview: PullRequestActivity = {
    events: [],
    commitsCount: 0,
    commentsCount: 0,
    reviewsCount: 0,
    changesSince: since ?? null,
    changesSinceIsAll: !since,
    latestCommentWebUrl: null,
  }

  if (!pr) return preview

  let latestCommentAt = 0
  const setLatestCommentUrl = (createdAt: string, suffix: string) => {
    if (!pr.url || !suffix) return
    const value = new Date(createdAt).getTime()
    if (value <= latestCommentAt) return
    preview.latestCommentWebUrl = `${pr.url}${suffix}`
    latestCommentAt = value
  }

  for (const commitNode of pr.commits.nodes) {
    if (!includePreviewEvent(commitNode.commit.authoredDate, preview.changesSince)) continue
    preview.events.push({
      type: 'commit',
      author: '',
      body: firstLine(commitNode.commit.message),
      createdAt: commitNode.commit.authoredDate,
      path: '',
      diffHunk: '',
      commitSHA: commitNode.commit.oid,
      state: '',
    })
    preview.commitsCount += 1
  }

  for (const comment of pr.comments.nodes) {
    if (!includePreviewEvent(comment.createdAt, preview.changesSince)) continue
    preview.events.push({
      type: 'comment',
      author: comment.author?.login ?? '',
      body: comment.body,
      createdAt: comment.createdAt,
      path: '',
      diffHunk: '',
      commitSHA: '',
      state: '',
    })
    preview.commentsCount += 1
    setLatestCommentUrl(comment.createdAt, `#issuecomment-${comment.databaseId}`)
  }

  for (const review of pr.reviews.nodes) {
    if (includePreviewEvent(review.createdAt, preview.changesSince)) {
      preview.events.push({
        type: 'review',
        author: review.author?.login ?? '',
        body: review.body.trim() ? review.body : `Review state: ${review.state}`,
        createdAt: review.createdAt,
        path: '',
        diffHunk: '',
        commitSHA: '',
        state: review.state,
      })
      preview.reviewsCount += 1
      setLatestCommentUrl(review.createdAt, `#pullrequestreview-${review.databaseId}`)
    }

    for (const comment of review.comments.nodes) {
      if (!includePreviewEvent(comment.createdAt, preview.changesSince)) continue
      preview.events.push({
        type: 'review_comment',
        author: comment.author?.login ?? '',
        body: comment.body,
        createdAt: comment.createdAt,
        path: comment.path ?? '',
        diffHunk: comment.diffHunk ?? '',
        commitSHA: '',
        state: '',
      })
      preview.commentsCount += 1
      setLatestCommentUrl(comment.createdAt, `#discussion_r${comment.databaseId}`)
    }
  }

  for (const threadNode of pr.reviewThreads.nodes) {
    for (const comment of threadNode.comments.nodes) {
      if (!includePreviewEvent(comment.createdAt, preview.changesSince)) continue
      preview.events.push({
        type: 'thread_comment',
        author: comment.author?.login ?? '',
        body: comment.body,
        createdAt: comment.createdAt,
        path: threadNode.path,
        diffHunk: comment.diffHunk ?? '',
        commitSHA: '',
        state: '',
      })
      preview.commentsCount += 1
      setLatestCommentUrl(comment.createdAt, `#discussion_r${comment.databaseId}`)
    }
  }

  preview.events.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  return preview
}

export function includePreviewEvent(createdAt: string, since?: string | null): boolean {
  if (!since) return true
  return new Date(createdAt).getTime() > new Date(since).getTime()
}

export function firstLine(value: string): string {
  return value.trim().split('\n')[0] ?? ''
}
