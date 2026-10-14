/**
 * Persistent usage ledger (live request 2026-10-14: "目前流量是重启后丢失，
 * 增加改为持久记录，最长 90 天").
 *
 * The in-process {@link UsageTracker} answered "which exit served this and how
 * fast" for one host lifetime; this store answers "what did I spend" across
 * restarts, with three breakdowns the operator asked for: per day, per session
 * (the 流量 tab's top list), and per exit.
 *
 * Shape on disk (`~/.dsh/opencode-zen2dsh/usage.json`, one JSON document):
 *  - `totals`   — all-time cumulative, never trimmed: the footer's 总览 figure
 *                 has to stay honest past the retention window.
 *  - `days`     — one bucket per local calendar day, trimmed to
 *                 {@link USAGE_RETENTION_DAYS}.
 *  - `sessions` — keyed by the host's session id, carrying a readable label (the
 *                 conversation's first user turn, truncated) so the top list
 *                 means something; capped, oldest-activity first.
 *  - `exits`    — keyed by exit id (slot-stable ports, so a node keeps its
 *                 bucket across restarts); capped the same way.
 *
 * Writes are DEBOUNCED and ATOMIC (temp file + rename): a response is a few
 * hundred bytes of accounting, and rewriting the document per token would be
 * absurd; a crash between flushes loses at most the last few seconds.
 *
 * The same `record()` call also feeds the in-process tracker, so one code path
 * produces both scopes the UI switches between: `run` (this process) and
 * `total` (persisted).
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { stateDir } from '../paths.ts'
import { UsageTracker, emptyTotals, type TokenTotals, type TokenUsage, type UsageRecordMeta } from './usage.ts'

/** How long day buckets are kept (live request: 最长 90 天). */
export const USAGE_RETENTION_DAYS = 90

/** Bounds on the two keyed maps; the oldest activity is dropped first. */
const SESSION_CAP = 500
const EXIT_CAP = 200

/** Debounce window for the atomic rewrite. */
const FLUSH_DEBOUNCE_MS = 10_000

/** Which population a read is asking about. */
export type UsageScope = 'total' | 'run'

/** One day's bucket. */
export interface DayUsage {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
  totals: TokenTotals
}

/** One session's bucket, as the 流量 tab lists it. */
export interface SessionUsage {
  /** The host's session id (or the adapter's digest id without one). */
  id: string
  /** Readable label: the conversation's first user turn, truncated. */
  label: string
  totals: TokenTotals
  firstAt: number
  lastAt: number
}

interface StoredSession {
  label: string
  firstAt: number
  lastAt: number
  totals: TokenTotals
}

interface StoredExit {
  lastAt: number
  totals: TokenTotals
}

interface PersistedDocument {
  version: 1
  totals: TokenTotals
  days: Record<string, TokenTotals>
  sessions: Record<string, StoredSession>
  exits: Record<string, StoredExit>
  savedAt: number
}

/** Sum a list of buckets into one. */
export function sumTotals(buckets: Iterable<TokenTotals>): TokenTotals {
  const total = emptyTotals()
  for (const bucket of buckets) {
    total.requests += bucket.requests
    total.inputTokens += bucket.inputTokens
    total.outputTokens += bucket.outputTokens
    total.cacheReadTokens += bucket.cacheReadTokens
    total.cacheWriteTokens += bucket.cacheWriteTokens
    total.totalTokens += bucket.totalTokens
    total.outputMs += bucket.outputMs
  }
  return total
}

/** Add one bucket into another (mutating the first). */
function addInto(target: TokenTotals, source: TokenTotals): void {
  target.requests += source.requests
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.totalTokens += source.totalTokens
  target.outputMs += source.outputMs
}

