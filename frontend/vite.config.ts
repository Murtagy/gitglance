import { execSync } from 'node:child_process'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'dev'
  }
}

const buildTime = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
const commit = gitCommit()

function normalizeBasePath(value?: string) {
  if (!value || value === '/') return '/'
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`
}

function contentSecurityPolicy(authProxyUrl?: string) {
  const connectSrc = ["'self'", 'https://api.github.com']
  if (authProxyUrl) {
    connectSrc.push(authProxyUrl)
  }

  return [
    "default-src 'self'",
    `connect-src ${connectSrc.join(' ')}`,
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; ')
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const authProxyUrl = env.VITE_GITHUB_AUTH_PROXY_URL?.trim().replace(/\/+$/, '')
  const base = normalizeBasePath(env.VITE_APP_BASE_PATH || (mode === 'production' ? '/gitglance/' : '/'))

  return {
    base,
    plugins: [
      react(),
      {
        name: 'inject-csp-meta',
        transformIndexHtml(html) {
          if (mode !== 'production') return html
          const csp = contentSecurityPolicy(authProxyUrl)
          return html.replace(
            '</head>',
            `    <meta http-equiv="Content-Security-Policy" content="${csp}">\n  </head>`,
          )
        },
      },
    ],
    define: {
      __APP_COMMIT__: JSON.stringify(commit),
      __APP_BUILD_TIME__: JSON.stringify(buildTime),
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test/setup.ts',
    },
  }
})
