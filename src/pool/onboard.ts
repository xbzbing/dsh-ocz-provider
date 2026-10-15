/**
 * Pool onboarding — which exits actually go online (live request 2026-10-13).
 *
 * The problem this answers: a 44-node airport used to convert into 44 local
 * SOCKS listeners and put every one of them in the pool. The operator wants a
 * bounded pool ("池子默认 20 个") and, more to the point, does not want the
 * plugin opening dozens of local connections. So the pipeline is:
 *
 *   1. SPEED — measure every converted candidate through its own tunnel
 *      (latency + exit IP + geo, the documented coarse screen). This is the
 *      only measurement that can rank these nodes at all: the airport fronts
 *      many distinct nodes on ONE edge host:port and separates them by TLS
 *      SNI, so every candidate answers a bare TCP handshake identically.
 *   2. SELECT — keep the fastest `pool.poolSize`, in speed order.
 *   3. SHRINK — re-run the conversion with only those slots, which is what
 *      actually caps the local listeners (44 inbounds -> 20). The ports are
 *      slot-stable, so nothing that stays selected is repointed.
 *   4. CONNECT — the OpenCode connectivity test (models list + 1-token smoke)
 *      on the selection, fastest first.
 *   5. REPLACE — a candidate the upstream lane refuses is swapped for the next
 *      fastest reserve. With the reserve exhausted the refused exit is KEPT but
 *      demoted to the tail, so the pool holds its size instead of draining to
 *      nothing (docs §4.5's "never evict a paid line over one probe failure",
 *      now with a rank instead of an implicit first-place tie).
 *
 * 429 is not a refusal: the exit is alive and its quota is spent, so it is
 * admitted and cooled (`markLimited`), never swapped out.
 */

