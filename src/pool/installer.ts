/**
 * Installer — global-dispatcher install/swap/restore (docs/ip-pool.md 2, the
 * makeInstaller pattern from dsh-llm-proxy, adapted):
 *
 *  - installs a PoolRoutingDispatcher only while routing is enabled;
 *  - JOINS below a composing dispatcher (dsh-privacy-gateway's
 *    MaskingDispatcher) instead of replacing it, so masking and exit routing
 *    run on the same request — see #classifyOccupant;
 *  - remembers the pre-existing dispatcher and restores it on disable and
 *    on plugin dispose, but never rewrites a slot another layer has taken
 *    over (another dispatcher plugin — e.g. dsh-llm-proxy — must not stay
 *    short-circuited by us, and a layer that wrapped us must not be deleted);
 *  - disables by closing ours and, only when the slot is still ours,
 *    restoring the saved predecessor.
 *
 * The rotate-retry loop (3.4) is intentionally NOT here: this layer only
 * routes; the adapter-level loop owns failure semantics.
 */

import type { Dispatcher } from 'undici'

import { PoolRoutingDispatcher, resolveProxyHosts, resolveProxyPathPrefixes, type RoutingDispatcherSurface, type UndiciSeam } from './dispatcher.ts'
import { resolveLocalIpFamily, type InterfaceReader, type LocalIpFamily } from './local-family.ts'
import type { ExitPool } from './pool.ts'

/** The setter accepts the full Dispatcher; our router exposes the subset
 *  fetch exercises (RoutingDispatcherSurface — same duck-typing contract
 *  dsh-llm-proxy validated on this host). */
type InstallableDispatcher = Parameters<UndiciSeam['setGlobalDispatcher']>[0]

export interface InstallerDeps {
  pool: ExitPool
  undici: UndiciSeam
  proxyHosts?: string[]
  /** Path prefixes on the proxied hosts this plugin's own traffic uses. */
  proxyPathPrefixes?: string[]
  /** 本地出口兜底 (docs §3.3); default false = pool-only, never local. */
  localFallback?: boolean
  /** 本机出口协议族 (local-family.ts); default 'auto' = IPv6 where available. */
  localIpFamily?: LocalIpFamily
  /** Interface-table seam for the `auto` position (tests; see dispatcher.ts). */
  listInterfaces?: InterfaceReader
  /** Judge one transport cut (pool/transport.ts); unset = a cut is a strike. */
  onTransportCut?: (exitId: string) => void
  logger?: { info(message: string): void; warn(message: string): void }
}

/**
 * Why the routing layer is not active (docs/ip-pool.md R1, coexistence
 * policy): another dispatcher-level plugin owns the global dispatcher, so we
 * deferred instead of short-circuiting it. Null = routing is active.
 */
export type DeferredReason = string | null

/**
 * Who owns the global dispatcher slot right now, as far as this plugin may act
 * on it (docs/ip-pool.md R1):
 *
 *  - `free` — ours to take: undici's own default, or an unnamed stand-in
 *    (tests, a host that never installed anything);
 *  - `composable` — a layer that offers `chainTo()` and sends each request to
 *    the newest dispatcher chained after it (dsh-privacy-gateway's
 *    MaskingDispatcher is the one running on this host). We JOIN below it
 *    instead of replacing it: the composer keeps the slot and stays outermost,
 *    so a request body is masked BEFORE an exit is chosen, and this router
 *    still picks the exit;
 *  - `foreign` — anybody else (dsh-http-proxy's plain replace-and-restore
 *    layer, for one). Installing over it would short-circuit it silently, so
 *    we defer.
 */
type SlotOccupant =
  | { kind: 'free' }
  | { kind: 'composable'; dispatcher: Dispatcher; name: string }
  | { kind: 'foreign'; name: string }


export class RoutingInstaller {
  #deps: InstallerDeps
  #previous: Dispatcher | null = null
  #current: PoolRoutingDispatcher | null = null
  #enabled = false
  #deferredReason: DeferredReason = null
  /** Name of the composing dispatcher we joined below, or null when we own the slot. */
  #composedUnder: string | null = null
  /** The composer we chained into, held for identity checks (never for dispatch). */
  #composer: Dispatcher | null = null
  /** A composer that did not adopt us, so a refusal is not retried on every admission. */
  #refusedBy: Dispatcher | null = null
  /** The built-in fetch saved aside while the module fetch is installed (R2). */
  #savedGlobalFetch: unknown = null

  constructor(deps: InstallerDeps) {
    this.#deps = deps
  }

  get enabled(): boolean {
    return this.#enabled
  }

  /** The deferral reason exposed to the status bridge / settings card. */
  get deferredReason(): DeferredReason {
    return this.#deferredReason
  }

