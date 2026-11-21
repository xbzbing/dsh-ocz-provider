/**
 * sing-box child handoff across a plugin reload (pool/singbox-lease.ts).
 *
 * Every subscription fetch re-rolls each node's TLS fingerprint, so the
 * generated config always differs and the old reload path restarted the child:
 * every converted exit went dark for a second and in-flight requests struck
 * their rows. These tests run a real (fake-binary) supervisor pair and pin what
 * adoption must and must not keep.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SingBoxSupervisor } from '../src/pool/singbox.ts'
import { dropSingBox, matchesLease, SINGBOX_GRACE_MS, type SingBoxExpectation, type SingBoxLease } from '../src/pool/singbox-lease.ts'
import type { ParsedNode } from '../src/pool/subscription.ts'

const quiet = { info: () => {}, warn: () => {} }
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-singbox.mjs')
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A `sing-box` command the supervisor can spawn: a wrapper around the fixture. */
function fakeBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-singbox-'))
  const path = join(dir, 'sing-box')
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

function node(name: string): ParsedNode {
  return {
    name,
    type: 'anytls',
    server: `${name}.example.test`,
    port: 443,
    raw: { type: 'anytls', password: 'pw', sni: `${name}.example.test` },
  }
}

/** Same node, re-rolled TLS fingerprint: a different config, the same identity. */
function rerolled(node: ParsedNode): ParsedNode {
  return { ...node, raw: { ...node.raw, tls: { enabled: true, utls: { enabled: true, fingerprint: 'qq' } } } }
}

const recordOf = (dataDir: string): { pid: number } =>
  JSON.parse(readFileSync(join(dataDir, 'child.json'), 'utf8')) as { pid: number }

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function exported<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } finally {
    for (const stop of STOPPERS.splice(0)) await stop().catch(() => {})
    dropSingBox(LAST.dataDir)
  }
}

/** Supervisors the test in flight must end, even when an assertion throws. */
const STOPPERS: Array<() => Promise<void>> = []

/** A supervisor that is always stopped at the end of the test. */
function supervised(options: ConstructorParameters<typeof SingBoxSupervisor>[0]): SingBoxSupervisor {
  const supervisor = new SingBoxSupervisor(options)
  STOPPERS.push(() => supervisor.stop())
  return supervisor
}

/** The data dir of the test in flight, so a failure still ends the leased child. */
const LAST = { dataDir: '' }

test('handoff: the next generation keeps the same child when the node set is unchanged', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'singbox-lease-'))
  LAST.dataDir = dataDir
  const binPath = fakeBinary()
  const basePort = 41_000 + Math.floor(Math.random() * 500)
  const nodes = [node('a'), node('b')]

  await exported(async () => {
    const first = supervised({ binPath, dataDir, basePort, readyTimeoutMs: 5_000, logger: quiet })
    const exits1 = await first.reload(nodes)
    assert.equal(exits1.length, 2, 'both nodes converted')
    const pid = recordOf(dataDir).pid
    assert.equal(alive(pid), true)

    first.handOff(10_000)
    assert.equal(first.running, false, 'the outgoing supervisor no longer owns the child')

    const second = supervised({ binPath, dataDir, basePort, readyTimeoutMs: 5_000, logger: quiet })
    const exits2 = await second.reload(nodes.map(rerolled))
    assert.equal(recordOf(dataDir).pid, pid, 'the re-rolled fingerprint did not restart the child')
    assert.deepEqual(exits2.map((exit) => exit.address), exits1.map((exit) => exit.address), 'the ports stay put')
    assert.equal(second.running, true)

    await second.stop()
    await sleep(100)
    assert.equal(alive(pid), false, 'stop() still ends an adopted child')
  })
})


/** A lease-shaped object whose child has no exit status (still running). */
function fakeLease(overrides: Partial<SingBoxLease> = {}): SingBoxLease {
  return {
    child: { exitCode: null, signalCode: null } as unknown as SingBoxLease['child'],
    binPath: '/usr/local/bin/sing-box',
    binary: 'sing-box',
    configPath: '/state/singbox/singbox-config.json',
    dataDir: '/state/singbox',
    ports: [30_001, 30_002],
    keys: ['node-a', 'node-b'],
    handedAt: 0,
    ...overrides,
  }
}

function expectation(overrides: Partial<SingBoxExpectation> = {}): SingBoxExpectation {
  return {
    binPath: '/usr/local/bin/sing-box',
    binary: 'sing-box',
    configPath: '/state/singbox/singbox-config.json',
    dataDir: '/state/singbox',
    ports: [30_001, 30_002],
    keys: ['node-a', 'node-b'],
    ...overrides,
  }
}

