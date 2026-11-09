/**
 * Screening-verdict cache: a plugin reload must not re-probe a subscription it
 * already measured. These tests pin both halves — the on-disk cache (freshness
 * per entry, corrupt files cost a re-screen but never a failure) and the
 * onboarder consuming it (cached nodes are not dialled at all).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ExitPool } from '../src/pool/pool.ts'
import { Prober } from '../src/pool/prober.ts'
import { Onboarder } from '../src/pool/onboard.ts'
import type { ConvertedExit } from '../src/pool/singbox.ts'
import type { ParsedNode } from '../src/pool/subscription.ts'
import {
  ONBOARD_CACHE_TTL_MS,
  loadOnboardCache,
  saveOnboardCache,
  screeningKey,
  type ScreeningVerdict,
} from '../src/pool/onboard-cache.ts'

const BASE_PORT = 30_000

function node(name: string): ParsedNode {
  return {
    name,
    type: 'anytls',
    server: `${name}.example.test`,
    port: 443,
    raw: { type: 'anytls', password: 'pw', sni: `${name}.example.test` },
  }
}

function candidates(count: number): ConvertedExit[] {
  return Array.from({ length: count }, (_, index) => ({
    address: `127.0.0.1:${BASE_PORT + 1 + index}`,
    protocol: 'socks5' as const,
    node: node(`n${String(index).padStart(2, '0')}`),
    slot: index,
  }))
}

function portOf(address: string): number {
  return Number(address.split(':')[1])
}

/** A seam that counts every speed-pass request, so "no probe" is provable. */
function countingSeam(failPorts: readonly number[] = []) {
  const probes: string[] = []
  return {
    probes,
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      uri: string
      close() { return Promise.resolve() }
      destroy() { return Promise.resolve() }
    },
    request: (async (url: string, init: { dispatcher: { uri: string } }) => {
      probes.push(url)
      const port = portOf(init.dispatcher.uri.replace(/^[a-z0-9+.-]+:\/\//, ''))
      if (failPorts.includes(port)) return { statusCode: 502, body: { text: async () => 'nope' } }
      return {
        statusCode: 200,
        body: { text: async () => JSON.stringify({ status: 'success', query: `8.8.${port % 250}.1`, countryCode: 'US', city: 'c' }) },
      }
    }) as never,
  }
}

function harness(count: number, poolSize = 20, failPorts: readonly number[] = []) {
  const pool = new ExitPool({ poolSize })
  const prober = new Prober({ pool, maxConcurrentProbes: 8 })
  const nodes = candidates(count)
  const transport = countingSeam(failPorts)
  const logger = { info: () => {}, warn: () => {} }
  const onboarder = new Onboarder({
    pool,
    prober,
    admission: { pool, undici: transport as never, blockedCountries: ['CN'], smokeModel: 'big-pickle', logger },
    select: async (slots) => slots.map((slot) => nodes[slot]!),
    logger,
  })
  return { pool, prober, nodes, onboarder, probes: transport.probes }
}

test('a re-rolled uTLS fingerprint is the same node; a different edge is not', async () => {
  // The airport randomises the fingerprint per fetch, which is why the cache
  // key cannot be the outbound JSON: it would change on every fetch.
  const base = node('n00')
  const rerolled: ParsedNode = {
    ...base,
    raw: { ...base.raw, tls: { enabled: true, utls: { enabled: true, fingerprint: 'qq' } } },
  }
  assert.equal(screeningKey(rerolled), screeningKey(base), 'the fingerprint is not identity')

  const otherEdge: ParsedNode = { ...base, server: 'other.example.test' }
  assert.notEqual(screeningKey(otherEdge), screeningKey(base))

  const otherSni: ParsedNode = { ...base, raw: { ...base.raw, sni: 'x.example.test' } }
  assert.notEqual(screeningKey(otherSni), screeningKey(base), 'one edge serves many nodes, told apart by SNI')

  const otherAccount: ParsedNode = { ...base, raw: { ...base.raw, password: 'other' } }
  assert.notEqual(screeningKey(otherAccount), screeningKey(base), 'a different account on the same edge is a different node')
})

test('a fresh cache round-trips its per-node verdicts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc2dsh-onboard-'))
  try {
    const path = join(dir, 'onboarding.json')
    const verdicts = new Map<string, ScreeningVerdict>([
      ['k1', { at: 1_000, facts: { exitIP: '8.8.8.8', exitLocation: 'US', latencyMs: 120 } }],
      ['k2', { at: 1_000, rejected: 'latency 5000ms > 3000ms' }],
    ])
    await saveOnboardCache(path, verdicts)
    const loaded = await loadOnboardCache(path, ONBOARD_CACHE_TTL_MS, 2_000)
    assert.equal(loaded?.size, 2)
    assert.deepEqual(loaded?.get('k1'), { at: 1_000, facts: { exitIP: '8.8.8.8', exitLocation: 'US', latencyMs: 120 } })
    assert.deepEqual(loaded?.get('k2'), { at: 1_000, rejected: 'latency 5000ms > 3000ms' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('entries older than the TTL are dropped, and only the fresh ones come back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc2dsh-onboard-'))
  try {
    const path = join(dir, 'onboarding.json')
    await saveOnboardCache(path, new Map<string, ScreeningVerdict>([
      ['old', { at: 1_000, facts: { exitIP: '1.1.1.1', exitLocation: 'US', latencyMs: 100 } }],
      ['new', { at: 10_000, facts: { exitIP: '2.2.2.2', exitLocation: 'US', latencyMs: 100 } }],
    ]))
    const loaded = await loadOnboardCache(path, 5_000, 12_000)
    assert.deepEqual([...(loaded?.keys() ?? [])], ['new'])
    assert.equal(await loadOnboardCache(path, 5_000, 60_000), null, 'nothing fresh left means nothing to reuse')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a corrupt cache costs a re-screen, not a failed refresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc2dsh-onboard-'))
  try {
    const path = join(dir, 'onboarding.json')
    await writeFile(path, '{not json', 'utf8')
    assert.equal(await loadOnboardCache(path), null)
    await writeFile(path, JSON.stringify({ entries: { bad: { at: 'yesterday' } } }), 'utf8')
    assert.equal(await loadOnboardCache(path), null)
    assert.equal(await loadOnboardCache(join(dir, 'absent.json')), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cached verdicts are reused without dialling the nodes at all', async () => {
  const { pool, nodes, onboarder, probes } = harness(4, 4)
  const at = Date.now()
  // Distinct exit IPs: the pool treats one IP as one quota bucket, so shared
  // facts would legitimately collapse the four rows into one.
  const restored = new Map<string, ScreeningVerdict>(
    nodes.map((exit, index): [string, ScreeningVerdict] => [
      screeningKey(exit.node),
      { at, facts: { exitIP: `8.8.8.${index + 1}`, exitLocation: 'US', latencyMs: 50 } },
    ]),
  )
  const result = await onboarder.run(nodes, [], new Map(), restored)

  assert.deepEqual(probes, [], 'a cached round probes nothing')
  assert.equal(onboarder.reused, 4, 'every candidate answered from the cache')
  assert.equal(result.screened, 4)
  assert.equal(result.admitted, 4)
  assert.equal(pool.list().length, 4)
  // Reused verdicts keep their own measurement time: the cache never ages itself forward.
  for (const verdict of onboarder.verdicts.values()) assert.equal(verdict.at, at)
})

test('only the nodes missing from the cache are dialled', async () => {
  const { nodes, onboarder, probes } = harness(3, 3)
  const restored = new Map<string, ScreeningVerdict>([
    [screeningKey(nodes[0]!.node), { at: Date.now(), facts: { exitIP: '8.8.8.8', exitLocation: 'US', latencyMs: 50 } }],
    [screeningKey(nodes[1]!.node), { at: Date.now(), facts: { exitIP: '8.8.4.4', exitLocation: 'US', latencyMs: 60 } }],
  ])
  const result = await onboarder.run(nodes, [], new Map(), restored)
  assert.equal(probes.length, 1, 'the one uncached node is the only probe')
  assert.equal(onboarder.reused, 2)
  assert.equal(result.screened, 3)
  // The fresh measurement is stamped now, the reused ones keep theirs.
  assert.equal(onboarder.verdicts.size, 3)
})

test('a failed probe is not remembered as a verdict about the exit', async () => {
  // The seam answers 502 for one port: that is a measurement failure, and
  // caching it would keep a healthy node out of the pool for the whole TTL.
  const { nodes, onboarder, probes } = harness(3, 10, [BASE_PORT + 3])
  await onboarder.run(nodes)
  assert.ok(probes.length >= 3, 'every node was dialled once')
  const missing = screeningKey(nodes[2]!.node)
  assert.equal(onboarder.verdicts.has(missing), false, 'a measurement failure is not cached')
  assert.equal(onboarder.verdicts.size, 2, 'the two measured nodes are cached')
})

test('a cached rejection keeps the node out without probing it', async () => {
  const { pool, nodes, onboarder, probes } = harness(3, 10)
  const restored = new Map<string, ScreeningVerdict>([
    [screeningKey(nodes[0]!.node), { at: Date.now(), facts: { exitIP: '8.8.8.8', exitLocation: 'US', latencyMs: 50 } }],
    [screeningKey(nodes[1]!.node), { at: Date.now(), facts: { exitIP: '8.8.4.4', exitLocation: 'US', latencyMs: 60 } }],
    [screeningKey(nodes[2]!.node), { at: Date.now(), rejected: 'latency 5000ms > 3000ms' }],
  ])
  const result = await onboarder.run(nodes, [], new Map(), restored)
  assert.deepEqual(probes, [])
  assert.equal(onboarder.reused, 3, 'a cached rejection is reuse too')
  assert.equal(result.screened, 2)
  assert.equal(pool.has(nodes[2]!.address), false, 'a refused candidate is not admitted')
})
