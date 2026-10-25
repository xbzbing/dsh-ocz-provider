/**
 * Per-exit usage attribution (exit-stats surface).
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
 * never entered the dispatcher (pool off entirely) carry no exit stamp, and
 * {@link attributeUsage} books those to {@link LOCAL_EXIT_ID} as well — the
 * 本机 row counts every request this process sent from this machine.
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

/**
 * Rolling window for the tok/s display (docs/ip-pool.md §5.5): a lifetime
 * weighted mean has too much inertia to answer "how fast is this exit NOW" —
 * one bad day poisons the number forever.
 */
export const RECENT_WINDOW_MS = 180_000

/**
 * Display floor: a window carrying fewer output tokens than this reads 0 and
 * the UI hides the chip. Without it, a window holding one half-second blip
 * shows a confident number made of noise (the free lane's traffic is bursty).
 */
export const RECENT_MIN_TOKENS = 50

/** One timed response inside the recent window. */
interface RecentSample {
  /** Epoch ms the usage chunk landed (window membership key). */
  at: number
  /** Output tokens of that response. */
  tokens: number
  /** That response's own decode window (ms, ≥ 1). */
  ms: number
}

/** The `usage` shape one recorded response contributes. */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /**
   * Decode window in ms (first output delta → usage chunk), measured by
   * attributeUsage. Feeds the recent-window tok/s display (per-response
   * generation speed, excluding queueing before the first token) and the
   * ledger's cumulative outputMs.
   */
  durationMs?: number
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
  /** Cumulative decode window (ms) of the recorded responses. */
  outputMs: number
}

function zeroTotals(): TokenTotals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, outputMs: 0 }
}

/** A fresh all-zero bucket (bridge stubs for a disabled pool). */
export const emptyTotals = zeroTotals

/**
 * Who a response belongs to, for the persistent ledger's per-session view
 * (docs/ip-pool.md §5.6). Optional everywhere: the process-lifetime tracker
 * has no session dimension, and an adapter call that carries no session id
 * simply lands in the per-day/per-exit totals alone.
 */
export interface UsageRecordMeta {
  /** Session the response belongs to (the host's session id when there is one). */
  session?: string
  /** Human label for that session (its first user turn, truncated). */
  label?: string
}

/** The write face {@link attributeUsage} needs (the tracker, or the ledger). */
export interface UsageRecorder {
  record(exitId: string, usage: TokenUsage, meta?: UsageRecordMeta): void
}

