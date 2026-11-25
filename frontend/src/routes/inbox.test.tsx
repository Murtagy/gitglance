import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppProvider } from '../lib/app-context'
import { buildThreadPreview, fetchInboxSnoozeActivity, fetchNotifications, fetchPullRequestDetails, fetchViewer, markThreadRead, submitPullRequestReview } from '../lib/github'
import { deleteInboxSnooze, loadInboxSnoozes, saveInboxSnooze, wakeInboxSnooze } from '../lib/storage'
import type { InboxSnapshot, InboxSnooze, NotificationThread, PullRequestData } from '../lib/types'
import { buildRouter } from '../router'

vi.mock('../lib/github', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/github')>(),
  fetchNotifications: vi.fn(), fetchViewer: vi.fn(), fetchPullRequestDetails: vi.fn(), fetchInboxSnoozeActivity: vi.fn(),
  markThreadRead: vi.fn(), submitPullRequestReview: vi.fn(),
}))
vi.mock('../lib/storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/storage')>(),
  saveInboxSnapshot: vi.fn().mockResolvedValue(undefined),
  savePreviewSnapshot: vi.fn().mockResolvedValue(undefined),
  loadInboxSnapshot: vi.fn().mockResolvedValue(undefined),
  loadPreviewSnapshot: vi.fn().mockResolvedValue(undefined),
  clearPreviewCaches: vi.fn().mockResolvedValue(undefined),
  loadInboxSnoozes: vi.fn(), saveInboxSnooze: vi.fn(), deleteInboxSnooze: vi.fn(), wakeInboxSnooze: vi.fn(),
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
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'viewer' } }], pageInfo: { hasNextPage: false } },
  commits: { totalCount: 0, nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
  comments: { totalCount: 0, nodes: [] }, files: { nodes: [] }, changedFiles: 1, additions: 30, deletions: 0,
}
let queryClient: QueryClient
const savedSnoozes = new Map<string, InboxSnooze>()
function snoozeRecord(thread: NotificationThread = threads[0]): InboxSnooze {
  return { thread, pullRequest: { ...pr, id: `pr${thread.id}`, number: Number(thread.id) }, snoozedAt: new Date().toISOString() }
}

function renderInbox(token: string = 'token', pullRequest: PullRequestData | ((thread: NotificationThread) => PullRequestData) = pr, inboxThreads: NotificationThread[] = threads): void {
  sessionStorage.setItem('github-token', token)
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  const snapshot: InboxSnapshot = { show: 'unread', threads: inboxThreads, savedAt: new Date().toISOString(), source: 'network', pagesLoaded: 1, nextPage: 2 }
  queryClient.setQueryData(['notifications', 'token', 'unread'], snapshot)
  queryClient.setQueryData(['viewer', 'token'], { id: 'viewer', login: 'viewer' })
  for (const thread of inboxThreads) {
    const details = typeof pullRequest === 'function' ? pullRequest(thread) : pullRequest
    queryClient.setQueryData(['preview', 'token', thread.id], buildThreadPreview(thread, { ...details, id: `pr${thread.id}`, number: Number(thread.id) }))
  }
  render(<QueryClientProvider client={queryClient}><AppProvider><RouterProvider router={buildRouter(queryClient)} /></AppProvider></QueryClientProvider>)
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState({}, '', '/#/')
  vi.clearAllMocks()
  vi.stubGlobal('scrollTo', vi.fn())
  savedSnoozes.clear()
  vi.mocked(loadInboxSnoozes).mockImplementation(async (viewerId) => [...savedSnoozes.entries()].filter(([key]) => key.startsWith(`${viewerId}:`)).map(([, value]) => value))
  vi.mocked(saveInboxSnooze).mockImplementation(async (viewerId, snooze) => { savedSnoozes.set(`${viewerId}:${snooze.thread.id}`, snooze) })
  vi.mocked(deleteInboxSnooze).mockImplementation(async (viewerId, snooze) => {
    const key = `${viewerId}:${snooze.thread.id}`
    if (savedSnoozes.get(key)?.snoozedAt === snooze.snoozedAt) savedSnoozes.delete(key)
  })
  vi.mocked(wakeInboxSnooze).mockImplementation(async (viewerId, snooze) => {
    const key = `${viewerId}:${snooze.thread.id}`
    if (savedSnoozes.get(key)?.snoozedAt === snooze.snoozedAt) savedSnoozes.set(key, { ...snooze, restoredAt: new Date().toISOString() })
  })
  vi.mocked(fetchInboxSnoozeActivity).mockResolvedValue(false)
  vi.mocked(fetchViewer).mockResolvedValue({ id: 'viewer', login: 'viewer' })
  vi.mocked(fetchNotifications).mockResolvedValue({ threads, pagesLoaded: 1, nextPage: 2 })
  vi.mocked(fetchPullRequestDetails).mockResolvedValue(pr)
  vi.mocked(markThreadRead).mockResolvedValue(undefined)
  vi.mocked(submitPullRequestReview).mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals() })

