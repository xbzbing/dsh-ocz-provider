/**
 * Adapter-layer rotate-retry delegate (docs/ip-pool.md §3.4/§8.1).
 *
 * The dispatcher layer only MARKS a degraded exit; the host's own retry loop
 * then re-enters the adapter, which re-picks through the pool — correct, but
 * every attempt burns one of the host's retries on the same visible
 * error string ("Connection error." streaks in the user's chat). This module
 * lets the ADAPTER itself retry inside one user-visible request: when a
 * stream fails before any content landed, the adapter asks this delegate
 * whether the failure is exit-shaped (transport / 429 / 401/403) and the pool
 * has another candidate — then transparently restarts the pi-ai stream, which
 * re-picks a fresh exit through the same ALS context.
 *
 * The delegate is set by the runtime assembly (ip-pool.ts) and cleared on
 * dispose, so a disabled pool keeps the adapter's behavior unchanged.
 */

import type { ExitPool } from './pool.ts'

export type RotateFailure = 'transport' | 'limited' | 'refused'

export interface RotateDelegate {
  /**
   * Record the failure against the failed exit (passive-signal parity) and
   * decide whether another rotate attempt is worth it.
   * @param failure - what the stream died of (before any content landed).
   * @param model - the in-flight model (ban-level bookkeeping).
   * @param session - the sticky-session key (broken on rotate).
   * @param attempt - 1-based rotate attempt about to run.
   * @param deterministic - the failure is a property of the exit (upstream
   *        RegionError body); the sticky exit's (exit, model) pairing is
   *        banned at once instead of waiting for a second sample.
   * @param abusive - the refusal names THIS EXIT'S IP as abusive (OpenCode's
   *        network-reputation answer, isIpReputationRefusal); the exit is
   *        benched for hours rather than rotated onto again in a moment.
   * @param failedExit - the exit that carried the failed attempt. Passed
   *        explicitly because the relay settle and the dispatcher have already
   *        broken the session binding by the time the adapter asks.
   * @returns true to re-pick and restart the stream; false to surface the error.
   */
  decide(failure: RotateFailure, model: string, session: string, attempt: number, deterministic?: boolean, abusive?: boolean, failedExit?: string | null): boolean
}

let delegate: RotateDelegate | null = null

/** Install the runtime's rotate delegate (startIpPool). */
export function setRotateDelegate(next: RotateDelegate | null): void {
  delegate = next
}

/** True when a runtime delegate is installed (adapter fast-path). */
export function hasRotateDelegate(): boolean {
  return delegate !== null
}

/** Ask the installed delegate; false when no pool is running. */
export function shouldRotate(failure: RotateFailure, model: string, session: string, attempt: number, deterministic = false, abusive = false, failedExit: string | null = null): boolean {
  return delegate?.decide(failure, model, session, attempt, deterministic, abusive, failedExit) ?? false
}

/**
 * True when the refusal blames the exit's ADDRESS rather than the request:
 * OpenCode's network-reputation answer —
 * "OpenCode's free models aren't available from your current network because
 * we've detected abusive traffic from this IP address. … If you're on a VPN or
 * proxy, turn it off and try again". Distinct from the other 403 the lane
 * sends ("…can only be used from within OpenCode"), which is about the request
 * shape and is identical from every address: this one is a property of the
 * exit and outlives any rotation, so the pool benches the exit instead of
 * treating it like a moment-to-moment refusal (docs/ip-pool.md §3.2).
 */
export function isIpReputationRefusal(errorMessage: string): boolean {
  return /abusive traffic|this ip address/i.test(errorMessage)
}

/** Map a pi-ai error message to the failure taxonomy (adapter-side parse). */
export function classifyStreamFailure(errorMessage: string): RotateFailure | null {
  const text = errorMessage.toLowerCase()
  if (/\b429\b|rate.?limit|freeusagelimit/.test(text)) return 'limited'
  if (/\b(?:401|403)\b/.test(text)) return 'refused'
  // pi-ai's truncation sentinel — same predicate the host uses for its own
  // providers (dsh-llm-pi-ai classifyPiAiError, lib/index.js:1456) and the same
  // one adapter/events.ts classifyError now applies. Exit-shaped like any
  // reset, so a truncation that lands BEFORE content rotates to a fresh exit
  // instead of burning a host retry on the exit that just cut it.
  if (/stream ended (?:before|without)\b/.test(text)) return 'transport'
  // The same cut under spellings a `\bsocket\b` test misses (opencode2dsh #105):
  // "WebSocket" has no inner word boundary, and undici's own cuts arrive as
  // "other side closed" (SocketError, client-h1.js/client-h2.js — the
  // realistic failure through the exit pool) or "http2 request did not get
  // a response". Same taxonomy the adapter applies (events.ts classifyError).
  if (/\bwebsocket\b|other side closed|http2 request did not get a response/.test(text)) return 'transport'
  if (/\b(?:network|connection|socket|fetch|terminated|premature close)\b|\beconn[a-z]+\b|timeout|timed out/.test(text)) return 'transport'
  // 5xx joins the rotate set: through a proxy a 500 is as often the
  // proxy mangling the tunnel as the upstream itself — one exit change
  // before taking the error at face value (bounded by maxRotateAttempts).
  if (/\b5\d\d\b|internal server error|server error/.test(text)) return 'transport'
  return null
}

/** True when the error body names a deterministic region block (Zen's
 *  RegionError): the exit's IP cannot serve this model — ban the pairing on
 *  sight instead of collecting two samples (docs 4.2). */
export function isRegionBlocked(errorMessage: string): boolean {
  return /regionerror|not available in your country/i.test(errorMessage)
}

/**
 * Build the runtime delegate over the live pool (ip-pool.ts assembly).
 * Passive bookkeeping mirrors the dispatcher observer: the stream that died
 * before content already recorded its verdict through the routing layer when
 * it could see it — the sentinel covers the mute-connection case — so this
 * delegate applies the body-only verdicts (abusive, RegionError), owns the
 * rotation bound (`ipPool.maxRotateAttempts`), and checks whether a usable
 * exit remains.
 */
export function createRotateDelegate(pool: ExitPool, options: { maxAttempts?: number } = {}): RotateDelegate {
  const maxAttempts = options.maxAttempts ?? 3
  return {
    decide(failure, model, session, attempt, deterministic = false, abusive = false, exitId = null) {
      // The binding is usually gone already (settle reroutes on any bad
      // verdict), so the caller's exit id is the authority.
      const failedExit = exitId ?? pool.exitOfSession(session)
      // IP-reputation refusal: the address is the problem, not the model and
      // not the moment. Bench the exit for the long window so neither pick()
      // nor a pin can walk back onto it; the note rides the status card.
      if (abusive && failedExit !== null) pool.markAbusive(failedExit)
      // Deterministic refusal (RegionError): ban the sticky exit's pairing
      // immediately — the dispatcher layer recorded the refusal but cannot
      // see the body; the adapter's classify knows it on sight (docs 4.2).
      if (deterministic && failedExit !== null) {
        pool.markModelBanned(failedExit, model)
      }
      if (attempt > maxAttempts) return false
      // Anything usable for this model left? (pick filters cooldowns, bans,
      // dead.) Nothing usable -> let the error surface honestly.
      const usable = pool.list().some((entry) => pool.isUsable(entry.id, model))
      if (!usable) return false
      // Break the sticky binding so the restarted stream picks a different
      // exit instead of landing on the one that just failed.
      pool.rerouteSession(session)
      return true
    },
  }
}
