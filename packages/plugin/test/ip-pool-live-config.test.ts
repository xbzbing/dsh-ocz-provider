/**
 * Live-config tests for the pool assembly: manual rows and 固定主力 are part
 * of the settings card's contract (docs §5.1 / IP-5 "保存即生效无需重启"), and a
 * pool that assembles EMPTY must engage routing by itself once the first exit
 * lands (subscription admissions included).
 *
 * The real startIpPool runs here; only the installer is faked, so nothing
 * touches a global dispatcher or the network (the free refill loop is off in
 * every config below).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import { buildPoolFromConfig, startIpPool, syncManualExits } from '../src/ip-pool.ts'

const quiet = { info: () => {}, warn: () => {} }

function node(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: 'h:1',
    protocol: 'socks5',
    source: 'subscription',
    pinned: false,
    exitIP: '',
    exitLocation: '',
    latencyMs: 0,
    quality: 'S',
    addedAt: 0,
    ...overrides,
  }
}

const ids = (pool: ExitPool): string[] => pool.list().map((entry) => entry.id).sort()

/** Fake installer: records calls, keeps every global untouched. */
function fakeInstaller() {
  const calls: string[] = []
  let enabled = false
  return {
    calls,
    install(): void {
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
    get enabled(): boolean {
      return enabled
    },
    deferredReason: null as string | null,
  }
}

// -- syncManualExits: the one path assembly and live commits share -------------

test('syncManualExits: assembly parity with buildPoolFromConfig', () => {
  const config = {
    ipPool: {
      manual: ['http://127.0.0.1:7890', 'socks5://127.0.0.1:1080'],
      pinnedExitId: 'http://127.0.0.1:7890',
    },
  }
  const pool = buildPoolFromConfig(config)
  assert.deepEqual(ids(pool), ['http://127.0.0.1:7890', 'socks5://127.0.0.1:1080'])
  assert.equal(pool.pinnedId, 'http://127.0.0.1:7890')
  assert.equal(pool.get('http://127.0.0.1:7890')?.pinned, true, 'the pinned row carries the flag admission reads')
  assert.equal(pool.get('socks5://127.0.0.1:1080')?.source, 'manual')
})

test('syncManualExits: an edit drops the old rows and re-pins, no restart', () => {
  // Regression (live 2026-10-12): editing 固定主力 in the settings card wrote
  // the config and reconfigured the runtime, but manual/pinned were read only
  // at assembly — the stale pin kept winning pick() until a restart.
  const pool = new ExitPool()
  syncManualExits(pool, { manual: ['http://a:1', 'http://b:2'], pinnedExitId: 'http://a:1' })
  syncManualExits(pool, { manual: ['http://b:2', 'http://c:3'], pinnedExitId: 'http://c:3' })
  assert.deepEqual(ids(pool), ['http://b:2', 'http://c:3'], 'the deleted row left the table')
  assert.equal(pool.pinnedId, 'http://c:3', 'the new 固定主力 took over')

  syncManualExits(pool, { manual: ['http://b:2', 'http://c:3'], pinnedExitId: '' })
  assert.equal(pool.pinnedId, '', 'clearing 固定主力 unpins live')
  assert.ok(pool.list().every((entry) => !entry.pinned), 'no stale pinned flag survives the unpin')
})

test('syncManualExits: idempotent, keeps probe state, never touches other sources', () => {
  const pool = new ExitPool()
  pool.add(node({ id: '10.0.0.9:1080', exitIP: '9.9.9.9' }))
  syncManualExits(pool, { manual: ['http://a:1'] })
  pool.markDead('http://a:1')
  syncManualExits(pool, { manual: ['http://a:1'] })
  assert.deepEqual(ids(pool), ['10.0.0.9:1080', 'http://a:1'])
  assert.equal(pool.list().find((entry) => entry.id === 'http://a:1')?.health.state, 'dead', 're-applying the same config must not reset probe state')
})

test('syncManualExits: pinning an admitted exit keeps the row and its source', () => {
  const pool = new ExitPool()
  pool.add(node({ id: '127.0.0.1:30005', exitIP: '1.2.3.4' }))
  syncManualExits(pool, { pinnedExitId: '127.0.0.1:30005' })
  assert.equal(pool.get('127.0.0.1:30005')?.source, 'subscription', 'pinning must not re-label the row manual')
  assert.equal(pool.pinnedId, '127.0.0.1:30005')
  assert.equal(pool.get('127.0.0.1:30005')?.pinned, true)
})

// -- assembly wiring -----------------------------------------------------------

test('assembly: an empty pool installs nothing; the first admitted exit engages routing', async () => {
  // Regression (live 2026-10-12): a subscription-only profile assembled empty,
  // filled up minutes later, and NEVER installed the dispatcher — the card
  // reported the pool as enabled while every request kept going direct. The
  // free refill loop had its own hook; nothing watched subscription admissions.
  const installer = fakeInstaller()
  const runtime = await startIpPool(
    { ipPool: { enabled: true, free: { enabled: false } } },
    quiet,
    { makeInstaller: () => installer },
  )
  assert.ok(runtime !== null)
  assert.deepEqual(installer.calls, [], 'nothing to route through yet')

  runtime.pool.add(node({ id: '127.0.0.1:30005' }))
  assert.deepEqual(installer.calls, ['install'], 'the first exit engages routing without a settings save')
  assert.equal(runtime.installer.enabled, true)

  runtime.pool.add(node({ id: '127.0.0.1:30006' }))
  assert.deepEqual(installer.calls, ['install'], 'already engaged: no re-install per admission')
  await runtime.dispose()
})

test('assembly: manual rows and the pin apply live through reconfigure', async () => {
  const installer = fakeInstaller()
  const runtime = await startIpPool(
    { ipPool: { enabled: true, free: { enabled: false } } },
    quiet,
    { makeInstaller: () => installer },
  )
  assert.ok(runtime !== null)

  await runtime.reconfigure({
    ipPool: { enabled: true, free: { enabled: false }, manual: ['http://127.0.0.1:7890'], pinnedExitId: 'http://127.0.0.1:7890' },
  })
  assert.deepEqual(ids(runtime.pool), ['http://127.0.0.1:7890'])
  assert.equal(runtime.pool.pinnedId, 'http://127.0.0.1:7890')

  await runtime.reconfigure({ ipPool: { enabled: true, free: { enabled: false }, manual: [], pinnedExitId: '' } })
  assert.deepEqual(ids(runtime.pool), [], 'the removed row leaves the live table')
  assert.equal(runtime.pool.pinnedId, '', 'and the pin is released — the exact edit that used to need a restart')
  await runtime.dispose()
})