it.each([
  { reason: 'review_requested', tone: 'amber', label: 'Review requested' },
  { reason: 'subscribed', tone: 'gray', label: 'Watching / subscribed' },
  { reason: 'mention', tone: 'blue', label: 'Mention' },
  { reason: 'team_mention', tone: 'blue', label: 'Team mention' },
  { reason: 'manual', tone: 'blue', label: 'Manual' },
  { reason: 'new_reason', tone: 'blue', label: 'New reason' },
])('distinguishes $reason cards and reason badges with $tone styling', async ({ reason, tone, label }) => {
  renderInbox('token', pr, [{ ...threads[0], reason }])
  const card = await screen.findByRole('button', { name: /octo\/repo.*First PR/ })
  expect(card).toHaveClass(`reason-${tone}`)
  expect(within(card).getByText(label, { selector: '.badge' })).toHaveClass(tone)
})

it('preserves notification reason styling when changing selected card', async () => {
  const user = userEvent.setup()
  renderInbox('token', pr, [threads[0], { ...threads[1], reason: 'subscribed' }])
  const requestedCard = await screen.findByRole('button', { name: /octo\/repo.*First PR/ })
  const watchingCard = screen.getByRole('button', { name: /octo\/repo.*Second PR/ })
  expect(requestedCard).toHaveClass('selected', 'reason-amber')
  await user.click(watchingCard)
  expect(watchingCard).toHaveClass('selected', 'reason-gray')
  expect(watchingCard).toHaveFocus()
  expect(requestedCard).not.toHaveClass('selected')
  expect(requestedCard).toHaveClass('reason-amber')
})

it.each([false, true])('shows closed PRs in red ahead of notification reason and draft status (draft: %s)', async (isDraft) => {
  const user = userEvent.setup()
  renderInbox('token', { ...pr, state: 'CLOSED', isDraft }, [threads[0], { ...threads[1], reason: 'subscribed' }])
  await user.click(await screen.findByRole('button', { name: 'Watching' }))
  const requestedCard = await screen.findByRole('button', { name: /octo\/repo.*First PR/ })
  const watchingCard = screen.getByRole('button', { name: /octo\/repo.*Second PR/ })
  for (const card of [requestedCard, watchingCard]) {
    expect(card).toHaveClass('pr-closed')
    expect(within(card).getByText('Closed')).toHaveClass('red')
    expect(within(card).getByLabelText('Closed pull request')).toHaveClass('red')
  }
  expect(within(requestedCard).getByText('Review requested')).toHaveClass('amber')
  expect(within(watchingCard).getByText('Watching / subscribed')).toHaveClass('gray')
  for (const badge of screen.getAllByText('CLOSED')) expect(badge).toHaveClass('red')
  expect(screen.queryByText('DRAFT')).not.toBeInTheDocument()
  await user.click(watchingCard)
  expect(watchingCard).toHaveClass('selected', 'pr-closed')
  expect(watchingCard).toHaveFocus()
  expect(requestedCard).toHaveClass('pr-closed')
  expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
})

