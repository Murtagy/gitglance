import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAppContext } from '../lib/app-context'
import { fetchViewer } from '../lib/github'
import { hasGitHubDeviceAuthProxy, pollGitHubDeviceFlow, startGitHubDeviceFlow } from '../lib/github-auth'

type DeviceFlowState = {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalMs: number
  expiresAt: number
}

export function GitHubTokenControls({ showConnectedUser = true }: { showConnectedUser?: boolean }) {
  const { token, setToken, clearToken, storageMode, setStorageMode } = useAppContext()
  const [draft, setDraft] = useState(token)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [startingDeviceFlow, setStartingDeviceFlow] = useState(false)
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState | null>(null)
  const [deviceFlowStatus, setDeviceFlowStatus] = useState('')
  const deviceWindowRef = useRef<Window | null>(null)

  useEffect(() => {
    setDraft(token)
  }, [token])

  const viewerQuery = useQuery({
    queryKey: ['viewer', token],
    enabled: Boolean(token) && showConnectedUser,
    queryFn: () => fetchViewer(token),
  })

  const saveManualToken = async () => {
    setChecking(true)
    setError('')
    try {
      const nextToken = draft.trim()
      await fetchViewer(nextToken)
      setToken(nextToken)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to validate token')
    } finally {
      setChecking(false)
    }
  }

  const startDeviceFlow = async () => {
    setStartingDeviceFlow(true)
    setError('')
    setDeviceFlowStatus('')
    try {
      const response = await startGitHubDeviceFlow()
      setDeviceFlow({
        deviceCode: response.device_code,
        userCode: response.user_code,
        verificationUri: response.verification_uri,
        intervalMs: Math.max(5, response.interval) * 1000,
        expiresAt: Date.now() + (Math.max(60, response.expires_in) * 1000),
      })
      deviceWindowRef.current = window.open(response.verification_uri, '_blank', 'noopener,noreferrer')
      setDeviceFlowStatus(deviceWindowRef.current ? 'GitHub verification opened in new tab.' : 'Open GitHub verification page, then enter code below.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start GitHub device flow')
    } finally {
      setStartingDeviceFlow(false)
    }
  }

  useEffect(() => {
    if (!deviceFlow) return

    let cancelled = false
    let timeoutId = 0

    const poll = async () => {
      if (cancelled) return
      if (Date.now() >= deviceFlow.expiresAt) {
        setError('GitHub device code expired. Start again.')
        setDeviceFlow(null)
        setDeviceFlowStatus('')
        return
      }

      try {
        const response = await pollGitHubDeviceFlow(deviceFlow.deviceCode)
        if (cancelled) return

        if (response.access_token) {
          await fetchViewer(response.access_token)
          setToken(response.access_token)
          setDeviceFlow(null)
          setDeviceFlowStatus('Signed in with GitHub.')
          return
        }

        if (response.error === 'authorization_pending') {
          setDeviceFlowStatus('Waiting for GitHub approval…')
          timeoutId = window.setTimeout(poll, deviceFlow.intervalMs)
          return
        }

        if (response.error === 'slow_down') {
          const intervalMs = Math.max(10, response.interval ?? Math.ceil(deviceFlow.intervalMs / 1000) + 5) * 1000
          setDeviceFlow((current) => current ? { ...current, intervalMs } : current)
          setDeviceFlowStatus('GitHub asked app to slow down polling…')
          timeoutId = window.setTimeout(poll, intervalMs)
          return
        }

        if (response.error === 'access_denied') {
          setError('GitHub sign-in was cancelled.')
          setDeviceFlow(null)
          setDeviceFlowStatus('')
          return
        }

        if (response.error === 'expired_token') {
          setError('GitHub device code expired. Start again.')
          setDeviceFlow(null)
          setDeviceFlowStatus('')
          return
        }

        throw new Error(response.error_description || response.error || 'GitHub device flow failed')
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'GitHub device flow failed')
        setDeviceFlow(null)
        setDeviceFlowStatus('')
      }
    }

    timeoutId = window.setTimeout(poll, deviceFlow.intervalMs)
    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [deviceFlow, setToken])

  return (
    <div className="stack">
      <h2 style={{ margin: 0 }}>Token</h2>
      <p className="muted">Stored locally only. Clear any time.</p>
      <div className="split">
        <label><input type="radio" checked={storageMode === 'memory'} onChange={() => setStorageMode('memory')} /> This tab only</label>
        <label><input type="radio" checked={storageMode === 'session'} onChange={() => setStorageMode('session')} /> This browser session</label>
        <label><input type="radio" checked={storageMode === 'local'} onChange={() => setStorageMode('local')} /> Remember on this device</label>
      </div>

      {hasGitHubDeviceAuthProxy() ? (
        <div className="stack" style={{ gap: 12 }}>
          <div className="notice">
            Recommended GitHub OAuth scopes: <code>notifications</code>, <code>repo</code> for private repos, optional <code>read:user</code>.
          </div>
          <div className="controls">
            <button className="btn" onClick={startDeviceFlow} disabled={startingDeviceFlow || Boolean(deviceFlow)}>{startingDeviceFlow ? 'Starting…' : 'Sign in with GitHub'}</button>
            {deviceFlow ? <button className="btn secondary" onClick={() => { setDeviceFlow(null); setDeviceFlowStatus(''); setError('') }}>Cancel sign-in</button> : null}
          </div>
          {deviceFlow ? (
            <div className="card" style={{ padding: 16 }}>
              <div className="stack" style={{ gap: 8 }}>
                <div style={{ fontWeight: 700 }}>Finish sign-in on GitHub</div>
                <div className="muted small">Open <a href={deviceFlow.verificationUri} target="_blank" rel="noreferrer">{deviceFlow.verificationUri}</a> and enter this code:</div>
                <div className="notice" style={{ fontSize: 24, fontWeight: 800, letterSpacing: 2, textAlign: 'center' }}><code>{deviceFlow.userCode}</code></div>
                <div className="muted small">Code expires in about {Math.max(1, Math.ceil((deviceFlow.expiresAt - Date.now()) / 60_000))} minute(s).</div>
              </div>
            </div>
          ) : null}
          {deviceFlowStatus ? <div className="notice">{deviceFlowStatus}</div> : null}
        </div>
      ) : null}

      <label className="stack">
        <span>{hasGitHubDeviceAuthProxy() ? 'Manual token fallback' : 'Personal access token'}</span>
        <div className="muted small">Create or manage tokens at <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer">github.com/settings/tokens</a>.</div>
        <textarea className="form-control" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="github_pat_..." />
      </label>
      <div className="controls">
        <button className="btn" onClick={saveManualToken} disabled={!draft.trim() || checking}>{checking ? 'Checking…' : 'Save locally'}</button>
        <button className="btn secondary" onClick={() => { setDraft(''); setDeviceFlow(null); setDeviceFlowStatus(''); setError(''); clearToken() }}>Clear token</button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {viewerQuery.data ? <div className="notice">Connected GitHub user: <strong>{viewerQuery.data.login}</strong></div> : null}
    </div>
  )
}
