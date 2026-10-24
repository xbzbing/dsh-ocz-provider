/**
 * Pool onboarding (live request 2026-10-13; no-probe contract 2026-10-24):
 * speed-test every converted candidate, keep the fastest `poolSize`, shrink
 * the sing-box conversion to them, and admit the selection FROM ITS SPEED
 * FACTS. The subscription flow never sends a request to OpenCode — no models
 * list, no smoke, on onboarding or on a later reserve swap (operator decision
 * 2026-10-24: 添加订阅后，不对 OpenCode 进行任何主动探测，只显示测速的延迟).
 *
 * The seam therefore THROWS on any non-ip-api request: a single OpenCode call
 * during onboarding or replace() fails the test outright. It also controls the
 * speed-pass latency per candidate port (so the ranking is observable).
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

/**
 * The candidate list a full conversion hands over: one port per slot.
 *
 * NOTE on the `latencyMs` seams below: the speed pass ranks by MEASURED wall
 * time, and node --test runs test FILES in parallel, so the spacing has to
 * dominate scheduler jitter. 10ms per step was too tight — one full-suite run
 * ranked [4,1,2] where the speed order was [4,3,2] (a 20ms inversion under
 * load). The steps are now 50-120ms.
 */
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
  /** Make the speed pass fail for every candidate (blocked echo endpoint). */
  screenFails?: boolean
}

/**
 * The seam serves ONLY the speed pass (ip-api). Anything else — a Zen models
 * list, a chat smoke, any OpenCode URL — is recorded as evidence of a probe
 * the 2026-10-24 contract forbids; tests assert the record stays empty.
 */
