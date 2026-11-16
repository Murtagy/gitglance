import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppProvider } from '../lib/app-context'
import { fetchNotifications, fetchPullRequestDetails, fetchPullRequestFiles, fetchReviewRequests, fetchReviewSnoozeActivity, fetchViewer, submitPullRequestReview } from '../lib/github'
import { deleteReviewSnooze, loadReviewSnoozes, saveReviewSnooze } from '../lib/storage'
import type { PullRequestData, RequestedPullRequest, ReviewSnooze } from '../lib/types'
import { buildRouter } from '../router'

vi.mock('../lib/github', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/github')>(),
  fetchNotifications: vi.fn(), fetchViewer: vi.fn(), fetchReviewRequests: vi.fn(), fetchReviewSnoozeActivity: vi.fn(),
  fetchPullRequestDetails: vi.fn(), fetchPullRequestFiles: vi.fn(), submitPullRequestReview: vi.fn(),
}))
vi.mock('../lib/storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/storage')>(),
  clearPreviewCaches: vi.fn().mockResolvedValue(undefined),
  loadReviewSnoozes: vi.fn(), saveReviewSnooze: vi.fn(), deleteReviewSnooze: vi.fn(),
}))

const pullRequests: RequestedPullRequest[] = ['First', 'Second'].map((name, index) => ({
  id: `pr${index + 1}`, number: index + 1, title: `${name} PR`,
  url: `https://github.com/octo/repo/pull/${index + 1}`, updatedAt: '2026-05-07T10:00:00Z',
  repository: { nameWithOwner: 'octo/repo' }, author: { login: 'author' },
  state: 'OPEN', isDraft: false, merged: false, reviewDecision: 'REVIEW_REQUIRED', reviews: { nodes: [] }, headRefOid: 'head1',
  reviewRequests: {
    nodes: [{ requestedReviewer: index === 0
      ? { __typename: 'User', login: 'viewer' }
      : { __typename: 'Team' } }],
    pageInfo: { hasNextPage: false },
  },
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
const savedSnoozes = new Map<string, ReviewSnooze>()
function snoozeRecord(pr = pullRequests[0]): ReviewSnooze {
  return { pullRequest: pr, snoozedAt: '2026-05-07T10:00:00Z', headRefOid: 'head1' }
}

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
  savedSnoozes.clear()
  vi.mocked(loadReviewSnoozes).mockImplementation(async (viewerId) => [...savedSnoozes.entries()].filter(([key]) => key.startsWith(`${viewerId}:`)).map(([, snooze]) => snooze))
  vi.mocked(saveReviewSnooze).mockImplementation(async (viewerId, snooze) => { savedSnoozes.set(`${viewerId}:${snooze.pullRequest.id}`, snooze) })
  vi.mocked(deleteReviewSnooze).mockImplementation(async (viewerId, snooze) => {
    const key = `${viewerId}:${snooze.pullRequest.id}`
    if (savedSnoozes.get(key)?.snoozedAt === snooze.snoozedAt) savedSnoozes.delete(key)
  })
  vi.mocked(fetchReviewSnoozeActivity).mockResolvedValue({ headRefOid: 'head1', authorReplied: false, isClosed: false })
  vi.stubGlobal('scrollTo', vi.fn())
  vi.mocked(fetchViewer).mockResolvedValue({ id: 'viewer', login: 'viewer' })
  vi.mocked(fetchReviewRequests).mockResolvedValue({ pullRequests, totalCount: 2, nextCursor: null })
  vi.mocked(fetchPullRequestDetails).mockImplementation(async (_token, _owner, _repo, number) => details(number))
  vi.mocked(fetchPullRequestFiles).mockResolvedValue([
    { path: 'src/main.ts', additions: 30, deletions: 0, changeType: 'MODIFIED', patch: '@@ -0,0 +1 @@\n+const ready = true' },
  ])
  vi.mocked(submitPullRequestReview).mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); queryClient.clear(); focusManager.setFocused(undefined); vi.unstubAllGlobals() })

