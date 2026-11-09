import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppProvider } from '../lib/app-context'
import { fetchNotifications, fetchPullRequestDetails, fetchPullRequestFiles, fetchReviewRequests, fetchViewer, submitPullRequestReview } from '../lib/github'
import type { PullRequestData, RequestedPullRequest } from '../lib/types'
import { buildRouter } from '../router'

vi.mock('../lib/github', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/github')>(),
  fetchNotifications: vi.fn(), fetchViewer: vi.fn(), fetchReviewRequests: vi.fn(),
  fetchPullRequestDetails: vi.fn(), fetchPullRequestFiles: vi.fn(), submitPullRequestReview: vi.fn(),
}))
vi.mock('../lib/storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/storage')>(),
  clearPreviewCaches: vi.fn().mockResolvedValue(undefined),
}))

const pullRequests: RequestedPullRequest[] = ['First', 'Second'].map((name, index) => ({
  id: `pr${index + 1}`, number: index + 1, title: `${name} PR`,
  url: `https://github.com/octo/repo/pull/${index + 1}`, updatedAt: '2026-05-07T10:00:00Z',
  repository: { nameWithOwner: 'octo/repo' }, author: { login: 'author' },
}))
function details(number: number): PullRequestData {
  const pr = pullRequests[number - 1]
  return {
    ...pr, body: `Body of ${pr.title}`, state: 'OPEN', isDraft: false, merged: false, createdAt: pr.updatedAt,
    commits: { totalCount: 0, nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
    comments: { totalCount: 0, nodes: [] },
    files: { nodes: [{ path: 'src/main.ts', additions: 30, deletions: 0, changeType: 'MODIFIED' }] },
    changedFiles: 1, additions: 30, deletions: 0,
  }
}
let queryClient: QueryClient

function renderReviews(token = 'token') {
  sessionStorage.setItem('github-token', token)
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><AppProvider><RouterProvider router={buildRouter(queryClient)} /></AppProvider></QueryClientProvider>)
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/#/reviews')
  vi.clearAllMocks()
  vi.stubGlobal('scrollTo', vi.fn())
  vi.mocked(fetchViewer).mockResolvedValue({ id: 'viewer', login: 'viewer' })
  vi.mocked(fetchReviewRequests).mockResolvedValue({ pullRequests, totalCount: 2, nextCursor: null })
  vi.mocked(fetchPullRequestDetails).mockImplementation(async (_token, _owner, _repo, number) => details(number))
  vi.mocked(fetchPullRequestFiles).mockResolvedValue([
    { path: 'src/main.ts', additions: 30, deletions: 0, changeType: 'MODIFIED', patch: '@@ -0,0 +1 @@\n+const ready = true' },
  ])
  vi.mocked(submitPullRequestReview).mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals() })

