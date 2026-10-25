/**
 * The probe's user turn: a small pool of one-liners, default `hello`.
 *
 * The smoke is a 1-token chat request that proves the anonymous lane answers
 * through a candidate exit (docs/ip-pool.md §4.5 step 4). Its user turn is
 * decoration — the gate is the request SHAPE (streaming + the free-lane tools)
 * — so a pool of one-liners keeps the probe traffic from looking like one fixed
 * synthetic pattern while every other property of the probe stays identical.
 * One exit draws one entry per pass, so the variation is across exits.
 *
 * The default lives HERE rather than in the settings schema: the settings layer
 * resolves it for the UI (`resolveProbeContents`) and the admission path keeps
 * its own fallback for direct callers, so one constant has to be the truth for
 * both. (Same split as `DEFAULT_PROBE_MODEL` ↔ `deps.smokeModel`.)
 */
export const DEFAULT_SMOKE_CONTENT = 'hello'

/** Trim, drop empties and dedupe a configured pool (order preserved). */
export function normalizeSmokeContents(contents: readonly string[] | undefined): string[] {
  const pool: string[] = []
  for (const entry of contents ?? []) {
    const value = typeof entry === 'string' ? entry.trim() : ''
    if (value !== '' && !pool.includes(value)) pool.push(value)
  }
  return pool
}

/**
 * One EXIT PROBE's user turn: a random entry of the configured pool, or the
 * default when nothing is configured. The draw belongs to the exit, not to the
 * request (docs/ip-pool.md §4.2): callers that probe one exit across
 * several models draw ONCE and reuse it for the whole pass (admission's
 * `smokeContent`). `random` is a seam (tests, and any future deterministic
 * caller); the index is clamped, so a seam returning 1 — or a negative, or
 * NaN — can never read outside the pool.
 */
export function pickSmokeContent(contents: readonly string[] | undefined, random: () => number = Math.random): string {
  const pool = normalizeSmokeContents(contents)
  if (pool.length === 0) return DEFAULT_SMOKE_CONTENT
  const raw = random()
  const index = Number.isFinite(raw) ? Math.min(pool.length - 1, Math.max(0, Math.floor(raw * pool.length))) : 0
  return pool[index]!
}
