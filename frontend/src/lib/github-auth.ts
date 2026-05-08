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

function authProxyBaseUrl(): string {
  return (import.meta.env.VITE_GITHUB_AUTH_PROXY_URL ?? '').trim().replace(/\/+$/, '')
}

export function hasGitHubDeviceAuthProxy(): boolean {
  return Boolean(authProxyBaseUrl())
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
