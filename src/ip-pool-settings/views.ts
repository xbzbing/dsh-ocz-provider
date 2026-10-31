/**
 * The bridge's read model (docs/ip-pool.md §5.3): the /status view built over
 * the live pool runtime and the persistent usage ledger. Pure projections —
 * no request handling lives here.
 */

import type { IpPoolRuntime } from '../ip-pool.ts'
import { resolveLocalIpFamily, type LocalIpFamily } from '../pool/local-family.ts'
import { opencodeUserAgent } from '../adapter/ids.ts'
import type { ExitSource } from '../pool/pool.ts'
import { DIRECT_EXIT_ID, LOCAL_EXIT_ID, emptyTotals, usageTracker, type TokenTotals } from '../pool/usage.ts'
import { localDay, type UsageScope, type UsageStore } from '../pool/usage-store.ts'
import type { SessionTitleMap } from '../pool/session-titles.ts'
import { DEFAULT_PROXY_PATH_PREFIXES } from '../pool/dispatcher.ts'

/**
 * Sessions listed in the 流量 tab. Shared by the status prefetch and the view
 * builder so both slice the ledger to the same population — the title join
 * must ask for exactly the ids the table will render.
 */
export const USAGE_SESSION_LIMIT = 20

// -- status view ---------------------------------------------------------------

export interface ExitRowView {
  id: string
  source: ExitSource
  protocol: string
  pinned: boolean
  exitIP: string
  exitLocation: string
  latencyMs: number
  quality: string
  state: 'unknown' | 'ok' | 'dead'
  cooling: boolean
  cooldownUntil: number
  consecutiveLimited: number
  /** Why the exit is benched beyond a cooldown ('' = nothing to say):
   *  `'abusive'` = OpenCode flagged this exit's IP (pool/pool.ts ExitNote). */
  note: string
  bannedModels: Array<{ model: string; state: 'suspect' | 'banned'; bannedAt: number }>
  /** Passive-signal counters from real requests (docs §4.3, IP-6). */
  passive: { ok: number; limited: number; refused: number; dead: number; transport: number }
  /** Sum of the passive buckets — total classified requests through this exit
   *  (the exit-stats modal's sort key). */
  requests: number
  /** Epoch ms of the most recent dispatch through this exit (0 = never). */
  lastUsedAt: number
  /** Requests currently in flight through this exit. */
  inFlight: number
  /** Rejected by the upstream lane with no reserve to promote: kept as the
   *  last resort, ranked last by pick() and listed last here. */
  demoted: boolean
  /** Token totals attributed to this exit by the adapter (process lifetime). */
  tokens: TokenTotals
  /**
   * Recent output speed (tok/s): the process tracker's rolling 3-minute
   * window (pool/usage.ts), NOT the lifetime ledger — only the recent window
   * answers "how fast is this exit now". 0 = nothing timed in the window; the
   * UI hides the number.
   */
  speed: number
}

/**
 * One project as the 流量 tab groups it. Resolved at READ time from the host's
 * workspace registry (session id → workspace), never stored: the ledger keeps
 * session ids and the registry is the authority on which project each one
 * belongs to (docs §5.6).
 */
export interface UsageProjectView {
  id: string
  title: string
  path: string
}

/** One day's row in the 流量 tab. */
export interface UsageDayView {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string
  requests: number
  /** input + output + cache read/write (the all-in figure the UI shows). */
  tokens: number
  outputTokens: number
  /** Cumulative decode window (ms); diagnostic only — the tok/s display
   *  comes from the recent window, not from these totals. */
  outputMs: number
}

/** One session's row in the 流量 tab's top list. */
export interface UsageSessionView {
  id: string
  /**
   * The row's name: the HOST's session title when the host has one (the same
   * name the sidebar shows), falling back to the ledger's recorded label —
   * the first user turn, truncated — for sessions the host cannot title.
   */
  label: string
  requests: number
  tokens: number
  outputTokens: number
  outputMs: number
  firstAt: number
  lastAt: number
  /** The project this session belongs to (null when unresolvable). */
  project: UsageProjectView | null
}

