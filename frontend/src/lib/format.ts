export function formatDateTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function formatShortDateTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function truncateText(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

export function formatStaleness(lastSyncAt?: string | null, autoRefreshSeconds = 120): { label: string; tone: 'green' | 'amber' | 'red' } {
  if (!lastSyncAt) {
    return { label: 'Never synced', tone: 'red' }
  }
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(lastSyncAt).getTime()) / 1000))
  if (seconds < 60) return { label: `Fresh · ${seconds}s ago`, tone: 'green' }
  const minutes = Math.floor(seconds / 60)
  if (seconds <= autoRefreshSeconds * 2) return { label: `Fresh · ${minutes}m ago`, tone: 'green' }
  if (seconds <= autoRefreshSeconds * 4) return { label: `Refresh lagging · ${minutes}m ago`, tone: 'amber' }
  return { label: `Refresh stalled · ${minutes}m ago`, tone: 'red' }
}
