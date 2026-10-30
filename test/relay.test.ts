import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_RELAY_UPSTREAM, RelaySupervisor, defaultRelayScript, findBun } from '../src/relay/supervisor.ts'
import { EGRESS_HEADER, directEgressDirective, hasRelayEgress, isRelayTransportFailure, pickRelayEgress, setRelayEgressSeams, settleRelayEgress, statusOfFailure } from '../src/relay/egress.ts'

/**
 * The relay is the connection-stack half of the free-lane gate, which no
 * payload edit can satisfy: requests must leave through Bun. These tests cover
 * the lifecycle contract the adapter depends on — a fake child stands in for
 * bun, so nothing here spawns a process or opens a socket.
 */

/** A fake relay child: emits the ready line on demand, like the real script. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  pid = 4242
  killed = false
  /** The supervisor detaches the child so it can never hold the host's loop. */
  unref(): void {}
  emitReady(port: number): void {
    this.stdout.write(`OC2DSH_RELAY_READY ${port}\n`)
  }
  kill(): boolean {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }
}

/** Build a supervisor over a fake child; `health` decides the probe outcome. */
function makeSupervisor(options: {
  bunPath?: string
  health?: () => Promise<unknown>
  /** Config port handed to the child (0 = ephemeral). */
  port?: number
  /** The port the fake child reports (never 0 — that is what a real relay avoids). */
  reportedPort?: number
  maxRestarts?: number
  healthyResetMs?: number
  /** Replaces the default "report ready one tick later" behaviour. */
  onSpawn?: (child: FakeChild) => void
} = {}) {
  const children: FakeChild[] = []
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  const probes: string[] = []
  const warnings: string[] = []
  const supervisor = new RelaySupervisor({
    config: { ...(options.bunPath !== undefined ? { bunPath: options.bunPath } : {}), ...(options.port !== undefined ? { port: options.port } : {}) },
    scriptPath: '/fake/oc2dsh-relay.mjs',
    spawnImpl: ((command: string, args: string[], spawnOptions: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: spawnOptions.env })
      const child = new FakeChild()
      children.push(child)
      // The real relay reports its port one tick after spawn.
      if (options.onSpawn !== undefined) options.onSpawn(child)
      else setTimeout(() => child.emitReady(options.reportedPort ?? 45678), 1)
      return child as unknown as never
    }) as never,
    healthFetch: async (url: string) => {
      probes.push(url)
      return (options.health ?? (async () => ({ ok: true })))()
    },
    readyTimeoutMs: 2_000,
    logger: { info: () => {}, warn: (message: string) => warnings.push(message) },
    ...(options.maxRestarts !== undefined ? { maxRestarts: options.maxRestarts } : {}),
    ...(options.healthyResetMs !== undefined ? { healthyResetMs: options.healthyResetMs } : {}),
  })
  return { supervisor, children, calls, probes, warnings }
}

/** The per-spawn token a supervisor handed its child. */
function tokenOf(call: { env: NodeJS.ProcessEnv }): string {
  return String(call.env.OC2DSH_RELAY_TOKEN ?? '')
}

