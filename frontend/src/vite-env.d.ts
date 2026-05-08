/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GITHUB_AUTH_PROXY_URL?: string
  readonly VITE_GITHUB_MARK_READ_PROXY_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare const __APP_COMMIT__: string
declare const __APP_BUILD_TIME__: string
