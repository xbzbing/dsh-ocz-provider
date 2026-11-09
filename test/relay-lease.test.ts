import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RelaySupervisor } from '../src/relay/supervisor.ts'
import {
  childRecordPath,
  clearChildRecord,
  resetSweepGuard,
  sweepChildRecord,
  sweepChildRecordOnce,
  writeChildRecord,
} from '../src/child-record.ts'

/**
 * A plugin reload disposes the fiber that owns the relay. These tests pin the
 * handoff contract: a reload adopts the same child (connections survive), an
 * uninstall lets the lease end it, and a lease that cannot be trusted is
 * refused instead of carrying a stale child into service.
 */

/** A fake relay child: the ready line on demand, `kill` observable. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  pid = 5151
  killed = false
  /** A live ChildProcess reports null for both, and the adopter checks them. */
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  unref(): void {}
  emitReady(port: number): void {
    this.stdout.write(`OC2DSH_RELAY_READY ${port}\n`)
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true
    this.signalCode = signal
    this.emit('exit', null, signal)
    return true
  }
}

function makeSupervisor(options: {
  bunPath: string
  port?: number
  reportedPort?: number
  health?: () => Promise<unknown>
  upstream?: string
  scriptPath?: string
  onSpawn?: (child: FakeChild) => void
} = { bunPath: '/tmp/oc2dsh-bun' }) {
  const children: FakeChild[] = []
  const probes: string[] = []
  const supervisor = new RelaySupervisor({
    config: {
      bunPath: options.bunPath,
      ...(options.upstream === undefined ? {} : { upstream: options.upstream }),
      ...(options.port === undefined ? {} : { port: options.port }),
    },
    scriptPath: options.scriptPath ?? '/fake/oc2dsh-relay.mjs',
    spawnImpl: ((_command: string, _args: string[]) => {
      const child = new FakeChild()
      children.push(child)
      if (options.onSpawn !== undefined) options.onSpawn(child)
      else setTimeout(() => child.emitReady(options.reportedPort ?? 45678), 1)
      return child as unknown as never
    }) as never,
    healthFetch: async (url: string) => {
      probes.push(url)
      return (options.health ?? (async () => ({ ok: true })))()
    },
    readyTimeoutMs: 2_000,
    logger: { info: () => {}, warn: () => {} },
  })
  return { supervisor, children, probes }
}

/** A throwaway file findBun() accepts as an explicit bun path. */
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

test('a reload adopts the same child instead of spawning a new one', async () => {
  await withFakeBun(async (bun) => {
    const first = makeSupervisor({ bunPath: bun, reportedPort: 46001 })
    const url = await first.supervisor.start()
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:46001\/_\/[0-9a-f]{48}$/)
    first.supervisor.handOff()

    // Adoption must not need bun: the child is already running.
    const second = makeSupervisor({ bunPath: join(tmpdir(), 'definitely-not-bun'), reportedPort: 46002 })
    const adopted = await second.supervisor.start()
    assert.equal(adopted, url, 'the same base URL survives the reload')
    assert.equal(second.children.length, 0, 'nothing was spawned')
    assert.equal(first.children[0]!.killed, false, 'the child is still running')
    assert.equal(second.probes.length, 1, 'the adopter health-checks the child first')
    await second.supervisor.stop()
  })
})

