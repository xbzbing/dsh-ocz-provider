/**
 * Reload handoff of the exit TABLE (pool/rows-lease.ts).
 *
 * Another plugin's install recomposes the profile and HMR re-applies this
 * plugin in the same process. The next generation rebuilds its table from
 * config, so without the offer the admitted subscription rows disappear from
 * the panel — and from pick() — until the next subscription round re-admits
 * them, while sing-box still listens on every port.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startIpPool } from '../src/ip-pool.ts'
import type { ExitNode } from '../src/pool/pool.ts'
import { dropRows, offerRows, takeRows } from '../src/pool/rows-lease.ts'

const quiet = { info: () => {}, warn: () => {} }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function row(id: string, over: Partial<ExitNode> = {}): ExitNode {
  return {
    id,
    protocol: 'socks5',
    source: 'subscription',
    pinned: false,
    exitIP: '1.1.1.1',
    exitLocation: 'HK city',
    latencyMs: 300,
    quality: 'S',
    addedAt: 1,
    ...over,
  }
}

/** A routing layer the assembly can install, count and tear down. */
function adoptableLayer() {
  let enabled = false
  const calls: string[] = []
  const layer = {
    calls,
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
  }
  return layer
}

/** A temp state dir, so nothing here touches the operator's own ledger. */
function withStateDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'oc2dsh-rows-'))
  const previous = process.env.OC2DSH_HOME
  process.env.OC2DSH_HOME = dir
  return run(dir).finally(() => {
    dropRows(dir)
    if (previous === undefined) delete process.env.OC2DSH_HOME
    else process.env.OC2DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  })
}

test('rows lease: an offer is claimed once and carries a copy of the rows', () => {
  const offered = [row('127.0.0.1:30001')]
  offerRows('/state/a', offered, 10_000)
  // The offering generation keeps mutating its own objects after dispose: the
  // claim must not see those writes.
  offered[0]!.latencyMs = 9_999

  const taken = takeRows('/state/a')
  assert.equal(taken?.length, 1)
  assert.equal(taken?.[0]?.latencyMs, 300, 'the lease holds a snapshot')
  assert.equal(takeRows('/state/a'), null, 'a claimed offer is gone')
  dropRows('/state/a')
})

test('rows lease: an unclaimed offer expires, and an empty table is never offered', async () => {
  offerRows('/state/b', [row('127.0.0.1:30002')], 10)
  await sleep(60)
  assert.equal(takeRows('/state/b'), null, 'nobody claimed it, so the rows are dropped')

  offerRows('/state/b', [], 10_000)
  assert.equal(takeRows('/state/b'), null, 'an empty table has nothing to inherit')
})

test('rows lease: a newer offer replaces the older one, and state dirs do not mix', () => {
  offerRows('/state/c', [row('127.0.0.1:30003')], 10_000)
  offerRows('/state/c', [row('127.0.0.1:30004')], 10_000)
  offerRows('/state/d', [row('127.0.0.1:30005')], 10_000)

  assert.deepEqual(takeRows('/state/c')?.map((entry) => entry.id), ['127.0.0.1:30004'], 'only the newest table is inherited')
  assert.deepEqual(takeRows('/state/d')?.map((entry) => entry.id), ['127.0.0.1:30005'], 'one profile cannot adopt another profile rows')
  dropRows('/state/c')
  dropRows('/state/d')
})

test('assembly: a reload keeps the subscription rows the outgoing generation offered', async () => {
  await withStateDir(async (dir) => {
    const layer = adoptableLayer()
    const first = await startIpPool({ ipPool: { enabled: true } }, quiet, { makeInstaller: ((): typeof layer => layer) as never, rowsLease: true })
    assert.ok(first !== null)
    // What the subscription round would have admitted at runtime.
    assert.equal(first!.pool.add(row('127.0.0.1:30011', { exitIP: '9.9.9.9' })), true)
    assert.equal(first!.pool.add(row('127.0.0.1:30012', { exitIP: '9.9.9.10' })), true)
    await first!.dispose()

    const second = await startIpPool({ ipPool: { enabled: true } }, quiet, { makeInstaller: ((): typeof layer => layer) as never, rowsLease: true })
    assert.ok(second !== null)
    assert.equal(second!.pool.has('127.0.0.1:30011'), true, 'the converted exit is back in the table')
    assert.equal(second!.pool.has('127.0.0.1:30012'), true)
    const kept = second!.pool.list()
    assert.equal(kept.length, 2)
    assert.equal(kept[0]?.exitIP, '9.9.9.9', 'the row keeps the facts the earlier generation measured')
    assert.equal(kept[0]?.health.state, 'unknown', 'and claims no health it has not proven again')
    assert.equal(takeRows(dir), null, 'the offer was claimed at assembly, not left behind')
    // Disposing the second generation offers the same table to a third one.
    await second!.dispose()
    assert.deepEqual(takeRows(dir)?.map((entry) => entry.id), ['127.0.0.1:30011', '127.0.0.1:30012'])
    dropRows(dir)
  })
})

test('assembly: a disabled pool claims nothing; an empty table offers nothing', async () => {
  await withStateDir(async (dir) => {
    offerRows(dir, [row('127.0.0.1:30021')], 10_000)
    const layer = adoptableLayer()
    const disabled = await startIpPool({ ipPool: { enabled: false } }, quiet, { makeInstaller: ((): typeof layer => layer) as never, rowsLease: true })
    assert.ok(disabled !== null)
    assert.equal(disabled!.pool.snapshot().total, 0, 'a switched-off pool does not resurrect an exit table')
    await disabled!.dispose()
    assert.equal(takeRows(dir)?.length, 1, 'nothing claimed the offer, so it still stands')
    dropRows(dir)

    const cold = await startIpPool({ ipPool: { enabled: true } }, quiet, { makeInstaller: ((): typeof layer => layer) as never, rowsLease: true })
    assert.ok(cold !== null)
    assert.equal(cold!.pool.snapshot().total, 0, 'no rows, no table')
    await cold!.dispose()
    assert.equal(takeRows(dir), null, 'an empty table offers nothing')
  })
})
