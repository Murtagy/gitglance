# GitGlance Frontend

Pure client-side GitHub notifications inbox.

Main repo docs live in:

- `../README.md`

## Goals

- browser-local GitHub token after auth
- no backend account/session/token storage
- optional minimal auth broker for GitHub OAuth device flow
- inbox-first GitHub notifications UX
- PR preview enrichment direct from GitHub APIs
- offline last-snapshot fallback

## Stack

- React
- TypeScript
- Vite
- TanStack Router
- TanStack Query
- IndexedDB for cached inbox/previews

## Run

Simplest repo-level local run:

```bash
cd frontend && npm install
cd .. && ./dev.sh
```

Frontend-only run:

```bash
cd frontend
npm run dev
```

Optional local auth-proxy override:

```bash
cp .env.example .env.local
# set custom proxy env vars only if using your own hosted proxy
```

## Build

```bash
cd frontend
npm run build
```

Production build uses GitHub Pages base path:

- `/gitglance/`
- routing uses hash history, so deep links work on Pages

## Test

```bash
cd frontend
npm test
```

## Storage

- token default: `sessionStorage`
- token optional: memory-only or `localStorage`
- inbox/preview cache: IndexedDB
- preferences: `localStorage`

## Auth proxy

For deploy/setup instructions, see:

- `../README.md#github-auth-proxy`


GitHub OAuth/device-flow login endpoints do not work cleanly from pure browser code because of GitHub login endpoint limitations. This app can use a tiny auth broker instead.

Expected frontend env for custom self-hosting override:

- `VITE_GITHUB_AUTH_PROXY_URL`
- `VITE_GITHUB_MARK_READ_PROXY_URL`

Proxy sources in repo:

- `../proxy/github-auth-worker.js`
- `../proxy/local-proxy.mjs`

Proxy goals:

- optional device flow start + poll for hosted OAuth proxy
- proxy notification mark-read
- no persistent token storage
- no broad GitHub API proxying after auth

## GitHub Pages

Workflow:

- `.github/workflows/github-pages.yml`

Repo settings needed:

- Settings → Pages
- Source: GitHub Actions
