/**
 * ip-pool assembly — builds the ExitPool + RoutingInstaller from plugin
 * config and owns their lifecycle (docs/ip-pool.md IP-1 scope: manual
 * proxies + pinned, both strictness levels; free sources arrive in IP-2).
 *
 * Deliberately lazy about `undici`: the module is only imported when
 * ipPool.enabled is true, so the default install keeps today's dependency
 * surface (pi-ai only).
 *
 * IP-5: the runtime additionally exposes reconfigure() so the settings
 * namespace can hot-apply committed values (docs §5.1) — no restart for any
 * knob, including enabled itself.
 */

import type { Opencode2dshConfig } from './config.ts'

import { homedir } from 'node:os'
import { join } from 'node:path'

import { ExitPool, gradeOf, type ExitNode } from './pool/pool.ts'
import { LOCAL_EXIT_ID } from './pool/usage.ts'
import type { UndiciSeam } from './pool/dispatcher.ts'
import type { AdmissionDeps, AdmissionResult } from './pool/admission.ts'
import type { InstallerDeps } from './pool/installer.ts'
import { Prober } from './pool/prober.ts'
import { RefillScheduler } from './pool/refill.ts'
import { SubscriptionFetcher } from './pool/subscription-fetcher.ts'
import { SingBoxSupervisor } from './pool/singbox.ts'
import { createRotateDelegate, setRotateDelegate } from './pool/rotate.ts'

/** Data dir shared with the catalog cache (config.ts convention). */
function dataDir(): string {
  return join(homedir(), '.opencode2dsh')
}

/**
 * docs/ip-pool.md §4.6 probe timing. `PROBE_INTERVAL_MS` is the documented
 * periodic-recheck cadence, `DEAD_RETRY_MS` the documented dead retry; the
 * tick is far shorter than either because it is pure bookkeeping — it reads
 * health and enqueues only what is actually due.
 */
const PROBE_TICK_MS = 60_000
const PROBE_INTERVAL_MS = 10 * 60_000
const DEAD_RETRY_MS = 2 * 60_000

/** Parse one manual proxy string into an exit id + protocol, or null. */
export function parseManualProxy(
  entry: string,
): { id: string; protocol: 'http' | 'socks5' } | null {
  const trimmed = entry.trim()
  if (trimmed === '') return null
  const schemeMatch = /^([a-z0-9+.-]+):\/\//i.exec(trimmed)
  const scheme = schemeMatch?.[1]?.toLowerCase()
  const rest = schemeMatch ? trimmed.slice(schemeMatch[0].length) : trimmed
  if (!/^\[[^\]]+\]|[^:]+:\d{1,5}$/.test(rest)) return null
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'socks5' && scheme !== 'https' && scheme !== 'socks4' && scheme !== 'socks5h') return null
  const protocol = scheme === 'socks5' || scheme === 'socks4' || scheme === 'socks5h' ? 'socks5' : 'http'
  return { id: trimmed, protocol }
}

/**
 * Which health mark one probe verdict earns. Extracted (and exported) so the
 * mapping itself is testable without a network: a verified pass marks the
 * exit ok, a 429 marks it limited, and the trusted-source fallback — which
 * returns `admitted: true` without having reached the exit at all — must NOT
 * claim health. Live 2026-10-13: markOk() on the fallback revived five dead
 * subscription exits every probe round (state ok, grade S, exitIP unknown),
 * so the picker ranked them first and fed them real traffic that died at the
 * transport layer.
 */
export function applyProbeVerdict(
  pool: ExitPool,
  id: string,
  verdict: AdmissionResult,
  model: string,
): void {
  if (verdict.limited) pool.markLimited(id)
  else if (verdict.unverified) pool.markUnverified(id)
  else pool.markOk(id, model)
}

/**
 * Should the periodic probe tick do work?
 *
 * Off means off: while the pool is disabled nothing routes through an exit,
 * so the tick can only spend zen quota on exits nobody is using — and it made
 * the settings card's exit table churn while the operator believed the plugin
 * was idle (live 2026-10-13: 13 exits probed with the pool switched off).
 * Absent stays enabled: the documented default is on, and defaulting the tick
 * off would silently stop probing for everyone.
 */
export function probeTickEnabled(ipPool: { enabled?: boolean } | undefined): boolean {
  return ipPool?.enabled !== false
}

