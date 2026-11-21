/**
 * One exit row's state, as a rule rather than styling.
 *
 * Both browser surfaces (the settings card's exit table and the stats modal)
 * and the host's 「立即验证」 action ask this one function, because the
 * precedence IS the contract: a dead row that is also demoted is still dead,
 * and a row with no health claim is only 未验证 when nothing ever measured it.
 *
 * `unproven` is the case that used to be folded into the untested one: the row
 * HAS an exit IP (this machine measured the tunnel and where it exits) but no
 * health claim — a port that now serves another node, or a row whose lane probe
 * failed. Reading 未验证 there told an operator "never tested" about a row
 * carrying a fresh exit IP and latency, so it is named 待验证 instead. The
 * upstream abuse flag (`abusive`) is the card's own branch and outranks all of
 * this: it is a reputation verdict, not a liveness state.
 *
 * It lives host-side because the probe action needs the SAME rule to decide
 * which rows to verify; the browser half imports it from here
 * (`src/client/exit-state.ts` re-exports), so the two can never disagree.
 */

/** Which state one row names, highest precedence first. */
export type ExitRowState = 'dead' | 'demoted' | 'cooling' | 'usable' | 'unproven' | 'unknown'

/** The fields this rule reads, shared by the `/status` view and a pool row. */
export interface RowStateFacts {
  /** The health claim (`'ok'` = proven against the lane). */
  state: 'unknown' | 'ok' | 'dead'
  /** Inside a 429 cooldown right now. */
  cooling: boolean
  /** Measured exit address; empty = nothing ever reached this row. */
  exitIP: string
  /** Rejected upstream with no reserve left (kept as the last resort). */
  demoted?: boolean
}

/** Classify one row. Pure: the caller owns the wording and the dot colour. */
export function exitRowState(row: RowStateFacts): ExitRowState {
  if (row.state === 'dead') return 'dead'
  // Demoted = kept but ranked last (upstream refused it, no reserve left).
  if (row.demoted === true) return 'demoted'
  if (row.cooling) return 'cooling'
  if (row.state === 'ok') return 'usable'
  // No claim, but this machine measured the exit: a different fault from a row
  // nothing ever reached.
  if (row.exitIP !== '') return 'unproven'
  return 'unknown'
}

/**
 * Whether this row wants a verification pass: measured, not cooling, not
 * dead/demoted, and without a live claim. `ok` rows are skipped on purpose —
 * that is what makes 「立即验证」 cheap enough to press without thinking.
 */
export function needsVerification(row: RowStateFacts): boolean {
  return exitRowState(row) === 'unproven'
}