it('lists requests independently of inbox and fetches only the selected preview', async () => {
  const user = userEvent.setup()
  renderReviews()
  expect(await screen.findByText('Body of First PR')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Reviews' })).toHaveClass('active')
  expect(screen.getByText('2 of 2 loaded')).toBeInTheDocument()
  expect(screen.getByText('Recent activity')).toBeInTheDocument()
  expect(screen.queryByText(/since last read/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Mark.*read/ })).not.toBeInTheDocument()
  expect(fetchNotifications).not.toHaveBeenCalled()
  expect(fetchPullRequestDetails).toHaveBeenCalledTimes(1)

  let finishPreview!: (pr: PullRequestData) => void
  vi.mocked(fetchPullRequestDetails).mockReturnValueOnce(new Promise((resolve) => { finishPreview = resolve }))
  await user.click(screen.getByRole('button', { name: /octo\/repo #2/ }))
  expect(screen.queryByText('Body of First PR')).not.toBeInTheDocument()
  expect(screen.getByText('Loading preview…')).toBeInTheDocument()
  await act(async () => { finishPreview(details(2)) })
  expect(await screen.findByText('Body of Second PR')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /octo\/repo #2/ })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('link', { name: 'Open in GitHub' })).toHaveAttribute('href', pullRequests[1].url)
  expect(fetchPullRequestDetails).toHaveBeenLastCalledWith('token', 'octo', 'repo', 2)
})

it('keeps review cards neutral without repeated reason badges and preserves selection', async () => {
  const user = userEvent.setup()
  renderReviews()
  const first = await screen.findByRole('button', { name: /octo\/repo #1/ })
  const second = screen.getByRole('button', { name: /octo\/repo #2/ })
  for (const card of [first, second]) {
    expect(card).toHaveClass('card', 'inbox-item')
    expect(card).not.toHaveClass('reason-amber')
  }
  expect(screen.queryByText('Review requested')).not.toBeInTheDocument()
  expect(first).toHaveClass('selected')
  await user.click(second)
  expect(second).toHaveClass('selected')
  expect(second).toHaveFocus()
  expect(first).not.toHaveClass('selected')
})

it('reuses file patches and keeps separate drafts during keyboard navigation', async () => {
  const user = userEvent.setup()
  renderReviews()
  await user.click(await screen.findByRole('button', { name: 'Show lines' }))
  expect(await screen.findByText('+const ready = true')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Comment' }))
  await user.type(screen.getByRole('textbox'), 'First draft jkr')
  expect(screen.getByRole('button', { name: /octo\/repo #1/ })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: /octo\/repo #1/ }))
  await user.keyboard('j')
  expect(await screen.findByText('Body of Second PR')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Comment' }))
  await user.type(screen.getByRole('textbox'), 'Second draft')
  await user.click(screen.getByRole('button', { name: /octo\/repo #2/ }))
  await user.keyboard('k')
  expect(await screen.findByRole('textbox')).toHaveValue('First draft jkr')
})

it('paginates, deduplicates overlapping pages, and refreshes loaded pages', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchReviewRequests).mockImplementation(async (_token, after) => ({
    pullRequests: after ? pullRequests : [pullRequests[0]], totalCount: 2, nextCursor: after ? null : 'next',
  }))
  renderReviews()
  await user.click(await screen.findByRole('button', { name: 'Load more' }))
  expect(await screen.findByText('2 of 2 loaded')).toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: /octo\/repo #/ })).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  expect(fetchReviewRequests).toHaveBeenLastCalledWith('token', 'next')
  await user.click(screen.getByRole('button', { name: 'Refresh Reviews' }))
  await waitFor(() => expect(fetchReviewRequests).toHaveBeenCalledTimes(4))
  expect(screen.getByText('2 of 2 loaded')).toBeInTheDocument()
})

it('retains existing requests when loading another page fails and allows retry', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchReviewRequests)
    .mockResolvedValueOnce({ pullRequests: [pullRequests[0]], totalCount: 2, nextCursor: 'next' })
    .mockRejectedValueOnce(new Error('Rate limited'))
    .mockResolvedValue({ pullRequests: [pullRequests[1]], totalCount: 2, nextCursor: null })
  renderReviews()
  await user.click(await screen.findByRole('button', { name: 'Load more' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Rate limited')
  expect(screen.getByRole('button', { name: /octo\/repo #1/ })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Load more' }))
  expect(await screen.findByText('2 of 2 loaded')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('does not mistake a failed search for an empty queue', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchReviewRequests).mockRejectedValueOnce(new Error('Token access denied'))
  renderReviews()
  expect(await screen.findByRole('alert')).toHaveTextContent('Token access denied')
  expect(screen.queryByText('No pending review requests.')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Body of First PR')).toBeInTheDocument()
})

it('allows retrying a failed preview without losing the request list', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchPullRequestDetails).mockRejectedValueOnce(new Error('Repository unavailable'))
  renderReviews()
  expect(await screen.findByRole('alert')).toHaveTextContent('Repository unavailable')
  expect(screen.getByText('2 of 2 loaded')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Retry preview' }))
  expect(await screen.findByText('Body of First PR')).toBeInTheDocument()
})

it('submits the existing review action and refreshes queue membership from GitHub', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchReviewRequests)
    .mockResolvedValueOnce({ pullRequests, totalCount: 2, nextCursor: null })
    .mockResolvedValue({ pullRequests: [pullRequests[1]], totalCount: 1, nextCursor: null })
  renderReviews()
  await user.click(await screen.findByRole('button', { name: 'Approve' }))
  await user.type(screen.getByRole('textbox'), ' Looks good ')
  await user.click(screen.getByRole('button', { name: 'Submit approval' }))
  expect(await screen.findByText('1 of 1 loaded')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /octo\/repo #1/ })).not.toBeInTheDocument()
  expect(await screen.findByText('Body of Second PR')).toBeInTheDocument()
  expect(submitPullRequestReview).toHaveBeenCalledWith('token', 'pr1', 'APPROVE', 'Looks good')
})

it('keeps a failed review draft available for retry', async () => {
  const user = userEvent.setup()
  vi.mocked(submitPullRequestReview).mockRejectedValueOnce(new Error('Review not permitted'))
  renderReviews()
  await user.click(await screen.findByRole('button', { name: 'Comment' }))
  await user.type(screen.getByRole('textbox'), 'Keep my draft')
  await user.click(screen.getByRole('button', { name: 'Submit comment' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Review not permitted')
  expect(screen.getByRole('textbox')).toHaveValue('Keep my draft')
  expect(screen.getByText('2 of 2 loaded')).toBeInTheDocument()
})

it('shows token setup without fetching requests, then loads after sign-in', async () => {
  const user = userEvent.setup()
  renderReviews('')
  const tokenInput = await screen.findByPlaceholderText('github_pat_...')
  await user.keyboard('r')
  expect(fetchReviewRequests).not.toHaveBeenCalled()
  await user.type(tokenInput, 'token')
  await user.click(screen.getByRole('button', { name: 'Save locally' }))
  expect(await screen.findByText('Body of First PR')).toBeInTheDocument()
})

it('shows an empty queue only after a successful search', async () => {
  vi.mocked(fetchReviewRequests).mockResolvedValue({ pullRequests: [], totalCount: 0, nextCursor: null })
  renderReviews()
  expect(await screen.findByText('No pending review requests.')).toBeInTheDocument()
  expect(fetchPullRequestDetails).not.toHaveBeenCalled()
})

it.each([true, false])('reports partial search access without hiding accessible PRs (has results: %s)', async (hasResults) => {
  vi.mocked(fetchReviewRequests).mockResolvedValue({
    pullRequests: hasResults ? pullRequests : [], totalCount: hasResults ? 2 : 0, nextCursor: null,
    warning: 'Authorize your token for SSO',
  })
  renderReviews()
  expect(await screen.findByRole('status')).toHaveTextContent('Some review requests could not be loaded. Authorize your token for SSO')
  expect(screen.queryByText('No pending review requests.')).not.toBeInTheDocument()
  if (hasResults) expect(await screen.findByText('Body of First PR')).toBeInTheDocument()
})

it('keeps the current preview and draft focused while updated PR details reload', async () => {
  const user = userEvent.setup()
  renderReviews()
  await user.click(await screen.findByRole('button', { name: 'Comment' }))
  await user.type(screen.getByRole('textbox'), 'Working draft')

  let finishPreview!: (pr: PullRequestData) => void
  vi.mocked(fetchPullRequestDetails).mockReturnValueOnce(new Promise((resolve) => { finishPreview = resolve }))
  vi.mocked(fetchReviewRequests).mockResolvedValue({
    pullRequests: [{ ...pullRequests[0], updatedAt: '2026-05-07T11:00:00Z' }, pullRequests[1]], totalCount: 2, nextCursor: null,
  })
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ['review-requests', 'token'] }) })
  expect(screen.getByRole('textbox')).toHaveValue('Working draft')
  expect(screen.getByRole('textbox')).toHaveFocus()
  expect(screen.getByText('Body of First PR')).toBeInTheDocument()
  await act(async () => { finishPreview({ ...details(1), body: 'Updated PR body' }) })
  expect(await screen.findByText('Updated PR body')).toBeInTheDocument()
  expect(screen.getByRole('textbox')).toHaveFocus()
})

it('makes GitHub search limits explicit and links to the same search', async () => {
  vi.mocked(fetchReviewRequests).mockResolvedValue({ pullRequests, totalCount: 1001, nextCursor: null })
  renderReviews()
  expect(await screen.findByText(/GitHub search exposes at most 1,000 results/)).toBeInTheDocument()
  const url = new URL(screen.getByRole('link', { name: 'View search on GitHub' }).getAttribute('href')!)
  expect(url.searchParams.get('q')).toBe('is:pr is:open draft:false review-requested:@me sort:updated-desc')
})