/** One manual/pinned row: unknown facts until the prober measures them. */
function manualNode(id: string, protocol: 'http' | 'socks5'): ExitNode {
  return {
    id,
    protocol,
    source: 'manual',
    pinned: false,
    exitIP: '',
    exitLocation: '',
    latencyMs: 0,
    quality: gradeOf(0),
    addedAt: Date.now(),
  }
}

/**
 * Make the pool's manual rows and its pin match `ipPool` exactly: add what the
 * config names, drop what it no longer names, then pin/unpin.
 *
 * Idempotent, and scoped to `source === 'manual'` rows (free and subscription
 * rows are never touched). Runs at assembly AND on every live commit.
 *
 * Live-observed gap this closes (2026-10-12): manual/pinned used to be read
 * ONLY at assembly, so editing 固定主力 in the settings card wrote the config,
 * triggered reconfigure() — and changed nothing. The stale pin kept winning
 * pick() while the deleted row stayed in the table, so the only visible fix
 * was a restart. docs §5.1 / IP-5 acceptance ("设置页改任何项保存即生效无需重启")
 * was unmet for exactly these two fields.
 *
 * A pinned address that is not in the pool is admitted as a manual row (the
 * user vouches for it, docs 3.1/4.5); an id that is already in the pool keeps
 * its row and source and is merely pinned.
 */
export function syncManualExits(pool: ExitPool, ipPool: Opencode2dshConfig['ipPool'] = {}): void {
  const desired = new Set<string>()
  for (const entry of ipPool?.manual ?? []) {
    const parsed = parseManualProxy(entry)
    if (!parsed) continue
    desired.add(parsed.id)
    if (!pool.has(parsed.id)) {
      pool.add(manualNode(parsed.id, parsed.protocol))
      pool.markOk(parsed.id)
    }
  }

  const requested = (ipPool?.pinnedExitId ?? '').trim()
  /**
   * `local` is the 本机 sentinel (the stats modal's 固定 button on the local
   * row): every request egresses from this machine. It is not an address, so
   * it must be answered before the manual-row path — parseManualProxy would
   * reject it and the pin would silently read as "nothing pinned".
   */
  const pinnedLocal = requested === LOCAL_EXIT_ID
  let pinned = ''
  if (requested !== '' && !pinnedLocal) {
    if (pool.has(requested)) {
      pinned = requested
    } else {
      // Not in the pool yet: a manual address is vouched in; anything else
      // (garbage, or a subscription exit that has not been admitted yet)
      // simply pins nothing — same tolerance buildPoolFromConfig always had.
      const parsed = parseManualProxy(requested)
      if (parsed) {
        pool.add(manualNode(parsed.id, parsed.protocol))
        pool.markOk(parsed.id)
        pinned = parsed.id
      }
    }
    if (pinned !== '') desired.add(pinned)
  }

  for (const node of pool.list()) {
    if (node.source === 'manual' && !desired.has(node.id)) pool.remove(node.id)
  }

  if (pinnedLocal) pool.pinLocal()
  else if (pinned === '') pool.unpin()
  else pool.pin(pinned)
}

/** Build the ExitPool from config (manual proxies + pinned). The pool starts
 *  with unknown health; the periodic/probe layer (IP-2) fills it in. Pinned
 *  nodes are admitted even without admission data — the user vouches for
 *  them (docs/ip-pool.md 3.1/4.5). */
export function buildPoolFromConfig(config: Opencode2dshConfig): ExitPool {
  const pool = new ExitPool()
  syncManualExits(pool, config.ipPool)
  return pool
}