/** The persisted-ledger view. */
export interface UsageView {
  /** Which population the scoped numbers came from. */
  scope: UsageScope
  /** Day-bucket retention in force (90). */
  retentionDays: number
  /** When this process started — the run scope's origin. */
  runSince: number
  /** All-time persisted totals: the footer's 总览 figure, scope-independent. */
  total: TokenTotals
  /** Totals for the scope being shown. */
  scoped: TokenTotals
  /**
   * Recent output speed (tok/s) over the process tracker's rolling 3-minute
   * window. A live gauge: the same number under every scope, because the
   * window only exists in this process.
   */
  recentSpeed: number
  /** Day buckets, oldest first (the UI charts the tail of this). */
  days: UsageDayView[]
  /** Heaviest sessions first. */
  sessions: UsageSessionView[]
  /** Sessions rolled up by project, heaviest first. */
  projects: Array<UsageProjectView & { requests: number; tokens: number; sessions: number; lastAt: number }>
  /** How much the ledger is holding (the tab's footnote). */
  stored: { sessions: number; days: number; exits: number }
}

/** Session id → the project it belongs to (host workspace registry seam). */
export type ProjectResolver = (sessionId: string) => UsageProjectView | null

export interface ProberView {
  queued: number
  inFlight: number
  enqueued: number
  completed: number
}

export interface SubscriptionView {
  /** URL count only — the URLs themselves never ride the bridge (§5.1 redaction). */
  urlCount: number
  pendingConversion: number
  convertedAdmitted: number
  plaintextAdmitted: number
  lastFetch: number
  lastError: string
}

export interface PoolStatusView {
  enabled: boolean
  /**
   * Whether the pool runtime exists at all. False means the pool was never
   * assembled (its wiring threw, or the entry is still starting) — a different
   * fault from a live runtime whose routing deferred, and the only signal that
   * separates them: `deferredReason` stays empty in both when the installer is
   * never reached.
   */
  runtimeReady: boolean
  /** Non-empty when the pool runs but the routing layer deferred to another
   *  dispatcher-level plugin (R1 coexistence policy). */
  deferredReason: string
  total: number
  bySource: Record<ExitSource, number>
  /** Usable exits across the whole pool, any source. */
  availableTotal: number
  /** Whole-pool capacity in force (settings `poolSize`, default 10). */
  poolSize: number
  /**
   * The pin in force. `local` marks the 本机 sentinel (every request egresses
   * from this machine), which is a pin without an exit id — the stats modal
   * renders 取消固定 on the local row from this flag alone.
   */
  pinned: { id: string; strict: boolean; local: boolean } | null
  /**
   * Why the pin above is not carrying traffic right now (null = it is, or
   * nothing is pinned). The rotation deliberately falls through to another exit
   * when the pinned row is unusable — that is what 主力+备胎 means — so the
   * status must say so, or a dead pin reads healthy (AGENTS.md egress-row
   * hygiene).
   */
  pinnedSkip: 'dead' | 'cooling' | null
  proxyHosts: string[]
  /** Path prefixes on those hosts the pool carries (default `/inference/v1`);
   *  this is the scope that decides WHICH opencode.ai traffic the exits serve. */
  proxyPathPrefixes: string[]
  exits: ExitRowView[]
  prober: ProberView
  subscription: SubscriptionView | null
  /** Pool-host requests that fell back to direct (empty pool / no agent) with
   *  the tokens attributed there — the stats modal's 直连兜底 chip. */
  direct: { requests: number; tokens: TokenTotals }
  /**
   * Model traffic that egressed from THIS machine instead of a pool exit:
   * hosts outside {@link proxyHosts} (and every request while routing is off)
   * plus the {@link direct} fallbacks. Requests/tokens come from the usage
   * tracker, so a response with no usage event is not counted — the same
   * basis as the per-exit token column.
   */
  local: { requests: number; tokens: TokenTotals; lastUsedAt: number; speed: number }
  /** The persistent usage ledger (null when no store is wired). */
  usage: UsageView | null
  /** The UA the next formal Zen request will actually use. */
  zenUserAgent: string
  /**
   * Pool-wide recent output speed (tok/s): every timed bucket in the
   * process tracker's rolling 3-minute window — the modal summary chip and
   * the footer both read this.
   */
  recentSpeed: number
  /**
   * Today's all-in token figure (input + output + cache) from the ledger's
   * day bucket — THE footer's token figure in every variant (docs §5.5).
   * Falls back to the process tracker's own totals when no ledger is wired;
   * 0 when nothing was recorded today.
   */
  todayTokens: number
  /**
   * 本地出口兜底 in force on the running router (docs §3.3): false = a pool
   * miss fails the request instead of egressing from this machine, which is
   * what the modal's 直连兜底 row is quiet about. Optional so a client bundle
   * can still read a host snapshot that predates the field.
   */
  localFallback?: boolean
  /**
   * 本机出口协议族 in force on the running router (local-family.ts): 'auto'
   * prefers IPv6 where this machine has a routable one, while 'ipv4'/'ipv6'
   * pin the family. Optional for the same reason as `localFallback`.
   */
  localIpFamily?: LocalIpFamily
  at: number
}