test('matchesLease: identity and port decide, list order does not', () => {
  assert.equal(matchesLease(fakeLease(), expectation()), true)
  assert.equal(
    matchesLease(fakeLease(), expectation({ keys: ['node-b', 'node-a'], ports: [30_002, 30_001] })),
    true,
    'a reordered subscription still maps each node to its own port',
  )
  assert.equal(
    matchesLease(fakeLease(), expectation({ keys: ['node-a', 'node-b', 'node-c'], ports: [30_001, 30_002, 30_003] })),
    false,
    'a node the child does not serve needs a reload',
  )
  assert.equal(
    matchesLease(fakeLease(), expectation({ keys: ['node-a'], ports: [30_001] })),
    true,
    'a narrower selection is served by the same child (its spare listener just idles)',
  )
  assert.equal(
    matchesLease(fakeLease(), expectation({ keys: ['node-a', 'node-b'], ports: [30_001, 30_009] })),
    false,
    'a moved port is a different listener',
  )
  assert.equal(
    matchesLease(fakeLease({ ports: [30_001, 0] }), expectation()),
    false,
    'a node the previous selection never opened must be converted, not adopted',
  )
  assert.equal(matchesLease(fakeLease(), expectation({ binPath: '/opt/sing-box' })), false, 'another binary is not ours')
  assert.equal(
    matchesLease(fakeLease({ child: { exitCode: 1, signalCode: null } as unknown as SingBoxLease['child'] }), expectation()),
    false,
    'a dead child is not adopted',
  )
  assert.equal(
    matchesLease(fakeLease({ keys: ['node-a', 'node-a'] }), expectation({ keys: ['node-a', 'node-a'] })),
    false,
    'duplicate identities cannot be told apart, so they are never adopted',
  )
})

test('handoff: a reordered subscription keeps the running child', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'singbox-lease-'))
  LAST.dataDir = dataDir
  const binPath = fakeBinary()
  const basePort = 42_800 + Math.floor(Math.random() * 400)
  const a = node('a')
  const b = node('b')

  await exported(async () => {
    const first = supervised({ binPath, dataDir, basePort, readyTimeoutMs: 5_000, logger: quiet })
    const before = await first.reload([a, b])
    const pid = recordOf(dataDir).pid
    const portOfA = before[0]!.address

    first.handOff(10_000)
    const second = supervised({ binPath, dataDir, basePort, readyTimeoutMs: 5_000, logger: quiet })
    const after = await second.reload([rerolled(b), rerolled(a)])
    assert.equal(recordOf(dataDir).pid, pid, 'the same child serves the reordered list')
    assert.equal(after[1]!.address, portOfA, 'node a keeps its own port after the reorder')
    await second.stop()
  })
})

test('handoff: a different node set is replaced, not adopted', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'singbox-lease-'))
  LAST.dataDir = dataDir
  const binPath = fakeBinary()
  const basePort = 41_600 + Math.floor(Math.random() * 500)

  await exported(async () => {
    const first = supervised({ binPath, dataDir, basePort, readyTimeoutMs: 5_000, logger: quiet })
    await first.reload([node('a'), node('b')])
    const pid = recordOf(dataDir).pid

    first.handOff(10_000)
    const second = supervised({ binPath, dataDir, basePort, readyTimeoutMs: 5_000, logger: quiet })
    const exits = await second.reload([node('a'), node('b'), node('c')])
    assert.equal(exits.length, 3, 'the new node converts')
    const replaced = recordOf(dataDir).pid
    assert.notEqual(replaced, pid, 'a node the child never converted needs a reload')
    await sleep(100)
    assert.equal(alive(pid), false, 'the retired child is ended')
    await second.stop()
  })
})

test('handoff: a lease nobody claims ends the child after its grace window', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'singbox-lease-'))
  LAST.dataDir = dataDir
  const binPath = fakeBinary()
  const basePort = 42_200 + Math.floor(Math.random() * 500)

  const first = supervised({ binPath, dataDir, basePort, readyTimeoutMs: 5_000, logger: quiet })
  await first.reload([node('a')])
  const pid = recordOf(dataDir).pid
  first.handOff(30)
  await sleep(400)
  assert.equal(alive(pid), false, 'an uninstall leaves the child unclaimed, and the timer ends it')
  assert.ok(SINGBOX_GRACE_MS > 30)
})