/** A throwaway file that findBun() accepts as an explicit bun path. */
async function withFakeBun(fn: (bun: string) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'oc2dsh-bun-'))
  const bun = join(temp, 'bun')
  await writeFile(bun, '')
  try {
    await fn(bun)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

test('the relay starts, reports its port, and exposes a loopback base URL', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'oc2dsh-bun-'))
  const bun = join(temp, 'bun')
  await writeFile(bun, '')
  try {
    const { supervisor, calls, probes } = makeSupervisor({ bunPath: bun, port: 0 })
    const baseUrl = await supervisor.start()
    const token = tokenOf(calls[0]!)
    assert.match(token, /^[0-9a-f]{48}$/, 'a 192-bit per-spawn token')
    assert.equal(baseUrl, `http://127.0.0.1:45678/_/${token}`)
    assert.equal(supervisor.baseUrl, baseUrl)
    assert.deepEqual(probes, [`http://127.0.0.1:45678/_/${token}/__oc2dsh/health`], 'health rides the token prefix too')
    assert.equal(supervisor.status().active, true)
    assert.equal(supervisor.status().baseUrl, 'http://127.0.0.1:45678', 'diagnostics never carry the token')
    assert.equal(supervisor.status().bunPath, bun)
    // The child is told to watch stdin (parent-death watchdog) and where to go.
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.command, bun)
    assert.deepEqual(calls[0]!.args, ['/fake/oc2dsh-relay.mjs'])
    assert.equal(calls[0]!.env.OC2DSH_RELAY_WATCH_STDIN, '1')
    assert.equal(calls[0]!.env.OC2DSH_RELAY_UPSTREAM, DEFAULT_RELAY_UPSTREAM)
    assert.equal(calls[0]!.env.OC2DSH_RELAY_PORT, '0')
    await supervisor.stop()
    assert.equal(supervisor.baseUrl, null)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('baseUrlFor keeps the lane origin path (the ladder moves between /inference and /zen)', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'oc2dsh-bun-'))
  const bun = join(temp, 'bun')
  await writeFile(bun, '')
  try {
    const { supervisor, calls } = makeSupervisor({ bunPath: bun })
    assert.equal(supervisor.baseUrlFor('https://opencode.ai/inference'), null, 'no relay yet')
    await supervisor.start()
    const base = `http://127.0.0.1:45678/_/${tokenOf(calls[0]!)}`
    assert.equal(supervisor.baseUrlFor('https://opencode.ai/inference'), `${base}/inference`)
    assert.equal(supervisor.baseUrlFor('https://opencode.ai/zen/'), `${base}/zen`)
    assert.equal(supervisor.baseUrlFor('not a url'), base)
    await supervisor.stop()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('a machine without bun keeps working: no relay, a stated reason, no throw', async () => {
  const { supervisor, warnings } = makeSupervisor({ bunPath: join(tmpdir(), 'definitely-not-bun') })
  const baseUrl = await supervisor.start()
  assert.equal(baseUrl, null)
  assert.equal(supervisor.status().active, false)
  assert.match(supervisor.status().lastError, /no bun binary found/)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /429/)
})

test('a disabled relay never spawns', async () => {
  const supervisor = new RelaySupervisor({ config: { enabled: false }, spawnImpl: (() => assert.fail('spawned')) as never })
  assert.equal(await supervisor.start(), null)
  assert.match(supervisor.status().lastError, /disabled/)
})

