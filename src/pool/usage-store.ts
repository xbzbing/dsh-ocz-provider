/**
 * Persistent usage ledger (docs/ip-pool.md §5.6): day/session/exit
 * breakdowns kept across restarts, day buckets retained 90 days.
 *
 * The in-process {@link UsageTracker} answered "which exit served this and how
 * fast" for one host lifetime; this store answers "what did I spend" across
 * restarts, with three breakdowns the operator asked for: per day, per session
 * (the 流量 tab's top list), and per exit.
 *
 * Shape on disk (`~/.dsh/oc2dsh/usage.json`, one JSON document):
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
 * Writes are DEBOUNCED and ATOMIC (a per-process temp file + rename): a
 * response is a few hundred bytes of accounting, and rewriting the document per
 * token would be absurd; a crash between flushes loses at most the last few
 * seconds. Each flush re-reads the file and adds only this process's unflushed
 * deltas onto it, so two hosts sharing one state root do not erase each other's
 * counters (docs/ip-pool.md §5.6). A file that cannot be read as a ledger is
 * renamed aside (`usage.json.corrupt-<ms>`) before a fresh one is written.
 *
 * The same `record()` call also feeds the in-process tracker, so one code path
 * produces both scopes the UI switches between: `run` (this process) and
 * `total` (persisted).
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { stateDir } from '../paths.ts'
import { UsageTracker, emptyTotals, type TokenTotals, type TokenUsage, type UsageRecordMeta } from './usage.ts'

/** How long day buckets are kept (docs/ip-pool.md §5.6). */
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

/** What this process recorded since its last successful flush. */
interface PendingDeltas {
  totals: TokenTotals
  days: Map<string, TokenTotals>
  sessions: Map<string, StoredSession>
  exits: Map<string, StoredExit>
}

