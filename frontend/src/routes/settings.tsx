import { useAppContext } from '../lib/app-context'
import { GitHubTokenControls } from '../components/github-token-controls'

export function SettingsPage() {
  const { preferences, setAutoRefreshSeconds } = useAppContext()

  return (
    <div className="stack" style={{ gap: 24, maxWidth: 860 }}>
      <div className="stack" style={{ gap: 6 }}>
        <h1 className="title">Settings</h1>
        <p className="subtitle">Pure SPA app. Browser-local token after GitHub auth. No server-side account needed.</p>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <GitHubTokenControls />
      </div>

      <div className="card" style={{ padding: 24 }}>
        <div className="stack">
          <h2 style={{ margin: 0 }}>Inbox behavior</h2>
          <label className="stack">
            <span>Auto refresh seconds</span>
            <input className="form-control" type="number" min={30} step={30} value={preferences.autoRefreshSeconds} onChange={(event) => setAutoRefreshSeconds(Math.max(30, Number(event.target.value) || 120))} />
          </label>
          <div className="notice">Offline: app keeps last inbox snapshot and preview cache in browser IndexedDB.</div>
        </div>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <div className="stack">
          <h2 style={{ margin: 0 }}>Deprecation</h2>
          <p className="muted">Legacy Go backend stays only until this SPA reaches feature parity and validation. Then remove backend fully.</p>
        </div>
      </div>
    </div>
  )
}
