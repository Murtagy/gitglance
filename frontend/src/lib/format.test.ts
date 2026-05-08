import { formatStaleness, truncateText } from './format'

describe('truncateText', () => {
  it('truncates long text', () => {
    expect(truncateText('abcdef', 5)).toBe('abcd…')
  })
})

describe('formatStaleness', () => {
  it('reports missing sync as red', () => {
    expect(formatStaleness(undefined, 120)).toEqual({ label: 'Never synced', tone: 'red' })
  })
})
