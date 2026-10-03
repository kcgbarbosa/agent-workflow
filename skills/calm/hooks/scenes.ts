// Calm scenes: pure frames drawn in place of the spinner.
//
// Every scene is a function of the tick count and the usable width, so a
// frame can be computed (and tested) without a clock. One tick is TICK_MS.
//
// `baton` is a lone conductor at the left edge working through a program of
// gestures: a 4/4 bar, a waltz, slow legato sweeps, a cue, a held fermata, a
// soft passage, a crescendo. The program loops, so he never repeats the same
// gesture for long. A steady stream flows right from every row he stands in,
// a mix of music, code and thinking marks; the row his baton points at plays
// loudest.
import type { CalmScene } from '../types'

export const TICK_MS = 220

export const SCENES: Record<CalmScene, string> = {
  baton: 'a conductor works through a program of gestures while music, code and ideas stream right',
  metronome: 'a pendulum swings at a resting heart rate',
  swell: 'a crescendo and diminuendo to breathe along with, about 8s a breath',
}

export function isScene(name: string): name is CalmScene {
  return Object.hasOwn(SCENES, name)
}

/** A run of cells sharing one style. */
export type Segment = { text: string; color?: string; dim?: boolean; bold?: boolean }
export type Frame = Segment[][]

type Style = { color?: string; dim?: boolean; bold?: boolean }
type Cell = Style & { ch: string }

class Canvas {
  readonly cells: Cell[][]

  constructor(
    readonly width: number,
    rows: number,
  ) {
    this.cells = Array.from({ length: rows }, () =>
      Array.from({ length: width }, () => ({ ch: ' ' })),
    )
  }

  put(row: number, col: number, text: string, style: Style = {}): void {
    const line = this.cells[row]
    if (!line) return
    let x = col
    for (const ch of text) {
      if (x >= 0 && x < this.width) line[x] = { ch, ...style }
      x += 1
    }
  }

  frame(): Frame {
    return this.cells.map(line => {
      const segments: Segment[] = []
      for (const cell of line) {
        const last = segments.at(-1)
        if (last && last.color === cell.color && last.dim === cell.dim && last.bold === cell.bold) {
          last.text += cell.ch
        } else {
          segments.push({ text: cell.ch, color: cell.color, dim: cell.dim, bold: cell.bold })
        }
      }
      return segments
    })
  }
}

// The conductor is three rows tall: head and arms, body and low arms, legs.
// He is drawn in blue; the baton in his right hand is a yellow tip one column
// past it, so the figure spans four columns.
const CONDUCTOR_ROWS = 3
const CONDUCTOR_WIDTH = 4
const LEGS = '/ \\'
const BATON_COL = 3

type PoseName =
  | 'rest'
  | 'up'
  | 'out'
  | 'down'
  | 'left'
  | 'right'
  | 'cue'
  | 'soft'
  | 'softer'

// Each pose: its two upper rows, where the baton's tip is and how it lies,
// and the row of the stream it points at.
const POSES: Record<
  PoseName,
  { rows: readonly [string, string]; baton: { row: 0 | 1 | 2; ch: string }; points: 0 | 1 | 2 }
> = {
  rest: { rows: [' o ', '/|\\'], baton: { row: 2, ch: '╲' }, points: 1 },
  up: { rows: ['\\o/', ' | '], baton: { row: 0, ch: '╱' }, points: 0 },
  out: { rows: ['─o─', ' | '], baton: { row: 0, ch: '─' }, points: 0 },
  down: { rows: [' o ', '/|\\'], baton: { row: 2, ch: '╲' }, points: 2 },
  left: { rows: ['─o ', ' |\\'], baton: { row: 2, ch: '╲' }, points: 1 },
  right: { rows: [' o─', '/| '], baton: { row: 0, ch: '─' }, points: 0 },
  cue: { rows: ['\\o─', ' | '], baton: { row: 0, ch: '─' }, points: 0 },
  soft: { rows: [' o ', '╱|╲'], baton: { row: 2, ch: '╲' }, points: 1 },
  softer: { rows: [' o ', '─|─'], baton: { row: 1, ch: '─' }, points: 2 },
}
const SOFT_POSES = new Set<PoseName>(['soft', 'softer'])

// One gesture: the pose he holds and for how many ticks.
type Step = { pose: PoseName; ticks: number }

const BEAT = 2

