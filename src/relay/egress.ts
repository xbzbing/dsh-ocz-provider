/**
 * The egress seam between the adapter and the exit pool, for relay traffic:
 * the relay opens the upstream connection, so the pool's dispatcher never sees
 * the request. The adapter asks pick() which exit carries one request (the same
 * pick(session, model) direct dispatch uses), hands it to the relay in
 * {@link EGRESS_HEADER} (stripped before the upstream sees anything), then
 * reports settle() so the chosen exit is the graded one. Module state installed
 * by the runtime assembly (ip-pool.ts) and cleared on dispose: a plugin without
 * a pool never reaches either half.
 */

/** Per-request egress directive, understood by `relay/oc2dsh-relay.mjs`. */
export const EGRESS_HEADER = 'x-oc2dsh-egress'

/**
 * Address family for this machine's own egress through the relay: `4` / `6`
 * dial that family only, `prefer6` tries every AAAA answer first and falls
 * back to A on a connect failure.
 */
export type DirectEgressFamily = 4 | 6 | 'prefer6'

/** The {@link EGRESS_HEADER} value for a direct request on one family. */
export function directEgressDirective(family: DirectEgressFamily): string {
  return `direct;family=${family}`
}

/** One exit chosen for one request. */
export interface RelayEgressPick {
  /** Proxy URL for the relay: `http://h:p` or `socks5://h:p` (bridge-side). */
  url: string
  /** The pool exit carrying it (usage attribution + health verdicts). */
  exitId: string
  /** The model in flight (the pool's (exit, model) health pairing). */
  model: string
  /**
   * The stickiness key this pick was made for, carried back on settle so a
   * degraded exit can break the session binding (as `#observe` does).
   */
  session: string
}

/**
 * The pool could not carry the request and 本地出口兜底 is off. Reported instead
 * of a silent local egress, matching the dispatcher's fail-closed path
 * (pool/dispatcher.ts `#failClosed`): the switch governs relay traffic too.
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
 * The status a pi-ai error message names, when it names one: pi-ai folds
 * provider failures into `errorMessage` text ("429 status code (no body)"), so
 * the adapter's pre-content path reads the number back out of the string to
 * grade the relay's exit — 2xx/429 = exit fine, 5xx/transport = exit at fault,
 * the same verdict table `PoolRoutingDispatcher.#observe` applies.
 */
export function statusOfFailure(message: string): number | undefined {
  const match = /\b([1-5]\d{2})\b/.exec(message)
  return match === null ? undefined : Number(match[1])
}

/**
 * True when the failure is the relay's own envelope: its upstream fetch threw
 * before any status existed, so the 502 in front is packaging, not an answer.
 */
export function isRelayTransportFailure(message: string): boolean {
  return /\brelay_error\b/.test(message)
}
