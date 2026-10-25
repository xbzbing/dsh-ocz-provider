import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_RELAY_UPSTREAM, RelaySupervisor, defaultRelayScript, findBun } from '../src/relay/supervisor.ts'
import { EGRESS_HEADER, hasRelayEgress, pickRelayEgress, setRelayEgressSeams, settleRelayEgress, statusOfFailure } from '../src/relay/egress.ts'

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
} = {}) {
  const children: FakeChild[] = []
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  const warnings: string[] = []
  const supervisor = new RelaySupervisor({
    config: { ...(options.bunPath !== undefined ? { bunPath: options.bunPath } : {}), ...(options.port !== undefined ? { port: options.port } : {}) },
    scriptPath: '/fake/oc2dsh-relay.mjs',
    spawnImpl: ((command: string, args: string[], spawnOptions: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, env: spawnOptions.env })
      const child = new FakeChild()
      children.push(child)
      // The real relay reports its port one tick after spawn.
      setTimeout(() => child.emitReady(options.reportedPort ?? 45678), 1)
      return child as unknown as never
    }) as never,
    healthFetch: async () => (options.health ?? (async () => ({ ok: true })))(),
    readyTimeoutMs: 2_000,
    logger: { info: () => {}, warn: (message: string) => warnings.push(message) },
    ...(options.maxRestarts !== undefined ? { maxRestarts: options.maxRestarts } : {}),
    ...(options.healthyResetMs !== undefined ? { healthyResetMs: options.healthyResetMs } : {}),
  })
  return { supervisor, children, calls, warnings }
}

test('the relay starts, reports its port, and exposes a loopback base URL', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'oc2dsh-bun-'))
  const bun = join(temp, 'bun')
  await writeFile(bun, '')
  try {
    const { supervisor, calls } = makeSupervisor({ bunPath: bun, port: 0 })
    const baseUrl = await supervisor.start()
    assert.equal(baseUrl, 'http://127.0.0.1:45678')
    assert.equal(supervisor.baseUrl, baseUrl)
    assert.equal(supervisor.status().active, true)
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
    const { supervisor } = makeSupervisor({ bunPath: bun })
    assert.equal(supervisor.baseUrlFor('https://opencode.ai/inference'), null, 'no relay yet')
    await supervisor.start()
    assert.equal(supervisor.baseUrlFor('https://opencode.ai/inference'), 'http://127.0.0.1:45678/inference')
    assert.equal(supervisor.baseUrlFor('https://opencode.ai/zen/'), 'http://127.0.0.1:45678/zen')
    assert.equal(supervisor.baseUrlFor('not a url'), 'http://127.0.0.1:45678')
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
    assert.equal(await supervisor.start(), 'http://127.0.0.1:45678')
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
    assert.equal(pick !== null && !('fail' in pick) ? pick.exitId : null, '127.0.0.1:30033')
    settleRelayEgress(pick !== null && !('fail' in pick) ? pick : null, { status: 429 })
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

test('the egress header keeps the spelling the relay strips', () => {
  assert.equal(EGRESS_HEADER, 'x-oc2dsh-egress')
})
