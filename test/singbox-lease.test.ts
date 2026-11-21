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
import { dropSingBox, SINGBOX_GRACE_MS } from '../src/pool/singbox-lease.ts'
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
    dropSingBox(LAST.dataDir)
  }
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
    const first = new SingBoxSupervisor({ binPath, dataDir, basePort, readyTimeoutMs: 5_000, logger: quiet })
    const exits1 = await first.reload(nodes)
    assert.equal(exits1.length, 2, 'both nodes converted')
    const pid = recordOf(dataDir).pid
    assert.equal(alive(pid), true)

    first.handOff(10_000)
    assert.equal(first.running, false, 'the outgoing supervisor no longer owns the child')

    const second = new SingBoxSupervisor({ binPath, dataDir, basePort, readyTimeoutMs: 5_000, logger: quiet })
    const exits2 = await second.reload(nodes.map(rerolled))
    assert.equal(recordOf(dataDir).pid, pid, 'the re-rolled fingerprint did not restart the child')
    assert.deepEqual(exits2.map((exit) => exit.address), exits1.map((exit) => exit.address), 'the ports stay put')
    assert.equal(second.running, true)

    await second.stop()
    await sleep(100)
    assert.equal(alive(pid), false, 'stop() still ends an adopted child')
  })
})

test('handoff: a different node set is replaced, not adopted', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'singbox-lease-'))
  LAST.dataDir = dataDir
  const binPath = fakeBinary()
  const basePort = 41_600 + Math.floor(Math.random() * 500)

  await exported(async () => {
    const first = new SingBoxSupervisor({ binPath, dataDir, basePort, readyTimeoutMs: 5_000, logger: quiet })
    await first.reload([node('a'), node('b')])
    const pid = recordOf(dataDir).pid

    first.handOff(10_000)
    const second = new SingBoxSupervisor({ binPath, dataDir, basePort, readyTimeoutMs: 5_000, logger: quiet })
    const exits = await second.reload([node('a')])
    assert.equal(exits.length, 1)
    const replaced = recordOf(dataDir).pid
    assert.notEqual(replaced, pid, 'a child serving another node set is replaced')
    assert.equal(alive(pid), false, 'the retired child is ended')
    await second.stop()
  })
})

test('handoff: a lease nobody claims ends the child after its grace window', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'singbox-lease-'))
  LAST.dataDir = dataDir
  const binPath = fakeBinary()
  const basePort = 42_200 + Math.floor(Math.random() * 500)

  const first = new SingBoxSupervisor({ binPath, dataDir, basePort, readyTimeoutMs: 5_000, logger: quiet })
  await first.reload([node('a')])
  const pid = recordOf(dataDir).pid
  first.handOff(30)
  await sleep(400)
  assert.equal(alive(pid), false, 'an uninstall leaves the child unclaimed, and the timer ends it')
  assert.ok(SINGBOX_GRACE_MS > 30)
})
