/**
 * Subscription fetcher — pulls airport/Clash subscription URLs, parses them
 * with the three-format auto-detector (subscription.ts) and routes the
 * parsed nodes (docs/ip-pool.md 1.2 source 3):
 *
 *   - plaintext nodes (http/socks5) -> speed test only -> ExitPool
 *   - encrypted nodes (vmess/vless/trojan/ss/hysteria2/anytls/tuic) ->
 *     parked until a conversion core is configured, then sing-box conversion
 *     -> the bounded onboarding pipeline (also speed test only, see onboard.ts)
 *
 * NEITHER path ever sends a request to OpenCode (docs/ip-pool.md §4.5): the
 * speed test (ip-api echo through the candidate) measures the exit's IP, geo
 * and the latency the pool row displays, and nothing else. OpenCode's opinion
 * of an exit IP arrives passively from real traffic (pool.recordPassive).
 * What still probes OpenCode is the settings card's 探测/批量探活 action — an
 * explicit user request, outside this flow.
 *
 * Deliberately gentle: subscription servers are paid account resources
 * (ban risk), so one request per URL per refresh — no retries, no fan-out
 * (docs 4.1: subscription never goes hot).
 *
 * The fetch User-Agent is settings-driven (docs 5.1 `subscription.userAgent`,
 * default DEFAULT_SUBSCRIPTION_USER_AGENT): airports gate on it and a UA their
 * panel does not list can come back as an error page or a 502 rather than a
 * subscription body — the measured versions and what each answers are recorded
 * in docs/ip-pool.md §4.6.
 */

import { ExitPool, type ExitNode } from './pool.ts'
import { Prober, type ProbeTask } from './prober.ts'
import { admitBySpeed, type AdmissionDeps } from './admission.ts'
import { Onboarder } from './onboard.ts'
import { parseSubscription, type ParsedNode, DEFAULT_SUBSCRIPTION_USER_AGENT } from './subscription.ts'
import { SingBoxSupervisor, isDialableServer, type ConvertedExit } from './singbox.ts'

/**
 * The fetch UA the settings layer and the runtime both default to; re-exported
 * so callers wiring the fetcher need not reach into the parser module.
 */
export { DEFAULT_SUBSCRIPTION_USER_AGENT }

/** Empty/whitespace means "use the default", never "send no User-Agent". */
function normalizeUserAgent(userAgent: string | undefined): string {
  const trimmed = (userAgent ?? '').trim()
  return trimmed === '' ? DEFAULT_SUBSCRIPTION_USER_AGENT : trimmed
}

export interface SubscriptionDeps extends AdmissionDeps {
  pool: ExitPool
  prober: Prober
  fetchImpl?: typeof fetch
  /** sing-box supervisor for encrypted-node conversion; when null the
   *  encrypted nodes simply park as pending (no binary configured). */
  supervisor?: {
    reload(nodes: ParsedNode[], keep?: readonly number[]): Promise<ConvertedExit[]>
    stop(): Promise<void>
    readonly running: boolean
  }
}

export interface SubscriptionState {
  /** Parsed nodes needing an external core; empty once conversion ran. */
  pendingConversion: ParsedNode[]
  /** Converted local exits admitted into the pool this round. */
  convertedAdmitted: number
  lastFetch: number
  lastError: string
  plaintextAdmitted: number
}

export interface SubscriptionOptions {
  /** Refresh interval (docs 4.6, default 30min). */
  intervalMs?: number
  timeoutMs?: number
  /**
   * User-Agent for subscription fetches (docs 5.1 `subscription.userAgent`).
   * Airports gate on this — an unlisted UA returns an error page instead of a
   * body, and may also select the returned format. Empty/unset falls back to
   * DEFAULT_SUBSCRIPTION_USER_AGENT.
   */
  userAgent?: string
  logger?: { info(message: string): void; warn(message: string): void }
}

