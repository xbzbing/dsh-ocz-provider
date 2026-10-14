/**
 * ip-pool settings controller — glues the plugin's volatile `Config` field
 * (docs/ip-pool.md §5.1) to the runtime assembly (ip-pool.ts) with live apply,
 * and mounts the status/probe bridge (§5.3) on the host webServer.
 *
 * Lifecycle (all no-restart, docs §7 IP-5 acceptance), on the DSH 0.1.7 model
 * where there is no `ctx.settings.register()` and the namespace is the Loader
 * entry id:
 *  - the Loader resolves the entry config into the `ipPool` volatile
 *    reference, so a composition that already sets `enabled` assembles the
 *    pool at boot;
 *  - every settings save commits into that same reference and arrives as
 *    `loader/volatile-update`, which hot-applies through runtime.reconfigure()
 *    — including the `enabled` flip (dispatcher install/uninstall) and address
 *    list edits (manual rows rebuilt, pinned re-pinned);
 *  - bridge routes mount once the webServer service shows up (ctx.inject),
 *    reading the live runtime and the current settings value.
 */

import type { PluginContext } from '../index.ts'
import type { OrdinaryPluginConfig } from '../config.ts'
import type { IpPoolRuntime } from '../ip-pool.ts'
import { IP_POOL_NAMESPACE, resolveIpPoolSettings, toIpPoolConfig, type IpPoolSettings } from './namespace.ts'
import { IP_POOL_BRIDGE_PREFIX, makeBridgeHandlers, makeBridgeRoutes, type ProjectResolver, type WritePin } from './bridge.ts'
import type { UsageStore } from '../pool/usage-store.ts'

export interface IpPoolController {
  /** The live runtime (null until enabled and assembled). */
  runtime: IpPoolRuntime | null
  /** Current effective settings value (defaults filled). */
  settings(): IpPoolSettings
  /** The plugin config object shape consumed by reconfigure. */
  asConfig(value: IpPoolSettings): OrdinaryPluginConfig & { ipPool: ReturnType<typeof toIpPoolConfig> }
}

/** Assembly seam (test-injectable); default = the real startIpPool. */
export type AssembleIpPool = (
  config: OrdinaryPluginConfig & { ipPool: ReturnType<typeof toIpPoolConfig> },
  logger: PluginContext['logger'],
) => Promise<IpPoolRuntime | null>

const defaultAssemble: AssembleIpPool = async (config, logger) => {
  const { startIpPool } = await import('../ip-pool.ts')
  return startIpPool(config, logger)
}

/**
 * Register the ip-pool namespace, own the live runtime, mount the bridge.
 * Returns the controller handle; disposal rides the plugin fiber.
 */
