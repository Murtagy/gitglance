import { createContext, useContext, useMemo, useState } from 'react'
import type { InboxShow, Preferences, StorageMode } from './types'
import { clearToken as clearStoredToken, loadPreferences, loadStorageMode, loadToken, savePreferences, saveStorageMode, saveToken } from './storage'

type AppContextValue = {
  token: string
  storageMode: StorageMode
  preferences: Preferences
  setToken: (token: string) => void
  clearToken: () => void
  setStorageMode: (mode: StorageMode) => void
  setShow: (show: InboxShow) => void
  setAutoRefreshSeconds: (seconds: number) => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences())
  const [storageMode, setStorageModeState] = useState<StorageMode>(() => loadStorageMode())
  const [token, setTokenState] = useState<string>(() => loadToken(loadStorageMode()))

  const persistPreferences = (next: Preferences) => {
    setPreferences(next)
    savePreferences(next)
  }

  const setStorageMode = (mode: StorageMode) => {
    saveStorageMode(mode)
    saveToken(mode, token)
    setStorageModeState(mode)
    setTokenState(loadToken(mode))
    persistPreferences({ ...preferences, storageMode: mode })
  }

  const setToken = (nextToken: string) => {
    setTokenState(nextToken)
    saveToken(storageMode, nextToken)
  }

  const clearToken = () => {
    setTokenState('')
    clearStoredToken()
  }

  const value = useMemo<AppContextValue>(() => ({
    token,
    storageMode,
    preferences,
    setToken,
    clearToken,
    setStorageMode,
    setShow: (show: InboxShow) => persistPreferences({ ...preferences, show }),
    setAutoRefreshSeconds: (seconds: number) => persistPreferences({ ...preferences, autoRefreshSeconds: seconds }),
  }), [token, storageMode, preferences])

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useAppContext() {
  const value = useContext(AppContext)
  if (!value) throw new Error('AppContext missing')
  return value
}
