/**
 * The egress seam between the adapter and the exit pool, for relay traffic.
 *
 * When the Bun relay carries a request (src/relay/supervisor.ts), the request
 * leaves this process as a plain HTTP call to `127.0.0.1:<relay>` and the
 * relay opens the upstream connection. That moves the connection out of
 * undici's reach, so the pool's global dispatcher — which picks an exit
 * per dispatch and books the outcome — never sees the request. This module is
 * the replacement channel, and it keeps the pool's two halves intact:
 *
 *   pick  — the adapter asks WHICH exit should carry this request (same
 *           pick(session, model) the dispatcher calls, so pinning, stickiness
 *           and two-tier health still decide), then hands the answer to the
 *           relay in {@link EGRESS_HEADER}. The relay strips that header
 *           before the upstream sees anything.
 *   settle— the adapter reports what happened, so the exit the pool chose is
 *           the exit the pool grades (recordPassive / recordPassiveTransport),
 *           exactly like `PoolRoutingDispatcher.#observe` does for direct
 *           dispatches.
 *
 * Deliberately module state, like rotate.ts and usage.ts: the seam is installed
 * by the runtime assembly (ip-pool.ts) and cleared on dispose, so a plugin
 * without a pool never reaches either half and a disabled pool keeps the
 * adapter's behaviour unchanged.
 */

/** Per-request egress directive, understood by `relay/oc2dsh-relay.mjs`. */
export const EGRESS_HEADER = 'x-oc2dsh-egress'

/** One exit chosen for one request. */
export interface RelayEgressPick {
  /** Proxy URL for the relay: `http://h:p` or `socks5://h:p` (bridge-side). */
  url: string
  /** The pool exit carrying it (usage attribution + health verdicts). */
  exitId: string
  /** The model in flight (the pool's (exit, model) health pairing). */
  model: string
  /**
   * The stickiness key this pick was made for. Carried back on settle so a
   * degraded exit can break the session binding, exactly like
   * `PoolRoutingDispatcher.#observe` does after a bad status.
   */
  session: string
}

/**
 * The pool could not carry the request and 本地出口兜底 is off.
 *
 * Reported instead of a silent local egress because the switch exists exactly
 * to keep this machine's address off the wire; the dispatcher fails closed the
 * same way (pool/dispatcher.ts `#failClosed`), so relay traffic must not be the
 * one road around the operator's decision.
 */
export interface RelayEgressFail {
  fail: string
}

/** null = send direct (no pool, or the pool is not in this request's scope). */
export type RelayEgressDecision = RelayEgressPick | RelayEgressFail | null

/** What the relay request ended as. */
export interface RelayOutcome {
  /** Upstream HTTP status when one arrived. */
  status?: number
  /** The connection itself failed (no status). */
  transport?: boolean
}

export interface RelayEgressSeams {
  pick?: (context: { model: string; session: string }) => RelayEgressDecision
  settle?: (pick: RelayEgressPick, outcome: RelayOutcome) => void
}

let seams: RelayEgressSeams = {}

/** Install the runtime's egress seams (startIpPool); null clears them on dispose. */
export function setRelayEgressSeams(next: RelayEgressSeams | null): void {
  seams = next ?? {}
}

/** True when a pool is wired to relay traffic (adapter fast-path). */
export function hasRelayEgress(): boolean {
  return seams.pick !== undefined
}

/** Ask the pool which exit should carry one request. */
export function pickRelayEgress(context: { model: string; session: string }): RelayEgressDecision {
  return seams.pick?.(context) ?? null
}

/** Report one relayed request's outcome to the pool that chose the exit. */
export function settleRelayEgress(pick: RelayEgressPick | null, outcome: RelayOutcome): void {
  if (pick === null) return
  seams.settle?.(pick, outcome)
}

/**
 * The status a pi-ai error message names, when it names one.
 *
 * pi-ai normalizes provider failures into `errorMessage` text ("429 status
 * code (no body)", "403 FreeTierError …"), so the adapter's pre-content path
 * can only read the number back out of the string. Used to grade the exit the
 * relay carried the request over — a 2xx/429 say the exit itself was fine, a
 * 5xx or a transport cut say it was not (the same verdict table
 * `PoolRoutingDispatcher.#observe` applies to a real status code).
 */
export function statusOfFailure(message: string): number | undefined {
  const match = /\b([1-5]\d{2})\b/.exec(message)
  return match === null ? undefined : Number(match[1])
}
