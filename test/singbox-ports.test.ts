/**
 * `ports.json`: the identity -> local port map has to outlive the supervisor.
 *
 * Every pool row is keyed by its local SOCKS port (`127.0.0.1:300xx`), so a
 * reload that renumbers a node silently repoints the pool at a different
 * upstream — or, worse, at a port nobody listens on. Before this file existed
 * the map lived only in memory, so any new supervisor (host restart, plugin
 * re-apply) renumbered the whole conversion from 30001 in list order and the
 * onboarding reset every row it had (2026-11-08).
 *
 * The fake binary below answers `version`/`check` with 0 and holds `run`, which
 * is all the supervisor needs to execute its real port logic.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SingBoxSupervisor, type ConvertedExit } from '../src/pool/singbox.ts'
import type { ParsedNode } from '../src/pool/subscription.ts'

function node(server: string): ParsedNode {
  return {
    name: server,
    type: 'anytls',
    server,
    port: 443,
    raw: { type: 'anytls', password: 'pw', sni: server },
  }
}

function fakeBinary(dir: string): string {
  const path = join(dir, 'sing-box')
  // `exec` so the run child IS the sleep: it dies on the supervisor's SIGINT
  // instead of holding the 5s grace window on every reload.
  writeFileSync(path, '#!/bin/sh\nif [ "$1" = "run" ]; then exec sleep 30; fi\nexit 0\n', 'utf8')
  chmodSync(path, 0o755)
  return path
}

function portsOf(exits: ConvertedExit[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const exit of exits) out[exit.node.server] = Number(exit.address.split(':')[1])
  return out
}

function supervisor(dir: string, binary: string): SingBoxSupervisor {
  return new SingBoxSupervisor({ binPath: binary, dataDir: dir, readyTimeoutMs: 120 })
}

test('an identity keeps its port across reorders, gaps and restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2dsh-ports-'))
  const binary = fakeBinary(dir)
  const sup = supervisor(dir, binary)
  const a = node('a.example.test')
  const b = node('b.example.test')
  const c = node('c.example.test')
  try {
    const first = portsOf(await sup.reload([a, b, c]))
    assert.equal(new Set(Object.values(first)).size, 3, 'distinct ports')
    for (const port of Object.values(first)) assert.ok(port > 30000, `port ${port} comes from the pool range`)

    // Same nodes, different order: every identity must keep its own port.
    const reordered = portsOf(await sup.reload([c, a, b]))
    assert.deepEqual(reordered, first, 'reordering the node list does not renumber anybody')

    // `b` disappears for a round. Its port is now free, so it may be reused —
    // that is deliberate (a reused port is a NEW exit: the onboarding sees the
    // node key change and starts that row over instead of crediting it with the
    // old node's health).
    const d = node('d.example.test')
    const withoutB = portsOf(await sup.reload([a, c, d]))
    assert.equal(withoutB['a.example.test'], first['a.example.test'], 'a kept node is never renumbered')
    assert.equal(withoutB['c.example.test'], first['c.example.test'])
    assert.equal(new Set(Object.values(withoutB)).size, 3, 'still one port per live node')

    // A node that leaves and comes back while its port is still free keeps it,
    // so its pool row survives the gap.
    const gap = portsOf(await sup.reload([a, c]))
    assert.equal(gap['a.example.test'], first['a.example.test'])
    const back = portsOf(await sup.reload([a, b, c]))
    assert.equal(back['b.example.test'], first['b.example.test'], 'a returning node lands back on its own port when it is free')
  } finally {
    await sup.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the assignment survives the supervisor that wrote it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2dsh-ports-'))
  const binary = fakeBinary(dir)
  const nodes = [node('a.example.test'), node('b.example.test')]
  let remembered: Record<string, number> = {}
  try {
    const first = supervisor(dir, binary)
    try {
      remembered = portsOf(await first.reload(nodes))
    } finally {
      await first.stop()
    }
    const file = join(dir, 'ports.json')
    assert.ok(existsSync(file), 'the map is written beside the config')
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>
    assert.equal(Object.keys(stored).length, 2, 'one entry per node identity')

    // A brand-new supervisor (host restart, plugin re-apply) must reuse it —
    // the node list arrives in the OPPOSITE order.
    const second = supervisor(dir, binary)
    try {
      const again = portsOf(await second.reload([...nodes].reverse()))
      assert.deepEqual(again, remembered, 'a restart does not renumber the exits')
    } finally {
      await second.stop()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt ports.json costs renumbering, never the conversion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2dsh-ports-'))
  const binary = fakeBinary(dir)
  writeFileSync(join(dir, 'ports.json'), '{not json', 'utf8')
  const sup = supervisor(dir, binary)
  try {
    const exits = await sup.reload([node('a.example.test')])
    assert.equal(exits.length, 1, 'the conversion still runs')
    assert.ok(Number(exits[0]!.address.split(':')[1]) > 30000)
  } finally {
    await sup.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