/** Mutable accumulator map keyed by exit id. One instance per process. */
export class UsageTracker implements UsageRecorder {
  #byExit = new Map<string, TokenTotals>()
  /** Last record time per bucket (epoch ms) — the modal's 最后使用 column. */
  #lastAt = new Map<string, number>()
  /** Rolling timed samples per bucket — the recent-window tok/s ring. */
  #recent = new Map<string, RecentSample[]>()
  #now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now
  }

  /** Attribute one response's usage to one exit id. */
  record(exitId: string, usage: TokenUsage, _meta?: UsageRecordMeta): void {
    const bucket = this.#byExit.get(exitId) ?? zeroTotals()
    const input = usage.inputTokens ?? 0
    const output = usage.outputTokens ?? 0
    bucket.requests += 1
    bucket.inputTokens += input
    bucket.outputTokens += output
    bucket.cacheReadTokens += usage.cacheReadTokens ?? 0
    bucket.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    bucket.totalTokens += input + output
    bucket.outputMs += usage.durationMs ?? 0
    this.#byExit.set(exitId, bucket)
    const at = this.#now()
    this.#lastAt.set(exitId, at)
    // The recent ring only holds TIMED responses: one with no decode window
    // (aborted before any delta) would add tokens without time and inflate
    // the speed. The lifetime totals above still count it.
    const ms = usage.durationMs ?? 0
    if (ms > 0) {
      const samples = this.#recent.get(exitId) ?? []
      samples.push({ at, tokens: output, ms })
      pruneSamples(samples, at)
      this.#recent.set(exitId, samples)
    }
  }

  /** A copy of one bucket (zeros when nothing was recorded). */
  totals(exitId: string): TokenTotals {
    return { ...(this.#byExit.get(exitId) ?? zeroTotals()) }
  }

  /**
   * Recent output speed (tok/s) over the {@link RECENT_WINDOW_MS} window for
   * one bucket. Weighted mean of the windowed responses (sum tokens / sum
   * decode window); 0 when the window is empty or below
   * {@link RECENT_MIN_TOKENS} — the UI hides the number then.
   */
  speed(exitId: string): number {
    return this.speedFor([exitId])
  }

  /** Recent speed merged over several buckets (the 本机 row's direct+local). */
  speedFor(exitIds: readonly string[], at: number = this.#now()): number {
    let tokens = 0
    let ms = 0
    for (const id of exitIds) {
      const samples = this.#recent.get(id)
      if (samples === undefined) continue
      for (const sample of samples) {
        if (sample.at < at - RECENT_WINDOW_MS) continue
        tokens += sample.tokens
        ms += sample.ms
      }
    }
    if (ms <= 0 || tokens < RECENT_MIN_TOKENS) return 0
    return Math.round((tokens * 1000) / ms)
  }

  /** Pool-wide recent speed: every timed bucket in the window. */
  speedAll(at: number = this.#now()): number {
    return this.speedFor([...this.#recent.keys()], at)
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
    this.#recent.clear()
  }
}

/** Drop samples that fell out of the recent window (oldest first). */
function pruneSamples(samples: RecentSample[], now: number): void {
  const cutoff = now - RECENT_WINDOW_MS
  let firstLive = 0
  while (firstLive < samples.length && samples[firstLive]!.at < cutoff) firstLive += 1
  if (firstLive > 0) samples.splice(0, firstLive)
}

/** The process-lifetime tracker: adapter writes, status bridge reads. */
export const usageTracker = new UsageTracker()

/**
 * Where `attributeUsage` writes by default. The plugin swaps in the persistent
 * ledger at apply() time (usage-store.ts), which keeps the run-scope tracker
 * inside itself — this seam exists so usage.ts never has to import the ledger
 * (the two modules would form an import cycle, and the ledger pulls node:fs in
 * with it). A composition without the swap keeps the plain in-process tracker,
 * which is also what the unit tests exercise.
 */
let activeRecorder: UsageRecorder = usageTracker

/** Install the recorder `attributeUsage` should write to (null restores the tracker). */
export function setUsageRecorder(recorder: UsageRecorder | null): void {
  activeRecorder = recorder ?? usageTracker
}

/**
 * Pass a chunk stream through, recording every `usage` chunk against the
 * routing context's exit stamp. Placed around the adapter's per-attempt
 * output so each attempt's tokens land on the exit that actually carried
 * that attempt (a rotate restart therefore splits correctly across exits).
 *
 * Also measures each response's decode window — the wall time from the FIRST
 * output delta (text/reasoning/tool-call) to the `usage` chunk — and hands
 * it to the tracker as `durationMs`, the per-response window the recent
 * tok/s ring and the ledger's cumulative outputMs both accumulate. Prompt
 * processing and queueing before the first token are excluded on purpose:
 * the number answers "how fast does this exit generate", not "how long did
 * the user wait". Each usage closes the window the preceding deltas opened —
 * a later response in the same stream starts a fresh one, so multi-response
 * streams do not inflate a single window. A response with no output delta
 * (empty/aborted before any token) records no window.
 *
 * A context with no stamp means nothing routed this request through a pool
 * exit — the pool is off, the host is outside the proxy set, or routing was
 * never installed. That is exactly the 本机 ledger, so the usage lands in
 * {@link LOCAL_EXIT_ID} rather than being dropped: the modal can then show
 * that model traffic is leaving from this machine even while the pool looks
 * healthy.
 */
export async function* attributeUsage(
  store: { exitId?: string; usageSession?: string; usageLabel?: string },
  source: AsyncGenerator<HarnessChunk>,
  recorder: UsageRecorder | undefined = undefined,
  now: () => number = Date.now,
): AsyncGenerator<HarnessChunk> {
  const target = recorder ?? activeRecorder
  let firstDeltaAt: number | undefined
  for await (const chunk of source) {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
      firstDeltaAt ??= now()
    } else if (chunk.type === 'usage') {
      // Each usage closes the window the PRECEDING deltas opened; a stream
      // carrying several responses (a recovery re-send) starts a fresh one.
      const durationMs = firstDeltaAt === undefined ? undefined : Math.max(1, now() - firstDeltaAt)
      firstDeltaAt = undefined
      target.record(
        store.exitId ?? LOCAL_EXIT_ID,
        { ...chunk.usage, durationMs },
        { session: store.usageSession, label: store.usageLabel },
      )
    }
    yield chunk
  }
}