  /**
   * The composing dispatcher our layer sits BELOW (dsh-privacy-gateway's
   * MaskingDispatcher), or null when we own the global slot. Non-null means
   * masking and exit routing are both live on the same request: the composer
   * masks the body first, then hands it to this router.
   */
  get composedUnder(): string | null {
    return this.#composedUnder
  }

  /**
   * Whether the routing that is enabled is still the routing in force — the
   * public seam behind the pool's per-admission reconcile (ip-pool.ts
   * engageRouting). False means the slot was taken over, so install() has work
   * to do; true costs two identity comparisons and no I/O.
   */
  routingInForce(): boolean {
    return this.#enabled && this.#stillRouted()
  }

  /**
   * The host list actually in force. Reads the running router when one is
   * installed (its own default already applied), otherwise resolves the
   * configured value — so the settings card can never display a default the
   * router is not using.
   */
  get proxyHosts(): readonly string[] {
    return this.#current?.proxyHosts ?? resolveProxyHosts(this.#deps.proxyHosts)
  }

  /** Live re-apply of the proxied-host list (forwards to the running router). */
  setProxyHosts(hosts?: string[]): void {
    this.#deps.proxyHosts = hosts
    this.#current?.setProxyHosts(hosts)
  }

  /** The path scope actually in force (running router wins, exactly like hosts). */
  get proxyPathPrefixes(): readonly string[] {
    return this.#current?.proxyPathPrefixes ?? resolveProxyPathPrefixes(this.#deps.proxyPathPrefixes)
  }

  /** Live re-apply of the path scope (forwards to the running router). */
  setProxyPathPrefixes(prefixes?: string[]): void {
    this.#deps.proxyPathPrefixes = prefixes
    this.#current?.setProxyPathPrefixes(prefixes)
  }

  /**
   * 本地出口兜底 in force. Reported the same way as the host/path lists: the
   * running router's own value wins, so the card can never display a switch
   * position the router is not actually honouring.
   */
  get localFallback(): boolean {
    return this.#current?.localFallback ?? (this.#deps.localFallback === true)
  }

  /** Live re-apply of 本地出口兜底 (settings page, docs §3.3/§5.1). */
  setLocalFallback(value: boolean): void {
    this.#deps.localFallback = value === true
    this.#current?.setLocalFallback(value === true)
  }

  /**
   * 本机出口协议族 in force, reported exactly like 本地出口兜底: the running
   * router's own resolution wins, so the dropdown can never display a position
   * the sockets are not actually using.
   */
  get localIpFamily(): LocalIpFamily {
    return this.#current?.localIpFamily ?? resolveLocalIpFamily(this.#deps.localIpFamily)
  }

  /** Live re-apply of 本机出口协议族 (settings page, local-family.ts). */
  setLocalIpFamily(value: unknown): void {
    const family = resolveLocalIpFamily(value)
    this.#deps.localIpFamily = family
    this.#current?.setLocalIpFamily(family)
  }

