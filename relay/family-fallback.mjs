/**
 * 本机出口协议族 的 429 兜底: which family a direct request should dial next.
 *
 * `prefer6` already falls back to IPv4 when an IPv6 CONNECT fails, but the free
 * lane's refusal is an HTTP 429 over a healthy socket, so the connect-level
 * fallback never fires and one family being out of quota silently takes the
 * whole lane down (the polarity of that refusal has flipped more than once —
 * docs/ip-pool.md §3.7). The relay therefore retries ONE direct attempt on the
 * other family when the first one answers a quota refusal, and remembers that
 * answer for a while so the next request starts on the family that worked.
 *
 * Plain data + pure functions, time injected: the relay wires it and
 * test/family-fallback.test.ts pins it.
 *
 * @typedef {'4' | '6' | 'prefer6'} DirectFamily
 */

/**
 * How long a quota refusal keeps steering new requests to the other family.
 * Short on purpose: the lane's own `retry-after` points at the next 00:00Z
 * (12 h away on a late-evening request), so honouring it would pin the fallback
 * for the rest of the day — half an hour is long enough to stop paying a wasted
 * 429 on every request and short enough to notice a recovered family.
 */
export const FAMILY_REFUSAL_TTL_MS = 30 * 60_000

/**
 * The family a directive dials first: `prefer6` tries AAAA, the others pin.
 *
 * @param {DirectFamily} family
 * @returns {'4' | '6'}
 */
function primaryOf(family) {
  return family === '4' ? '4' : '6'
}

/**
 * The family to try when `family` answered a quota refusal, or null when no
 * direct family was requested (nothing to swap).
 *
 * @param {DirectFamily | undefined} family
 * @returns {DirectFamily | null}
 */
export function alternateFamily(family) {
  if (family === undefined) return null
  return primaryOf(family) === '6' ? '4' : '6'
}

/**
 * What to actually dial for a requested family, given refusals seen recently.
 * `prefer6` still prefers IPv6 — but not when IPv6 is the family that is out of
 * quota, which is the whole point of the memo.
 *
 * @param {DirectFamily} family
 * @param {Map<'4' | '6', number>} refusals refused-until timestamps, ms
 * @param {number} now
 * @returns {DirectFamily}
 */
export function familyFor(family, refusals, now) {
  const primary = primaryOf(family)
  const until = refusals.get(primary) ?? 0
  if (until <= now) return family
  return primary === '6' ? '4' : '6'
}

/**
 * Record that `family` answered a quota refusal, until `ttlMs` from `now`.
 *
 * @param {Map<'4' | '6', number>} refusals
 * @param {DirectFamily} family
 * @param {number} now
 * @param {number} [ttlMs]
 */
export function noteFamilyRefusal(refusals, family, now, ttlMs = FAMILY_REFUSAL_TTL_MS) {
  refusals.set(primaryOf(family), now + ttlMs)
}

/**
 * Drop entries that have expired, so the map cannot outlive its facts.
 *
 * @param {Map<'4' | '6', number>} refusals
 * @param {number} now
 */
export function pruneRefusals(refusals, now) {
  for (const [family, until] of refusals) {
    if (until <= now) refusals.delete(family)
  }
}