it('keeps merged PRs purple rather than treating them as closed', async () => {
  renderInbox('token', { ...pr, state: 'MERGED', merged: true, isDraft: true })
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Watching' }))
  const card = await screen.findByRole('button', { name: /octo\/repo.*First PR/ })
  expect(card).not.toHaveClass('pr-closed')
  expect(within(card).getByLabelText('Merged pull request')).toHaveClass('purple')
  for (const badge of screen.getAllByText('MERGED')) expect(badge).toHaveClass('purple')
  expect(screen.queryByText('Closed')).not.toBeInTheDocument()
})

it('keeps open draft PRs gray without labeling them closed', async () => {
  renderInbox('token', { ...pr, isDraft: true })
  const card = await screen.findByRole('button', { name: /octo\/repo.*First PR/ })
  expect(card).toHaveClass('reason-amber', 'pr-draft')
  expect(card).not.toHaveClass('pr-closed')
  expect(within(card).getByText('Draft')).toHaveClass('gray')
  expect(within(card).getByLabelText('Draft pull request')).toHaveClass('gray')
  for (const badge of screen.getAllByText('DRAFT')) expect(badge).toHaveClass('gray')
  expect(screen.queryByText('Closed')).not.toBeInTheDocument()
})

it('labels open PRs distinctly from drafts in inbox cards', async () => {
  renderInbox()
  const card = await screen.findByRole('button', { name: /octo\/repo.*First PR/ })
  expect(card).not.toHaveClass('pr-draft')
  expect(within(card).getByText('Open')).toHaveClass('green')
  expect(within(card).queryByText('Draft')).not.toBeInTheDocument()
})

it.each([
  { login: 'viewer', color: 'blue', title: 'Approved by you' },
  { login: 'another-reviewer', color: 'green', title: 'Approved' },
])('shows $color approval badges for $login in inbox and summary', async ({ login, color, title }) => {
  renderInbox('token', {
    ...pr, reviewDecision: 'APPROVED',
    reviews: { nodes: [{
      id: 'review1', databaseId: 1, state: 'APPROVED', createdAt: threads[0].updatedAt,
      author: { login }, body: '', comments: { nodes: [] },
    }] },
  })
  await screen.findByRole('button', { name: 'Approve' })
  const badges = screen.getAllByText('Approved', { selector: '.badge' })
  expect(badges).toHaveLength(3)
  for (const badge of badges) {
    expect(badge).toHaveClass(color)
    expect(badge).toHaveAttribute('title', title)
  }
})

it.each(['CHANGES_REQUESTED', 'DISMISSED'])('does not highlight a viewer approval superseded by %s', async (state) => {
  renderInbox('token', {
    ...pr, reviewDecision: 'APPROVED',
    reviews: { nodes: [
      { login: 'viewer', state: 'APPROVED' },
      { login: 'viewer', state },
      { login: 'another-reviewer', state: 'APPROVED' },
    ].map((review, index) => ({
      id: `review${index}`, databaseId: index, state: review.state,
      createdAt: `2026-01-01T00:00:0${index}Z`, author: { login: review.login }, body: '', comments: { nodes: [] },
    })) },
  })
  await screen.findByRole('button', { name: 'Approve' })
  const badges = screen.getAllByText('Approved', { selector: '.badge' })
  expect(badges).toHaveLength(3)
  for (const badge of badges) expect(badge).toHaveClass('green')
  expect(screen.queryByTitle('Approved by you')).not.toBeInTheDocument()
})

it.each(['REVIEW_REQUIRED', 'CHANGES_REQUESTED'])('keeps viewer approval visible when overall decision is %s', async (reviewDecision) => {
  renderInbox('token', {
    ...pr, reviewDecision,
    reviews: { nodes: [{
      id: 'review1', databaseId: 1, state: 'APPROVED', createdAt: threads[0].updatedAt,
      author: { login: 'viewer' }, body: '', comments: { nodes: [] },
    }] },
  })
  await screen.findByRole('button', { name: 'Approve' })
  const badges = screen.getAllByText('Approved', { selector: '.badge' })
  expect(badges).toHaveLength(2)
  for (const badge of badges) expect(badge).toHaveClass('blue')
  expect(screen.getByText(reviewDecision === 'REVIEW_REQUIRED' ? 'Review required' : 'Changes requested')).toBeInTheDocument()
})

