import { useState } from 'react'
import { useAppContext } from '../lib/app-context'
import { GitHubTokenControls } from '../components/github-token-controls'
import { clearAllCaches } from '../lib/storage'

export function SettingsPage() {
  const { preferences, setAutoRefreshSeconds } = useAppContext()
  const [clearingCache, setClearingCache] = useState(false)
  const [cacheMessage, setCacheMessage] = useState('')

  const clearCachedData = async () => {
    setClearingCache(true)
    setCacheMessage('')
    try {
      await clearAllCaches()
      setCacheMessage('Cleared inbox and preview cache from this browser.')
    } catch {
      setCacheMessage('Failed to clear cached data.')
    } finally {
      setClearingCache(false)
    }
  }

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
          <div className="controls">
            <button className="btn secondary" onClick={() => { void clearCachedData() }} disabled={clearingCache}>{clearingCache ? 'Clearing…' : 'Clear cached inbox/preview data'}</button>
          </div>
          {cacheMessage ? <div className="notice">{cacheMessage}</div> : null}
        </div>
      </div>

    </div>
  )
}
