import type { CacheSnap, UsageSnap, Warmth } from '../types'
import { formatTokens } from './format'
import { mix } from './light'
import type { Palette } from './skin'
import { escape, FONT, measure } from './svg-kit'

// The band above the prompt: how full the context window is, how warm the prompt cache
// still is and how much of each plan limit is spent, as rings that fill in when they draw.

const RING_R = 9
const FILL_MS = 900
const ITEM_W = 132
const TEXT_SIZE = 12.5
const MINUTE_MS = 60_000
const CACHE_SHORT_MS = 5 * MINUTE_MS
const CACHE_LONG_MS = 60 * MINUTE_MS
// The share of its life left below which the cache's meter warns that it is cooling.
const COOLING = 20
// The terminal's bar: cells, and the left-eighth blocks that fill one cell part way.
const BAR_CELLS = 8
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
// What a limit says before its time to reset; one not named here shows the time alone.
const RESET_WORDS: Readonly<Record<string, string>> = { Session: 'reset in ' }

// `resets`, where shown, is the time left until the limit resets, as `countdownOf` writes it;
// on the cache's meter, the time left until it goes cold. `tokens`, on the context's, the
// tokens behind its percent. `warm` marks the cache's meter, words alone with no ring or bar,
// which read warm or cold where the others read a percent; its percent is how much of the
// cache's life is left.
export type Meter = { label: string; percent: number; resets?: string; tokens?: string; warm?: boolean }

// The time left until a reset, to the minute: `3d04h12m`, `1h05m`, `12m`, and `now` once it is due.
export function countdownOf(ms: number): string {
  const minutes = Math.ceil(ms / MINUTE_MS)

  if (minutes <= 0) {
    return 'now'
  }

  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = String(minutes % 60).padStart(2, '0')

  if (days > 0) {
    return `${days}d${String(hours).padStart(2, '0')}h${rest}m`
  }

  return hours > 0 ? `${hours}h${rest}m` : `${minutes}m`
}

// Each limit's countdown by its label, for the limits that say when they reset.
export const countdownsOf = (usage: UsageSnap, now: number): Record<string, string> =>
  Object.fromEntries(usage.limits.flatMap(limit => (limit.resetsAt === undefined ? [] : [[limit.label, countdownOf(limit.resetsAt - now)]])))

// What the band's entrance is keyed by: the numbers, not the countdowns, so a countdown
// ticking down redraws the rings settled instead of filling them again.
// The cache's ring empties as it cools, so it is keyed by warm or cold alone.
export const metersKey = (meters: readonly Meter[]): string =>
  meters.map(meter => (meter.warm === undefined ? `${meter.label} ${meter.percent}%` : `${meter.label} ${meter.warm ? 'warm' : 'cold'}`)).join(', ')

// What leads a meter's words, `42%` or the cache's `warm`, and what follows its label: the
// context's tokens, the cache's time left, a limit's time to reset in brackets.
const headOf = (meter: Meter): string => (meter.warm === undefined ? `${meter.percent}%` : meter.warm ? 'warm' : 'cold')

function tailOf(meter: Meter): string {
  const tokens = meter.tokens === undefined ? '' : ` · ${meter.tokens}`

  if (meter.resets === undefined) {
    return tokens
  }

  return `${tokens}${meter.warm === undefined ? ` (${RESET_WORDS[meter.label] ?? ''}${meter.resets})` : ` · ${meter.resets}`}`
}

const meterText = (meter: Meter): string => `${headOf(meter)} ${meter.label}${tailOf(meter)}`

function altOf(meter: Meter): string {
  if (meter.warm !== undefined) {
    return meter.warm ? `cache warm${meter.resets === undefined ? '' : `, cold in ${meter.resets}`}` : 'cache cold'
  }

  return `${meter.label} ${meter.percent}%${meter.tokens === undefined ? '' : `, ${meter.tokens} tokens`}${meter.resets === undefined ? '' : `, resets in ${meter.resets}`}`
}