it('does not show approval badges without an approval', async () => {
  renderInbox()
  await screen.findByRole('button', { name: 'Approve' })
  expect(screen.queryByText('Approved', { selector: '.badge' })).not.toBeInTheDocument()
})

it('refreshes the reviewed PR without refetching unrelated inbox previews', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchPullRequestDetails).mockResolvedValue({
    ...pr, reviewDecision: 'APPROVED',
    reviews: { nodes: [{
      id: 'approval', databaseId: 1, state: 'APPROVED', createdAt: threads[0].updatedAt,
      author: { login: 'viewer' }, body: '', comments: { nodes: [] },
    }] },
  })
  renderInbox()
  await user.click(await screen.findByRole('button', { name: 'Approve' }))
  await user.click(screen.getByRole('button', { name: 'Submit approval' }))
  await waitFor(() => expect(screen.getAllByTitle('Approved by you')).toHaveLength(2))
  expect(within(screen.getByRole('button', { name: /octo\/repo.*Second PR/ })).queryByText('Approved')).not.toBeInTheDocument()
  expect(fetchPullRequestDetails).toHaveBeenCalledTimes(1)
  expect(fetchPullRequestDetails).toHaveBeenCalledWith('token', 'octo', 'repo', 1)
})

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

it.each([1, 2])('marks read and snoozes PR #%s, retaining nearby selection across refresh and reload', async (number) => {
  const user = userEvent.setup()
  renderInbox()
  await user.click(await screen.findByRole('button', { name: new RegExp(`octo/repo.*${number === 1 ? 'First' : 'Second'} PR`) }))
  await user.click(await screen.findByRole('button', { name: 'Mark read and Snooze' }))
  await screen.findByText('Snoozed (1)')
  const title = number === 1 ? 'First PR' : 'Second PR'
  const remaining = number === 1 ? 'Second PR' : 'First PR'
  expect(markThreadRead).toHaveBeenCalledWith('token', String(number))
  expect(screen.queryByRole('button', { name: new RegExp(`octo/repo.*${title}`) })).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(`octo/repo.*${remaining}`) })).toHaveClass('selected'))
  await user.click(screen.getByRole('button', { name: 'Refresh Inbox' }))
  await waitFor(() => expect(fetchInboxSnoozeActivity).toHaveBeenCalled())
  expect(screen.queryByRole('button', { name: new RegExp(`octo/repo.*${title}`) })).not.toBeInTheDocument()
  cleanup()
  queryClient.clear()
  renderInbox()
  await screen.findByText('Snoozed (1)')
  expect(screen.queryByRole('button', { name: new RegExp(`octo/repo.*${title}`) })).not.toBeInTheDocument()
  await user.click(screen.getByText('Snoozed (1)'))
  const snoozedCard = await screen.findByRole('button', { name: new RegExp(`octo/repo.*${title}`) })
  expect(snoozedCard).toHaveClass('selected')
  expect(within(snoozedCard).queryByLabelText('Unread')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: `Restore ${title}` }))
  expect(await screen.findByText('No snoozed threads.')).toBeInTheDocument()
  expect(savedSnoozes.size).toBe(0)
})

it('keeps an existing review_requested notification hidden until fresh eligible activity', async () => {
  const user = userEvent.setup()
  savedSnoozes.set('viewer:1', snoozeRecord())
  renderInbox()
  await screen.findByText('Snoozed (1)')
  await user.click(screen.getByRole('button', { name: 'Refresh Inbox' }))
  await waitFor(() => expect(fetchInboxSnoozeActivity).toHaveBeenCalled())
  expect(screen.queryByRole('button', { name: /octo\/repo.*First PR/ })).not.toBeInTheDocument()
  vi.mocked(fetchInboxSnoozeActivity).mockResolvedValue(true)
  await user.click(screen.getByRole('button', { name: 'Refresh Inbox' }))
  expect(await screen.findByRole('button', { name: /octo\/repo.*First PR/ })).toBeInTheDocument()
  expect(savedSnoozes.get('viewer:1')?.restoredAt).toBeTruthy()
})

