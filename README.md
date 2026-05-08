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

## Local development

Requirements:

- Node.js 22+

Install:

```bash
cd frontend
npm install
```

Run dev server:

```bash
cd frontend
npm run dev
```

Open:

- http://localhost:5173/
  - or URL Vite prints

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

Setup instructions:

- GitHub OAuth App: `GitHub -> Settings -> Developer settings -> OAuth Apps -> New OAuth App`
- Cloudflare Worker config: `proxy/wrangler.toml`
- Worker source: `proxy/github-auth-worker.js`
- GitHub Pages build secret: `Settings -> Secrets and variables -> Actions -> VITE_GITHUB_AUTH_PROXY_URL`

Deploy quickstart:

```bash
cd proxy
wrangler secret put GITHUB_CLIENT_ID
wrangler deploy
```

If running Wrangler from repo root, pass config explicitly:

```bash
wrangler secret put GITHUB_CLIENT_ID --config proxy/wrangler.toml
wrangler deploy --config proxy/wrangler.toml
```

## GitHub auth proxy

GitHub login endpoints are not browser-CORS friendly, so pure SPA device flow needs a tiny auth broker.

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
- no GitHub API proxying
- no database
- no token persistence by design
- final GitHub token returned to browser, then browser talks to `api.github.com` directly

Required Worker env vars:

- `GITHUB_CLIENT_ID` — GitHub OAuth App client ID
- `ALLOWED_ORIGINS` — comma-separated app origins, for example:
  - `https://murtagy.github.io,http://localhost:5173`

Optional Worker env vars:

- `GITHUB_SCOPE` — default scope string

Frontend env:

- `frontend/.env.example`
- `VITE_GITHUB_AUTH_PROXY_URL=https://your-worker-or-domain`

Transparency note:

- proxy can see OAuth tokens in transit during exchange
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
