/**
 * Installer — global-dispatcher install/swap/restore (docs/ip-pool.md 2, the
 * makeInstaller pattern from dsh-llm-proxy, adapted):
 *
 *  - installs a PoolRoutingDispatcher only while routing is enabled;
 *  - remembers the pre-existing dispatcher and restores it on disable and
 *    on plugin dispose (another dispatcher plugin — e.g. dsh-llm-proxy —
 *    must not stay short-circuited by us);
 *  - disables by restoring + destroying ours.
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

export class RoutingInstaller {
  #deps: InstallerDeps
  #previous: Dispatcher | null = null
  #current: PoolRoutingDispatcher | null = null
  #enabled = false
  #deferredReason: DeferredReason = null
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
   * Decide whether installing is safe (docs/ip-pool.md R1 coexistence policy).
   * The global dispatcher slot is single-owner: if another dispatcher-level
   * plugin (dsh-llm-proxy etc.) already installed its own layer, installing
   * ours would short-circuit theirs silently. We defer instead — routing
   * stays off, the pool keeps assembling (exits/probes/settings all live),
   * and the reason surfaces on the settings card. Default Agent instances
   * (undici's own) are not treated as a foreign owner.
   */
  #detectForeignDispatcher(): DeferredReason | null {
    let current: unknown
    try {
      current = this.#deps.undici.getGlobalDispatcher()
    } catch {
      return null
    }
    if (current === null || current === undefined) return null
    const foreign = current as { constructor?: { name?: string } }
    const name = foreign.constructor?.name ?? ''
    // undici's own defaults, plain-object stand-ins (tests, hosts that never
    // installed anything), and anything unnamed are not a foreign plugin.
    if (name === '' || name === 'Object' || name === 'Agent' || name === 'Dispatcher') return null
    if (current instanceof (this.#deps.undici.Agent as unknown as { new (): unknown })) return null
    return `deferred: global dispatcher is owned by "${name}" — install dsh-llm-proxy or the IP pool in one profile only, not both (R1)`
  }

  /** Install (or keep installed) the routing dispatcher. */
  install(): void {
    if (this.#enabled) return
    const foreign = this.#detectForeignDispatcher()
    if (foreign !== null) {
      this.#deferredReason = foreign
      this.#deps.logger?.warn(`oc2dsh: exit routing ${foreign}`)
      return
    }
    this.#deferredReason = null
    const router = new PoolRoutingDispatcher({
      pool: this.#deps.pool,
      undici: this.#deps.undici,
      proxyHosts: this.#deps.proxyHosts,
      proxyPathPrefixes: this.#deps.proxyPathPrefixes,
      localFallback: this.#deps.localFallback === true,
      localIpFamily: resolveLocalIpFamily(this.#deps.localIpFamily),
      listInterfaces: this.#deps.listInterfaces,
      onTransportCut: this.#deps.onTransportCut,
      logger: this.#deps.logger,
    })
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
    this.#enabled = false
    const restoreFetch = this.#savedGlobalFetch !== null
    if (restoreFetch) {
      ;(globalThis as { fetch: unknown }).fetch = this.#savedGlobalFetch
      this.#savedGlobalFetch = null
    }
    let restored = false
    // Destroy OUR layer before installing the previous one back: leaving the
    // router alive while the slot points elsewhere would keep its per-exit
    // ProxyAgents (and their sockets) in memory after the plugin is gone.
    const dying = this.#current
    this.#current = null
    if (dying !== null) void dying.destroy().catch(() => {})
    if (this.#previous !== null) {
      try {
        this.#deps.undici.setGlobalDispatcher(this.#previous)
        restored = true
      } catch {
        // the saved dispatcher may already be gone (host teardown) — our
        // uninstall still succeeded for our own layer
      }
      this.#previous = null
    }
    if (!restored && dying !== null) {
      // Nothing to restore (the slot was empty when we installed, or the
      // saved dispatcher died with the host): hand undici its own default
      // back so the process does not keep calling into a destroyed layer.
      try {
        this.#deps.undici.setGlobalDispatcher(new this.#deps.undici.Agent())
        restored = true
      } catch {}
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
