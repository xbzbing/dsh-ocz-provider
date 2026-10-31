import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

import { ModelCatalog, defaultCachePath, type CatalogSnapshot } from './adapter/catalog.ts'
import { opencodeUserAgent, setRequestHeadersReader, setUserAgentOverride } from './adapter/ids.ts'
import { hostProjectAsync } from './adapter/project.ts'
import type { RequestHeaders } from './request-headers.ts'
import { ZenAdapter, PROVIDER_ID } from './adapter/zen-adapter.ts'
import { Config, ordinaryConfig, resolveConfig, type Opencode2dshConfig, type ResolvedPluginConfig } from './config.ts'
import type { ModelContextWindows } from './model-context.ts'
import { applyIpPoolSettings, type IpPoolController } from './ip-pool-settings/apply.ts'
import { setUsageRecorder } from './pool/usage.ts'
import { usageStore } from './pool/usage-store.ts'
import { readVolatile, type IpPoolSettings } from './ip-pool-settings/namespace.ts'
import { stateDir } from './paths.ts'
import { RelaySupervisor, type RelayStatus } from './relay/supervisor.ts'

/**
 * oc2dsh DSH cordis plugin entry: register a DSH LlmAdapter that streams
 * directly from the Zen anonymous lane — no child process, no binary, no
 * local port.
 *
 * Settings: the editable surface is exported as `Config` (`ipPool` volatile,
 * plus the `requestHeaders` / `modelContextWindows` dictionaries), served
 * under this entry's Loader id; there is no `ctx.settings.register()`.
 *
 * dispose(): stop timers/catalog. The cordis fiber disposal guarantees this
 * runs on plugin reload/unload and on DSH shutdown.
 */

// Minimal structural typing against the host ctx; keeps the plugin independent
// of the exact @deepseek-ai/cordis version DSH ships.
export interface PluginContext {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  llm?: { registerAdapter(providers: string[], adapter: unknown): unknown }
  /**
   * The host's workspace registry (`@deepseek-ai/dsh-workspace`), requested on
   * demand: it is the authority on which project a session belongs to, and the
   * usage ledger's 流量 tab joins session ids to it at read time.
   */
  workspaceRegistry?: {
    list?(): Array<{ id: unknown; title: string; path: string; sessionIds?: readonly unknown[] }>
  }
  /**
   * The host's session query engine (`@deepseek-ai/dsh-session-query`),
   * requested on demand: its title fold is the authority on what a session is
   * CALLED, and the usage ledger's 流量 tab joins session ids to it at read
   * time — the recorded first-prompt label stays only as the fallback.
   */
  sessionQuery?: {
    readTitleSnapshots?(
      sessionIds: readonly string[],
      signal?: AbortSignal,
    ): Promise<ReadonlyArray<{ sessionId?: unknown; status?: unknown; value?: { title?: { title?: unknown } } | undefined }>>
  }
  /**
   * DSH 0.1.7 `SettingsForms` (dsh-settings). `configure` is how a plugin
   * claims its own settings page instead of letting the domain auto-generate
   * one; `mutate` is the pin write path. The 0.1.1 `register()/watch()` scope
   * seam is gone and deliberately not re-declared.
   */
  settings?: {
    describe?(options?: { redactSecrets?: boolean }): unknown
    get?(ns: string): unknown
    mutate?(ns: string, ops: Array<{ op: 'set' | 'unset'; path: Array<string | number>; value?: unknown }>, expectedRevision?: number): Promise<void>
    configure?(presentation: { auto?: boolean }, owner?: unknown): () => void
  }
  /** Web route registration (dsh-host-webserver service, docs §5.3). */
  webServer?: {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void
  }
  /** cordis fiber injection: run the callback once every listed service is up. */
  inject?(services: string[], callback: (ctx: PluginContext) => void | Promise<void>): unknown
  effect?(fn: () => () => void): unknown
  on?(event: string, listener: (...args: never[]) => unknown): () => void
}

export const name = 'oc2dsh'
/**
 * The plugin's own settings schema. DSH 0.1.7 reads this export to decide
 * which fields are editable in 设置 → 插件 and under which namespace (the
 * Loader entry id), so it must be named `Config` on the plugin runtime.
 */
