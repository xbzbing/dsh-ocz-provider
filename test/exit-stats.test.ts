/**
 * Exit-stats surface tests (2026-10-13): per-exit activity (which exit is
 * being used right now), request-lifecycle bookkeeping in the routing
 * dispatcher, the direct-fallback bucket, and token attribution from the
 * adapter's `usage` chunks to the exit stamped into the ALS routing context.
 *
 * The load-bearing invariant: the dispatcher stamps contextStore.exitId at
 * pick(), and attributeUsage() records every usage chunk against exactly that
 * stamp — so a rotate restart splits tokens across the exits that carried
 * each attempt, and traffic that never entered the pool is never counted.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import { PoolRoutingDispatcher, resolveProxyHosts, routingContext, type RoutingContext } from '../src/pool/dispatcher.ts'
import { DIRECT_EXIT_ID, LOCAL_EXIT_ID, UsageTracker, attributeUsage, usageTracker } from '../src/pool/usage.ts'
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import type { HarnessChunk, PiDoneMessage, PiEvent } from '../src/adapter/events.ts'
import type { HarnessGenerateOptions } from '../src/adapter/messages.ts'

function node(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: 'h:1',
    protocol: 'http',
    source: 'manual',
    pinned: false,
    exitIP: '1.1.1.1',
    exitLocation: 'US city',
    latencyMs: 300,
    quality: 'S',
    addedAt: 0,
    ...overrides,
  }
}

/** A fake seam whose proxy dispatches capture the observer handler. */
function capturingSeam() {
  const captured: Array<Record<string, unknown>> = []
  const makeAgent = (tag: string) => ({
    dispatch(_opts: unknown, handler: unknown): boolean {
      if (tag !== 'direct') captured.push(handler as Record<string, unknown>)
      return true
    },
    close: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  })
  const direct = makeAgent('direct')
  const seam = {
    Agent: class {
      constructor(_options?: unknown) {
        return direct
      }
    },
    ProxyAgent: class {
      constructor(_options?: unknown) {
        return makeAgent('proxy')
      }
    },
    setGlobalDispatcher: () => undefined,
    getGlobalDispatcher: () => direct,
  }
  return { seam, captured }
}

const POOL_HOST = { origin: 'https://opencode.ai/zen/v1/chat/completions' } as never

// -- pool activity --------------------------------------------------------------

test('exit activity: last-used stamps, in-flight counts, floors and removal cleanup', () => {
  let now = 1_000
  const pool = new ExitPool({ now: () => now })
  pool.add(node({ id: 'a:1' }))

  assert.deepEqual(pool.activity('a:1'), { lastUsedAt: 0, inFlight: 0 })
  assert.deepEqual(pool.activity('never-seen'), { lastUsedAt: 0, inFlight: 0 }, 'unknown exits read zeros, not undefined')

  pool.beginRequest('a:1')
  now = 2_000
  pool.beginRequest('a:1')
  assert.deepEqual(pool.activity('a:1'), { lastUsedAt: 2_000, inFlight: 2 })

  pool.endRequest('a:1')
  pool.endRequest('a:1')
  pool.endRequest('a:1') // a double end must floor at zero, never go negative
  assert.equal(pool.activity('a:1').inFlight, 0)

  pool.recordDirectRequest()
  pool.recordDirectRequest()
  assert.equal(pool.directRequests, 2)

  pool.beginRequest('a:1')
  pool.remove('a:1')
  assert.deepEqual(pool.activity('a:1'), { lastUsedAt: 0, inFlight: 0 }, 'removing a row clears its activity')
})

// -- dispatcher attribution -------------------------------------------------------

test('dispatcher stamps the picked exit into the routing context', () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'p:1', latencyMs: 10 }))
  pool.markOk('p:1')
  const { seam } = capturingSeam()
  const router = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'] })

  const store: RoutingContext = { model: 'm', session: 's' }
  routingContext.run(store, () => {
    router.dispatch(POOL_HOST, {} as never)
  })
  assert.equal(store.exitId, 'p:1', 'the adapter reads this stamp back when usage lands')
  assert.equal(pool.activity('p:1').inFlight, 1, 'the dispatch booked a live request')
  assert.equal(pool.directRequests, 0)
})

test('dispatcher: direct bias stamps the direct bucket; foreign hosts stamp 本机', () => {
  const pool = new ExitPool() // empty → pick() returns null
  const { seam } = capturingSeam()
  const router = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'] })

  const fallback: RoutingContext = { model: 'm', session: 's' }
  routingContext.run(fallback, () => {
    router.dispatch(POOL_HOST, {} as never)
  })
  assert.equal(fallback.exitId, DIRECT_EXIT_ID)
  assert.equal(pool.directRequests, 1, 'pool-host traffic that dodged the pool is counted')

  const foreign: RoutingContext = { model: 'm', session: 's' }
  routingContext.run(foreign, () => {
    router.dispatch({ origin: 'https://example.com/x' } as never, {} as never)
  })
  assert.equal(foreign.exitId, LOCAL_EXIT_ID, 'non-pool hosts egress from this machine → 本机')
  assert.equal(pool.directRequests, 1, 'the fallback counter stays a pool-host measure')

  const loopback: RoutingContext = { model: 'm', session: 's' }
  routingContext.run(loopback, () => {
    router.dispatch({ origin: 'http://127.0.0.1:3080/status' } as never, {} as never)
  })
  assert.equal(loopback.exitId, undefined, 'loopback is the host talking to itself — never counted')
})