/** Local calendar day key, `YYYY-MM-DD` (the operator's own timezone). */
export function localDay(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * The default ledger path (same data dir as the catalog cache). Resolved on
 * every call, so `OPENCODE_ZEN_HOME` set after import still redirects it.
 */
export function defaultUsagePath(): string {
  return join(stateDir(), 'usage.json')
}

export interface UsageStoreOptions {
  /** Ledger path; defaults to {@link defaultUsagePath}. */
  path?: string
  /** Day-bucket retention; defaults to {@link USAGE_RETENTION_DAYS}. */
  retentionDays?: number
  /** Debounce window; 0 disables the timer (tests flush explicitly). */
  flushMs?: number
  now?: () => number
  /** Injected for tests: never touch the disk. */
  readOnly?: boolean
}

export class UsageStore {
  /** This process's buckets — the 本次重启 scope, unchanged from before. */
  readonly run = new UsageTracker()

  #pathOverride: string | undefined
  #retentionDays: number
  #flushMs: number
  #now: () => number
  #readOnly: boolean
  #loaded = false
  #dirty = false
  #timer: ReturnType<typeof setInterval> | null = null

  #totals: TokenTotals = emptyTotals()
  #days = new Map<string, TokenTotals>()
  #sessions = new Map<string, StoredSession>()
  #exits = new Map<string, StoredExit>()

  /** Run-scope session buckets (this process only). */
  #runSessions = new Map<string, StoredSession>()

  constructor(options: UsageStoreOptions = {}) {
    this.#pathOverride = options.path
    this.#retentionDays = options.retentionDays ?? USAGE_RETENTION_DAYS
    this.#flushMs = options.flushMs ?? FLUSH_DEBOUNCE_MS
    this.#now = options.now ?? Date.now
    this.#readOnly = options.readOnly ?? false
  }

  /**
   * Where this ledger lives (diagnostics / the UI's footnote). Without an
   * injected path this resolves per call, so a test that drives the real entry
   * — `apply()` installs the process-wide store at import time — can still
   * redirect it by setting `OPENCODE_ZEN_HOME` in its own body (paths.ts).
   */
  get path(): string {
    return this.#pathOverride ?? defaultUsagePath()
  }

  get retentionDays(): number {
    return this.#retentionDays
  }

  /** Read the document once, then trim it to the retention window. */
  load(): void {
    if (this.#loaded) return
    this.#loaded = true
    if (this.#readOnly) return
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return // no ledger yet (first run) — not an error
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedDocument>
      if (parsed.version !== 1) return
      this.#totals = { ...emptyTotals(), ...parsed.totals }
      for (const [day, bucket] of Object.entries(parsed.days ?? {})) this.#days.set(day, { ...emptyTotals(), ...bucket })
      for (const [id, row] of Object.entries(parsed.sessions ?? {})) {
        this.#sessions.set(id, { label: row.label ?? '', firstAt: row.firstAt ?? 0, lastAt: row.lastAt ?? 0, totals: { ...emptyTotals(), ...row.totals } })
      }
      for (const [id, row] of Object.entries(parsed.exits ?? {})) {
        this.#exits.set(id, { lastAt: row.lastAt ?? 0, totals: { ...emptyTotals(), ...row.totals } })
      }
    } catch {
      // A corrupt ledger must not take the pool down: start fresh rather than
      // throwing on every request. The bad file is left alone for inspection.
      return
    }
    this.prune()
  }

  /** Attribute one response's usage to one exit (and its session). */
  record(exitId: string, usage: TokenUsage, meta: UsageRecordMeta = {}): void {
    this.load()
    const at = this.#now()
    this.run.record(exitId, usage)

    const delta = emptyTotals()
    const input = usage.inputTokens ?? 0
    const output = usage.outputTokens ?? 0
    delta.requests = 1
    delta.inputTokens = input
    delta.outputTokens = output
    delta.cacheReadTokens = usage.cacheReadTokens ?? 0
    delta.cacheWriteTokens = usage.cacheWriteTokens ?? 0
    delta.totalTokens = input + output
    delta.outputMs = usage.durationMs ?? 0

    addInto(this.#totals, delta)
    const day = localDay(at)
    const dayBucket = this.#days.get(day) ?? emptyTotals()
    addInto(dayBucket, delta)
    this.#days.set(day, dayBucket)

    const exit = this.#exits.get(exitId) ?? { lastAt: 0, totals: emptyTotals() }
    addInto(exit.totals, delta)
    exit.lastAt = at
    this.#exits.set(exitId, exit)

    const sessionId = meta.session ?? ''
    if (sessionId !== '') {
      const stored = this.#sessions.get(sessionId) ?? { label: '', firstAt: at, lastAt: 0, totals: emptyTotals() }
      if (stored.label === '' && meta.label !== undefined && meta.label !== '') stored.label = meta.label
      addInto(stored.totals, delta)
      stored.lastAt = at
      this.#sessions.set(sessionId, stored)

      const run = this.#runSessions.get(sessionId) ?? { label: stored.label, firstAt: at, lastAt: 0, totals: emptyTotals() }
      if (run.label === '' && meta.label !== undefined && meta.label !== '') run.label = meta.label
      addInto(run.totals, delta)
      run.lastAt = at
      this.#runSessions.set(sessionId, run)
    }

    this.#dirty = true
    this.#schedule()
  }

  /** All-time cumulative totals (never trimmed). */
  totals(): TokenTotals {
    this.load()
    return { ...this.#totals }
  }

  /** This process's totals. */
  runTotals(): TokenTotals {
    return sumTotals([...this.run.exits().map((id) => this.run.totals(id))])
  }

  /** One exit's bucket in the requested scope. */
  exitTotals(exitId: string, scope: UsageScope): TokenTotals {
    if (scope === 'run') return this.run.totals(exitId)
    this.load()
    return { ...(this.#exits.get(exitId)?.totals ?? emptyTotals()) }
  }

  /** One exit's last-use stamp in the requested scope (0 = never). */
  exitLastUsedAt(exitId: string, scope: UsageScope): number {
    if (scope === 'run') return this.run.lastUsedAt(exitId)
    this.load()
    return this.#exits.get(exitId)?.lastAt ?? 0
  }

  /** Day buckets, oldest first, capped to the most recent `limit` days. */
  days(scope: UsageScope, limit?: number): DayUsage[] {
    this.load()
    const source = scope === 'run' ? this.#runDays() : this.#days
    const rows = [...source.entries()]
      .map(([day, totals]) => ({ day, totals: { ...totals } }))
      .sort((left, right) => left.day.localeCompare(right.day))
    return limit === undefined ? rows : rows.slice(-limit)
  }

  /** Session buckets, heaviest first, capped to `limit`. */
  sessions(scope: UsageScope, limit = 20): SessionUsage[] {
    this.load()
    const source = scope === 'run' ? this.#runSessions : this.#sessions
    return [...source.entries()]
      .map(([id, row]) => ({ id, label: row.label, totals: { ...row.totals }, firstAt: row.firstAt, lastAt: row.lastAt }))
      .sort((left, right) => right.totals.totalTokens - left.totals.totalTokens || right.lastAt - left.lastAt)
      .slice(0, limit)
  }

  /** How many sessions/days the ledger is holding (the UI's footnote). */
  size(): { sessions: number; days: number; exits: number } {
    this.load()
    return { sessions: this.#sessions.size, days: this.#days.size, exits: this.#exits.size }
  }

  /** Drop day buckets past the retention window and cap the keyed maps. */
  prune(at?: number): void {
    const now = at ?? this.#now()
    const cutoff = localDay(now - this.#retentionDays * 24 * 60 * 60 * 1000)
    for (const day of [...this.#days.keys()]) {
      if (day < cutoff) this.#days.delete(day)
    }
    this.#cap(this.#sessions, SESSION_CAP, (row) => row.lastAt)
    this.#cap(this.#exits, EXIT_CAP, (row) => row.lastAt)
  }

  #cap<T extends { lastAt: number }>(map: Map<string, T>, limit: number, lastAt: (row: T) => number): void {
    if (map.size <= limit) return
    const doomed = [...map.entries()]
      .sort((left, right) => lastAt(left[1]) - lastAt(right[1]))
      .slice(0, map.size - limit)
    for (const [key] of doomed) map.delete(key)
  }

  /** The day buckets recorded since this process started. */
  #runDays(): Map<string, TokenTotals> {
    // Derived on read: the run tracker has no day dimension, and the store's
    // own day map is the persisted one. A process that spans midnight rolls a
    // new key here the moment the next response lands.
    const days = new Map<string, TokenTotals>()
    for (const row of this.#runSessions.values()) {
      const day = localDay(row.lastAt)
      const bucket = days.get(day) ?? emptyTotals()
      addInto(bucket, row.totals)
      days.set(day, bucket)
    }
    return days
  }

  #schedule(): void {
    if (this.#readOnly || this.#flushMs <= 0 || this.#timer !== null) return
    this.#timer = setInterval(() => { void this.flush() }, this.#flushMs)
    this.#timer.unref?.()
  }

  /** Write the document atomically (temp file + rename); no-op when clean. */
  async flush(): Promise<void> {
    if (this.#readOnly || !this.#dirty) return
    this.load()
    this.prune()
    const document: PersistedDocument = {
      version: 1,
      totals: this.#totals,
      days: Object.fromEntries(this.#days),
      sessions: Object.fromEntries(this.#sessions),
      exits: Object.fromEntries(this.#exits),
      savedAt: this.#now(),
    }
    const temp = `${this.path}.tmp`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(temp, JSON.stringify(document), 'utf8')
      renameSync(temp, this.path)
      this.#dirty = false
    } catch {
      // A failed write must never fail the request that triggered it; the next
      // flush retries with the same in-memory state.
      try {
        unlinkSync(temp)
      } catch { /* nothing to clean */ }
    }
  }

  /** Stop the timer and write whatever is pending (host shutdown). */
  async dispose(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    await this.flush()
  }

  /**
   * Operator-facing clear (live request 2026-10-14: "总量统计保留 90 天，自然
   * 过期，增加一个清空的功能按钮"): drop every bucket AND make the empty
   * document the one on disk, so a restart cannot bring the numbers back.
   *
   * `load()` runs FIRST on purpose: a store that has not read the file yet
   * would otherwise re-read it inside `flush()` and merge the old totals back
   * over the clear. Both scopes go together — a cleared 总览 next to a live
   * 本次重启 would read as a bug, not as a feature.
   */
  async clear(): Promise<void> {
    this.load()
    this.reset()
    this.#dirty = true
    await this.flush()
  }

  /** In-memory-only seam: drop every bucket and start over (tests). */
  reset(): void {
    this.run.reset()
    this.#totals = emptyTotals()
    this.#days.clear()
    this.#sessions.clear()
    this.#exits.clear()
    this.#runSessions.clear()
    this.#dirty = false
  }
}

/** The process-wide ledger: adapter writes, status bridge reads. */
export const usageStore = new UsageStore()
