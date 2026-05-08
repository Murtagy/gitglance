const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEFAULT_SCOPE = 'notifications repo read:user'

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) })
      }

      if (request.method !== 'POST') {
        return json({ error: 'method_not_allowed' }, 405, request, env)
      }

      const url = new URL(request.url)
      if (url.pathname === '/github/device/code') {
        return startDeviceFlow(request, env)
      }
      if (url.pathname === '/github/device/poll') {
        return pollDeviceFlow(request, env)
      }

      return json({ error: 'not_found' }, 404, request, env)
    } catch (error) {
      return json({ error: 'proxy_error', error_description: error instanceof Error ? error.message : 'Unexpected proxy error' }, 500, request, env)
    }
  },
}

async function startDeviceFlow(request, env) {
  const clientId = getClientId(env)
  const payload = await readJSON(request)
  const scope = typeof payload.scope === 'string' && payload.scope.trim() ? payload.scope.trim() : (env.GITHUB_SCOPE || DEFAULT_SCOPE)

  const response = await fetchGitHub(GITHUB_DEVICE_CODE_URL, {
    client_id: clientId,
    scope,
  })

  return json(pick(response, ['device_code', 'user_code', 'verification_uri', 'expires_in', 'interval']), 200, request, env)
}

async function pollDeviceFlow(request, env) {
  const clientId = getClientId(env)
  const payload = await readJSON(request)
  const deviceCode = typeof payload.deviceCode === 'string' ? payload.deviceCode.trim() : ''
  if (!deviceCode) {
    return json({ error: 'invalid_request', error_description: 'deviceCode required' }, 400, request, env)
  }

  const response = await fetchGitHub(GITHUB_ACCESS_TOKEN_URL, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })

  const status = response.error ? 400 : 200
  return json(pick(response, ['access_token', 'token_type', 'scope', 'error', 'error_description', 'interval']), status, request, env)
}

function getClientId(env) {
  if (!env.GITHUB_CLIENT_ID) {
    throw new Error('Missing GITHUB_CLIENT_ID')
  }
  return env.GITHUB_CLIENT_ID
}

async function fetchGitHub(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok && !data.error) {
    return {
      error: 'github_auth_failed',
      error_description: `GitHub auth endpoint failed (${response.status})`,
    }
  }
  return data
}

async function readJSON(request) {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

function pick(value, keys) {
  const result = {}
  for (const key of keys) {
    if (key in value && value[key] !== undefined) {
      result[key] = value[key]
    }
  }
  return result
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || ''
  const allowedOrigins = String(env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || '*'

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(value, status, request, env) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
    },
  })
}
