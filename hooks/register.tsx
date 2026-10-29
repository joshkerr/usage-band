import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheFacts, Window } from '../types'
import { HUE, ROBO_SIZE, roboSvg } from './robo'
import type { Mode } from './robo'

// One slim row above the prompt. Three facts, left to right:
//   7D  ●●●●●●●···  68% left · 3d 9h      the 7-day window, what is LEFT, and its reset
//   5H  ●●●●●●●●●·  92% left · 2h 14m     the 5-hour window, the same
//   [robo]  WARM 47m left                  the prompt cache: WARM, COOLING (last 10 min) or COLD,
//                                          led by Robo, who bobs while warm and freezes when cold
//
// Zero token cost: it reads the engine's own usage figures and draws them.
// Narrow bands stack each window into a small block; the terminal gets the same facts as text.
// Adapted from ribbon (github.com/robonuggets/ribbon, MIT), without the drawings and price table.

const CELLS = 10
const TIGHT_CELLS = 6
const LOW_AT = 15
/** The prompt cache lives this long after the last request that read or wrote it. */
const TTL_MIN = 60
const TTL_MS = TTL_MIN * 60_000
/** Under this many minutes left the cache reads as COOLING. */
const COOLING_AT_MIN = 10
/** How often the band redraws, so countdowns and the warm-to-cold flip stay current. */
const TICK_MS = 30_000
/** One row fits two windows and the cache at about 78 columns; under 42 the bars shrink too. */
const WIDE_AT = 78
const TIGHT_AT = 42

// Colours: the band's own warm dark look.
const BG = '#24221c'
const TEXT = '#e8e2d2'
const MUTED = '#8d8775'
const EMPTY = '#4a463b'
const ORANGE = '#ff6b1a'
const YELLOW = '#f5a623'
const INK = '#1c1a16'

type Kind = 'wide' | 'stacked' | 'tight'

const windows = atom({ plugin: 'usage-band', key: 'windows' } as const, [] as Window[])
const cache = atom({ plugin: 'usage-band', key: 'cache' } as const, null as CacheFacts | null)

const NAMES: Record<string, string> = { seven_day: '7D', five_hour: '5H', spend_limit: 'SPEND' }
const ORDER: Record<string, number> = { seven_day: 0, five_hour: 1 }
const COLORS: Record<string, string> = { seven_day: ORANGE, five_hour: YELLOW }

const clean = (list: readonly Window[]): Window[] =>
  list
    .map(w => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }))
    .sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9))

const dots = (left: number, cells: number): { on: string; off: string } => {
  const n = Math.max(0, Math.min(cells, Math.round((left / 100) * cells)))
  return { on: '●'.repeat(n), off: '·'.repeat(cells - n) }
}

/** A span in minutes as `42m`, `3h 9m` or `2d 5h`. */
const fmtSpan = (ms: number): string => {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const fmtReset = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'resetting'
  return fmtSpan(ms)
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)

const kindOf = (columns: number): Kind => (columns >= WIDE_AT ? 'wide' : columns >= TIGHT_AT ? 'stacked' : 'tight')

type CacheView = { mode: Mode; label: string; tokens: number }

/** What the cache reads as right now, or null until a main-thread request has been seen. */
export const viewOf = (c: CacheFacts | null, now: number): CacheView | null => {
  if (!c || c.lastAt <= 0) return null
  const idleMs = Math.max(0, now - c.lastAt)
  if (idleMs >= TTL_MS) return { mode: 'cold', label: `${fmtSpan(idleMs)} idle`, tokens: c.tokens }
  const leftMs = TTL_MS - idleMs
  const mode: Mode = leftMs <= COOLING_AT_MIN * 60_000 ? 'cooling' : 'warm'
  return { mode, label: `${fmtSpan(leftMs)} left`, tokens: c.tokens }
}

