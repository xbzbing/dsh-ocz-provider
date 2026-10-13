/**
 * Per-exit usage attribution (exit-stats surface, 2026-10-13).
 *
 * The routing dispatcher already knows WHICH exit carried each request — it
 * stamps the exit id into the adapter's ALS routing context at pick() — and
 * the adapter is the layer that reads the response's `usage` (plaintext, far
 * above the TLS the tunnel carries). This module joins the two: a
 * process-lifetime tracker keyed by exit id, written by the adapter and read
 * by the status bridge. Deliberately in-memory only — restart resets it
 * (agreed scope: no persistence).
 *
 * Requests that matched a pool host but fell back to a direct connection
 * (empty pool, missing agent) attribute to {@link DIRECT_EXIT_ID} so the
 * modal can show "直连兜底" honestly instead of dropping those tokens.
 * Requests to hosts outside the pool attribute to {@link LOCAL_EXIT_ID}:
 * that is the 本机 side of the ledger, and it is the number that exposes a
 * routing layer that should be steering traffic but is not. Requests that
 * never entered the dispatcher (pool off entirely) have no exit stamp and
 * are still not counted — the same boundary the passive health counters
 * already respect.
 */
import type { HarnessChunk } from '../adapter/events.ts'

/** Pseudo exit id for pool-host traffic that fell back to a direct connection. */
export const DIRECT_EXIT_ID = 'direct'

/**
 * Pseudo exit id for traffic this process sent out from the local machine
 * instead of through a pool exit (hosts outside the pool, or every request
 * while routing is off). Separate from {@link DIRECT_EXIT_ID}, which is the
 * narrower diagnostic "should have used the pool but could not" bucket; the
 * status bridge merges both into the modal's 本机 row.
 */
export const LOCAL_EXIT_ID = 'local'

/** The `usage` shape one recorded response contributes. */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Accumulated counters for one exit (or the direct bucket). */
export interface TokenTotals {
  /** Recorded usage events (≈ completed responses attributed here). */
  requests: number
  inputTokens: number
  outputTokens: number
  /** Cache buckets are a breakdown of input, not extra tokens on top. */
  cacheReadTokens: number
  cacheWriteTokens: number
  /** input + output; cache reads/writes are reported separately. */
  totalTokens: number
}

function zeroTotals(): TokenTotals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
}

/** A fresh all-zero bucket (bridge stubs for a disabled pool). */
export const emptyTotals = zeroTotals

/** Mutable accumulator map keyed by exit id. One instance per process. */
export class UsageTracker {
  #byExit = new Map<string, TokenTotals>()
  /** Last record time per bucket (epoch ms) — the modal's 最后使用 column. */
  #lastAt = new Map<string, number>()

  /** Attribute one response's usage to one exit id. */
  record(exitId: string, usage: TokenUsage): void {
    const bucket = this.#byExit.get(exitId) ?? zeroTotals()
    const input = usage.inputTokens ?? 0
    const output = usage.outputTokens ?? 0
    bucket.requests += 1
    bucket.inputTokens += input
    bucket.outputTokens += output
    bucket.cacheReadTokens += usage.cacheReadTokens ?? 0
    bucket.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    bucket.totalTokens += input + output
    this.#byExit.set(exitId, bucket)
    this.#lastAt.set(exitId, Date.now())
  }

  /** A copy of one bucket (zeros when nothing was recorded). */
  totals(exitId: string): TokenTotals {
    return { ...(this.#byExit.get(exitId) ?? zeroTotals()) }
  }

  /** Epoch ms of the last recorded response for one bucket (0 = never). */
  lastUsedAt(exitId: string): number {
    return this.#lastAt.get(exitId) ?? 0
  }

  /** Every exit id with recorded usage (diagnostics). */
  exits(): string[] {
    return [...this.#byExit.keys()]
  }

  /** Test seam / future reset action. */
  reset(): void {
    this.#byExit.clear()
    this.#lastAt.clear()
  }
}

/** The process-lifetime tracker: adapter writes, status bridge reads. */
export const usageTracker = new UsageTracker()

/**
 * Pass a chunk stream through, recording every `usage` chunk against the
 * routing context's exit stamp. Placed around the adapter's per-attempt
 * output so each attempt's tokens land on the exit that actually carried
 * that attempt (a rotate restart therefore splits correctly across exits).
 *
 * A context with no stamp means nothing routed this request through a pool
 * exit — the pool is off, the host is outside the proxy set, or routing was
 * never installed. That is exactly the 本机 ledger, so the usage lands in
 * {@link LOCAL_EXIT_ID} rather than being dropped: the modal can then show
 * that model traffic is leaving from this machine even while the pool looks
 * healthy (the failure mode this bucket was added for, live 2026-10-13).
 */
export async function* attributeUsage(
  store: { exitId?: string },
  source: AsyncGenerator<HarnessChunk>,
  tracker: UsageTracker = usageTracker,
): AsyncGenerator<HarnessChunk> {
  for await (const chunk of source) {
    if (chunk.type === 'usage') {
      tracker.record(store.exitId ?? LOCAL_EXIT_ID, chunk.usage)
    }
    yield chunk
  }
}