export function applyIpPoolSettings(
  ctx: PluginContext,
  ordinary: OrdinaryPluginConfig,
  readIpPool: () => Partial<IpPoolSettings> | undefined,
  logger: PluginContext['logger'],
  deps: {
    assemble?: AssembleIpPool
    listLiveModels?: () => string[]
    /** The persistent usage ledger (index.ts owns the singleton). */
    usage?: UsageStore
  } = {},
): IpPoolController {
  const assemble = deps.assemble ?? defaultAssemble
  let disposed = false
  let starting: Promise<void> | undefined
  const controller: IpPoolController = {
    runtime: null,
    settings: () => resolveIpPoolSettings(readIpPool()),
    asConfig: (value) => ({ ...ordinary, ipPool: toIpPoolConfig(value) }),
  }

  /** Assemble on first enable; reuse across later commits (live reconfigure). */
  const ensureRuntime = async (): Promise<void> => {
    if (disposed || controller.runtime !== null) return
    if (starting !== undefined) return starting
    starting = (async () => {
      const runtime = await assemble(controller.asConfig(controller.settings()), logger)
      if (disposed) await runtime?.dispose()
      else controller.runtime = runtime
    })()
    try { await starting } finally { starting = undefined }
  }

  // Cold-start ordering: the Loader has already resolved schema defaults, the
  // composition's entry config, and the persisted user document into the
  // volatile reference, so a saved enabled:true must assemble the pool at boot
  // — not only after the next settings-page save. The entry config alone
  // cannot see the persisted value; `readIpPool()` can.
  const applyCommitted = (value: IpPoolSettings): void => {
    if (disposed) return
    const rt = controller.runtime
    if (value.enabled && rt === null) {
      void ensureRuntime()
        .then(() => controller.runtime?.reconfigure(controller.asConfig(controller.settings())))
        .catch((err) => {
          logger.warn(`opencode2dsh: ip pool start failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      return
    }
    if (rt !== null) {
      void rt.reconfigure(controller.asConfig(value)).catch((err) => {
        logger.warn(`opencode2dsh: ip pool live re-apply failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

  // Boot: apply the resolved value. Then every commit the Loader announces
  // takes the same path — one code path for boot and live, as before.
  applyCommitted(controller.settings())

  // Every settings save the Host accepts for this entry lands in the volatile
  // reference and arrives here. This replaces the 0.1.1 `scope.watch()` seam
  // that DSH 0.1.7 deleted along with `ctx.settings.register()`.
  const maybeOn = (ctx as { on?: PluginContext['on'] }).on
  if (typeof maybeOn === 'function') {
    maybeOn.call(ctx, 'loader/volatile-update', () => {
      applyCommitted(controller.settings())
    })
  }

  // The plugin supplies its own page (the client half's IP 池 card), so tell
  // the settings domain not to auto-generate one for this entry. Requested
  // lazily: `settings` must stay out of `inject` or a headless composition
  // that does not compose it would never activate the provider route.
  // Same shape as dsh-llm-deepseek's host.ts — `configure` returns the undo, so
  // the claim is scoped to our fiber and released on unload.
  //
  // The same handle is the write face for the stats modal's 固定 button: that
  // entry is mounted outside any settings form (the sidebar footer), so it has
  // no ConfigForm to mutate through and rides the bridge instead. Captured at
  // request time, never at mount time — a host that composes settings after
  // the bridge is still served.
  let settingsHandle: PluginContext['settings']
  if (typeof ctx.inject === 'function') {
    void Promise.resolve(ctx.inject(['settings'], (sctx: PluginContext) => {
      const settings = sctx.settings
      if (settings === undefined) return
      settingsHandle = settings
      if (typeof settings.configure !== 'function') return
      const fiber = (ctx as { fiber?: unknown }).fiber
      const claim = () => settings.configure!({ auto: false }, fiber)
      const maybeFiberEffect = (sctx as { effect?: PluginContext['effect'] }).effect
      if (typeof maybeFiberEffect === 'function') {
        // `configure` returns the undo, so the claim is scoped to our fiber.
        maybeFiberEffect.call(sctx, claim)
        return
      }
      void claim()
    })) as unknown as Promise<unknown>
  }

  /**
   * Session id → project, resolved through the host's workspace registry.
   *
   * The ledger records SESSION ids (the LLM request carries no workspace —
   * DSH's own prompt says the cwd is not inferable), and the registry is the
   * authority on which project each session belongs to: `list()` returns every
   * workspace with its `sessionIds`, so this is a read-time join rather than a
   * fact the adapter would have to guess at record time. Optional service: a
   * composition without the registry simply reports no project.
   */
  let projectOf: ProjectResolver | undefined
  if (typeof ctx.inject === 'function') {
    void Promise.resolve(ctx.inject(['workspaceRegistry'], (sctx: PluginContext) => {
      const registry = sctx.workspaceRegistry
      if (registry === undefined || typeof registry.list !== 'function') return
      projectOf = (sessionId: string) => {
        if (sessionId === '') return null
        for (const workspace of registry.list?.() ?? []) {
          if (!(workspace.sessionIds ?? []).includes(sessionId)) continue
          return { id: String(workspace.id), title: workspace.title, path: workspace.path }
        }
        return null
      }
    })) as unknown as Promise<unknown>
  }

  /**
   * Persist one pin value into this plugin's own namespace. `pinnedExitId` is
   * a volatile field of the entry's Config, so the path carries the field name
   * in front (`['ipPool', 'pinnedExitId']`) exactly like the card's own writes;
   * an empty value unsets it so the schema default applies rather than a stored
   * empty string. No expectedRevision: this is a single-field path op from a
   * surface that never read the descriptor (the same tolerance
   * provider.ts::removeProviderRoute uses for the sidecar route).
   */
  const writePin: WritePin = async (value) => {
    const settings = settingsHandle
    if (typeof settings?.mutate !== 'function') return false
    await settings.mutate(
      IP_POOL_NAMESPACE,
      [value === ''
        ? { op: 'unset', path: ['ipPool', 'pinnedExitId'] }
        : { op: 'set', path: ['ipPool', 'pinnedExitId'], value }],
    )
    return true
  }

  // Bridge: mount once webServer is up. The handlers read the live runtime
  // and the current settings value at request time (never stale closures).
  if (typeof ctx.inject === 'function') {
    void Promise.resolve(ctx.inject(['webServer'], (bctx: PluginContext) => {
      if (!bctx.webServer) return
      const handlers = makeBridgeHandlers(
        () => controller.runtime,
        () => ({
          pinnedStrict: controller.settings().pinnedStrict,
          // Report what the router is ACTUALLY using, not what the settings
          // say plus a display default: the two diverged silently while the
          // proxy-host list was empty and the card kept showing opencode.ai
          // (live 2026-10-13), which is exactly how a fully-direct pool
          // looked healthy.
          proxyHosts: controller.runtime?.installer?.proxyHosts !== undefined
            ? [...controller.runtime.installer.proxyHosts]
            : (controller.settings().proxyHosts.length > 0 ? controller.settings().proxyHosts : ['opencode.ai']),
          // The path scope, reported the same way (router's answer when one is
          // running). Without it nothing could tell "the pool carries our
          // /zen/v1 traffic" from "the pool carries whatever else lands on
          // opencode.ai" — the difference that made the request counters climb
          // while every opencode2dsh session was quiet (live 2026-10-13).
          proxyPathPrefixes: controller.runtime?.installer?.proxyPathPrefixes !== undefined
            ? [...controller.runtime.installer.proxyPathPrefixes]
            : (controller.settings().proxyPathPrefixes.length > 0 ? controller.settings().proxyPathPrefixes : ['/zen/v1']),
          // The card's state badge follows the free-source machine only while
          // that source is on; with free disabled the same thresholds apply
          // to the whole pool (a subscription-only profile used to sit on
          // "emergency" forever, live-observed 2026-10-12).
          freeEnabled: controller.settings().free.enabled,
          // The usage switch the card owns: every usage surface (this bridge's
          // per-exit numbers, the modal's tabs) follows it, while the footer
          // stays pinned to 总览 (live request 2026-10-14).
          usageScope: controller.settings().usageScope,
        }),
        {
          // Probe-model dropdown rows: the plugin's live Zen catalog when one
          // is running (adapter mode), static S3 list only otherwise.
          listLiveModels: deps.listLiveModels,
          // The modal's 固定 button persists `pinnedExitId` here.
          writePin,
          // The persistent ledger + the project join for the 流量 tab.
          usage: deps.usage,
          projectOf: (sessionId: string) => projectOf?.(sessionId) ?? null,
          runSince: () => Date.now() - Math.round(process.uptime() * 1000),
        },
      )
      const disposers: Array<() => void> = []
      for (const route of makeBridgeRoutes(handlers)) {
        disposers.push(bctx.webServer.register(route as never))
      }
      logger.info(`opencode2dsh: ip-pool bridge mounted at ${IP_POOL_BRIDGE_PREFIX} (${disposers.length} routes)`)
      const maybeEffect = (bctx as { effect?: PluginContext['effect'] }).effect
      if (typeof maybeEffect === 'function') {
        maybeEffect.call(bctx, () => () => {
          for (const dispose of disposers) dispose()
        })
      }
    })) as unknown as Promise<unknown>
  }

  logger.info(`opencode2dsh: settings namespace "${IP_POOL_NAMESPACE}" served from the plugin's volatile Config — live apply via 设置 → 插件 → IP 池`)
  const maybeEffect = (ctx as { effect?: PluginContext['effect'] }).effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      disposed = true
      void controller.runtime?.dispose()
      controller.runtime = null
    })
  }
  return controller
}