it('checks snoozed PRs outside loaded notification pages and preserves snoozes on check failure', async () => {
  const user = userEvent.setup()
  const outside = { ...threads[0], id: '99', subjectTitle: 'Outside pages' }
  savedSnoozes.set('viewer:99', snoozeRecord(outside))
  vi.mocked(fetchInboxSnoozeActivity).mockRejectedValue(new Error('Rate limited'))
  renderInbox()
  await screen.findByText('Snoozed (1)')
  await user.click(screen.getByRole('button', { name: 'Refresh Inbox' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('octo/repo #99')
  expect(screen.getByRole('alert')).toHaveTextContent('Rate limited')
  expect(savedSnoozes.size).toBe(1)
  await user.click(screen.getByText('Snoozed (1)'))
  expect(await screen.findByRole('link', { name: 'Open in GitHub' })).toHaveAttribute('href', pr.url)
  await user.click(screen.getByRole('button', { name: 'Restore Outside pages' }))
  await waitFor(() => expect(screen.queryByText('Snoozed (1)')).not.toBeInTheDocument())
})

it.each(['mark', 'save'])('handles %s failure without claiming a successful snooze', async (step) => {
  const user = userEvent.setup()
  if (step === 'mark') vi.mocked(markThreadRead).mockRejectedValueOnce(new Error('Network unavailable'))
  else vi.mocked(saveInboxSnooze).mockRejectedValueOnce(new Error('Storage unavailable'))
  renderInbox()
  await user.click(await screen.findByRole('button', { name: 'Mark read and Snooze' }))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(step === 'mark' ? 'Network unavailable' : 'Marked read on GitHub, but could not save snooze')
  expect(screen.queryByText('Snoozed (1)')).not.toBeInTheDocument()
  expect(savedSnoozes.size).toBe(0)
})

it('surfaces eligible activity even while GitHub keeps the notification read, persists the wake, and clears it on mark-read', async () => {
  const user = userEvent.setup()
  savedSnoozes.set('viewer:1', snoozeRecord())
  vi.mocked(fetchInboxSnoozeActivity).mockResolvedValue(true)
  vi.mocked(fetchNotifications).mockResolvedValue({ threads: [threads[1]], pagesLoaded: 1, nextPage: null })
  renderInbox('token', pr, [threads[1]])
  await screen.findByText('Snoozed (1)')
  await user.click(screen.getByRole('button', { name: 'Refresh Inbox' }))
  const card = await screen.findByRole('button', { name: /octo\/repo.*First PR/ })
  expect(within(card).getByText('Woken locally')).toBeInTheDocument()
  expect(within(card).getByLabelText('Unread')).toBeInTheDocument()
  cleanup()
  queryClient.clear()
  renderInbox('token', pr, [threads[1]])
  expect(await screen.findByRole('button', { name: /octo\/repo.*First PR/ })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Mark First PR as read' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: /octo\/repo.*First PR/ })).not.toBeInTheDocument())
  expect(savedSnoozes.size).toBe(0)
})

it('keeps newer GitHub activity timestamps and ordering after a local wake', async () => {
  const restoredAt = '2026-05-07T10:00:00Z'
  const newer = '2026-05-07T11:00:00Z'
  savedSnoozes.set('viewer:1', { ...snoozeRecord(), restoredAt })
  const initial = [{ ...threads[0], updatedAt: '2026-05-07T09:00:00Z' }, { ...threads[1], updatedAt: '2026-05-07T10:30:00Z' }]
  renderInbox('token', pr, initial)
  const card = await screen.findByRole('button', { name: /octo\/repo.*First PR/ })
  expect(card.querySelector('time')).toHaveAttribute('dateTime', restoredAt)
  await act(async () => { queryClient.setQueryData<InboxSnapshot>(['notifications', 'token', 'unread'], (old) => old && ({ ...old, threads: [{ ...initial[0], updatedAt: newer }, initial[1]] })) })
  await waitFor(() => expect(card.querySelector('time')).toHaveAttribute('dateTime', newer))
  const cards = screen.getAllByRole('button', { name: /octo\/repo.*PR/ })
  expect(cards[0]).toHaveTextContent('Second PR')
  expect(cards[1]).toHaveTextContent('First PR')
})

it('respects the 120-second automatic snooze check minimum while allowing manual checks', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  try {
    localStorage.setItem('preferences', JSON.stringify({ autoRefreshSeconds: 30 }))
    savedSnoozes.set('viewer:1', snoozeRecord())
    renderInbox()
    await screen.findByText('Snoozed (1)')
    await act(async () => { vi.advanceTimersByTime(30_000) })
    await waitFor(() => expect(fetchNotifications).toHaveBeenCalled())
    expect(fetchInboxSnoozeActivity).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(90_000) })
    await waitFor(() => expect(fetchInboxSnoozeActivity).toHaveBeenCalledTimes(1))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh Inbox' }))
    await waitFor(() => expect(fetchInboxSnoozeActivity).toHaveBeenCalledTimes(2))
  } finally { vi.useRealTimers() }
})

it('keeps an in-flight snooze associated with its original account and preserves new account selection', async () => {
  const user = userEvent.setup()
  let finishRead!: () => void
  vi.mocked(markThreadRead).mockImplementationOnce(() => new Promise<void>((resolve) => { finishRead = resolve }))
  renderInbox()
  await user.click(await screen.findByRole('button', { name: 'Mark read and Snooze' }))
  await act(async () => { queryClient.setQueryData(['viewer', 'token'], { id: 'other', login: 'other' }) })
  await waitFor(() => expect(loadInboxSnoozes).toHaveBeenCalledWith('other'))
  await user.click(screen.getByRole('button', { name: 'Watching' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /octo\/repo.*First PR/ })).toHaveClass('selected'))
  await act(async () => { finishRead() })
  await waitFor(() => expect(savedSnoozes.has('viewer:1')).toBe(true))
  expect(savedSnoozes.has('other:1')).toBe(false)
  expect(screen.getByRole('button', { name: /octo\/repo.*First PR/ })).toHaveClass('selected')
})