test('a lease is refused when the child runs another script or upstream', async () => {
  await withFakeBun(async (bun) => {
    const first = makeSupervisor({ bunPath: bun, reportedPort: 46011 })
    await first.supervisor.start()
    first.supervisor.handOff()

    const second = makeSupervisor({ bunPath: bun, upstream: 'https://other.example', reportedPort: 46012 })
    assert.match(String(await second.supervisor.start()), /:46012\//)
    assert.equal(first.children[0]!.killed, true, 'a child that is not ours is ended')
    assert.equal(second.children.length, 1, 'a fresh child serves the new upstream')
    await second.supervisor.stop()
  })
})

test('a lease whose listener stopped answering is ended, not adopted', async () => {
  await withFakeBun(async (bun) => {
    const first = makeSupervisor({ bunPath: bun, reportedPort: 46021 })
    await first.supervisor.start()
    first.supervisor.handOff()

    const second = makeSupervisor({
      bunPath: bun,
      reportedPort: 46022,
      health: async () => {
        throw new Error('connection refused')
      },
    })
    assert.equal(await second.supervisor.start(), null, 'a failed start stays a failed start')
    assert.equal(first.children[0]!.killed, true, 'the dead child is killed')
    assert.equal(second.children.length, 1, 'a replacement was spawned')
    await second.supervisor.stop()
  })
})

test('an unclaimed lease ends the child after its grace window', async () => {
  await withFakeBun(async (bun) => {
    const { supervisor, children } = makeSupervisor({ bunPath: bun })
    await supervisor.start()
    supervisor.handOff(10)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(children[0]!.killed, true, 'an uninstalled plugin leaves no relay behind')
  })
})

test('handOff during startup kills the child instead of leaving it behind', async () => {
  await withFakeBun(async (bun) => {
    let pending: FakeChild | null = null
    const { supervisor, children } = makeSupervisor({ bunPath: bun, onSpawn: (child) => { pending = child } })
    const starting = supervisor.start()
    // start() yields once before spawning (adoption is awaited first).
    await new Promise((resolve) => setImmediate(resolve))
    // No origin/token yet, so there is nothing a later generation could adopt.
    supervisor.handOff()
    assert.equal(children[0]!.killed, true, 'an unadoptable child is ended, not leaked')
    pending!.emitReady(46031)
    assert.equal(await starting, null)
  })
})

test('stop() after handOff is a no-op: the child belongs to the lease now', async () => {
  await withFakeBun(async (bun) => {
    const { supervisor, children } = makeSupervisor({ bunPath: bun })
    await supervisor.start()
    supervisor.handOff(10_000)
    await supervisor.stop()
    assert.equal(children[0]!.killed, false, 'stop() cannot kill a handed-off child')
    // Let the lease expire so the next test starts from an empty box.
    await new Promise((resolve) => setTimeout(resolve, 30))
    children[0]!.kill()
  })
})

test('a pid record is swept only while the pid still carries our marker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc2dsh-record-'))
  resetSweepGuard()
  try {
    // A real child stands in for a leftover: the sweep has to prove ownership
    // from its command line before signalling it.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    assert.ok(child.pid !== undefined)
    // Listen before the sweep: a fast exit would otherwise land before the
    // await is installed and the promise would never settle.
    const gone = new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(true)
      else child.once('exit', () => resolve(true))
    })
    const record = childRecordPath(dir, 'child')
    await writeChildRecord(record, {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      marker: 'not-this-process',
      binary: 'node',
    })
    assert.equal(await sweepChildRecord(record, { marker: 'not-this-process', graceMs: 500 }), false, 'the marker does not match the live command line')
    assert.equal(await readFile(record, 'utf8').then(() => true, () => false), false, 'the record is cleared')

    await writeChildRecord(record, {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      marker: 'setInterval',
      binary: 'node',
    })
    assert.equal(await sweepChildRecord(record, { marker: 'setInterval', graceMs: 500 }), true, 'a matching leftover is ended')
    assert.equal(await gone, true, 'the leftover is really gone')

    // The guard is per process and per path: the second call after a sweep is a no-op.
    assert.equal(await sweepChildRecordOnce(record, { marker: 'setInterval' }), false)
    assert.equal(await sweepChildRecordOnce(record, { marker: 'setInterval' }), false)
  } finally {
    resetSweepGuard()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a record for a pid that is gone is removed without a signal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc2dsh-record-'))
  try {
    const record = childRecordPath(dir, 'child')
    await writeChildRecord(record, {
      pid: 2 ** 22 + 7,
      startedAt: new Date().toISOString(),
      marker: 'anything',
      binary: 'node',
    })
    assert.equal(await sweepChildRecord(record, { marker: 'anything', graceMs: 100 }), false)
    await clearChildRecord(record)
    assert.equal(await readFile(record, 'utf8').then(() => true, () => false), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