test('a failing health probe fails the start instead of trusting the ready line', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'oc2dsh-bun-'))
  const bun = join(temp, 'bun')
  await writeFile(bun, '')
  try {
    const { supervisor } = makeSupervisor({
      bunPath: bun,
      health: async () => {
        throw new Error('connection refused')
      },
    })
    assert.equal(await supervisor.start(), null)
    assert.equal(supervisor.status().active, false)
    assert.match(supervisor.status().lastError, /connection refused/)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('a crash clears the base URL and restarts the relay', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'oc2dsh-bun-'))
  const bun = join(temp, 'bun')
  await writeFile(bun, '')
  try {
    const { supervisor, children } = makeSupervisor({ bunPath: bun })
    assert.match(String(await supervisor.start()), /^http:\/\/127\.0\.0\.1:45678\/_\/[0-9a-f]{48}$/)
    children[0]!.emit('exit', 1, null)
    assert.equal(supervisor.baseUrl, null, 'a dead relay is not offered to the adapter')
    assert.equal(supervisor.status().restarts, 1)
    await supervisor.stop()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('a relay that stays up gives the restart budget back', async () => {
  // The budget bounds a crash LOOP, not a process lifetime: sustained uptime
  // gives it back, so a healthy relay never degrades into a direct/429 path.
  const temp = await mkdtemp(join(tmpdir(), 'oc2dsh-bun-'))
  const bun = join(temp, 'bun')
  await writeFile(bun, '')
  try {
    const { supervisor, children } = makeSupervisor({ bunPath: bun, healthyResetMs: 20 })
    await supervisor.start()
    children[0]!.emit('exit', 1, null)
    assert.equal(supervisor.status().restarts, 1)
    // backoff after the first strike is 500 ms, then the child reports ready
    await new Promise((resolve) => setTimeout(resolve, 650))
    assert.equal(children.length, 2, 'the restarted child is up')
    assert.equal(supervisor.status().baseUrl, 'http://127.0.0.1:45678')
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(supervisor.status().restarts, 0, 'sustained uptime returns the budget')
    await supervisor.stop()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('a relay that dies before the window keeps its strike', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'oc2dsh-bun-'))
  const bun = join(temp, 'bun')
  await writeFile(bun, '')
  try {
    // A window far longer than the test: the counter must NOT decay, which is
    // what keeps a genuine crash loop from running forever.
    const { supervisor, children } = makeSupervisor({ bunPath: bun, healthyResetMs: 60_000 })
    await supervisor.start()
    children[0]!.emit('exit', 1, null)
    await new Promise((resolve) => setTimeout(resolve, 650))
    assert.equal(children.length, 2)
    assert.equal(supervisor.status().restarts, 1, 'a short-lived child does not clear its record')
    await supervisor.stop()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('each spawn gets a fresh token and an env without proxy variables', async () => {
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, http_proxy: process.env.http_proxy, NO_PROXY: process.env.NO_PROXY }
  process.env.HTTPS_PROXY = 'http://10.0.0.1:3128'
  process.env.http_proxy = 'http://10.0.0.1:3128'
  process.env.NO_PROXY = 'localhost'
  try {
    await withFakeBun(async (bun) => {
      const { supervisor, calls, children } = makeSupervisor({ bunPath: bun })
      await supervisor.start()
      const env = calls[0]!.env
      for (const name of ['HTTPS_PROXY', 'http_proxy', 'NO_PROXY']) assert.equal(env[name], undefined, `${name} must not reach the relay`)
      assert.equal(env.PATH, process.env.PATH, 'PATH is kept so bun can run')
      assert.equal(env.OC2DSH_RELAY_HOST, '127.0.0.1')
      children[0]!.emit('exit', 1, null)
      await new Promise((resolve) => setTimeout(resolve, 650))
      assert.equal(calls.length, 2)
      assert.notEqual(tokenOf(calls[1]!), tokenOf(calls[0]!), 'a restart mints a new token')
      await supervisor.stop()
    })
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('a ready line split across chunks still starts the relay', async () => {
  await withFakeBun(async (bun) => {
    const { supervisor } = makeSupervisor({
      bunPath: bun,
      onSpawn: (child) => {
        setTimeout(() => child.stdout.write('RELAY READY 45678\nOC2DSH_RE'), 1)
        setTimeout(() => child.stdout.write('LAY_READY 456'), 5)
        setTimeout(() => child.stdout.write('78\n'), 10)
      },
    })
    assert.match(String(await supervisor.start()), /^http:\/\/127\.0\.0\.1:45678\/_\//)
    await supervisor.stop()
  })
})

test('warm() after stop() never spawns an orphan relay', async () => {
  await withFakeBun(async (bun) => {
    const { supervisor, calls } = makeSupervisor({ bunPath: bun })
    await supervisor.stop()
    supervisor.warm()
    assert.equal(await supervisor.start(), null)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls.length, 0)
  })
})

test('stop() during startup kills the child and start resolves null', async () => {
  await withFakeBun(async (bun) => {
    const { supervisor, children } = makeSupervisor({
      bunPath: bun,
      onSpawn: (child) => { setTimeout(() => child.emitReady(45678), 20) },
    })
    const pending = supervisor.start()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await supervisor.stop()
    assert.equal(await pending, null)
    assert.equal(supervisor.baseUrl, null)
    assert.equal(children[0]!.killed, true)
  })
})

test('stop() while the health probe runs leaves no live relay behind', async () => {
  await withFakeBun(async (bun) => {
    let release: () => void = () => {}
    const { supervisor, children } = makeSupervisor({
      bunPath: bun,
      health: () => new Promise((resolve) => { release = () => resolve({ ok: true }) }),
    })
    const pending = supervisor.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const stopping = supervisor.stop()
    release()
    await stopping
    assert.equal(await pending, null)
    assert.equal(supervisor.baseUrl, null)
    assert.equal(children[0]!.killed, true)
  })
})

test('a child that dies before ready is a strike, and warm() backs off', async () => {
  await withFakeBun(async (bun) => {
    const { supervisor, calls } = makeSupervisor({
      bunPath: bun,
      onSpawn: (child) => { setTimeout(() => child.emit('exit', 1, null), 1) },
    })
    assert.equal(await supervisor.start(), null)
    assert.match(supervisor.status().lastError, /exited during startup/)
    assert.equal(supervisor.status().restarts, 1, 'startup failures spend the restart budget')
    for (let i = 0; i < 5; i += 1) supervisor.warm()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls.length, 1, 'warm() inside the backoff window does not respawn')
    await new Promise((resolve) => setTimeout(resolve, 520))
    supervisor.warm()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls.length, 2, 'after the backoff a warm() tries again')
    await supervisor.stop()
  })
})

test('findBun honours an explicit path and refuses a missing one', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'oc2dsh-bun-'))
  const bun = join(temp, 'bun')
  await writeFile(bun, '')
  try {
    assert.equal(findBun(bun), bun)
    assert.equal(findBun(join(temp, 'nope')), null)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('defaultRelayScript resolves the package relay, not a missing file', () => {
  const script = defaultRelayScript()
  assert.notEqual(script, '', 'the shipped relay must be resolvable from src/ and lib/')
  assert.match(script, /oc2dsh-relay\.mjs$/)
})

test('egress seams are inert without a pool and complete with one', () => {
  setRelayEgressSeams(null)
  assert.equal(hasRelayEgress(), false)
  assert.equal(pickRelayEgress({ model: 'm', session: 's' }), null, 'no pool = direct egress')

  const settled: Array<{ exitId: string; status?: number }> = []
  setRelayEgressSeams({
    pick: () => ({ url: 'socks5://127.0.0.1:30033', exitId: '127.0.0.1:30033', model: 'm', session: 's' }),
    settle: (pick, outcome) => settled.push({ exitId: pick.exitId, ...(outcome.status !== undefined ? { status: outcome.status } : {}) }),
  })
  try {
    assert.equal(hasRelayEgress(), true)
    const pick = pickRelayEgress({ model: 'm', session: 's' })
    assert.equal(pick !== null && 'exitId' in pick ? pick.exitId : null, '127.0.0.1:30033')
    settleRelayEgress(pick !== null && 'exitId' in pick ? pick : null, { status: 429 })
    settleRelayEgress(null, { status: 200 })
    assert.deepEqual(settled, [{ exitId: '127.0.0.1:30033', status: 429 }], 'a null pick settles nothing')
  } finally {
    setRelayEgressSeams(null)
  }
})

test('statusOfFailure reads the status pi-ai folds into an error message', () => {
  assert.equal(statusOfFailure('429 status code (no body)'), 429)
  assert.equal(statusOfFailure('429 FreeUsageLimitError: quota'), 429)
  assert.equal(statusOfFailure('403 FreeTierError: free tier can only be used from within OpenCode'), 403)
  assert.equal(statusOfFailure('fetch failed'), undefined)
  assert.equal(statusOfFailure('stream ended without finish_reason'), undefined)
})

test('isRelayTransportFailure tells the relay envelope from an upstream answer', () => {
  assert.equal(isRelayTransportFailure('502: {"type":"relay_error","message":"ECONNREFUSED: Unable to connect. Is the computer able to access the url?"}'), true)
  assert.equal(isRelayTransportFailure('502: Bad Gateway'), false)
  assert.equal(isRelayTransportFailure('429 FreeUsageLimitError: quota'), false)
})

test('the egress header keeps the spelling the relay strips', () => {
  assert.equal(EGRESS_HEADER, 'x-oc2dsh-egress')
})

test('directEgressDirective spells the three family directives the relay parses', () => {
  assert.equal(directEgressDirective(4), 'direct;family=4')
  assert.equal(directEgressDirective(6), 'direct;family=6')
  assert.equal(directEgressDirective('prefer6'), 'direct;family=prefer6')
})