export { Config } from './config.ts'
/**
 * Only `llm` gates this fiber, because the Zen lane needs nothing else: its
 * credential is the literal `'public'` and the ip-pool settings ride the
 * `Config` volatile reference. DSH 0.1.7 composes `ctx.settings` as
 * `SettingsForms`, which injects `['configEditor', 'profileContext']` and
 * ships disabled wherever no `profileContext` exists (headless/CLI) —
 * demanding it here would keep the fiber (and the provider route) from
 * activating. The `configure({ auto: false })` page claim asks for that seam
 * through `ctx.inject` instead.
 */
export const inject = ['llm'] as const
export function apply(ctx: PluginContext, config: ResolvedPluginConfig | Opencode2dshConfig = {}): void {
  // A host that predates the `Config` export hands over the raw patch object
  // (no volatile reference); readVolatile copes with both spellings.
  const resolved = config as ResolvedPluginConfig
  const cfg = resolveConfig(config as Opencode2dshConfig)
  // The Zen-lane User-Agent is ordinary config, but every sender reads it at
  // request time (chat adapter, catalog refresh, admission probes), so it is
  // applied here — before registration — and the first /models fetch already
  // carries it. Empty restores the built-in CLI-identical value.
  setUserAgentOverride(cfg.userAgent)
  const releaseHeaders = setRequestHeadersReader(() => readVolatile<RequestHeaders>(resolved.requestHeaders))
  if (typeof ctx.effect === 'function') ctx.effect.call(ctx, () => releaseHeaders)
  // Cordis accepts disposal effects; readiness objects are invalid effects.
  applyAdapter(ctx, resolved, () => readVolatile<IpPoolSettings>(resolved.ipPool))
}

/**
 * Catalog + LlmAdapter registration. The adapter registration is disposed
 * with the plugin fiber (registerAdapter uses ctx.effect internally); we only
 * own the catalog refresh loop here.
 */
