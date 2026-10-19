/**
 * The free lane's ORIGINS — one recipe, two doors.
 *
 * OpenCode serves the anonymous free lane from two origins that accept the
 * SAME fingerprint (headers, ids, tools):
 *
 *   https://opencode.ai/inference   the 2.x client's origin, primary
 *   https://opencode.ai/zen         the 1.x console origin, live again
 *
 * Measured 2026-10-19 13:32-13:45 +08:00, single variable per request, the
 * captured adapter bytes replayed: `/zen/v1/chat/completions` answered 200 SSE
 * to the SAME body, headers and UA that `/inference/v1` answered 200 to, with
 * no redirect (`redirect: 'manual'` also 200), on two models (mimo-v2.6-flash-free,
 * big-pickle), and `/zen/v1/models` kept listing all 85 models. That
 * contradicted this repository's 2026-10-14 note that `/zen/v1` refuses every
 * shape — the lane had simply moved back into service, which is why the
 * ladder below exists rather than a hard-coded single base.
 *
 * The ladder is NOT a second recipe: the request bytes never change, only the
 * origin they are sent to, so it cannot trip the gate's generation-coherence
 * check (ids.ts `disguiseHeaders`). A failover costs one round trip and is
 * only spent on an origin-level answer — a gate refusal (401/403) or a 5xx
 * from the edge — never on a 429 (an exit/IP-shaped limit: rotating the exit
 * is the right cure) or on a transport error (egress-shaped).
 *
 * Failover also covers the SENDERS BESIDE THE CHAT: the catalog listing
 * (`/v1/models`) and the pool's admission smoke both speak to the same lane,
 * so they walk the same ladder — an exit that only reaches one of the two
 * origins must not be marked dead by the other (pool/admission.ts).
 */

/** The 2.x client's origin (catalog.ts `ZEN_BASE_URL`), tried first. */
export const ZEN_PRIMARY_BASE_URL = 'https://opencode.ai/inference'
/** The console origin, live again since 2026-10-19; the ladder's second rung. */
export const ZEN_FALLBACK_BASE_URL = 'https://opencode.ai/zen'

/** The known lane origins, primary first — the ladder's default contents. */
export const ZEN_LANE_ORIGINS = [ZEN_PRIMARY_BASE_URL, ZEN_FALLBACK_BASE_URL] as const

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '')
}

/**
 * The ordered origins one lane request walks.
 *
 * `primary` is whatever the caller resolved (the `zenBaseUrl` seam, default
 * `https://opencode.ai/inference`). The fallback rung is added ONLY when the
 * primary is itself a known lane origin: a base a test or an operator points
 * somewhere else must be used alone, or an injected fixture would suddenly
 * reach the live console behind its back. Passing `fallback` explicitly
 * overrides that rule, which is how the tests drive a two-rung ladder without
 * touching the network.
 */
export function laneOrigins(primary: string, fallback?: string): string[] {
  const first = normalizeOrigin(primary)
  if (first === '') return []
  const explicit = fallback === undefined ? undefined : normalizeOrigin(fallback)
  if (explicit !== undefined) {
    return explicit === '' || explicit === first ? [first] : [first, explicit]
  }
  if (!(ZEN_LANE_ORIGINS as readonly string[]).includes(first)) return [first]
  return [first, ...ZEN_LANE_ORIGINS.filter((origin) => origin !== first)]
}

/**
 * True when a failure names the ORIGIN rather than the exit: the gate refusing
 * the request outright (401/403, the `FreeTierError` body), the edge itself
 * failing (5xx), or the door not serving the route at all (404 — upstream
 * measured `/inference` without a models route on 2026-10-14). Any of those
 * means "ask the other door"; a 429, a timeout or a socket error is
 * exit-shaped and stays with the pool's rotation.
 *
 * The patterns mirror pool/rotate.ts `classifyStreamFailure` (`refused` and the
 * 5xx half of `transport`) so the two layers agree on what a refusal is.
 */
export function isOriginFailure(errorMessage: string): boolean {
  const text = errorMessage.toLowerCase()
  // RegionError is exit-shaped (pool/rotate.ts isRegionBlocked): the door is
  // fine, this exit's country is not — rotating the exit is the cure.
  if (/regionerror|not available in your country/.test(text)) return false
  if (/\b(?:401|403|404)\b/.test(text)) return true
  if (/free tiererror|free tier can only be used from within opencode/.test(text)) return true
  return /\b5\d\d\b|internal server error|server error|bad gateway|service unavailable/.test(text)
}
