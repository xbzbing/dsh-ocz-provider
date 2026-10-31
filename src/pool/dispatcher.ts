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

import {
  DEFAULT_LOCAL_IP_FAMILY,
  localEgressConnectOptions,
  resolveLocalIpFamily,
  type InterfaceReader,
  type LocalEgressConnectOptions,
  type LocalIpFamily,
} from './local-family.ts'
import { parseManualProxy } from '../proxy-entry.ts'
import { ExitAgentCache } from './agent-cache.ts'
import { observeExitRequest } from './observer.ts'
import { mayEgressLocally } from './outcome.ts'
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
   * Node's built-in fetch reads a SEPARATE built-in undici instance's
   * dispatcher slot, which npm undici's setGlobalDispatcher never reaches, and
   * the OpenAI SDK inside pi-ai captures globalThis.fetch at call time — so
   * without this swap the pool's routing never applies to model traffic.
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
   * Session id the usage ledger files this response under. Separate from
   * {@link session}: that one is the routing stickiness key, while this one
   * prefers the HOST's session id (the adapter's own digest id is a fallback),
   * which is the id the workspace registry can resolve back to a project.
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
   *  composing the first token (1.7-2.7s measured), so this window is
   *  far looser than (a). Default 10s, test-injectable. */
  headersMs?: number
  /**
   * 本地出口兜底: may a request the pool cannot carry (no pickable exit, or
   * no proxy agent for one) still egress from this machine?
   *
   * Default FALSE — fail closed, because the whole point of an exit pool is
   * that the operator's own IP does not reach the upstream (the free lane
   * 403s this machine's CN egress). The settings switch
   * `localFallback` opts into fail-open instead. An EXPLICIT 固定本机 pin is
   * honoured either way: that is the operator asking for local egress, not the
   * pool falling back to it.
   */
  localFallback?: boolean
  /**
   * 本机出口协议族: which family the LOCAL egress agent dials with.
   * `auto` (default) prefers IPv6 when this machine has a routable one — the
   * free lane refuses this host's IPv4 and accepts its IPv6, and the official
   * client reaches the AAAA records — while `ipv4` / `ipv6` pin the family
   * outright. See local-family.ts for the measurements.
   */
  localIpFamily?: LocalIpFamily
  /**
   * Interface-table seam for the `auto` position (tests). Production leaves it
   * unset and reads `os.networkInterfaces()` inside local-family.ts, so a test
   * can decide whether "this machine has IPv6" without touching the host.
   */
  listInterfaces?: InterfaceReader
  /**
   * The layer this router is being chained ABOVE (a composing dispatcher's
   * previous downstream). Traffic the pool does not carry — other hosts, and
   * other lanes on the pool host — is handed to it instead of dialling
   * directly, so joining in front of another dispatcher keeps that
   * dispatcher's policy in force. Borrowed: this layer never closes it.
   */
  downstream?: Dispatcher
  /**
   * Judge one transport cut (pool/transport.ts). The runtime wires it so both
   * routing seams share one policy; a caller that leaves it unset treats a cut
   * as a strike.
   */
  onTransportCut?: (exitId: string) => void
  /** Log sink for routing decisions (diagnostics). */
  logger?: { warn(message: string): void }
}

/**
 * The error a request gets when the pool cannot carry it and local egress is
 * switched off. Fetch surfaces it as "fetch failed" with this as the cause;
 * the message is the only place the reason is stated, so it names the switch.
 */
export const NO_EXIT_MESSAGE = 'oc2dsh: no usable pool exit and the local-egress fallback is off (本地出口兜底已关闭)'

const DEFAULT_PROXY_HOSTS = ['opencode.ai']
const PROXY_PROTOCOL_PREFIX = /^[a-z0-9+.-]+:\/\//i

/**
 * The path prefixes this plugin's OWN traffic uses on the proxied hosts.
 *
 * Host matching alone is too coarse to mean "our traffic": one opencode.ai
 * serves the free lane this plugin's adapter calls, the paid/go lane (driven
 * by the separate `opencode-go` provider) and the usage-billing plugin's usage
 * poll — with host-only routing, foreign lane traffic rides the airport exits
 * and lands in this pool's request counters as zero-token requests.
 *
 * The default follows the adapter's `https://opencode.ai/inference/v1`
 * (adapter/catalog.ts `ZEN_BASE_URL`), and the segment-aware match below keeps
 * `/inference/v1` from taking `/inference/go/v1` — that isolation is what this
 * constant exists for. An operator whose profile still stores `/zen/v1` keeps
 * that explicit value and must add `/inference/v1` for the pool to carry the
 * lane again.
 *
 * Empty means "every path on the proxied hosts", which stays reachable for
 * anyone who wants the pool to carry the whole host.
 */
