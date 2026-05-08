# Self-hosting GitGlance

GitGlance is static frontend app.

Needed parts:
- static file hosting for `frontend/dist`
- optional auth proxy for GitHub OAuth device flow
- no app database
- no app backend for GitHub API data

## Simplest local run

Dev mode:

```bash
cd frontend
npm install
npm run dev
```

Open:
- http://localhost:5173/

If you do not set up auth proxy yet:
- use manual GitHub token entry in app

## Simplest local production-like run

Build:

```bash
cd frontend
VITE_APP_BASE_PATH=/ npm run build
```

Preview built app:

```bash
cd frontend
npm run preview
```

Open Vite preview URL.

## Self-hosting overview

Two choices for login:

1. simplest: no auth proxy
   - users paste GitHub personal access token manually
2. nicer: deploy tiny auth proxy
   - users sign in with GitHub device flow
   - proxy also handles mark-read server-side because browser CORS for GitHub `PATCH` is unreliable

After token exists in browser:
- browser talks to `https://api.github.com` directly
- token stored only in browser storage mode user chose

## Build for your own domain or path

Base path is configurable.

Examples:

Host at site root:

```bash
cd frontend
VITE_APP_BASE_PATH=/ npm run build
```

Host under subpath like `/gitglance/`:

```bash
cd frontend
VITE_APP_BASE_PATH=/gitglance/ npm run build
```

Then upload `frontend/dist/` to any static host.

## Static hosting options

Works on any static host, for example:
- Nginx
- Caddy
- Cloudflare Pages
- Netlify
- Vercel
- GitHub Pages
- S3 + CloudFront

Important:
- serve `frontend/dist/`
- app uses hash routing, so deep-link rewrite rules usually not needed
- keep HTTPS on in production

## Manual-token self-hosting

No proxy needed.

Users need GitHub token with scopes like:
- `notifications`
- `repo` for private repos
- optional `read:user`

Then they paste token into app.

## Optional auth proxy setup

Why:
- GitHub login/device-flow endpoints not browser-CORS friendly
- GitHub notification mark-read `PATCH` is also unreliable from browser because of CORS
- tiny proxy starts/polls device flow and proxies mark-read only

Files:
- `proxy/github-auth-worker.js`
- `proxy/wrangler.toml`

### GitHub OAuth App

Create OAuth App in GitHub settings.

Needed value:
- `GITHUB_CLIENT_ID`

### Cloudflare Worker deploy

Install Wrangler and login:

```bash
npm install -g wrangler
wrangler login
```

Deploy from repo root:

```bash
wrangler secret put GITHUB_CLIENT_ID --config proxy/wrangler.toml
wrangler deploy --config proxy/wrangler.toml
```

Worker env/config:
- `GITHUB_CLIENT_ID`
- `ALLOWED_ORIGINS`
- optional `GITHUB_SCOPE`

Example allowed origins:
- `https://your-domain.example,http://localhost:5173`

### Frontend config for proxy

Official hosted app already defaults to:

- `https://gitglance-auth-proxy.murtagy.workers.dev`

Self-hosters can override proxy URL.

Create local env file:

```bash
cd frontend
cp .env.example .env.local
```

Set for custom proxy:

```bash
VITE_GITHUB_AUTH_PROXY_URL=https://your-worker.example.workers.dev
VITE_APP_BASE_PATH=/
```

Then run/build again.

## Deploy checklist

- build frontend with correct `VITE_APP_BASE_PATH`
- serve `frontend/dist/`
- if using custom auth proxy, deploy worker and set `VITE_GITHUB_AUTH_PROXY_URL`
- verify login or manual token flow works
- verify GitHub API calls succeed from browser
- verify mark-read works through proxy
- verify service worker updates after deploy

## Security notes

- never commit real `.env.local`
- never commit GitHub tokens
- prefer browser `sessionStorage` default for shared machines
- auth proxy should stay stateless and minimal