it('keeps failed restores recoverable and excludes every snoozed PR from keyboard selection', async () => {
  const user = userEvent.setup()
  for (const thread of threads) savedSnoozes.set(`viewer:${thread.id}`, snoozeRecord(thread))
  vi.mocked(deleteInboxSnooze).mockRejectedValueOnce(new Error('Storage unavailable'))
  renderInbox()
  await screen.findByText('Snoozed (2)')
  await user.keyboard('jko')
  expect(screen.queryByRole('group', { name: 'Inbox actions' })).not.toBeInTheDocument()
  await user.click(screen.getByText('Snoozed (2)'))
  await user.click(screen.getByRole('button', { name: 'Restore First PR' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not restore inbox thread')
  expect(savedSnoozes.size).toBe(2)
  await user.click(screen.getByRole('button', { name: 'Restore First PR' }))
  expect(await screen.findByText('Snoozed (1)')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /octo\/repo.*First PR/ })).not.toBeInTheDocument()
})

it('isolates snoozes by account and disables new snoozes after a storage read failure', async () => {
  savedSnoozes.set('other-viewer:1', snoozeRecord())
  renderInbox()
  expect(await screen.findByRole('button', { name: /octo\/repo.*First PR/ })).toBeInTheDocument()
  expect(await screen.findByRole('button', { name: 'Mark read and Snooze' })).toBeEnabled()
  cleanup()
  queryClient.clear()
  vi.mocked(loadInboxSnoozes).mockRejectedValueOnce(new Error('Storage unavailable'))
  renderInbox()
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load inbox snoozes')
  expect(screen.getByRole('button', { name: 'Mark read and Snooze' })).toBeDisabled()
})

it('loads more and preserves loaded page count on refresh', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchNotifications).mockResolvedValue({
    threads: [...threads, { ...threads[0], id: '3', subjectType: 'Issue', subjectTitle: 'Third issue' }],
    pagesLoaded: 2, nextPage: null,
  })
  renderInbox()
  await user.click(await screen.findByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: 'Watching' }))
  expect(await screen.findByRole('button', { name: /octo\/repo.*Third issue/ })).toBeInTheDocument()
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

