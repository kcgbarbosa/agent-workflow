// Calm: a conversation-only presentation mode for Claude Code.
//
// Modeled on the Pi Calm extension in kunchenguid's dotfiles. When on, the
// transcript hides the rows of the built-in file and shell tools (errors and
// interruptions stay visible), and the spinner line becomes a small animated
// scene. It changes drawing only: tool calls, the model's context and the
// stored transcript are never touched, and ctrl+o still unfolds tool groups.
//
// `/calm` toggles it, `/calm <scene>` picks a scene and turns it on. The choice
// is kept in this plugin's store, so it survives restarts.
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, RenderElement, Register, Timer } from 'claude-code'

import type { CalmContext, CalmScene } from '../types'
import { contextSnapshot, layoutContextBar, runs } from './context-bar'
import { isScene, renderScene, SCENES, TICK_MS } from './scenes'

const enabled = atom({ plugin: 'calm', key: 'enabled' } as const, false)
const scene = atom({ plugin: 'calm', key: 'scene' } as const, 'baton' as CalmScene)
const tick = atom({ plugin: 'calm', key: 'tick' } as const, 0)
const context = atom({ plugin: 'calm', key: 'context' } as const, null as CalmContext | null)

// The tools whose rows Calm folds away, matching Pi Calm's built-in set.
const QUIET_TOOLS = new Set(['Read', 'Bash', 'Edit', 'MultiEdit', 'Write', 'Grep', 'Glob', 'LS'])

const WIDEST_SCENE = 100

const SCENE_LIST = Object.entries(SCENES)
  .map(([name, about]) => `- \`${name}\`: ${about}`)
  .join('\n')

// The window's fill moves after each model response; the breakdown by
// category is a local estimate, cheap enough to take each time.
// If the figures cannot be had, the bar keeps its last reading.
async function refreshContext($: EngineInterface): Promise<void> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    await update($, context, () => contextSnapshot(usage))
  } catch {
    // Nothing to draw from yet; the next measurement tries again.
  }
}

export const register: Register = on => {
  let ticker: Timer | undefined

  on('session.start', async ($, e, next) => {
    // A timer started inside a turn's dispatch ends with that dispatch, which
    // froze the scene on its first frame. Started here it lives as long as the
    // module; it only advances while Calm is on.
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      void (async () => {
        if (await read($, enabled)) await update($, tick, n => n + 1)
      })()
    })

    const storedEnabled = await $.store.get('enabled')
    const storedScene = await $.store.get('scene')
    await update($, enabled, () => storedEnabled === true)
    await update($, scene, current =>
      typeof storedScene === 'string' && isScene(storedScene) ? storedScene : current,
    )
    await $.command.register({
      name: 'calm',
      description: 'Toggle Calm: hide built-in tool rows and conduct while Claude works',
      argumentHint: '[on|off|scenes|baton|metronome|swell]',
      immediate: true,
    })
    await refreshContext($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') && (await read($, enabled))) await refreshContext($)
    return next(e)
  })

  on('command.run', { command: 'calm' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const wasOn = await read($, enabled)

    if (arg === 'scenes' || arg === 'list') {
      const current = await read($, scene)
      return { text: `Scenes (current: \`${current}\`):\n${SCENE_LIST}` }
    }

    let next: boolean
    if (arg === '') next = !wasOn
    else if (arg === 'on') next = true
    else if (arg === 'off') next = false
    else if (isScene(arg)) {
      next = true
      await update($, scene, () => arg)
      await $.store.set('scene', arg)
    } else {
      return { text: `Unknown option \`${arg}\`. Try \`/calm scenes\`.` }
    }

    await update($, enabled, () => next)
    await $.store.set('enabled', next)
    if (!next) return { text: 'Calm is off.' }
    await refreshContext($)
    return { text: `Calm is on, scene \`${await read($, scene)}\`.` }
  })

  // The spinner line becomes the scene. The desktop draws its own spinner row.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !(await read($, enabled))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.min(WIDEST_SCENE, Math.max(8, (e.viewport?.columns ?? 80) - 4))
    const frame = renderScene(await read($, scene), await read($, tick), width)
    // The engine's own line keeps the elapsed time and token count, which no
    // prop carries; only its word changes.
    const counters = await next({ ...e, props: { ...e.props, word: 'Conducting' } })
    const window = await read($, context)

    return (
      <Box flexDirection="column">
        {counters}
        {frame.map(row => (
          <Text wrap="truncate">
            {row.map(part => (
              <Text color={part.color} dimColor={part.dim} bold={part.bold}>
                {part.text}
              </Text>
            ))}
          </Text>
        ))}
        {window !== null && contextPanel($.ui.resolve(e), window, width)}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const quiet =
      QUIET_TOOLS.has(e.props.tool) && !e.props.isErrored && !e.props.isInterrupted
    if (!quiet || !(await read($, enabled))) return next(e)
    return <></>
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!QUIET_TOOLS.has(e.props.tool) || e.props.isErrored || !(await read($, enabled))) {
      return next(e)
    }
    return <></>
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const quiet =
      !e.props.isExpanded &&
      e.props.calls.every(
        call => QUIET_TOOLS.has(call.tool) && !call.isErrored && !call.isInterrupted,
      )
    if (!quiet || !(await read($, enabled))) return next(e)
    return <></>
  })

  // The line that closes a turn reads like a concert program.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    return next({ ...e, props: { ...e.props, word: 'Conducted' } })
  })
}

const PERCENT_COLORS = [
  { below: 60, color: 'green' },
  { below: 85, color: 'yellow' },
  { below: Infinity, color: 'red' },
]

// The panel under the scene: a rounded box with the figures and the bar.
function contextPanel(
  { Box, Text }: Elements['terminal'],
  window: CalmContext,
  width: number,
): RenderElement {
  // Two border cells and one cell of padding on each side.
  const inner = Math.max(4, width - 4)
  const bar = layoutContextBar(window, inner)
  const badge = PERCENT_COLORS.find(level => bar.percent < level.below)!.color

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1} width={width}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color="claude">◆ </Text>
          <Text bold>context</Text>
        </Text>
        <Text>
          <Text bold>{bar.used}</Text>
          <Text dimColor> of {bar.window}</Text>
          {bar.compactsAt !== null && <Text dimColor> · compacts at {bar.compactsAt}</Text>}
          <Text> </Text>
          <Text backgroundColor={badge} color="black" bold>
            {` ${bar.percent}% `}
          </Text>
        </Text>
      </Box>
      <Text wrap="truncate">
        {runs(bar.cells).map(run => (
          <Text color={run.color} dimColor={run.dim}>
            {run.ch}
          </Text>
        ))}
      </Text>
    </Box>
  )
}
