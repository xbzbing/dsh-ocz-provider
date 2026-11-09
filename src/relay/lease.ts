/**
 * Process-level handoff of the running relay child.
 *
 * A plugin reload disposes the fiber that owns the relay, and the relay's TCP
 * connections to the free lane die with the child process. The lease keeps the
 * child alive across that dispose: the outgoing supervisor offers it here, the
 * incoming generation adopts it after a health probe, and a timer kills it
 * when nothing claims it — a reload hands the child over, an uninstall ends it.
 *
 * The holder lives on `globalThis` because HMR evicts the plugin's modules: a
 * module-scoped holder would be empty again in the next generation.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export interface RelayLease {
  child: ChildProcessWithoutNullStreams
  /** `http://127.0.0.1:<port>`, no token. */
  origin: string
  /** `origin` plus the per-spawn `/_/<token>` prefix. */
  baseUrl: string
  token: string
  /** Script the child runs; a different script is not ours to adopt. */
  scriptPath: string
  upstream: string
  /** The bun binary that started the child, so adoption keeps the status truthful. */
  bunPath: string | null
  orphanedAt: number
  timer?: NodeJS.Timeout
}

interface LeaseBox {
  lease: RelayLease | null
  exitHooked: boolean
}

const LEASE_KEY = Symbol.for('oc2dsh.relay.lease')

function box(): LeaseBox {
  const holder = globalThis as unknown as Record<symbol, LeaseBox | undefined>
  const existing = holder[LEASE_KEY]
  if (existing !== undefined) return existing
  const created: LeaseBox = { lease: null, exitHooked: false }
  holder[LEASE_KEY] = created
  return created
}

/**
 * Offer a live child to the next generation. An unclaimed lease from an
 * earlier reload is ended first: only one relay may survive at a time, and the
 * stale one has already lost its adopter.
 */
export function offerLease(lease: RelayLease, graceMs: number): void {
  const state = box()
  if (state.lease !== null) killLease(state.lease)
  installLeaseExitHook()
  state.lease = lease
  // The grace window is what a reload costs: it must cover uninstall +
  // install + the next apply, or the child is killed before its adopter runs.
  lease.timer = setTimeout(() => {
    if (state.lease !== lease) return
    state.lease = null
    killLease(lease)
  }, graceMs)
  lease.timer.unref?.()
}

/** Claim the offered child, cancelling the kill timer; null when there is none. */
export function takeLease(): RelayLease | null {
  const state = box()
  const lease = state.lease
  if (lease === null) return null
  state.lease = null
  if (lease.timer !== undefined) clearTimeout(lease.timer)
  lease.timer = undefined
  return lease
}

/** End an unclaimed child: stdin EOF is the relay's own shutdown, the signal is the fallback. */
export function killLease(lease: RelayLease): void {
  const child = lease.child
  try {
    child.stdin?.end()
  } catch {
    // already closed
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // already gone
  }
}

/** Discard a lease without adopting it (tests, and a lease that cannot be reused). */
export function dropLease(): void {
  const lease = takeLease()
  if (lease !== null) killLease(lease)
}

/**
 * Kill whatever is still leased when the process exits: a graceful dispose
 * hands the child over, and the process ending is the one case where nobody
 * will ever adopt it.
 */
export function installLeaseExitHook(): void {
  const state = box()
  if (state.exitHooked) return
  state.exitHooked = true
  process.once('exit', () => {
    const lease = state.lease
    if (lease === null) return
    state.lease = null
    killLease(lease)
  })
}
