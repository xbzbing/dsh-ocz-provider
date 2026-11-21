/**
 * The pool's learned health, kept across a restart or a plugin reload.
 *
 * A fresh pool starts every row at "nothing proven", which re-burns cooldowns
 * and bans the lane just handed out. The store keeps only facts that carry
 * their own clock, and an expired liveness claim falls back to `unknown` while
 * the measured facts stay (the card's 已测速·未验证).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ExitPool, type ExitNode, type SeededHealth } from '../src/pool/pool.ts'
import {
  ABUSIVE_TTL_MS,
  BAN_TTL_MS,
  DEAD_TTL_MS,
  FACTS_TTL_MS,
  PROVEN_TTL_MS,
  collectPoolHealth,
  loadPoolHealth,
  restorableRows,
  restorePoolHealth,
  startPoolHealthWriter,
  writePoolHealth,
  type PoolHealthDocument,
} from '../src/pool/pool-health.ts'

const T0 = 1_700_000_000_000

function node(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: 'h:1',
    protocol: 'socks5',
    source: 'manual',
    pinned: false,
    exitIP: '',
    exitLocation: '',
    latencyMs: 0,
    quality: 'C',
    addedAt: T0,
    ...overrides,
  }
}

function seededRow(overrides: Partial<SeededHealth> = {}): SeededHealth {
  return {
    state: 'unknown',
    lastProbedAt: 0,
    consecutiveLimited: 0,
    cooldownUntil: 0,
    deadStrikes: 0,
    deadAt: 0,
    note: '',
    noteAt: 0,
    ...overrides,
  }
}

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'pool-health-')), 'pool-health.json')

test('collect → restore keeps cooldowns, bans, counters, facts and the last-used stamp', () => {
  const pool = new ExitPool({ now: () => T0 })
  pool.add(node({ id: 'h:1', exitIP: '203.0.113.7', exitLocation: 'HK Central', latencyMs: 210, quality: 'S' }))
  pool.markLimited('h:1')
  pool.markModelBanned('h:1', 'big-pickle')
  pool.recordPassive('h:1', 429, 'big-pickle')
  pool.beginRequest('h:1')
  pool.endRequest('h:1')

  const doc = collectPoolHealth(pool, T0)
  const restored = new ExitPool({ now: () => T0 })
  restored.add(node({ id: 'h:1' }))
  assert.equal(restorePoolHealth(restored, doc, T0), 1)

  const row = restored.list()[0]!
  assert.equal(row.health.cooldownUntil, pool.list()[0]!.health.cooldownUntil, 'the cooldown deadline survives')
  assert.equal(row.health.consecutiveLimited, 2, 'so the next 429 backs off from the right step')
  assert.deepEqual(row.bans.map((entry) => [entry.model, entry.ban.state]), [['big-pickle', 'banned']])
  assert.deepEqual(restored.passiveStats('h:1'), { ok: 0, limited: 1, refused: 0, dead: 0, transport: 0 })
  assert.equal(row.exitIP, '203.0.113.7', 'measured facts come back')
  assert.equal(row.exitLocation, 'HK Central')
  assert.equal(row.quality, 'S')
  assert.equal(restored.activity('h:1').lastUsedAt, T0, '最后使用 survives; nothing is in flight')
  assert.equal(restored.activity('h:1').inFlight, 0)
})

test('a row that lands after assembly takes its record on add (subscription exits)', () => {
  const doc: PoolHealthDocument = {
    version: 1,
    savedAt: T0,
    exits: {
      '127.0.0.1:30001': {
        at: T0,
        state: 'ok',
        lastProbedAt: T0,
        consecutiveLimited: 2,
        cooldownUntil: T0 + 60_000,
        deadStrikes: 0,
        deadAt: 0,
        note: '',
        noteAt: 0,
        passive: { ok: 0, limited: 2, refused: 0, dead: 0, transport: 0 },
        facts: { exitIP: '198.51.100.9', exitLocation: 'SG', latencyMs: 300, quality: 'S' },
        lastUsedAt: T0,
        bans: [],
      },
    },
  }
  const pool = new ExitPool({ now: () => T0 })
  restorePoolHealth(pool, doc, T0)
  assert.equal(pool.list().length, 0, 'seeding never invents a row')

  pool.add(node({ id: '127.0.0.1:30001', source: 'subscription' }))
  const row = pool.list()[0]!
  assert.equal(row.health.state, 'ok')
  assert.equal(row.health.consecutiveLimited, 2)
  assert.equal(row.exitIP, '198.51.100.9', 'the measurement rides along with the row')
})

test('expired claims fall back to unknown, expired deadlines disappear', () => {
  const base: PoolHealthDocument['exits'][string] = {
    at: T0,
    state: 'ok',
    lastProbedAt: T0,
    consecutiveLimited: 3,
    cooldownUntil: T0 - 1,
    deadStrikes: 2,
    deadAt: 0,
    note: 'abusive',
    noteAt: T0 - ABUSIVE_TTL_MS - 1,
    passive: { ok: 1, limited: 3, refused: 0, dead: 0, transport: 0 },
    facts: { exitIP: '203.0.113.1', exitLocation: 'JP', latencyMs: 900, quality: 'A' },
    lastUsedAt: T0,
    bans: [
      { model: 'old-ban', state: 'banned', bannedAt: T0 - BAN_TTL_MS - 1, consecutiveFailures: 2 },
      { model: 'live-ban', state: 'banned', bannedAt: T0 - 60_000, consecutiveFailures: 2 },
      { model: 'suspect-only', state: 'suspect', bannedAt: T0, consecutiveFailures: 1 },
    ],
  }
  const doc: PoolHealthDocument = {
    version: 1,
    savedAt: T0,
    exits: {
      proven: { ...base },
      provenOld: { ...base, lastProbedAt: T0 - PROVEN_TTL_MS - 1 },
      dead: { ...base, state: 'dead', deadAt: T0 - 1 },
      deadOld: { ...base, state: 'dead', deadAt: T0 - DEAD_TTL_MS - 1 },
      factsOld: { ...base, state: 'unknown', lastProbedAt: T0 - FACTS_TTL_MS - 1 },
    },
  }
  const rows = new Map(restorableRows(doc, T0))

  assert.equal(rows.get('proven')!.state, 'ok', 'a recent proof is a hint the pool can use')
  assert.equal(rows.get('provenOld')!.state, 'unknown', 'an old proof is not a liveness claim any more')
  assert.equal(rows.get('provenOld')!.facts?.exitIP, '203.0.113.1', 'the measurement still shows (已测速·未验证)')
  assert.equal(rows.get('dead')!.state, 'dead')
  assert.equal(rows.get('deadOld')!.state, 'unknown', 'an old strike gets the row a fresh chance')
  assert.equal(rows.get('proven')!.cooldownUntil, 0, 'a past cooldown is dropped')
  assert.equal(rows.get('proven')!.note, '', 'an expired abuse flag is dropped')
  assert.deepEqual(rows.get('proven')!.bans?.map((ban) => ban.model), ['live-ban'], 'only a live ban and only a ban (not a suspect)')
  assert.equal(rows.get('factsOld')!.facts, undefined, 'facts past their TTL are not restored')
})

test('the store tolerates a missing, corrupt or foreign document', async () => {
  const path = tempFile()
  assert.equal(await loadPoolHealth(path), null, 'absent = cold pool')

  writeFileSync(path, '{ not json')
  assert.equal(await loadPoolHealth(path), null, 'corrupt = cold pool, never a failed start')

  writeFileSync(path, JSON.stringify({ version: 9, savedAt: T0, exits: {} }))
  assert.equal(await loadPoolHealth(path), null, 'a document from another version is not guessed at')

  const doc = collectPoolHealth(new ExitPool({ now: () => T0 }), T0)
  await writePoolHealth(path, doc)
  const read = await loadPoolHealth(path)
  assert.deepEqual(read, doc, 'what was written comes back')
  assert.ok(readFileSync(path, 'utf8').endsWith('\n'), 'the file ends with a newline')
})

test('the writer flushes the current table and stops its timer', async () => {
  const path = tempFile()
  const pool = new ExitPool({ now: () => T0 })
  pool.add(node({ id: 'h:2' }))
  const writer = startPoolHealthWriter({ pool, path, everyMs: 0, now: () => T0 })
  await writer.flush()
  writer.stop()

  const written = await loadPoolHealth(path)
  assert.notEqual(written, null)
  assert.deepEqual(Object.keys(written!.exits), ['h:2'])
  assert.equal(written!.savedAt, T0)
})

test('restore never resurrects a row the table does not carry', () => {
  const pool = new ExitPool({ now: () => T0 })
  const doc: PoolHealthDocument = {
    version: 1,
    savedAt: T0,
    exits: { 'gone:1': { at: T0, state: 'ok', lastProbedAt: T0, consecutiveLimited: 0, cooldownUntil: 0, deadStrikes: 0, deadAt: 0, note: '', noteAt: 0, passive: { ok: 1, limited: 0, refused: 0, dead: 0, transport: 0 }, facts: { exitIP: '203.0.113.5', exitLocation: '', latencyMs: 1, quality: 'S' }, lastUsedAt: T0, bans: [] } },
  }
  restorePoolHealth(pool, doc, T0)
  assert.equal(pool.list().length, 0)
  assert.equal(pool.get('gone:1'), undefined)
  pool.seedHealth([['other:1', seededRow({ state: 'ok' })]])
  assert.equal(pool.get('other:1'), undefined, 'seeding a missing row is a no-op until the row lands')
})
