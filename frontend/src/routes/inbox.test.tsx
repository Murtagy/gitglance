import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppProvider } from '../lib/app-context'
import { buildThreadPreview, fetchNotifications, fetchPullRequestDetails, fetchViewer, markThreadRead, submitPullRequestReview } from '../lib/github'
import type { InboxSnapshot, NotificationThread, PullRequestData } from '../lib/types'
import { buildRouter } from '../router'

vi.mock('../lib/github', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/github')>(),
  fetchNotifications: vi.fn(), fetchViewer: vi.fn(), fetchPullRequestDetails: vi.fn(),
  markThreadRead: vi.fn(), submitPullRequestReview: vi.fn(),
}))
vi.mock('../lib/storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/storage')>(),
  saveInboxSnapshot: vi.fn().mockResolvedValue(undefined),
  savePreviewSnapshot: vi.fn().mockResolvedValue(undefined),
  loadInboxSnapshot: vi.fn().mockResolvedValue(undefined),
  loadPreviewSnapshot: vi.fn().mockResolvedValue(undefined),
  clearPreviewCaches: vi.fn().mockResolvedValue(undefined),
}))

const threads: NotificationThread[] = ['First', 'Second'].map((name: string, index: number) => ({
  id: String(index + 1), unread: true, reason: 'review_requested', updatedAt: new Date().toISOString(),
  repoFullName: 'octo/repo', subjectType: 'PullRequest', subjectTitle: `${name} PR`,
  subjectUrl: `https://api.github.com/repos/octo/repo/pulls/${index + 1}`,
}))
const pr: PullRequestData = {
  id: 'pr1', number: 1, title: 'First PR', body: '', url: 'https://github.com/octo/repo/pull/1',
  state: 'OPEN', isDraft: false, merged: false, createdAt: threads[0].updatedAt,
  repository: { nameWithOwner: 'octo/repo' }, author: { login: 'author' },
  commits: { totalCount: 0, nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
  comments: { totalCount: 0, nodes: [] }, files: { nodes: [] }, changedFiles: 1, additions: 30, deletions: 0,
}
let queryClient: QueryClient

function renderInbox(token: string = 'token'): void {
  sessionStorage.setItem('github-token', token)
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  const snapshot: InboxSnapshot = { show: 'unread', threads, savedAt: new Date().toISOString(), source: 'network', pagesLoaded: 1, nextPage: 2 }
  queryClient.setQueryData(['notifications', 'token', 'unread'], snapshot)
  queryClient.setQueryData(['viewer', 'token'], { id: 'viewer', login: 'viewer' })
  for (const thread of threads) {
    queryClient.setQueryData(['preview', 'token', thread.id], buildThreadPreview(thread, { ...pr, id: `pr${thread.id}`, number: Number(thread.id) }))
  }
  render(<QueryClientProvider client={queryClient}><AppProvider><RouterProvider router={buildRouter(queryClient)} /></AppProvider></QueryClientProvider>)
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/#/')
  vi.clearAllMocks()
  vi.stubGlobal('scrollTo', vi.fn())
  vi.mocked(fetchViewer).mockResolvedValue({ id: 'viewer', login: 'viewer' })
  vi.mocked(fetchNotifications).mockResolvedValue({ threads, pagesLoaded: 1, nextPage: 2 })
  vi.mocked(fetchPullRequestDetails).mockResolvedValue(pr)
  vi.mocked(markThreadRead).mockResolvedValue(undefined)
  vi.mocked(submitPullRequestReview).mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals() })

it('preserves separate review drafts and modes when switching threads', async () => {
  const user = userEvent.setup()
  renderInbox()
  await user.click(await screen.findByRole('button', { name: 'Comment' }))
  await user.type(screen.getByPlaceholderText('Required review comment'), 'First draft')
  await user.click(screen.getByText('Second PR', { selector: '.inbox-item-title' }))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Request changes' }))
  await user.type(screen.getByPlaceholderText('Required change request'), 'Second draft')
  await user.click(screen.getByText('First PR', { selector: '.inbox-item-title' }))
  expect(screen.getByPlaceholderText('Required review comment')).toHaveValue('First draft')
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  await user.click(screen.getByText('Second PR', { selector: '.inbox-item-title' }))
  expect(screen.getByPlaceholderText('Required change request')).toHaveValue('Second draft')
})