import { admitTrusted, coarseScreen, type AdmissionDeps, type AdmissionResult, type EchoFacts } from './admission.ts'
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
  /** Refused exits kept at the tail (no reserve left). */
  demoted: number
  /** Refusals seen (each one either promoted away or demoted). */
  refused: number
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

  constructor(deps: OnboardDeps) {
    this.#deps = deps
  }

  /** Reserves still waiting (diagnostics). */
  get reserveSize(): number {
    return this.#reserve.length
  }

  /**
   * One onboarding round over a freshly converted candidate list.
   *
   * Called from the subscription refresh, after the full conversion produced
   * every candidate's own local port.
   */
  async run(exits: ConvertedExit[]): Promise<OnboardResult> {
    const { pool, prober, admission, logger } = this.#deps
    this.#candidates = new Map()
    this.#selected = new Set()
    this.#reserve = []
    const result: OnboardResult = {
      candidates: exits.length,
      screened: 0,
      online: 0,
      admitted: 0,
      promoted: 0,
      demoted: 0,
      refused: 0,
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
     * documented dedicated-line case) or a transient outage, not 44 dead nodes.
     * Draining a paid subscription to zero over a MEASUREMENT failure is the
     * failure class this pool has been bitten by before, so fall back to
     * unranked candidates in subscription order: the connectivity test still
     * gets its say, and anything it refuses is parked at the tail rather than
     * dropped (docs §4.5).
     */
    let ranked = measured
    if (ranked.length === 0 && exits.length > 0) {
      logger?.warn('oc2dsh: onboarding speed pass measured nothing; keeping candidates unranked in subscription order (they stay at the tail unless the connectivity test verifies them)')
      ranked = [...this.#candidates.values()].sort((left, right) => left.slot - right.slot)
    }

    // 2. Keep what is already online — its measured facts, health, counters and
    //    session stickiness survive a refresh — and fill the rest of the pool
    //    with the fastest of the remainder, which becomes the reserve.
    const wanted = pool.poolSize
    const online = ranked.filter((candidate) => pool.has(candidate.address))
    const fresh = ranked.filter((candidate) => !pool.has(candidate.address))
    const room = Math.max(0, wanted - online.length)
    const selected = fresh.slice(0, room)
    this.#reserve = fresh.slice(room)
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

    // 4+5. Connectivity test in speed order, replacing refusals.
    for (const candidate of selected) await this.#admitOrReplace(candidate, result)
    result.reserve = this.#reserve.length
    return result
  }

  /**
   * Converge a live pool to a LOWERED capacity: drop the worst unpinned exits
   * down to `pool.poolSize` and rebuild the config with only the survivors, so
   * their listeners close with them. Without this, lowering `poolSize` from the
   * settings card only bound the NEXT onboarding — the pool kept serving its old
   * size and kept the extra ports open (the same "capacity that lies" failure as
   * an orphaned listener, just in the other direction; live 2026-10-14: 16 exits
   * against a freshly-set capacity of 10).
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
   * A pool exit was refused after onboarding (a periodic probe verdict, or a
   * passive 401/403 the runtime observed): swap in the next reserve, or demote
   * it to the tail when there is none. Returns true when a replacement landed.
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
     * the probe that asks for this replacement was still in flight). Promoting
     * here would ADD a slot rather than swap one — `selected − (slot that is no
     * longer there) + next` is one bigger than the selection, i.e. one extra
     * local listener, the same capacity lie from the other direction.
     *
     * A candidate that has not been admitted yet (onboarding step 4, which runs
     * the smokes before anything reaches the table) is not in the pool either,
     * but its slot IS in the selection — that case must still be replaced.
     */
    if (!this.#deps.pool.has(address) && !this.#selected.has(candidate.slot)) return false
    const result: OnboardResult = {
      candidates: 0,
      screened: 0,
      online: 0,
      admitted: 0,
      promoted: 0,
      demoted: 0,
      refused: 0,
      reserve: this.#reserve.length,
    }
    await this.#promoteAfterRefusal(candidate, result)
    return result.admitted > 0
  }

  /** Smoke one selected candidate; a refusal goes to the replacement path. */
  async #admitOrReplace(candidate: Candidate, result: OnboardResult): Promise<void> {
    const verdict = await this.#smoke(candidate)
    if (verdict.unverified !== true) {
      this.#admit(candidate, verdict)
      result.admitted += 1
      return
    }
    result.refused += 1
    await this.#promoteAfterRefusal(candidate, result)
  }

  /**
   * Walk the reserve until one passes the connectivity test. Every refused
   * candidate on the way is dropped from the pool; when the reserve runs out,
   * the last refused one is kept and moved to the tail (the pool holds its
   * size, it just stops spending traffic on that exit first).
   */
  async #promoteAfterRefusal(refused: Candidate, result: OnboardResult): Promise<void> {
    let current = refused
    for (;;) {
      const next = this.#reserve.shift()
      if (next === undefined) {
        this.#keepDemoted(current)
        result.demoted += 1
        this.#deps.logger?.warn(`oc2dsh: exit ${current.address} refused by the upstream lane and no reserve is left; kept at the pool tail`)
        return
      }
      // Build the NEXT selection and hand exactly that to the rebuild. Passing
      // `selected + next` before the swap (the pre-2026-10-14 shape) left the
      // refused slot in the config: the pool dropped the exit while sing-box
      // kept listening on its port — measured live as 21 local listeners for 16
      // pool exits, i.e. five orphaned ports.
      const nextSelection = new Set(this.#selected)
      nextSelection.delete(current.slot)
      nextSelection.add(next.slot)
      try {
        await this.#deps.select([...nextSelection])
      } catch (err) {
        // The rebuild failed: keep the refused exit rather than losing a slot.
        this.#reserve.unshift(next)
        this.#keepDemoted(current)
        result.demoted += 1
        this.#deps.logger?.warn(`oc2dsh: sing-box rebuild failed while promoting ${next.address} (${message(err)}); ${current.address} stays at the tail`)
        return
      }
      this.#selected = nextSelection
      this.#deps.pool.remove(current.address)
      result.promoted += 1
      const verdict = await this.#smoke(next)
      if (verdict.unverified !== true) {
        this.#admit(next, verdict)
        result.admitted += 1
        return
      }
      result.refused += 1
      current = next
    }
  }

  /** The OpenCode connectivity test: models list + 1-token smoke, reusing the
   *  speed pass's facts so steps 1-2 are not paid for twice. */
  #smoke(candidate: Candidate): Promise<AdmissionResult> {
    return admitTrusted(
      this.#deps.admission,
      { address: candidate.address, protocol: candidate.protocol, source: 'subscription' },
      { echoFacts: candidate.facts ?? undefined },
    )
  }

  /** Admit (or refresh) one candidate with its verdict. */
  #admit(candidate: Candidate, verdict: AdmissionResult): void {
    const { pool } = this.#deps
    if (!pool.has(candidate.address) && pool.isFull()) {
      // The pool is at capacity (free/manual rows landed first): make room by
      // dropping the worst unpinned exit. Pinned and manual rows are explicit
      // user config and are never evicted here.
      pool.evictWorst()
    }
    if (verdict.node !== undefined) {
      pool.add({ ...verdict.node, source: 'subscription', pinned: false })
    }
    if (verdict.limited === true) pool.markLimited(candidate.address)
    else if (verdict.unverified === true) pool.markUnverified(candidate.address)
    else pool.markOk(candidate.address)
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
