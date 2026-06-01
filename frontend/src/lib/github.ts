import { hasGitHubMarkReadProxy, proxyMarkThreadRead } from './github-auth'
import type { NotificationThread, PRFile, PullRequestData, ThreadPreview, Viewer } from './types'

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

async function fetchJSON<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    cache: 'no-store',
    ...init,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub request failed (${response.status}): ${text || response.statusText}`)
  }
  return response.json() as Promise<T>
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

export async function fetchNotifications(token: string, show: 'unread' | 'all'): Promise<NotificationThread[]> {
  const url = new URL(`${GITHUB_API_URL}/notifications`)
  url.searchParams.set('all', show === 'all' ? 'true' : 'false')
  url.searchParams.set('participating', 'false')
  const data = await fetchJSON<any[]>(url, {
    headers: authHeaders(token),
  })

  pruneRecentlyReadThreads()

  return data
    .filter((thread) => !(show === 'unread' && isRecentlyReadThread(thread.id)))
    .map((thread) => ({
      id: thread.id,
      unread: isRecentlyReadThread(thread.id) ? false : thread.unread,
      reason: thread.reason,
      updatedAt: thread.updated_at,
      lastReadAt: isRecentlyReadThread(thread.id) ? new Date().toISOString() : thread.last_read_at,
      repoFullName: thread.repository.full_name,
      repoUrl: thread.repository.html_url,
      subjectType: thread.subject.type,
      subjectTitle: thread.subject.title,
      subjectUrl: thread.subject.url,
      webUrl: thread.subject.url ? apiUrlToWebUrl(thread.subject.url) : thread.repository.html_url,
      latestCommentUrl: thread.subject.latest_comment_url,
    }))
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

async function fetchGraphQL<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetchJSON<GraphQLResponse<T>>(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ query, variables }),
  })

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

export function buildThreadPreview(thread: NotificationThread, pr?: PullRequestData): ThreadPreview {
  const preview: ThreadPreview = {
    thread,
    pullRequest: pr,
    events: [],
    commitsCount: 0,
    commentsCount: 0,
    reviewsCount: 0,
    changesSince: thread.lastReadAt ?? null,
    changesSinceIsAll: !thread.lastReadAt,
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
