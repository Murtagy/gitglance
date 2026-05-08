# GitGlance

GitHub notifications inbox with PR-aware previews.

Live site:

- https://murtagy.github.io/gitglance/

## What repo is now

Pure client-side SPA.

- no Go backend for GitHub API data
- optional minimal auth broker for GitHub OAuth device flow
- GitHub token stays in browser storage after auth
- app fetches GitHub Notifications + PR details directly from GitHub APIs

## Repo structure

```text
.
├── .github/workflows/github-pages.yml   # GitHub Pages deploy
├── frontend/                            # React + TypeScript SPA
│   ├── src/
│   │   ├── lib/                         # GitHub API, storage, formatting, types
│   │   ├── routes/                      # Inbox + Settings routes
│   │   └── test/                        # test setup
│   ├── public/sw.js                     # service worker
│   ├── package.json                     # frontend scripts
│   └── README.md                        # frontend-specific notes
├── TODO
└── README.md
```

## Main features

- inbox-first GitHub notifications UI
- right-side PR preview
- exact new activity since last read
- review/comment/commit aggregation
- mark read
- keyboard shortcuts:
  - `j/k` move
  - `o` open on GitHub
  - `m` mark read
  - `r` refresh
- local cache + offline last snapshot
- GitHub Pages hosting

## Super simple local run

Requirements:

- Node.js 22+

One command:

```bash
cd frontend && npm install
cd .. && ./dev.sh
```

Open:

- http://localhost:5173/

What this does:
- starts frontend dev server
- starts local Node proxy for mark-read
- local dev expects manual GitHub token input
- no Wrangler needed
- no local OAuth setup needed

Alternative frontend-only run:

```bash
cd frontend
npm run dev
```

Then paste GitHub token manually in app.

## Local production-like run

```bash
cd frontend
VITE_APP_BASE_PATH=/ npm run build
npm run preview
```

## Self-hosting

Full guide:

- `SELF_HOSTING.md`

Short version:

- build `frontend/dist/`
- serve static files on any static host
- optional auth proxy for GitHub device-flow login
- mark-read can use either public proxy, Cloudflare Worker, or local Node proxy
- otherwise users can paste GitHub token manually

## Test

```bash
cd frontend
npm test
```

## Build

```bash
cd frontend
npm run build
```

## GitHub Pages deploy

Workflow:

- `.github/workflows/github-pages.yml`

Repo settings:

- `Settings -> Pages -> Source -> GitHub Actions`

Production URL:

- https://murtagy.github.io/gitglance/

## Token and storage

Token never belongs in git.

Current storage behavior:

- GitHub sign-in: OAuth device flow via minimal auth proxy, or manual PAT fallback
- default token storage: `sessionStorage`
- optional token storage: memory-only or `localStorage`
- inbox/preview cache: IndexedDB
- preferences: `localStorage`

## GitHub auth proxy

GitHub login endpoints are not browser-CORS friendly, so pure SPA device flow needs a tiny auth broker.

Setup and deploy details:

- `SELF_HOSTING.md`

Quickstart:

- GitHub OAuth App: `GitHub -> Settings -> Developer settings -> OAuth Apps -> New OAuth App`
- Cloudflare Worker config: `proxy/wrangler.toml`
- Worker source: `proxy/github-auth-worker.js`
- Official public proxy default: `https://gitglance-auth-proxy.murtagy.workers.dev`
- Optional frontend override variable: `VITE_GITHUB_AUTH_PROXY_URL`

Deploy quickstart:

```bash
wrangler secret put GITHUB_CLIENT_ID --config proxy/wrangler.toml
wrangler deploy --config proxy/wrangler.toml
```

Worker source:

- `proxy/github-auth-worker.js`

One-time deploy example:

```bash
npm install -g wrangler
wrangler login
wrangler deploy proxy/github-auth-worker.js
```

Then configure Worker env vars in Cloudflare dashboard or Wrangler:

- `GITHUB_CLIENT_ID`
- `ALLOWED_ORIGINS`
- optional `GITHUB_SCOPE`

Design goals:

- only handles GitHub OAuth device-flow bootstrap + polling
- only extra GitHub API proxying is notification mark-read
- no database
- no token persistence by design
- final GitHub token returned to browser, then browser talks to `api.github.com` directly for normal reads/previews

Required Worker env vars:

- `GITHUB_CLIENT_ID` — GitHub OAuth App client ID
- `ALLOWED_ORIGINS` — comma-separated app origins, for example:
  - `https://murtagy.github.io,http://localhost:5173`

Optional Worker env vars:

- `GITHUB_SCOPE` — default scope string

Frontend env:

- `frontend/.env.example`
- official hosted app already defaults to `https://gitglance-auth-proxy.murtagy.workers.dev`
- self-hosters can override with `VITE_GITHUB_AUTH_PROXY_URL=...`

Transparency note:

- proxy can see OAuth tokens in transit during exchange
- proxy can also see token on proxied mark-read calls
- proxy should be kept stateless, open source, and narrowly scoped
- after exchange, token lives in browser storage chosen by user

## Security rules

- never commit PATs
- never commit `.env` files
- never commit built secrets/log/db artifacts
- GitHub API traffic stays browser-direct after auth
- auth broker should stay stateless and narrowly scoped

Ignored by git:

- `.env`
- `.env.*`
- `frontend/node_modules/`
- `frontend/dist/`
- `frontend/*.tsbuildinfo`

## Frontend docs

See:

- `frontend/README.md`
