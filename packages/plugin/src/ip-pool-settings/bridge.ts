/**
 * ip-pool settings bridge (docs/ip-pool.md §5.3) — the loopback-only
 * webServer route pair the settings card needs beyond the official settings
 * transport: reading live pool runtime state (/status) and driving probe
 * actions (/probe). Settings reads/writes ride the official apiproxy
 * settings.describe/mutate RPCs (rc.2 serves every registered namespace —
 * no allowlist), so unlike dsh-llm-proxy this bridge carries NO settings
 * proxy surface.
 *
 * Trust model copied from dsh-llm-proxy settings.js (validated on this
 * host): loopback socket + canonical loopback Host header + same-origin
 * browser request. Everything else 403s.
 */

import type { IpPoolRuntime } from '../ip-pool.ts'
import type { PoolState, ExitSource } from '../pool/pool.ts'
import { DIRECT_EXIT_ID, LOCAL_EXIT_ID, emptyTotals, usageTracker, type TokenTotals } from '../pool/usage.ts'
import type { UsageScope, UsageStore } from '../pool/usage-store.ts'

/** Bridge route prefix (same-origin, loopback-only). */
export const IP_POOL_BRIDGE_PREFIX = '/api/opencode2dsh/ip-pool'

/** Cap on JSON request bodies (a probe trigger is tiny). */
const MAX_JSON_BODY_BYTES = 16 * 1024

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
}

/**
 * One project as the 流量 tab groups it. Resolved at READ time from the host's
 * workspace registry (session id → workspace), never stored: the ledger keeps
 * session ids, and the registry is the authority on which project each one
 * belongs to (live request 2026-10-14: 按会话/项目记录流量).
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
  /** Cumulative decode window, the tok/s denominator. */
  outputMs: number
}