function applyAdapter(
  ctx: PluginContext,
  config: ResolvedPluginConfig,
  readIpPool: () => Partial<IpPoolSettings> | undefined,
): void {
  const logger = ctx.logger
  // Strip the volatile reference before the plain config resolution: it is an
  // ordinary-fields consumer, and `{ ...defaults, ...config }` would otherwise
  // hand `startIpPool` the reference object where it expects values.
  const ordinary = ordinaryConfig(config)
  const cfg = resolveConfig(ordinary)

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('oc2dsh: llm service unavailable; the adapter cannot register')
    return
  }

  const dataDir = stateDir()
  const statusPath = join(dataDir, 'adapter-status.json')
  /** The last relay snapshot, written into the status file (diagnostics). */
  let relayStatus: RelayStatus | null = null
  /**
   * The pool controller and whatever the wiring threw. Both land in the status
   * file: a pool that is switched on but never assembled otherwise looks
   * identical to one that is switched off, and the reason only ever existed in
   * the host's in-process log.
   */
  let ipPool: IpPoolController | null = null
  let ipPoolError: string | null = null
  /** Pool state for the status file, read at write time (never captured). */
  const poolDiagnostics = (): Record<string, unknown> => {
    const runtime = ipPool?.runtime ?? null
    return {
      ready: runtime !== null,
      enabled: runtime?.installer.enabled ?? false,
      deferredReason: runtime?.installer.deferredReason ?? '',
      exits: runtime === null ? 0 : runtime.pool.snapshot().total,
      singbox: runtime?.singboxState() ?? null,
      ...(ipPoolError === null ? {} : { wiringError: ipPoolError }),
    }
  }
  const writeStatus = (status: CatalogSnapshot, lastError: string): void => {
    void writeFile(
      statusPath,
      JSON.stringify(
        {
          ...status,
          zenUserAgent: opencodeUserAgent(),
          ...(relayStatus !== null ? { relay: relayStatus } : {}),
          pool: poolDiagnostics(),
          lastError,
          writtenAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    ).catch(() => {})
  }

  /**
   * The Bun upstream relay, constructed here but started lazily (catalog
   * refresh, then `listModels`/`prepareCall`): loading the plugin must not fork
   * a process. A machine without bun keeps working — the supervisor resolves
   * null, the adapter sends direct, and the warning says what is missing.
   */
  const relay = new RelaySupervisor({
    ...(cfg.relay !== undefined ? { config: cfg.relay } : {}),
    logger,
  })

  const catalog = new ModelCatalog({
    refreshSeconds: cfg.refreshSeconds,
    cachePath: defaultCachePath(dataDir),
    // Read the volatile node on every model resolution (never cached here):
    // a settings save applies to the next request without a restart, exactly
    // like requestHeaders does for the wire.
    contextWindows: () => readVolatile<ModelContextWindows>(config.modelContextWindows),
    onRefresh: (status, lastError) => {
      // The catalog refresh is the plugin's first background work in every
      // host, so it is also the honest place to bring the relay up: a host that
      // never lists models before a turn still finds it listening by then
      // (relay/supervisor.ts warm(); refused in a process with no bun).
      relay.warm()
      relayStatus = relay.status()
      writeStatus(status, lastError)
      if (lastError) logger.warn(`oc2dsh: catalog refresh issue: ${lastError}`)
    },
  })
  const adapter = new ZenAdapter(catalog, {
    firstEventMs: cfg.firstEventMs,
    bodyIdleMs: cfg.bodyIdleMs,
    responsesBodyIdleMs: cfg.responsesBodyIdleMs,
    relay,
  })

  // Persistent usage ledger, installed HERE, not inside the ip-pool runtime:
  // the ledger answers "what did this machine spend", which stays true with the
  // pool switched off (every request then lands in the 本机 bucket), and a host
  // that never enables the pool still gets its numbers. The recorder seam keeps
  // usage.ts from importing the ledger (that would be an import cycle).
  setUsageRecorder(usageStore)
  if (typeof ctx.effect === 'function') {
    ctx.effect.call(ctx, () => () => { void usageStore.dispose() })
  } else {
    void usageStore.load()
  }

  // Register FIRST: the provider must appear in the selector right away. The
  // host awaits listModels and caches its answer per host generation, so the
  // registration-time read warms the catalog (bounded, issue #45) instead of
  // handing the picker the staticFreeModels bootstrap list. A throw anywhere
  // in the ip-pool wiring or the refresh loop must never cost the deployment
  // its only free provider.
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  logger.info(`oc2dsh: adapter registered for "${PROVIDER_ID}" (catalog warms up in background)`)

  // The relay is started on the first production call (listModels at
  // registration, then prepareCall) rather than here: loading the plugin must
  // not fork a process, and a host that only inspects the catalog should never
  // pay for one. The adapter reads `baseUrl` per request, so a relay that is
  // still coming up means that attempt goes direct (and is answered 429)
  // instead of failing.
  if (typeof ctx.effect === 'function') {
    ctx.effect.call(ctx, () => () => {
      relayStatus = relay.status()
      void relay.stop()
    })
  } else {
    process.once('exit', () => {
      void relay.stop()
    })
  }

  // IP-pool exit routing (docs/ip-pool.md IP-1..IP-5): manual proxies, pinned,
  // subscriptions, and the volatile `ipPool` settings field with
  // live apply + the /status /models /probe bridge. Opt-in via settings page or
  // cordis.patch.yml; disabled keeps the process byte-for-byte on direct.
  // Lifecycle (assembly on first enable, live reconfigure, dispose) is owned by
  // applyIpPoolSettings through the plugin fiber. It runs after the catalog
  // exists (the probe-model dropdown lists the live catalog) and inside
  // try/catch, because the provider route above must survive anything this
  // layer throws.
  try {
    ipPool = applyIpPoolSettings(ctx, ordinary, readIpPool, logger, {
      listLiveModels: () => catalog.list(),
      usage: usageStore,
      // Read per probe, not captured: the relay can restart onto another port.
      relayBaseUrl: () => relay.baseUrl,
    })
  } catch (err) {
    ipPoolError = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    logger.error(`oc2dsh: ip-pool settings wiring failed; the provider route stays direct: ${err instanceof Error ? err.message : String(err)}`)
  }

  // The project id rides every request; resolving it now keeps the git spawns
  // off the first turn (adapter/project.ts serves the cache from then on).
  void hostProjectAsync()

  void catalog.start().catch((err) => {
    logger.error(`oc2dsh: catalog start failed: ${err instanceof Error ? err.message : String(err)}`)
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect.call(ctx, () => () => {
      catalog.stop()
    })
  }
}

export { RelaySupervisor, defaultRelayScript, findBun, type RelayStatus } from './relay/supervisor.ts'
export { resolveConfig, type Opencode2dshConfig } from './config.ts'
