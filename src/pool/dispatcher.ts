/**
 * PoolRoutingDispatcher — the undici global-dispatcher layer for the exit
 * pool (docs/ip-pool.md section 2).
 *
 * Shape copied from dsh-llm-proxy's RoutingDispatcher (verified there
 * against the same host); selection logic differs: instead of a static
 * host set, every request consults ExitPool.pick() (pinned-first, session
 * stickiness, rotation over two-tier health).
 *
 * One routing decision per request, synchronous and IO-free (pick is pure).
 * Failures are NOT retried here — the 429/403 rotation loop (3.4) is the
 * pi-ai-callable layer's job; this dispatcher only routes. It implements
 * the undici Dispatcher subset `fetch` uses (dispatch/close/destroy),
 * same contract dsh-llm-proxy validated.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { Agent, ProxyAgent, type Dispatcher } from 'undici'

import type { ExitPool } from './pool.ts'
import { DIRECT_EXIT_ID, LOCAL_EXIT_ID } from './usage.ts'

/** Structural seam over npm undici so tests can inject fakes. */
export interface UndiciSeam {
  Agent: typeof Agent
  ProxyAgent: typeof ProxyAgent
  setGlobalDispatcher(dispatcher: Dispatcher): unknown
  getGlobalDispatcher(): Dispatcher
  /**
   * The module's own fetch (honors THIS module's global-dispatcher state).
   * Live-observed 2026-09-09 (docs/ip-pool.md R2): Node's built-in fetch
   * reads a SEPARATE built-in undici instance's dispatcher slot —
   * setGlobalDispatcher on the npm module never reaches it, and the OpenAI
   * SDK inside pi-ai captures globalThis.fetch at call time, so without
   * this swap the pool's routing silently never applies to model traffic.
   * Typed loosely on purpose: npm undici's Request/Response element types
   * never structurally match Node's built-ins across versions.
   */
  fetch?: (input: unknown, init?: unknown) => Promise<unknown>
}

export interface RoutingContext {
  /** Model id for the in-flight call (two-tier health needs it, 3.3). */
  model?: string
  /** Inbound session id (stickiness key, 3.3). */
  session?: string
  /**
   * Session id the usage ledger files this response under (live request
   * 2026-10-14: 按会话/项目记录流量). Separate from {@link session}: that one is
   * the routing stickiness key, while this one prefers the HOST's session id
   * (the adapter's own digest id is a fallback), which is the id the workspace
   * registry can resolve back to a project.
   */
  usageSession?: string
  /** Readable label for that session (its first user turn, truncated). */
  usageLabel?: string
  /**
   * The exit this request was routed through, stamped at pick() (exit-stats
   * surface). The adapter reads it back when the response's `usage` lands so
   * tokens attribute to the exit that actually carried the request;
   * DIRECT_EXIT_ID marks a pool-host request that fell back to a direct
   * connection. Stays unset for hosts outside the pool (out of scope).
   */
  exitId?: string
}

/** Per-request routing context (docs/ip-pool.md 3.3): pi-ai builds the body
 *  and dispatches on separate layers with no model channel between them, so
 *  the adapter sets this at stream() entry and the dispatcher reads it. */
export const routingContext = new AsyncLocalStorage<RoutingContext>()

export interface PoolRoutingOptions {
  pool: ExitPool
  undici: UndiciSeam
  /** Hosts whose traffic goes through the pool; everything else is direct. */
  proxyHosts?: string[]
  /**
   * Path prefixes ON those hosts that the pool carries (default
   * `/inference/v1` = this plugin's own lane). Empty means every path.
   */
  proxyPathPrefixes?: string[]
  /** Per-exit ProxyAgent cache LRU cap (connection setup is lazy). */
  agentLruCap?: number
  /** Response-silence sentinel, window (a): dispatch -> first callback (docs §4.3; default 2s, test-injectable). */
  sentinelMs?: number
  /** Sentinel window (b): tunnel established -> response headers. The tunnel
   *  standing proves exit liveness; the rest of the wait is the LLM upstream
   *  composing the first token (measured 1.7-2.7s live), so this window is
   *  far looser than (a). Default 10s, test-injectable. */
  headersMs?: number
  /** Log sink for routing decisions (diagnostics). */
  logger?: { warn(message: string): void }
}