/** One session's row in the 流量 tab's top list. */
export interface UsageSessionView {
  id: string
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

/** The persisted-ledger view (live request 2026-10-14). */
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

export interface RefillView {
  admitted: number
  rejected: number
  fetched: number
  coarsePassed: number
  state: string
  at: number
  /** Live in-flight round progress (docs §5.3, 立即补充 feedback). */
  progress: { running: boolean; stage: 'fetch' | 'coarse' | 'admit' | 'idle'; sourcesDone: number; sourcesTotal: number; fetched: number; candidates: number; coarsePassed: number; coarseDone: number; admissions: number; admitted: number }
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
  /** Non-empty when the pool runs but the routing layer deferred to another
   *  dispatcher-level plugin (R1 coexistence policy). */
  deferredReason: string
  state: PoolState
  /**
   * Which population produced {@link state}. `free` = the documented 3.5
   * four-state machine over the free-source pool (only meaningful while the
   * free source is on); `pool` = the same thresholds applied to the whole
   * pool, used once the free source is disabled — a subscription/manual-only
   * profile otherwise stays on "emergency" forever (0 free nodes, live
   * observation 2026-10-12).
   */
  stateBasis: 'free' | 'pool'
  total: number
  bySource: Record<ExitSource, number>
  /** Usable FREE-source exits — a subset of availableTotal, not the pool total. */
  availableFree: number
  /** Usable exits across the whole pool, any source. */
  availableTotal: number
  targetSize: number
  /** Whole-pool capacity in force (settings `poolSize`, default 10). */
  poolSize: number
  /**
   * The pin in force. `local` marks the 本机 sentinel (every request egresses
   * from this machine), which is a pin without an exit id — the stats modal
   * renders 取消固定 on the local row from this flag alone.
   */
  pinned: { id: string; strict: boolean; local: boolean } | null
  proxyHosts: string[]
  /** Path prefixes on those hosts the pool carries (default `/zen/v1`); this
   *  is the scope that decides WHICH opencode.ai traffic the exits serve. */
  proxyPathPrefixes: string[]
  exits: ExitRowView[]
  prober: ProberView
  refill: RefillView | null
  subscription: SubscriptionView | null
  /** Pool-host requests that fell back to direct (empty pool / no agent) with
   *  the tokens attributed there — the stats modal's 直连兜底 chip. */
  direct: { requests: number; tokens: TokenTotals }
  /**
   * Model traffic that egressed from THIS machine instead of a pool exit:
   * hosts outside {@link proxyHosts} (including the empty-host-list case that
   * silently routed everything locally) plus the {@link direct} fallbacks.
   * Requests/tokens come from the usage tracker, so a response with no usage
   * event is not counted — the same basis as the per-exit token column.
   */
  local: { requests: number; tokens: TokenTotals; lastUsedAt: number }
  /** The persistent usage ledger (null when no store is wired). */
  usage: UsageView | null
  at: number
}

/**
 * The four-state thresholds (docs 3.5) applied to a usable/capacity ratio.
 * An empty population reads `warning`, never `emergency`: an enabled pool
 * whose exits have not landed yet (subscription still fetching) is not the
 * same failure as a pool that drained.
 */
function stateOfRatio(available: number, capacity: number): PoolState {
  if (capacity <= 0) return 'warning'
  const ratio = available / capacity
  if (ratio < 0.1) return 'emergency'
  if (ratio < 0.3) return 'critical'
  if (ratio < 0.95) return 'warning'
  return 'healthy'
}

/** Build the /status view over the live runtime (or a disabled stub). */
export function buildStatusView(
  runtime: IpPoolRuntime | null,
  pinnedStrict: boolean,
  proxyHosts: string[],
  options: {
    freeEnabled?: boolean
    proxyPathPrefixes?: string[]
    /** The persistent ledger (absent = a composition without one). */
    usage?: UsageStore
    /** Which population the per-exit/usage numbers report. */
    usageScope?: UsageScope
    projectOf?: ProjectResolver
    /** Process start, for the 本次重启 label. */
    runSince?: number
  } = {},
): PoolStatusView {
  const freeEnabled = options.freeEnabled ?? true
  const proxyPathPrefixes = options.proxyPathPrefixes ?? ['/zen/v1']
  const store = options.usage
  const scope: UsageScope = options.usageScope ?? 'total'
  /**
   * Per-exit numbers follow the scope switch: the ledger's persisted buckets
   * for 总览, the in-process tracker for 本次重启. A composition with no ledger
   * falls back to the tracker, which is exactly the pre-ledger behaviour.
   */
  const tokensOf = (id: string): TokenTotals => (store === undefined ? usageTracker.totals(id) : store.exitTotals(id, scope))
  /** 最后使用: the live dispatch stamp for 本次重启, the ledger's last recorded
   *  response for 总览 (a dispatch that produced no usage event never reached
   *  the ledger, so the two are not the same signal — the column says which). */
  const lastUsedOf = (id: string, live: number): number =>
    store === undefined || scope === 'run' ? live : store.exitLastUsedAt(id, 'total')
  const snapshot = runtime
    ? runtime.pool.snapshot()
    : { state: 'healthy' as PoolState, total: 0, bySource: { free: 0, manual: 0, subscription: 0, goproxy: 0 } as Record<ExitSource, number>, availableFree: 0, pinned: '' }
  const now = Date.now()
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
        bannedModels: entry.bans
          .filter((b) => b.ban.state !== 'ok')
          .map((b) => ({ model: b.model, state: b.ban.state as 'suspect' | 'banned', bannedAt: b.ban.bannedAt })),
        passive,
        requests: passive.ok + passive.limited + passive.refused + passive.dead + passive.transport,
        lastUsedAt: lastUsedOf(entry.id, activity.lastUsedAt),
        inFlight: activity.inFlight,
        demoted: runtime.pool.demoted(entry.id),
        tokens: tokensOf(entry.id),
      }
    })
    : []
  /**
   * Usable exits across the WHOLE pool, any source. `availableFree` is only
   * the free-source subset, so rendering it as a bare "可用 n/capacity"
   * reads as "nothing is usable" to anyone running subscription/manual
   * exits only — a live profile showed "可用 0/20 · 手填 1 · 订阅 12" while
   * 7 of those 12 were healthy.
   */
  const availableTotal = exits.filter((exit) => exit.state === 'ok').length
  const stateBasis: 'free' | 'pool' = freeEnabled ? 'free' : 'pool'
  return {
    enabled: runtime !== null && runtime.installer.enabled,
    deferredReason: runtime !== null && !runtime.installer.enabled
      ? (runtime.installer as unknown as { deferredReason?: string }).deferredReason ?? ''
      : '',
    state: stateBasis === 'free' ? snapshot.state : stateOfRatio(availableTotal, snapshot.total),
    stateBasis,
    total: snapshot.total,
    bySource: snapshot.bySource,
    availableFree: snapshot.availableFree,
    availableTotal,
    targetSize: runtime ? runtime.pool.targetSize : 20,
    poolSize: runtime ? runtime.pool.poolSize : 10,
    pinned: snapshot.pinned !== ''
      ? { id: snapshot.pinned, strict: pinnedStrict, local: snapshot.pinned === LOCAL_EXIT_ID }
      : null,
    proxyHosts,
    proxyPathPrefixes,
    exits,
    prober: runtime
      ? runtime.prober.stats
      : { queued: 0, inFlight: 0, enqueued: 0, completed: 0 },
    refill: runtime?.refill
      ? { ...runtime.refill.lastRound, progress: runtime.refill.progress }
      : null,
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
    local: localView(store, scope),
    usage: buildUsageView(store, scope, {
      projectOf: options.projectOf,
      runSince: options.runSince,
    }),
    at: now,
  }
}

