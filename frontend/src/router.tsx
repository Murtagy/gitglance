import { useEffect, useRef } from 'react'
import { Link, Outlet, createRootRoute, createRoute, createRouter, createHashHistory, useRouterState } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { useAppContext } from './lib/app-context'
import { InboxPage } from './routes/inbox'
import { SettingsPage } from './routes/settings'

declare global {
  interface Window {
    kofiwidget2?: {
      init: (label: string, color: string, id: string) => void
      draw: () => void
    }
  }
}

function KoFiWidget() {
  const containerRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let cancelled = false

    const draw = () => {
      if (cancelled || !window.kofiwidget2 || !container) return
      container.innerHTML = ''
      const host = document.createElement('span')
      container.appendChild(host)
      const previousBodyPosition = document.body.style.position
      try {
        document.body.style.position = 'relative'
        window.kofiwidget2.init('Thank you', '#313b4d', 'A0A6DPF5O')
        window.kofiwidget2.draw()
      } finally {
        document.body.style.position = previousBodyPosition
      }
      const floatingWidget = document.getElementById('kofi-widget-overlay')
      if (floatingWidget && host.parentElement === container) {
        host.appendChild(floatingWidget)
      }
    }

    if (window.kofiwidget2) {
      draw()
      return () => {
        cancelled = true
        container.innerHTML = ''
      }
    }

    const script = document.createElement('script')
    script.src = 'https://storage.ko-fi.com/cdn/widget/Widget_2.js'
    script.async = true
    script.onload = () => draw()
    container.appendChild(script)

    return () => {
      cancelled = true
      container.innerHTML = ''
    }
  }, [])

  return <span ref={containerRef} />
}

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
              <KoFiWidget />
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
