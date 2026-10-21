const DAY_MS = 24 * 60 * 60 * 1000

// A one-time ask for a GitHub star, after a few days of use, so it lands on someone who
// kept the skin rather than someone still trying it out.
const STAR_AFTER_MS = 3 * DAY_MS

export const STAR_NOTICE = 'Enjoying skins? A ★ on GitHub helps others find it: https://github.com/hellosverre/claude-skins'

export type Star = { since: number; asked: boolean }

// What to store and whether to ask now. Undefined `save` means the stored record stands.
export function starStep(raw: unknown, now: number): { save?: Star; ask: boolean } {
  const record = typeof raw === 'object' && raw !== null ? (raw as Partial<Star>) : {}

  if (record.asked === true) {
    return { ask: false }
  }

  if (typeof record.since !== 'number') {
    return { save: { since: now, asked: false }, ask: false }
  }

  return now - record.since >= STAR_AFTER_MS ? { save: { since: record.since, asked: true }, ask: true } : { ask: false }
}
