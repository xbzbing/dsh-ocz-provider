/**
 * Per-step retry-delay ladder — the exact waits the free lane takes between
 * host retries (README troubleshooting table).
 *
 * Why a ladder module instead of the retry policy: dsh-llm-retry only accepts
 * `{ initialDelayMs, maxDelayMs, jitterRatio }` and computes
 * `min(initial * 2^n, max) * (1 ± jitter)` itself (dsh-llm-retry lib/index.js
 * `localDelay`) — a non-exponential schedule cannot be expressed there. The
 * host DOES honour a provider-supplied wait verbatim: `failure.providerRetryAfterMs`
 * on the finish failure (LlmFailure; an explicitly allowed key in session
 * persistence's `llmFailureValue` and in `normalizeLlmFailure`) replaces the
 * exponential delay whenever it is ≤ policy.maxDelayMs (dsh-llm-retry
 * `recover()`). So zen-adapter tags every retryable failure with the next rung
 * of this ladder and the host waits exactly that.
 *
 * Counting: a host retry re-enters the adapter with the SAME step request
 * (identical messages + model), so the ladder position is keyed by a digest of
 * that request — the mirror of the host's own projection, which resets on
 * `step/start`. A slot idle for longer than STALE_RETRY_GAP_MS restarts at the
 * first rung (a later conversation opening with identical messages, a chain
 * that was interrupted), and the map is LRU-capped so a long-lived host
 * process cannot grow it without bound. A miscount is self-limiting: the wait
 * is still a rung of the ladder, never unbounded, and the host's own
 * maxRetries still ends the chain.
 *
 * INVARIANT (pinned by test/retry-delay.test.ts): every rung must stay
 * ≤ FREE_LANE_RETRY_POLICY.maxDelayMs. The host does NOT clamp a larger
 * providerRetryAfterMs — in normal mode it reads it as "give up now" and
 * surfaces the error WITHOUT retrying — so one over-long rung would silently
 * turn the whole budget into zero retries.
 */

import { createHash } from 'node:crypto'

/**
 * The schedule: retries 1-6 wait 5/8/10/15/20/30s; retries 7-10 stay on the
 * last rung (30s — the documented ceiling). Cumulative worst case per step:
 * 5+8+10+15+20+30+30+30+30+30 = 208s of silent waiting before the error
 * surfaces.
 */
export const RETRY_DELAY_LADDER_MS: readonly number[] = Object.freeze([
  5_000,
  8_000,
  10_000,
  15_000,
  20_000,
  30_000,
])

/** A slot untouched for this long restarts the ladder. Comfortably above the
 *  worst within-chain gap (a rung wait ≤30s plus a hanging attempt), small
 *  enough that an unrelated later request with an identical digest begins at
 *  the first rung. */
export const STALE_RETRY_GAP_MS = 10 * 60_000

/** LRU cap: distinct step digests tracked at once (oldest evicted). */
export const MAX_RETRY_KEYS = 64

interface RetrySlot {
  count: number
  at: number
}

const slots = new Map<string, RetrySlot>()

/**
 * The identity of one host-retried step: the model plus a digest of the exact
 * messages. Retries of the same step re-send byte-identical input; the next
 * step (more history) digests differently and starts a fresh ladder.
 */
export function retryDelayKey(model: string, messages: unknown): string {
  let encoded: string
  try {
    encoded = JSON.stringify(messages ?? null) ?? 'null'
  } catch {
    encoded = 'unhashable'
  }
  const digest = createHash('sha256').update(encoded).digest('hex').slice(0, 24)
  return `${model}|${digest}`
}

/**
 * The wait this surfaced failure asks the host for: one rung further along the
 * key's ladder. Called exactly once per failure that reaches the host, i.e.
 * once per scheduled host retry.
 */
export function nextRetryDelayMs(key: string, now: number = Date.now()): number {
  const existing = slots.get(key)
  if (existing === undefined || now - existing.at > STALE_RETRY_GAP_MS) {
    slots.delete(key)
    slots.set(key, { count: 1, at: now })
  } else {
    existing.count += 1
    existing.at = now
    // touch for LRU: re-insert so eviction reads least-recently-used first
    slots.delete(key)
    slots.set(key, existing)
  }
  while (slots.size > MAX_RETRY_KEYS) {
    const oldest = slots.keys().next().value as string | undefined
    if (oldest === undefined) break
    slots.delete(oldest)
  }
  const slot = slots.get(key)
  const index = Math.min((slot?.count ?? 1) - 1, RETRY_DELAY_LADDER_MS.length - 1)
  return RETRY_DELAY_LADDER_MS[index] ?? RETRY_DELAY_LADDER_MS[0]!
}

/** Test hook: drop all ladder positions (fresh process state). */
export function resetRetryDelays(): void {
  slots.clear()
}
