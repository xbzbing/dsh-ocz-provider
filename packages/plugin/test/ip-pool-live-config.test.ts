/**
 * Live-config tests for the pool assembly: manual rows and 固定主力 are part
 * of the settings card's contract (docs §5.1 / IP-5 "保存即生效无需重启"), and a
 * pool that assembles EMPTY must engage routing by itself once the first exit
 * lands (subscription admissions included).
 *
 * The real startIpPool runs here; only the installer is faked, so nothing
 * touches a global dispatcher or the network (the free refill loop is off in
 * every config below).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import { buildPoolFromConfig, startIpPool, syncManualExits, applyProbeVerdict, probeTickEnabled } from '../src/ip-pool.ts'

const quiet = { info: () => {}, warn: () => {} }

function node(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: 'h:1',
    protocol: 'socks5',
    source: 'subscription',
    pinned: false,
    exitIP: '',
    exitLocation: '',
    latencyMs: 0,
    quality: 'S',
    addedAt: 0,
    ...overrides,
  }
}

const ids = (pool: ExitPool): string[] => pool.list().map((entry) => entry.id).sort()

/** Fake installer: records calls, keeps every global untouched. */
function fakeInstaller() {
  const calls: string[] = []
  let enabled = false
  return {
    calls,
    install(): void {
      calls.push('install')
      enabled = true
    },
    disable(): void {
      calls.push('disable')
      enabled = false
    },
    dispose(): void {
      calls.push('dispose')
      enabled = false
    },
    get enabled(): boolean {
      return enabled
    },
    deferredReason: null as string | null,
  }
}

// -- syncManualExits: the one path assembly and live commits share -------------

test('syncManualExits: assembly parity with buildPoolFromConfig', () => {
  const config = {
    ipPool: {
      manual: ['http://127.0.0.1:7890', 'socks5://127.0.0.1:1080'],
      pinnedExitId: 'http://127.0.0.1:7890',
    },
  }
  const pool = buildPoolFromConfig(config)
  assert.deepEqual(ids(pool), ['http://127.0.0.1:7890', 'socks5://127.0.0.1:1080'])
  assert.equal(pool.pinnedId, 'http://127.0.0.1:7890')
  assert.equal(pool.get('http://127.0.0.1:7890')?.pinned, true, 'the pinned row carries the flag admission reads')
  assert.equal(pool.get('socks5://127.0.0.1:1080')?.source, 'manual')
})

test('syncManualExits: an edit drops the old rows and re-pins, no restart', () => {
  // Regression (live 2026-10-12): editing 固定主力 in the settings card wrote
  // the config and reconfigured the runtime, but manual/pinned were read only
  // at assembly — the stale pin kept winning pick() until a restart.
  const pool = new ExitPool()
  syncManualExits(pool, { manual: ['http://a:1', 'http://b:2'], pinnedExitId: 'http://a:1' })
  syncManualExits(pool, { manual: ['http://b:2', 'http://c:3'], pinnedExitId: 'http://c:3' })
  assert.deepEqual(ids(pool), ['http://b:2', 'http://c:3'], 'the deleted row left the table')
  assert.equal(pool.pinnedId, 'http://c:3', 'the new 固定主力 took over')

  syncManualExits(pool, { manual: ['http://b:2', 'http://c:3'], pinnedExitId: '' })
  assert.equal(pool.pinnedId, '', 'clearing 固定主力 unpins live')
  assert.ok(pool.list().every((entry) => !entry.pinned), 'no stale pinned flag survives the unpin')
})

test('syncManualExits: idempotent, keeps probe state, never touches other sources', () => {
  const pool = new ExitPool()
  pool.add(node({ id: '10.0.0.9:1080', exitIP: '9.9.9.9' }))
  syncManualExits(pool, { manual: ['http://a:1'] })
  pool.markDead('http://a:1')
  syncManualExits(pool, { manual: ['http://a:1'] })
  assert.deepEqual(ids(pool), ['10.0.0.9:1080', 'http://a:1'])
  assert.equal(pool.list().find((entry) => entry.id === 'http://a:1')?.health.state, 'dead', 're-applying the same config must not reset probe state')
})

test('syncManualExits: pinning an admitted exit keeps the row and its source', () => {
  const pool = new ExitPool()
  pool.add(node({ id: '127.0.0.1:30005', exitIP: '1.2.3.4' }))
  syncManualExits(pool, { pinnedExitId: '127.0.0.1:30005' })
  assert.equal(pool.get('127.0.0.1:30005')?.source, 'subscription', 'pinning must not re-label the row manual')
  assert.equal(pool.pinnedId, '127.0.0.1:30005')
  assert.equal(pool.get('127.0.0.1:30005')?.pinned, true)
})

