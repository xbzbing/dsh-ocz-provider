import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import { TransportVerdicts } from '../src/pool/transport.ts'
import type { ProxyProtocol } from '../src/pool/protocol.ts'

let clock = 1_000_000
const now = () => clock

function node(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: 'h:1',
    protocol: 'http',
    source: 'subscription',
    pinned: false,
    exitIP: '1.1.1.1',
    exitLocation: 'US city',
    latencyMs: 300,
    quality: 'S',
    addedAt: clock,
    ...overrides,
  }
}

interface Harness {
  pool: ExitPool
  verdicts: TransportVerdicts
  warnings: string[]
  probes: string[]
  /** Settle the in-flight diagnosis (it is a promise chain off #diagnose). */
  settle: () => Promise<void>
}

function harness(options: {
  answer?: (address: string) => Promise<ProxyProtocol | null>
} = {}): Harness {
  const pool = new ExitPool({ now })
  const warnings: string[] = []
  const probes: string[] = []
  const verdicts = new TransportVerdicts({
    pool,
    detect: async (address) => {
      probes.push(address)
      return options.answer === undefined ? 'socks5' : options.answer(address)
    },
    logger: { warn: (message) => { warnings.push(message) } },
    now,
  })
  return {
    pool,
    verdicts,
    warnings,
    probes,
    settle: async () => { await new Promise((resolve) => setImmediate(resolve)) },
  }
}

test('a cut on a MEASURED row is a strike: the label was proven by real traffic', async () => {
  // A subscription row whose protocol came from a real request has nothing to
  // ask: the cut IS the verdict.
  const h = harness()
  h.pool.add(node({ id: '127.0.0.1:30033', source: 'subscription', protocol: 'socks5', exitIP: '9.9.9.9' }))
  h.pool.markOk('127.0.0.1:30033')

  assert.equal(h.verdicts.cut('127.0.0.1:30033'), 'struck')
  assert.equal(h.pool.list()[0]!.health.state, 'dead')
  assert.deepEqual(h.probes, [], 'nothing to ask: the row was measured')
  assert.equal(h.pool.passiveStats('127.0.0.1:30033').transport, 1)
})

test('a mislabelled listener is relabelled and revived instead of buried', async () => {
  // The scenario: a manual row labelled `http` in front of a SOCKS5 listener —
  // every request dies while the same port answers 200 through socks5://.
  const h = harness({ answer: async () => 'socks5' })
  h.pool.add(node({ id: '127.0.0.1:30035', source: 'manual', protocol: 'http', pinned: true, exitIP: '' }))
  h.pool.markOk('127.0.0.1:30035')
  // The row already carries a strike: the correction must lift it.
  h.pool.markDeadStrike('127.0.0.1:30035')

  assert.equal(h.verdicts.cut('127.0.0.1:30035'), 'deferred')
  await h.settle()

  assert.equal(h.pool.get('127.0.0.1:30035')?.protocol, 'socks5', 'the row matches the listener')
  assert.equal(h.pool.list()[0]!.health.state, 'unknown', 'revived, but not claiming to be verified')
  assert.equal(h.pool.list()[0]!.health.deadStrikes, 0, 'the outage is over, not paused')
  assert.match(h.warnings.join('\n'), /标的是 http，实测是 socks5（已纠正并复活/)
})

test('a listener that answers nothing is still struck dead on the first cut', async () => {
  // The grace is for rows whose LABEL may be wrong, not for rows that are gone.
  const h = harness({ answer: async () => null })
  h.pool.add(node({ id: '127.0.0.1:30999', source: 'manual', exitIP: '' }))
  h.pool.markOk('127.0.0.1:30999')

  assert.equal(h.verdicts.cut('127.0.0.1:30999'), 'deferred')
  await h.settle()

  assert.equal(h.pool.list()[0]!.health.state, 'dead')
  assert.match(h.warnings.join('\n'), /连不上（端口没有监听/)
})

test('the right label and a live listener absolves the row once, not forever', async () => {
  // Answers, label correct: not this row's fault. It stays pickable (a
  // transient cut must not empty a healthy pool) but drops to 'unknown', and
  // the NEXT cut is a strike — no timer involved.
  const h = harness({ answer: async () => 'http' })
  h.pool.add(node({ id: '127.0.0.1:30035', source: 'manual', protocol: 'http', exitIP: '' }))
  h.pool.markOk('127.0.0.1:30035')

  assert.equal(h.verdicts.cut('127.0.0.1:30035'), 'deferred')
  await h.settle()
  assert.equal(h.pool.list()[0]!.health.state, 'unknown', 'kept, demoted out of the verified tier')
  assert.equal(h.pool.isUsable('127.0.0.1:30035', 'm'), true, 'still routable')
  assert.match(h.warnings.join('\n'), /再失败一次就判/)

  // Hours later, with nothing having succeeded through the row in between:
  // still a strike. A time window used to pardon this again on every cut, which
  // is how a listener that answers while its tunnel is gone stayed pickable
  // (measured live: 8 cuts, 0 successes, pinned row still in service).
  clock += 6 * 60 * 60 * 1000
  assert.equal(h.verdicts.cut('127.0.0.1:30035'), 'struck', 'one free diagnosis per outage')
  assert.equal(h.pool.list()[0]!.health.state, 'dead')
  assert.deepEqual(h.probes, ['127.0.0.1:30035'], 'and no second probe was spent')
})