const DEFAULT_PROXY_HOSTS = ['opencode.ai']
const PROXY_PROTOCOL_PREFIX = /^[a-z0-9+.-]+:\/\//i

/**
 * The path prefixes this plugin's OWN traffic uses on the proxied hosts.
 *
 * Host matching alone is too coarse to mean "our traffic": one opencode.ai
 * serves the free lane this plugin's adapter calls, the paid/go lane (driven
 * by the separate `opencode-go` provider) and the usage-billing plugin's
 * usage poll. Live 2026-10-13 with host-only routing: 77 `POST
 * /zen/go/v1/chat/completions` in 6.3 minutes (≈12/min) were proxied through
 * the airport exits and counted as requests with zero tokens (tokens are
 * attributed only for traffic that flows through our adapter), so "I stopped
 * using oc2dsh models" and "the request count keeps climbing" were both
 * true — and paid-lane traffic was egressing through free airport exits by
 * accident.
 *
 * The lane moved on 2026-10-14: the adapter now calls
 * `https://opencode.ai/inference/v1` (adapter/catalog.ts `ZEN_BASE_URL`) and
 * the go lane sits at `/inference/go/v1`, so the default follows the adapter —
 * `/inference/v1` does not take `/inference/go/v1` (segment-aware match
 * below), which keeps the isolation this constant exists for. An operator whose
 * profile still stores the old `/zen/v1` keeps their explicit value; the
 * settings card shows it, and `/inference/v1` must be added there for the pool
 * to carry the lane again.
 *
 * Empty means "every path on the proxied hosts" (the old behaviour), which
 * stays reachable for anyone who wants the pool to carry the whole host.
 */
export const DEFAULT_PROXY_PATH_PREFIXES = ['/inference/v1']

/**
 * The effective path-prefix list: an absent OR EMPTY list means the default.
 * Same empty-equals-absent rule as {@link resolveProxyHosts}, and for the
 * same reason: the settings schema hands the runtime `[]` when the user never
 * touched the field, and an empty list read literally would exclude every
 * path — the mirror image of the empty-host-list bug below.
 */
export function resolveProxyPathPrefixes(prefixes?: readonly string[] | null): string[] {
  const normalized = (prefixes ?? [])
    .map((prefix) => normalizePathPrefix(prefix))
    .filter((prefix) => prefix !== '')
  return normalized.length > 0 ? normalized : [...DEFAULT_PROXY_PATH_PREFIXES]
}

/** 'inference/v1/', '/inference/v1?x=1' -> '/inference/v1'; an unusable entry -> '' (dropped). */
export function normalizePathPrefix(prefix: string): string {
  const trimmed = (prefix ?? '').trim().split('?')[0]?.trim() ?? ''
  if (trimmed === '') return ''
  const rooted = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return rooted.length > 1 ? rooted.replace(/\/+$/, '') : rooted
}

/** Segment-aware prefix match: '/inference/v1' takes '/inference/v1' and
 *  '/inference/v1/chat/completions?x=1', never '/inference/v10' or
 *  '/inference/go/v1'. */
export function matchesPathPrefix(path: string, prefix: string): boolean {
  const clean = path.split('?')[0] ?? ''
  if (prefix === '/') return true
  return clean === prefix || clean.startsWith(`${prefix}/`)
}

/** The request path from either dispatch shape. undici's fetch builds
 *  `{origin, path}` (lib/web/fetch/index.js: `url.pathname + url.search`); a
 *  raw DispatchOptions or a Request-shaped argument carries the rest. */
export function dispatchRequestPath(options: Dispatcher.DispatchOptions): string {
  const direct = (options as unknown as { path?: unknown }).path
  if (typeof direct === 'string') return direct
  const candidate = (options as unknown as { url?: unknown }).url
  const text = typeof candidate === 'string'
    ? candidate
    : candidate !== null && typeof candidate === 'object' && 'url' in candidate
      ? String((candidate as { url: unknown }).url)
      : ''
  if (text === '') return ''
  try {
    const url = new URL(text)
    return `${url.pathname}${url.search}`
  } catch {
    return ''
  }
}

