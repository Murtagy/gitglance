export type StorageMode = 'memory' | 'session' | 'local'

export type InboxShow = 'unread' | 'all'

export type Viewer = {
  id: string
  login: string
}

export type NotificationThread = {
  id: string
  unread: boolean
  reason: string
  updatedAt: string
  lastReadAt?: string | null
  repoFullName: string
  repoUrl?: string | null
  subjectType: string
  subjectTitle: string
  subjectUrl?: string | null
  webUrl?: string | null
  latestCommentUrl?: string | null
}

export type PRFile = {
  path: string
  additions: number
  deletions: number
  changeType: string
  patch?: string | null
  blobUrl?: string | null
}

export type PullRequestData = {
  id: string
  number: number
  title: string
  url: string
  state: string
  merged: boolean
  createdAt: string
  repository: {
    nameWithOwner: string
  }
  commits: {
    totalCount: number
    nodes: Array<{
      commit: {
        oid: string
        message: string
        authoredDate: string
      }
    }>
  }
  reviews: {
    nodes: Array<{
      state: string
      id: string
      databaseId: number
      createdAt: string
      author?: { login?: string | null } | null
      body: string
      comments: {
        nodes: Array<{
          id: string
          databaseId: number
          createdAt: string
          path?: string | null
          diffHunk?: string | null
          body: string
          author?: { login?: string | null } | null
        }>
      }
    }>
  }
  reviewThreads: {
    nodes: Array<{
      path: string
      id: string
      comments: {
        nodes: Array<{
          id: string
          databaseId: number
          createdAt: string
          body: string
          diffHunk?: string | null
          author?: { login?: string | null } | null
        }>
      }
    }>
  }
  comments: {
    totalCount: number
    nodes: Array<{
      id: string
      databaseId: number
      body: string
      createdAt: string
      author?: { login?: string | null } | null
    }>
  }
  files: {
    nodes: PRFile[]
  }
  changedFiles: number
  additions: number
  deletions: number
  reviewDecision?: string | null
}

export type PreviewEvent = {
  type: string
  author: string
  body: string
  createdAt: string
  path: string
  diffHunk: string
  commitSHA: string
  state: string
}

export type ThreadPreview = {
  thread: NotificationThread
  pullRequest?: PullRequestData
  events: PreviewEvent[]
  commitsCount: number
  commentsCount: number
  reviewsCount: number
  changesSince?: string | null
  changesSinceIsAll: boolean
  latestCommentWebUrl?: string | null
}

export type InboxSnapshot = {
  show: InboxShow
  threads: NotificationThread[]
  savedAt: string
  source: 'network' | 'cache'
}

export type PreviewSnapshot = {
  savedAt: string
  preview: ThreadPreview
}

export type Preferences = {
  show: InboxShow
  autoRefreshSeconds: number
  storageMode: StorageMode
}
