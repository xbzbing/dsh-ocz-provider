import test from 'node:test'
import assert from 'node:assert/strict'
import { bridgeErrorText, exitAction, postBridge } from '../src/client/bridge-client.ts'
import { createPoolStatusStore, type PoolStatusEnv } from '../src/client/pool-status-store.ts'
import type { PoolStatusView } from '../src/client/types.ts'

/** A fetch stub answering one JSON body and recording the request. */
function stubFetch(status: number, body: unknown, calls: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
}

test('postBridge returns the value of an ok reply and posts JSON to the prefixed route', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const reply = await postBridge<{ queued: number }>('/probe', { scope: 'all' }, { fetch: stubFetch(200, { ok: true, value: { queued: 3 } }, calls) })
  assert.deepEqual(reply, { ok: true, value: { queued: 3 } })
  assert.equal(calls[0]!.url, '/api/oc2dsh/ip-pool/probe')
  assert.equal(calls[0]!.init.method, 'POST')
  assert.equal(calls[0]!.init.body, '{"scope":"all"}')
})

test('postBridge passes the host failure code and message through', async () => {
  const reply = await postBridge('/exit', {}, {
    fetch: stubFetch(200, { ok: false, code: 'exit-unreachable', message: '出口 x 没有监听' }),
  })
  assert.deepEqual(reply, { ok: false, code: 'exit-unreachable', message: '出口 x 没有监听' })
  assert.ok(!reply.ok)
  assert.equal(bridgeErrorText(reply, 'Action failed'), '出口 x 没有监听')
})

test('postBridge folds a handler 500, a guard 403, bad JSON and a network error into failures', async () => {
  const internal = await postBridge('/status', {}, { fetch: stubFetch(500, { ok: false, code: 'internal', message: 'boom' }) })
  assert.deepEqual(internal, { ok: false, code: 'internal', message: 'boom' })
  const forbidden = await postBridge('/status', {}, { fetch: stubFetch(403, { error: 'forbidden' }) })
  assert.deepEqual(forbidden, { ok: false, code: 'client-http-403', message: 'forbidden' })
  const garbled = await postBridge('/status', {}, { fetch: stubFetch(502, '<html>') })
  assert.deepEqual(garbled, { ok: false, code: 'client-bad-response', message: 'HTTP 502' })
  const offline = await postBridge('/status', {}, { fetch: (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch })
  assert.equal(offline.ok, false)
  assert.ok(!offline.ok && offline.code === 'client-network')
  assert.ok(!offline.ok && bridgeErrorText(offline, 'Action failed') === 'Action failed', 'transport failures use the localized fallback')
})

test('exitAction sends the exit id only for actions that name a row', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetch = stubFetch(200, { ok: true, value: {} }, calls)
  await exitAction('pin', 'http://127.0.0.1:1', { fetch })
  await exitAction('unpin', undefined, { fetch })
  await exitAction('pin-local', undefined, { fetch })
  assert.deepEqual(calls.map((call) => JSON.parse(String(call.init.body))), [
    { action: 'pin', exitId: 'http://127.0.0.1:1' },
    { action: 'unpin' },
    { action: 'pin-local' },
  ])
  assert.ok(calls.every((call) => call.url === '/api/oc2dsh/ip-pool/exit'))
})

/** A manual environment: timers fire on demand, fetches resolve on demand. */
function manualEnv() {
  const timers: Array<{ run: () => void; ms: number; live: boolean }> = []
  const pending: Array<{ resolve: (value: PoolStatusView) => void; fail: () => void; signal: AbortSignal }> = []
  let hidden = false
  let onVisibility: (() => void) | null = null
  const env: PoolStatusEnv = {
    fetchStatus: (signal) => new Promise((resolve) => {
      pending.push({
        resolve: (value) => resolve({ ok: true, value }),
        fail: () => resolve({ ok: false, code: 'internal', message: 'boom' }),
        signal,
      })
    }),
    setTimer: (run, ms) => { const timer = { run, ms, live: true }; timers.push(timer); return timer },
    clearTimer: (handle) => { (handle as { live: boolean }).live = false },
    isHidden: () => hidden,
    onVisibilityChange: (listener) => { onVisibility = listener; return () => { onVisibility = null } },
    now: () => 1_000,
  }
  return {
    env, timers, pending,
    liveTimers: () => timers.filter((timer) => timer.live),
    setHidden: (next: boolean) => { hidden = next; onVisibility?.() },
  }
}

const view = (at: number): PoolStatusView => ({ at } as PoolStatusView)
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('the status store keeps one request in flight and drops superseded answers', async () => {
  const m = manualEnv()
  const store = createPoolStatusStore(m.env)
  const a = Symbol('a')
  store.setRate(a, 3_000)
  assert.equal(m.pending.length, 1, 'the first subscriber fetches at once')
  const forced = store.refresh()
  assert.equal(m.pending.length, 2)
  assert.equal(m.pending[0]!.signal.aborted, true, 'a forced refresh aborts the older request')
  m.pending[1]!.resolve(view(2))
  await forced
  m.pending[0]!.resolve(view(1))
  await flush()
  assert.equal(store.getSnapshot().status?.at, 2, 'the older answer never overwrites the newer one')
})

test('the status store polls at the fastest rate and pauses while hidden', async () => {
  const m = manualEnv()
  const store = createPoolStatusStore(m.env)
  const card = Symbol('card')
  const modal = Symbol('modal')
  store.setRate(card, 3_000)
  m.pending[0]!.resolve(view(1))
  await flush()
  assert.deepEqual(m.liveTimers().map((timer) => timer.ms), [3_000])
  store.setRate(modal, 2_000)
  assert.deepEqual(m.liveTimers().map((timer) => timer.ms), [2_000])
  m.setHidden(true)
  assert.deepEqual(m.liveTimers(), [], 'no timer while the document is hidden')
  m.setHidden(false)
  assert.equal(m.pending.length, 2, 'becoming visible refreshes at once')
  store.removeRate(card)
  store.removeRate(modal)
  m.pending[1]!.resolve(view(2))
  await flush()
  assert.deepEqual(m.liveTimers(), [], 'no subscribers, no polling')
})

test('a failed refresh keeps the last good status and reports the error', async () => {
  const m = manualEnv()
  const store = createPoolStatusStore(m.env)
  store.setRate(Symbol('a'), 3_000)
  m.pending[0]!.resolve(view(1))
  await flush()
  void store.refresh()
  m.pending[1]!.fail()
  await flush()
  const state = store.getSnapshot()
  assert.equal(state.status?.at, 1)
  assert.deepEqual(state.error, { code: 'internal', message: 'boom' })
  assert.equal(state.updatedAt, 1_000)
})