  /**
   * Classify the global dispatcher slot (docs/ip-pool.md R1 coexistence
   * policy). The slot is single-owner by host convention, so taking it from a
   * dispatcher-level plugin short-circuits that plugin silently — but a
   * COMPOSING dispatcher hands us a documented way in (`chainTo`), and joining
   * it is strictly better than deferring: both layers then run, in the only
   * order that works (masking first, exit second).
   */
  #classifyOccupant(): SlotOccupant {
    let current: unknown
    try {
      current = this.#deps.undici.getGlobalDispatcher()
    } catch {
      return { kind: 'free' }
    }
    if (current === null || current === undefined) return { kind: 'free' }
    const foreign = current as { constructor?: { name?: string }; chainTo?: unknown }
    const name = foreign.constructor?.name ?? ''
    // undici's own defaults, plain-object stand-ins (tests, hosts that never
    // installed anything), and anything unnamed are not a foreign plugin.
    if (name === '' || name === 'Object' || name === 'Agent' || name === 'Dispatcher') return { kind: 'free' }
    if (current instanceof (this.#deps.undici.Agent as unknown as { new (): unknown })) return { kind: 'free' }
    if (typeof foreign.chainTo === 'function') return { kind: 'composable', dispatcher: current as Dispatcher, name }
    return { kind: 'foreign', name }
  }

  /** The routing layer itself, carrying the settings in force right now. */
  #buildRouter(downstream?: Dispatcher): PoolRoutingDispatcher {
    return new PoolRoutingDispatcher({
      pool: this.#deps.pool,
      undici: this.#deps.undici,
      proxyHosts: this.#deps.proxyHosts,
      proxyPathPrefixes: this.#deps.proxyPathPrefixes,
      localFallback: this.#deps.localFallback === true,
      localIpFamily: resolveLocalIpFamily(this.#deps.localIpFamily),
      listInterfaces: this.#deps.listInterfaces,
      onTransportCut: this.#deps.onTransportCut,
      logger: this.#deps.logger,
      ...(downstream === undefined ? {} : { downstream }),
    })
  }

  /**
   * Attach this router BELOW a composing dispatcher, leaving the slot to it.
   *
   * The composer hands each request to the newest layer chained after it, so
   * appending ours keeps it outermost — exactly the order masking needs. The
   * result is verified through the composer's own `downstream()` when it
   * exposes one: a composer that did not adopt us (or adopted us and still
   * routes elsewhere) is treated like any other foreign owner, so the status
   * can never claim routing the process is not doing.
   */
  #joinDownstream(occupant: { dispatcher: Dispatcher; name: string }): void {
    if (this.#refusedBy === occupant.dispatcher) {
      this.#deferForeign(occupant.name, 'did not adopt this layer as its downstream')
      return
    }
    const probe = occupant.dispatcher as unknown as {
      chainTo?(d: unknown): void
      downstream?: () => unknown
    }
    // What sits below us is read BEFORE chaining: afterwards the composer's
    // "current downstream" is us. That layer is borrowed, not replaced — a
    // proxy policy installed before us keeps carrying everything the pool does
    // not take.
    const below = typeof probe.downstream === 'function' ? probe.downstream() : undefined
    const borrowed = below !== null && typeof below === 'object' && typeof (below as { dispatch?: unknown }).dispatch === 'function'
      ? below as Dispatcher
      : undefined
    const router = this.#buildRouter(borrowed)
    let adopted = true
    try {
      if (typeof probe.chainTo !== 'function') adopted = false
      else {
        probe.chainTo(router)
        if (typeof probe.downstream === 'function') adopted = probe.downstream() === router
      }
    } catch {
      adopted = false
    }
    if (!adopted) {
      this.#refusedBy = occupant.dispatcher
      this.#deferForeign(occupant.name, 'did not adopt this layer as its downstream')
      void router.destroy().catch(() => {})
      return
    }
    const old = this.#current
    this.#current = router
    this.#enabled = true
    this.#composedUnder = occupant.name
    this.#composer = occupant.dispatcher
    this.#refusedBy = null
    this.#deferredReason = null
    // Nothing of ours took the slot, so there is nothing of ours to restore.
    this.#previous = null
    if (old !== null) void old.destroy().catch(() => {})
    this.#deps.logger?.info(`oc2dsh: exit routing joined below "${occupant.name}" (body masked first, then the exit is picked)`)
  }

