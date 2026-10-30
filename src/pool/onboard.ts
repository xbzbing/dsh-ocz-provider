/**
 * Pool onboarding — which exits actually go online (docs/ip-pool.md §4.7).
 *
 * The pipeline is bounded so a subscription never turns into dozens of local
 * listeners and a pool of `poolSize`:
 *
 *   1. SPEED — measure every converted candidate through its own tunnel
 *      (latency + exit IP + geo, the documented coarse screen). This is the
 *      only measurement that can rank these nodes at all: the airport fronts
 *      many distinct nodes on ONE edge host:port and separates them by TLS
 *      SNI, so every candidate answers a bare TCP handshake identically.
 *      This speed pass is the ONLY probe the subscription flow runs — no
 *      step-4 OpenCode test (models list + 1-token smoke), and none on
 *      reserve promotion. Whatever OpenCode thinks of an exit's IP is answered
 *      passively by real traffic (pool.recordPassive /
 *      recordPassiveTransport at the routing layer, docs §4.3), never by an
 *      active request from this flow.
 *   2. SELECT — keep the fastest `pool.poolSize`, in speed order.
 *   3. SHRINK — re-run the conversion with only those slots, which is what
 *      actually caps the local listeners. Ports follow node identity, so
 *      nothing that stays selected is repointed.
 *   4. ADMIT — put the selection in the pool from its speed facts: measured
 *      rows claim `ok` with the speed-test latency/grade they displayed,
 *      unmeasured ones (blocked echo endpoint) are kept at the tail
 *      unverified so a paid line is never dropped over a probe failure
 *      (docs §4.5).
 *   5. REPLACE — a swap requested later (a dead rotation, a passive 401/403,
 *      the operator's 轮换 button) hands the refused row's slot to the next
 *      fastest reserve, admitted from its CACHED speed facts without probing
 *      anything. With the reserve exhausted the refused exit is KEPT but
 *      demoted to the tail, so the pool holds its size instead of draining
 *      to nothing (docs §4.5's "never evict a paid line over one probe
 *      failure").
 *
 * What still probes OpenCode: the settings card's 探测/批量探活 actions —
 * explicit user actions, outside this module.
 */

import { coarseScreen, type AdmissionDeps, type EchoFacts } from './admission.ts'
import { gradeOf, UNVERIFIED_QUALITY, type ExitPool } from './pool.ts'
import type { Prober, ProbeTask } from './prober.ts'
import type { ConvertedExit } from './singbox.ts'
import type { ParsedNode } from './subscription.ts'

export interface OnboardDeps {
  pool: ExitPool
  prober: Prober
  /** Admission seam: the same undici/geo/logger the probe path uses. */
  admission: AdmissionDeps
  /**
   * Re-run the conversion with exactly these candidate slots and return the
   * exits actually listening. Slot-stable, so the addresses of the exits that
   * stay selected do not change.
   */
  select(slots: number[]): Promise<ConvertedExit[]>
  logger?: { info(message: string): void; warn(message: string): void }
}

/** One candidate's onboarding state. */
interface Candidate {
  /** Stable port slot (index in the converted candidate list). */
  slot: number
  address: string
  protocol: 'socks5'
  node: ParsedNode
  /** Speed-pass facts, or null when the screen rejected it. */
  facts: EchoFacts | null
  /** Why the screen rejected it ('' when it passed). */
  screenRejection: string
}

