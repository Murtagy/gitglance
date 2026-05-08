#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
PROXY_URL="http://127.0.0.1:8787"
PROXY_PID=""
FRONTEND_PID=""

cleanup() {
  set +e
  if [ -n "$FRONTEND_PID" ]; then kill "$FRONTEND_PID" 2>/dev/null || true; fi
  if [ -n "$PROXY_PID" ]; then kill "$PROXY_PID" 2>/dev/null || true; fi
  wait "$FRONTEND_PID" 2>/dev/null || true
  wait "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
  echo "frontend/node_modules missing"
  echo "run: cd frontend && npm install"
  exit 1
fi

echo "starting local mark-read proxy on $PROXY_URL"
node "$ROOT_DIR/proxy/local-proxy.mjs" &
PROXY_PID=$!

sleep 1

echo "starting frontend on http://localhost:5173/"
echo "oauth local proxy disabled by default; manual token input expected"
echo "if you want local oauth too: cp proxy/.dev.vars.example proxy/.dev.vars and set GITHUB_CLIENT_ID"
(
  cd "$FRONTEND_DIR"
  VITE_GITHUB_AUTH_PROXY_URL='' \
  VITE_GITHUB_MARK_READ_PROXY_URL="$PROXY_URL" \
  VITE_APP_BASE_PATH=/ \
  npm run dev -- --host 127.0.0.1
) &
FRONTEND_PID=$!

wait "$FRONTEND_PID"
