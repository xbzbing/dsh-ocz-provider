/**
 * Persistent usage ledger: these tests drive the real file in a temp
 * directory — the whole point of the store is what survives a restart, which
 * a mocked fs would not prove.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { UsageStore, USAGE_RETENTION_DAYS, defaultUsagePath, localDay, sumTotals } from '../src/pool/usage-store.ts'

function tempPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'usage-store-'))
  return { dir, path: join(dir, 'usage.json') }
}

/** One response's usage with a controllable decode window. */
const usage = (input: number, output: number, durationMs = 1000): { inputTokens: number; outputTokens: number; durationMs: number } =>
  ({ inputTokens: input, outputTokens: output, durationMs })

test('a recorded response lands in every breakdown, and survives a restart', async () => {
  const { dir, path } = tempPath()
  try {
    const store = new UsageStore({ path, flushMs: 0, now: () => Date.UTC(2026, 9, 14, 3, 0, 0) })
    store.record('127.0.0.1:30001', usage(100, 50), { session: 'ses_abc', label: 'write a changelog' })
    store.record('127.0.0.1:30001', usage(20, 10, 500), { session: 'ses_abc', label: 'write a changelog' })
    store.record('local', usage(5, 5), { session: 'ses_xyz', label: 'other conversation' })
    await store.flush()

    assert.equal(store.totals().requests, 3)
    assert.equal(store.totals().inputTokens, 125)
    assert.equal(store.totals().outputTokens, 65)
    assert.equal(store.exitTotals('127.0.0.1:30001', 'total').requests, 2)
    assert.equal(store.exitTotals('local', 'total').requests, 1)
    assert.equal(store.days('total').length, 1)
    assert.equal(store.days('total')[0]!.day, '2026-10-14')
    assert.deepEqual(store.sessions('total', 10).map((row) => [row.label, row.totals.requests]), [
      ['write a changelog', 2],
      ['other conversation', 1],
    ], 'heaviest session first, with its readable label')

    // The restart story: a fresh store on the same file sees the same numbers.
    const reloaded = new UsageStore({ path, flushMs: 0 })
    assert.equal(reloaded.totals().requests, 3)
    assert.equal(reloaded.exitTotals('127.0.0.1:30001', 'total').requests, 2)
    assert.equal(reloaded.sessions('total', 10)[0]!.label, 'write a changelog')
    assert.equal(reloaded.days('total')[0]!.day, '2026-10-14')
    // ...while the run scope of the NEW process is empty: that is the switch.
    assert.equal(reloaded.runTotals().requests, 0)
    assert.equal(reloaded.exitTotals('127.0.0.1:30001', 'run').requests, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the run scope counts this process only, the total scope counts everything', async () => {
  const { dir, path } = tempPath()
  try {
    const first = new UsageStore({ path, flushMs: 0 })
    first.record('a:1', usage(10, 10), { session: 'ses_1', label: 'one' })
    await first.flush()

    const second = new UsageStore({ path, flushMs: 0 })
    second.record('a:1', usage(1, 1), { session: 'ses_1', label: 'one' })
    assert.equal(second.exitTotals('a:1', 'run').requests, 1, '本次重启 counts the new process only')
    assert.equal(second.exitTotals('a:1', 'total').requests, 2, '总览 keeps the earlier process')
    assert.equal(second.runTotals().requests, 1)
    assert.equal(second.totals().requests, 2)
    assert.equal(second.sessions('run', 5)[0]!.totals.requests, 1)
    assert.equal(second.sessions('total', 5)[0]!.totals.requests, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clear() empties every bucket and persists the empty document', async () => {
  // The 清空 button wipes every bucket, not just the headline totals.
  const { dir, path } = tempPath()
  try {
    const store = new UsageStore({ path, flushMs: 0, now: () => Date.UTC(2026, 9, 14, 3, 0, 0) })
    store.record('127.0.0.1:30001', usage(100, 50), { session: 'ses_a', label: 'conversation' })
    store.record('local', usage(5, 5), { session: 'ses_b', label: 'other' })
    await store.flush()
    assert.equal(store.totals().requests, 2)

    await store.clear()
    assert.equal(store.totals().requests, 0)
    assert.equal(store.runTotals().requests, 0, '本次重启 goes with it — a cleared 总览 beside a live run reads as a bug')
    assert.deepEqual(store.sessions('total', 10), [])
    assert.deepEqual(store.days('total'), [])
    assert.equal(store.exitTotals('127.0.0.1:30001', 'total').requests, 0)

    // The clear has to be ON DISK, or a restart resurrects everything.
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
      totals: { requests: number }
      sessions: Record<string, unknown>
      exits: Record<string, unknown>
    }
    assert.equal(onDisk.totals.requests, 0)
    assert.deepEqual(Object.keys(onDisk.sessions), [])
    assert.deepEqual(Object.keys(onDisk.exits), [])

    const reloaded = new UsageStore({ path, flushMs: 0 })
    assert.equal(reloaded.totals().requests, 0, 'a fresh process sees the cleared ledger')
    assert.deepEqual(reloaded.sessions('total', 10), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clear() works on a store that has not read the file yet', async () => {
  // The trap this guards: flush() loads first, so a clear that skipped load()
  // would merge the old document back over the clear.
  const { dir, path } = tempPath()
  try {
    const seeded = new UsageStore({ path, flushMs: 0 })
    seeded.record('a:1', usage(10, 10), { session: 'ses_1', label: 'one' })
    await seeded.flush()

    const fresh = new UsageStore({ path, flushMs: 0 }) // never read the file
    await fresh.clear()
    assert.equal(fresh.totals().requests, 0)
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { totals: { requests: number } }).totals.requests, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OC2DSH_HOME redirects the default ledger path, and is read lazily', async () => {
  // The store built by the real entry is built at import time — before a test
  // body can set anything — so the redirect only works because the path is
  // resolved per use.
  const before = process.env.OC2DSH_HOME
  const dir = mkdtempSync(join(tmpdir(), 'oc2dsh-home-'))
  try {
    delete process.env.OC2DSH_HOME
    assert.equal(defaultUsagePath(), join(homedir(), '.dsh', 'oc2dsh', 'usage.json'), 'the production default is untouched')
    const store = new UsageStore({ flushMs: 0 }) // no injected path: follows the env
    process.env.OC2DSH_HOME = dir
    assert.equal(defaultUsagePath(), join(dir, 'usage.json'))
    assert.equal(store.path, join(dir, 'usage.json'), 'the redirect applies after construction')
    store.record('local', usage(3, 4), { session: 'ses_scratch', label: 'hi' })
    await store.flush()
    assert.ok(existsSync(join(dir, 'usage.json')), 'the ledger landed under the override')
    assert.equal(JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')).sessions.ses_scratch.label, 'hi')
  } finally {
    if (before === undefined) delete process.env.OC2DSH_HOME
    else process.env.OC2DSH_HOME = before
    rmSync(dir, { recursive: true, force: true })
  }
})

test('day buckets are trimmed to the retention window; the all-time total is not', async () => {
  const { dir, path } = tempPath()
  try {
    const now = Date.UTC(2026, 9, 14, 3, 0, 0)
    const fresh = new UsageStore({ path, flushMs: 0, now: () => now })
    fresh.record('a:1', usage(1, 1), { session: 'ses_new', label: 'recent' })
    await fresh.flush()

    // Hand-edit an ancient day into the document: 120 days before `now`.
    const document = JSON.parse(readFileSync(path, 'utf8')) as { days: Record<string, unknown> }
    const old = localDay(now - 120 * 24 * 60 * 60 * 1000)
    document.days[old] = { requests: 9, inputTokens: 9, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 18, outputMs: 0 }
    writeFileSync(path, JSON.stringify(document), 'utf8')

    const reloaded = new UsageStore({ path, flushMs: 0, now: () => now })
    assert.deepEqual(reloaded.days('total').map((row) => row.day), [localDay(now)], 'the expired day is gone')
    assert.equal(USAGE_RETENTION_DAYS, 90)
    assert.equal(reloaded.retentionDays, 90)
    // The cumulative figure is the operator's "what have I spent" number, so it
    // must not silently drop when a day bucket ages out.
    assert.equal(reloaded.totals().requests, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt ledger starts fresh instead of failing every request', async () => {
  const { dir, path } = tempPath()
  try {
    writeFileSync(path, '{ this is not json', 'utf8')
    const store = new UsageStore({ path, flushMs: 0 })
    store.record('a:1', usage(1, 1), { session: 'ses_1', label: 'x' })
    assert.equal(store.totals().requests, 1)
    await store.flush()
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1, 'the next flush rewrites a good document')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a read-only store never touches the disk', async () => {
  const { dir, path } = tempPath()
  try {
    const store = new UsageStore({ path, flushMs: 0, readOnly: true })
    store.record('a:1', usage(1, 1), { session: 'ses_1', label: 'x' })
    await store.flush()
    assert.equal(store.totals().requests, 1, 'the in-memory view still works')
    assert.throws(() => readFileSync(path, 'utf8'), 'and nothing was written')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessions and exits are capped by last activity', async () => {
  const { dir, path } = tempPath()
  try {
    let clock = Date.UTC(2026, 9, 1)
    const store = new UsageStore({ path, flushMs: 0, now: () => (clock += 1000) })
    for (let index = 0; index < 520; index += 1) {
      store.record(`exit:${index}`, usage(1, 1), { session: `ses_${index}`, label: `s${index}` })
    }
    store.prune()
    assert.equal(store.size().sessions, 500, 'the 500 most recent sessions are kept')
    assert.equal(store.size().exits, 200, 'and the 200 most recent exits')
    const ids = store.sessions('total', 1000).map((row) => row.id)
    assert.ok(ids.includes('ses_519'), 'the newest session survived')
    assert.ok(!ids.includes('ses_0'), 'the oldest was dropped')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sumTotals adds every bucket field', () => {
  const total = sumTotals([
    { requests: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 30, outputMs: 1000 },
    { requests: 2, inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3, outputMs: 500 },
  ])
  assert.deepEqual(total, { requests: 3, inputTokens: 11, outputTokens: 22, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 33, outputMs: 1500 })
})

test('localDay keys by the local calendar, not UTC', () => {
  // 2026-10-14 07:00 in Shanghai is 2026-10-13 23:00 UTC: the bucket has to
  // follow the operator's own day or "每天" would split their evenings.
  const shanghaiMorning = new Date('2026-10-14T07:00:00+08:00').getTime()
  assert.equal(localDay(shanghaiMorning), '2026-10-14')
})