const pull = async ($: EngineInterface): Promise<void> => {
  const u = await $.session.usage()
  await update($, windows, () => clean(u.rateLimits))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await pull($)
    $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, windows, () => clean(e.rateLimits))
    }
    if (e.changed.includes('context') && e.context.tokens && e.context.tokens > 0) {
      const tokens = e.context.tokens
      await update($, cache, c => (c ? { ...c, tokens } : c))
    }
    return next(e)
  })

  // A resumed or forked session knows how long it was away; a clear or compact starts the cache over.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear' || e.source === 'compact') {
      await update($, cache, () => null)
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const now = await $.clock.now()
      const lastAt = now - e.seconds_since_last_response * 1000
      const tokens = typeof e.context_tokens === 'number' ? e.context_tokens : 0
      await update($, cache, () => ({ lastAt, tokens }))
    }
    return r
  }).catch(($, e, next) => next(e))

  // Each main-thread request reads or writes the cache, so its start resets the hour.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, cache, c => ({ lastAt: now, tokens: c?.tokens ?? 0 }))
    }
    yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const now = await $.clock.now()
    const c = await read($, cache)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    const lastAt = !c || now - c.lastAt > e.durationMs ? now : c.lastAt
    const u = await $.session.usage()
    const tokens = u.context.tokens && u.context.tokens > 0 ? u.context.tokens : (c?.tokens ?? 0)
    await update($, cache, () => ({ lastAt, tokens }))
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    // Robo is a drawing: desktop, VS Code and mobile draw it; the terminal has no Svg.
    // Ask the surface, not the table: the terminal's table still lists Svg.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const list = await read($, windows)
    const now = await $.clock.now()
    const view = viewOf(await read($, cache), now)

    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 100
    const kind = kindOf(columns)
    const isWide = kind === 'wide'
    const cells = kind === 'tight' ? TIGHT_CELLS : CELLS

    const parts = (w: Window) => {
      const left = Math.max(0, Math.round((100 - w.percentUsed) * 10) / 10)
      return {
        left,
        col: COLORS[w.kind] ?? TEXT,
        name: NAMES[w.kind] ?? w.kind.toUpperCase(),
        d: dots(left, cells),
        reset: fmtReset(w.resetsAt, now),
      }
    }

    const wide = (w: Window, i: number) => {
      const p = parts(w)
      return (
        <Box key={`w-${i}`} flexDirection="row" flexShrink={0} marginRight={3}>
          <Text color={MUTED} bold>{p.name} </Text>
          <Text color={p.col}>{p.d.on}</Text>
          <Text color={EMPTY}>{p.d.off}</Text>
          <Text color={p.col} bold> {p.left}% left</Text>
          {p.left < LOW_AT ? <Text color={TEXT} bold> LOW</Text> : null}
          {p.reset ? <Text color={MUTED}> · {p.reset}</Text> : null}
        </Box>
      )
    }

    const stacked = (w: Window, i: number) => {
      const p = parts(w)
      return (
        <Box key={`w-${i}`} flexDirection="column" flexShrink={0} marginRight={3}>
          <Box flexDirection="row">
            <Text color={MUTED} bold>{p.name} </Text>
            <Text color={p.col}>{p.d.on}</Text>
            <Text color={EMPTY}>{p.d.off}</Text>
          </Box>
          <Box flexDirection="row">
            <Text color={p.col} bold>{p.left}% left</Text>
            {p.left < LOW_AT ? <Text color={TEXT} bold> LOW</Text> : null}
          </Box>
          {p.reset ? <Text color={MUTED}>resets {p.reset}</Text> : null}
        </Box>
      )
    }

    const label = (
      <Box key="label" flexShrink={0} marginRight={isWide ? 2 : 3}>
        <Text color={TEXT} bold>USAGE</Text>
      </Box>
    )
    const usage = list.length > 0
      ? list.map(isWide ? wide : stacked)
      : [<Box key="wait" flexShrink={0} marginRight={3}><Text color={MUTED}>waiting for the first reply</Text></Box>]

    if (!view) {
      return (
        <Box flexDirection="row" backgroundColor={BG} paddingX={1}>
          {label}
          {usage}
        </Box>
      )
    }

    const hue = HUE[view.mode]
    const word = view.mode.toUpperCase()
    // Robo leads the cache in place of a label: two cells wide instead of six, so the row fits.
    const icon = Svg ? (
      <Box key="robo" flexShrink={0} marginRight={1}>
        <Svg
          source={roboSvg(view.mode)}
          alt={view.mode === 'cold' ? 'Robo, frozen' : 'Robo, bobbing'}
          width={ROBO_SIZE}
          height={ROBO_SIZE}
          isInteractive
        />
      </Box>
    ) : null
    const chip = <Text key="chip" backgroundColor={hue} color={INK} bold>{` ${word} `}</Text>
    const detail = [
      <Text key="state" color={hue} bold>{` ${view.label}`}</Text>,
      view.tokens > 0 ? <Text key="tok" color={MUTED}> · {fmtTokens(view.tokens)} tokens</Text> : null,
    ]

    if (kind === 'wide') {
      return (
        <Box flexDirection="row" backgroundColor={BG} paddingX={1} alignItems="center">
          {label}
          {usage}
          <Box key="cache" flexDirection="row" flexShrink={0} alignItems="center">
            {icon}
            {chip}
            {detail}
          </Box>
        </Box>
      )
    }

    if (kind === 'stacked') {
      return (
        <Box flexDirection="row" backgroundColor={BG} paddingX={1}>
          {label}
          {usage}
          <Box key="cache" flexDirection="column" flexShrink={0}>
            <Box flexDirection="row" alignItems="center">{icon}{chip}</Box>
            <Text color={hue} bold>{view.label}</Text>
            {view.tokens > 0 ? <Text color={MUTED}>{fmtTokens(view.tokens)} tokens</Text> : null}
          </Box>
        </Box>
      )
    }

    // Tight: the cache takes its own row under the usage blocks.
    return (
      <Box flexDirection="column" backgroundColor={BG}>
        <Box flexDirection="row" paddingX={1}>
          {label}
          {usage}
        </Box>
        <Box key="cache" flexDirection="row" paddingX={1} alignItems="center">
          {icon}
          {chip}
          {detail}
        </Box>
      </Box>
    )
  })
}
