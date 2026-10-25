import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { ModelCatalog, defaultCachePath, type CatalogSnapshot } from './adapter/catalog.ts'
import { opencodeUserAgent, setRequestHeadersReader, setUserAgentOverride } from './adapter/ids.ts'
import type { RequestHeaders } from './request-headers.ts'
import { ZenAdapter, PROVIDER_ID } from './adapter/zen-adapter.ts'
import { AgentProcess, type ReadyInfo } from './agent-process.ts'
import { Config, configPaths, ensureToken, ordinaryConfig, resolveConfig, writeAgentConfig, type Opencode2dshConfig, type ResolvedPluginConfig } from './config.ts'
import type { ModelContextWindows } from './model-context.ts'
import { applyIpPoolSettings } from './ip-pool-settings/apply.ts'
import { setUsageRecorder } from './pool/usage.ts'
import { usageStore } from './pool/usage-store.ts'
import { readVolatile, type IpPoolSettings } from './ip-pool-settings/namespace.ts'
import { stateDir } from './paths.ts'
import { fetchHealth, fetchModels, registerProvider, removeProviderRoute } from './provider.ts'
import { RelaySupervisor, type RelayStatus } from './relay/supervisor.ts'

/**
 * oc2dsh DSH cordis plugin entry. Two modes (config.mode, default `adapter`):
 *  - adapter: register a DSH LlmAdapter streaming directly from the Zen
 *    anonymous lane (marketplace shape: no child process, no binary).
 *  - sidecar (not bundled): prepare data dir + token + agent-config.json,
 *    spawn the Go agent, wait for READY, register the llm-pi-ai provider
 *    route, schedule model refresh.
 *
 * Settings: the editable surface is exported as `Config` (`ipPool` volatile,
 * plus the `requestHeaders` / `modelContextWindows` dictionaries), served
 * under this entry's Loader id; there is no `ctx.settings.register()`.
 *
 * dispose(): stop timers/catalog, terminate the agent tree (sidecar mode).
 * The cordis fiber disposal guarantees this runs on plugin reload/unload and
 * on DSH shutdown.
 */

// Minimal structural typing against the host ctx; keeps the plugin independent
// of the exact @deepseek-ai/cordis version DSH ships.
export interface PluginContext {
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  llm?: { registerAdapter(providers: string[], adapter: unknown): unknown }
  credentials?: { set(ref: string, value: string): Promise<void> }
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
   * DSH 0.1.7 `SettingsForms` (dsh-settings). Read face for the sidecar's
   * namespace writes; `configure` is how a plugin claims its own settings
   * page instead of letting the domain auto-generate one. The 0.1.1
   * `register()/watch()` scope seam is gone and deliberately not re-declared.
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
 * Only `llm` gates this fiber, because adapter mode (the shipped default) uses
 * nothing else: the Zen lane's credential is the literal `'public'`, and the
 * ip-pool settings ride the `Config` volatile reference. DSH 0.1.7 composes
 * `ctx.settings` as `SettingsForms`, which injects
 * `['configEditor', 'profileContext']` and ships disabled wherever no
 * `profileContext` exists (headless/CLI) — demanding it here would keep the
 * fiber (and the provider route) from activating. Sidecar mode and the
 * `configure({ auto: false })` page claim ask for the extra seams through
 * `ctx.inject` instead.
 */
export const inject = ['llm'] as const
export function apply(ctx: PluginContext, config: ResolvedPluginConfig | Opencode2dshConfig = {}): void {
  // A host that predates the `Config` export hands over the raw patch object
  // (no volatile reference); readVolatile copes with both spellings.
  const resolved = config as ResolvedPluginConfig
  const cfg = resolveConfig(config as Opencode2dshConfig)
  // The Zen-lane User-Agent is ordinary config, but every sender reads it at
  // request time (chat adapter, catalog refresh, admission probes), so it is
  // applied here — before either branch — and the first /models fetch already
  // carries it. Empty restores the built-in CLI-identical value.
  setUserAgentOverride(cfg.userAgent)
  const releaseHeaders = setRequestHeadersReader(() => readVolatile<RequestHeaders>(resolved.requestHeaders))
  if (typeof ctx.effect === 'function') ctx.effect.call(ctx, () => releaseHeaders)
  // Cordis accepts disposal effects; readiness objects are invalid effects.
  if (cfg.mode === 'sidecar') applySidecar(ctx, config as Opencode2dshConfig)
  else applyAdapter(ctx, resolved, () => readVolatile<IpPoolSettings>(resolved.ipPool))
}

/**
 * Adapter mode: catalog + LlmAdapter registration. The adapter registration
 * is disposed with the plugin fiber (registerAdapter uses ctx.effect
 * internally); we only own the catalog refresh loop here.
 */
function applyAdapter(
  ctx: PluginContext,
  config: ResolvedPluginConfig,
  readIpPool: () => Partial<IpPoolSettings> | undefined,
): { ready: Promise<{ port: number; version: string }> } {
  const logger = ctx.logger
  // Strip the volatile reference before the plain config resolution: it is an
  // ordinary-fields consumer, and `{ ...defaults, ...config }` would otherwise
  // hand `startIpPool` the reference object where it expects values.
  const ordinary = ordinaryConfig(config)
  const cfg = resolveConfig(ordinary)
  const ready = Promise.resolve({ port: 0, version: 'adapter' })

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('oc2dsh: llm service unavailable; adapter mode cannot register')
    return { ready }
  }