test('a second cut with no success in between strikes without asking again', async () => {
  const h = harness({ answer: async () => 'socks5' })
  h.pool.add(node({ id: '127.0.0.1:30035', source: 'manual', protocol: 'socks5', exitIP: '' }))
  h.pool.markOk('127.0.0.1:30035')

  h.verdicts.cut('127.0.0.1:30035')
  await h.settle()
  assert.equal(h.verdicts.cut('127.0.0.1:30035'), 'struck')
  assert.deepEqual(h.probes, ['127.0.0.1:30035'], 'coalesced per row')
  assert.equal(h.pool.list()[0]!.health.state, 'dead')
})

test('a concurrent cut is deferred behind the diagnosis already in flight', async () => {
  // The adapter's rotate loop can report several transport failures for the
  // same row within a second; each one must not buy its own probe.
  let release: (value: ProxyProtocol | null) => void = () => {}
  const h = harness({ answer: async () => new Promise((resolve) => { release = resolve }) })
  h.pool.add(node({ id: '127.0.0.1:30035', source: 'manual', protocol: 'socks5', exitIP: '' }))
  h.pool.markOk('127.0.0.1:30035')

  assert.equal(h.verdicts.cut('127.0.0.1:30035'), 'deferred')
  assert.deepEqual(h.verdicts.pending, ['127.0.0.1:30035'])
  assert.equal(h.verdicts.cut('127.0.0.1:30035'), 'deferred', 'still asking')
  assert.equal(h.pool.list()[0]!.health.state, 'ok', 'nothing is decided while the question is open')
  release('socks5')
  await h.settle()
  assert.deepEqual(h.verdicts.pending, [])
  assert.deepEqual(h.probes, ['127.0.0.1:30035'])
})

test('a prober that cannot answer leaves the row exactly as it was', async () => {
  const h = harness({ answer: async () => { throw new Error('EAI_AGAIN') } })
  h.pool.add(node({ id: '127.0.0.1:30035', source: 'manual', exitIP: '' }))
  h.pool.markOk('127.0.0.1:30035')

  assert.equal(h.verdicts.cut('127.0.0.1:30035'), 'deferred')
  await h.settle()
  assert.equal(h.pool.list()[0]!.health.state, 'ok')
  assert.equal(h.pool.get('127.0.0.1:30035')?.protocol, 'http')
  assert.deepEqual(h.warnings, [])
  // Silence is not a pardon: the grace is spent, so the next cut strikes.
  assert.equal(h.verdicts.cut('127.0.0.1:30035'), 'struck')
})

test('a row that leaves the table mid-diagnosis is not resurrected', async () => {
  const h = harness({ answer: async () => 'socks5' })
  h.pool.add(node({ id: '127.0.0.1:30035', source: 'manual', exitIP: '' }))
  h.pool.markOk('127.0.0.1:30035')

  h.verdicts.cut('127.0.0.1:30035')
  h.pool.remove('127.0.0.1:30035')
  await h.settle()
  assert.equal(h.pool.has('127.0.0.1:30035'), false)
})

test('a cut for an unknown row is ignored', () => {
  const h = harness()
  assert.equal(h.verdicts.cut('gone:1'), 'ignored')
})

test('every cut is counted, whatever the verdict', async () => {
  // `passive.transport` is diagnostics: the counters must say how often a row
  // dropped a request even when the drop was a mislabel rather than a corpse.
  const h = harness({ answer: async () => 'http' })
  h.pool.add(node({ id: '127.0.0.1:30035', source: 'manual', exitIP: '' }))
  h.pool.markOk('127.0.0.1:30035')
  h.verdicts.cut('127.0.0.1:30035')
  await h.settle()
  assert.equal(h.pool.passiveStats('127.0.0.1:30035').transport, 1)
})

test('a success re-arms the free diagnosis (the outage is over)', async () => {
  // The pardon is keyed on PROOF, not on time: once a real 2xx lands on the
  // row, the next isolated cut is again forgiven — that is what keeps a busy
  // row from dying on two unrelated hiccups a day apart.
  const h = harness({ answer: async () => 'http' })
  h.pool.add(node({ id: '127.0.0.1:30035', source: 'manual', protocol: 'http', exitIP: '' }))
  h.pool.markOk('127.0.0.1:30035')

  h.verdicts.cut('127.0.0.1:30035')
  await h.settle()
  assert.equal(h.verdicts.cut('127.0.0.1:30035'), 'struck', 'the pardoned outage is spent')

  h.pool.markOk('127.0.0.1:30035') // a real request got through
  clock += 60 * 60 * 1000
  assert.equal(h.verdicts.cut('127.0.0.1:30035'), 'deferred', 'a fresh outage gets its own diagnosis')
  await h.settle()
  assert.equal(h.pool.isUsable('127.0.0.1:30035', 'm'), true)
})
