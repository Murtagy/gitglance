const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEFAULT_SCOPE = 'notifications repo read:user'

export default {
  async fetch(request, env) {
    try {
      const origin = requireAllowedOrigin(request, env)

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) })
      }

      if (request.method !== 'POST') {
        return json({ error: 'method_not_allowed' }, 405, origin)
      }

      const url = new URL(request.url)
      if (url.pathname === '/github/device/code') {
        return startDeviceFlow(request, env, origin)
      }
      if (url.pathname === '/github/device/poll') {
        return pollDeviceFlow(request, env, origin)
      }
      const markReadMatch = url.pathname.match(/^\/github\/notifications\/threads\/([^/]+)\/mark-read$/)
      if (markReadMatch) {
        return markThreadRead(markReadMatch[1], request, origin)
      }

      return json({ error: 'not_found' }, 404, origin)
    } catch (error) {
      const origin = safeAllowedOrigin(request, env)
      const status = error instanceof Response ? error.status : 500
      const body = error instanceof Response
        ? { error: 'origin_not_allowed', error_description: 'Origin not allowed' }
        : { error: 'proxy_error', error_description: error instanceof Error ? error.message : 'Unexpected proxy error' }
      return new Response(JSON.stringify(body), {
        status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...(origin ? corsHeaders(origin) : {}),
        },
      })
    }
  },
}

async function startDeviceFlow(request, env, origin) {
  const clientId = getClientId(env)
  const payload = await readJSON(request)
  const scope = typeof payload.scope === 'string' && payload.scope.trim() ? payload.scope.trim() : (env.GITHUB_SCOPE || DEFAULT_SCOPE)

  const response = await fetchGitHub(GITHUB_DEVICE_CODE_URL, {
    client_id: clientId,
    scope,
  })

  return json(pick(response, ['device_code', 'user_code', 'verification_uri', 'expires_in', 'interval']), 200, origin)
}

async function pollDeviceFlow(request, env, origin) {
  const clientId = getClientId(env)
  const payload = await readJSON(request)
  const deviceCode = typeof payload.deviceCode === 'string' ? payload.deviceCode.trim() : ''
  if (!deviceCode) {
    return json({ error: 'invalid_request', error_description: 'deviceCode required' }, 400, origin)
  }

  const response = await fetchGitHub(GITHUB_ACCESS_TOKEN_URL, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })

  const status = response.error ? 400 : 200
  return json(pick(response, ['access_token', 'token_type', 'scope', 'error', 'error_description', 'interval']), status, origin)
}

async function markThreadRead(threadId, request, origin) {
  const payload = await readJSON(request)
  const token = typeof payload.token === 'string' ? payload.token.trim() : ''
  if (!token) {
    return json({ error: 'invalid_request', error_description: 'token required' }, 400, origin)
  }

  const response = await fetch(`https://api.github.com/notifications/threads/${encodeURIComponent(threadId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gitglance-auth-proxy',
    },
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return json({ error: 'github_mark_read_failed', error_description: text || `GitHub mark-read failed (${response.status})` }, response.status, origin)
  }

  return new Response(null, {
    status: 204,
    headers: {
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  })
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

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean)
}

function safeAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || ''
  return allowedOrigins(env).includes(origin) ? origin : ''
}

function requireAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || ''
  const configuredOrigins = allowedOrigins(env)
  if (!configuredOrigins.length) {
    throw new Error('Missing ALLOWED_ORIGINS')
  }
  if (!configuredOrigins.includes(origin)) {
    throw new Response('Origin not allowed', { status: 403 })
  }
  return origin
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(value, status, origin) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  })
}
