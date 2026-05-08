import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEFAULT_SCOPE = 'notifications repo read:user'
const PORT = Number(process.env.PORT || 8787)

loadDotEnvLike(resolve(process.cwd(), 'proxy/.dev.vars'))
loadDotEnvLike(resolve(process.cwd(), '.env'))

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

createServer(async (request, response) => {
  try {
    const origin = requireAllowedOrigin(request)

    if (request.method === 'OPTIONS') {
      writeEmpty(response, 204, corsHeaders(origin))
      return
    }

    if (request.method !== 'POST') {
      writeJSON(response, 405, { error: 'method_not_allowed' }, origin)
      return
    }

    const url = new URL(request.url || '/', `http://${request.headers.host || `127.0.0.1:${PORT}`}`)
    if (url.pathname === '/github/device/code') {
      await startDeviceFlow(request, response, origin)
      return
    }
    if (url.pathname === '/github/device/poll') {
      await pollDeviceFlow(request, response, origin)
      return
    }

    const markReadMatch = url.pathname.match(/^\/github\/notifications\/threads\/([^/]+)\/mark-read$/)
    if (markReadMatch) {
      await markThreadRead(markReadMatch[1], request, response, origin)
      return
    }

    writeJSON(response, 404, { error: 'not_found' }, origin)
  } catch (error) {
    const origin = safeAllowedOrigin(request)
    const status = error?.statusCode || 500
    const body = error?.code === 'origin_not_allowed'
      ? { error: 'origin_not_allowed', error_description: 'Origin not allowed' }
      : { error: 'proxy_error', error_description: error instanceof Error ? error.message : 'Unexpected proxy error' }
    writeJSON(response, status, body, origin || undefined)
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[gitglance-local-proxy] listening on http://127.0.0.1:${PORT}`)
  console.log(`[gitglance-local-proxy] allowed origins: ${allowedOrigins.join(', ')}`)
  if (!process.env.GITHUB_CLIENT_ID) {
    console.log('[gitglance-local-proxy] GITHUB_CLIENT_ID not set. Device-flow sign-in disabled. Manual token still works.')
  }
})

async function startDeviceFlow(_request, response, origin) {
  const clientId = getClientId()
  const scope = process.env.GITHUB_SCOPE || DEFAULT_SCOPE
  const githubResponse = await fetchGitHub(GITHUB_DEVICE_CODE_URL, {
    client_id: clientId,
    scope,
  })
  writeJSON(response, 200, pick(githubResponse, ['device_code', 'user_code', 'verification_uri', 'expires_in', 'interval']), origin)
}

async function pollDeviceFlow(request, response, origin) {
  const clientId = getClientId()
  const payload = await readJSON(request)
  const deviceCode = typeof payload.deviceCode === 'string' ? payload.deviceCode.trim() : ''
  if (!deviceCode) {
    writeJSON(response, 400, { error: 'invalid_request', error_description: 'deviceCode required' }, origin)
    return
  }

  const githubResponse = await fetchGitHub(GITHUB_ACCESS_TOKEN_URL, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })

  writeJSON(response, githubResponse.error ? 400 : 200, pick(githubResponse, ['access_token', 'token_type', 'scope', 'error', 'error_description', 'interval']), origin)
}

async function markThreadRead(threadId, request, response, origin) {
  const payload = await readJSON(request)
  const token = typeof payload.token === 'string' ? payload.token.trim() : ''
  if (!token) {
    writeJSON(response, 400, { error: 'invalid_request', error_description: 'token required' }, origin)
    return
  }

  const githubResponse = await fetch(`https://api.github.com/notifications/threads/${encodeURIComponent(threadId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gitglance-local-proxy',
    },
  })

  if (!githubResponse.ok) {
    const text = await githubResponse.text().catch(() => '')
    writeJSON(response, githubResponse.status, { error: 'github_mark_read_failed', error_description: text || `GitHub mark-read failed (${githubResponse.status})` }, origin)
    return
  }

  writeEmpty(response, 204, corsHeaders(origin))
}

function getClientId() {
  if (!process.env.GITHUB_CLIENT_ID) {
    throw new Error('Missing GITHUB_CLIENT_ID')
  }
  return process.env.GITHUB_CLIENT_ID
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
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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

function safeAllowedOrigin(request) {
  const origin = request.headers.origin || ''
  return allowedOrigins.includes(origin) ? origin : ''
}

function requireAllowedOrigin(request) {
  const origin = request.headers.origin || ''
  if (!allowedOrigins.length) {
    const error = new Error('Missing ALLOWED_ORIGINS')
    error.statusCode = 500
    throw error
  }
  if (!allowedOrigins.includes(origin)) {
    const error = new Error('Origin not allowed')
    error.code = 'origin_not_allowed'
    error.statusCode = 403
    throw error
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
    'Cache-Control': 'no-store',
  }
}

function writeJSON(response, status, body, origin) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(origin ? corsHeaders(origin) : { 'Cache-Control': 'no-store' }),
  })
  response.end(JSON.stringify(body))
}

function writeEmpty(response, status, headers) {
  response.writeHead(status, headers)
  response.end()
}

function loadDotEnvLike(path) {
  if (!existsSync(path)) return
  const content = readFileSync(path, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index === -1) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}
