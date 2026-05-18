import { Link, Outlet, createRootRoute, createRoute, createRouter, createHashHistory, useRouterState } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { useAppContext } from './lib/app-context'
import { InboxPage } from './routes/inbox'
import { SettingsPage } from './routes/settings'

function RootLayout() {
  const { token } = useAppContext()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const commitUrl = `https://github.com/Murtagy/gitglance/commit/${__APP_COMMIT__}`

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="container" style={{ padding: 0 }}>
          <div className="topbar-row">
            <nav>
              <Link className={pathname === '/' ? 'active' : ''} to="/" search={{ show: 'unread', selected: '' }}>Inbox</Link>
              <Link className={pathname === '/settings' ? 'active' : ''} to="/settings">Settings</Link>
              {token ? <span className="muted small">Browser-local GitHub token active</span> : <span className="muted small">No token loaded</span>}
            </nav>
            <div className="build-meta small">
              <span>Source:</span>
              <a href={commitUrl} target="_blank" rel="noreferrer"><code>{__APP_COMMIT__}</code></a>
              <span>Updated:</span>
              <span>{__APP_BUILD_TIME__}</span>
              <a className="btn secondary" href="https://ko-fi.com/A0A6DPF5O" target="_blank" rel="noreferrer">Thank you</a>
            </div>
          </div>
        </div>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </div>
  )
}

export const rootRoute = createRootRoute({ component: RootLayout })

export const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: InboxPage,
  validateSearch: (search: Record<string, unknown>) => ({
    show: search.show === 'all' ? 'all' : 'unread',
    selected: typeof search.selected === 'string' ? search.selected : '',
  }),
})

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([inboxRoute, settingsRoute])

export function buildRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    history: createHashHistory(),
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof buildRouter>
  }
}