/** Build the /status view over the live runtime (or a disabled stub). */
export function buildStatusView(
  runtime: IpPoolRuntime | null,
  pinnedStrict: boolean,
  proxyHosts: string[],
  options: {
    proxyPathPrefixes?: string[]
    /** The persistent ledger (absent = a composition without one). */
    usage?: UsageStore
    /** Which population the per-exit/usage numbers report. */
    usageScope?: UsageScope
    /** 本地出口兜底 as configured (the running router's value wins below). */
    localFallback?: boolean
    /** 本机出口协议族 as configured (the running router's value wins below). */
    localIpFamily?: string
    projectOf?: ProjectResolver
    /** Host session titles for the top-session rows (read-time join). */
    sessionTitles?: SessionTitleMap
    /** Process start, for the 本次重启 label. */
    runSince?: number
    /**
     * Wall clock for `at`/`todayTokens`, defaulting to `Date.now()`. Tests
     * pin it so a ledger bucket recorded under a frozen clock still reads as
     * "today" — otherwise the assertion breaks the day real time passes it.
     */
    now?: number
  } = {},
): PoolStatusView {
  const proxyPathPrefixes = options.proxyPathPrefixes ?? [...DEFAULT_PROXY_PATH_PREFIXES]
  const store = options.usage
  const scope: UsageScope = options.usageScope ?? 'total'
  /**
   * Per-exit numbers follow the scope switch: the ledger's persisted buckets
   * for 总览, the in-process tracker for 本次重启. A composition with no ledger
   * falls back to the tracker.
   */
  const tokensOf = (id: string): TokenTotals => (store === undefined ? usageTracker.totals(id) : store.exitTotals(id, scope))
  /**
   * Recent speed always reads the PROCESS tracker's rolling window: the
   * lifetime ledger cannot answer "how fast is it now", and the window has no
   * scope dimension.
   */
  const tracker = store === undefined ? usageTracker : store.run
  /** 最后使用: the live dispatch stamp for 本次重启, the ledger's last recorded
   *  response for 总览 (a dispatch that produced no usage event never reached
   *  the ledger, so the two are not the same signal — the column says which). */
  const lastUsedOf = (id: string, live: number): number =>
    store === undefined || scope === 'run' ? live : store.exitLastUsedAt(id, 'total')
  const snapshot = runtime
    ? runtime.pool.snapshot()
    : { total: 0, bySource: { manual: 0, subscription: 0, goproxy: 0 } as Record<ExitSource, number>, pinned: '' }
  const now = options.now ?? Date.now()
  const exits: ExitRowView[] = runtime
    ? runtime.pool.list().map((entry) => {
      const passive = runtime.pool.passiveStats(entry.id)
      const activity = runtime.pool.activity(entry.id)
      return {
        id: entry.id,
        source: entry.source,
        protocol: entry.protocol,
        pinned: entry.pinned,
        exitIP: entry.exitIP,
        exitLocation: entry.exitLocation,
        latencyMs: entry.latencyMs,
        quality: entry.quality,
        state: entry.health.state,
        cooling: entry.health.cooldownUntil > now,
        cooldownUntil: entry.health.cooldownUntil,
        consecutiveLimited: entry.health.consecutiveLimited,
        note: entry.health.note,
        bannedModels: entry.bans
          .filter((b) => b.ban.state !== 'ok')
          .map((b) => ({ model: b.model, state: b.ban.state as 'suspect' | 'banned', bannedAt: b.ban.bannedAt })),
        passive,
        requests: passive.ok + passive.limited + passive.refused + passive.dead + passive.transport,
        lastUsedAt: lastUsedOf(entry.id, activity.lastUsedAt),
        inFlight: activity.inFlight,
        demoted: runtime.pool.demoted(entry.id),
        tokens: tokensOf(entry.id),
        speed: tracker.speed(entry.id),
      }
    })
    : []
  /** Usable exits across the whole pool, any source. */
  const availableTotal = exits.filter((exit) => exit.state === 'ok').length
  /**
   * Is the pin actually carrying traffic? Only the two states that stop
   * `isUsable()` on their own are reported: dead and a live cooldown. A
   * (exit, model) ban cannot be answered here — it depends on the model the
   * next request picks — and inventing an answer would be worse than silence.
   */
  const pinnedRow = snapshot.pinned !== '' && snapshot.pinned !== LOCAL_EXIT_ID
    ? exits.find((exit) => exit.id === snapshot.pinned)
    : undefined
  const pinnedSkip: PoolStatusView['pinnedSkip'] = pinnedRow === undefined
    ? null
    : pinnedRow.state === 'dead'
      ? 'dead'
      : pinnedRow.cooling ? 'cooling' : null
  return {
    enabled: runtime !== null && runtime.installer.enabled,
    runtimeReady: runtime !== null,
    deferredReason: runtime !== null && !runtime.installer.enabled
      ? (runtime.installer as unknown as { deferredReason?: string }).deferredReason ?? ''
      : '',
    total: snapshot.total,
    bySource: snapshot.bySource,
    availableTotal,
    poolSize: runtime ? runtime.pool.poolSize : 10,
    pinned: snapshot.pinned !== ''
      ? { id: snapshot.pinned, strict: pinnedStrict, local: snapshot.pinned === LOCAL_EXIT_ID }
      : null,
    pinnedSkip,
    proxyHosts,
    proxyPathPrefixes,
    exits,
    prober: runtime
      ? runtime.prober.stats
      : { queued: 0, inFlight: 0, enqueued: 0, completed: 0 },
    subscription: runtime?.subscriptions
      ? {
        urlCount: runtime.subscriptions.urlCount,
        pendingConversion: runtime.subscriptions.state.pendingConversion.length,
        convertedAdmitted: runtime.subscriptions.state.convertedAdmitted,
        plaintextAdmitted: runtime.subscriptions.state.plaintextAdmitted,
        lastFetch: runtime.subscriptions.state.lastFetch,
        lastError: runtime.subscriptions.state.lastError,
      }
      : null,
    direct: {
      requests: runtime ? runtime.pool.directRequests : 0,
      tokens: runtime ? tokensOf(DIRECT_EXIT_ID) : emptyTotals(),
    },
    local: localView(store, scope, tracker),
    usage: buildUsageView(store, scope, {
      projectOf: options.projectOf,
      sessionTitles: options.sessionTitles,
      runSince: options.runSince,
    }),
    zenUserAgent: opencodeUserAgent(),
    recentSpeed: tracker.speedAll(),
    todayTokens: todayTokensOf(store, now),
    // Report the ROUTER's policy, not the setting plus a guess: the two can
    // differ for a moment (install deferred, R1) and the card must not claim
    // "no local egress" while traffic is still leaving from this machine.
    localFallback: runtime?.installer?.localFallback ?? options.localFallback ?? false,
    // Same reporting rule: what the sockets are dialling with, not what the
    // form happens to say (the two differ for a moment while install defers).
    localIpFamily: resolveLocalIpFamily(runtime?.installer?.localIpFamily ?? options.localIpFamily),
    at: now,
  }
}

