/**
 * ExitPool — the exit-node table plus two-tier health and the four-state
 * refill machine (docs/ip-pool.md section 3).
 *
 * Tier 1, per-exit (ExitHealth): 429 cooldown + dead marking. Anonymous
 * quota is metered per exit IP (design.md section 3), so a 429 cools the
 * whole exit while other exits keep serving.
 *
 * Tier 2, per-(exit x model) (ModelBan): 401/403 refusals are usually
 * model-level (region blocks, delisting — see the muse/hy3 notes in
 * catalog.ts), so they ban only that pairing and never cool the exit.
 *
 * The pool is pure state: no IO, no timers. The prober, the dispatcher and
 * the refill scheduler all drive it through the mark* methods and read it
 * through pick()/snapshot(). injectable now() keeps the cooldown math
 * unit-testable.
 */

import { LOCAL_EXIT_ID } from './usage.ts'

export type ExitSource = 'free' | 'manual' | 'subscription' | 'goproxy'

export interface ExitNode {
  /** host:port, unique inside the pool (the address we dial). */
  id: string
  protocol: 'http' | 'socks5'
  source: ExitSource
  /** Fixed primary exit (docs/ip-pool.md 3.6). */
  pinned: boolean
  /** Empty for pinned nodes whose admission could not read it (3.1). */
  exitIP: string
  exitLocation: string
  latencyMs: number
  quality: 'S' | 'A' | 'B' | 'C'
  addedAt: number
}

export type ExitState = 'unknown' | 'ok' | 'dead'
/**
 * How long an exit is benched after OpenCode's IP-reputation refusal
 * (…abusive traffic from this IP address…). The flag lives upstream and is
 * measured in hours (docs/ip-pool.md §3.2), so a minutes-long cooldown would
 * just re-burn the same refusal on the next rotation. The card's 探测 action
 * still probes it on demand, and a probe that passes clears the note (markOk).
 */
export const ABUSIVE_COOLDOWN_MS = 3 * 60 * 60 * 1000
export type BanState = 'ok' | 'suspect' | 'banned'
/**
 * Why an exit is benched beyond a plain cooldown. `'abusive'` is OpenCode's
 * IP-reputation refusal (…detected abusive traffic from this IP address…):
 * the flag lives upstream for hours, so the exit is benched for the long haul
 * instead of being retried every rotation.
 */
export type ExitNote = '' | 'abusive'

interface ExitHealth {
  state: ExitState
  lastProbedAt: number
  consecutiveLimited: number
  /** 429 cooldown deadline (epoch ms); 0 = not cooling. */
  cooldownUntil: number
  /** Serial-probe lock slot: at most one in-flight probe per exit (4.1). */
  inflight: boolean
  /** Consecutive strikes; a free row evicts after deadEvictions (3.5). */
  deadStrikes: number
  /**
   * When the exit was last struck dead (epoch ms); 0 = not dead. Diagnostic
   * bookkeeping (the exit table and tests read it); markOk clears it.
   */
  deadAt: number
  /** Why the exit is benched, when the reason outlives a cooldown (ExitNote). */
  note: ExitNote
  noteAt: number
}

interface ModelBan {
  state: BanState
  bannedAt: number
  consecutiveFailures: number
}

export type PoolState = 'healthy' | 'warning' | 'critical' | 'emergency'

export interface PoolOptions {
  /** Free-pool target capacity (docs/ip-pool.md 3.5). Free-source nodes only. */
  targetSize?: number
  /**
   * Whole-pool capacity: how many exits the pool keeps online at once, any
   * source (settings `poolSize`, default 10). This is the number that bounds
   * local connections too, because the onboarding shrinks the sing-box config
   * to the selected exits.
   *
   * Enforced by the ADMISSION paths (`admissionQuota()` for free,
   * `isFull()`/`evictWorst()` for the onboarding), not by `add()`: `add()` stays
   * a pure upsert so a hand-configured manual row or the user's pinned line is
   * never silently dropped — those are explicit config, and the onboarding
   * evicts a slower unpinned row to make room instead.
   */
  poolSize?: number
  /** First 429 cooldown. */
  limitedCooldownBaseMs?: number
  /** Exponential backoff ceiling. */
  limitedCooldownMaxMs?: number
  /** Suspect -> banned after this many consecutive 401/403. */
  modelBanConfirmations?: number
  /** Dead exits are evicted after this many strikes (free source only). */
  deadEvictions?: number
  now?: () => number
}

/** Quality grade from admission latency (GoProxy thresholds). */
export function gradeOf(latencyMs: number): ExitNode['quality'] {
  if (latencyMs <= 500) return 'S'
  if (latencyMs <= 1000) return 'A'
  if (latencyMs <= 2000) return 'B'
  return 'C'
}