  const dataDir = stateDir()
  const statusPath = join(dataDir, 'adapter-status.json')
  /** The last relay snapshot, written into the status file (diagnostics). */
  let relayStatus: RelayStatus | null = null
  const writeStatus = (status: CatalogSnapshot, lastError: string): void => {
    void writeFile(
      statusPath,
      JSON.stringify(
        {
          ...status,
          zenUserAgent: opencodeUserAgent(),
          ...(relayStatus !== null ? { relay: relayStatus } : {}),
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
  // in the ip-pool wiring, the stale-route sweep, or the refresh loop must
  // never cost the deployment its only free provider.
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
  // free sources, subscriptions, and the volatile `ipPool` settings field with
  // live apply + the /status /models /probe bridge. Opt-in via settings page or
  // cordis.patch.yml; disabled keeps the process byte-for-byte on direct.
  // Lifecycle (assembly on first enable, live reconfigure, dispose) is owned by
  // applyIpPoolSettings through the plugin fiber. It runs after the catalog
  // exists (the probe-model dropdown lists the live catalog) and inside
  // try/catch, because the provider route above must survive anything this
  // layer throws.
  try {
    applyIpPoolSettings(ctx, ordinary, readIpPool, logger, {
      listLiveModels: () => catalog.list(),
      usage: usageStore,
      // Read per probe, not captured: the relay can restart onto another port.
      relayBaseUrl: () => relay.baseUrl,
    })
  } catch (err) {
    logger.error(`oc2dsh: ip-pool settings wiring failed; the provider route stays direct: ${err instanceof Error ? err.message : String(err)}`)
  }

  void catalog.start().catch((err) => {
    logger.error(`oc2dsh: catalog start failed: ${err instanceof Error ? err.message : String(err)}`)
  })

  // A sidecar leftover (llm-pi-ai.providers.oc2dsh pointing at a dead local
  // port) would shadow the adapter registration and fail every dispatch with a
  // connection error, so it is removed before the route can be used. The
  // `settings` seam is requested rather than assumed (0.1.7's SettingsForms is
  // absent from a headless composition) and reads through `describe()`.
  if (typeof ctx.inject === 'function') {
    void Promise.resolve(ctx.inject(['settings'], (sctx: PluginContext) => {
      if (!sctx.settings) return
      void removeProviderRoute({ settings: sctx.settings }, cfg.providerId)
        .then((removed) => {
          if (removed) logger.info(`oc2dsh: removed stale sidecar route for "${cfg.providerId}" from llm-pi-ai settings`)
        })
        .catch((err) => {
          logger.warn(`oc2dsh: stale route cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
        })
    })) as unknown as Promise<unknown>
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect.call(ctx, () => () => {
      catalog.stop()
    })
  }
  return { ready }
}

function applySidecar(ctx: PluginContext, config: Opencode2dshConfig): { ready: Promise<ReadyInfo> } {
  const cfg = resolveConfig(config)
  const paths = configPaths(stateDir())
  const logger = ctx.logger

  let agent: AgentProcess | null = null
  let refreshTimer: NodeJS.Timeout | null = null
  let disposed = false
  let readyResolve: (info: ReadyInfo) => void = () => {}
  const ready = new Promise<ReadyInfo>((resolve) => {
    readyResolve = resolve
  })

  const onLog = (line: string) => {
    // Agent structured logs arrive as single JSON lines on stderr/stdout.
    logger.info(`[agent] ${line}`)
  }

  /**
   * Sidecar mode's two extra seams, asked for lazily: `inject` declares only
   * `llm`, so sidecar requests `credentials`/`settings` itself. The 2 s race
   * keeps a composition that composes neither from parking the first refresh
   * forever — it settles immediately when the services are already up, and
   * falls back to what ctx carries when they never arrive.
   */
  let seams: Promise<{ credentials?: PluginContext['credentials']; settings?: PluginContext['settings'] }> | undefined
  const resolveSeams = (): Promise<{ credentials?: PluginContext['credentials']; settings?: PluginContext['settings'] }> => {
    if (seams !== undefined) return seams
    const carried = { credentials: ctx.credentials, settings: ctx.settings }
    if ((carried.credentials !== undefined && carried.settings !== undefined) || typeof ctx.inject !== 'function') {
      seams = Promise.resolve(carried)
      return seams
    }
    const arrived = new Promise<{ credentials?: PluginContext['credentials']; settings?: PluginContext['settings'] }>((resolve) => {
      void Promise.resolve(ctx.inject!(['credentials', 'settings'], (sctx: PluginContext) => {
        resolve({ credentials: sctx.credentials, settings: sctx.settings })
      }))
    })
    seams = Promise.race([arrived, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000))])
      .then((value) => value ?? carried)
    return seams
  }

  /**
   * Wait until the agent's model catalog is no longer "pending" (it fetches
   * the live S1 list a moment after listen; registering before that bakes the
   * 3-model static fallback into the DSH provider until the next refresh).
   */
  async function waitCatalogReady(port: number, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const health = await fetchHealth(port, 2000)
        const status = (health as { models?: { status?: string } })?.models?.status
        if (status && status !== 'pending') return
      } catch {
        // healthz hiccups right after listen are normal; keep polling
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    logger.warn('oc2dsh: catalog still pending after timeout; registering whatever the agent exposes now')
  }

  async function refreshModels(info: ReadyInfo, token: string, { waitReady = false } = {}): Promise<void> {
    try {
      if (waitReady) await waitCatalogReady(info.port)
      const models = await fetchModels(info.port, token)
      const { credentials, settings } = await resolveSeams()
      if (credentials && settings) {
        await registerProvider(
          {
            credentials,
            settings,
            logger: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
          },
          { providerId: cfg.providerId, apiKeyEnv: cfg.apiKeyEnv, port: info.port },
          token,
          models,
        )
      } else {
        logger.warn('oc2dsh: credentials/settings services unavailable; provider route not registered')
      }
    } catch (err) {
      logger.warn(`oc2dsh: model refresh failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function scheduleRefresh(info: ReadyInfo, token: string): void {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      if (disposed) return
      void refreshModels(info, token).then(() => {
        if (!disposed && agent?.getState() === 'ready') scheduleRefresh(info, token)
      })
    }, cfg.refreshSeconds * 1000)
  }

  async function startOnce(): Promise<ReadyInfo> {
    const token = await ensureToken(paths)
    await writeAgentConfig(paths, { token, refreshSeconds: cfg.refreshSeconds })
    const binary = cfg.agentPath ?? defaultAgentPath()
    agent = new AgentProcess(binary, ['--config', paths.configPath, '--print-ready', ...(cfg.agentArgs ?? [])], {
      restartDelayMs: cfg.restartDelayMs,
      restartMaxDelayMs: cfg.restartMaxDelayMs,
      maxConsecutiveCrashes: cfg.maxConsecutiveCrashes,
      onLog,
    })
    agent.on('exit-restart', (delay, crashes) => {
      logger.warn(`oc2dsh: agent exited unexpectedly; restarting in ${delay}ms (attempt ${crashes})`)
    })
    agent.on('circuit-tripped', (crashes) => {
      logger.error(`oc2dsh: agent crashed ${crashes} times consecutively; giving up`)
    })
    agent.on('state', (state) => {
      if (state === 'ready') logger.info('oc2dsh: agent ready')
    })
    const info = await agent.start()
    readyResolve(info)
    await refreshModels(info, token, { waitReady: true })
    scheduleRefresh(info, token)
    return info
  }

  void startOnce().catch((err) => {
    logger.error(`oc2dsh: failed to start agent: ${err instanceof Error ? err.message : String(err)}`)
  })

  // Register disposer on the plugin fiber so reload/unload/shutdown reaps the
  // child process (design.md §7 sidecar contract: no orphans).
  if (typeof ctx.effect === 'function') {
    ctx.effect.call(ctx, () => () => {
      void teardown()
    })
  }

  async function teardown(): Promise<void> {
    disposed = true
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    if (agent) {
      await agent.dispose().catch(() => {})
      agent = null
    }
  }

  return { ready }
}

/**
 * Locate the agent binary (sidecar mode, legacy — the published package does
 * not bundle it): explicit config wins; then a sibling `legacy/agent` dev
 * build; then a bare name on PATH.
 */
export function defaultAgentPath(): string {
  const bin = 'oc2dsh-agent'
  const exe = process.platform === 'win32' ? `${bin}.exe` : bin
  const here = __dirnameSafe()
  for (const sibling of [
    join(here, '..', '..', '..', 'legacy', 'agent', exe),
    join(here, '..', '..', 'legacy', 'agent', exe),
  ]) {
    if (existsSync(sibling)) return sibling
  }
  return exe
}

function __dirnameSafe(): string {
  try {
    return fileURLToPath(new URL('.', import.meta.url))
  } catch {
    return '.'
  }
}

export { AgentProcess } from './agent-process.ts'
export { RelaySupervisor, defaultRelayScript, findBun, type RelayStatus } from './relay/supervisor.ts'
export { configPaths, ensureToken, resolveConfig, writeAgentConfig, type Opencode2dshConfig } from './config.ts'
export { fetchHealth, fetchModels, registerProvider, providerBaseURL, toPiAiModels, type DshSeams } from './provider.ts'