export interface OnboardResult {
  /** Candidates handed in (already converted, one per node). */
  candidates: number
  /** Candidates the speed pass could measure (geo/latency survivors). */
  screened: number
  /** Candidates that were already online before this round. */
  online: number
  /** Exits admitted this round (fresh admissions + promoted reserves). */
  admitted: number
  /** Refused exits swapped for a reserve. */
  promoted: number
  /** Refused exits kept at the tail (no reserve left), plus unmeasured
   *  candidates parked there so a blocked speed pass never drains the pool. */
  demoted: number
  /** Reserves still waiting after the round. */
  reserve: number
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class Onboarder {
  readonly #deps: OnboardDeps
  /** Candidate per address from the last run (drives replace()). */
  #candidates = new Map<string, Candidate>()
  /** Slots currently selected (online), the live `keep` set for a rebuild. */
  #selected = new Set<number>()
  /** Screened but not selected, fastest first. */
  #reserve: Candidate[] = []
  /** Node identity per listener address from the last run (ConvertedExit.key). */
  #keys = new Map<string, string>()

  constructor(deps: OnboardDeps) {
    this.#deps = deps
  }

  /** Reserves still waiting (diagnostics). */
  get reserveSize(): number {
    return this.#reserve.length
  }

  /** Every listener address the last run produced (selected and reserve). */
  get addresses(): string[] {
    return [...this.#candidates.keys()]
  }

  /** Which node each address served in the last run (handed to the next onboarder). */
  get identities(): ReadonlyMap<string, string> {
    return new Map(this.#keys)
  }

  /**
   * One onboarding round over a freshly converted candidate list.
   *
   * Called from the subscription refresh, after the full conversion produced
   * every candidate's own local port. `inherited` / `inheritedKeys` carry the
   * addresses and node identities a previous onboarder produced, so a refresh
   * that builds a new onboarder still prunes retired ports and notices a port
   * that now serves another node.
   */
  async run(
    exits: ConvertedExit[],
    inherited: Iterable<string> = [],
    inheritedKeys: ReadonlyMap<string, string> = new Map(),
  ): Promise<OnboardResult> {
    const { pool, prober, admission, logger } = this.#deps
    // The addresses the PREVIOUS conversion produced, and the ones this one
    // serves: a refresh that drops nodes retires ports, and the pool would keep
    // dialling them (see #pruneVanished).
    const previous = new Set([...this.#candidates.keys(), ...inherited])
    const current = new Set(exits.map((exit) => exit.address))
    const previousKeys = new Map([...inheritedKeys, ...this.#keys])
    this.#candidates = new Map()
    this.#selected = new Set()
    this.#reserve = []
    this.#keys = new Map()
    this.#pruneVanished(previous, current)
    this.#dropReassigned(exits, previousKeys)
    const result: OnboardResult = {
      candidates: exits.length,
      screened: 0,
      online: 0,
      admitted: 0,
      promoted: 0,
      demoted: 0,
      reserve: 0,
    }
    if (exits.length === 0) return result

    // 1. Speed pass: one coarse screen per candidate, through its own port.
    //    Bounded by the shared prober (same-exit serial, cross-exit capped), so
    //    a paid airport is never hammered (docs §4.1: subscription never hot).
    const screenDeps = {
      undici: admission.undici,
      ipEchoUrl: admission.ipEchoUrl,
      blockedCountries: admission.blockedCountries,
      logger: admission.logger,
    }
    const tasks: ProbeTask[] = exits.map((exit): ProbeTask => ({
      exitId: exit.address,
      kind: 'onboard-screen',
      run: async () => {
        const verdict = await coarseScreen(screenDeps, { address: exit.address, protocol: exit.protocol })
        this.#candidates.set(exit.address, {
          slot: exit.slot,
          address: exit.address,
          protocol: exit.protocol,
          node: exit.node,
          facts: 'exitIP' in verdict ? verdict : null,
          screenRejection: 'rejected' in verdict ? verdict.rejected : '',
        })
      },
    }))
    await prober.enqueueAll(tasks)

    const measured = [...this.#candidates.values()]
      .filter((candidate) => candidate.facts !== null)
      .sort((left, right) => (left.facts!.latencyMs - right.facts!.latencyMs) || left.address.localeCompare(right.address))
    result.screened = measured.length
    if (measured.length < exits.length) {
      const sample = [...this.#candidates.values()]
        .filter((candidate) => candidate.facts === null)
        .slice(0, 3)
        .map((candidate) => `${candidate.address} (${candidate.screenRejection})`)
        .join(', ')
      logger?.info(`oc2dsh: onboarding screened ${measured.length}/${exits.length} candidate(s); ${exits.length - measured.length} did not answer the speed pass${sample === '' ? '' : ` (${sample}…)`}`)
    }
    /**
     * Nothing answered the speed pass at all — a blocked echo endpoint (the
     * documented dedicated-line case) or a transient outage, not dead nodes.
     * Draining a paid subscription to zero over a MEASUREMENT failure is
     * never acceptable, so fall back to unranked candidates in subscription
     * order: they are parked unverified at the tail (docs §4.5), never
     * dropped, and real traffic is what will ever prove them — this flow
     * probes nothing.
     */
    let ranked = measured
    if (ranked.length === 0 && exits.length > 0) {
      logger?.warn('oc2dsh: onboarding speed pass measured nothing; keeping candidates unranked in subscription order (parked at the tail, unverified — no probe runs for subscriptions)')
      ranked = [...this.#candidates.values()].sort((left, right) => left.slot - right.slot)
    }

    // 2. Keep what is already online — its health, counters and session
    //    stickiness survive a refresh, its facts take this round's measurement —
    //    and fill the rest of the pool with the fastest of the remainder, which
    //    becomes the reserve. A candidate egressing from an exit IP another row
    //    already holds is one quota bucket (§3.1): it waits at the reserve tail.
    const wanted = pool.poolSize
    const online = ranked.filter((candidate) => pool.has(candidate.address))
    for (const candidate of online) this.#refreshFacts(candidate)
    const fresh = ranked.filter((candidate) => !pool.has(candidate.address))
    const room = Math.max(0, wanted - online.length)
    const selected: Candidate[] = []
    const duplicates: Candidate[] = []
    const reserve: Candidate[] = []
    const claimed = new Set<string>()
    for (const candidate of fresh) {
      const exitIP = candidate.facts?.exitIP ?? ''
      const taken = exitIP !== '' && (claimed.has(exitIP) || pool.exitIPHolder(exitIP) !== undefined)
      if (taken) duplicates.push(candidate)
      else if (selected.length < room) {
        selected.push(candidate)
        if (exitIP !== '') claimed.add(exitIP)
      } else reserve.push(candidate)
    }
    this.#reserve = [...reserve, ...duplicates]
    this.#selected = new Set([...online, ...selected].map((candidate) => candidate.slot))
    result.online = online.length
    result.reserve = this.#reserve.length

    // 3. Shrink to the selection: this is the step that bounds local listeners
    //    at poolSize. Skipped when the selection IS every candidate (nothing to
    //    drop, and a needless sing-box restart would drop live connections).
    if (this.#selected.size < exits.length) {
      try {
        await this.#deps.select([...this.#selected])
      } catch (err) {
        logger?.warn(`oc2dsh: sing-box rebuild for the pool selection failed (${message(err)}); keeping the full conversion running`)
      }
    }

    // 4. Admit the selection straight from its speed facts — no probe of any
    //    kind: the subscription flow never asks OpenCode anything (docs §4.5).
    //    An unmeasured candidate (the blocked-echo fallback above) is parked
    //    unverified at the tail instead.
    for (const candidate of selected) {
      if (candidate.facts === null) {
        // Unmeasured (blocked echo endpoint): parked unverified at the tail —
        // with the same capacity guard as a real admission, so a pool already
        // filled by other sources cannot be pushed past `poolSize` by blind
        // rows.
        if (!pool.has(candidate.address) && pool.isFull()) pool.evictWorst()
        this.#keepDemoted(candidate)
        result.demoted += 1
        continue
      }
      if (this.#admit(candidate)) result.admitted += 1
    }
    result.reserve = this.#reserve.length
    return result
  }

  /**
   * A port that now serves a DIFFERENT node is a new exit: the row's health,
   * stickiness and counters belong to the node that left, so it leaves with it.
   * Identities come from the conversion (ConvertedExit.key); exits without one
   * are not judged.
   */
  #dropReassigned(exits: ConvertedExit[], previousKeys: ReadonlyMap<string, string>): void {
    const { pool, logger } = this.#deps
    const dropped: string[] = []
    for (const exit of exits) {
      if (exit.key === undefined) continue
      const before = previousKeys.get(exit.address)
      if (before !== undefined && before !== exit.key && pool.has(exit.address)) {
        pool.remove(exit.address)
        dropped.push(exit.address)
      }
      this.#keys.set(exit.address, exit.key)
    }
    if (dropped.length > 0) {
      logger?.info(`oc2dsh: ${dropped.length} listener(s) now serve a different node; their rows start over (${dropped.join(', ')})`)
    }
  }

  /** Write this round's speed facts onto a row that stayed online. */
  #refreshFacts(candidate: Candidate): void {
    const facts = candidate.facts
    if (facts === null) return
    const holder = this.#deps.pool.exitIPHolder(facts.exitIP)
    this.#deps.pool.refresh(candidate.address, {
      // An exit IP another row holds stays off this row (one bucket, one row).
      ...(holder === undefined || holder === candidate.address ? { exitIP: facts.exitIP } : {}),
      exitLocation: facts.exitLocation,
      latencyMs: facts.latencyMs,
      quality: gradeOf(facts.latencyMs),
    })
  }

  /**
   * Drop pool rows whose local listener this conversion no longer serves.
   *
   * Every address this onboarder creates is a sing-box inbound port, and a
   * subscription refresh that drops nodes retires their ports while the pool
   * keeps the old addresses. Dialling a
   * retired port fails at CONNECT ("Connection error."), which the pool reads
   * as an exit-shaped failure: it rotates, strikes the exit dead, re-admits it
   * as an unverified trusted line, and does it all again (docs §3.2).
   *
   * Only addresses THIS onboarder produced are considered, so a manual proxy a
   * human added by hand is never touched. remove() also clears a pin that
   * pointed at the vanished row, which is what turns "pinned to a corpse" into
   * a pool that picks a live exit again.
   */
  #pruneVanished(previous: Set<string>, current: Set<string>): void {
    const { pool, logger } = this.#deps
    const dropped: string[] = []
    for (const address of previous) {
      if (current.has(address) || !pool.has(address)) continue
      pool.remove(address)
      dropped.push(address)
    }
    if (dropped.length > 0) {
      logger?.info(
        `oc2dsh: dropped ${dropped.length} exit(s) whose listener the new conversion no longer serves (${dropped.join(', ')})`,
      )
    }
  }

  /**
   * Converge a live pool to a LOWERED capacity: drop the worst unpinned exits
   * down to `pool.poolSize` and rebuild the config with only the survivors, so
   * their listeners close with them. Without this, lowering `poolSize` from the
   * settings card only binds the NEXT onboarding — the pool keeps serving its
   * old size and keeps the extra ports open (docs §4.7 容量下调要收敛).
   *
   * Returns how many exits were dropped. No-op for a pool at or under capacity,
   * and for a pool this onboarder does not own (no candidate list ⇒ nothing to
   * rebuild).
   */
  async trim(): Promise<number> {
    const { pool, logger } = this.#deps
    if (this.#candidates.size === 0) return 0
    const dropped: string[] = []
    while (pool.list().length > pool.poolSize) {
      const evicted = pool.evictWorst()
      if (evicted === null) break
      dropped.push(evicted)
    }
    if (dropped.length === 0) return 0

    const addressBySlot = new Map([...this.#candidates.values()].map((candidate) => [candidate.slot, candidate.address]))
    const survivors = new Set<number>()
    for (const slot of this.#selected) {
      const address = addressBySlot.get(slot)
      if (address === undefined || pool.has(address)) survivors.add(slot)
    }
    this.#selected = survivors
    try {
      await this.#deps.select([...this.#selected])
    } catch (err) {
      // The pool already dropped them; a failed rebuild only leaves their ports
      // listening, which the next round clears.
      logger?.warn(`oc2dsh: sing-box rebuild after trimming to poolSize failed (${message(err)}); the dropped exits' ports stay open until the next round`)
    }
    logger?.info(`oc2dsh: pool trimmed to ${pool.poolSize} (dropped ${dropped.length}: ${dropped.join(', ')})`)
    return dropped.length
  }

  /**
   * A pool exit must give up its slot (a passive 401/403 or transport death
   * the runtime observed, a dead rotation, or the operator's 轮换 button): swap
   * in the next reserve from its cached speed facts — no probe — or demote it
   * to the tail when there is none. Returns true when a replacement landed.
   */
  async replace(address: string): Promise<boolean> {
    const candidate = this.#candidates.get(address)
    if (candidate === undefined) {
      // Not from the current candidate list (a manual or pinned row): there is
      // nothing to promote, so just stop it outranking live exits.
      this.#deps.pool.demoteToTail(address)
      return false
    }
    /**
     * Nothing to give up: the exit already left BOTH the table and the current
     * selection, so this call is a late duplicate (a rotation removed it while
     * the swap request was still in flight). Promoting here would ADD a slot
     * rather than swap one — `selected − (slot that is no longer there) + next`
     * is one bigger than the selection, i.e. one extra local listener, the same
     * capacity lie from the other direction.
     *
     * A row that left the table mid-round but whose slot is still selected is
     * not a duplicate: that case must still be swapped.
     */
    if (!this.#deps.pool.has(address) && !this.#selected.has(candidate.slot)) return false
    const result: OnboardResult = {
      candidates: 0,
      screened: 0,
      online: 0,
      admitted: 0,
      promoted: 0,
      demoted: 0,
      reserve: this.#reserve.length,
    }
    await this.#promoteAfterRefusal(candidate, result)
    return result.admitted > 0
  }

  /**
   * Swap a refused exit for the next reserve — from the reserve's CACHED speed
   * facts, never with a probe (docs §4.5: the subscription flow asks OpenCode
   * nothing; a reserve was already speed-tested at onboarding, and OpenCode's
   * opinion of an exit IP comes from real traffic).
   *
   * A promotion therefore always lands on the first candidate — only the
   * sing-box rebuild can fail it. When the reserve is exhausted the refused
   * exit is kept and moved to the tail (the pool holds its size, it just stops
   * spending traffic on that exit first).
   */
  async #promoteAfterRefusal(refused: Candidate, result: OnboardResult): Promise<void> {
    // The first reserve whose exit IP no other row holds (the refused row is leaving).
    const index = this.#reserve.findIndex((candidate) => {
      const holder = this.#deps.pool.exitIPHolder(candidate.facts?.exitIP ?? '')
      return holder === undefined || holder === refused.address || holder === candidate.address
    })
    const next = index < 0 ? undefined : this.#reserve.splice(index, 1)[0]
    if (next === undefined) {
      this.#keepDemoted(refused)
      result.demoted += 1
      this.#deps.logger?.warn(`oc2dsh: exit ${refused.address} refused upstream and no reserve is left; kept at the pool tail`)
      return
    }
    // Build the NEXT selection and hand exactly that to the rebuild: the
    // refused slot must be REMOVED before the reserve is added, or the pool
    // drops the exit while sing-box keeps listening on its port — one local
    // listener more than the pool has exits (docs §4.7 端口与选择集).
    const nextSelection = new Set(this.#selected)
    nextSelection.delete(refused.slot)
    nextSelection.add(next.slot)
    try {
      await this.#deps.select([...nextSelection])
    } catch (err) {
      // The rebuild failed: keep the refused exit rather than losing a slot.
      this.#reserve.splice(index, 0, next)
      this.#keepDemoted(refused)
      result.demoted += 1
      this.#deps.logger?.warn(`oc2dsh: sing-box rebuild failed while promoting ${next.address} (${message(err)}); ${refused.address} stays at the tail`)
      return
    }
    this.#selected = nextSelection
    this.#deps.pool.remove(refused.address)
    result.promoted += 1
    if (next.facts === null) {
      // Never speed-measured (the blocked-echo round it was reserved from):
      // it takes the slot but claims nothing and sits at the tail. Same
      // capacity guard as every other add — the removed row may not itself
      // have been in the table to free a slot.
      if (!this.#deps.pool.has(next.address) && this.#deps.pool.isFull()) this.#deps.pool.evictWorst()
      this.#keepDemoted(next)
      return
    }
    if (this.#admit(next)) result.admitted += 1
  }

  /**
   * Admit one speed-measured candidate: the row carries the speed test's
   * latency/grade (the ONLY measurement the subscription flow takes, docs
   * §4.5), and `markOk` claims exactly what the speed pass proved: this tunnel
   * carries HTTP with a known exit IP. What OpenCode thinks of that IP is left
   * entirely to passive verdicts from real traffic (recordPassive /
   * recordPassiveTransport), the standing liveness model (docs §4.3). Called
   * only for rows NOT yet in the table (the `fresh` slice), so it never clears
   * an existing row's bench or bans.
   *
   * Returns false when the pool refused the row (its exit IP is another row's
   * quota bucket): the slot leaves the selection, and its listener closes with
   * the next rebuild.
   */
  #admit(candidate: Candidate): boolean {
    const { pool } = this.#deps
    if (!pool.has(candidate.address) && pool.isFull()) {
      // The pool is at capacity (free/manual rows landed first): make room by
      // dropping the worst unpinned exit. Pinned and manual rows are explicit
      // user config and are never evicted here.
      pool.evictWorst()
    }
    const facts = candidate.facts
    const added = pool.add({
      id: candidate.address,
      protocol: candidate.protocol,
      source: 'subscription',
      pinned: false,
      exitIP: facts?.exitIP ?? '',
      exitLocation: facts?.exitLocation ?? '',
      latencyMs: facts?.latencyMs ?? 0,
      quality: facts === null ? UNVERIFIED_QUALITY : gradeOf(facts.latencyMs),
      addedAt: Date.now(),
    })
    if (!added) {
      this.#selected.delete(candidate.slot)
      this.#deps.logger?.warn(`oc2dsh: exit ${candidate.address} egresses from ${facts?.exitIP ?? '?'}, which another row already uses; not admitted`)
      return false
    }
    pool.markOk(candidate.address)
    return true
  }

  /** Keep a refused exit as the last resort: in the pool, but at the tail. */
  #keepDemoted(candidate: Candidate): void {
    const { pool } = this.#deps
    if (!pool.has(candidate.address)) {
      const facts = candidate.facts
      pool.add({
        id: candidate.address,
        protocol: 'socks5',
        source: 'subscription',
        pinned: false,
        exitIP: facts?.exitIP ?? '',
        exitLocation: facts?.exitLocation ?? '',
        latencyMs: facts?.latencyMs ?? 0,
        quality: facts === null ? UNVERIFIED_QUALITY : gradeOf(facts.latencyMs),
        addedAt: Date.now(),
      })
    }
    pool.markUnverified(candidate.address)
    pool.demoteToTail(candidate.address)
  }
}