/**
 * Grade for an exit that was never measured. gradeOf(0) returns 'S' (a 0ms
 * admission), which would hand the BEST grade to an exit carrying NO facts,
 * and the picker sorts by grade. An unmeasured exit ranks last until a probe
 * actually measures it.
 */
export const UNVERIFIED_QUALITY: ExitNode['quality'] = 'C'

/** Quality rank for worst-first eviction (lower grade = keep longer). */
const GRADE_RANK: Record<ExitNode['quality'], number> = { S: 0, A: 1, B: 2, C: 3 }

const banKey = (exitId: string, model: string) => `${exitId}\u0000${model}`

export class ExitPool {
  readonly #nodes = new Map<string, ExitNode>()
  readonly #health = new Map<string, ExitHealth>()
  readonly #bans = new Map<string, ModelBan>()
  readonly #sessionExit = new Map<string, string>()
  /** Passive-signal counters per exit (docs/ip-pool.md §4.3 被动 + IP-6 stats). */
  readonly #passive = new Map<string, { ok: number; limited: number; refused: number; dead: number; transport: number }>()
  /** Live-request activity per exit: last dispatch stamp + in-flight count
   *  (exit-stats surface — "which exit is being used right now"). */
  readonly #activity = new Map<string, { lastUsedAt: number; inFlight: number }>()
  /** Pool-host requests that fell back to a direct connection (empty pool /
   *  missing proxy agent) — the honest 直连兜底 count for the stats modal. */
  #directRequests = 0
  /** Fired once per newly added node — see onAdmitted(). */
  #admittedCallbacks: Array<() => void> = []
  /** Fired when an exit transitions to dead — see onDead(). */
  #deadCallbacks: Array<(id: string) => void> = []
  /** Fired when a set pin is skipped by the rotation — see onPinnedSkip(). */
  #pinSkipCallbacks: Array<(pinned: string, used: string) => void> = []
  /**
   * Exits rejected by the upstream lane (a failed OpenCode smoke, or a 401/403
   * verdict) with no reserve left to promote: they stay in the pool as the last
   * resort but are ranked last by `pick()` and listed last by `list()` — the
   * pool keeps its size instead of draining to zero (docs/ip-pool.md §4.7).
   */
  readonly #demoted = new Set<string>()
  #targetSize: number
  #poolSize: number
  #cooldownBase: number
  #cooldownMax: number
  #banConfirmations: number
  #deadEvictions: number
  #now: () => number

  constructor(options: PoolOptions = {}) {
    this.#targetSize = options.targetSize ?? 20
    this.#poolSize = options.poolSize ?? 10
    this.#cooldownBase = options.limitedCooldownBaseMs ?? 60_000
    this.#cooldownMax = options.limitedCooldownMaxMs ?? 30 * 60_000
    this.#banConfirmations = options.modelBanConfirmations ?? 2
    this.#deadEvictions = options.deadEvictions ?? 2
    this.#now = options.now ?? Date.now
  }

  /** Live re-apply of the whole-pool capacity (settings page, §5.1). */
  setPoolSize(value: number): void {
    this.#poolSize = Math.max(1, value)
  }

  /** The effective whole-pool capacity (diagnostics / status bridge). */
  get poolSize(): number {
    return this.#poolSize
  }

  /** Is the pool at capacity? Callers admit only after this returns false. */
  isFull(): boolean {
    return this.#nodes.size >= this.#poolSize
  }

  /** Is this exit demoted to the tail (rejected, no reserve to promote)? */
  demoted(id: string): boolean {
    return this.#demoted.has(id)
  }

  /**
   * Move an exit to the tail of the pool's own order: keep it (it may still
   * serve another model, or recover) but let `pick()` rank it last and the exit
   * table list it last. `add()`'s Map insertion order IS the pool order, so a
   * delete + re-insert is the whole move — every side table (health, bans,
   * passive counters, activity) is keyed by id and survives untouched.
   */
  demoteToTail(id: string): boolean {
    if (!this.#moveToTail(id)) return false
    this.#demoted.add(id)
    return true
  }

  /** The reorder half of demoteToTail, without the last-resort flag: a dead
   *  exit sinks to the end of the table but recovers straight back into the
   *  ranked set once a probe verifies it (`markOk` clears `#demoted` only). */
  #moveToTail(id: string): boolean {
    const node = this.#nodes.get(id)
    if (node === undefined) return false
    this.#nodes.delete(id)
    this.#nodes.set(id, node)
    return true
  }

  /** Is this exit currently `dead` (transport failure / failed probe)? */
  isDead(id: string): boolean {
    return this.#health.get(id)?.state === 'dead'
  }