export interface IpPoolRuntime {
  pool: ExitPool
  installer: {
    install(): void
    disable(): void
    dispose(): void
    readonly enabled: boolean
    /** R1 coexistence: why the routing layer deferred (null when active). */
    readonly deferredReason: string | null
    /** The host list actually in force (router's own default applied).
     *  Optional so a test seam can stand in without the running router. */
    readonly proxyHosts?: readonly string[]
    /** Live re-apply of the proxied-host list; optional so a test seam can
     *  stand in without implementing the running router's forwarding. */
    setProxyHosts?(hosts?: string[]): void
    /** The path scope in force on those hosts (default `/zen/v1`). */
    readonly proxyPathPrefixes?: readonly string[]
    /** Live re-apply of the path scope; optional for the same reason. */
    setProxyPathPrefixes?(prefixes?: string[]): void
  }
  /** Shared probe scheduler (admission + periodic probes + UI-triggered). */
  prober: Prober
  /** Subscription layer (null when no URLs configured). */
  subscriptions: SubscriptionFetcher | null
  /** Free-source refill loop (null when free.enabled false). */
  refill: RefillScheduler | null
  /** Hot-apply one committed settings value onto the live runtime (docs §5.1).
   *  Every knob lands without restart; enabled toggles the dispatcher. */
  reconfigure(next: Opencode2dshConfig): Promise<void>
  /** Enqueue a probe of every pool exit against the probe models (bridge
   *  /probe scope 'all', docs §5.3). Returns the queue depth after enqueue. */
  probeAll(): Promise<number>
  /** Enqueue one exit's probe (bridge /probe scope 'exit'). */
  probeExit(exitId: string): Promise<number>
  /** One manual refill round (bridge /probe scope 'refill'). */
  refillNow(): Promise<void>
  /** One subscription refresh round (bridge 立即刷新, docs §5.2). */
  refreshSubscriptions(): Promise<void>
  dispose(): Promise<void>
}

export interface IpPoolAssemblyDeps {
  /**
   * Installer factory seam. Production leaves it unset and gets the real
   * RoutingInstaller (imported lazily so undici stays out of the default
   * install's module graph); tests inject a fake so the engage-routing wiring
   * can be asserted without installing a global dispatcher into the process.
   */
  makeInstaller?: (deps: InstallerDeps) => IpPoolRuntime['installer']
}

/**
 * Assemble the routing stack. Returns null (with a logged reason) when the
 * host has no undici or the pool ends up empty — enabled-but-empty must
 * degrade to today's direct behavior, never a broken dispatcher (3.3).
 *
 * The undici seam is imported once here and threaded to every layer; empty
 * pool does not stop the runtime from existing (reconfigure can add exits
 * later), it only keeps the dispatcher uninstalled.
 */