/** The all-in token figure the UI shows (input + output + cache read/write). */
function grandTotal(totals: TokenTotals): number {
  return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
}

/**
 * Today's all-in tokens: the ledger's local-calendar-day bucket when one is
 * wired (scope-independent — "today" is a day, not a scope), the process
 * tracker's totals otherwise, so a composition without a ledger still shows
 * what this machine spent today.
 */
function todayTokensOf(store: UsageStore | undefined, now: number): number {
  if (store === undefined) {
    let sum = 0
    for (const id of usageTracker.exits()) sum += grandTotal(usageTracker.totals(id))
    return sum
  }
  const key = localDay(now)
  const row = store.days('total').find((entry) => entry.day === key)
  return row === undefined ? 0 : grandTotal(row.totals)
}

/**
 * Merge the two local-egress buckets into the modal's 本机 row.
 *
 * `direct` = pool-host traffic that should have used an exit but could not;
 * `local` = hosts outside the proxy set (and every request while routing is
 * off). Both left this machine, so the row sums them — requests and tokens on
 * the same recorded-usage-event basis as the per-exit column (a response with
 * no usage event is not counted).
 */
function localView(
  store: UsageStore | undefined,
  scope: UsageScope,
  tracker: { speedFor(ids: readonly string[]): number },
): { requests: number; tokens: TokenTotals; lastUsedAt: number; speed: number } {
  const read = (id: string): TokenTotals => (store === undefined ? usageTracker.totals(id) : store.exitTotals(id, scope))
  const lastUsed = (id: string): number =>
    store === undefined || scope === 'run' ? usageTracker.lastUsedAt(id) : store.exitLastUsedAt(id, 'total')
  const direct = read(DIRECT_EXIT_ID)
  const local = read(LOCAL_EXIT_ID)
  const tokens: TokenTotals = {
    requests: direct.requests + local.requests,
    inputTokens: direct.inputTokens + local.inputTokens,
    outputTokens: direct.outputTokens + local.outputTokens,
    cacheReadTokens: direct.cacheReadTokens + local.cacheReadTokens,
    cacheWriteTokens: direct.cacheWriteTokens + local.cacheWriteTokens,
    totalTokens: direct.totalTokens + local.totalTokens,
    outputMs: direct.outputMs + local.outputMs,
  }
  return {
    requests: tokens.requests,
    tokens,
    lastUsedAt: Math.max(lastUsed(DIRECT_EXIT_ID), lastUsed(LOCAL_EXIT_ID)),
    speed: tracker.speedFor([DIRECT_EXIT_ID, LOCAL_EXIT_ID]),
  }
}