function emptyPending(): PendingDeltas {
  return { totals: emptyTotals(), days: new Map(), sessions: new Map(), exits: new Map() }
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
  for (const bucket of buckets) addInto(total, bucket)
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
 * every call, so `OC2DSH_HOME` set after import still redirects it.
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
  /** This process's buckets — the 本次重启 scope. */
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
  /** Deltas not yet written; merged onto the file's current content at flush. */
  #pending: PendingDeltas = emptyPending()
  /** The next flush writes memory as-is instead of merging (after clear()). */
  #replaceOnFlush = false

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
   * redirect it by setting `OC2DSH_HOME` in its own body (paths.ts).
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
    const document = this.#readDocument()
    if (document !== null) this.#adopt(document)
    this.prune()
  }

  /**
   * The ledger on disk, or null when there is none. A file that is not a
   * version-1 ledger (corrupt JSON, a hand edit, a future version) is renamed
   * aside so the next write never destroys it.
   */
  #readDocument(): Partial<PersistedDocument> | null {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return null // no ledger yet (first run) — not an error
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedDocument> | null
      if (parsed !== null && typeof parsed === 'object' && parsed.version === 1) return parsed
    } catch {
      /* fall through: not a ledger */
    }
    try {
      renameSync(this.path, `${this.path}.corrupt-${this.#now()}`)
    } catch { /* already moved by another process */ }
    return null
  }

  /** Replace the persisted maps with a document's content. */
  #adopt(parsed: Partial<PersistedDocument>): void {
    this.#totals = { ...emptyTotals(), ...parsed.totals }
    this.#days.clear()
    this.#sessions.clear()
    this.#exits.clear()
    for (const [day, bucket] of Object.entries(parsed.days ?? {})) this.#days.set(day, { ...emptyTotals(), ...bucket })
    for (const [id, row] of Object.entries(parsed.sessions ?? {})) {
      this.#sessions.set(id, { label: row.label ?? '', firstAt: row.firstAt ?? 0, lastAt: row.lastAt ?? 0, totals: { ...emptyTotals(), ...row.totals } })
    }
    for (const [id, row] of Object.entries(parsed.exits ?? {})) {
      this.#exits.set(id, { lastAt: row.lastAt ?? 0, totals: { ...emptyTotals(), ...row.totals } })
    }
  }

  /** Add this process's unflushed deltas onto the persisted maps. */
  #applyPending(): void {
    const pending = this.#pending
    addInto(this.#totals, pending.totals)
    for (const [day, delta] of pending.days) {
      const bucket = this.#days.get(day) ?? emptyTotals()
      addInto(bucket, delta)
      this.#days.set(day, bucket)
    }
    for (const [id, delta] of pending.sessions) mergeSession(this.#sessions, id, delta)
    for (const [id, delta] of pending.exits) {
      const row = this.#exits.get(id) ?? { lastAt: 0, totals: emptyTotals() }
      addInto(row.totals, delta.totals)
      row.lastAt = Math.max(row.lastAt, delta.lastAt)
      this.#exits.set(id, row)
    }
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

    const day = localDay(at)
    const sessionId = meta.session ?? ''
    const label = meta.label ?? ''
    // The same delta lands in memory (what reads see) and in the pending set
    // (what the next flush adds onto the file).
    for (const target of [
      { totals: this.#totals, days: this.#days, sessions: this.#sessions, exits: this.#exits },
      this.#pending,
    ]) {
      addInto(target.totals, delta)
      const dayBucket = target.days.get(day) ?? emptyTotals()
      addInto(dayBucket, delta)
      target.days.set(day, dayBucket)
      const exit = target.exits.get(exitId) ?? { lastAt: 0, totals: emptyTotals() }
      addInto(exit.totals, delta)
      exit.lastAt = at
      target.exits.set(exitId, exit)
      if (sessionId !== '') mergeSession(target.sessions, sessionId, { label, firstAt: at, lastAt: at, totals: delta })
    }

    if (sessionId !== '') {
      mergeSession(this.#runSessions, sessionId, { label: this.#sessions.get(sessionId)?.label ?? label, firstAt: at, lastAt: at, totals: delta })
      this.#cap(this.#runSessions, SESSION_CAP, (row) => row.lastAt)
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

  /**
   * Write the document atomically (temp file + rename); no-op when clean.
   * The file is re-read first and this process's pending deltas are added onto
   * it, so another process's flushes survive; only a write landing between
   * this read and this rename can still be lost (last writer wins there).
   */
  async flush(): Promise<void> {
    if (this.#readOnly || !this.#dirty) return
    this.load()
    if (!this.#replaceOnFlush) {
      const onDisk = this.#readDocument()
      if (onDisk !== null) {
        this.#adopt(onDisk)
        this.#applyPending()
      }
    }
    this.prune()
    const document: PersistedDocument = {
      version: 1,
      totals: this.#totals,
      days: Object.fromEntries(this.#days),
      sessions: Object.fromEntries(this.#sessions),
      exits: Object.fromEntries(this.#exits),
      savedAt: this.#now(),
    }
    // Per-process temp name: two hosts sharing the state root never write one file.
    const temp = `${this.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(temp, JSON.stringify(document), 'utf8')
      renameSync(temp, this.path)
      this.#dirty = false
      this.#pending = emptyPending()
      this.#replaceOnFlush = false
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
   * Operator-facing clear (docs/ip-pool.md §5.6): drop every bucket AND make
   * the empty document the one on disk, so a restart cannot bring the numbers
   * back.
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
    this.#replaceOnFlush = true
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
    this.#pending = emptyPending()
    this.#dirty = false
  }
}

/** Fold one session delta into a session map (labels: first non-empty wins). */
function mergeSession(map: Map<string, StoredSession>, id: string, delta: StoredSession): void {
  const row = map.get(id)
  if (row === undefined) {
    map.set(id, { label: delta.label, firstAt: delta.firstAt, lastAt: delta.lastAt, totals: { ...delta.totals } })
    return
  }
  if (row.label === '' && delta.label !== '') row.label = delta.label
  row.firstAt = row.firstAt === 0 ? delta.firstAt : Math.min(row.firstAt, delta.firstAt)
  row.lastAt = Math.max(row.lastAt, delta.lastAt)
  addInto(row.totals, delta.totals)
}

/** The process-wide ledger: adapter writes, status bridge reads. */
export const usageStore = new UsageStore()
