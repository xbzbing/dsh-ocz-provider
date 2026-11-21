/**
 * Process-level handoff of the routing layer across a plugin reload.
 *
 * Another plugin's install/uninstall recomposes the profile, and HMR stops and
 * re-applies the entries whose modules it saw change — in the same process, a
 * fraction of a second apart. Disposing the routing layer would leave that
 * window unrouted: every request in the process would egress from this machine
 * (or fail against the lane) until the next generation installed again.
 *
 * So dispose OFFERS the live installer here instead of closing it. The next
 * generation CLAIMS it and swaps its own pool under the still-installed layer
 * (installer.retarget), so the slot never empties. A lease nobody claims — a
 * real uninstall, or a host that stays up with the plugin gone — is closed by
 * its timer, exactly like the relay lease.
 *
 * The holder lives on `globalThis` because HMR evicts the plugin's modules: a
 * module-scoped holder would be empty again in the next generation.
 */
/**
 * What a lease holds: the installed layer, minimal so the seam does not pull
 * undici (or the installer's module graph) into a settings-only import.
 */
export interface SlottedLayer {
  /** Close the layer: the teardown an uninstall would have done. */
  disable(): void
}

export interface SlotLease {
  installer: SlottedLayer
  /** Epoch ms the offering generation disposed (diagnostics). */
  handedAt: number
  timer?: NodeJS.Timeout
}

interface LeaseBox {
  lease: SlotLease | null
  exitHooked: boolean
}

/**
 * How long an unclaimed layer keeps routing. It must cover uninstall + install
 * + the next apply (a `dsh plugin add` runs pnpm in between), and the cost of
 * being wrong is bounded: an uninstalled plugin keeps steering model traffic
 * for this long, then the layer closes by itself.
 */
export const SLOT_GRACE_MS = 60_000

const LEASE_KEY = Symbol.for('oc2dsh.slot.lease')

function box(): LeaseBox {
  const holder = globalThis as unknown as Record<symbol, LeaseBox | undefined>
  const existing = holder[LEASE_KEY]
  if (existing !== undefined) return existing
  const created: LeaseBox = { lease: null, exitHooked: false }
  holder[LEASE_KEY] = created
  return created
}

/**
 * Offer the installed layer to the next generation. An unclaimed lease from an
 * earlier handoff is closed first: only one layer may outlive its generation,
 * and the stale one has already lost its adopter.
 */
export function offerSlot(installer: SlottedLayer, graceMs: number = SLOT_GRACE_MS): void {
  const state = box()
  if (state.lease !== null) closeLease(state.lease)
  installSlotExitHook()
  const lease: SlotLease = { installer, handedAt: Date.now() }
  state.lease = lease
  lease.timer = setTimeout(() => {
    if (state.lease !== lease) return
    state.lease = null
    closeLease(lease)
  }, graceMs)
  lease.timer.unref?.()
}

/** Claim the offered layer, cancelling its close timer; null when there is none. */
export function takeSlot(): SlotLease | null {
  const state = box()
  const lease = state.lease
  if (lease === null) return null
  state.lease = null
  if (lease.timer !== undefined) clearTimeout(lease.timer)
  lease.timer = undefined
  return lease
}

/** Close a lease's layer: the same teardown an uninstall would have done. */
export function closeLease(lease: SlotLease): void {
  try {
    lease.installer.disable()
  } catch {
    // a layer already closed by the host leaves nothing to tear down
  }
}

/** Discard a lease without adopting it (tests, and a layer that cannot be reused). */
export function dropSlot(): void {
  const lease = takeSlot()
  if (lease !== null) closeLease(lease)
}

/**
 * Close whatever is still leased when the process exits: a graceful dispose
 * hands the layer over, and the process ending is the one case where nobody
 * will ever claim it.
 */
export function installSlotExitHook(): void {
  const state = box()
  if (state.exitHooked) return
  state.exitHooked = true
  process.once('exit', () => {
    const lease = state.lease
    if (lease === null) return
    state.lease = null
    closeLease(lease)
  })
}