/**
 * Merge the two local-egress buckets into the modal's 本机 row.
 *
 * `direct` = pool-host traffic that should have used an exit but could not;
 * `local` = hosts outside the proxy set (and every request while routing is
 * off). Both left this machine, so the row sums them, while the request
 * count prefers the pool's dispatch counter when it has one: that counter
 * sees the request even when no usage event follows (an aborted turn), which
 * a token-only bucket would silently drop.
 */
function localView(store: UsageStore | undefined, scope: UsageScope): { requests: number; tokens: TokenTotals; lastUsedAt: number } {
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
  }
}

/**
 * Project the ledger for the 流量 tab. `scope` picks the population; `total`
 * (all-time) always rides along, because the footer is pinned to 总览 while the
 * modal follows the switch.
 *
 * Sessions are listed heaviest-first and their projects resolved through the
 * registry seam — a session whose project cannot be resolved keeps a null
 * project rather than a fabricated one.
 */
export function buildUsageView(
  store: UsageStore | undefined,
  scope: UsageScope,
  options: { projectOf?: ProjectResolver; runSince?: number; sessionLimit?: number } = {},
): UsageView | null {
  if (store === undefined) return null
  const sessionLimit = options.sessionLimit ?? 20
  const sessions: UsageSessionView[] = store.sessions(scope, sessionLimit).map((row) => ({
    id: row.id,
    label: row.label,
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

// -- request plumbing -----------------------------------------------------------

/** Whether a socket address is a literal loopback peer. */
function isLoopbackAddress(address: unknown): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Whether a normalized hostname is a literal loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Parse one bare Host authority; undefined for anything non-canonical. */
function parseAuthority(authority: string): { url: URL } | undefined {
  if (authority.trim() !== authority) return undefined
  const match = authority.startsWith('[')
    ? /^\[[^\]]+\](?::([0-9]+))?$/.exec(authority)
    : /^[^:@/?#\s]+(?::([0-9]+))?$/.exec(authority)
  if (match === null) return undefined
  try {
    const url = new URL('http://' + authority)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    const rawPort = match[1]
    if (rawPort !== undefined && (String(Number(rawPort)) !== rawPort || Number(rawPort) > 65535)) return undefined
    return { url }
  } catch {
    return undefined
  }
}

/** Browser same-origin marker (loopback hosts are always same-origin here). */
function isSameOriginRequest(request: { headers: Record<string, string | string[] | undefined> }, hostUrl: URL): boolean {
  const headers = request.headers
  const site = headers['sec-fetch-site']
  if (site === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(String(origin)).host === hostUrl.host
  } catch {
    return false
  }
}

/** Hot-path trust decision: loopback socket + canonical Host + same-origin. */
export function isTrustedBridgeRequest(request: {
  socket?: { remoteAddress?: unknown }
  headers: Record<string, string | string[] | undefined>
}): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  const parsed = parseAuthority(host)
  if (parsed === undefined || parsed.url.host.toLowerCase() !== host.toLowerCase()) return false
  if (!isSameOriginRequest(request, parsed.url)) return false
  return isLoopbackHostname(parsed.url.hostname)
}

// -- handlers + routes -----------------------------------------------------------

/** One JSON response. */
function writeJson(res: { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: AsyncIterable<Buffer> & { [Symbol.asyncIterator](): AsyncIterator<Buffer> }): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(Buffer.from(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

export type BridgeResult = { ok: true; value: unknown } | { ok: false; code: string; message: string }

/**
 * Persist one pin value into the plugin's own settings namespace. Returns
 * false when the profile cannot be written (read-only, or no settings service
 * in this composition) — the caller then keeps the live-only pin, which is
 * the honest degradation: the click works now and the modal says it is not
 * persisted. An empty value UNSETS the field so the schema default applies
 * instead of a stored empty string.
 */
export type WritePin = (value: string) => Promise<boolean>

/** deps over the live runtime + the current settings value (probe model etc.). */
export interface BridgeHandlers {
  status(): Promise<BridgeResult>
  probe(body: { scope?: unknown; exitId?: unknown }): Promise<BridgeResult>
  /** Selectable probe models (docs §5.2 探活模型 dropdown): S3 static list
   *  first, then the live Zen catalog entries the runtime resolved. */
  models(): Promise<BridgeResult>
  /**
   * One row action from the exit tables (live request 2026-10-14): pin,
   * pin-local, unpin, or rotate. The pin family writes `pinnedExitId` and
   * applies live; `rotate` hands the row to the candidate list — a reserve
   * takes its slot, or it sinks to the tail when there is nothing to promote.
   * It was called `remove` until the operator pointed out that nothing is
   * deleted: the row is rotated out.
   */
  exit(body: { action?: unknown; exitId?: unknown }): Promise<BridgeResult>
}

/** Live-catalog seam for the models() dropdown rows (index.ts injects the
 *  plugin's ModelCatalog when one is running; undefined = static list only). */
export type ListLiveModels = () => string[]

/** Build the bridge handlers over the runtime + current settings. */
export function makeBridgeHandlers(
  runtime: () => IpPoolRuntime | null,
  settings: () => {
    pinnedStrict: boolean
    proxyHosts: string[]
    proxyPathPrefixes?: string[]
    freeEnabled?: boolean
    /** 'total' (ledger) or 'run' (this process) — the card's switch. */
    usageScope?: UsageScope
  },
  deps: {
    listLiveModels?: ListLiveModels
    writePin?: WritePin
    /** The persistent ledger (absent = a composition without one). */
    usage?: UsageStore
    /** Session id → project, resolved from the host's workspace registry. */
    projectOf?: ProjectResolver
    /** Process start, for the 本次重启 label. */
    runSince?: () => number
  } = {},
): BridgeHandlers {
  return {
    async status() {
      const current = settings()
      return {
        ok: true,
        value: buildStatusView(runtime(), current.pinnedStrict, current.proxyHosts, {
          freeEnabled: current.freeEnabled,
          proxyPathPrefixes: current.proxyPathPrefixes,
          usage: deps.usage,
          usageScope: current.usageScope,
          projectOf: deps.projectOf,
          runSince: deps.runSince?.(),
        }),
      }
    },
    async probe(body) {
      const rt = runtime()
      if (rt === null) return { ok: false, code: 'pool-disabled', message: 'ip pool is not running (enabled off)' }
      const scope = body.scope
      if (scope === 'all') {
        const queued = await rt.probeAll()
        return { ok: true, value: { queued } }
      }
      if (scope === 'refill') {
        await rt.refillNow()
        return { ok: true, value: { refilled: true } }
      }
      if (scope === 'subscription') {
        // docs §5.2 订阅「立即刷新」. This scope used to be missing, so the
        // card's button sent 'refill' (free sources) instead and
        // IpPoolRuntime.refreshSubscriptions() had no caller at all — a
        // subscription could never be re-pulled on demand, only by its timer.
        await rt.refreshSubscriptions()
        return { ok: true, value: { refreshed: true } }
      }
      if (scope === 'exit') {
        const exitId = typeof body.exitId === 'string' ? body.exitId : ''
        if (!rt.pool.has(exitId)) return { ok: false, code: 'unknown-exit', message: `exit "${exitId}" is not in the pool` }
        const count = await rt.probeExit(exitId)
        return { ok: true, value: { queued: count } }
      }
      return { ok: false, code: 'settings-rejected', message: "probe scope must be 'all', 'exit', 'refill' or 'subscription'" }
    },
    async models() {
      const { staticFreeModels } = await import('../adapter/catalog.ts')
      const rows: Array<{ id: string; verified: boolean }> = staticFreeModels.map((id) => ({ id, verified: true }))
      const seen = new Set(staticFreeModels)
      for (const id of deps.listLiveModels?.() ?? []) {
        if (typeof id !== 'string' || id === '' || seen.has(id)) continue
        seen.add(id)
        rows.push({ id, verified: false })
      }
      return { ok: true, value: { models: rows } }
    },
    async exit(body) {
      const rt = runtime()
      if (rt === null) return { ok: false, code: 'pool-disabled', message: 'ip pool is not running (enabled off)' }
      const action = body.action

      if (action === 'pin' || action === 'pin-local' || action === 'unpin') {
        // An empty value is the unpin spelling, `pin-local` the 本机 row's
        // button: keeping the sentinel host-side means the browser bundle never
        // has to spell it (and cannot drift from it).
        const raw = action === 'unpin'
          ? ''
          : action === 'pin-local'
            ? LOCAL_EXIT_ID
            : (typeof body.exitId === 'string' ? body.exitId.trim() : '')
        if (raw !== '' && raw !== LOCAL_EXIT_ID && !rt.pool.has(raw)) {
          return { ok: false, code: 'unknown-exit', message: `exit "${raw}" is not in the pool` }
        }
        // Persist first, then apply: the settings commit lands on the same
        // pool through reconfigure(), and applying it here as well makes the
        // click effective even when the profile is read-only (the modal then
        // reports `persisted: false` instead of pretending).
        let persisted = false
        try {
          persisted = await deps.writePin?.(raw) ?? false
        } catch {
          persisted = false
        }
        if (raw === '') rt.pool.unpin()
        else if (raw === LOCAL_EXIT_ID) rt.pool.pinLocal()
        else rt.pool.pin(raw)
        return { ok: true, value: { pinned: raw, local: raw === LOCAL_EXIT_ID, persisted } }
      }

      if (action === 'rotate') {
        const exitId = typeof body.exitId === 'string' ? body.exitId : ''
        if (!rt.pool.has(exitId)) {
          return { ok: false, code: 'unknown-exit', message: `exit "${exitId}" is not in the pool` }
        }
        // Rotating the pinned exit has to unpin first: the pin lives in the
        // settings, and a later commit would otherwise re-pin a row that is no
        // longer in the pool — and re-admit it as a manual row when the id
        // happens to parse as an address (subscription ids do).
        if (rt.pool.pinnedId === exitId) {
          try {
            await deps.writePin?.('')
          } catch { /* live unpin below still holds */ }
          rt.pool.unpin()
        }
        // The subscription layer owns the candidate list: it promotes the
        // next-fastest reserve, or keeps the exit at the pool tail when the
        // reserve is empty (both documented as "rotate → refill, else sink").
        const promoted = await rt.subscriptions?.replaceExit(exitId).catch(() => false) ?? false
        if (!promoted && rt.pool.has(exitId)) {
          // A running onboarding/trim holds the rebuild mutex and replaceExit()
          // answers false without consulting the reserve. Sinking the row then
          // would violate the request ("refill first, sink only when there is
          // nothing to promote"), so say busy instead and leave the row alone.
          if (rt.subscriptions?.busy === true) {
            return { ok: true, value: { rotated: false, promoted: false, busy: true, remaining: rt.pool.snapshot().total } }
          }
          // No onboarder at all (no subscription round ran in this process):
          // the row still has to stop outranking live exits.
          rt.pool.demoteToTail(exitId)
        }
        return { ok: true, value: { rotated: true, promoted, remaining: rt.pool.snapshot().total } }
      }

      return { ok: false, code: 'settings-rejected', message: "exit action must be 'pin', 'pin-local', 'unpin' or 'rotate'" }
    },
  }
}

/** Bridge route registration input (exact paths for webServer.register). */
export interface BridgeRoute {
  kind: 'exact'
  path: string
  handler: (req: never, res: never) => void | Promise<void>
}

/** Build the loopback-guarded routes. The route bodies are host-shaped
 *  (node:http req/res); typed loosely because the plugin never touches the
 *  webServer service itself — index.ts does. */
export function makeBridgeRoutes(
  handlers: BridgeHandlers,
  deps: {
    guard?: (req: unknown) => boolean
  } = {},
): Array<{ kind: 'exact'; path: string; handler: (req: never, res: never) => void | Promise<void> }> {
  const guard = deps.guard ?? isTrustedBridgeRequest
  const check = (req: { method?: string } & Parameters<typeof isTrustedBridgeRequest>[0], res: { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }): boolean => {
    if (!guard(req)) {
      writeJson(res, 403, { error: 'forbidden' })
      return false
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method not allowed: ' + (req.method ?? '') })
      return false
    }
    return true
  }
  return [
    {
      kind: 'exact',
      path: `${IP_POOL_BRIDGE_PREFIX}/status`,
      handler: async (req, res) => {
        if (!check(req as never, res as never)) return
        const result = await handlers.status()
        writeJson(res as never, 200, result)
      },
    },
    {
      kind: 'exact',
      path: `${IP_POOL_BRIDGE_PREFIX}/models`,
      handler: async (req, res) => {
        if (!check(req as never, res as never)) return
        const result = await handlers.models()
        writeJson(res as never, 200, result)
      },
    },
    {
      kind: 'exact',
      path: `${IP_POOL_BRIDGE_PREFIX}/probe`,
      handler: async (req, res) => {
        if (!check(req as never, res as never)) return
        let body: unknown
        try {
          body = await readJsonBody(req as never)
        } catch {
          body = undefined
        }
        if (body === undefined || typeof body !== 'object' || body === null) {
          writeJson(res as never, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
          return
        }
        const result = await handlers.probe(body as { scope?: unknown; exitId?: unknown })
        writeJson(res as never, 200, result)
      },
    },
    {
      kind: 'exact',
      path: `${IP_POOL_BRIDGE_PREFIX}/exit`,
      handler: async (req, res) => {
        if (!check(req as never, res as never)) return
        let body: unknown
        try {
          body = await readJsonBody(req as never)
        } catch {
          body = undefined
        }
        if (body === undefined || typeof body !== 'object' || body === null) {
          writeJson(res as never, 400, { ok: false, code: 'settings-rejected', message: 'unreadable JSON body' })
          return
        }
        const result = await handlers.exit(body as { action?: unknown; exitId?: unknown })
        writeJson(res as never, 200, result)
      },
    },
  ]
}
