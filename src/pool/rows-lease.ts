/**
 * Process-level handoff of the exit TABLE across a plugin reload.
 *
 * Another plugin's install/uninstall recomposes the profile, and HMR stops and
 * re-applies this plugin in the same process. The next generation builds its
 * table from CONFIG (`buildPoolFromConfig`), which carries the manual rows and
 * the pin — the subscription rows were admitted at runtime and have nowhere to
 * come from. Until the subscription layer fetches, screens and admits them
 * again (30 s on a good airport, minutes on a bad one) the table holds only the
 * manual rows, so the panel reads "the exits are gone" while sing-box is still
 * listening on every port and pick() has almost nothing to choose from.
 *
 * So dispose OFFERS the table it had, at the same moment it hands the sing-box
 * child over — the listeners those rows describe are still bound. The next
 * generation CLAIMS it before the health store seeds, so every row comes back
 * with its facts and its verdicts attached. A row that outlived its listener
 * costs a skipped pick rather than a refused connect: dispatch goes through
 * the local-port guard (`ExitPool.setLocalPortGuard`).
 *
 * The holder lives on `globalThis` because HMR evicts the plugin's modules: a
 * module-scoped holder would be empty again in the next generation. An offer
 * nobody claims (a real uninstall, or a host that stays up with the plugin
 * gone) expires by its timer; the rows are plain data, so there is nothing to
 * close and a process exit takes the holder with it.
 */
import type { ExitNode } from './pool.ts'

export interface RowsLease {
  /** The table as the outgoing generation saw it (subscription rows). */
  rows: ExitNode[]
  /** Epoch ms the offering generation disposed (diagnostics). */
  handedAt: number
  timer?: NodeJS.Timeout
}

/**
 * How long an unclaimed offer stays claimable. It only has to cover the
 * recompose itself (a fraction of a second), and it matches the sing-box
 * child's handoff grace, so the rows and the listeners they name expire
 * together.
 */
export const ROWS_GRACE_MS = 60_000

interface RowsBox {
  /** One offer per state dir: the profile decides which pool a generation is. */
  offers: Map<string, RowsLease>
}

const ROWS_KEY = Symbol.for('oc2dsh.pool.rows')

function box(): RowsBox {
  const holder = globalThis as unknown as Record<symbol, RowsBox | undefined>
  const existing = holder[ROWS_KEY]
  if (existing !== undefined) return existing
  const created: RowsBox = { offers: new Map() }
  holder[ROWS_KEY] = created
  return created
}

/**
 * Offer the table to the next generation. A later offer for the same state dir
 * replaces the earlier one: only the newest generation's table is worth
 * inheriting, and the older rows are already superseded.
 */
export function offerRows(dataDir: string, rows: readonly ExitNode[], graceMs: number = ROWS_GRACE_MS): void {
  if (rows.length === 0) return
  const state = box()
  const previous = state.offers.get(dataDir)
  if (previous?.timer !== undefined) clearTimeout(previous.timer)
  const lease: RowsLease = { rows: rows.map((row) => ({ ...row })), handedAt: Date.now() }
  lease.timer = setTimeout(() => {
    if (state.offers.get(dataDir) !== lease) return
    state.offers.delete(dataDir)
  }, graceMs)
  lease.timer.unref?.()
  state.offers.set(dataDir, lease)
}

/** Claim the offered table, cancelling its expiry; null when there is none. */
export function takeRows(dataDir: string): ExitNode[] | null {
  const state = box()
  const lease = state.offers.get(dataDir)
  if (lease === undefined) return null
  state.offers.delete(dataDir)
  if (lease.timer !== undefined) clearTimeout(lease.timer)
  lease.timer = undefined
  return lease.rows
}

/** Discard an offer without adopting it (tests, and a table that cannot be reused). */
export function dropRows(dataDir: string): void {
  const state = box()
  const lease = state.offers.get(dataDir)
  if (lease === undefined) return
  state.offers.delete(dataDir)
  if (lease.timer !== undefined) clearTimeout(lease.timer)
  lease.timer = undefined
}