/**
 * The effective proxied-host set: an absent OR EMPTY list means the default.
 *
 * Empty must fall back exactly like absent. Live-observed 2026-10-13: the
 * settings layer hands the runtime `proxyHosts: []` (that schema's own
 * default), and the old `?? DEFAULT_PROXY_HOSTS` guard waved it straight
 * through as an EMPTY host set — so every model call took the direct branch
 * while the settings card kept displaying `opencode.ai` (its display
 * fallback), i.e. the pool reported itself enabled and healthy and silently
 * routed nothing.
 */
export function resolveProxyHosts(hosts?: readonly string[] | null): string[] {
  const normalized = (hosts ?? [])
    .map((host) => normalizeHost(host))
    .filter((host) => host !== '')
  return normalized.length > 0 ? normalized : DEFAULT_PROXY_HOSTS.map((host) => normalizeHost(host))
}

/** 'host:port' -> 'host' (bracket-aware) for host matching. */
export function normalizeHost(host: string): string {
  if (!host) return ''
  let value = host.trim().toLowerCase()
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname
    } catch {
      /* fall through to the regex strip */
    }
  }
  return value.replace(/:\d+$/, '').replace(/^\[(.+)\]$/, '$1')
}

export function isLoopback(host: string): boolean {
  const normalized = normalizeHost(host)
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

/** Map an exit address to a ProxyAgent URI ('h:1' -> 'http://h:1'). */
export function exitProxyUri(exitId: string, protocol: 'http' | 'socks5'): string {
  const scheme = protocol === 'socks5' ? 'socks5' : 'http'
  return PROXY_PROTOCOL_PREFIX.test(exitId) ? exitId : `${scheme}://${exitId}`
}

/**
 * The undici Dispatcher surface `fetch` actually calls (the subset
 * dsh-llm-proxy's RoutingDispatcher implements — full `Dispatcher` carries
 * 20+ stream helpers we never hit through fetch).
 */
export interface RoutingDispatcherSurface {
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean
  close(): Promise<void>
  destroy(): Promise<void>
}

export class PoolRoutingDispatcher implements RoutingDispatcherSurface {
  #pool: ExitPool
  #undici: UndiciSeam
  #proxyHosts: Set<string>
  #proxyPathPrefixes: string[]
  #agentLruCap: number
  #sentinelMs: number
  #headersMs: number
  #logger?: { warn(message: string): void }
  /** Direct path for non-pool hosts and loopback. */
  #direct: Dispatcher
  /** LRU of per-exit ProxyAgents (docs/ip-pool.md 2, exit multi-instance). */
  #agents = new Map<string, Dispatcher>()
  #agentsOrder: string[] = []
  #closed = false

  constructor(options: PoolRoutingOptions) {
    this.#pool = options.pool
    this.#undici = options.undici
    this.#proxyHosts = new Set(resolveProxyHosts(options.proxyHosts))
    this.#proxyPathPrefixes = resolveProxyPathPrefixes(options.proxyPathPrefixes)
    this.#agentLruCap = options.agentLruCap ?? 16
    this.#sentinelMs = options.sentinelMs ?? 2_000
    // Window (b) must stay looser than the ADAPTER's own first-event budget,
    // not just looser than window (a): the adapter tolerates a slow first
    // token up to its configured first-event window (~30s), so a tighter
    // dispatcher deadline retires exits for turns the adapter would happily
    // have waited out. Measured on a live profile: exits that answer Zen in
    // 1.3-2.0s via curl were all struck dead by this path.
    this.#headersMs = options.headersMs ?? 30_000
    this.#logger = options.logger
    this.#direct = new options.undici.Agent()
  }

  /** Live re-apply of the proxied-host list (settings page, docs §5.1). */
  setProxyHosts(hosts: string[] | undefined): void {
    this.#proxyHosts = new Set(resolveProxyHosts(hosts))
  }

  /** The proxied-host set as configured (diagnostics / status bridge). */
  get proxyHosts(): readonly string[] {
    return [...this.#proxyHosts]
  }

  /** Live re-apply of the path scope (settings page, docs §5.1). */
  setProxyPathPrefixes(prefixes: string[] | undefined): void {
    this.#proxyPathPrefixes = resolveProxyPathPrefixes(prefixes)
  }

  /** The path scope in force (diagnostics / status bridge). */
  get proxyPathPrefixes(): readonly string[] {
    return [...this.#proxyPathPrefixes]
  }

  /**
   * Does this request belong to the pool's configured scope?
   *
   * An EMPTY path means the caller never exposed one (a raw dispatch, a future
   * undici shape): that counts as IN scope. Guessing "out" there would
   * silently disable routing — the failure class this file has already been
   * bitten by twice (empty host list, deferred dispatcher) — while guessing
   * "in" at worst sends one extra request through an exit on a host the user
   * explicitly opted into.
   */
  #inScope(path: string): boolean {
    if (path === '') return true
    return this.#proxyPathPrefixes.some((prefix) => matchesPathPrefix(path, prefix))
  }

  /**
   * Pool-host traffic that could not ride an exit (no pick, or no agent):
   * stamp the direct bucket so the stats modal's 直连兜底 row stays honest,
   * then dispatch direct — never fail closed (3.3).
   */
  #directFallback(context: RoutingContext, options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    context.exitId = DIRECT_EXIT_ID
    this.#pool.recordDirectRequest()
    return this.#direct.dispatch(options, handler)
  }

  /** The agent for one exit, LRU-capped (docs/ip-pool.md 2). */
  #agentFor(exitId: string): Dispatcher | null {
    const cached = this.#agents.get(exitId)
    if (cached) {
      const index = this.#agentsOrder.indexOf(exitId)
      if (index >= 0) this.#agentsOrder.splice(index, 1)
      this.#agentsOrder.push(exitId)
      return cached
    }
    const exit = this.#pool.get(exitId)
    if (!exit) return null
    try {
      // dsh-llm-proxy's measured keep-alive pitfall (routing-dispatcher.js):
      // the ProxyAgent's proxy-side pool reuses silently-dead CONNECT
      // tunnels; pipelining: 0 forces a fresh tunnel per request.
      const seam = this.#undici
      const agent = new seam.ProxyAgent({
        uri: exitProxyUri(exit.id, exit.protocol),
        clientFactory: (origin: URL | string, opts?: unknown) =>
          new seam.Agent({ ...(opts as object), pipelining: 0 }),
      })
      this.#agents.set(exitId, agent)
      this.#agentsOrder.push(exitId)
      if (this.#agentsOrder.length > this.#agentLruCap) {
        const evict = this.#agentsOrder.shift()
        if (evict !== undefined) {
          const old = this.#agents.get(evict)
          this.#agents.delete(evict)
          void old?.destroy().catch(() => {})
        }
      }
      return agent
    } catch (err) {
      this.#logger?.warn(`oc2dsh: failed to build proxy agent for ${exitId}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    if (this.#closed) {
      handler.onResponseError?.({} as Dispatcher.DispatchController, new Error('oc2dsh: routing dispatcher closed'))
      return false
    }
    const origin = String(options.origin ?? '')
    const host = normalizeHost(origin)
    // Loopback is the host talking to itself (bridge, sing-box control):
    // never counted, never proxied.
    if (isLoopback(host)) {
      return this.#direct.dispatch(options, handler)
    }
    if (!this.#proxyHosts.has(host)) {
      // Outside the pool by configuration. Model traffic still reaches this
      // branch when the host list does not cover the API host (the empty
      // list bug, live 2026-10-13), so stamp the 本机 bucket: the adapter
      // then attributes that response's tokens to "egressed locally"
      // instead of dropping them into an invisible void.
      const context = routingContext.getStore()
      if (context !== undefined) context.exitId = LOCAL_EXIT_ID
      return this.#direct.dispatch(options, handler)
    }
    if (!this.#inScope(dispatchRequestPath(options))) {
      // Right host, wrong lane: /inference/go/* (the separate opencode-go
      // provider and its usage poll) shares this host with our own
      // /inference/v1 traffic, and host-only routing used to drag all of it
      // through the airport exits and into the request counters. Deliberately
      // NOT stamped as 本机 — this traffic is not ours to account — and not a
      // blind spot either: were a path change to exclude OUR calls, the
      // adapter's usage would still land in 本机 through attributeUsage's
      // default.
      return this.#direct.dispatch(options, handler)
    }
    const context = routingContext.getStore() ?? {}
    const model = context.model ?? 'default'
    const session = context.session ?? 'default'
    const exitId = this.#pool.pick(session, model)
    if (exitId === null) {
      // Pool unusable (empty / all cooling): direct, never fail closed (3.3).
      // Still stamped + counted: pool-host traffic that dodged the pool is
      // exactly what the stats modal's 直连兜底 row exists to surface.
      return this.#directFallback(context, options, handler)
    }
    const agent = this.#agentFor(exitId)
    if (!agent) {
      return this.#directFallback(context, options, handler)
    }
    // Stamp the attribution key for the adapter's usage accounting and book
    // the request lifecycle (begin at pick, end in the observer's terminals).
    context.exitId = exitId
    this.#pool.beginRequest(exitId)
    return agent.dispatch(options, this.#observe(exitId, model, session, handler))
  }

  /**
   * Wrap the downstream handler with the passive-signal observer
   * (docs/ip-pool.md §4.2 rule table, §4.3 被动): the real request's own
   * outcome feeds the two-tier health — free liveness data no probe spends
   * quota on. Body bytes stream through untouched; only the response start
   * line and terminal transport errors are read.
   *
   * Forwarding discipline (measured against undici 8.10 on this host): the
   * fetch handler's methods live on a prototype with private state, so a
   * spread would strip them and Object.create delegation would re-enter
   * them with the wrong `this`. The wrapper is a fresh plain object that
   * forwards every DispatchHandler callback to the original with the
   * original as `this` — the same shape undici's own wrappers use.
   *
   * Response-silence sentinel: undici's Pool fires NONE of the handler
   * callbacks (not even onResponseError) when a proxy CONNECT fails at the
   * connection stage — the failure surfaces only as a fetch rejection (and
   * an APIConnectionError/"Connection error." upstream). Without a fallback
   * the passive signal is blind exactly when a dead exit needs to be evicted
   * (live repro: 10.255.255.1:9999 blackhole, seen:[] callbacks). So the
   * wrapper arms a timer at dispatch time; any handler callback disarms it,
   * and silence past the deadline counts as a transport failure (dead strike
   * + session reroute). The sentinel never aborts the request itself — fetch
   * and pi-ai own their own timeouts.
   */
  #observe(exitId: string, model: string, session: string, handler: Dispatcher.DispatchHandler): Dispatcher.DispatchHandler {
    const pool = this.#pool
    const forward = (method: keyof Dispatcher.DispatchHandler, args: unknown[]): void => {
      const fn = handler[method]
      if (typeof fn === 'function') (fn as (...a: unknown[]) => void).apply(handler, args)
    }
    let classified = false
    // Request-lifecycle bookkeeping (exit-stats): exactly one end per
    // dispatch, whichever terminal lands first — response end, transport
    // error, upgrade, or the silence sentinel firing with no callback at all.
    let ended = false
    const end = (): void => {
      if (ended) return
      ended = true
      pool.endRequest(exitId)
    }
    const classify = (statusCode: number): void => {
      if (classified) return
      classified = true
      const verdict = pool.recordPassive(exitId, statusCode, model)
      // A degraded sticky exit must not keep the session pinned to it.
      if (verdict !== 'ok') pool.rerouteSession(session)
    }
    // The most recent controller the wrapper has seen (undici hands a fresh
    // one to each handler callback; abort must go to the live one).
    let liveController: { abort?(reason: Error): void } | null = null
    const classifyTransport = (why: string): void => {
      if (classified) return
      classified = true
      pool.recordPassiveTransport(exitId)
      pool.rerouteSession(session)
      end()
      // One strike retires the exit (`markDeadStrike`), and until the periodic
      // due-probe re-tests it (docs §4.6 deadRetryMs) `isUsable()` hides it
      // from pick(), so a false positive used to be permanent. Log WHY: the
      // two silence windows and a real transport error mean very different
      // things, and without this line the three are indistinguishable after
      // the fact — a live profile lost all 14 exits and nothing said why.
      this.#logger?.warn(`oc2dsh: exit ${exitId} marked dead (${why})`)
      // Live-observed (2026-09-07, muse via 7897): after the tunnel stands a
      // dead-behind-the-tunnel exit answers NOTHING — no headers, no
      // onResponseError — and neither fetch nor pi-ai owns a body-silence
      // timeout, so the request hangs forever (the turn never finished; the
      // stop button's abort never reached it). The sentinel therefore does
      // more than bookkeeping: it tears the dispatch down BOTH ways — abort
      // the controller when we have one, and when the blackhole path never
      // handed us a single callback (no controller exists) synthesize the
      // response-error the handler owes, so fetch rejects at once, pi-ai
      // turns that into an error event, and the adapter's rotate loop gets
      // to move the session to a live exit.
      const reason = new Error('oc2dsh: exit response silence')
      if (typeof handler.onResponseError === 'function') {
        ;(handler.onResponseError as (c: unknown, e: Error) => void).call(handler, liveController ?? ({} as never), reason)
      }
      liveController?.abort?.(reason)
    }
    // Silence deadline, in two windows: (a) dispatch -> first callback (dead
    // CONNECT fires NONE, undici 8.10 measured); (b) tunnel established ->
    // response headers (onRequestStart disarms window (a) only). Window (b)
    // must be MUCH looser than (a): the tunnel standing proves the exit is
    // alive, and the remaining wait is the LLM upstream composing the first
    // token — measured live 2026-09-09 (mihomo 7897 -> SJ exit -> zen):
    // headers landed 1.7-2.7s after onRequestStart, so a 2s window (b) kills
    // healthy streams (live repro: status 200 with TTFB 2.66s struck dead
    // at 2s). Body pacing stays uncovered (a live stream disarms at
    // onResponseStart); (a) keeps sitting under the host's 1-5s retry
    // cadence and the coarse-screen latency gate (3s).
    const armSentinel = (): void => {
      clearTimeout(sentinel)
      const window = sawRequestStart ? this.#headersMs : this.#sentinelMs
      sentinel = setTimeout(
        () => classifyTransport(sawRequestStart
          ? `no response headers within ${this.#headersMs}ms of request start`
          : `no request start within ${this.#sentinelMs}ms of dispatch (proxy CONNECT never completed)`),
        window,
      )
      sentinel.unref?.()
    }
    let sawRequestStart = false
    let sentinel: NodeJS.Timeout | undefined = undefined
    armSentinel()
    const disarm = (): void => {
      clearTimeout(sentinel)
    }
    return {
      onRequestStart: (controller, context) => {
        liveController = controller
        // window (a) ends; window (b) begins: headers must still arrive,
        // on the looser upstream-composition budget (see armSentinel)
        sawRequestStart = true
        armSentinel()
        forward('onRequestStart', [controller, context])
      },
      onRequestUpgrade: (controller, statusCode, headers, socket) => {
        liveController = controller
        disarm()
        end()
        forward('onRequestUpgrade', [controller, statusCode, headers, socket])
      },
      onResponseStart: (controller, statusCode, headers, statusMessage) => {
        liveController = controller
        disarm()
        classify(statusCode)
        forward('onResponseStart', [controller, statusCode, headers, statusMessage])
      },
      onResponseData: (controller, chunk) => {
        liveController = controller
        forward('onResponseData', [controller, chunk])
      },
      onResponseEnd: (controller, trailers) => {
        liveController = controller
        disarm()
        end()
        forward('onResponseEnd', [controller, trailers])
      },
      onResponseError: (controller, error) => {
        liveController = controller
        disarm()
        classifyTransport(`transport error: ${error instanceof Error ? error.message : String(error)}`)
        end()
        forward('onResponseError', [controller, error])
      },
      onResponseStarted: () => {
        disarm()
        forward('onResponseStarted', [])
      },
      onBodySent: (chunk) => forward('onBodySent', [chunk]),
      onRequestSent: () => forward('onRequestSent', []),
    }
  }

  close(): Promise<void> {
    this.#closed = true
    const jobs = [this.#direct.close(), ...[...this.#agents.values()].map((a) => a.close())]
    return Promise.all(jobs).then(() => undefined)
  }

  destroy(): Promise<void> {
    this.#closed = true
    const jobs = [this.#direct.destroy(), ...[...this.#agents.values()].map((a) => a.destroy())]
    this.#agents.clear()
    this.#agentsOrder = []
    return Promise.all(jobs).then(() => undefined)
  }
}