const FOUR: Step[] = [
  { pose: 'down', ticks: BEAT },
  { pose: 'left', ticks: BEAT },
  { pose: 'right', ticks: BEAT },
  { pose: 'up', ticks: BEAT },
]
const THREE: Step[] = [
  { pose: 'down', ticks: BEAT },
  { pose: 'right', ticks: BEAT },
  { pose: 'up', ticks: BEAT },
]
const LEGATO: Step[] = [
  { pose: 'out', ticks: BEAT * 2 },
  { pose: 'rest', ticks: BEAT },
  { pose: 'up', ticks: BEAT * 2 },
  { pose: 'down', ticks: BEAT },
]
const CUE: Step[] = [
  { pose: 'right', ticks: BEAT },
  { pose: 'cue', ticks: BEAT * 2 },
  { pose: 'rest', ticks: BEAT },
]
const FERMATA: Step[] = [
  { pose: 'out', ticks: BEAT },
  { pose: 'up', ticks: BEAT * 3 },
  { pose: 'rest', ticks: BEAT },
]
const BREATHE: Step[] = [
  { pose: 'soft', ticks: BEAT },
  { pose: 'softer', ticks: BEAT },
  { pose: 'soft', ticks: BEAT },
  { pose: 'softer', ticks: BEAT },
]
const CRESCENDO: Step[] = [
  { pose: 'soft', ticks: BEAT },
  { pose: 'down', ticks: BEAT },
  { pose: 'rest', ticks: BEAT },
  { pose: 'out', ticks: BEAT },
  { pose: 'up', ticks: BEAT * 2 },
]

// The concert program, about half a minute before it starts again.
const PROGRAM: Step[] = [
  ...FOUR, ...FOUR, ...BREATHE, ...THREE, ...THREE, ...CUE, ...LEGATO,
  ...FOUR, ...CRESCENDO, ...FERMATA, ...THREE, ...BREATHE, ...FOUR,
  ...CUE, ...LEGATO, ...FERMATA,
]

// Each stream sends something every STREAM_EVERY ticks. The program is padded
// to a multiple of it, so the streams loop seamlessly with it.
const STREAM_EVERY = 4
{
  const length = PROGRAM.reduce((sum, step) => sum + step.ticks, 0)
  const pad = (STREAM_EVERY - (length % STREAM_EVERY)) % STREAM_EVERY
  if (pad > 0) PROGRAM.push({ pose: 'rest', ticks: pad })
}

const STARTS = PROGRAM.reduce<number[]>((starts, step, i) => {
  starts.push(i === 0 ? 0 : starts[i - 1]! + PROGRAM[i - 1]!.ticks)
  return starts
}, [])
/** Ticks in one pass of the program. */
export const PROGRAM_TICKS = STARTS.at(-1)! + PROGRAM.at(-1)!.ticks

function within(tick: number): number {
  return ((tick % PROGRAM_TICKS) + PROGRAM_TICKS) % PROGRAM_TICKS
}

/** The pose the conductor holds at `tick`, exposed for tests. */
export function poseAt(tick: number): PoseName {
  const t = within(tick)
  let i = STARTS.length - 1
  while (STARTS[i]! > t) i -= 1
  return PROGRAM[i]!.pose
}

function conductor(canvas: Canvas, tick: number): void {
  const pose = POSES[poseAt(tick)]
  pose.rows.forEach((line, row) => {
    ;[...line].forEach((ch, col) => {
      if (ch !== ' ') canvas.put(row, col, ch, { color: 'blue', bold: true })
    })
  })
  canvas.put(2, 0, LEGS, { color: 'blue', bold: true })
  canvas.put(pose.baton.row, BATON_COL, pose.baton.ch, { color: 'yellow', bold: true })
}

// What the streams carry: music, code, and the marks of thinking things
// through, all in cyan. Each piece is at most three cells, so the four-cell
// spacing always leaves a gap.
const STREAM_COLOR = 'cyan'
const MUSIC = ['♪', '♫', '♩', '♬']
const CODE = ['{}', '</>', '=>', '()', '[]', '&&', '//', 'fn', '$_', '++', 'λ', '#']
const THOUGHT = ['✓', '★', '→', '∞', 'Δ', '?', '!', '✦', '≈', '∑']
const KINDS: readonly (readonly string[])[] = [MUSIC, CODE, THOUGHT]