export const DEFAULT_PROXY_PATH_PREFIXES = ['/inference/v1']

/**
 * The effective path-prefix list: an absent OR EMPTY list means the default.
 * Same empty-equals-absent rule as {@link resolveProxyHosts}, and for the
 * same reason: the settings schema hands the runtime `[]` when the user never
 * touched the field, and an empty list read literally would exclude every
 * path — the mirror image of the empty-host-list rule below.
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
 * Empty must fall back exactly like absent: the settings layer hands the
 * runtime `proxyHosts: []` (that schema's own default), and an empty host set
 * read literally sends every model call down the direct branch while the
 * settings card keeps displaying its `opencode.ai` fallback — the pool would
 * report itself enabled and healthy and silently route nothing.
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

/**
 * The URI an exit is dialled with: its host:port under the row's CURRENT
 * protocol, never the scheme the id was typed with, so a relabelled row dials
 * what the listener speaks. `https` survives only for an https entry still
 * labelled http.
 */
export function exitProxyUri(exitId: string, protocol: 'http' | 'socks5'): string {
  const trimmed = exitId.trim()
  const parsed = parseManualProxy(trimmed)
  const authority = parsed !== null ? `${parsed.host}:${parsed.port}` : trimmed.replace(PROXY_PROTOCOL_PREFIX, '')
  if (protocol === 'socks5') return `socks5://${authority}`
  return /^https:\/\//i.test(trimmed) ? `https://${authority}` : `http://${authority}`
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
  #sentinelMs: number
  #headersMs: number
  /** 本地出口兜底 in force (docs §3.3); false = pool-only, never local. */
  #localFallback: boolean
  /** 本机出口协议族 in force (local-family.ts). */
  #localFamily: LocalIpFamily
  /** Interface-table seam for `auto`; undefined = the real interface table. */
  #listInterfaces?: InterfaceReader
  /**
   * Who judges a transport cut. Wired by the runtime to pool/transport.ts,
   * which can tell a mislabelled listener from a dead line; unset means "a cut
   * is a strike".
   */
  #onTransportCut?: (exitId: string) => void
  #logger?: { warn(message: string): void }
  /** Direct path for non-pool hosts and loopback. */
  #direct: Dispatcher
  /**
   * The LOCAL egress agent — separate from {@link #direct} on purpose. This is
   * the agent that carries the Zen lane when the pool does not (固定本机 pin,
   * 本地出口兜底), so it is the only one the family setting may touch:
   * `#direct` also carries loopback (the settings bridge, sing-box control) and
   * every other host some other plugin fetches, and flipping those to another
   * family is not what 本机使用 IPv4 还是 IPv6 promises.
   */
  #localEgress: Dispatcher
  /**
   * The layer this router was chained ABOVE (a composer's previous downstream),
   * borrowed rather than owned: traffic the pool does not carry is handed to
   * it, so joining in front of another dispatcher never deletes that
   * dispatcher's policy (dsh-http-proxy's proxy rules, for one). Null = dial
   * directly from this machine, which is what owning the slot means.
   */
  #elsewhere: Dispatcher
  /** Per-exit ProxyAgents (docs/ip-pool.md 2, exit multi-instance). */
  #agents: ExitAgentCache
  #closed = false

  /**
   * Closed/destroyed as PUBLIC fields, matching undici's own Dispatcher
   * surface. A component that COMPOSES dispatchers (dsh-privacy-gateway's
   * MaskingDispatcher) skips a downstream layer by reading exactly these two
   * properties; while they stayed private, a router disabled under a composer
   * stayed the chosen hop and every later request failed with "routing
   * dispatcher closed" instead of falling through to the layer below.
   */
  get closed(): boolean {
    return this.#closed
  }

  get destroyed(): boolean {
    return this.#closed
  }

  constructor(options: PoolRoutingOptions) {
    this.#pool = options.pool
    this.#undici = options.undici
    this.#proxyHosts = new Set(resolveProxyHosts(options.proxyHosts))
    this.#proxyPathPrefixes = resolveProxyPathPrefixes(options.proxyPathPrefixes)
    // dsh-llm-proxy's measured keep-alive pitfall: the ProxyAgent's proxy-side
    // pool reuses silently-dead CONNECT tunnels; pipelining: 0 forces a fresh
    // tunnel per request.
    const seam = options.undici
    this.#agents = new ExitAgentCache(options.agentLruCap ?? 16, (uri) => new seam.ProxyAgent({
      uri,
      clientFactory: (_origin: URL | string, opts?: unknown) => new seam.Agent({ ...(opts as object), pipelining: 0 }),
    }))
    this.#sentinelMs = options.sentinelMs ?? 2_000
    // Window (b) must stay looser than the ADAPTER's own first-event budget,
    // not just looser than window (a): the adapter tolerates a slow first
    // token up to its configured first-event window (~30s), so a tighter
    // dispatcher deadline would retire exits that answer Zen in 1.3-2.0s —
    // turns the adapter would happily have waited out.
    this.#headersMs = options.headersMs ?? 30_000
    // Fail closed unless the caller opts in: a pool exists to keep this
    // machine's IP off the wire, so "no exit" must not silently mean "this
    // machine" (see PoolRoutingOptions.localFallback).
    this.#localFallback = options.localFallback === true
    this.#localFamily = resolveLocalIpFamily(options.localIpFamily ?? DEFAULT_LOCAL_IP_FAMILY)
    this.#listInterfaces = options.listInterfaces
    this.#onTransportCut = options.onTransportCut
    this.#logger = options.logger
    this.#direct = new options.undici.Agent()
    // Borrowed, never closed here: a layer we were chained above belongs to
    // whoever installed it.
    this.#elsewhere = options.downstream ?? this.#direct
    this.#localEgress = new options.undici.Agent({ connect: this.#localConnectOptions(this.#localFamily) })
  }

  /**
   * The connect options for one family position, through the injected
   * interface reader when a caller supplied one (the reader decides whether
   * `auto` prefers IPv6, so a test can pin either answer).
   */
  #localConnectOptions(family: LocalIpFamily): LocalEgressConnectOptions {
    return this.#listInterfaces === undefined
      ? localEgressConnectOptions(family)
      : localEgressConnectOptions(family, this.#listInterfaces)
  }

  /** Live re-apply of 本地出口兜底 (settings page, docs §3.3/§5.1). */
  setLocalFallback(value: boolean): void {
    this.#localFallback = value === true
  }

  /** 本地出口兜底 in force (diagnostics / status bridge). */
  get localFallback(): boolean {
    return this.#localFallback
  }

  /**
   * Live re-apply of 本机出口协议族 (settings page, local-family.ts).
   *
   * A family is a property of the socket, so the switch means a NEW agent; the
   * old one is closed after the swap, so requests already on it finish while
   * nothing new is dialled under the previous family. A no-op position does
   * not churn the socket pool — `auto` on an IPv4-only machine resolves to the
   * same empty options twice.
   */
  setLocalIpFamily(value: unknown): void {
    const family = resolveLocalIpFamily(value)
    const previous = this.#localConnectOptions(this.#localFamily)
    const next = this.#localConnectOptions(family)
    this.#localFamily = family
    if (previous.family === next.family && previous.lookup === next.lookup) return
    const dying = this.#localEgress
    this.#localEgress = new this.#undici.Agent({ connect: next })
    if (!this.#closed) void dying.close().catch(() => {})
  }

  /** 本机出口协议族 in force (diagnostics / status bridge). */
  get localIpFamily(): LocalIpFamily {
    return this.#localFamily
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
   * silently disable routing, while guessing "in" at worst sends one extra
   * request through an exit on a host the user explicitly opted into.
   */
  #inScope(path: string): boolean {
    if (path === '') return true
    return this.#proxyPathPrefixes.some((prefix) => matchesPathPrefix(path, prefix))
  }

  /**
   * Pool-host traffic that could not ride an exit (no pick, or no agent):
   * stamp the direct bucket so the stats modal's 直连兜底 row stays honest,
   * then dispatch from this machine. Only reachable with 本地出口兜底 ON (or an
   * explicit 固定本机 pin) — {@link #failClosed} covers the other case.
   *
   * Rides {@link #localEgress}, not {@link #direct}: this is the branch the
   * 本机出口协议族 setting governs, and it is the one the free lane sees as
   * "outside OpenCode" when it leaves over a refused IPv4 address.
   */
  #directFallback(context: RoutingContext, options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    context.exitId = DIRECT_EXIT_ID
    this.#pool.recordDirectRequest()
    return this.#localEgress.dispatch(options, handler)
  }

  /**
   * 本地出口兜底 is OFF and the pool cannot carry this request: fail the
   * dispatch instead of egressing from this machine.
   *
   * The error travels the same channel undici uses for a transport failure
   * (the closed-dispatcher branch below sets the precedent), so fetch rejects
   * with "fetch failed" and this message as its cause — the adapter's rotate
   * loop then retries the pool, finds nothing, and surfaces the failure.
   * Nothing is stamped and nothing is counted: 本机 did not carry it.
   */
  #failClosed(handler: Dispatcher.DispatchHandler): boolean {
    handler.onResponseError?.({} as Dispatcher.DispatchController, new Error(NO_EXIT_MESSAGE))
    return false
  }

  /**
   * The fallback decision shared by both "pool could not carry it" branches.
   * An explicit 固定本机 pin wins over the switch: `pick()` answers null for
   * it, but the operator asked for this machine, so the request rides direct.
   */
  #poolMissed(context: RoutingContext, options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    if (mayEgressLocally(this.#pool, this.#localFallback)) return this.#directFallback(context, options, handler)
    return this.#failClosed(handler)
  }

  /** The agent for one exit, dialling its current protocol (docs/ip-pool.md 2). */
  #agentFor(exitId: string): Dispatcher | null {
    const exit = this.#pool.get(exitId)
    if (!exit) return null
    try {
      return this.#agents.get(exitId, exitProxyUri(exit.id, exit.protocol))
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
      // branch when the host list does not cover the API host, so stamp the
      // 本机 bucket: the adapter then attributes that response's tokens to
      // "egressed locally" instead of dropping them into an invisible void.
      const context = routingContext.getStore()
      if (context !== undefined) context.exitId = LOCAL_EXIT_ID
      return this.#elsewhere.dispatch(options, handler)
    }
    if (!this.#inScope(dispatchRequestPath(options))) {
      // Right host, wrong lane: /inference/go/* (the separate opencode-go
      // provider and its usage poll) shares this host with our own
      // /inference/v1 traffic, and host-only routing would drag all of it
      // through the airport exits and into the request counters. Deliberately
      // NOT stamped as 本机 — this traffic is not ours to account — and not a
      // blind spot either: were a path change to exclude OUR calls, the
      // adapter's usage would still land in 本机 through attributeUsage's
      // default.
      return this.#elsewhere.dispatch(options, handler)
    }
    const context = routingContext.getStore() ?? {}
    const model = context.model ?? 'default'
    const session = context.session ?? 'default'
    const exitId = this.#pool.pick(session, model)
    if (exitId === null) {
      // Pool unusable (empty / all cooling): 本地出口兜底 decides between a
      // direct dispatch and a failed one (docs §3.3). Stamped + counted when
      // it does fall back: pool-host traffic that dodged the pool is exactly
      // what the stats modal's 直连兜底 row exists to surface.
      return this.#poolMissed(context, options, handler)
    }
    const agent = this.#agentFor(exitId)
    if (!agent) {
      // The row exists but its proxy agent could not be built: same question,
      // same answer — the pool cannot carry the request either way.
      return this.#poolMissed(context, options, handler)
    }
    // Stamp the attribution key for the adapter's usage accounting and book
    // the request lifecycle (begin at pick, end in the observer's terminals).
    context.exitId = exitId
    this.#pool.beginRequest(exitId)
    return agent.dispatch(options, observeExitRequest({
      pool: this.#pool,
      exitId,
      model,
      session,
      sentinelMs: this.#sentinelMs,
      headersMs: this.#headersMs,
      onTransportCut: this.#onTransportCut,
      logger: this.#logger,
    }, handler))
  }

  close(): Promise<void> {
    this.#closed = true
    const jobs = [this.#direct.close(), this.#localEgress.close(), ...this.#agents.agents().map((a) => a.close())]
    return Promise.all(jobs).then(() => undefined)
  }

  destroy(): Promise<void> {
    this.#closed = true
    const jobs = [this.#direct.destroy(), this.#localEgress.destroy(), ...this.#agents.agents().map((a) => a.destroy())]
    this.#agents.clear()
    return Promise.all(jobs).then(() => undefined)
  }
}
