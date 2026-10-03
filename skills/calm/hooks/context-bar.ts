// Calm's context bar: how full the context window is, drawn under the scene.
//
// Pure: it takes a snapshot of the window (from $.session.usage) and a width
// and lays out the header figures and one row of colored cells, so it can be
// tested without a session.
import type { CalmContext } from '../types'

type SessionUsageLike = {
  context: {
    tokens?: number
    window: number
    breakdown?: {
      categories: { tokens: number; color: string; kind: 'used' | 'free' | 'buffer' | 'deferred' }[]
      totalTokens: number
      autoCompactThreshold?: number
      isAutoCompactEnabled: boolean
    }
  }
}

/** The snapshot the bar draws from, out of `$.session.usage({ breakdown })`. */
export function contextSnapshot(usage: SessionUsageLike): CalmContext | null {
  const { context } = usage
  const breakdown = context.breakdown
  if (breakdown) {
    return {
      used: breakdown.totalTokens,
      window: context.window,
      compactAt: breakdown.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null,
      parts: breakdown.categories
        .filter(part => part.kind !== 'deferred' && part.tokens > 0)
        .map(part => ({ kind: part.kind as 'used' | 'free' | 'buffer', tokens: part.tokens, color: part.color })),
    }
  }
  if (context.tokens === undefined) return null
  return {
    used: context.tokens,
    window: context.window,
    compactAt: null,
    parts: [{ kind: 'used', tokens: context.tokens, color: 'claude' }],
  }
}

/** `212k`, `1M`, `950k`, `1.5M`. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return `${tokens}`
}

export type BarCell = { ch: string; color?: string; dim?: boolean }

export type ContextBar = {
  used: string
  window: string
  compactsAt: string | null
  percent: number
  /** Exactly `width` cells. */
  cells: BarCell[]
}

const FILLED = '█'
const MARKER = '▕'

export function layoutContextBar(context: CalmContext, width: number): ContextBar {
  const cells: BarCell[] = []
  const scale = Math.max(context.window, context.parts.reduce((sum, part) => sum + part.tokens, 0), 1)
  const compactCell =
    context.compactAt === null ? null : Math.min(width - 1, Math.round((context.compactAt / scale) * width))

  // Used categories first, each at least one cell so small ones still show.
  let filledTokens = 0
  for (const part of context.parts.filter(one => one.kind === 'used')) {
    filledTokens += part.tokens
    const end = Math.max(cells.length + 1, Math.round((filledTokens / scale) * width))
    while (cells.length < Math.min(end, width)) cells.push({ ch: FILLED, color: part.color })
  }

  // Then the free space, the compaction point, and the reserve past it.
  const free = context.parts.find(part => part.kind === 'free')
  while (cells.length < width) {
    if (compactCell !== null && cells.length === compactCell) {
      cells.push({ ch: MARKER, color: 'yellow' })
    } else if (compactCell !== null && cells.length > compactCell) {
      cells.push({ ch: FILLED, color: 'inactive', dim: true })
    } else {
      cells.push({ ch: FILLED, color: free?.color ?? 'inactive', dim: true })
    }
  }

  return {
    used: formatTokens(context.used),
    window: formatTokens(context.window),
    compactsAt: context.compactAt === null ? null : formatTokens(context.compactAt),
    percent: Math.round((context.used / Math.max(context.window, 1)) * 100),
    cells,
  }
}

/** Runs of cells sharing one style, to draw as few Text elements as possible. */
export function runs(cells: readonly BarCell[]): BarCell[] {
  const out: BarCell[] = []
  for (const cell of cells) {
    const last = out.at(-1)
    if (last && last.color === cell.color && last.dim === cell.dim) last.ch += cell.ch
    else out.push({ ...cell })
  }
  return out
}