  /**
   * Evict the worst exit to make room for a better candidate (whole pool, any
   * source, pinned never). Worst = lowest quality grade, then slowest, then
   * oldest — the same ordering `evictWorstFree()` uses, minus the source filter.
   * Returns the evicted id (null when nothing can be evicted), because the
   * caller has to close that exit's local listener too — see `Onboarder.trim()`.
   */
  evictWorst(): string | null {
    let worst: ExitNode | null = null
    for (const node of this.#nodes.values()) {
      if (node.pinned) continue
      if (worst === null) {
        worst = node
        continue
      }
      const byGrade = GRADE_RANK[node.quality] - GRADE_RANK[worst.quality]
      const byLatency = node.latencyMs - worst.latencyMs
      const worse = byGrade > 0
        || (byGrade === 0 && byLatency > 0)
        || (byGrade === 0 && byLatency === 0 && node.addedAt < worst.addedAt)
      if (worse) worst = node
    }
    if (worst === null) return null
    this.remove(worst.id)
    return worst.id
  }

  /** Live re-apply of the free-pool target capacity (settings page, §5.1). */
  setTargetSize(value: number): void {
    this.#targetSize = Math.max(1, value)
  }

  /** The effective target capacity (diagnostics / status bridge). */
  get targetSize(): number {
    return this.#targetSize
  }

  // -- table management ------------------------------------------------------

  /**
   * Register a callback fired after every node newly added to the pool.
   *
   * The runtime assembly uses it to engage routing the moment a pool that
   * assembled EMPTY stops being empty. Without a source-agnostic hook here, a
   * profile that fills up after boot (subscription-only, free disabled) keeps
   * the dispatcher uninstalled and reports "enabled" while every request still
   * goes direct; free, subscription and manual admissions all reach this hook
   * through add().
   */
  onAdmitted(callback: () => void): void {
    this.#admittedCallbacks.push(callback)
  }