it('groups notifications by ownership and current review requests before draft status', async () => {
  const user = userEvent.setup()
  const nonRequested = { ...pr, reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } } }
  const details: PullRequestData[] = [
    { ...nonRequested, isDraft: true, author: { login: 'VIEWER' } },
    { ...pr, isDraft: true },
    { ...nonRequested, isDraft: true },
    nonRequested,
    pr,
  ]
  const mixed = details.map((_, index): NotificationThread => ({
    ...threads[0], id: String(index + 1), subjectTitle: `Notification ${index + 1}`,
    reason: index < 2 ? 'subscribed' : 'review_requested', subjectType: index === 4 ? 'Issue' : 'PullRequest',
  }))
  renderInbox('token', (thread) => details[Number(thread.id) - 1], mixed)
  const titles = () => screen.getAllByRole('button', { name: /octo\/repo.*Notification/ }).map((row) => row.querySelector('.inbox-item-title')?.textContent)
  expect(await screen.findByRole('button', { name: 'For me' })).toHaveAttribute('aria-pressed', 'true')
  await waitFor(() => expect(titles()).toEqual(['Notification 1', 'Notification 2']))
  await user.click(screen.getByRole('button', { name: 'Watching' }))
  expect(titles()).toEqual(['Notification 4', 'Notification 5'])
  await user.click(screen.getByRole('button', { name: 'Drafts' }))
  expect(titles()).toEqual(['Notification 3'])
})

it('moves a PR on refresh when its review request ends but the notification reason remains', async () => {
  const user = userEvent.setup()
  renderInbox('token', pr, [threads[0]])
  expect(await screen.findByRole('button', { name: /octo\/repo.*First PR/ })).toBeInTheDocument()
  vi.mocked(fetchPullRequestDetails).mockResolvedValue({ ...pr, reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } } })
  vi.mocked(fetchNotifications).mockResolvedValue({ threads: [threads[0]], pagesLoaded: 1, nextPage: null })
  await user.click(screen.getByRole('button', { name: 'Refresh Inbox' }))
  expect(await screen.findByText('No inbox threads in this tab.')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Watching' }))
  expect(await screen.findByRole('button', { name: /octo\/repo.*First PR/ })).toBeInTheDocument()
})

it('clears all snoozes from the tab without changing GitHub read status', async () => {
  const user = userEvent.setup()
  for (const thread of threads) savedSnoozes.set(`viewer:${thread.id}`, snoozeRecord(thread))
  savedSnoozes.set('other:1', snoozeRecord())
  vi.mocked(fetchNotifications).mockImplementation(async (_token, show) => ({
    threads: show === 'all' ? threads.map((thread) => ({ ...thread, unread: false })) : [], pagesLoaded: 1, nextPage: null,
  }))
  renderInbox('token', pr, [])
  await user.click(await screen.findByRole('button', { name: 'Snoozed (2)' }))
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  await user.keyboard('j')
  expect(await screen.findByRole('button', { name: 'Restore Second PR' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Clear all' }))
  expect(await screen.findByText('No snoozed threads.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled()
  expect(markThreadRead).not.toHaveBeenCalled()
  expect([...savedSnoozes.keys()]).toEqual(['other:1'])
  await user.click(screen.getByRole('button', { name: 'For me' }))
  expect(await screen.findByText('No inbox threads in this tab.')).toBeInTheDocument()
  await user.selectOptions(screen.getByRole('combobox'), 'all')
  expect(await screen.findByRole('button', { name: /octo\/repo.*First PR/ })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Mark First PR as read' })).not.toBeInTheDocument()
})

it('can sign in without changing hook order', async () => {
  const user = userEvent.setup()
  renderInbox('')
  await user.type(await screen.findByPlaceholderText('github_pat_...'), 'token')
  await user.click(screen.getByRole('button', { name: 'Save locally' }))
  expect(await screen.findByText('2 loaded')).toBeInTheDocument()
})
