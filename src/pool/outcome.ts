/**
 * What one routed request's outcome does to the pool, shared by both routing
 * seams: the dispatcher's observer (pool/observer.ts) and the relay's settle
 * callback (ip-pool.ts). One table, so the two paths cannot grade differently.
 */

import type { ExitPool } from './pool.ts'

/**
 * May a request the pool cannot carry leave from this machine? Only with
 * 本地出口兜底 on, or under an explicit 固定本机 pin (docs/ip-pool.md §3.3).
 */
export function mayEgressLocally(pool: ExitPool, localFallback: boolean): boolean {
  return localFallback || pool.pinnedLocal
}

/** Grade one upstream status against its exit; a degraded exit loses the session binding. */
export function settleStatus(
  pool: ExitPool,
  pick: { exitId: string; session: string; model: string },
  status: number,
): ReturnType<ExitPool['recordPassive']> {
  const verdict = pool.recordPassive(pick.exitId, status, pick.model)
  if (verdict !== 'ok') pool.rerouteSession(pick.session)
  return verdict
}

/**
 * One transport cut: handed to the judge (pool/transport.ts) when one is
 * wired, a strike otherwise. The session moves to another exit either way.
 */
export function settleTransport(
  pool: ExitPool,
  pick: { exitId: string; session: string },
  judge?: (exitId: string) => void,
): void {
  if (judge !== undefined) judge(pick.exitId)
  else pool.recordPassiveTransport(pick.exitId)
  pool.rerouteSession(pick.session)
}