function seam(options: SeamOptions = {}) {
  const probeAttempts: string[] = []
  return {
    probeAttempts,
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      uri: string
      close() { return Promise.resolve() }
      destroy() { return Promise.resolve() }
    },
    request: (async (url: string, init: { dispatcher: { uri: string } }) => {
      if (!url.includes('ip-api')) {
        probeAttempts.push(url)
        return { statusCode: 418, body: { text: async () => 'probe attempted' } }
      }
      const port = portOf(init.dispatcher.uri.replace(/^[a-z0-9+.-]+:\/\//, ''))
      if (options.screenFails === true) return { statusCode: 502, body: { text: async () => 'nope' } }
      await delay(options.latencyMs?.(port) ?? 1)
      return {
        statusCode: 200,
        body: { text: async () => JSON.stringify({ status: 'success', query: `8.8.${port % 250}.1`, countryCode: 'US', city: 'c' }) },
      }
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
  const transport = seam(options)
  const onboarder = new Onboarder({
    pool,
    prober,
    admission: {
      pool,
      undici: transport as never,
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
  return { pool, prober, nodes, onboarder, selections, probeAttempts: transport.probeAttempts }
}

const ascending = (slots: number[]): number[] => [...slots].sort((left, right) => left - right)

test('onboarding keeps the fastest poolSize and shrinks the conversion to exactly them', async () => {
  // Latency grows with the slot, so the FASTEST candidates are the LAST slots:
  // a selection that just took the first N would fail this.
  const { pool, nodes, onboarder, selections } = harness({
    count: 30,
    poolSize: 20,
    latencyMs: (port) => (BASE_PORT + 31 - port) * 50,
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
  const { pool, nodes, onboarder, selections, probeAttempts } = harness({
    count: 5,
    poolSize: 3,
    latencyMs: (port) => (BASE_PORT + 6 - port) * 120,
  })
  const result = await onboarder.run(nodes)

  // Onboarding itself refuses nothing now (there is no connectivity test to
  // fail): the selection is admitted straight from its speed facts.
  assert.equal(result.admitted, 3)
  assert.equal(result.promoted, 0)
  assert.equal(result.demoted, 0)
  assert.equal(pool.list().length, 3, 'the pool holds its capacity')
  assert.deepEqual(ascending(selections[0]!), [2, 3, 4], 'the shrink keeps the fastest 3 slots')
  assert.deepEqual(probeAttempts, [], 'onboarding sent ZERO requests to OpenCode (2026-10-24 contract)')

  // A refusal arrives later (passive 401/403 / dead rotation): the swap hands
  // the refused row's slot to the next-fastest reserve — again with no probe.
  const replaced = await onboarder.replace(`127.0.0.1:${BASE_PORT + 5}`)
  assert.equal(replaced, true, 'the reserve was promoted')
  // The rebuild must be handed the NEXT selection, never `selected + next`:
  // the pre-2026-10-14 shape left the refused slot in the config, so sing-box
  // kept listening on a port no exit owned (measured live: 21 listeners for 16
  // pool exits). Every select() call is therefore a subset of the live pool.
  assert.deepEqual(ascending(selections.at(-1)!), [1, 2, 3], 'the refused slot leaves the config with it')
  assert.ok(selections.every((slots) => slots.length <= 3))
  assert.ok(!pool.has(`127.0.0.1:${BASE_PORT + 5}`), 'the refused exit left the pool')
  assert.ok(pool.has(`127.0.0.1:${BASE_PORT + 2}`), 'the next reserve (slot 1) took the slot')
  assert.ok(pool.has(`127.0.0.1:${BASE_PORT + 3}`))
  assert.ok(pool.has(`127.0.0.1:${BASE_PORT + 4}`))
  // The promoted reserve was admitted from its CACHED speed facts: no probe.
  assert.deepEqual(probeAttempts, [], 'replace() also sends ZERO requests to OpenCode')
  const promoted = pool.get(`127.0.0.1:${BASE_PORT + 2}`)
  assert.ok(promoted !== undefined && promoted.latencyMs > 0, 'the promoted row carries its speed-test latency')
  assert.ok(['S', 'A'].includes(promoted.quality), `grade follows the speed test (${promoted.quality})`)
})

test('with no reserve left a refused exit is kept, demoted to the tail', async () => {
  const { pool, nodes, onboarder, probeAttempts } = harness({
    count: 2,
    poolSize: 2,
    latencyMs: (port) => (port - BASE_PORT) * 120,
  })
  await onboarder.run(nodes)
  assert.equal(pool.list().length, 2)
  assert.deepEqual(probeAttempts, [], 'onboarding sent ZERO requests to OpenCode')

  // Both slots are full and the reserve is empty: the swap keeps the refused
  // exit as the last resort instead of draining the pool.
  const refused = `127.0.0.1:${BASE_PORT + 2}`
  const replaced = await onboarder.replace(refused)
  assert.equal(replaced, false, 'nothing was promoted')
  assert.equal(pool.list().length, 2, 'the pool never drains below its size')
  assert.ok(pool.has(refused), 'the refused exit stays as the last resort')
  assert.ok(pool.demoted(refused))
  assert.equal(pool.list().at(-1)?.id, refused, 'and it sits at the end of the pool order')
  assert.equal(pool.list().find((entry) => entry.id === refused)?.health.state, 'unknown', 'it claims no health')
  assert.deepEqual(probeAttempts, [], 'the demotion path also sends ZERO requests to OpenCode')
})

test('onboarding marks rows ok from the speed pass alone — no OpenCode verdict involved', async () => {
  // The 2026-10-24 contract: the ONLY health signal the subscription flow
  // takes is the speed test's. A row admitted from measured facts claims `ok`
  // (its tunnel demonstrably carries HTTP) with the measured latency/grade;
  // whether OpenCode accepts that IP is learned passively from real traffic.
  const { pool, nodes, onboarder, probeAttempts } = harness({
    count: 2,
    poolSize: 2,
    latencyMs: (port) => (BASE_PORT + 3 - port) * 60,
  })
  const result = await onboarder.run(nodes)

  assert.equal(result.admitted, 2)
  assert.deepEqual(probeAttempts, [], 'no models list, no smoke, nothing to OpenCode')
  const rows = pool.list()
  assert.ok(rows.every((entry) => entry.health.state === 'ok'))
  assert.ok(rows.every((entry) => entry.exitIP !== '' && entry.latencyMs > 0), 'every row carries speed-test facts')
  assert.ok(rows.every((entry) => !entry.health.cooldownUntil), 'no cooldown: nothing ever asked about quota')
})

test('replace() promotes a reserve for an exit the upstream refuses later', async () => {
  // Deterministic speed order (equal latencies fall back to the address tie-break
  // and timer jitter decides which two of three get selected).
  const { pool, nodes, onboarder } = harness({
    count: 3,
    poolSize: 2,
    latencyMs: (port) => (port - BASE_PORT) * 120,
  })
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

test('trim() converges a live pool to a lowered capacity and closes the dropped listeners', async () => {
  // Onboard 6 with capacity 6 — the selection IS every candidate, so no shrink
  // happens yet (and the harness records no select call). Latency shrinks with
  // the port here, so the FASTEST are the last slots.
  const { pool, nodes, onboarder, selections } = harness({
    count: 6,
    poolSize: 6,
    latencyMs: (port) => (BASE_PORT + 7 - port) * 120,
  })
  await onboarder.run(nodes)
  assert.equal(pool.list().length, 6)
  assert.deepEqual(selections, [], 'a selection that is every candidate needs no rebuild')

  // Lowering the capacity must converge the live pool: the worst (slowest, all
  // grade S here) go, and the rebuild keeps only the survivors so their ports
  // close with them.
  pool.setPoolSize(2)
  const dropped = await onboarder.trim()
  assert.equal(dropped, 4)
  assert.equal(pool.list().length, 2, 'the pool is at its new capacity')
  // The selection keeps its onboarding order (speed order, fastest first), so
  // the rebuild is handed [5, 4] — the two fastest — and nothing else.
  assert.deepEqual(selections, [[5, 4]], 'the rebuild keeps only the two fastest slots')
  assert.deepEqual(
    pool.list().map((entry) => entry.id).sort(),
    [`127.0.0.1:${BASE_PORT + 5}`, `127.0.0.1:${BASE_PORT + 6}`],
  )

  // A pool already at or under capacity is left alone (no needless rebuild).
  assert.equal(await onboarder.trim(), 0)
  assert.equal(selections.length, 1)
})

test('replace() is a no-op for an exit that already left both the table and the selection', async () => {
  // The late-duplicate shape (live 2026-10-14): two callers ask for the same
  // exit's replacement — the dead rotation and the probe that was already in
  // flight both fire replaceExit(). The first one promotes a reserve and drops
  // the row AND its slot; the second must do nothing, because promoting there
  // would ADD a slot instead of swapping one (`selected − (slot that is no
  // longer there) + next` is one bigger than the selection, i.e. one extra
  // local listener — the capacity lie from the other direction).
  const { pool, nodes, onboarder, selections } = harness({
    count: 5,
    poolSize: 3,
    latencyMs: (port) => (BASE_PORT + 6 - port) * 120,
  })
  await onboarder.run(nodes)
  const victim = pool.list().map((entry) => entry.id).sort()[0]!
  assert.equal(await onboarder.replace(victim), true, 'the first call swaps in a reserve')
  const afterFirst = selections.length
  assert.equal(pool.list().length, 3)

  assert.equal(await onboarder.replace(victim), false, 'the late duplicate promotes nothing')
  assert.equal(selections.length, afterFirst, 'and requests no rebuild')
  assert.equal(pool.list().length, 3, 'the pool stays at its capacity')
  assert.ok(selections.every((slots) => slots.length <= 3), 'no rebuild ever asks for more slots than the capacity')
})

test('replace() still swaps a reserve for an exit that is in the table', async () => {
  // The guard above must not swallow the real case: a row that IS in the table
  // but no longer in the selection (a manual/uncandidate row) sinks; one that
  // is in the selection gets its reserve.
  const { pool, nodes, onboarder, selections } = harness({
    count: 5,
    poolSize: 3,
    latencyMs: (port) => (BASE_PORT + 6 - port) * 120,
  })
  await onboarder.run(nodes)
  const before = selections.length
  const online = pool.list().map((entry) => entry.id).sort()
  const replaced = await onboarder.replace(online[0]!)

  assert.equal(replaced, true, 'the next-fastest reserve took the slot')
  assert.equal(selections.length, before + 1)
  assert.equal(pool.list().length, 3, 'the pool holds its capacity')
  assert.equal(pool.demoted(online[0]!), false, 'a promoted replacement is not a demotion')
})

/**
 * Live 2026-10-19: sing-box assigns one port per node INDEX, so a subscription
 * refresh that reorders or shrinks the node list retires ports. The pool kept
 * dialling one of them for hours — every request through it failed at CONNECT,
 * the row was struck dead, the trusted-admission fallback re-admitted it as
 * unverified (usable again), and a pin on it made the failure total.
 */
test('a refresh that retires a port drops the orphaned row, and unpins it', async () => {
  const pool = new ExitPool({ poolSize: 20 })
  const prober = new Prober({ pool, maxConcurrentProbes: 8 })
  const logs: string[] = []
  const logger = { info: (message: string) => logs.push(message), warn: (message: string) => logs.push(message) }
  const three = candidates(3)
  const [first, , third] = three as [ConvertedExit, ConvertedExit, ConvertedExit]
  // The next conversion keeps the third node where it is and moves the other to
  // a fresh port — the first two addresses no longer have a listener.
  const moved: ConvertedExit = { ...first, address: `127.0.0.1:${BASE_PORT + 9}`, slot: 9 }
  const second = [moved, third]
  let current = three
  const onboarder = new Onboarder({
    pool,
    prober,
    admission: { pool, undici: seam() as never, blockedCountries: ['CN'], smokeModel: 'big-pickle', logger },
    select: async (slots) => slots.map((slot) => current[slot]!),
    logger,
  })

  await onboarder.run(current)
  assert.equal(pool.list().length, 3)
  pool.pin(first.address)
  assert.equal(pool.pinnedId, first.address)

  current = second
  await onboarder.run(second)

  assert.ok(!pool.has(first.address), 'the retired port left the pool')
  assert.equal(pool.pinnedId, '', 'and took the pin with it (pool.remove clears it)')
  assert.ok(pool.has(third.address), 'a port the new conversion still serves stays')
  assert.ok(pool.has(moved.address), 'the moved node is admitted under its new port')
  assert.ok(logs.some((line) => line.includes('no longer serves') && line.includes(first.address)), 'the drop is logged')
})

test('an empty conversion prunes every port the last one opened', async () => {
  const pool = new ExitPool({ poolSize: 20 })
  const prober = new Prober({ pool, maxConcurrentProbes: 8 })
  const logger = { info: () => {}, warn: () => {} }
  const nodes = candidates(2)
  const onboarder = new Onboarder({
    pool,
    prober,
    admission: { pool, undici: seam() as never, blockedCountries: ['CN'], smokeModel: 'big-pickle', logger },
    select: async (slots) => slots.map((slot) => nodes[slot]!),
    logger,
  })
  await onboarder.run(nodes)
  assert.equal(pool.list().length, 2)
  await onboarder.run([])
  assert.equal(pool.list().length, 0, 'sing-box stopped: no listener survives, so no row survives')
})