// -- proxy-host resolution (live regression, 2026-10-13) ---------------------------

test('proxy hosts: an empty list means the default, never an empty routing set', () => {
  // The live bug: the settings schema default is [], and the old
  // `options.proxyHosts ?? DEFAULT_PROXY_HOSTS` guard waved that through as
  // an EMPTY set — every request took the direct branch while /status kept
  // displaying opencode.ai, so the pool looked enabled and routed nothing.
  assert.deepEqual(resolveProxyHosts([]), ['opencode.ai'])
  assert.deepEqual(resolveProxyHosts(undefined), ['opencode.ai'])
  assert.deepEqual(resolveProxyHosts(['']), ['opencode.ai'], 'blank entries are not hosts')
  assert.deepEqual(resolveProxyHosts(['API.Example.com:443']), ['api.example.com'])

  const pool = new ExitPool()
  pool.add(node({ id: 'p:1', latencyMs: 10 }))
  pool.markOk('p:1')
  const { seam } = capturingSeam()
  const router = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: [] })

  const store: RoutingContext = { model: 'm', session: 's' }
  routingContext.run(store, () => {
    router.dispatch(POOL_HOST, {} as never)
  })
  assert.equal(store.exitId, 'p:1', 'an empty configured list still routes the default host through the pool')
  assert.equal(pool.activity('p:1').inFlight, 1)
  assert.equal(pool.directRequests, 0)

  router.setProxyHosts([])
  const after: RoutingContext = { model: 'm', session: 's' }
  routingContext.run(after, () => {
    router.dispatch(POOL_HOST, {} as never)
  })
  assert.equal(after.exitId, 'p:1', 'the live re-apply keeps the same empty-means-default rule')
})

test('request lifecycle: exactly one end per dispatch, even with a double terminal', () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'p:1', latencyMs: 10 }))
  pool.markOk('p:1')
  const { seam, captured } = capturingSeam()
  const router = new PoolRoutingDispatcher({ pool, undici: seam as never, proxyHosts: ['opencode.ai'] })

  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch(POOL_HOST, {} as never)
  })
  assert.equal(pool.activity('p:1').inFlight, 1)

  const observer = captured[0]!
  ;(observer.onResponseEnd as (c: unknown, t: unknown) => void)({}, [])
  assert.equal(pool.activity('p:1').inFlight, 0, 'response end closes the request')
  ;(observer.onResponseEnd as (c: unknown, t: unknown) => void)({}, [])
  assert.equal(pool.activity('p:1').inFlight, 0, 'a repeated terminal never drives it negative')
})

test('the silence sentinel ends a request that never got a single callback', async () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'p:1', latencyMs: 10 }))
  pool.markOk('p:1')
  const { seam } = capturingSeam()
  const router = new PoolRoutingDispatcher({
    pool,
    undici: seam as never,
    proxyHosts: ['opencode.ai'],
    sentinelMs: 5,
  })

  routingContext.run({ model: 'm', session: 's' }, () => {
    router.dispatch(POOL_HOST, {} as never)
  })
  assert.equal(pool.activity('p:1').inFlight, 1)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(pool.activity('p:1').inFlight, 0, 'window (a) fired → classifyTransport ends the request')
  assert.equal(pool.passiveStats('p:1').transport, 1, 'and the passive counter saw the mute connection')
})

// -- token accounting --------------------------------------------------------------

test('UsageTracker accumulates per exit, keeps cache buckets separate, resets clean', () => {
  const tracker = new UsageTracker()
  tracker.record('e:1', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, durationMs: 1_500 })
  tracker.record('e:1', { inputTokens: 10, outputTokens: 5, durationMs: 500 })
  tracker.record(DIRECT_EXIT_ID, {})
  assert.deepEqual(tracker.totals('e:1'), {
    requests: 2, inputTokens: 110, outputTokens: 55, cacheReadTokens: 40, cacheWriteTokens: 0, totalTokens: 165, outputMs: 2_000,
  })
  assert.deepEqual(tracker.totals('direct'), {
    requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, outputMs: 0,
  })
  assert.deepEqual(tracker.totals('unknown'), {
    requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, outputMs: 0,
  })
  assert.deepEqual([...tracker.exits()].sort(), ['direct', 'e:1'])
  tracker.reset()
  assert.equal(tracker.totals('e:1').requests, 0)
})

