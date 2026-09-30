import { formatRelativeTime, formatStaleness, truncateText } from './format'

describe('truncateText', () => {
  it('truncates long text', () => {
    expect(truncateText('abcdef', 5)).toBe('abcd…')
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-05-07T12:00:00Z')

  it.each([
    ['2026-05-07T11:59:30Z', 'just now'],
    ['2026-05-07T11:55:00Z', '5m ago'],
    ['2026-05-07T10:00:00Z', '2h ago'],
    ['2026-05-05T12:00:00Z', '2d ago'],
    ['2026-05-08T12:00:00Z', 'just now'],
    ['invalid', '—'],
  ])('formats %s as %s', (value: string, expected: string) => {
    expect(formatRelativeTime(value, now)).toBe(expected)
  })
})

describe('formatStaleness', () => {
  it('reports missing sync as red', () => {
    expect(formatStaleness(undefined, 120)).toEqual({ label: 'Never synced', tone: 'red' })
  })
})