// -- assembly wiring -----------------------------------------------------------

test('assembly: an empty pool installs nothing; the first admitted exit engages routing', async () => {
  // Regression (live 2026-10-12): a subscription-only profile assembled empty,
  // filled up minutes later, and NEVER installed the dispatcher — the card
  // reported the pool as enabled while every request kept going direct. The
  // free refill loop had its own hook; nothing watched subscription admissions.
  const installer = fakeInstaller()
  const runtime = await startIpPool(
    { ipPool: { enabled: true, free: { enabled: false } } },
    quiet,
    { makeInstaller: () => installer },
  )
  assert.ok(runtime !== null)
  assert.deepEqual(installer.calls, [], 'nothing to route through yet')

  runtime.pool.add(node({ id: '127.0.0.1:30005' }))
  assert.deepEqual(installer.calls, ['install'], 'the first exit engages routing without a settings save')
  assert.equal(runtime.installer.enabled, true)

  runtime.pool.add(node({ id: '127.0.0.1:30006' }))
  assert.deepEqual(installer.calls, ['install'], 'already engaged: no re-install per admission')
  await runtime.dispose()
})

/**
 * Live 2026-10-13: with the pool switched OFF the settings card still showed
 * 13 exits — not because they were in use, but because the periodic probe tick
 * kept working (8 queued, 3 in flight, 70 enqueued lifetime) while nothing
 * routed through an exit. Off has to mean off, and the polarity here is the
 * load-bearing part: defaulting the tick off would silently stop probing for
 * everyone.
 */
test('probeTickEnabled: absent means on, only an explicit false pauses the tick', () => {
  assert.equal(probeTickEnabled(undefined), true, 'the documented default is enabled')
  assert.equal(probeTickEnabled({}), true)
  assert.equal(probeTickEnabled({ enabled: true }), true)
  assert.equal(probeTickEnabled({ enabled: false }), false, 'off means off')
})

test('assembly: manual rows and the pin apply live through reconfigure', async () => {
  const installer = fakeInstaller()
  const runtime = await startIpPool(
    { ipPool: { enabled: true, free: { enabled: false } } },
    quiet,
    { makeInstaller: () => installer },
  )
  assert.ok(runtime !== null)

  await runtime.reconfigure({
    ipPool: { enabled: true, free: { enabled: false }, manual: ['http://127.0.0.1:7890'], pinnedExitId: 'http://127.0.0.1:7890' },
  })
  assert.deepEqual(ids(runtime.pool), ['http://127.0.0.1:7890'])
  assert.equal(runtime.pool.pinnedId, 'http://127.0.0.1:7890')

  await runtime.reconfigure({ ipPool: { enabled: true, free: { enabled: false }, manual: [], pinnedExitId: '' } })
  assert.deepEqual(ids(runtime.pool), [], 'the removed row leaves the live table')
  assert.equal(runtime.pool.pinnedId, '', 'and the pin is released — the exact edit that used to need a restart')
  await runtime.dispose()
})

/**
 * Fake transport seam: answers the whole probe chain (ip echo → models → smoke)
 * and records every request body, so what the probe SENDS is observable
 * without a network.
 */
function fakeProbeTransport() {
  const bodies = new Map<string, string>()
  const echoBody = JSON.stringify({ status: 'success', query: '5.5.5.5', countryCode: 'US', city: 'city', country: 'c' })
  return {
    bodies,
    undici: {
      Agent: class {} as never,
      ProxyAgent: class {
        constructor(_options: { uri: string }) {}
        close() { return Promise.resolve() }
        destroy() { return Promise.resolve() }
      } as never,
      setGlobalDispatcher: (() => {}) as never,
      getGlobalDispatcher: (() => ({})) as never,
      request: (async (url: string, init?: { body?: string }) => {
        if (typeof init?.body === 'string') bodies.set(url, init.body)
        const body = url.includes('ip-api.com') ? echoBody : url.endsWith('/v1/models') ? '{"data":[]}' : '{"id":"x"}'
        return { statusCode: 200, body: { text: async () => body } }
      }) as never,
    },
  }
}

/** The smoke request's user turn, read back out of the captured chat body. */
function smokeTurn(transport: ReturnType<typeof fakeProbeTransport>): string {
  const entry = [...transport.bodies.entries()].find(([url]) => url.includes('/chat/completions'))
  assert.ok(entry, 'the probe reached the anonymous-lane smoke')
  return (JSON.parse(entry[1]) as { messages: Array<{ content: string }> }).messages[0]!.content
}

