/**
 * Process-level handoff of the sing-box child across a plugin reload.
 *
 * A reload torn down the supervisor and started another one, which rewrote the
 * config (the airport re-rolls every node's TLS fingerprint on each fetch, so
 * the file always "changed") and restarted the child — every converted exit
 * went unreachable for a second or more, and the pool struck the rows that had
 * requests in flight. The child keeps serving the SAME node set perfectly well,
 * so the outgoing supervisor offers it here and the incoming generation adopts
 * it when the semantic node identity (fingerprint-free) and the port list are
 * unchanged. A changed node set, a different binary or a dead port falls back
 * to the old stop-and-spawn path, and a lease nobody claims is ended by its
 * timer.
 *
 * The holder lives on `globalThis` because HMR evicts the plugin's modules.
 */
import type { ChildProcess } from 'node:child_process'

export interface SingBoxLease {
  child: ChildProcess
  /** Binary that started it; a different one is not ours to adopt. */
  binPath: string
  /** `basename(binPath)`, the sweep record's evidence on Windows. */
  binary: string
  /** Config path: the marker in the child record. */
  configPath: string
  dataDir: string
  /** Local ports the child is listening on, index-aligned with `keys`. */
  ports: number[]
  /**
   * Semantic identity of the node set it serves (pool/node-key.ts), in order.
   * The airport randomises TLS fingerprints per fetch, so this — not the
   * generated config — decides "same nodes".
   */
  keys: string[]
  handedAt: number
  timer?: NodeJS.Timeout
}

/** What an adopting supervisor must match to keep the running child. */
export interface SingBoxExpectation {
  binPath: string
  binary: string
  configPath: string
  dataDir: string
  ports: readonly number[]
  keys: readonly string[]
}

/**
 * How long an unclaimed child keeps holding the ports. It covers uninstall +
 * install + the next apply; a real uninstall leaves it unclaimed, and the
 * timer then ends it like `stop()` would have.
 */
export const SINGBOX_GRACE_MS = 60_000

interface LeaseBox {
  leases: Map<string, SingBoxLease>
  exitHooked: boolean
}

const LEASE_KEY = Symbol.for('oc2dsh.singbox.lease')

function box(): LeaseBox {
  const holder = globalThis as unknown as Record<symbol, LeaseBox | undefined>
  const existing = holder[LEASE_KEY]
  if (existing !== undefined) return existing
  const created: LeaseBox = { leases: new Map(), exitHooked: false }
  holder[LEASE_KEY] = created
  return created
}

/**
 * Whether `lease` is the child this expectation would have started itself.
 *
 * Identity, not order, decides "the same exits": a node's local port follows
 * its own identity (`ports.json`), so a subscription that comes back in a
 * different order still maps every node to the port the running child listens
 * on. Every node this generation wants to serve has to be there at the expected
 * port; extra listeners left in the child (reserves converted before) are
 * harmless and stay until the next real reload.
 */
export function matchesLease(lease: SingBoxLease, want: SingBoxExpectation): boolean {
  if (lease.binPath !== want.binPath || lease.binary !== want.binary) return false
  if (lease.configPath !== want.configPath || lease.dataDir !== want.dataDir) return false
  if (lease.child.exitCode !== null || lease.child.signalCode !== null) return false
  if (lease.keys.length !== lease.ports.length || want.keys.length !== want.ports.length) return false
  const served = new Map<string, number>()
  for (let index = 0; index < lease.keys.length; index += 1) {
    const key = lease.keys[index] ?? ''
    if (key === '' || served.has(key)) return false
    served.set(key, lease.ports[index] ?? 0)
  }
  const seen = new Set<string>()
  for (let index = 0; index < want.keys.length; index += 1) {
    const key = want.keys[index] ?? ''
    if (key === '' || seen.has(key)) return false
    seen.add(key)
    const port = served.get(key)
    // A port of 0 means the child has no inbound for that node (it was
    // converted in a narrower selection), so this generation must reload.
    if (port === undefined || port <= 0 || port !== (want.ports[index] ?? 0)) return false
  }
  return true
}

/** Offer a live child to the next generation (per data dir: one child each). */
export function offerSingBox(lease: SingBoxLease, graceMs: number = SINGBOX_GRACE_MS): void {
  const state = box()
  const previous = state.leases.get(lease.dataDir)
  if (previous !== undefined) closeSingBox(previous)
  installSingBoxExitHook()
  state.leases.set(lease.dataDir, lease)
  lease.timer = setTimeout(() => {
    if (state.leases.get(lease.dataDir) !== lease) return
    state.leases.delete(lease.dataDir)
    closeSingBox(lease)
  }, graceMs)
  lease.timer.unref?.()
}

/** Claim the offered child for `dataDir`, cancelling its close timer. */
export function takeSingBox(dataDir: string): SingBoxLease | null {
  const state = box()
  const lease = state.leases.get(dataDir)
  if (lease === undefined) return null
  state.leases.delete(dataDir)
  if (lease.timer !== undefined) clearTimeout(lease.timer)
  lease.timer = undefined
  return lease
}

/**
 * End a leased child: SIGINT first (sing-box exits cleanly, releasing the
 * ports), SIGKILL after a short grace so a wedged process cannot hold them.
 */
export function closeSingBox(lease: SingBoxLease): void {
  const child = lease.child
  try {
    child.kill('SIGINT')
  } catch {
    return
  }
  const kill = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }, 5_000)
  kill.unref?.()
}

/** Discard an offered child without adopting it (tests, and a mismatch). */
export function dropSingBox(dataDir: string): void {
  const lease = takeSingBox(dataDir)
  if (lease !== null) closeSingBox(lease)
}

/** End whatever is still leased when the process exits. */
export function installSingBoxExitHook(): void {
  const state = box()
  if (state.exitHooked) return
  state.exitHooked = true
  process.once('exit', () => {
    for (const lease of state.leases.values()) closeSingBox(lease)
    state.leases.clear()
  })
}