export async function startIpPool(
  config: Opencode2dshConfig,
  logger: { info(message: string): void; warn(message: string): void },
  deps: IpPoolAssemblyDeps = {},
): Promise<IpPoolRuntime | null> {
  const ipPool = config.ipPool ?? {}
  const pool = buildPoolFromConfig(config)

  let undici: UndiciSeam
  try {
    undici = (await import('undici')) as UndiciSeam
  } catch (err) {
    logger.warn(`opencode2dsh: undici unavailable; exit routing disabled (${err instanceof Error ? err.message : String(err)})`)
    return null
  }

  const installerDeps: InstallerDeps = {
    pool,
    undici,
    proxyHosts: ipPool.proxyHosts,
    proxyPathPrefixes: ipPool.proxyPathPrefixes,
    logger,
  }
  const installer: IpPoolRuntime['installer'] = deps.makeInstaller !== undefined
    ? deps.makeInstaller(installerDeps)
    : new (await import('./pool/installer.ts')).RoutingInstaller(installerDeps)

  const admissionDeps: AdmissionDeps = {
    pool,
    undici: undici as unknown as AdmissionDeps['undici'],
    logger,
    blockedCountries: ipPool.free?.blockedCountries,
    smokeModel: (ipPool.probeModels ?? [])[0],
  }
  const probeModels = ipPool.probeModels ?? []
  const prober = new Prober({ pool, maxConcurrentProbes: ipPool.maxConcurrentProbes ?? 3 })

  // Free-source refill loop (docs/ip-pool.md 3.5/4.5, IP-2): periodic state
  // check -> tiered fetch -> admission probes through the Prober queue.
  let refill: RefillScheduler | null = null

  // Subscriptions (docs 1.2 source 3, IP-3/IP-4): pull + parse + trusted
  // smoke; encrypted nodes convert via sing-box when a binary is configured.
  let subscriptions: SubscriptionFetcher | null = null
  let supervisor: SingBoxSupervisor | undefined

  const ensureSupervisor = (): SingBoxSupervisor | undefined => {
    const singboxPath = config.ipPool?.singbox?.path
    if (typeof singboxPath !== 'string' || singboxPath.length === 0) return undefined
    if (supervisor === undefined) {
      supervisor = new SingBoxSupervisor({
        binPath: singboxPath,
        dataDir: join(dataDir(), 'singbox'),
        logger,
      })
    } else {
      supervisor.setBinPath(singboxPath)
    }
    return supervisor
  }

  const ensureSubscriptions = (urls: string[]): SubscriptionFetcher | null => {
    if (urls.length === 0) return null
    if (subscriptions === null) {
      subscriptions = new SubscriptionFetcher(
        { ...admissionDeps, prober, supervisor: ensureSupervisor() },
        { logger },
      )
    }
    subscriptions.setUrls(urls)
    return subscriptions
  }

  /** Apply the config to the live objects (initial start + reconfigure). */
  const applyConfig = (): void => {
    const current = config.ipPool ?? {}
    // Manual rows and the pin FIRST: they are table membership, and the
    // subscription/free layers below must see the post-edit table. This is
    // the hot path the settings card promises — without it, editing 固定主力
    // wrote the config and left the old pin winning pick() until a restart.
    syncManualExits(pool, current)
    pool.setTargetSize(current.free?.targetSize ?? 20)
    // Whole-pool capacity (settings `poolSize`, default 20): the onboarding
    // keeps the fastest N and shrinks the sing-box config to them, and the free
    // refill's admissionQuota() honours the same ceiling.
    pool.setPoolSize(current.poolSize ?? 20)
    admissionDeps.blockedCountries = current.free?.blockedCountries
    admissionDeps.smokeModel = probeModels[0]
    prober.setMaxConcurrent(current.maxConcurrentProbes ?? 3)
    installer.setProxyHosts?.(current.proxyHosts)
    installer.setProxyPathPrefixes?.(current.proxyPathPrefixes)

    // Free loop on/off + restart on target change (interval fixed 10min).
    const wantRefill = (current.free?.enabled ?? true) && current.enabled !== false
    if (wantRefill && refill === null) {
      refill = new RefillScheduler(pool, { ...admissionDeps, prober })
      refill.start()
    } else if (!wantRefill && refill !== null) {
      refill.stop()
      refill = null
    }

    // Subscription layer: (re)create on URL change, keep the fetcher across
    // refresh-interval edits.
    const urls = current.subscriptions ?? []
    const fetcher = ensureSubscriptions(urls)
    if (fetcher !== null) {
      // Attach/replace the conversion core on every commit: `singbox.path` is
      // editable while the pool runs, and the supervisor used to be read only
      // when the fetcher was first constructed — so filling the field after
      // that had no effect at all until a restart (docs §5.1 promises live).
      fetcher.setSupervisor(ensureSupervisor())
      fetcher.setIntervalMs(current.subscription?.refreshMs ?? 30 * 60_000)
      // Applied before start() so the very first refresh already carries the
      // configured UA (airports gate on it — an unlisted one answers 502).
      fetcher.setUserAgent(current.subscription?.userAgent)
      if (fetcher === subscriptions && !fetcherActive) {
        fetcher.start()
        fetcherActive = true
      }
      // Lowering poolSize must converge the LIVE pool, not just the next
      // onboarding: drop the worst exits and close their listeners with them
      // (live 2026-10-14: capacity set to 10 while 16 exits were online and
      // nothing moved). Serialized with the other config rebuilds inside the
      // fetcher, and a no-op when the pool is at or under capacity.
      if (pool.snapshot().total > pool.poolSize) {
        void fetcher.enforceCapacity().catch(() => {})
      }
    }
  }

  let fetcherActive = false

  /**
   * Engage routing as soon as the pool stops being empty.
   *
   * A pool that assembles EMPTY (subscription-only profile, or free enabled
   * but not yet refilled) skips the install() below and used to have no
   * retry hook except a settings save: the exits landed minutes later and
   * every request kept going direct while the card reported the pool as
   * enabled. This watches the TABLE, not a source, so subscription, free and
   * manual admissions all engage routing (live-observed 2026-10-12).
   */
  const engageRouting = (): void => {
    if (config.ipPool?.enabled === false) return
    if (installer.enabled || pool.snapshot().total === 0) return
    installer.install()
    if (installer.enabled) logger.info('opencode2dsh: exits admitted — exit routing engaged (live)')
  }
  pool.onAdmitted(engageRouting)

  /**
   * A dead exit must not just sit in the table (live request 2026-10-14:
   * "其余 dead 自动轮换，dead 的出口移至列表末尾"). The subscription layer swaps
   * it for the next-fastest reserve and, when the reserve is exhausted, parks it
   * at the pool tail — the pool holds its size either way. Only subscription
   * exits rotate: free rows belong to the refill loop (they evict after repeated
   * strikes) and manual/pinned rows are explicit user config.
   */
  pool.onDead((id) => {
    if (config.ipPool?.enabled === false) return
    if (pool.get(id)?.source !== 'subscription') return
    void subscriptions?.replaceExit(id).catch(() => {})
  })

  if (pool.snapshot().total > 0) {
    installer.install()
  } else {
    logger.warn('opencode2dsh: ipPool enabled but the pool is empty; staying direct until exits land (subscription/free admissions engage routing automatically)')
  }
  applyConfig()

  /**
   * One exit's probe pass, shared by every trigger (manual 批量探活 / 单出口 /
   * periodic due-probe) so the three can never drift apart.
   */
  const probeOne = async (entry: ReturnType<ExitPool['list']>[number], models: string[]): Promise<void> => {
    const { admitCandidate, admitTrusted } = await import('./pool/admission.ts')
    for (const model of models) {
      // The smoke rides the shared admission deps; point its model at the
      // current probe-model before each pass (per-exit serial, §4.1).
      admissionDeps.smokeModel = model
      // Free exits re-run the full candidate chain (echo→tunnel→smoke) —
      // their facts may have drifted; trusted exits run the smoke only
      // (docs §4.5 manual/subscription path). Pinned rides the trusted
      // path so a blocked echo endpoint never evicts the user's line.
      const verdict = entry.source === 'free'
        ? await admitCandidate(admissionDeps, {
          address: entry.id,
          protocol: entry.protocol,
          source: 'free',
        })
        : await admitTrusted(admissionDeps, {
          address: entry.id,
          protocol: entry.protocol,
          source: entry.source === 'manual' ? 'manual' : 'subscription',
        }, { pinned: entry.pinned, previous: { exitIP: entry.exitIP, exitLocation: entry.exitLocation, latencyMs: entry.latencyMs, quality: entry.quality } })
      if (verdict.admitted && verdict.node) {
        // Refresh the facts on a row that is STILL in the table. `add()` is an
        // upsert and this probe holds a snapshot from before it ran, so writing
        // it back used to resurrect an exit a rotation (or an operator's 删除)
        // had removed meanwhile — as a row with no local listener, still
        // pickable as the last resort. Measured live 2026-10-14: 11 rows against
        // a capacity of 10, the extra one demoted, unverified, listenerless.
        const refreshed = pool.refresh(entry.id, {
          protocol: verdict.node.protocol,
          exitIP: verdict.node.exitIP,
          exitLocation: verdict.node.exitLocation,
          latencyMs: verdict.node.latencyMs,
          quality: verdict.node.quality,
        })
        if (!refreshed) break
        applyProbeVerdict(pool, entry.id, verdict, model)
        // The upstream lane refused this exit (a failed smoke / 401/403 — a 429
        // arrives as `limited`, never here): swap in the next-fastest reserve,
        // or move it to the pool tail when the reserve is empty. Routed
        // through the subscription layer, which owns the candidate list and the
        // reserve; it demotes the exit itself when it has nothing to promote.
        if (verdict.unverified === true && entry.source === 'subscription') {
          void subscriptions?.replaceExit(entry.id).catch(() => {})
        }
      } else {
        pool.markDeadStrike(entry.id)
        break
      }
    }
  }

  const probeAll = async (): Promise<number> => {
    const models = probeModels.length > 0 ? probeModels : ['big-pickle']
    const tasks = pool.list().map((entry): import('./pool/prober.ts').ProbeTask => ({
      exitId: entry.id,
      kind: 'probe-all',
      run: () => probeOne(entry, models),
    }))
    if (tasks.length === 0) return 0
    void prober.enqueueAll(tasks).catch(() => {})
    return tasks.length
  }

  const probeExitTask = (exitId: string, entry: ReturnType<ExitPool['list']>[number]): import('./pool/prober.ts').ProbeTask => ({
    exitId,
    kind: 'probe-exit',
    run: () => probeOne(entry, probeModels.length > 0 ? [...probeModels] : ['big-pickle']),
  })

  const probeExit = async (exitId: string): Promise<number> => {
    const entry = pool.list().find((node) => node.id === exitId)
    if (!entry) return 0
    await prober.enqueue(probeExitTask(exitId, entry))
    return 1
  }

  /**
   * Periodic due-probe (docs §4.3 周期 + §4.6 deadRetryMs). Re-probes:
   * dead exits once deadRetryMs has elapsed, cooling exits whose window
   * expired, exits never probed, and anything past the periodic cadence.
   *
   * This is the ONLY way a dead exit can come back: `ExitPool.isUsable()`
   * returns false for `state === 'dead'`, so `pick()` never hands one a real
   * request and passive traffic can never call markOk() on it. Without this
   * loop a single false-positive transport strike retired an exit for the
   * life of the process — a live profile lost all 14 exits this way and the
   * pool drained to zero while still reporting itself enabled.
   *
   * Cheap by construction: it only reads health and enqueues what is due, so
   * the tick runs far more often than the 10-minute cadence in order to
   * honour the 2-minute dead-retry budget.
   */
  const probeDue = async (): Promise<number> => {
    if (!probeTickEnabled(config.ipPool)) return 0
    const due = pool.dueForProbe(Date.now(), { intervalMs: PROBE_INTERVAL_MS, deadRetryMs: DEAD_RETRY_MS })
    if (due.length === 0) return 0
    const byId = new Map(pool.list().map((entry) => [entry.id, entry]))
    const models = probeModels.length > 0 ? probeModels : ['big-pickle']
    const tasks = due.flatMap((id): Array<import('./pool/prober.ts').ProbeTask> => {
      const entry = byId.get(id)
      return entry === undefined ? [] : [{ exitId: id, kind: 'probe-due', run: () => probeOne(entry, models) }]
    })
    if (tasks.length === 0) return 0
    void prober.enqueueAll(tasks).catch(() => {})
    return tasks.length
  }

  // Periodic tick (§4.3). unref'd so it never keeps the host process alive.
  const probeTimer = setInterval(() => { void probeDue().catch(() => {}) }, PROBE_TICK_MS)
  probeTimer.unref?.()

  // Adapter-layer rotate delegate (docs §3.4/§8.1, IP-7): lets zen-adapter
  // restart a pre-content stream on a fresh exit instead of surfacing the
  // intermediate error to the host's retry budget.
  setRotateDelegate(createRotateDelegate(pool, { maxAttempts: config.ipPool?.maxRotateAttempts ?? 3 }))

  return {
    pool,
    installer,
    prober,
    get subscriptions() { return subscriptions },
    get refill() { return refill },
    async reconfigure(next: Opencode2dshConfig) {
      const wasEnabled = config.ipPool?.enabled !== false
      // splice the new ipPool section into the config object the runtime closes over
      config.ipPool = next.ipPool
      probeModels.length = 0
      probeModels.push(...(next.ipPool?.probeModels ?? []))
      const enable = next.ipPool?.enabled !== false
      applyConfig()
      // rotate ceiling is live-tunable (settings page) — rebuild the delegate
      setRotateDelegate(createRotateDelegate(pool, { maxAttempts: next.ipPool?.maxRotateAttempts ?? 3 }))
      // Dispatcher install state follows enabled + pool occupancy. Every
      // enable flip re-attempts install: when another dispatcher-level plugin
      // owned the slot (R1 deferral), its unload is picked up here without a
      // restart.
      if (enable && !installer.enabled && pool.snapshot().total > 0) {
        installer.install()
        if (installer.enabled) {
          logger.info('opencode2dsh: exit routing recovered — global dispatcher is free again (R1)')
        }
      } else if (!enable && installer.enabled) {
        installer.disable()
      }
      if (wasEnabled !== enable) {
        logger.info(`opencode2dsh: ip pool ${enable ? 'enabled' : 'disabled'} via settings (live)`)
        // Switching on has to mean something within seconds: the periodic tick
        // is paused while disabled, so without this kick the pool would sit
        // unverified (pick() → null → direct) for up to a full probe interval
        // — the "enabled but routing nothing" state this plugin keeps being
        // caught in.
        if (enable) void probeAll().catch(() => {})
      }
    },
    probeAll,
    probeExit,
    async refillNow() {
      if (refill !== null) await refill.tick()
    },
    async refreshSubscriptions() {
      await subscriptions?.refreshNow()
    },
    async dispose() {
      clearInterval(probeTimer)
      setRotateDelegate(null)
      subscriptions?.stop()
      refill?.stop()
      installer.dispose()
    },
  }
}
