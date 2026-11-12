/**
 * One exit row's state, as the two tables name it.
 *
 * Both surfaces (the settings card's exit table and the stats modal) ask this
 * one function, because the precedence is a rule, not styling: a dead row that
 * is also demoted is still dead, and a row with no health claim is only
 * 「未验证」 when nothing ever measured it.
 *
 * `unproven` is the case that used to be folded into the untested one: the row
 * HAS an exit IP (this machine measured the tunnel and where it exits) but no
 * health claim — a port that now serves another node, or a row whose lane probe
 * failed. Reading 「未验证」 there told an operator "never tested" about a row
 * carrying a fresh exit IP and latency. The upstream abuse flag (`abusive`) is
 * the card's own branch and outranks all of this: it is a reputation verdict,
 * not a liveness state.
 */
import type { ExitRowView } from './types.ts'

/** Which state one {@link ExitRowView} names, highest precedence first. */
export type ExitRowState = 'dead' | 'demoted' | 'cooling' | 'usable' | 'unproven' | 'unknown'

/** Classify one row. Pure: the caller owns the wording and the dot colour. */
export function exitRowState(exit: ExitRowView): ExitRowState {
  if (exit.state === 'dead') return 'dead'
  // Demoted = kept but ranked last (upstream refused it, no reserve left).
  if (exit.demoted === true) return 'demoted'
  if (exit.cooling) return 'cooling'
  if (exit.state === 'ok') return 'usable'
  // No claim, but this machine measured the exit: a different fault from a row
  // nothing ever reached.
  if (exit.exitIP !== '') return 'unproven'
  return 'unknown'
}
