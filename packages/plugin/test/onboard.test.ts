/**
 * Pool onboarding (live request 2026-10-13): speed-test every converted
 * candidate, keep the fastest `poolSize`, shrink the sing-box conversion to
 * them, then run the OpenCode connectivity test — replacing anything the
 * upstream lane refuses from a reserve, and parking the refused exit at the
 * tail when the reserve is empty so the pool holds its size.
 *
 * The seam controls, per candidate port: the speed-pass latency (so the
 * ranking is observable), whether the smoke is refused (401/403), and whether
 * it answers 429 (quota, which must NOT be treated as a refusal).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool } from '../src/pool/pool.ts'
import { Prober } from '../src/pool/prober.ts'
import { Onboarder } from '../src/pool/onboard.ts'
import type { ConvertedExit } from '../src/pool/singbox.ts'
import type { ParsedNode } from '../src/pool/subscription.ts'

const BASE_PORT = 30_000

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function node(name: string): ParsedNode {
  return {
    name,
    type: 'anytls',
    server: `${name}.example.test`,
    port: 443,
    raw: { type: 'anytls', password: 'pw', sni: `${name}.example.test` },
  }
}

/** The candidate list a full conversion hands over: one port per slot. */
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

interface SeamOptions {
  /** Speed-pass latency per candidate port (default 1ms). */
  latencyMs?: (port: number) => number
  /** Ports whose connectivity smoke answers 403 (upstream refusal). */
  refuseSmoke?: number[]
  /** Ports whose smoke answers 429 (quota — a cooldown, not a refusal). */
  limitedSmoke?: number[]
  /** Make the speed pass fail for every candidate (blocked echo endpoint). */
  screenFails?: boolean
}