test('attributeUsage records stamped usage and passes every chunk through untouched', async () => {
  const tracker = new UsageTracker()
  const usage: HarnessChunk = { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 } }
  const store: { exitId?: string } = { exitId: 'x:1' }
  // Two responses in one stream: deltas at t=0/t=100, usage at t=250/t=400 —
  // each usage closes its OWN decode window at the delta that opened it.
  const clock = { at: 0 }
  const now = (): number => clock.at
  const source = (async function* () {
    clock.at = 0; yield { type: 'text-delta', index: 0, text: 'a' } satisfies HarnessChunk
    clock.at = 250; yield usage
    clock.at = 300; yield { type: 'text-delta', index: 0, text: 'b' } satisfies HarnessChunk
    clock.at = 400; yield usage
  })()

  const out: HarnessChunk[] = []
  for await (const chunk of attributeUsage(store, source, tracker, now)) out.push(chunk)
  assert.equal(out.length, 4)
  assert.equal(out[1], usage, 'identity preserved — the wrapper never rewrites the stream')
  assert.deepEqual(tracker.totals('x:1'), {
    requests: 2, inputTokens: 14, outputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 0, totalTokens: 20, outputMs: 350,
  }, 'decode windows: 250ms + 100ms')

  const bare: { exitId?: string } = {}
  const untouched = (async function*() { yield usage })()
  for await (const chunk of attributeUsage(bare, untouched, tracker)) assert.equal(chunk, usage)
  assert.deepEqual(tracker.totals(LOCAL_EXIT_ID), {
    requests: 1, inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0, totalTokens: 10, outputMs: 0,
  }, 'no stamp = egressed from this machine (本机), never an uncounted sample; no delta = no decode window')
})

// -- adapter end-to-end -------------------------------------------------------------

const options: HarnessGenerateOptions = {
  provider: 'opencode-zen',
  model: 'mimo-v2.6-flash-free',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hi.' }] }],
  maxTokens: 64,
}

function doneMessage(): PiDoneMessage {
  return {
    api: 'openai-completions', provider: 'opencode-zen', model: options.model,
    content: [{ type: 'text', text: 'hi' }],
    stopReason: 'stop',
    usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 2, totalTokens: 30 },
  }
}

function answer(): PiEvent[] {
  const partial = { content: [{ type: 'text', text: 'hi' }] }
  return [
    { type: 'text_start', contentIndex: 0, partial },
    { type: 'text_delta', contentIndex: 0, delta: 'hi', partial },
    { type: 'text_end', contentIndex: 0, content: 'hi', partial },
    { type: 'done', message: doneMessage() },
  ]
}

/** Adapter over a fake provider that stamps the ALS store exactly like the
 *  dispatcher does at pick() (`stamp: undefined` = a request outside the pool). */
function scripted(stamp: string | undefined) {
  const events = answer()
  const adapter = new ZenAdapter({
    list: () => [options.model],
    decision: () => ({ allowed: true, known: true, source: 'test' }),
    reasoningCapability: () => undefined,
  }, { providerOverride: {
    streamSimple() {
      const store = routingContext.getStore()
      if (store !== undefined && stamp !== undefined) store.exitId = stamp
      return (async function* () {
        for (const event of events) yield event
      })()
    },
  } })
  return adapter
}

test('adapter e2e: usage lands on the stamped exit; unstamped traffic lands on 本机', async () => {
  usageTracker.reset()
  try {
    const chunks: HarnessChunk[] = []
    for await (const chunk of scripted('h:9').stream(options)) chunks.push(chunk)
    assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 2 } })
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
    // The decode window is wall-clock, so its exact ms is not assertable
    // here — pin every counter and require the window to be a real number.
    const { outputMs, ...exitCounters } = usageTracker.totals('h:9')
    assert.deepEqual(exitCounters, {
      requests: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 30,
    })
    assert.ok(outputMs >= 0 && Number.isFinite(outputMs), 'the stamped exit carries a decode window')

    for await (const _chunk of scripted(undefined).stream(options)) { /* drain */ }
    assert.equal(usageTracker.totals('h:9').requests, 1, 'the unstamped run added nothing to the exit')
    const { outputMs: localMs, ...localCounters } = usageTracker.totals(LOCAL_EXIT_ID)
    assert.deepEqual(localCounters, {
      requests: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 2, totalTokens: 30,
    }, 'a request that never entered the pool is 本机 traffic, not a dropped sample')
    assert.ok(localMs >= 0 && Number.isFinite(localMs), 'the 本机 bucket carries its own decode window')
    assert.ok(usageTracker.lastUsedAt(LOCAL_EXIT_ID) > 0, 'and it stamps the 本机 last-used column')
  } finally {
    usageTracker.reset()
  }
})
