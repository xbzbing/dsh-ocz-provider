/**
 * Live-config tests for the pool assembly: manual rows and 固定主力 are part
 * of the settings card's contract (docs §5.1: a save takes effect without a
 * restart), and a pool that assembles EMPTY must engage routing by itself
 * once the first exit lands (subscription admissions included).
 *
 * The real startIpPool runs here; only the installer is faked, so nothing
 * touches a global dispatcher or the network (the free refill loop is off in
 * every config below).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import { buildPoolFromConfig, startIpPool, syncManualExits, applyProbeVerdict } from '../src/ip-pool.ts'
import { pickRelayEgress, settleRelayEgress, type RelayEgressPick } from '../src/relay/egress.ts'

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
  /** Every 本地出口兜底 value applied through setLocalFallback, in order. */
  const fallbacks: boolean[] = []
  let enabled = false
  return {
    calls,
    fallbacks,
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
    setLocalFallback(value: boolean): void {
      fallbacks.push(value)
    },
    get localFallback(): boolean {
      return fallbacks.at(-1) ?? false
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
  // manual/pinned are read at every sync, not only at assembly — otherwise an
  // edited 固定主力 leaves the stale pin winning pick() until a restart.
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

test('relay transport failure relabels and revives a manual row the listener disagrees with', async () => {
  // A transport cut is indistinguishable from a dead exit to the pool, so a
  // row whose listener speaks the other scheme would be struck while alive
  // (docs, egress row hygiene). The cut triggers one re-examination instead —
  // allowed only for rows with NO measured facts.
  let probes = 0
  const runtime = await startIpPool(
    { ipPool: { enabled: true, free: { enabled: false }, manual: ['127.0.0.1:30035'] } },
    quiet,
    {
      makeInstaller: () => fakeInstaller(),
      detectProtocol: async () => { probes += 1; return 'socks5' },
    },
  )
  assert.ok(runtime !== null)
  const row = runtime.pool.get('127.0.0.1:30035')
  assert.equal(row?.protocol, 'http', 'the row starts as the operator spelled it')

  const pick = pickRelayEgress({ model: 'mimo-v2.6-flash-free', session: 'ses_abc' })
  assert.ok(pick !== null && !('fail' in pick))
  settleRelayEgress(pick as RelayEgressPick, { transport: true })
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(probes, 1)
  assert.equal(runtime.pool.get('127.0.0.1:30035')?.protocol, 'socks5', 'the row now matches the listener')
  // Correcting the label must revive the row too: a healed reason on a
  // still-dead mark leaves nothing routable.
  const healed = runtime.pool.list().find((entry) => entry.id === '127.0.0.1:30035')
  assert.notEqual(healed?.health.state, 'dead', 'the mislabelled row is not left dead')
  assert.equal(runtime.pool.isUsable('127.0.0.1:30035', 'mimo-v2.6-flash-free'), true)

  // A corrected label is a new line, so the row earns a fresh grace: the next
  // cut asks the listener again (the label now matches, so nothing changes),
  // and only the cut after that — with still no success in between — strikes.
  settleRelayEgress(pick as RelayEgressPick, { transport: true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(probes, 2, 'a healed row is re-examined once on its next cut')
  assert.equal(runtime.pool.list().find((entry) => entry.id === '127.0.0.1:30035')?.health.state, 'unknown')

  settleRelayEgress(pick as RelayEgressPick, { transport: true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(probes, 2, 'and the grace is not renewable without a success')
  assert.equal(runtime.pool.list().find((entry) => entry.id === '127.0.0.1:30035')?.health.state, 'dead')
  await runtime.dispose()
})

test('relay transport failure never relabels a row that has measured facts', async () => {
  // A subscription exit's protocol came from real traffic; a transport cut
  // there means the exit is gone, not that its scheme was mistyped.
  let probes = 0
  const runtime = await startIpPool(
    { ipPool: { enabled: true, free: { enabled: false } } },
    quiet,
    {
      makeInstaller: () => fakeInstaller(),
      detectProtocol: async () => { probes += 1; return 'http' },
    },
  )
  assert.ok(runtime !== null)
  runtime.pool.add(node({ id: '127.0.0.1:30033', protocol: 'socks5', exitIP: '9.9.9.9' }))
  runtime.pool.markOk('127.0.0.1:30033')

  const pick = pickRelayEgress({ model: 'mimo-v2.6-flash-free', session: 'ses_abc' })
  assert.ok(pick !== null && !('fail' in pick))
  settleRelayEgress(pick as RelayEgressPick, { transport: true })
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(probes, 0, 'a measured row is not re-examined')
  assert.equal(runtime.pool.get('127.0.0.1:30033')?.protocol, 'socks5')
  assert.equal(runtime.pool.list().find((entry) => entry.id === '127.0.0.1:30033')?.health.state, 'dead', 'the cut is the verdict')
  await runtime.dispose()
})

// -- assembly wiring -----------------------------------------------------------

test('assembly: an empty pool still installs the dispatcher (本地出口兜底 decides what a miss means)', async () => {
  // The dispatcher installs regardless of occupancy. Two failure modes that
  // closes: a subscription-only profile that assembles empty and fills later
  // must already route (otherwise the card says enabled while every request
  // goes direct), and with the layer uninstalled an empty pool looks like
  // "no pool at all" — 本地出口兜底 can never refuse, so this machine's IP
  // rides the wire with nothing offered. Admissions only recover an R1
  // deferral.
  const installer = fakeInstaller()
  const runtime = await startIpPool(
    { ipPool: { enabled: true, free: { enabled: false } } },
    quiet,
    { makeInstaller: () => installer },
  )
  assert.ok(runtime !== null)
  assert.deepEqual(installer.calls, ['install'], 'installed with an empty pool')
  assert.equal(runtime.installer.enabled, true)

  runtime.pool.add(node({ id: '127.0.0.1:30005' }))
  assert.deepEqual(installer.calls, ['install'], 'already engaged: no re-install per admission')
  await runtime.dispose()
})

test('assembly: 本地出口兜底 reaches the installer at assembly and on every commit', async () => {
  const installer = fakeInstaller()
  let deps: { localFallback?: boolean } | undefined
  const runtime = await startIpPool(
    { ipPool: { enabled: true, free: { enabled: false }, localFallback: true } },
    quiet,
    { makeInstaller: (next) => { deps = next as { localFallback?: boolean }; return installer } },
  )
  assert.ok(runtime !== null)
  assert.equal(deps?.localFallback, true, 'the switch is part of the installer wiring')
  assert.deepEqual(installer.fallbacks, [true], 'and it is applied to the running router at assembly')

  await runtime.reconfigure({ ipPool: { enabled: true, free: { enabled: false }, localFallback: false } })
  assert.deepEqual(installer.fallbacks, [true, false], 'a settings commit flips it live, no restart')

  // Absent means OFF: the schema default is the strict reading.
  await runtime.reconfigure({ ipPool: { enabled: true, free: { enabled: false } } })
  assert.deepEqual(installer.fallbacks, [true, false, false], 'an absent field resolves to the strict default')
  await runtime.dispose()
})

/**
 * No periodic probe tick exists: liveness is judged by real requests
 * (recordPassive/recordPassiveTransport), never by a timer, so no probe
 * traffic runs at all unless an operator or an admission asks for it.
 */
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
  assert.equal(runtime.pool.pinnedId, '', 'and the pin is released')
  await runtime.dispose()
})

/**
 * Fake transport seam: answers the whole probe chain (ip echo → models → smoke)
 * and records every request body, so what the probe SENDS is observable
 * without a network.
 */
function fakeProbeTransport() {
  const requests: Array<{ url: string; body: string }> = []
  const echoBody = JSON.stringify({ status: 'success', query: '5.5.5.5', countryCode: 'US', city: 'city', country: 'c' })
  return {
    requests,
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
        requests.push({ url, body: typeof init?.body === 'string' ? init.body : '' })
        const body = url.includes('ip-api.com') ? echoBody : url.endsWith('/v1/models') ? '{"data":[]}' : '{"id":"x"}'
        return { statusCode: 200, body: { text: async () => body } }
      }) as never,
    },
  }
}

/**
 * Every smoke turn the probe chain sent, in order. An array rather than a
 * per-URL map on purpose: one pass over several models hits the SAME chat URL
 * twice, and the assertion is exactly about what those two requests carried.
 */
function smokeTurns(transport: ReturnType<typeof fakeProbeTransport>): string[] {
  return transport.requests
    .filter((request) => request.url.includes('/chat/completions'))
    .map((request) => {
      // messages[0] is the system slot carrying the `<env>` block the free lane
      // requires (adapter/env-block.ts); the probe sentence is the user turn.
      const messages = (JSON.parse(request.body) as { messages: Array<{ content: string }> }).messages
      return messages[messages.length - 1]!.content
    })
}

test('one probe content is drawn per exit pass, and a commit swaps the pool', async (t) => {
  // one random probe content per exit: a pass over several models is ONE
  // exit, so all of its smokes share the drawn turn; the next pass draws
  // again. The setting is live, not assembly-only.
  const transport = fakeProbeTransport()
  const runtime = await startIpPool(
    {
      ipPool: {
        enabled: true,
        free: { enabled: false },
        manual: ['http://127.0.0.1:7890'],
        probeModels: ['model-a', 'model-b'],
        probeContents: ['alpha', 'beta'],
      },
    },
    quiet,
    { makeInstaller: () => fakeInstaller(), undici: transport.undici },
  )
  assert.ok(runtime !== null)
  t.after(() => { void runtime.dispose() })

  // Math.random IS the production draw's source, so pinning it makes the
  // choice observable without another seam.
  t.mock.method(Math, 'random', () => 0)
  await runtime.probeExit('http://127.0.0.1:7890')
  assert.deepEqual(smokeTurns(transport), ['alpha', 'alpha'], 'both models of the pass send the ONE turn drawn for this exit')

  t.mock.method(Math, 'random', () => 0.99)
  await runtime.probeExit('http://127.0.0.1:7890')
  assert.deepEqual(smokeTurns(transport), ['alpha', 'alpha', 'beta', 'beta'], 'the next pass draws for this exit again')

  await runtime.reconfigure({
    ipPool: {
      enabled: true,
      free: { enabled: false },
      manual: ['http://127.0.0.1:7890'],
      probeModels: ['model-a', 'model-b'],
      probeContents: ['gamma'],
    },
  })
  await runtime.probeExit('http://127.0.0.1:7890')
  assert.deepEqual(smokeTurns(transport), ['alpha', 'alpha', 'beta', 'beta', 'gamma', 'gamma'], 'the next pass uses the committed pool — no restart')
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
  assert.deepEqual(smokeTurns(transport), ['hello'])
})

/**
 * The probe wiring itself, without a network. The trusted fallback returns
 * `admitted: true` (the line is kept, docs 4.5); a caller reading admission
 * as health would revive a dead exit on every probe round and feed it real
 * traffic, so only a verdict that actually verified the exit may mark it ok.
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