  #deferForeign(name: string, why?: string): void {
    this.#deferredReason = why === undefined
      ? `deferred: global dispatcher is owned by "${name}" — install dsh-llm-proxy or the IP pool in one profile only, not both (R1)`
      : `deferred: global dispatcher is owned by "${name}" and ${why} (R1)`
    this.#deps.logger?.warn(`oc2dsh: exit routing ${this.#deferredReason}`)
  }

  /**
   * Whether the routing enabled on the books is still the routing in force:
   * we hold the slot (or a composer handed it to us when it disposed), or the
   * composer still routes to our layer. Anything else — another plugin replaced
   * us, or the composer chained a later layer on top — means requests already
   * bypass this router.
   */
  #stillRouted(): boolean {
    const router = this.#current
    if (router === null) return false
    let current: unknown
    try {
      current = this.#deps.undici.getGlobalDispatcher()
    } catch {
      return false
    }
    if (current === (router as unknown)) {
      // We hold the slot: either we installed it, or the composer disposed and
      // handed its downstream to us. Either way there is no join to verify.
      this.#composedUnder = null
      this.#composer = null
      return true
    }
    const composer = this.#composer
    if (composer === null || current !== (composer as unknown)) return false
    const probe = composer as unknown as { downstream?: () => unknown }
    if (typeof probe.downstream !== 'function') return true
    try {
      return probe.downstream() === router
    } catch {
      return false
    }
  }

  /** Drop this layer without touching the slot; the caller re-classifies it. */
  #teardownLayer(): void {
    const dying = this.#current
    this.#current = null
    this.#enabled = false
    this.#composedUnder = null
    this.#composer = null
    this.#previous = null
    if (this.#savedGlobalFetch !== null) {
      ;(globalThis as { fetch: unknown }).fetch = this.#savedGlobalFetch
      this.#savedGlobalFetch = null
    }
    if (dying !== null) void dying.destroy().catch(() => {})
  }

  /** Whether the global slot still points at this layer (nobody wrapped us). */
  #ownsSlot(dispatcher: PoolRoutingDispatcher): boolean {
    try {
      return this.#deps.undici.getGlobalDispatcher() === (dispatcher as unknown)
    } catch {
      return false
    }
  }

  /** Install (or keep installed) the routing dispatcher. */
  install(): void {
    if (this.#enabled && this.#stillRouted()) return
    // Enabled on the books but gone from the chain (another plugin replaced us,
    // or a composer chained a later layer above): drop the stale layer and
    // decide again from the slot as it is now, rather than report `enabled` for
    // routing that no longer happens.
    if (this.#enabled) this.#teardownLayer()
    const occupant = this.#classifyOccupant()
    if (occupant.kind === 'foreign') {
      this.#deferForeign(occupant.name)
      return
    }
    this.#deferredReason = null
    if (occupant.kind === 'composable') {
      this.#joinDownstream(occupant)
      return
    }
    const router = this.#buildRouter()
    // Read BEFORE swapping: undici's `setGlobalDispatcher` returns void (not
    // the replaced dispatcher) on Node 24 / undici 8.x — it yields
    // `undefined` — so `#previous` has to come from the getter, or disable()
    // could never restore the host's dispatcher and this layer would outlive
    // the plugin, capturing every later fetch in the process.
    let previous: unknown = null
    try {
      previous = this.#deps.undici.getGlobalDispatcher()
    } catch {
      // a host with a broken slot still gets our layer; restore then falls
      // back to undici's own default on disable
    }
    this.#deps.undici.setGlobalDispatcher(router as unknown as InstallableDispatcher)
    if (previous !== null && previous !== undefined) this.#previous = previous as Dispatcher
    const old = this.#current
    this.#current = router
    this.#enabled = true
    this.#composedUnder = null
    this.#composer = null
    if (old !== null) void old.destroy().catch(() => {})
    // Global-fetch capture (R2): Node's built-in fetch reads the BUILT-IN
    // undici's dispatcher slot — a different module instance than the npm
    // undici this seam routes through — so setGlobalDispatcher alone never
    // routes the OpenAI SDK's requests (it captures globalThis.fetch at call
    // time). Swap the global fetch to the module's own (which honors OUR
    // dispatcher slot) while routing is enabled; restore on disable. Only when
    // the module actually exposes a distinct fetch — a same-instance host
    // needs nothing.
    const moduleFetch = this.#deps.undici.fetch
    if (typeof moduleFetch === 'function' && globalThis.fetch !== moduleFetch) {
      this.#savedGlobalFetch = globalThis.fetch
      ;(globalThis as { fetch: unknown }).fetch = moduleFetch
      this.#deps.logger?.info('oc2dsh: globalThis.fetch -> undici module fetch (built-in fetch bypasses the pool dispatcher otherwise)')
    }
    this.#deps.logger?.info('oc2dsh: global dispatcher -> PoolRoutingDispatcher (exit routing enabled)')
  }

  /** Restore the pre-install dispatcher and close ours. */
  disable(): void {
    if (!this.#enabled) return
    const dying = this.#current
    const previous = this.#previous
    const under = this.#composedUnder
    // Rewrite the slot ONLY while it still points at this layer. A composer
    // that wrapped us (or replaced us) holds the slot now: restoring our saved
    // predecessor would delete THAT layer — switching the pool off would have
    // removed masking from the whole process. Closing ours is enough, because a
    // composer skips a closed downstream and falls through to what is below.
    const owns = dying !== null && this.#ownsSlot(dying)
    const restoreFetch = this.#savedGlobalFetch !== null
    this.#teardownLayer()
    let restored = false
    if (owns) {
      if (previous !== null) {
        try {
          this.#deps.undici.setGlobalDispatcher(previous)
          restored = true
        } catch {
          // the saved dispatcher may already be gone (host teardown) — our
          // uninstall still succeeded for our own layer
        }
      }
      if (!restored) {
        // Nothing to restore (the slot was empty when we installed, or the
        // saved dispatcher died with the host): hand undici its own default
        // back so the process does not keep calling into a destroyed layer.
        try {
          this.#deps.undici.setGlobalDispatcher(new this.#deps.undici.Agent())
          restored = true
        } catch {}
      }
    }
    if (!owns) {
      this.#deps.logger?.info(
        `oc2dsh: exit routing disabled; global dispatcher left with "${under ?? 'the layer above'}" (our layer closed, requests fall through)`,
      )
      return
    }
    this.#deps.logger?.info(
      restored
        ? `oc2dsh: exit routing disabled; previous global dispatcher restored${restoreFetch ? ' and globalThis.fetch restored' : ''}`
        : 'oc2dsh: exit routing disabled; no previous dispatcher to restore',
    )
  }

  /** Full teardown (plugin dispose): same as disable. */
  dispose(): void {
    this.disable()
  }
}
