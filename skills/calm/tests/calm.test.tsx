import { describe, expect, mock, test } from 'claude-code/testing'

import { poseAt, PROGRAM_TICKS, renderScene, SCENES } from '../hooks/scenes'
import type { CalmScene } from '../types'

const ALL = Object.keys(SCENES) as CalmScene[]

const typed = (args: string) =>
  ({
    command: 'calm',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  }) as const

const text = (row: { text: string }[]) => row.map(part => part.text).join('')

describe('scenes', () => {
  test('every row of every frame is exactly the width', async () => {
    for (const name of ALL) {
      for (const width of [8, 40, 100]) {
        for (const tick of [0, 1, 7, 33, 500, PROGRAM_TICKS - 1]) {
          const frame = renderScene(name, tick, width)
          expect(frame.length).toBeGreaterThanOrEqual(2)
          for (const row of frame) expect([...text(row)]).toHaveLength(width)
        }
      }
    }
  })

  test('the conductor stands still at the left edge, in blue with a yellow baton', async () => {
    const poses = new Set<string>()
    for (let tick = 0; tick < PROGRAM_TICKS; tick += 1) {
      poses.add(poseAt(tick))
      const frame = renderScene('baton', tick, 60)
      const rows = frame.map(text)
      // No sway: his head and feet never move.
      expect(rows[0]![1]).toBe('o')
      expect(rows[2]!.slice(0, 3)).toBe('/ \\')
      const parts = frame.flat()
      const figure = parts.filter(part => part.color === 'blue').map(part => part.text).join('')
      expect(figure).toContain('o')
      expect(parts.some(part => part.color === 'yellow' && part.text.trim() !== '')).toBe(true)
      // Everything in the streams is cyan.
      for (const part of parts) {
        if (part.text.trim() !== '') expect(['blue', 'yellow', 'cyan']).toContain(part.color)
      }
    }
    expect(poses.size).toBeGreaterThanOrEqual(8)
    expect(renderScene('baton', 0, 60)).toHaveLength(3)
  })

  test('his arms move at least every half second', async () => {
    let held = 0
    let longest = 0
    for (let tick = 1; tick < PROGRAM_TICKS; tick += 1) {
      held = poseAt(tick) === poseAt(tick - 1) ? held + 1 : 0
      longest = Math.max(longest, held)
    }
    // The fermata is the one long hold, six ticks.
    expect(longest + 1).toBeLessThanOrEqual(6)
  })

  test('the streams mix music, code and thinking', async () => {
    const all = Array.from({ length: 40 }, (_, i) => renderScene('baton', 200 + i * 7, 80).map(text).join(''))
    const seen = all.join('')
    expect(seen).toMatch(/[♪♫♩♬]/)
    expect(seen).toMatch(/[{}<>=()\[\]&\/λ#$+]/)
    expect(seen).toMatch(/[✓★→∞Δ?!✦≈∑]/)
  })

  test('the program loops', async () => {
    expect(PROGRAM_TICKS % 4).toBe(0)
    expect(renderScene('baton', 100, 60)).toEqual(renderScene('baton', 100 + PROGRAM_TICKS, 60))
  })

  test('every row carries a steady stream of notes moving right', async () => {
    const rows = (tick: number) => renderScene('baton', tick, 60).map(row => [...text(row)])
    for (const tick of [77, 150, 400]) {
      const now = rows(tick)
      const later = rows(tick + 1)
      now.forEach((line, row) => {
        // The same notes, one column further right.
        // (A piece just sent can be three cells wide, so look past it.)
        expect(later[row]!.slice(8).join('')).toEqual(line.slice(7, 59).join(''))
        // Something every four columns, on every row.
        const count = line.slice(6).filter(ch => ch !== ' ').length
        expect(count).toBeGreaterThanOrEqual(13)
      })
    }
  })
})

describe('presentation', () => {
  test('off by default, on with a scene, and drawing hides quiet tool rows', async ($, on) => {
    mock.store(on)
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        rateLimits: [],
        context: {
          tokens: 212_000,
          window: 1_000_000,
          percent: 21,
          breakdown: {
            categories: [
              {
                name: 'Messages',
                tokens: 212_000,
                color: 'claude',
                isDeferred: false,
                kind: 'used' as const,
              },
              {
                name: 'Free space',
                tokens: 738_000,
                color: 'inactive',
                isDeferred: false,
                kind: 'free' as const,
              },
              {
                name: 'Autocompact buffer',
                tokens: 50_000,
                color: 'inactive',
                isDeferred: false,
                kind: 'buffer' as const,
              },
            ],
            totalTokens: 212_000,
            maxTokens: 1_000_000,
            rawMaxTokens: 1_000_000,
            autocompactSource: 'model-default',
            percentage: 21,
            gridRows: [],
            model: 'test',
            memoryFiles: [],
            mcpTools: [],
            agents: [],
            autoCompactThreshold: 950_000,
            isAutoCompactEnabled: true,
            apiUsage: null,
          },
        },
      },
    }))
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>stock</Text>
    })

    const spinnerProps = { word: 'Thinking', message: null, suffix: '…', mode: 'thinking' } as const
    const stockSpinner = await $.ui.mount({
      plugin: 'calm',
      surface: 'terminal',
      component: 'Spinner',
      props: spinnerProps,
    })
    expect(await stockSpinner.find({ text: 'stock' })).toBeDefined()
    await stockSpinner.unmount()

    const answer = await $.command.run(typed('metronome'))
    expect(answer.text).toContain('metronome')

    const spinner = await $.ui.mount({
      plugin: 'calm',
      surface: 'terminal',
      component: 'Spinner',
      props: spinnerProps,
      viewport: { columns: 60, rows: 30 },
    })
    expect(await spinner.find({ text: /●/ })).toBeDefined()
    // The engine's own line, with its time and token counters, stays above the scene.
    expect(await spinner.find({ text: 'stock' })).toBeDefined()
    expect(await spinner.find({ text: 'context' })).toBeDefined()
    expect(await spinner.find({ text: /compacts at 950k/ })).toBeDefined()
    await spinner.unmount()

    const row = {
      tool_use_id: 't1',
      tool: 'Read',
      input: { file_path: '/x' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    }
    const quiet = await $.ui.mount({
      plugin: 'calm',
      surface: 'terminal',
      component: 'ToolUse',
      props: row,
    })
    expect(await quiet.find({ text: 'stock' })).toBeUndefined()
    await quiet.unmount()

    const failed = await $.ui.mount({
      plugin: 'calm',
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...row, isErrored: true },
    })
    expect(await failed.find({ text: 'stock' })).toBeDefined()
    await failed.unmount()

    const custom = await $.ui.mount({
      plugin: 'calm',
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...row, tool: 'mcp__notes__add' },
    })
    expect(await custom.find({ text: 'stock' })).toBeDefined()
    await custom.unmount()

    await $.command.run(typed('off'))
    const back = await $.ui.mount({
      plugin: 'calm',
      surface: 'terminal',
      component: 'ToolUse',
      props: row,
    })
    expect(await back.find({ text: 'stock' })).toBeDefined()
    await back.unmount()
  })
})