/** What the `n`th piece of a stream is: a mix that looks unplanned but repeats exactly. */
function pieceFor(n: number, row: number): string {
  const hash = Math.imul(n * 3 + row + 1, 2654435761) >>> 0
  const kind = KINDS[hash % KINDS.length]!
  return kind[(hash >>> 8) % kind.length]!
}

const STREAM_GAP = 1

// Every row the conductor stands in carries a steady stream: a piece leaves
// every STREAM_EVERY ticks, each row offset from the next, and every piece
// travels right one column a tick, so the streams never bunch or drift.
function streams(canvas: Canvas, tick: number): void {
  const start = CONDUCTOR_WIDTH + STREAM_GAP
  const fadeFrom = canvas.width * 0.7
  for (let row = 0; row < CONDUCTOR_ROWS; row += 1) {
    for (let x = start; x < canvas.width; x += 1) {
      const sentAt = tick - (x - start)
      if (sentAt < 0) break
      if ((sentAt + row) % STREAM_EVERY !== 0) continue
      // The row his baton pointed at when the piece left plays loudest; a
      // soft passage is soft on every row.
      const pose = poseAt(sentAt)
      const loud = POSES[pose].points === row && !SOFT_POSES.has(pose)
      const quiet = SOFT_POSES.has(pose) || x > fadeFrom
      const piece = pieceFor(Math.floor(within(sentAt) / STREAM_EVERY), row)
      canvas.put(row, x, piece, quiet ? { color: STREAM_COLOR, dim: true } : { color: STREAM_COLOR, bold: loud })
    }
  }
}

function baton(tick: number, width: number): Frame {
  const canvas = new Canvas(width, CONDUCTOR_ROWS)
  streams(canvas, tick)
  conductor(canvas, tick)
  return canvas.frame()
}

// A full swing (left extreme back to left extreme) takes this many ticks.
const SWING_TICKS = 16
const SWING_REACH = 4

function metronome(tick: number, width: number): Frame {
  const canvas = new Canvas(width, 2)
  const center = Math.min(Math.floor(width / 2), 24)
  const angle = Math.sin((2 * Math.PI * tick) / SWING_TICKS)
  const offset = Math.round(angle * SWING_REACH)

  const atLeft = offset === -SWING_REACH
  const atRight = offset === SWING_REACH
  canvas.put(0, center - SWING_REACH - 1, '·', atLeft ? { color: 'yellow' } : { dim: true })
  canvas.put(0, center + SWING_REACH + 1, '·', atRight ? { color: 'yellow' } : { dim: true })
  canvas.put(0, center + offset, '●', { color: 'yellow' })

  const rod = offset < -1 ? '╲' : offset > 1 ? '╱' : '│'
  canvas.put(1, center - 2, '▁▁', { dim: true })
  canvas.put(1, center, rod, { bold: true })
  canvas.put(1, center + 1, '▁▁', { dim: true })
  canvas.put(1, 0, '♩ = 68', { dim: true })
  return canvas.frame()
}

// One breath in and out across this many ticks.
const BREATH_TICKS = 36
const DYNAMICS = ['pp', 'p', 'mp', 'mf', 'f'] as const

function swell(tick: number, width: number): Frame {
  const canvas = new Canvas(width, 2)
  const phase = (tick % BREATH_TICKS) / BREATH_TICKS
  const openness = (1 - Math.cos(2 * Math.PI * phase)) / 2
  const inhaling = phase < 0.5

  const reach = Math.max(2, Math.min(24, Math.floor((width - 4) / 2)))
  const half = Math.max(1, Math.round(openness * reach))
  const center = reach + 1
  const style = openness > 0.6 ? { color: 'cyan', bold: true } : { color: 'cyan' }
  canvas.put(0, center - half, '━'.repeat(half * 2 + 1), style)

  const level = Math.min(DYNAMICS.length - 1, Math.floor(openness * DYNAMICS.length))
  const mark = DYNAMICS[level]!
  canvas.put(1, center - Math.floor(mark.length / 2), mark, { dim: true })
  canvas.put(1, center + 3, inhaling ? 'cresc.' : 'dim.', { dim: true })
  return canvas.frame()
}

/** The frame of `scene` at `tick`: rows of exactly `width` cells. */
export function renderScene(scene: CalmScene, tick: number, width: number): Frame {
  const usable = Math.max(0, Math.floor(width))
  if (scene === 'metronome') return metronome(tick, usable)
  if (scene === 'swell') return swell(tick, usable)
  return baton(tick, usable)
}