test('the probe content pool reaches the live probe, and a commit swaps it', async (t) => {
  // Live request 2026-10-14: 增加探测文案的配置，允许自定义多个 content，
  // 探索时随机选择 — the setting has to be live, not assembly-only.
  const transport = fakeProbeTransport()
  const runtime = await startIpPool(
    { ipPool: { enabled: true, free: { enabled: false }, manual: ['http://127.0.0.1:7890'], probeContents: ['alpha', 'beta'] } },
    quiet,
    { makeInstaller: () => fakeInstaller(), undici: transport.undici },
  )
  assert.ok(runtime !== null)
  t.after(() => { void runtime.dispose() })

  // Math.random IS the production pick's source, so pinning it makes the draw
  // observable without another seam.
  t.mock.method(Math, 'random', () => 0)
  await runtime.probeExit('http://127.0.0.1:7890')
  assert.equal(smokeTurn(transport), 'alpha')

  t.mock.method(Math, 'random', () => 0.99)
  await runtime.probeExit('http://127.0.0.1:7890')
  assert.equal(smokeTurn(transport), 'beta', 'every probe draws again from the pool')

  await runtime.reconfigure({
    ipPool: { enabled: true, free: { enabled: false }, manual: ['http://127.0.0.1:7890'], probeContents: ['gamma'] },
  })
  await runtime.probeExit('http://127.0.0.1:7890')
  assert.equal(smokeTurn(transport), 'gamma', 'the next probe uses the committed pool — no restart')
})

test('an unconfigured probe content pool sends the default turn', async (t) => {
  const transport = fakeProbeTransport()
  const runtime = await startIpPool(
    { ipPool: { enabled: true, free: { enabled: false }, manual: ['http://127.0.0.1:7890'] } },
    quiet,
    { makeInstaller: () => fakeInstaller(), undici: transport.undici },
  )
  assert.ok(runtime !== null)
  t.after(() => { void runtime.dispose() })
  await runtime.probeExit('http://127.0.0.1:7890')
  assert.equal(smokeTurn(transport), 'hello')
})

/**
 * The probe wiring itself, without a network. Live 2026-10-13: the trusted
 * fallback returns `admitted: true` (the line is kept, docs 4.5) and the
 * caller read that as "healthy", so a dead exit was revived on every probe
 * round and fed real traffic. Only a verdict that actually verified the exit
 * may mark it ok.
 */
test('applyProbeVerdict: unverified never marks an exit ok, and cannot revive a dead one', () => {
  const pool = new ExitPool()
  pool.add(node({ id: 'sub:1' }))

  pool.markOk('sub:1')
  applyProbeVerdict(pool, 'sub:1', { admitted: true, unverified: true, reason: 'zen models HTTP 502' }, 'big-pickle')
  assert.equal(pool.list()[0]!.health.state, 'unknown', 'kept unverified, not ok')

  pool.markOk('sub:1')
  applyProbeVerdict(pool, 'sub:1', { admitted: true, limited: true, reason: 'zen smoke HTTP 429' }, 'big-pickle')
  assert.equal(pool.list()[0]!.health.state, 'ok', 'a 429 exit is alive — the tunnel answered')
  assert.ok(pool.list()[0]!.health.cooldownUntil > Date.now(), 'and it cools')

  pool.markOk('sub:1')
  applyProbeVerdict(pool, 'sub:1', { admitted: true, node: undefined }, 'big-pickle')
  assert.equal(pool.list()[0]!.health.state, 'ok', 'a plain verified pass is still ok')

  pool.markDeadStrike('sub:1')
  applyProbeVerdict(pool, 'sub:1', { admitted: true, unverified: true }, 'big-pickle')
  assert.notEqual(pool.list()[0]!.health.state, 'ok', 'the fallback can never claim a dead exit is healthy')
})

test('syncManualExits: pinnedExitId "local" pins this machine and admits no row', () => {
  // The stats modal's 本机 固定 button writes this sentinel. It is not an
  // address, so the manual-row path (parseManualProxy) must not see it: a
  // rejection there would read as "nothing pinned" and the click would do
  // nothing at all.
  const pool = new ExitPool()
  syncManualExits(pool, { manual: ['http://b:2'], pinnedExitId: 'local' })
  assert.deepEqual(ids(pool), ['http://b:2'], 'the sentinel is never admitted as a manual row')
  assert.equal(pool.pinnedLocal, true)
  assert.equal(pool.pinnedId, 'local')

  // Switching back to an address pin: the local sentinel must give way.
  syncManualExits(pool, { manual: ['http://b:2'], pinnedExitId: 'http://b:2' })
  assert.equal(pool.pinnedLocal, false)
  assert.equal(pool.pinnedId, 'http://b:2')

  // And clearing the pin entirely leaves neither.
  syncManualExits(pool, { manual: ['http://b:2'], pinnedExitId: '' })
  assert.equal(pool.pinnedId, '')
})