// When a transcript's main loop last asked the model, and for how long that request marked the
// cache: its last main-thread `api-request` line, which names the cache's `ttl`, or where the
// transcript has none (an older Claude Code's), its last assistant message's time alone.
export function lastRequestIn(transcript: string): { sentAt: number; ttlMs?: number } | undefined {
  const lines = transcript.split('\n')
  let answered: number | undefined

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? ''

    if (!line.includes('"api-request"') && !(answered === undefined && line.includes('"assistant"'))) {
      continue
    }

    let row: { type?: unknown; timestamp?: unknown; querySource?: unknown; isSidechain?: unknown; cacheControl?: unknown }

    try {
      row = JSON.parse(line) as typeof row
    } catch {
      continue
    }

    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN

    if (Number.isNaN(at)) {
      continue
    }

    if (row.type === 'api-request' && (row.querySource === undefined || String(row.querySource).startsWith('repl_main_thread'))) {
      const marks = Array.isArray(row.cacheControl) ? (row.cacheControl as { value?: { ttl?: unknown } }[]) : []

      return { sentAt: at, ...(marks.length === 0 ? {} : { ttlMs: marks.some(mark => mark.value?.ttl === '1h') ? CACHE_LONG_MS : CACHE_SHORT_MS }) }
    }

    if (row.type === 'assistant' && row.isSidechain !== true && answered === undefined) {
      answered = at
    }
  }

  return answered === undefined ? undefined : { sentAt: answered }
}

// How long the prompt cache holds the main loop's conversation after a request: an hour on a
// plan, five minutes on an API key or once a plan limit is spent and requests run on as
// overage. A request after more than five minutes away settles it: still read from the
// cache, the hour; not, five minutes. Otherwise the last request's holds.
export function cacheTtlOf(before: CacheSnap | null, sentAt: number, hasRead: boolean, limits: readonly { percent: number }[]): number {
  const away = before === null ? 0 : sentAt - before.sentAt

  if (away > CACHE_SHORT_MS && away <= CACHE_LONG_MS) {
    return hasRead ? CACHE_LONG_MS : CACHE_SHORT_MS
  }

  if (limits.some(limit => limit.percent >= 100)) {
    return CACHE_SHORT_MS
  }

  return before?.ttlMs ?? (limits.length > 0 ? CACHE_LONG_MS : CACHE_SHORT_MS)
}

// The cache's meter at `now`, to the minute, so it reads the same between ticks.
export function warmthOf(cache: CacheSnap | null, now: number): Warmth | null {
  if (cache === null) {
    return null
  }

  const left = cache.sentAt + cache.ttlMs - now

  if (left <= 0) {
    return { percent: 0 }
  }

  return { percent: Math.min(100, Math.round((100 * Math.ceil(left / MINUTE_MS) * MINUTE_MS) / cache.ttlMs)), left: countdownOf(left) }
}

// `five_hour` reads as `Session`, `seven_day` as `Week`; any other kind as its own name.
export function limitLabel(kind: string): string {
  const name = kind.toLowerCase()

  if (name.includes('five') || name.includes('5h') || name.includes('5_h')) {
    return 'Session'
  }

  if (name.includes('seven') || name.includes('7d') || name.includes('week')) {
    return 'Week'
  }

  return name.replace(/_/g, ' ')
}

// `countdowns`, by limit label, puts each limit's time to reset beside its meter; `warmth`
// puts the cache's meter first, ahead of the context's.
export function metersOf(usage: UsageSnap, countdowns: Record<string, string> = {}, warmth: Warmth | null = null): Meter[] {
  const tokens = usage.tokens === undefined ? {} : { tokens: `${formatTokens(usage.tokens.used)}/${formatTokens(usage.tokens.window)}` }

  return [
    ...(warmth === null ? [] : [{ label: 'cache', percent: warmth.percent, warm: warmth.left !== undefined, ...(warmth.left === undefined ? {} : { resets: warmth.left }) }]),
    ...(usage.context === null ? [] : [{ label: 'context', percent: usage.context, ...tokens }]),
    ...usage.limits.map(limit => {
      const resets = countdowns[limit.label]

      return { label: limit.label, percent: limit.percent, ...(resets === undefined ? {} : { resets }) }
    }),
  ].map(meter => ({ ...meter, percent: Math.max(0, Math.min(100, Math.round(meter.percent))) }))
}

// Accent while there is room; the warning colour from 80 %, the error colour from 95 %.
export const meterColor = (percent: number, palette: Palette): string =>
  percent >= 95 ? palette.err : percent >= 80 ? palette.warn : palette.user

