/**
 * Reload handoff of the routing layer (pool/slot-lease.ts + installer.retarget).
 *
 * Another plugin's install recomposes the profile and HMR re-applies this
 * plugin in the same process. Closing the routing layer on that dispose leaves
 * every request unrouted until the next generation installs; the lease hands
 * the installed layer over instead, and adoption only swaps the pool under it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RoutingInstaller } from '../src/pool/installer.ts'
import { PoolRoutingDispatcher } from '../src/pool/dispatcher.ts'
import { dropSlot, offerSlot, takeSlot } from '../src/pool/slot-lease.ts'
import { startIpPool } from '../src/ip-pool.ts'
import type { ExitPool } from '../src/pool/pool.ts'

const quiet = { info: () => {}, warn: () => {} }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A layer the lease only has to be able to close. */
function fakeLayer() {
  const calls: string[] = []
  return {
    calls,
    retargets: [] as ExitPool[],
    retargetError: false,
    disable(): void {
      calls.push('disable')
    },
  }
}

/** Minimal undici stand-in: a dispatcher slot with the real setter semantics. */
function makeUndiciStub() {
  class Agent {
    async close(): Promise<void> {}
    async destroy(): Promise<void> {}
    dispatch(): boolean {
      return true
    }
  }
  const initial = new Agent()
  let slot: unknown = initial
  return {
    Agent,
    initial,
    fetch: function moduleFetch(): Promise<unknown> {
      return Promise.resolve({ ok: true })
    },
    getGlobalDispatcher: (): unknown => slot,
    setGlobalDispatcher(next: unknown): undefined {
      slot = next
      return undefined
    },
    peek: (): unknown => slot,
    replace(next: unknown): void {
      slot = next
    },
  }
}

/** The installer's pool seam; retarget itself never touches these. */
function makePoolStub() {
  return {
    get: () => null,
    pick: () => null,
    has: () => false,
    list: () => [],
    snapshot: () => ({ total: 0 }),
    recordPassive: () => 'ok',
    recordPassiveTransport: () => {},
    rerouteSession: () => {},
  } as unknown as ExitPool
}

test('slot lease: the next generation claims the same layer and disarms the timer', async () => {
  const layer = fakeLayer()
  offerSlot(layer, 20)
  const taken = takeSlot()
  assert.equal(taken?.installer, layer, 'the offered layer is what comes back')
  assert.notEqual(taken?.handedAt, undefined)
  await sleep(60)
  assert.deepEqual(layer.calls, [], 'a claimed layer is never closed by the grace timer')
})

test('slot lease: an unclaimed layer closes after the grace window', async () => {
  const layer = fakeLayer()
  offerSlot(layer, 10)
  await sleep(60)
  assert.deepEqual(layer.calls, ['disable'], 'nobody claimed it, so the layer ends like an uninstall')
  assert.equal(takeSlot(), null, 'and it is gone from the box')
})

test('slot lease: a second offer closes the earlier layer', async () => {
  const first = fakeLayer()
  const second = fakeLayer()
  offerSlot(first, 10_000)
  offerSlot(second, 10_000)
  assert.deepEqual(first.calls, ['disable'], 'only one layer may outlive its generation')
  dropSlot()
  assert.deepEqual(second.calls, ['disable'], 'dropSlot closes the offered layer without adopting it')
})

test('retarget: the slot keeps pointing at a live routing layer with the new pool', () => {
  const undici = makeUndiciStub()
  const installer = new RoutingInstaller({
    pool: makePoolStub(),
    undici: undici as never,
    proxyHosts: ['opencode.ai'],
    logger: quiet,
  })
  installer.install()
  const before = undici.peek()
  assert.ok(before instanceof PoolRoutingDispatcher)

  const nextPool = makePoolStub()
  assert.equal(installer.retarget(nextPool, { onTransportCut: () => {}, logger: quiet }), true)
  assert.equal(installer.enabled, true, 'adoption keeps the layer enabled')
  const after = undici.peek()
  assert.ok(after instanceof PoolRoutingDispatcher, 'the slot still holds a routing layer')
  assert.notEqual(after, before, 'the retired router is replaced, not reused')
  assert.equal((before as { closed?: boolean }).closed, true, 'in-flight requests finish on the retired router, which then closes')
})

test('retarget: false when the layer is not the routing in force', () => {
  const undici = makeUndiciStub()
  const installer = new RoutingInstaller({
    pool: makePoolStub(),
    undici: undici as never,
    proxyHosts: ['opencode.ai'],
    logger: quiet,
  })
  assert.equal(installer.retarget(makePoolStub(), {}), false, 'a layer that was never installed cannot be adopted')

  installer.install()
  undici.replace(new undici.Agent())
  assert.equal(installer.retarget(makePoolStub(), {}), false, 'a slot taken by another layer is not ours to keep')
})

/**
 * A layer that models the reload seam: install is idempotent (like the real
 * installer), disable/dispose are counted, and retarget records the pool it was
 * handed.
 */
function adoptableLayer() {
  let enabled = false
  const calls: string[] = []
  const retargets: ExitPool[] = []
  const layer = {
    calls,
    retargets,
    retargetError: false,
    get enabled(): boolean {
      return enabled
    },
    install(): void {
      if (enabled) return
      calls.push('install')
      enabled = true
    },
    disable(): void {
      calls.push('disable')
      enabled = false
    },
    dispose(): void {
      calls.push('dispose')
      enabled = false
    },
    retarget(pool: ExitPool): boolean {
      retargets.push(pool)
      if (layer.retargetError) return false
      enabled = true
      return true
    },
  }
  return layer
}

test('assembly: a re-apply claims the offered layer instead of rebuilding the slot', async () => {
  const layer = adoptableLayer()
  let built = 0
  const makeInstaller = (): typeof layer => {
    built += 1
    return layer
  }
  try {
    const first = await startIpPool({ ipPool: { enabled: true } }, quiet, {
      makeInstaller: makeInstaller as never,
      slotLease: true,
    })
    assert.ok(first !== null)
    assert.deepEqual(layer.calls, ['install'], 'the first generation installs the layer')
    await first!.dispose()

    const second = await startIpPool({ ipPool: { enabled: true } }, quiet, {
      makeInstaller: makeInstaller as never,
      slotLease: true,
    })
    assert.ok(second !== null)
    assert.equal(built, 1, 'the reload builds no second layer')
    assert.equal(layer.retargets.length, 1, 'the live layer is re-pointed at the new pool')
    assert.equal(layer.retargets[0], second!.pool)
    assert.deepEqual(layer.calls, ['install'], 'no close and no re-install: the slot never emptied')
    await second!.dispose()
  } finally {
    dropSlot()
  }
})

test('assembly: a layer that cannot be re-pointed is closed and replaced', async () => {
  const layer = adoptableLayer()
  layer.retargetError = true
  let built = 0
  const makeInstaller = (): typeof layer => {
    built += 1
    return layer
  }
  try {
    const first = await startIpPool({ ipPool: { enabled: true } }, quiet, {
      makeInstaller: makeInstaller as never,
      slotLease: true,
    })
    await first!.dispose()
    const second = await startIpPool({ ipPool: { enabled: true } }, quiet, {
      makeInstaller: makeInstaller as never,
      slotLease: true,
    })
    assert.ok(second !== null)
    assert.equal(built, 2, 'a refused adoption falls back to a fresh layer')
    assert.deepEqual(
      layer.calls,
      ['install', 'disable', 'install'],
      'the unusable layer is closed, then the new generation installs from scratch',
    )
    await second!.dispose()
  } finally {
    dropSlot()
  }
})
