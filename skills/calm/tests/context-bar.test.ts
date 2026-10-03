import { expect, test } from 'claude-code/testing'

import { contextSnapshot, formatTokens, layoutContextBar } from '../hooks/context-bar'

const WINDOW = {
  used: 212_000,
  window: 1_000_000,
  compactAt: 950_000,
  parts: [
    { kind: 'used' as const, tokens: 3_000, color: 'promptBorder' },
    { kind: 'used' as const, tokens: 9_000, color: 'permission' },
    { kind: 'used' as const, tokens: 200_000, color: 'claude' },
    { kind: 'free' as const, tokens: 738_000, color: 'inactive' },
    { kind: 'buffer' as const, tokens: 50_000, color: 'inactive' },
  ],
}

test('figures read like the status panel', async () => {
  const bar = layoutContextBar(WINDOW, 50)
  expect([bar.used, bar.window, bar.compactsAt, bar.percent]).toEqual(['212k', '1M', '950k', 21])
  expect(formatTokens(1_500_000)).toBe('1.5M')
  expect(formatTokens(800)).toBe('800')
})

test('the bar fills to the width, every category shows, and the compaction point is marked', async () => {
  for (const width of [8, 50, 96]) {
    const { cells } = layoutContextBar(WINDOW, width)
    expect(cells).toHaveLength(width)
    for (const color of ['promptBorder', 'permission', 'claude']) {
      expect(cells.some(cell => cell.color === color && !cell.dim)).toBe(true)
    }
    expect(cells.filter(cell => cell.ch === '▕')).toHaveLength(1)
  }
})

test('a session with no breakdown falls back to the status line figures', async () => {
  expect(contextSnapshot({ context: { window: 200_000 } })).toBeNull()
  expect(contextSnapshot({ context: { tokens: 50_000, window: 200_000 } })?.used).toBe(50_000)
})