  /** A watcher's failure must never fail an admission. */
  #notifyAdmitted(): void {
    for (const callback of this.#admittedCallbacks) {
      try {
        callback()
      } catch {
        /* swallowed on purpose: bookkeeping is not admission */
      }
    }
  }

  /**
   * Register a callback fired when an exit TRANSITIONS to `dead` (once per
   * transition, not once per strike). The runtime uses it to rotate: the
   * subscription layer swaps the dead exit for the next-fastest reserve, or
   * parks it at the pool tail when no reserve is left (docs/ip-pool.md §4.7).
   */
  onDead(callback: (id: string) => void): void {
    this.#deadCallbacks.push(callback)
  }

  /** A watcher's failure must never fail the strike bookkeeping. */
  #notifyDead(id: string): void {
    for (const callback of this.#deadCallbacks) {
      try {
        callback(id)
      } catch {
        /* swallowed on purpose: bookkeeping is not the caller's error */
      }
    }
  }

  /**
   * Refresh one row's measured facts IN PLACE. Returns false when the row is
   * no longer in the table.
   *
   * A probe holds an `entry` snapshot taken before it ran, and the exit can
   * leave the table while the probe is in flight (a dead rotation, a refusal
   * replacement, an operator's 删除). `add()` is an upsert, so writing that
   * snapshot back RESURRECTS the removed row — and a resurrected row has no
   * local listener, while `isUsable()` still hands it out as the last resort
   * (docs/ip-pool.md §4.7). Facts for a row that left the table are dropped
   * instead: the probe measured an exit the pool already gave up on.
   *
   * Only the admission-measured fields are writable here — identity, source and
   * the pin flag belong to whoever put the row in the table.
   */
  refresh(id: string, facts: Partial<Pick<ExitNode, 'protocol' | 'exitIP' | 'exitLocation' | 'latencyMs' | 'quality'>>): boolean {
    const node = this.#nodes.get(id)
    if (node === undefined) return false
    // Mutated in place on purpose: `add()`'s Map insertion order IS the pool
    // order, so a delete + re-insert would silently sink the row to the tail.
    if (facts.protocol !== undefined) node.protocol = facts.protocol
    if (facts.exitIP !== undefined) node.exitIP = facts.exitIP
    if (facts.exitLocation !== undefined) node.exitLocation = facts.exitLocation
    if (facts.latencyMs !== undefined) node.latencyMs = facts.latencyMs
    if (facts.quality !== undefined) node.quality = facts.quality
    return true
  }

  /** Upsert a node (admission wrote its details); returns false on duplicate
   *  exit IP for a different address — two addresses sharing one exit IP are
   *  one quota bucket and must not both live in the pool (3.1). */
  add(node: ExitNode): boolean {
    if (node.exitIP !== '' && this.#hasExitIP(node.exitIP, node.id)) return false
    const isNew = !this.#nodes.has(node.id)
    this.#nodes.set(node.id, node)
    if (!this.#health.has(node.id)) {
      this.#health.set(node.id, {
        state: 'unknown',
        lastProbedAt: 0,
        consecutiveLimited: 0,
        cooldownUntil: 0,
        inflight: false,
        deadStrikes: 0,
        deadAt: 0,
        note: '',
        noteAt: 0,
      })
    }
    if (isNew) this.#notifyAdmitted()
    return true
  }

  #hasExitIP(exitIP: string, exceptId: string): boolean {
    for (const node of this.#nodes.values()) {
      if (node.id !== exceptId && node.exitIP === exitIP) return true
    }
    return false
  }

  has(id: string): boolean {
    return this.#nodes.has(id)
  }

  get(id: string): ExitNode | undefined {
    return this.#nodes.get(id)
  }

  /** Drop a node entirely (dead eviction for free nodes, cleanup otherwise). */
  remove(id: string): void {
    this.#nodes.delete(id)
    this.#health.delete(id)
    this.#passive.delete(id)
    this.#activity.delete(id)
    this.#demoted.delete(id)
    for (const key of this.#bans.keys()) {
      if (key.startsWith(`${id}\u0000`)) this.#bans.delete(key)
    }
    for (const [session, exitId] of this.#sessionExit) {
      if (exitId === id) this.#sessionExit.delete(session)
    }
    this.#clearPinnedIf(id)
  }

  /** Disable without dropping (dead manual/subscription/goproxy nodes, 3.5). */
  markDead(id: string): void {
    const health = this.#health.get(id)
    if (!health) return
    const wasDead = health.state === 'dead'
    health.state = 'dead'
    health.inflight = false
    if (!wasDead) {
      this.#moveToTail(id)
      this.#notifyDead(id)
    }
  }

  /**
   * A probe could not verify this exit (trusted-source admission fallback):
   * keep the node — a subscription line is paid and `admission.admitTrusted`
   * promises to revisit it — but drop its `ok` claim, so it leaves the
   * verified tier that `pick()` ranks first.
   *
   * 'unknown' is still *usable* (`#isAvailable` only hides 'dead'), which is
   * deliberate: a probe-side failure (Zen rejecting the smoke request, an
   * echo endpoint hiccup) must not empty a healthy pool. It only means an
   * exit that was never measured no longer outranks one that was.
   *
   * NOT a revival: an exit already struck dead stays dead until a probe
   * proves it alive (`markOk`). Otherwise a trusted line whose local port no
   * longer exists is re-admitted every round and absorbs every rotation
   * (docs/ip-pool.md §3.2).
   */
  markUnverified(id: string): void {
    const health = this.#health.get(id)
    if (!health) return
    if (health.state !== 'dead') health.state = 'unknown'
    health.inflight = false
  }

  /**
   * Put one struck-dead row back into service, WITHOUT claiming it is healthy.
   *
   * A `dead` mark is permanent until something proves the row alive, and
   * `pick()` skips dead rows — so a row nothing routes to earns no real 2xx,
   * and a corrected cause (a mislabelled protocol) would otherwise leave the
   * sentence behind (AGENTS.md, egress row hygiene).
   *
   * The revived row lands in 'unknown', not 'ok': a corrected label is evidence
   * about the LISTENER, not about the lane, so it re-enters the rotation below
   * the measured tier — and a pinned row is picked again immediately, which is
   * the point. `deadStrikes` resets with it: the grace is per outage.
   *
   * Returns false when the row is no longer in the table (a rotation may have
   * taken it while the diagnosis ran).
   */
  revive(id: string): boolean {
    const health = this.#health.get(id)
    if (health === undefined) return false
    if (health.state === 'dead') {
      health.state = 'unknown'
      health.deadStrikes = 0
      health.deadAt = 0
    }
    return true
  }

  /**
   * OpenCode refused this exit's IP on reputation grounds (…abusive traffic
   * from this IP address…): bench it for the long haul and record why.
   * Rotating back onto the same address inside the flag's lifetime can only
   * burn requests, and a pin on it turns into an endless failure loop — the
   * cooldown makes `isUsable()` false, so pick() skips it whatever the pin says.
   */
  markAbusive(id: string, windowMs: number = ABUSIVE_COOLDOWN_MS): number {
    const health = this.#health.get(id)
    if (!health) return 0
    health.cooldownUntil = Math.max(health.cooldownUntil, this.#now() + windowMs)
    health.note = 'abusive'
    health.noteAt = this.#now()
    return health.cooldownUntil
  }

  #clearPinnedIf(id: string): void {
    if (this.pinnedId === id) this.pinnedId = ''
  }

  pinnedId = ''

  /** Pin a node (docs/ip-pool.md 3.6); unpinning any previous pinned node.
   *  The row-level `pinned` flag is kept in step here so a stale flag can
   *  never keep routing a row down the pinned admission path after a
   *  hot-reconfigure unpinned it (the flag is read by probeOne). */
  pin(id: string): boolean {
    const target = this.#nodes.get(id)
    if (target === undefined) return false
    this.pinnedId = id
    for (const node of this.#nodes.values()) node.pinned = node === target
    return true
  }

  unpin(): void {
    this.pinnedId = ''
    for (const node of this.#nodes.values()) node.pinned = false
  }

  /**
   * Pin every request to THIS machine: the 本机 row's 固定 button. The sentinel
   * is {@link LOCAL_EXIT_ID}, which can never collide with a real exit id (those
   * are `host:port` or `scheme://host:port`), so `pick()` can tell "no exit at
   * all" from "the pinned exit is unusable" and return null instead of falling
   * through to the rotation pool. Traffic then egresses locally through the
   * dispatcher's local-egress branch, regardless of the 本地出口兜底 switch
   * (docs/ip-pool.md §3.3).
   *
   * No row carries the `pinned` flag here: there is no primary exit, and
   * leaving a stale flag behind would keep routing a row down the pinned
   * admission path after the switch (the same trap `pin()` documents).
   */
  pinLocal(): void {
    this.pinnedId = LOCAL_EXIT_ID
    for (const node of this.#nodes.values()) node.pinned = false
  }

  /** Whether the pin is currently the local-egress sentinel (status view). */
  get pinnedLocal(): boolean {
    return this.pinnedId === LOCAL_EXIT_ID
  }

  // -- probe locking (4.1: serial per exit) -----------------------------------

  /** Try to take the exit's serial-probe slot; false when already taken. */
  takeProbeLock(id: string): boolean {
    const health = this.#health.get(id)
    if (!health || health.inflight) return false
    health.inflight = true
    return true
  }

  releaseProbeLock(id: string): void {
    const health = this.#health.get(id)
    if (health) health.inflight = false
  }

  // -- passive & probe signals (rule table 4.2) --------------------------------

  markOk(id: string, model?: string): void {
    const health = this.#health.get(id)
    if (health) {
      health.state = 'ok'
      health.lastProbedAt = this.#now()
      health.consecutiveLimited = 0
      health.cooldownUntil = 0
      health.deadStrikes = 0
      health.deadAt = 0
      // A probe proved the exit alive against the REAL lane, so any recorded
      // bench reason (an abuse flag that has since cleared) is spent.
      health.note = ''
      health.noteAt = 0
    }
    // A verified-healthy exit is no longer demoted: the refusal that pushed it
    // to the tail was not permanent, and a later probe proved it.
    this.#demoted.delete(id)
    if (model !== undefined) {
      this.#bans.set(banKey(id, model), { state: 'ok', bannedAt: 0, consecutiveFailures: 0 })
    }
  }

  /** 429: exit-level cooldown with exponential backoff (3.2 / 4.6). */
  markLimited(id: string): number {
    const health = this.#health.get(id)
    if (!health) return 0
    health.consecutiveLimited += 1
    health.state = 'ok'
    const backoff = Math.min(
      this.#cooldownBase * 2 ** (health.consecutiveLimited - 1),
      this.#cooldownMax,
    )
    health.cooldownUntil = this.#now() + backoff
    return health.cooldownUntil
  }

  /** Deterministic refusal (upstream RegionError: region blocks are a
   *  property of the exit, not transient noise) — ban the pairing at once. */
  markModelBanned(id: string, model: string): void {
    this.#bans.set(banKey(id, model), { state: 'banned', bannedAt: this.#now(), consecutiveFailures: this.#banConfirmations })
  }

  /** 401/403: model-level suspicion; banned after N consecutive (3.2). */
  markModelSignal(id: string, model: string): BanState {
    const key = banKey(id, model)
    const current = this.#bans.get(key) ?? { state: 'ok' as BanState, bannedAt: 0, consecutiveFailures: 0 }
    current.consecutiveFailures += 1
    if (current.consecutiveFailures >= this.#banConfirmations && current.state !== 'banned') {
      current.state = 'banned'
      current.bannedAt = this.#now()
    } else if (current.state !== 'banned') {
      current.state = 'suspect'
    }
    this.#bans.set(key, current)
    return current.state
  }

  /** Transport failure / 5xx / probe timeout: dead, with free-source eviction
   *  after repeated strikes (3.5). Returns true when the node was evicted. */
  markDeadStrike(id: string): boolean {
    const node = this.#nodes.get(id)
    const health = this.#health.get(id)
    if (!node || !health) return false
    const wasDead = health.state === 'dead'
    health.state = 'dead'
    health.inflight = false
    health.deadStrikes += 1
    health.deadAt = this.#now()
    // A dead exit sinks to the end of the table and tells the runtime to
    // rotate a reserve in. Only on the TRANSITION: a node that keeps failing
    // would otherwise be re-inserted on every strike.
    if (!wasDead) {
      this.#moveToTail(id)
      this.#notifyDead(id)
    }
    if (node.source === 'free' && health.deadStrikes >= this.#deadEvictions) {
      this.remove(id)
      return true
    }
    return false
  }

  /** Death from a mid-flight stream (no retry path): same strike accounting. */
  markStreamFailure(id: string, kind: '429' | 'model', model?: string): void {
    if (kind === '429') {
      this.markLimited(id)
      this.#countPassive(id, 'limited')
    } else if (model !== undefined) {
      this.markModelSignal(id, model)
      this.#countPassive(id, 'refused')
    }
  }

  /**
   * Passive signal from a REAL request outcome (docs/ip-pool.md §4.2 rule
   * table, §4.3 被动 row): one response header read at the routing layer,
   * applied to the two-tier health exactly like a probe would. Returns the
   * classification for diagnostics.
   */
  recordPassive(id: string, statusCode: number, model: string, regionBlocked = false): 'ok' | 'limited' | 'refused' | 'dead' {
    if (!this.#nodes.has(id)) return 'ok'
    if (statusCode >= 200 && statusCode < 300) {
      this.markOk(id, model)
      this.#countPassive(id, 'ok')
      return 'ok'
    }
    if (statusCode === 429) {
      this.markLimited(id)
      this.#countPassive(id, 'limited')
      return 'limited'
    }
    if (statusCode === 401 || statusCode === 403) {
      // RegionError bodies are deterministic region blocks — a second sample
      // adds nothing, so ban the (exit, model) pairing immediately (docs 4.2).
      if (regionBlocked) this.markModelBanned(id, model)
      else this.markModelSignal(id, model)
      this.#countPassive(id, 'refused')
      return 'refused'
    }
    // 5xx: count into the dead bucket for diagnostics, but DO NOT strike the
    // exit dead. A 500 is often the MODEL failing behind a healthy exit (muse
    // without contributor access answers 500 through every exit), and striking
    // would dead a single-exit pool, empty `pick()` and silently send ALL
    // traffic direct while the pool still looked enabled. Exit liveness stays
    // the transport layer's call (sentinel/onResponseError); a 5xx-flapping
    // exit is recovered by the adapter rotate loop (5xx is in its set).
    this.#countPassive(id, 'dead')
    return 'dead'
  }

  /** Transport-level failure of a real request (connection died mid-flight). */
  recordPassiveTransport(id: string): void {
    if (!this.#nodes.has(id)) return
    this.markDeadStrike(id)
    this.#countPassive(id, 'transport')
  }

  /**
   * Count a transport-level failure WITHOUT deciding the row's fate.
   *
   * Cuts reach this table through pool/transport.ts, which may still be
   * finding out what one means: a listener whose scheme is mislabelled
   * answers nothing at all, and that is not a dead line.
   * The counters are diagnostics — `passive.transport` has to say how often an
   * exit dropped a request either way — so counting is separable from
   * striking.
   */
  recordTransportSignal(id: string): void {
    if (!this.#nodes.has(id)) return
    this.#countPassive(id, 'transport')
  }

  /** Drop the session's sticky exit when its exit degraded (§3.3). */
  rerouteSession(session: string): void {
    this.#sessionExit.delete(session)
  }

  /**
   * The session's current sticky exit, if any (adapter-side 403 bookkeeping:
   *  the dispatcher recorded the refusal against this exit). */
  exitOfSession(session: string): string | null {
    return this.#sessionExit.get(session) ?? null
  }

  #countPassive(id: string, kind: 'ok' | 'limited' | 'refused' | 'dead' | 'transport'): void {
    const bucket = this.#passive.get(id) ?? { ok: 0, limited: 0, refused: 0, dead: 0, transport: 0 }
    bucket[kind] += 1
    this.#passive.set(id, bucket)
  }

  /** Passive-signal counters for one exit (status bridge, IP-6). */
  passiveStats(id: string): { ok: number; limited: number; refused: number; dead: number; transport: number } {
    return { ...(this.#passive.get(id) ?? { ok: 0, limited: 0, refused: 0, dead: 0, transport: 0 }) }
  }

  /**
   * When this exit was last PROVEN alive against the real lane — a 2xx through
   * it or a probe that passed (both land in `markOk`); 0 = never.
   *
   * `pool/transport.ts` keys its one free diagnosis per outage on this, so a
   * cut can tell "nothing has worked since the last cut" (a dying line) from
   * "an isolated hiccup on a line that has carried traffic since".
   */
  provenAt(id: string): number {
    return this.#health.get(id)?.lastProbedAt ?? 0
  }

  /**
   * Book one dispatched request against this exit: stamps last-used with the
   * pool clock and increments in-flight until endRequest lands. Called by the
   * routing dispatcher at pick() — the moment "which exit is serving this"
   * becomes known (exit-stats surface).
   */
  beginRequest(id: string): void {
    const slot = this.#activity.get(id) ?? { lastUsedAt: 0, inFlight: 0 }
    slot.lastUsedAt = this.#now()
    slot.inFlight += 1
    this.#activity.set(id, slot)
  }

  /** Terminal callback for a begun request; floors at zero on a double end
   *  (the observer can end from both the response path and the sentinel). */
  endRequest(id: string): void {
    const slot = this.#activity.get(id)
    if (slot !== undefined && slot.inFlight > 0) slot.inFlight -= 1
  }

  /** Activity row for one exit (status bridge); zeros when never dispatched. */
  activity(id: string): { lastUsedAt: number; inFlight: number } {
    const slot = this.#activity.get(id)
    return slot === undefined ? { lastUsedAt: 0, inFlight: 0 } : { ...slot }
  }

  /** Count one pool-host request that fell back to a direct connection. */
  recordDirectRequest(): void {
    this.#directRequests += 1
  }

  /** Total direct-fallback requests since process start (status bridge). */
  get directRequests(): number {
    return this.#directRequests
  }

  // -- selection (3.3) ---------------------------------------------------------

  isUsable(id: string, model: string): boolean {
    const health = this.#health.get(id)
    if (!health || health.state === 'dead') return false
    if (health.cooldownUntil > this.#now()) return false
    const ban = this.#bans.get(banKey(id, model))
    return ban?.state !== 'banned'
  }

  /**
   * Pick the exit for one upstream request. Pinned wins while usable (3.6);
   * the rotation pool then prefers session stickiness, health, fewer
   * cooldowns and lower latency with a same-tier shuffle. Pure; no IO.
   *
   * A pin to the local sentinel is answered BEFORE the rotation: "固定本机"
   * means every request egresses from this machine, so falling through to the
   * pool would silently ignore the operator's click. Null is the dispatcher's
   * documented direct path (3.3), not an error.
   *
   * A pin that IS set but unusable falls through to the rotation — and says so
   * through the pin-skip callback. The fall-through is correct: a pin is a
   * preference (see `pinnedStrict`), so the callback is what keeps an unusable
   * pin visible to the operator (AGENTS.md, egress row hygiene).
   */
  pick(session: string, model: string): string | null {
    if (this.pinnedId === LOCAL_EXIT_ID) return null
    const pinned = this.pinnedId
    if (pinned !== '' && this.isUsable(pinned, model)) {
      // Record the binding even on the pin path: the verdicts that arrive
      // AFTER the response (the adapter's 403 accounting — exitOfSession) need
      // to know which exit answered, and while a pin is set that is always the
      // pinned one. Without this binding a refusal lands with no exit to blame,
      // so the row is never benched.
      this.#sessionExit.set(session, pinned)
      return pinned
    }

    const chosen = this.#rotate(session, model)
    if (chosen !== null && pinned !== '') this.#notifyPinSkip(pinned, chosen)
    return chosen
  }

  /** Sticky-else-sorted selection over the usable rows (pick's second half). */
  #rotate(session: string, model: string): string | null {
    const last = this.#sessionExit.get(session)
    if (last !== undefined && this.isUsable(last, model)) return last

    const usable = [...this.#nodes.keys()].filter((id) => this.isUsable(id, model))
    if (usable.length === 0) return null
    const health = (id: string) => this.#health.get(id)!
    const node = (id: string) => this.#nodes.get(id)!
    usable.sort((left, right) => {
      const a = health(left)
      const b = health(right)
      // A demoted exit (upstream rejected it, no reserve to promote) is the
      // LAST resort: it still serves when nothing else is usable, but it never
      // outranks a live exit — that is what "keep the pool at its size instead
      // of draining" has to mean to be worth anything.
      const byDemoted = (this.#demoted.has(left) ? 1 : 0) - (this.#demoted.has(right) ? 1 : 0)
      if (byDemoted !== 0) return byDemoted
      const stateRank = (h: ExitHealth) => (h.state === 'ok' ? 0 : 1)
      const byState = stateRank(a) - stateRank(b)
      if (byState !== 0) return byState
      const byLimited = a.consecutiveLimited - b.consecutiveLimited
      if (byLimited !== 0) return byLimited
      const byLatency = node(left).latencyMs - node(right).latencyMs
      if (byLatency !== 0) return byLatency
      return Math.random() < 0.5 ? -1 : 1
    })
    const chosen = usable[0]
    if (chosen === undefined) return null
    this.#sessionExit.set(session, chosen)
    return chosen
  }

  /**
   * Register a callback fired when a set pin could not be used and another exit
   * carried the request. Fired on EVERY such pick; the runtime decides how
   * often to speak (it warns once per outage).
   */
  onPinnedSkip(callback: (pinned: string, used: string) => void): void {
    this.#pinSkipCallbacks.push(callback)
  }

  /** A watcher's failure must never fail a pick. */
  #notifyPinSkip(pinned: string, used: string): void {
    for (const callback of this.#pinSkipCallbacks) {
      try {
        callback(pinned, used)
      } catch {
        /* swallowed on purpose: routing is not the watcher's */
      }
    }
  }

  /** Drop the session's sticky exit (cooldown/dead/ban broke it). */
  breakStickySession(session: string): void {
    this.#sessionExit.delete(session)
  }

  // -- four-state machine (3.5) -------------------------------------------------

  /** Usable = not dead, not cooling, and not banned for every probe model —
   *  approximation: nodes banned for all their known models count as
   *  unusable; with no ban data they stay usable (they are only banned for
   *  specific models, which the caller's model already filters). */
  #isAvailable(id: string): boolean {
    const health = this.#health.get(id)
    if (!health || health.state === 'dead') return false
    if (health.cooldownUntil > this.#now()) return false
    // A node with at least one banned pairing and no healthy pairing for any
    // model it serves is effectively exhausted. Track by distinct models:
    const nodeModels = new Set<string>()
    let allBanned = true
    let sawBan = false
    for (const [key, ban] of this.#bans) {
      if (!key.startsWith(`${id}\u0000`)) continue
      const model = key.slice(id.length + 1)
      nodeModels.add(model)
      if (ban.state !== 'banned') allBanned = false
      else sawBan = true
    }
    if (sawBan && nodeModels.size > 0 && allBanned) return false
    return true
  }

  /** Count usable free-source nodes toward the refill thresholds. */
  availableFreeCount(): number {
    let count = 0
    for (const node of this.#nodes.values()) {
      if (node.source === 'free' && this.#isAvailable(node.id)) count += 1
    }
    return count
  }

  /** Determine the pool state over the free-source pool (3.5 thresholds). */
  state(): PoolState {
    if (this.#targetSize <= 0) return 'healthy'
    const available = this.availableFreeCount()
    const ratio = available / this.#targetSize
    if (ratio < 0.1) return 'emergency'
    if (ratio < 0.3) return 'critical'
    if (ratio < 0.95) return 'warning'
    return 'healthy'
  }

  /** Admission quota for a refill round: how many free nodes to accept.
   *  Bounded by BOTH the free target and the whole-pool capacity, so a free
   *  refill can never push the pool past `poolSize` (settings §5.1). */
  admissionQuota(): number {
    const freeRoom = Math.max(0, this.#targetSize - this.availableFreeCount())
    const poolRoom = Math.max(0, this.#poolSize - this.#nodes.size)
    return Math.min(freeRoom, poolRoom)
  }

  /**
   * Replace the worst free node to make room (3.5). A DEAD row ranks worse
   * than any live one — with no periodic probe a corpse only leaves through
   * this eviction or the strike threshold, and ranking by grade alone would
   * let refill evict a live C-grade exit while a dead S-grade corpse keeps its
   * slot. Ties keep the C-grade/oldest rule.
   */
  evictWorstFree(): boolean {
    let worst: ExitNode | null = null
    const deadRank = (node: ExitNode): number => (this.#health.get(node.id)?.state === 'dead' ? 1 : 0)
    for (const node of this.#nodes.values()) {
      if (node.source !== 'free') continue
      if (!worst) {
        worst = node
        continue
      }
      const byDeath = deadRank(node) - deadRank(worst)
      if (byDeath > 0) {
        worst = node
        continue
      }
      if (byDeath < 0) continue
      const byGrade = GRADE_RANK[node.quality] - GRADE_RANK[worst.quality]
      if (byGrade > 0 || (byGrade === 0 && node.addedAt < worst.addedAt)) worst = node
    }
    if (!worst) return false
    this.remove(worst.id)
    return true
  }

  /** Is the pool full for free-source admission? (pinned and non-free nodes
   *  never count against the target, 3.5/3.6.) */
  isFreeFull(): boolean {
    return this.freeCount() >= this.#targetSize
  }

  freeCount(): number {
    let count = 0
    for (const node of this.#nodes.values()) if (node.source === 'free') count += 1
    return count
  }

  // -- diagnostics ------------------------------------------------------------

  snapshot(): {
    state: PoolState
    total: number
    bySource: Record<ExitSource, number>
    availableFree: number
    pinned: string
  } {
    const bySource: Record<ExitSource, number> = { free: 0, manual: 0, subscription: 0, goproxy: 0 }
    for (const node of this.#nodes.values()) bySource[node.source] += 1
    return {
      state: this.state(),
      total: this.#nodes.size,
      bySource,
      availableFree: this.availableFreeCount(),
      pinned: this.pinnedId,
    }
  }

  list(): Array<ExitNode & { health: ExitHealth; bans: Array<{ model: string; ban: ModelBan }> }> {
    const out: Array<ExitNode & { health: ExitHealth; bans: Array<{ model: string; ban: ModelBan }> }> = []
    for (const [id, node] of this.#nodes) {
      const health = this.#health.get(id)!
      const bans: Array<{ model: string; ban: ModelBan }> = []
      for (const [key, ban] of this.#bans) {
        if (key.startsWith(`${id}\u0000`)) bans.push({ model: key.slice(id.length + 1), ban })
      }
      out.push({ ...node, health, bans })
    }
    return out
  }
}