export class SubscriptionFetcher {
  readonly #deps: SubscriptionDeps
  #urls: string[] = []
  #state: SubscriptionState = {
    pendingConversion: [],
    convertedAdmitted: 0,
    lastFetch: 0,
    lastError: '',
    plaintextAdmitted: 0,
  }
  #timer: NodeJS.Timeout | null = null
  #running = false
  #stopped = false
  #intervalMs: number
  #timeoutMs: number
  #userAgent: string
  /** Live conversion core; see setSupervisor(). */
  #supervisor: SubscriptionDeps['supervisor']
  /** Last onboarding round's controller — holds the speed facts and the
   *  reserve, so a later refusal can be replaced (see replaceExit()). */
  #onboarder: Onboarder | null = null
  /** One replacement at a time: each one rebuilds the sing-box config, and a
   *  burst of dead exits must not stack rebuilds. */
  #replacing = false
  /** Swaps that arrived while the lock was held, keyed so a row queued twice
   *  swaps once; drained the moment the lock frees (see replaceExit). */
  #deferred = new Set<string>()
  #draining = false
  #logger?: SubscriptionOptions['logger']

  constructor(deps: SubscriptionDeps, options: SubscriptionOptions = {}) {
    this.#deps = deps
    this.#supervisor = deps.supervisor
    this.#intervalMs = options.intervalMs ?? 30 * 60_000
    this.#timeoutMs = options.timeoutMs ?? 30_000
    this.#userAgent = normalizeUserAgent(options.userAgent)
    this.#logger = options.logger
  }

  get state(): SubscriptionState {
    return { ...this.#state, pendingConversion: [...this.#state.pendingConversion] }
  }

  /** Configured URL count (status bridge; the URLs themselves never ride out). */
  get urlCount(): number {
    return this.#urls.length
  }

  /**
   * Update the subscription URL list (settings change) and, when the fetcher
   * is already running AND the list really changed, pull right away — a newly
   * added airport URL must not sit unfetched until the next interval tick.
   * Before `start()` (first assembly) the immediate refresh is skipped on
   * purpose: the caller starts the fetcher right after, which fetches anyway.
   */
  setUrls(urls: string[]): void {
    const next = urls.filter((url) => url.trim().length > 0)
    const changed = next.length !== this.#urls.length || next.some((url, index) => url !== this.#urls[index])
    this.#urls = next
    if (changed && this.#timer !== null && !this.#stopped && next.length > 0) void this.refresh()
  }

  /**
   * Live re-apply of the refresh interval (settings page, docs §5.1). A save
   * that does not change the interval must NOT re-arm the timer: every
   * settings commit calls this method, and re-arming on each one would push
   * the next fetch a full interval further out.
   */
  setIntervalMs(ms: number): void {
    const next = Math.max(60_000, ms)
    if (next === this.#intervalMs) return
    this.#intervalMs = next
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = setInterval(() => void this.refresh(), this.#intervalMs)
      this.#timer.unref?.()
    }
  }

  /**
   * Live re-apply of the fetch User-Agent (settings page, docs §5.1). Takes
   * effect on the next refresh — the in-flight round keeps the UA it started
   * with. Empty falls back to the default rather than sending no UA at all.
   */
  setUserAgent(userAgent: string | undefined): void {
    this.#userAgent = normalizeUserAgent(userAgent)
  }

  /** The UA the next fetch will send (settings card echo / diagnostics). */
  get userAgent(): string {
    return this.#userAgent
  }

  /**
   * Attach or replace the encrypted-node conversion core (settings page,
   * docs §5.1). `singbox.path` is editable while the pool runs, so this is
   * re-applied on every commit — otherwise the parked nodes simply stay
   * parked with no error to explain why. Conversion runs on the next
   * refresh, so callers that want it immediately should follow up with
   * refreshNow().
   */
  setSupervisor(supervisor: SubscriptionDeps['supervisor']): void {
    this.#supervisor = supervisor
  }

  /** Manual refresh trigger (settings page 立即刷新, docs §5.3 /probe scope 'subscription'). */
  async refreshNow(): Promise<SubscriptionState> {
    return this.refresh()
  }

  /**
   * Converge a live pool to a lowered `poolSize` (settings card, live): the
   * onboarding drops the worst exits and closes their listeners. Returns how
   * many were dropped; 0 when nothing is over capacity or no round has run yet.
   */
  async enforceCapacity(): Promise<number> {
    if (this.#onboarder === null || this.#replacing) return 0
    this.#replacing = true
    try {
      return await this.#onboarder.trim()
    } catch (err) {
      this.#logger?.warn(`oc2dsh: trimming the pool to poolSize failed: ${err instanceof Error ? err.message : String(err)}`)
      return 0
    } finally {
      this.#replacing = false
      await this.#drainDeferred()
    }
  }

  /**
   * Whether a replacement/trim is holding the rebuild mutex. The bridge reads
   * this to answer an operator's 删除 with "busy, try again" instead of sinking
   * the row — an automatic swap never surfaces it, it queues (replaceExit).
   */
  get busy(): boolean {
    return this.#replacing
  }

  /**
   * An exit in the pool must give up its slot after onboarding (a passive
   * 401/403 or transport death the runtime observed, a dead rotation, or the
   * operator's 轮换 button). Swap in the next-fastest reserve — admitted from
   * its cached speed facts, never with a probe (docs §4.5); with the
   * reserve exhausted the exit is kept and moved to the pool tail, so the pool
   * holds its size.
   *
   * `defer` is for the automatic callers (dead rotation, probe verdict): while
   * the mutex is held they queue the row instead of dropping the swap, and the
   * queued rows run the moment the lock frees. Without it — the operator's own
   * 轮换 — a busy mutex still answers false immediately, which is the
   * "busy, try again" the bridge reports.
   *
   * Returns true when a replacement was admitted. False also covers "no
   * onboarder yet" (no subscription round has run in this process).
   */
  async replaceExit(exitId: string, options: { defer?: boolean } = {}): Promise<boolean> {
    if (this.#onboarder === null) return false
    if (this.#replacing) {
      if (options.defer === true) this.#deferred.add(exitId)
      return false
    }
    this.#replacing = true
    try {
      return await this.#onboarder.replace(exitId)
    } catch (err) {
      this.#logger?.warn(`oc2dsh: replacing refused exit ${exitId} failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      this.#replacing = false
      await this.#drainDeferred()
    }
  }

  /**
   * Run the swaps queued while the mutex was held. They take the same lock one
   * at a time, so a drain cannot stack sing-box rebuilds, and a row queued
   * again while the drain runs is picked up by the same loop.
   */
  async #drainDeferred(): Promise<void> {
    if (this.#draining || this.#replacing || this.#deferred.size === 0) return
    this.#draining = true
    try {
      while (this.#deferred.size > 0) {
        const exitId = this.#deferred.values().next().value
        if (exitId === undefined) break
        this.#deferred.delete(exitId)
        this.#logger?.info(`oc2dsh: rebuild lock freed; running the deferred swap of ${exitId}`)
        this.#replacing = true
        try {
          await this.#onboarder?.replace(exitId)
        } catch (err) {
          this.#logger?.warn(`oc2dsh: deferred replacement of ${exitId} failed: ${err instanceof Error ? err.message : String(err)}`)
        } finally {
          this.#replacing = false
        }
      }
    } finally {
      this.#draining = false
    }
  }

  start(): void {
    if (this.#timer !== null || this.#stopped) return
    void this.refresh()
    this.#timer = setInterval(() => void this.refresh(), this.#intervalMs)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    this.#deferred.clear()
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    void this.#supervisor?.stop().catch(() => {})
  }

  /** One refresh round over every URL; never overlaps itself. */
  async refresh(): Promise<SubscriptionState> {
    if (this.#running) return this.state
    this.#running = true
    try {
      const pending: ParsedNode[] = []
      const unroutable: ParsedNode[] = []
      const plaintext: Array<{ address: string; protocol: 'http' | 'socks5' }> = []
      let lastError = ''
      for (const url of this.#urls) {
        try {
          const body = await this.#fetch(url)
          const report = parseSubscription(body)
          for (const node of report.nodes) {
            // Placeholder addresses (private/loopback/CGNAT literals) are
            // dropped here rather than parked: they would otherwise be handed
            // to sing-box as a real node, get a port, and hold a rotation slot
            // that can only ever fail.
            if (!isDialableServer(node.server)) {
              unroutable.push(node)
              continue
            }
            if (node.type === 'http' || node.type === 'socks5') {
              plaintext.push({
                address: `${node.server}:${node.port}`,
                protocol: node.type,
              })
            } else {
              pending.push(node)
            }
          }
          this.#logger?.info(`oc2dsh: subscription parsed ${report.nodes.length} node(s) (${report.detected}) from ${this.#redact(url)}`)
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
          this.#logger?.warn(`oc2dsh: subscription fetch failed for ${this.#redact(url)}: ${lastError}`)
        }
      }
      if (unroutable.length > 0) {
        const sample = unroutable
          .slice(0, 5)
          .map((node) => `${node.type} ${node.server}:${node.port}`)
          .join(', ')
        this.#logger?.warn(
          `oc2dsh: subscription carried ${unroutable.length} node(s) with an address that cannot be dialled from this machine; skipped (${sample}${unroutable.length > 5 ? ', …' : ''})`,
        )
      }
      this.#state = {
        pendingConversion: pending,
        convertedAdmitted: 0,
        lastFetch: Date.now(),
        lastError,
        plaintextAdmitted: 0,
      }
      // Encrypted nodes -> sing-box conversion -> local SOCKS5 exits, then the
      // bounded onboarding pipeline (speed pass -> keep the fastest
      // poolSize -> shrink the conversion to them -> admit from the speed
      // facts; later swaps reuse the cached facts, no probe — onboard.ts).
      // Without a supervisor configured they stay parked as pending.
      if (pending.length > 0 && this.#supervisor) {
        const supervisor = this.#supervisor
        try {
          const exits = await supervisor.reload(pending)
          // Keep the speed-pass facts per address so a later swap can be
          // admitted from them without probing (the onboarder holds that state).
          const onboarder = new Onboarder({
            pool: this.#deps.pool,
            prober: this.#deps.prober,
            admission: this.#deps,
            select: (slots) => supervisor.reload(pending, slots),
            logger: this.#logger,
          })
          this.#onboarder = onboarder
          const outcome = await onboarder.run(exits)
          this.#state.convertedAdmitted = outcome.admitted
          // The conversion ran: nothing is parked any more — every screened
          // candidate is either in the pool or held as reserve (unmeasured
          // ones are parked in the pool at the tail, neither "pending" nor
          // health-claiming).
          this.#state.pendingConversion = []
          this.#logger?.info(
            `oc2dsh: sing-box converted ${exits.length} encrypted node(s); onboarding kept ${outcome.online + outcome.admitted} of ${outcome.screened} screened (${outcome.admitted} admitted, ${outcome.promoted} promoted, ${outcome.demoted} demoted, ${outcome.reserve} reserve)`,
          )
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err)
          this.#state.lastError = text
          this.#logger?.warn(`oc2dsh: sing-box conversion failed: ${text}`)
        }
      }
      // Plaintext nodes get the SPEED TEST only — steps 1-2 (exit IP, geo,
      // latency), never a request to OpenCode (docs/ip-pool.md §4.5), and
      // never the hot coarse screen either: subscription nodes are paid
      // resources, so the single speed request still rides the bounded Prober
      // (docs 4.1: subscription never goes hot).
      const tasks: ProbeTask[] = plaintext
        .filter((candidate) => !this.#deps.pool.has(candidate.address))
        .map((candidate): ProbeTask => ({
          exitId: candidate.address,
          kind: 'subscription-speed',
          run: async () => {
            const verdict = await admitBySpeed(this.#deps, {
              address: candidate.address,
              protocol: candidate.protocol,
              source: 'subscription',
            })
            if (verdict.admitted && verdict.node) {
              if (this.#deps.pool.add(verdict.node)) {
                if (verdict.unverified) this.#deps.pool.markUnverified(verdict.node.id)
                else this.#deps.pool.markOk(verdict.node.id)
                this.#state.plaintextAdmitted += 1
              }
            }
          },
        }))
      if (tasks.length > 0) await this.#deps.prober.enqueueAll(tasks)
      return this.state
    } finally {
      this.#running = false
    }
  }

  async #fetch(url: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await (this.#deps.fetchImpl ?? fetch)(url, {
        signal: controller.signal,
        headers: { accept: '*/*', 'user-agent': this.#userAgent },
      })
      if (!response.ok) throw new Error(`subscription HTTP ${response.status}`)
      return await response.text()
    } finally {
      clearTimeout(timer)
    }
  }

  /** Subscriptions embed account credentials; never log them in full. */
  #redact(url: string): string {
    if (url.length <= 24) return url
    return url.slice(0, 12) + '…' + url.slice(-6)
  }
}
