import type { InboxShow, InboxSnapshot, Preferences, PreviewSnapshot, StorageMode } from './types'

const DB_NAME = 'ghnotifs-spa'
const DB_VERSION = 1
const KV_STORE = 'kv'
const PREFS_KEY = 'preferences'
const TOKEN_MODE_KEY = 'token-storage-mode'
const SESSION_TOKEN_KEY = 'github-token'
const LOCAL_TOKEN_KEY = 'github-token'

let memoryToken = ''
let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE)
      }
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => {
      dbPromise = null
      reject(request.error)
    }
  })

  return dbPromise
}

async function getValue<T>(key: string): Promise<T | undefined> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, 'readonly')
    const store = tx.objectStore(KV_STORE)
    const request = store.get(key)
    request.onsuccess = () => resolve(request.result as T | undefined)
    request.onerror = () => reject(request.error)
  })
}

async function setValue<T>(key: string, value: T): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, 'readwrite')
    const store = tx.objectStore(KV_STORE)
    const request = store.put(value, key)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

async function clearKeysMatching(predicate: (key: string) => boolean): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, 'readwrite')
    const store = tx.objectStore(KV_STORE)
    const cursorRequest = store.openCursor()
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        resolve()
        return
      }
      if (predicate(String(cursor.key))) {
        cursor.delete()
      }
      cursor.continue()
    }
    cursorRequest.onerror = () => reject(cursorRequest.error)
  })
}

export async function clearPreviewCaches(): Promise<void> {
  return clearKeysMatching((key) => key.startsWith('preview:'))
}

export async function clearInboxCaches(): Promise<void> {
  return clearKeysMatching((key) => key.startsWith('inbox:'))
}

export async function clearAllCaches(): Promise<void> {
  return clearKeysMatching((key) => key.startsWith('preview:') || key.startsWith('inbox:'))
}

export async function saveInboxSnapshot(snapshot: InboxSnapshot): Promise<void> {
  await setValue(`inbox:${snapshot.show}`, snapshot)
}

export async function loadInboxSnapshot(show: InboxShow): Promise<InboxSnapshot | undefined> {
  return getValue<InboxSnapshot>(`inbox:${show}`)
}

export async function savePreviewSnapshot(threadId: string, snapshot: PreviewSnapshot): Promise<void> {
  await setValue(`preview:${threadId}`, snapshot)
}

export async function loadPreviewSnapshot(threadId: string): Promise<PreviewSnapshot | undefined> {
  return getValue<PreviewSnapshot>(`preview:${threadId}`)
}

const DEFAULT_PREFERENCES: Preferences = {
  show: 'unread',
  autoRefreshSeconds: 120,
  autoOpenLinesThreshold: 12,
  storageMode: 'session',
}

export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFERENCES
    return { ...DEFAULT_PREFERENCES, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

export function savePreferences(preferences: Preferences): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(preferences))
}

export function loadStorageMode(): StorageMode {
  const raw = localStorage.getItem(TOKEN_MODE_KEY)
  if (raw === 'memory' || raw === 'session' || raw === 'local') return raw
  return 'session'
}

export function saveStorageMode(mode: StorageMode): void {
  localStorage.setItem(TOKEN_MODE_KEY, mode)
}

export function loadToken(mode: StorageMode): string {
  if (mode === 'memory') return memoryToken
  if (mode === 'session') return sessionStorage.getItem(SESSION_TOKEN_KEY) ?? ''
  return localStorage.getItem(LOCAL_TOKEN_KEY) ?? ''
}

export function saveToken(mode: StorageMode, token: string): void {
  memoryToken = mode === 'memory' ? token : ''
  if (mode === 'session') {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token)
    localStorage.removeItem(LOCAL_TOKEN_KEY)
    return
  }
  if (mode === 'local') {
    localStorage.setItem(LOCAL_TOKEN_KEY, token)
    sessionStorage.removeItem(SESSION_TOKEN_KEY)
    return
  }
  sessionStorage.removeItem(SESSION_TOKEN_KEY)
  localStorage.removeItem(LOCAL_TOKEN_KEY)
}

export function clearToken(): void {
  memoryToken = ''
  sessionStorage.removeItem(SESSION_TOKEN_KEY)
  localStorage.removeItem(LOCAL_TOKEN_KEY)
}