// The cache's meter turns the other way: accent while warm, the warning colour in the last
// fifth of its life, muted once cold.
export const colorOf = (meter: Meter, palette: Palette): string =>
  meter.warm === undefined ? meterColor(meter.percent, palette) : !meter.warm ? palette.muted : meter.percent <= COOLING ? palette.warn : palette.user

// The track a terminal bar's empty part is drawn on: the skin's band colour, lifted toward
// its muted text so the bar's whole length shows on any background.
export const trackColor = (palette: Palette): string => mix(palette.surface, palette.muted, 0.3)

// `tight` sizes each meter to its ring and words, with no fixed slot, so a row can spread them evenly.
// The cache's meter is its words alone, coloured as its ring would be.
export function usageSvg(meters: readonly Meter[], palette: Palette, tight = false): { source: string; width: number; height: number; alt: string; entranceMs: number } {
  // A meter with a countdown is wider than the rest; each starts where the one before ended.
  const ring = (meter: Meter) => (meter.warm === undefined ? RING_R * 2 + 12 : 4)
  const content = (meter: Meter) => ring(meter) + measure(meterText(meter), false, TEXT_SIZE)
  const widths = meters.map(meter => (tight ? Math.ceil(content(meter) + 6) : Math.max(ITEM_W, Math.ceil(content(meter) + 20))))
  const starts = widths.map((_, i) => widths.slice(0, i).reduce((sum, w) => sum + w, 0))
  const width = widths.reduce((sum, w) => sum + w, 0)
  const height = 30
  const circumference = 2 * Math.PI * RING_R

  const items = meters
    .map((meter, i) => {
      const x = (starts[i] ?? 0) + RING_R + 4
      const filled = (circumference * meter.percent) / 100
      const color = colorOf(meter, palette)
      const words = (at: number, head: string) =>
        `<text x="${at}" y="19.5" font-size="${TEXT_SIZE}"><tspan style="fill:${head};font-weight:600">${headOf(meter)}</tspan><tspan style="fill:${palette.muted}"> ${escape(meter.label)}${escape(tailOf(meter))}</tspan></text>`

      if (meter.warm !== undefined) {
        return words((starts[i] ?? 0) + 4, color)
      }

      return [
        `<circle cx="${x}" cy="15" r="${RING_R}" fill="none" stroke="${palette.muted}" stroke-opacity=".25" stroke-width="3"/>`,
        `<circle class="fill" cx="${x}" cy="15" r="${RING_R}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${filled} ${circumference}" transform="rotate(-90 ${x} 15)" style="--len:${filled}"/>`,
        words(x + RING_R + 8, palette.fg),
      ].join('')
    })
    .join('')

  const style = [
    `text{font-family:${FONT}}`,
    `.fill{animation:fill ${FILL_MS}ms cubic-bezier(.2,.8,.2,1)}`,
    '@keyframes fill{from{stroke-dasharray:0 100}}',
    '@media (prefers-reduced-motion:reduce){.fill{animation:none}}',
  ].join('')

  return {
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${style}</style>${items}</svg>`,
    width,
    height,
    alt: meters.map(altOf).join(', '),
    entranceMs: FILL_MS,
  }
}

// The terminal's version: one line of bar meters, `text` what follows each bar. A bar fills
// in eighths of a cell, so it runs smooth, and pads with blanks, which the row draws on a
// track. The bars keep the accent. The cache's meter has no bar (`bar` is empty): its words
// take its colour, so a cooling or cold cache shows.
export function usageLine(meters: readonly Meter[], palette: Palette): { label: string; bar: string; color: string; percent: number; text: string }[] {
  return meters.map(meter => {
    const eighths = Math.round((meter.percent / 100) * BAR_CELLS * 8)
    const filled = '█'.repeat(Math.floor(eighths / 8)) + (EIGHTHS[eighths % 8] ?? '')
    const bar = meter.warm === undefined ? filled.padEnd(BAR_CELLS, ' ') : ''

    return { label: meter.label, bar, color: meter.warm === undefined ? palette.user : colorOf(meter, palette), percent: meter.percent, text: meterText(meter) }
  })
}
