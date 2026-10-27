/**
 * What ONE transport cut means for the exit it landed on.
 *
 * A cut on a row that has NO measured facts is a QUESTION, not an answer: ask
 * the listener what it speaks (pool/protocol.ts dials nothing — a greeting
 * and a CONNECT to an RFC 5737 address), then
 *
 *   - nothing answers           -> the row really is unusable: strike it dead;
 *   - it speaks the other scheme -> relabel it, revive it, keep it working;
 *   - it speaks the right one   -> the cut was transient noise: keep the row
 *                                  pickable (it just loses its `ok` claim) and
 *                                  strike it on the NEXT cut instead.
 *
 * A row WITH measured facts keeps the direct accounting: its protocol came
 * from a real request, so a cut is a genuine loss of the line and there is
 * nothing to ask. The grace is one per OUTAGE — an outage ends when something
 * proves the row alive again — so a line that keeps dropping requests still
 * dies on its second cut rather than living on diagnostics (AGENTS.md, egress
 * row hygiene).
 */

import type { ExitNode, ExitPool } from './pool.ts'
import type { ProxyProtocol } from './protocol.ts'

/**
 * What one cut means:
 *   `struck`   the row was judged dead (measured row, spent grace, or nothing
 *              listening);
 *   `healed`   the listener spoke the other scheme, so the row was relabelled
 *              and revived — the very request that failed is explained;
 *   `absolved` the listener answers and the label was right: the row stays
 *              pickable, demoted to 'unknown' until something proves it again;
 *   `deferred` the question is being asked (verdict arrives later), or another
 *              cut is already asking it;
 *   `ignored`  the row is no longer in the table.
 */
export type TransportVerdict = 'struck' | 'healed' | 'absolved' | 'deferred' | 'ignored'

export interface TransportVerdictDeps {
  pool: ExitPool
  /** What a listener actually speaks; null = undecided, and never guessed from. */
  detect: (address: string) => Promise<ProxyProtocol | null>
  logger?: { warn(message: string): void }
  now?: () => number
}

/** A row the pool never measured: its `protocol` is the operator's typing. */
function unmeasured(node: ExitNode): boolean {
  return node.source === 'manual' || node.exitIP === ''
}

export class TransportVerdicts {
  readonly #deps: TransportVerdictDeps
  /** When each row last spent its one free diagnosis this outage. */
  readonly #pardonedAt = new Map<string, number>()
  /** Rows with a diagnosis in flight — a second cut must not queue another. */
  readonly #inflight = new Set<string>()

  constructor(deps: TransportVerdictDeps) {
    this.#deps = deps
  }

  /** Rows whose diagnosis has not answered yet (diagnostics/tests). */
  get pending(): string[] {
    return [...this.#inflight]
  }

  /**
   * Judge one transport cut. Synchronous on purpose: the caller is a request
   * teardown that must not wait for a socket probe, so anything that needs the
   * network answers through the callbacks above and the row's fate lands a few
   * milliseconds later.
   */
  cut(exitId: string): TransportVerdict {
    const pool = this.#deps.pool
    const node = pool.get(exitId)
    if (node === undefined) return 'ignored'
    // A measured row: the label is proven, so a cut is the line's own verdict.
    if (!unmeasured(node)) {
      pool.recordPassiveTransport(exitId)
      return 'struck'
    }
    // Already asking about this row: the answer covers this cut too.
    if (this.#inflight.has(exitId)) {
      pool.recordTransportSignal(exitId)
      return 'deferred'
    }
    /**
     * One free diagnosis per OUTAGE, and an outage ends when something proves
     * the row alive — not when a timer expires.
     *
     * A time window looked equivalent and was not: a row that drops a request
     * every couple of minutes was pardoned again on every cut, so a listener
     * that answers while its tunnel is gone stayed "usable" forever and kept
     * absorbing the pinned traffic (measured live: 8 cuts, 0 successes, and the
     * row still pickable). Keying the pardon on the proof instead means the
     * second cut without a success in between is a strike, however far apart
     * the two were — while any success, including a passing probe, re-arms it.
     */
    const pardon = this.#pardonedAt.get(exitId)
    if (pardon !== undefined && pardon >= pool.provenAt(exitId)) {
      this.#pardonedAt.delete(exitId)
      pool.recordPassiveTransport(exitId)
      return 'struck'
    }
    this.#pardonedAt.set(exitId, this.#now())
    this.#inflight.add(exitId)
    pool.recordTransportSignal(exitId)
    void this.#diagnose(exitId, node.protocol)
    return 'deferred'
  }

  async #diagnose(exitId: string, label: ProxyProtocol): Promise<void> {
    try {
      const found = await this.#deps.detect(exitId)
      // The row can leave the table while the socket probe runs (a rotation, a
      // capacity trim, an operator's 删除): its verdict is moot then.
      if (!this.#deps.pool.has(exitId)) return
      if (found === null) {
        this.#deps.pool.recordPassiveTransport(exitId)
        this.#warn(`oc2dsh: 出口 ${exitId} 连不上（端口没有监听，或监听的不是代理）；已判 dead`)
        return
      }
      if (found !== label) {
        if (!this.#deps.pool.refresh(exitId, { protocol: found })) return
        this.#deps.pool.revive(exitId)
        // A corrected label is a new line: it earns a fresh grace rather than
        // inheriting the one the bad label spent.
        this.#pardonedAt.delete(exitId)
        this.#warn(`oc2dsh: 出口 ${exitId} 标的是 ${label}，实测是 ${found}（已纠正并复活；下一次请求就走对了）`)
        return
      }
      // Answers, and the label was right: not this row's fault. It leaves the
      // verified tier (nothing has proven it against the lane) but stays
      // pickable, and the next cut — however far off — is a strike.
      this.#deps.pool.markUnverified(exitId)
      this.#warn(`oc2dsh: 出口 ${exitId} 连得上，这一次请求没拿到响应（先不判 dead；再失败一次就判）`)
    } catch {
      // A prober that cannot answer leaves the row exactly as it was; the next
      // cut is a strike, so silence never becomes a pardon.
    } finally {
      this.#inflight.delete(exitId)
    }
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  #warn(message: string): void {
    this.#deps.logger?.warn(message)
  }
}