it('clears a submitted draft without clearing another thread’s draft', async () => {
  const user = userEvent.setup()
  renderInbox()
  await user.click(await screen.findByRole('button', { name: 'Comment' }))
  await user.type(screen.getByRole('textbox'), 'Keep this draft')
  await user.click(screen.getByText('Second PR', { selector: '.inbox-item-title' }))
  await user.click(screen.getByRole('button', { name: 'Comment' }))
  await user.type(screen.getByRole('textbox'), 'Submit this draft')
  await user.click(screen.getByRole('button', { name: 'Submit comment' }))
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  expect(submitPullRequestReview).toHaveBeenCalledWith('token', 'pr2', 'COMMENT', 'Submit this draft')
  await user.click(screen.getByText('First PR', { selector: '.inbox-item-title' }))
  expect(screen.getByRole('textbox')).toHaveValue('Keep this draft')
  await user.click(screen.getByText('Second PR', { selector: '.inbox-item-title' }))
  await user.click(screen.getByRole('button', { name: 'Comment' }))
  expect(screen.getByRole('textbox')).toHaveValue('')
})

it('keeps an in-flight review locked across thread switches', async () => {
  const user = userEvent.setup()
  const finishSubmission = vi.fn<() => void>()
  vi.mocked(submitPullRequestReview).mockReturnValueOnce(new Promise<void>((resolve) => { finishSubmission.mockImplementation(resolve) }))
  renderInbox()
  await user.click(await screen.findByRole('button', { name: 'Comment' }))
  await user.type(screen.getByRole('textbox'), 'Submitting draft')
  await user.click(screen.getByRole('button', { name: 'Submit comment' }))
  await user.click(screen.getByText('Second PR', { selector: '.inbox-item-title' }))
  await user.click(screen.getByRole('button', { name: 'Comment' }))
  await user.type(screen.getByRole('textbox'), 'Untouched draft')
  await user.click(screen.getByText('First PR', { selector: '.inbox-item-title' }))
  expect(screen.getByRole('textbox')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled()
  await act(async () => { finishSubmission() })
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  await user.click(screen.getByText('Second PR', { selector: '.inbox-item-title' }))
  expect(screen.getByRole('textbox')).toHaveValue('Untouched draft')
  expect(submitPullRequestReview).toHaveBeenCalledTimes(1)
})

it('restores failed mark-read, explains failure, and retries original thread', async () => {
  const user = userEvent.setup()
  vi.mocked(markThreadRead).mockRejectedValueOnce(new Error('Network unavailable'))
  renderInbox()
  await user.click(await screen.findByRole('button', { name: 'Mark First PR as read' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable')
  expect(screen.getByText('2 loaded')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(markThreadRead).toHaveBeenLastCalledWith('token', '1')
  expect(screen.getByText('1 loaded')).toBeInTheDocument()
})

it('loads more and preserves loaded page count on refresh', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchNotifications).mockResolvedValue({
    threads: [...threads, { ...threads[0], id: '3', subjectType: 'Issue', subjectTitle: 'Third issue' }],
    pagesLoaded: 2, nextPage: null,
  })
  renderInbox()
  await user.click(await screen.findByRole('button', { name: 'Load more' }))
  expect(await screen.findByText('3 loaded')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  expect(fetchNotifications).toHaveBeenLastCalledWith('token', 'unread', 2)
  await user.click(screen.getByRole('button', { name: 'Refresh Inbox' }))
  await waitFor(() => expect(fetchNotifications).toHaveBeenCalledTimes(2))
  expect(fetchNotifications).toHaveBeenLastCalledWith('token', 'unread', 2)
})

it('keeps existing rows when loading more fails and allows retry', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchNotifications).mockRejectedValueOnce(new Error('Rate limited'))
  renderInbox()
  await user.click(await screen.findByRole('button', { name: 'Load more' }))
  expect(await screen.findByText('Rate limited')).toBeInTheDocument()
  expect(screen.getByText('2 loaded')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled()
})

it('can sign in without changing hook order', async () => {
  const user = userEvent.setup()
  renderInbox('')
  await user.type(await screen.findByPlaceholderText('github_pat_...'), 'token')
  await user.click(screen.getByRole('button', { name: 'Save locally' }))
  expect(await screen.findByText('2 loaded')).toBeInTheDocument()
})
