const DEFAULT_GITHUB_AUTH_PROXY_URL = 'https://gitglance-auth-proxy.murtagy.workers.dev'

type DeviceFlowStartResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

type DeviceFlowPollResponse = {
  access_token?: string
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
  interval?: number
}

function normalizeUrl(value?: string): string {
  return (value ?? '').trim().replace(/\/+$/, '')
}

function authProxyBaseUrl(): string {
  return normalizeUrl(import.meta.env.VITE_GITHUB_AUTH_PROXY_URL) || DEFAULT_GITHUB_AUTH_PROXY_URL
}

function markReadProxyBaseUrl(): string {
  return normalizeUrl(import.meta.env.VITE_GITHUB_MARK_READ_PROXY_URL) || authProxyBaseUrl()
}

export function hasGitHubDeviceAuthProxy(): boolean {
  return Boolean(authProxyBaseUrl())
}

export function hasGitHubMarkReadProxy(): boolean {
  return Boolean(markReadProxyBaseUrl())
}

async function postJSON<T>(path: string, body: Record<string, unknown>, allowErrorResponse = false): Promise<T> {
  const baseUrl = authProxyBaseUrl()
  if (!baseUrl) throw new Error('GitHub auth proxy not configured')

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok && !allowErrorResponse) {
    const message = typeof data?.error_description === 'string'
      ? data.error_description
      : typeof data?.error === 'string'
        ? data.error
        : `GitHub auth proxy failed (${response.status})`
    throw new Error(message)
  }

  return data as T
}

export async function startGitHubDeviceFlow(): Promise<DeviceFlowStartResponse> {
  return postJSON<DeviceFlowStartResponse>('/github/device/code', {})
}

export async function pollGitHubDeviceFlow(deviceCode: string): Promise<DeviceFlowPollResponse> {
  return postJSON<DeviceFlowPollResponse>('/github/device/poll', { deviceCode }, true)
}

export async function proxyMarkThreadRead(token: string, threadId: string): Promise<void> {
  const baseUrl = markReadProxyBaseUrl()
  if (!baseUrl) throw new Error('GitHub mark-read proxy not configured')

  const response = await fetch(`${baseUrl}/github/notifications/threads/${encodeURIComponent(threadId)}/mark-read`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ token }),
  })

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const message = typeof data?.error_description === 'string'
      ? data.error_description
      : typeof data?.error === 'string'
        ? data.error
        : `GitHub auth proxy failed (${response.status})`
    throw new Error(message)
  }
}
