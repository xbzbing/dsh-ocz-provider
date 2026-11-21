/**
 * The browser half's entry point to the exit-row rule.
 *
 * The rule itself lives in `src/pool/row-state.ts`: the host's 「立即验证」
 * action filters rows with the SAME function, so one click probes exactly the
 * rows the 状态 column calls 待验证. Re-exported here because every browser
 * surface (and its tests) already reach for this module.
 */
export { exitRowState, needsVerification, type ExitRowState, type RowStateFacts } from '../pool/row-state.ts'