/**
 * Project the ledger for the 流量 tab. `scope` picks the population; `total`
 * (all-time) always rides along, because the footer is pinned to 总览 while the
 * modal follows the switch.
 *
 * Sessions are listed heaviest-first and their projects resolved through the
 * registry seam — a session whose project cannot be resolved keeps a null
 * project rather than a fabricated one. The row NAME prefers the host's own
 * session title; the recorded first-prompt fragment is only the fallback for
 * sessions the host cannot title (docs §5.5).
 */
export function buildUsageView(
  store: UsageStore | undefined,
  scope: UsageScope,
  options: { projectOf?: ProjectResolver; sessionTitles?: SessionTitleMap; runSince?: number; sessionLimit?: number } = {},
): UsageView | null {
  if (store === undefined) return null
  const sessionLimit = options.sessionLimit ?? USAGE_SESSION_LIMIT
  const sessions: UsageSessionView[] = store.sessions(scope, sessionLimit).map((row) => ({
    id: row.id,
    label: options.sessionTitles?.get(row.id) || row.label,
    requests: row.totals.requests,
    tokens: row.totals.inputTokens + row.totals.outputTokens + row.totals.cacheReadTokens + row.totals.cacheWriteTokens,
    outputTokens: row.totals.outputTokens,
    outputMs: row.totals.outputMs,
    firstAt: row.firstAt,
    lastAt: row.lastAt,
    project: options.projectOf?.(row.id) ?? null,
  }))

  const byProject = new Map<string, UsageView['projects'][number]>()
  for (const session of sessions) {
    if (session.project === null) continue
    const row = byProject.get(session.project.id) ?? {
      ...session.project,
      requests: 0,
      tokens: 0,
      sessions: 0,
      lastAt: 0,
    }
    row.requests += session.requests
    row.tokens += session.tokens
    row.sessions += 1
    row.lastAt = Math.max(row.lastAt, session.lastAt)
    byProject.set(session.project.id, row)
  }

  return {
    scope,
    retentionDays: store.retentionDays,
    runSince: options.runSince ?? 0,
    total: store.totals(),
    scoped: scope === 'run' ? store.runTotals() : store.totals(),
    recentSpeed: store.run.speedAll(),
    days: store.days(scope).map((row) => ({
      day: row.day,
      requests: row.totals.requests,
      tokens: row.totals.inputTokens + row.totals.outputTokens + row.totals.cacheReadTokens + row.totals.cacheWriteTokens,
      outputTokens: row.totals.outputTokens,
      outputMs: row.totals.outputMs,
    })),
    sessions,
    projects: [...byProject.values()].sort((left, right) => right.tokens - left.tokens),
    stored: store.size(),
  }
}
