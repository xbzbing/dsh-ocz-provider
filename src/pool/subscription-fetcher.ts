/**
 * Subscription fetcher — pulls airport/Clash subscription URLs, parses them
 * with the three-format auto-detector (subscription.ts) and routes the
 * parsed nodes (docs/ip-pool.md 1.2 source 3):
 *
 *   - plaintext nodes (http/socks5) -> admission smoke -> ExitPool
 *   - encrypted nodes (vmess/vless/trojan/ss/hysteria2/anytls/tuic) ->
 *     parked as pending-conversion until the sing-box layer lands (IP-4)
 *
 * Deliberately gentle: subscription servers are paid account resources
 * (ban risk), so one request per URL per refresh — no retries, no fan-out
 * (docs 4.1: subscription never goes hot).
 *
 * The fetch User-Agent is settings-driven (docs 5.1 `subscription.userAgent`,
 * default DEFAULT_SUBSCRIPTION_USER_AGENT): airports gate on it and a UA their
 * panel does not list can come back as an error page or a 502 rather than a
 * subscription body — one airport measured here answers 502 for
 * `clash-verge/1.6.0` and 403 `PLEASE UPGRADE CLIENT` for `clash-verge/v2.0`
 * once its panel raised the floor (2026-10-13; v2.4.2 / mihomo 1.19.8 serve).
 */

import { ExitPool, type ExitNode } from './pool.ts'
import { Prober, type ProbeTask } from './prober.ts'
import { admitCandidate, admitTrusted, type AdmissionDeps } from './admission.ts'
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
   *  burst of dead exits must not stack rebuilds (the periodic probe retries
   *  whatever a skipped one missed). */
  #replacing = false
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
   * is already running AND the list really changed, pull right away.
   *
   * Live-observed 2026-10-12: saving the settings card only re-seeded the
   * list, so a newly added airport URL stayed unfetched until the next
   * interval tick — with the shipped 30-minute default that looked exactly
   * like "the setting did not apply". Before `start()` (first assembly) the
   * immediate refresh is skipped on purpose: the caller starts the fetcher
   * right after, which fetches anyway.
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
   * settings commit calls this method, and restarting the countdown on each
   * one pushed the next fetch a full interval away — a save made the pool
   * less live, not more.
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
   * docs §5.1). `singbox.path` is editable while the pool runs, but the
   * supervisor used to be read once at construction — so filling the field
   * after the fetcher existed had NO effect until a restart, and the parked
   * nodes simply stayed parked with no error to explain why. Conversion runs
   * on the next refresh, so callers that want it immediately should follow up
   * with refreshNow().
   */
  setSupervisor(supervisor: SubscriptionDeps['supervisor']): void {
    this.#supervisor = supervisor
  }

  /** Manual refresh trigger (settings page 立即刷新, docs §5.3 /probe scope: 'refill' parity). */
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
    }
  }

  /**
   * Whether a replacement/trim is holding the rebuild mutex. The dead-rotation
   * path ignores this (a skipped one is retried by the periodic probe), but an
   * operator's 删除 must not be mistaken for "no reserve left": the bridge
   * reads this to answer "busy, try again" instead of sinking the row.
   */
  get busy(): boolean {
    return this.#replacing
  }

  /**
   * An exit in the pool was refused by the upstream lane after onboarding (a
   * periodic probe verdict, or a passive 401/403 the runtime observed). Swap in
   * the next-fastest reserve; with the reserve exhausted the exit is kept and
   * moved to the pool tail, so the pool holds its size.
   *
   * Returns true when a replacement was admitted. False also covers "no
   * onboarder yet" (no subscription round has run in this process).
   */
  async replaceExit(exitId: string): Promise<boolean> {
    if (this.#onboarder === null || this.#replacing) return false
    this.#replacing = true
    try {
      return await this.#onboarder.replace(exitId)
    } catch (err) {
      this.#logger?.warn(`oc2dsh: replacing refused exit ${exitId} failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    } finally {
      this.#replacing = false
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
            // that can only ever fail (live 2026-10-13: server 10.255.255.255).
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
      // Encrypted nodes -> sing-box conversion -> local SOCKS5 exits (IP-4),
      // then the bounded onboarding pipeline (speed pass -> keep the fastest
      // poolSize -> shrink the conversion to them -> OpenCode connectivity test
      // -> replace refusals from the reserve). Without a supervisor configured
      // they stay parked as pending.
      if (pending.length > 0 && this.#supervisor) {
        const supervisor = this.#supervisor
        try {
          const exits = await supervisor.reload(pending)
          // Keep the speed-pass facts per address so a later refusal can be
          // replaced from the reserve (the onboarder holds that state).
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
          // The conversion ran: nothing is parked any more, whether or not the
          // connectivity test admitted each exit (the ones it refused are kept
          // in the pool at the tail, so they are not "pending" either).
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
      // Plaintext nodes go through the trusted admission smoke (never the
      // hot coarse screen: subscription nodes are paid resources, docs 4.1).
      const tasks: ProbeTask[] = plaintext
        .filter((candidate) => !this.#deps.pool.has(candidate.address))
        .map((candidate): ProbeTask => ({
          exitId: candidate.address,
          kind: 'subscription-smoke',
          run: async () => {
            const verdict = await admitTrusted(this.#deps, {
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