function seam(options: SeamOptions = {}) {
  const refuse = new Set(options.refuseSmoke ?? [])
  const limited = new Set(options.limitedSmoke ?? [])
  return {
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      uri: string
      close() { return Promise.resolve() }
      destroy() { return Promise.resolve() }
    },
    request: (async (url: string, init: { dispatcher: { uri: string } }) => {
      const port = portOf(init.dispatcher.uri.replace(/^[a-z0-9+.-]+:\/\//, ''))
      if (url.includes('ip-api')) {
        if (options.screenFails === true) return { statusCode: 502, body: { text: async () => 'nope' } }
        await delay(options.latencyMs?.(port) ?? 1)
        return {
          statusCode: 200,
          body: { text: async () => JSON.stringify({ status: 'success', query: `8.8.${port % 250}.1`, countryCode: 'US', city: 'c' }) },
        }
      }
      if (url.includes('chat/completions')) {
        if (refuse.has(port)) return { statusCode: 403, body: { text: async () => 'refused' } }
        if (limited.has(port)) return { statusCode: 429, body: { text: async () => 'quota' } }
        return { statusCode: 200, body: { text: async () => 'data: ok' } }
      }
      return { statusCode: 200, body: { text: async () => '{"data":[]}' } }
    }) as never,
  }
}

interface HarnessOptions extends SeamOptions {
  count: number
  poolSize?: number
}

/** An onboarder over a fake conversion that honours `keep` like the real one. */
function harness(options: HarnessOptions) {
  const pool = new ExitPool({ poolSize: options.poolSize ?? 20 })
  const prober = new Prober({ pool, maxConcurrentProbes: 8 })
  const nodes = candidates(options.count)
  const selections: number[][] = []
  const logger = { info: () => {}, warn: () => {} }
  const onboarder = new Onboarder({
    pool,
    prober,
    admission: {
      pool,
      undici: seam(options) as never,
      blockedCountries: ['CN'],
      smokeModel: 'big-pickle',
      logger,
    },
    select: async (slots) => {
      selections.push([...slots])
      return slots.map((slot) => nodes[slot]!)
    },
    logger,
  })
  return { pool, prober, nodes, onboarder, selections }
}

const ascending = (slots: number[]): number[] => [...slots].sort((left, right) => left - right)

test('onboarding keeps the fastest poolSize and shrinks the conversion to exactly them', async () => {
  // Latency grows with the slot, so the FASTEST candidates are the LAST slots:
  // a selection that just took the first N would fail this.
  const { pool, nodes, onboarder, selections } = harness({
    count: 30,
    poolSize: 20,
    latencyMs: (port) => (BASE_PORT + 31 - port) * 10,
  })
  const result = await onboarder.run(nodes)

  assert.equal(result.candidates, 30)
  assert.equal(result.screened, 30, 'every candidate answered the speed pass')
  assert.equal(result.admitted, 20)
  assert.equal(result.reserve, 10)
  assert.equal(pool.list().length, 20)
  assert.deepEqual(ascending(selections[0]!), Array.from({ length: 20 }, (_, index) => index + 10), 'the shrink keeps the fastest 20 slots')
  const kept = new Set(pool.list().map((entry) => entry.id))
  assert.ok(kept.has(`127.0.0.1:${BASE_PORT + 30}`), 'the fastest candidate is online')
  assert.ok(!kept.has(`127.0.0.1:${BASE_PORT + 1}`), 'the slowest is reserve, not online')
})

test('a refused exit is replaced by the next-fastest reserve', async () => {
  // 5 candidates, capacity 3: speed order is slots 4,3,2 with 1,0 in reserve.
  const { pool, nodes, onboarder, selections } = harness({
    count: 5,
    poolSize: 3,
    latencyMs: (port) => (BASE_PORT + 6 - port) * 10,
    refuseSmoke: [BASE_PORT + 5],
  })
  const result = await onboarder.run(nodes)

  assert.equal(result.promoted, 1)
  assert.equal(result.demoted, 0)
  assert.equal(pool.list().length, 3, 'the pool holds its capacity')
  // The rebuild must be handed the NEXT selection, never `selected + next`:
  // the pre-2026-10-14 shape left the refused slot in the config, so sing-box
  // kept listening on a port no exit owned (measured live: 21 listeners for 16
  // pool exits). Every select() call is therefore a subset of the live pool.
  assert.deepEqual(selections, [[4, 3, 2], [3, 2, 1]], 'the refused slot leaves the config with it')
  assert.ok(selections.every((slots) => slots.length <= 3))
  assert.ok(!pool.has(`127.0.0.1:${BASE_PORT + 5}`), 'the refused exit left the pool')
  assert.ok(pool.has(`127.0.0.1:${BASE_PORT + 2}`), 'the next reserve (slot 1) took the slot')
  assert.ok(pool.has(`127.0.0.1:${BASE_PORT + 3}`))
  assert.ok(pool.has(`127.0.0.1:${BASE_PORT + 4}`))
})

test('with no reserve left a refused exit is kept, demoted to the tail', async () => {
  const { pool, nodes, onboarder } = harness({
    count: 2,
    poolSize: 2,
    refuseSmoke: [BASE_PORT + 2],
  })
  const result = await onboarder.run(nodes)

  assert.equal(result.demoted, 1)
  assert.equal(result.admitted, 1)
  assert.equal(pool.list().length, 2, 'the pool never drains below its size')
  const refused = `127.0.0.1:${BASE_PORT + 2}`
  assert.ok(pool.has(refused), 'the refused exit stays as the last resort')
  assert.ok(pool.demoted(refused))
  assert.equal(pool.list().at(-1)?.id, refused, 'and it sits at the end of the pool order')
  assert.equal(pool.list().find((entry) => entry.id === refused)?.health.state, 'unknown', 'it claims no health')
})

test('a 429 is a cooldown, never a refusal', async () => {
  const { pool, nodes, onboarder } = harness({
    count: 1,
    poolSize: 1,
    limitedSmoke: [BASE_PORT + 1],
  })
  const result = await onboarder.run(nodes)

  assert.equal(result.admitted, 1)
  assert.equal(result.refused, 0)
  assert.equal(result.promoted, 0)
  const entry = pool.list()[0]!
  assert.ok(entry.health.cooldownUntil > Date.now(), 'the exit is cooling, not replaced')
  assert.equal(pool.demoted(entry.id), false)
})

test('replace() promotes a reserve for an exit the upstream refuses later', async () => {
  const { pool, nodes, onboarder } = harness({ count: 3, poolSize: 2 })
  await onboarder.run(nodes)
  assert.deepEqual(pool.list().map((entry) => entry.id).sort(), [`127.0.0.1:${BASE_PORT + 1}`, `127.0.0.1:${BASE_PORT + 2}`])

  const replaced = await onboarder.replace(`127.0.0.1:${BASE_PORT + 1}`)
  assert.equal(replaced, true, 'the reserve was promoted')
  assert.equal(pool.list().length, 2)
  assert.ok(!pool.has(`127.0.0.1:${BASE_PORT + 1}`), 'the refused exit is out')
  assert.ok(pool.has(`127.0.0.1:${BASE_PORT + 3}`), 'the reserve is in')
})

test('replace() demotes instead of draining when the reserve is exhausted', async () => {
  const { pool, nodes, onboarder } = harness({ count: 2, poolSize: 2 })
  await onboarder.run(nodes)

  const replaced = await onboarder.replace(`127.0.0.1:${BASE_PORT + 1}`)
  assert.equal(replaced, false, 'nothing was promoted')
  assert.equal(pool.list().length, 2, 'and nothing was dropped')
  assert.ok(pool.demoted(`127.0.0.1:${BASE_PORT + 1}`))
})

test('a speed pass that measures nothing keeps candidates unranked at the tail', async () => {
  // A blocked echo endpoint must not read as "44 dead nodes": the pool keeps its
  // capacity and parks the unverifiable exits at the tail instead of draining.
  const { pool, nodes, onboarder } = harness({ count: 3, poolSize: 2, screenFails: true })
  const result = await onboarder.run(nodes)

  assert.equal(result.screened, 0)
  assert.equal(result.admitted, 0)
  assert.equal(pool.list().length, 2, 'capacity holds even when nothing can be measured')
  assert.ok(pool.list().every((entry) => pool.demoted(entry.id)))
  assert.ok(pool.list().every((entry) => entry.health.state === 'unknown'))
})