it('snoozes the selected PR across reloads and allows manual restore', async () => {
  const user = userEvent.setup()
  renderReviews()
  await user.click(await screen.findByRole('button', { name: 'Snooze' }))
  expect(await screen.findByText('Body of Second PR')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /octo\/repo #1/ })).not.toBeInTheDocument()
  expect(savedSnoozes.get('viewer:pr1')).toMatchObject({ headRefOid: 'head1', pullRequest: { id: 'pr1' } })
  await user.keyboard('k')
  expect(screen.getByRole('button', { name: /octo\/repo #2/ })).toHaveAttribute('aria-pressed', 'true')

  cleanup()
  queryClient.clear()
  vi.mocked(fetchPullRequestDetails).mockClear()
  renderReviews()
  expect(await screen.findByText('Body of Second PR')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /octo\/repo #1/ })).not.toBeInTheDocument()
  expect(fetchPullRequestDetails).not.toHaveBeenCalledWith('token', 'octo', 'repo', 1)
  await user.click(screen.getByText('Snoozed (1)', { selector: 'summary' }))
  await user.click(screen.getByRole('button', { name: 'Restore First PR' }))
  expect(await screen.findByRole('button', { name: /octo\/repo #1/ })).toBeInTheDocument()
  expect(savedSnoozes.size).toBe(0)
})

it.each([
  { selectedNumber: 2, nextNumber: 3, hiddenNumber: 0 },
  { selectedNumber: 4, nextNumber: 3, hiddenNumber: 0 },
  { selectedNumber: 2, nextNumber: 4, hiddenNumber: 3 },
  { selectedNumber: 4, nextNumber: 2, hiddenNumber: 3 },
])('keeps position after snoozing PR #$selectedNumber (next #$nextNumber, hidden #$hiddenNumber)', async ({ selectedNumber, nextNumber, hiddenNumber }) => {
  const user = userEvent.setup()
  const requests = ['First', 'Second', 'Third', 'Fourth'].map((name, index) => ({
    ...pullRequests[0], id: `pr${index + 1}`, number: index + 1, title: `${name} PR`, url: `https://github.com/octo/repo/pull/${index + 1}`,
  }))
  vi.mocked(fetchReviewRequests).mockResolvedValue({ pullRequests: requests, totalCount: requests.length, nextCursor: null })
  vi.mocked(fetchPullRequestDetails).mockImplementation(async (_token, _owner, _repo, number) => ({
    ...details(1), id: requests[number - 1].id, number, title: requests[number - 1].title, body: `Body of ${requests[number - 1].title}`,
  }))
  if (hiddenNumber) savedSnoozes.set(`viewer:pr${hiddenNumber}`, snoozeRecord(requests[hiddenNumber - 1]))
  renderReviews()
  await user.click(await screen.findByRole('button', { name: new RegExp(`octo/repo #${selectedNumber}`) }))
  expect(await screen.findByText(`Body of ${requests[selectedNumber - 1].title}`)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Snooze' }))
  expect(await screen.findByText(`Body of ${requests[nextNumber - 1].title}`)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: new RegExp(`octo/repo #${nextNumber}`) })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: new RegExp(`octo/repo #${nextNumber}`) })).toHaveFocus()
  expect(screen.queryByRole('button', { name: new RegExp(`octo/repo #${selectedNumber}`) })).not.toBeInTheDocument()
})

it.each([
  { headRefOid: 'head1', authorReplied: true, isClosed: false, event: 'author reply' },
  { headRefOid: 'head2', authorReplied: false, isClosed: false, event: 'new commit' },
])('wakes a snoozed PR on $event', async ({ event: _event, ...activity }) => {
  savedSnoozes.set('viewer:pr1', snoozeRecord())
  renderReviews()
  expect(await screen.findByText('Body of Second PR')).toBeInTheDocument()
  vi.mocked(fetchReviewSnoozeActivity).mockResolvedValue(activity)
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ['review-snooze-activity', 'token', 'viewer'] }) })
  expect(await screen.findByRole('button', { name: /octo\/repo #1/ })).toBeInTheDocument()
  expect(savedSnoozes.size).toBe(0)
})

it('keeps snoozed PRs hidden when only teammate activity updates search results', async () => {
  savedSnoozes.set('viewer:pr1', snoozeRecord())
  renderReviews()
  expect(await screen.findByText('Body of Second PR')).toBeInTheDocument()
  vi.mocked(fetchReviewRequests).mockResolvedValue({ pullRequests: [{ ...pullRequests[0], updatedAt: '2026-05-07T12:00:00Z' }, pullRequests[1]], totalCount: 2, nextCursor: null })
  await act(async () => { await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['review-requests', 'token'] }),
    queryClient.invalidateQueries({ queryKey: ['review-snooze-activity', 'token', 'viewer'] }),
  ]) })
  expect(screen.queryByRole('button', { name: /octo\/repo #1/ })).not.toBeInTheDocument()
  expect(screen.getByText('Snoozed (1)', { selector: 'summary' })).toBeInTheDocument()
  expect(savedSnoozes.size).toBe(1)
})

it('checks snoozed PRs outside loaded search pages and refreshes the queue when they wake', async () => {
  const third = { ...pullRequests[0], id: 'pr3', number: 3, title: 'Third PR' }
  savedSnoozes.set('viewer:pr3', snoozeRecord(third))
  renderReviews()
  expect(await screen.findByText('Body of First PR')).toBeInTheDocument()
  vi.mocked(fetchReviewSnoozeActivity).mockResolvedValue({ headRefOid: 'head1', authorReplied: true, isClosed: false })
  vi.mocked(fetchReviewRequests).mockResolvedValue({ pullRequests: [...pullRequests, third], totalCount: 3, nextCursor: null })
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ['review-snooze-activity', 'token', 'viewer'] }) })
  expect(await screen.findByRole('button', { name: /octo\/repo #3/ })).toBeInTheDocument()
  expect(savedSnoozes.size).toBe(0)
})

it('does not hide a PR when saving its snooze fails', async () => {
  const user = userEvent.setup()
  vi.mocked(saveReviewSnooze).mockRejectedValueOnce(new Error('Storage full'))
  renderReviews()
  await user.click(await screen.findByRole('button', { name: 'Snooze' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not snooze PR. Storage full')
  expect(screen.getByRole('button', { name: /octo\/repo #1/ })).toHaveAttribute('aria-pressed', 'true')
  expect(savedSnoozes.size).toBe(0)
})

it('keeps account-local snoozes separate', async () => {
  savedSnoozes.set('viewer:pr1', snoozeRecord())
  savedSnoozes.set('other:pr2', snoozeRecord(pullRequests[1]))
  vi.mocked(fetchViewer).mockResolvedValue({ id: 'other', login: 'other' })
  renderReviews()
  expect(await screen.findByText('Body of First PR')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /octo\/repo #2/ })).not.toBeInTheDocument()
  expect(savedSnoozes.size).toBe(2)
})

it('reconciles snoozes and restores made in another tab when focus returns', async () => {
  renderReviews()
  expect(await screen.findByText('Body of First PR')).toBeInTheDocument()
  savedSnoozes.set('viewer:pr1', snoozeRecord())
  await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true) })
  expect(await screen.findByText('Body of Second PR')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /octo\/repo #1/ })).not.toBeInTheDocument()
  savedSnoozes.delete('viewer:pr1')
  await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true) })
  expect(await screen.findByRole('button', { name: /octo\/repo #1/ })).toBeInTheDocument()
})

it('keeps an in-flight snooze associated with its original account', async () => {
  const user = userEvent.setup()
  let finishSave!: () => void
  vi.mocked(saveReviewSnooze).mockImplementationOnce(async (viewerId, snooze) => {
    await new Promise<void>((resolve) => { finishSave = resolve })
    savedSnoozes.set(`${viewerId}:${snooze.pullRequest.id}`, snooze)
  })
  renderReviews()
  await user.click(await screen.findByRole('button', { name: 'Snooze' }))
  await act(async () => { queryClient.setQueryData(['viewer', 'token'], { id: 'other', login: 'other' }) })
  await waitFor(() => {
    expect(screen.queryByText('Your review')).not.toBeInTheDocument()
    expect(screen.getByText('Body of First PR')).toBeInTheDocument()
  })
  await act(async () => { finishSave() })
  await waitFor(() => expect(screen.getByRole('button', { name: /octo\/repo #1/ })).toBeInTheDocument())
  expect(savedSnoozes.has('viewer:pr1')).toBe(true)
  expect(savedSnoozes.has('other:pr1')).toBe(false)
})

it('shows all requests and disables snoozing if local snoozes cannot be loaded', async () => {
  vi.mocked(loadReviewSnoozes).mockRejectedValueOnce(new Error('Storage unavailable'))
  renderReviews()
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load snoozed reviews')
  expect(await screen.findByRole('button', { name: /octo\/repo #1/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Snooze' })).toBeDisabled()
})

it('explains failed restore and retries without losing the snoozed entry', async () => {
  const user = userEvent.setup()
  savedSnoozes.set('viewer:pr1', snoozeRecord())
  vi.mocked(deleteReviewSnooze).mockRejectedValueOnce(new Error('Storage unavailable'))
  renderReviews()
  await user.click(await screen.findByText('Snoozed (1)', { selector: 'summary' }))
  await user.click(screen.getByRole('button', { name: 'Restore First PR' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not restore PR')
  expect(savedSnoozes.size).toBe(1)
  await user.click(screen.getByRole('button', { name: 'Restore First PR' }))
  expect(await screen.findByRole('button', { name: /octo\/repo #1/ })).toBeInTheDocument()
  expect(savedSnoozes.size).toBe(0)
})

it('has a distinct all-snoozed state with no hidden keyboard selection', async () => {
  const user = userEvent.setup()
  renderReviews()
  await user.click(await screen.findByRole('button', { name: 'Snooze' }))
  expect(await screen.findByText('Body of Second PR')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Snooze' }))
  expect(await screen.findByText('All loaded review requests are snoozed.')).toBeInTheDocument()
  expect(screen.queryByText('No pending review requests.')).not.toBeInTheDocument()
  await user.keyboard('jk')
  expect(screen.queryByRole('button', { name: /octo\/repo #/ })).not.toBeInTheDocument()
  expect(screen.queryByText(/Body of .* PR/)).not.toBeInTheDocument()
})

it('clearly distinguishes draft and ready-for-review PRs in the same list', async () => {
  vi.mocked(fetchReviewRequests).mockResolvedValue({ pullRequests: [{ ...pullRequests[0], isDraft: true }, pullRequests[1]], totalCount: 2, nextCursor: null })
  vi.mocked(fetchPullRequestDetails).mockResolvedValue({ ...details(1), isDraft: true })
  renderReviews()
  const draft = await screen.findByRole('button', { name: /octo\/repo #1/ })
  const open = screen.getByRole('button', { name: /octo\/repo #2/ })
  expect(draft).toHaveClass('review-state-gray')
  expect(within(draft).getByText('Draft')).toHaveClass('gray')
  expect(within(open).getByText('Open')).toHaveClass('green')
  expect(open).not.toHaveClass('review-state-gray')
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
})

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

it('keeps pending review cards neutral without repeated reason badges and preserves selection', async () => {
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

it.each([
  { state: 'OPEN', isDraft: false, merged: false, reviewDecision: 'APPROVED', reviewer: 'other', tone: 'green', label: 'Approved' },
  { state: 'OPEN', isDraft: false, merged: false, reviewDecision: 'APPROVED', reviewer: 'VIEWER', tone: 'blue', label: 'Approved by you' },
  { state: 'OPEN', isDraft: false, merged: false, reviewDecision: 'REVIEW_REQUIRED', reviewer: 'viewer', tone: 'blue', label: 'Approved by you' },
  { state: 'OPEN', isDraft: false, merged: false, reviewDecision: 'CHANGES_REQUESTED', reviewer: 'viewer', tone: 'red', label: 'Changes requested' },
  { state: 'CLOSED', isDraft: true, merged: false, reviewDecision: 'APPROVED', reviewer: 'viewer', tone: 'red', label: 'Closed' },
  { state: 'MERGED', isDraft: false, merged: true, reviewDecision: 'APPROVED', reviewer: 'viewer', tone: 'purple', label: 'Merged' },
  { state: 'OPEN', isDraft: true, merged: false, reviewDecision: 'APPROVED', reviewer: 'viewer', tone: 'gray', label: 'Draft' },
  { state: 'OPEN', isDraft: false, merged: false, reviewDecision: null, reviewer: 'other', tone: 'green', label: 'Approved' },
  { state: 'OPEN', isDraft: false, merged: false, reviewDecision: null, reviewer: 'other', reviewState: 'CHANGES_REQUESTED', tone: 'red', label: 'Changes requested' },
])('colors all cards $tone for $label without fetching every preview', async ({ reviewer, reviewState = 'APPROVED', tone, label, ...state }) => {
  const user = userEvent.setup()
  const reviews = { nodes: [{ state: reviewState, createdAt: pullRequests[0].updatedAt, author: { login: reviewer } }] }
  vi.mocked(fetchReviewRequests).mockResolvedValue({ pullRequests: pullRequests.map((pr) => ({ ...pr, ...state, reviews, reviewRequests: pullRequests[1].reviewRequests })), totalCount: 2, nextCursor: null })
  vi.mocked(fetchPullRequestDetails).mockReturnValue(new Promise(() => {}))
  renderReviews()
  const first = await screen.findByRole('button', { name: /octo\/repo #1/ })
  const second = screen.getByRole('button', { name: /octo\/repo #2/ })
  await waitFor(() => expect(first).toHaveClass(`review-state-${tone}`))
  for (const card of [first, second]) {
    expect(card).toHaveClass(`review-state-${tone}`)
    expect(within(card).getByText(label)).toHaveClass(tone)
  }
  await user.click(second)
  expect(second).toHaveClass('selected', `review-state-${tone}`)
  expect(second).toHaveFocus()
  expect(fetchPullRequestDetails).toHaveBeenCalledTimes(2)
})

it.each(['REVIEW_REQUIRED', 'APPROVED', null])('keeps re-requested personal reviews pending despite old approval (%s)', async (reviewDecision) => {
  vi.mocked(fetchReviewRequests).mockResolvedValue({ pullRequests: [{
    ...pullRequests[0], reviewDecision,
    reviews: { nodes: [{ state: 'APPROVED', createdAt: pullRequests[0].updatedAt, author: { login: 'viewer' } }] },
  }], totalCount: 1, nextCursor: null })
  renderReviews()
  const card = await screen.findByRole('button', { name: /octo\/repo #1/ })
  expect(await within(card).findByText('Your review')).toBeInTheDocument()
  expect(card).not.toHaveClass('review-state-blue')
  expect(card).not.toHaveClass('review-state-green')
  expect(within(card).queryByText('Approved by you')).not.toBeInTheDocument()
})

it('keeps other reviewers’ approvals green while the viewer is personally requested again', async () => {
  vi.mocked(fetchReviewRequests).mockResolvedValue({ pullRequests: [{
    ...pullRequests[0], reviewDecision: 'APPROVED',
    reviews: { nodes: ['viewer', 'other'].map((login) => ({ state: 'APPROVED', createdAt: pullRequests[0].updatedAt, author: { login } })) },
  }], totalCount: 1, nextCursor: null })
  renderReviews()
  const card = await screen.findByRole('button', { name: /octo\/repo #1/ })
  expect(await within(card).findByText('Your review')).toBeInTheDocument()
  expect(card).toHaveClass('review-state-green')
  expect(within(card).getByText('Approved')).toHaveClass('green')
  expect(within(card).queryByText('Approved by you')).not.toBeInTheDocument()
})

it('distinguishes direct requests, team requests, and both together', async () => {
  const both = { ...pullRequests[0], id: 'pr3', number: 3, reviewRequests: {
    nodes: [...pullRequests[0].reviewRequests!.nodes, ...pullRequests[1].reviewRequests!.nodes],
    pageInfo: { hasNextPage: false },
  } }
  vi.mocked(fetchReviewRequests).mockResolvedValue({ pullRequests: [...pullRequests, both], totalCount: 3, nextCursor: null })
  renderReviews()
  const direct = await screen.findByRole('button', { name: /octo\/repo #1/ })
  const team = screen.getByRole('button', { name: /octo\/repo #2/ })
  const combined = screen.getByRole('button', { name: /octo\/repo #3/ })
  expect(await within(direct).findByText('Your review')).toHaveClass('blue')
  expect(within(direct).queryByText('Team review')).not.toBeInTheDocument()
  expect(within(team).getByText('Team review')).toHaveClass('gray')
  expect(within(team).queryByText('Your review')).not.toBeInTheDocument()
  expect(within(combined).getByText('Your review')).toBeInTheDocument()
  expect(within(combined).getByText('Team review')).toBeInTheDocument()
})

it('does not invent team requests when request details are unavailable or truncated', async () => {
  vi.mocked(fetchReviewRequests).mockResolvedValue({ pullRequests: [
    { ...pullRequests[0], reviews: null, reviewRequests: null },
    { ...pullRequests[1], reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'other' } }, null], pageInfo: { hasNextPage: true } } },
  ], totalCount: 2, nextCursor: null })
  renderReviews()
  const first = await screen.findByRole('button', { name: /octo\/repo #1/ })
  const second = screen.getByRole('button', { name: /octo\/repo #2/ })
  expect(within(first).getByText('Request details unavailable')).toBeInTheDocument()
  expect(within(second).getByText('Request details unavailable')).toBeInTheDocument()
  expect(within(second).getByText('More reviewers on GitHub')).toBeInTheDocument()
  expect(screen.queryByText('Your review')).not.toBeInTheDocument()
  expect(screen.queryByText('Team review')).not.toBeInTheDocument()
})

it('explains unavailable account identity without mislabeling direct requests and allows retry', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchViewer).mockRejectedValueOnce(new Error('Identity unavailable'))
  renderReviews()
  expect(await screen.findByRole('status')).toHaveTextContent('Personal review labels are unavailable')
  const direct = screen.getByRole('button', { name: /octo\/repo #1/ })
  expect(within(direct).queryByText('Request details unavailable')).not.toBeInTheDocument()
  expect(within(direct).queryByText('Team review')).not.toBeInTheDocument()
  expect(within(direct).queryByText('Your review')).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh Reviews' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Refresh Reviews' }))
  expect(await screen.findByText('Your review')).toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
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
  expect(url.searchParams.get('q')).toBe('is:pr is:open review-requested:@me sort:updated-desc')
})
