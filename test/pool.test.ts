import test from 'node:test'
import assert from 'node:assert/strict'

import { ABUSIVE_COOLDOWN_MS, ExitPool, gradeOf, type ExitNode } from '../src/pool/pool.ts'

let clock = 1_000_000
const now = () => clock

function pool(options: ConstructorParameters<typeof ExitPool>[0] = {}) {
  return new ExitPool({ now, ...options })
}

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

test('gradeOf follows the GoProxy thresholds', () => {
  assert.equal(gradeOf(100), 'S')
  assert.equal(gradeOf(500), 'S')
  assert.equal(gradeOf(501), 'A')
  assert.equal(gradeOf(1000), 'A')
  assert.equal(gradeOf(1001), 'B')
  assert.equal(gradeOf(2000), 'B')
  assert.equal(gradeOf(2001), 'C')
})

test('add rejects duplicate exit IPs across different addresses (one quota bucket)', () => {
  const p = pool()
  assert.ok(p.add(node({ id: 'a:1', exitIP: '9.9.9.9' })))
  assert.ok(!p.add(node({ id: 'b:2', exitIP: '9.9.9.9' })))
  // same address (re-admission) is fine
  assert.ok(p.add(node({ id: 'a:1', exitIP: '9.9.9.9' })))
  // pinned nodes may keep an empty exitIP (3.1 Clash/leased-line fallback)
  assert.ok(p.add(node({ id: 'c:3', exitIP: '', source: 'manual' })))
})

test('429 cooldown is exit-level with exponential backoff (rule table 4.2)', () => {
  const p = pool({ limitedCooldownBaseMs: 60_000, limitedCooldownMaxMs: 30 * 60_000 })
  p.add(node({ id: 'a:1' }))
  p.markOk('a:1')

  const first = p.markLimited('a:1')
  assert.equal(first, now() + 60_000)
  assert.ok(!p.isUsable('a:1', 'm'))
  // another exit keeps serving — the 429 never affects peers
  p.add(node({ id: 'b:2', exitIP: '2.2.2.2' }))
  p.markOk('b:2')
  assert.ok(p.isUsable('b:2', 'm'))

  const second = p.markLimited('a:1')
  assert.equal(second, now() + 120_000)

  // cooldown elapses -> usable again; success resets the backoff ladder
  clock += 121_000
  assert.ok(p.isUsable('a:1', 'm'))
  p.markOk('a:1')
  assert.equal(p.markLimited('a:1'), now() + 60_000)
})

test('401/403 is model-level: suspect -> banned, never cools the exit (rule table 4.2)', () => {
  const p = pool({ modelBanConfirmations: 2 })
  p.add(node({ id: 'a:1' }))
  p.markOk('a:1')

  assert.equal(p.markModelSignal('a:1', 'muse'), 'suspect')
  // suspect does NOT remove the exit from rotation (could be transient)
  assert.ok(p.isUsable('a:1', 'muse'))
  assert.equal(p.markModelSignal('a:1', 'muse'), 'banned')
  assert.ok(!p.isUsable('a:1', 'muse'))
  // the same exit still serves every other model
  assert.ok(p.isUsable('a:1', 'big-pickle'))

  // success clears the ban
  p.markOk('a:1', 'muse')
  assert.ok(p.isUsable('a:1', 'muse'))
})

test('dead strikes disable an exit but never evict it', () => {
  const p = pool()
  p.add(node({ id: 'sub:1' }))
  p.add(node({ id: 'manual:1', source: 'manual', exitIP: '3.3.3.3' }))
  for (let i = 0; i < 3; i++) {
    p.markDeadStrike('sub:1')
    p.markDeadStrike('manual:1')
  }
  assert.ok(p.has('sub:1') && p.has('manual:1'))
  assert.ok(!p.isUsable('sub:1', 'm'))
  assert.ok(!p.isUsable('manual:1', 'm'))
})

test('pick: pinned wins while usable; rotation otherwise (3.3/3.6)', () => {
  const p = pool()
  p.add(node({ id: 'pinned:1', source: 'manual', exitIP: '5.5.5.5', latencyMs: 900 }))
  p.add(node({ id: 'rot:1', exitIP: '6.6.6.6', latencyMs: 100 }))
  p.add(node({ id: 'rot:2', exitIP: '7.7.7.7', latencyMs: 200 }))
  p.markOk('pinned:1')
  p.markOk('rot:1')
  p.markOk('rot:2')

  assert.ok(p.pin('pinned:1'))
  assert.equal(p.pick('ses-a', 'm'), 'pinned:1')

  // pinned 429 -> falls to rotation while it cools
  p.markLimited('pinned:1')
  const rotated = p.pick('ses-a', 'm')
  assert.ok(rotated === 'rot:1' || rotated === 'rot:2')

  // cooldown expires -> pinned returns
  clock += 61_000
  assert.equal(p.pick('ses-a', 'm'), 'pinned:1')
})

test('pick: pinned banned for one model routes only that model away (3.6)', () => {
  const p = pool({ modelBanConfirmations: 2 })
  p.add(node({ id: 'pinned:1', source: 'manual', exitIP: '5.5.5.5' }))
  p.add(node({ id: 'rot:1', exitIP: '6.6.6.6' }))
  p.markOk('pinned:1')
  p.markOk('rot:1')
  p.pin('pinned:1')

  p.markModelSignal('pinned:1', 'muse')
  p.markModelSignal('pinned:1', 'muse')
  assert.equal(p.pick('ses-a', 'muse'), 'rot:1')
  assert.equal(p.pick('ses-a', 'big-pickle'), 'pinned:1')
})

test('pick: session stickiness keeps one conversation on one exit (3.3)', () => {
  const p = pool()
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 100 }))
  p.add(node({ id: 'b:2', exitIP: '2.2.2.2', latencyMs: 120 }))
  p.markOk('a:1')
  p.markOk('b:2')

  const first = p.pick('ses-1', 'm')
  const second = p.pick('ses-1', 'm')
  assert.ok(first !== null)
  assert.equal(first, second)
  // a different session may land elsewhere
  assert.ok(typeof p.pick('ses-2', 'm') === 'string')

  // stickiness breaks when the sticky exit cools
  p.markLimited(first)
  assert.notEqual(p.pick('ses-1', 'm'), first)
})

test('pick: null when everything is unusable (direct fallback decision, 3.3)', () => {
  const p = pool()
  p.add(node({ id: 'a:1' }))
  p.markDead('a:1')
  assert.equal(p.pick('ses', 'm'), null)
})

test('snapshot reports per-source counts and pinned (diagnostics, 5.3)', () => {
  const p = pool()
  p.add(node({ id: 'b:2', source: 'manual', exitIP: '2.2.2.2' }))
  p.add(node({ id: 'c:3', source: 'subscription', exitIP: '3.3.3.3' }))
  p.add(node({ id: 'd:4', source: 'goproxy', exitIP: '4.4.4.4' }))
  p.pin('b:2')
  const snap = p.snapshot()
  assert.equal(snap.total, 3)
  assert.deepEqual(snap.bySource, { manual: 1, subscription: 1, goproxy: 1 })
  assert.equal(snap.pinned, 'b:2')
})

test('unpinning/removing the pinned node clears the pointer', () => {
  const p = pool()
  p.add(node({ id: 'a:1', source: 'manual', exitIP: '2.2.2.2' }))
  p.pin('a:1')
  p.remove('a:1')
  assert.equal(p.pinnedId, '')
  assert.equal(p.pick('ses', 'm'), null)
})

// -- passive signals (docs §4.2 rule table, §4.3) --------------------

test('recordPassive classifies by the rule table and writes two-tier health', () => {
  const p = pool()
  p.add(node({ id: 'e:1', exitIP: '9.9.9.9' }))
  // 2xx -> ok + model ok + counter
  assert.equal(p.recordPassive('e:1', 200, 'big-pickle'), 'ok')
  assert.equal(p.isUsable('e:1', 'big-pickle'), true)
  assert.deepEqual(p.passiveStats('e:1'), { ok: 1, limited: 0, refused: 0, dead: 0, transport: 0 })
  // 429 -> exit-level cooldown (the whole exit cools, 4.2: quota is per IP)
  assert.equal(p.recordPassive('e:1', 429, 'big-pickle'), 'limited')
  assert.equal(p.isUsable('e:1', 'other-model'), false)
  assert.equal(p.passiveStats('e:1').limited, 1)
  // cooldown cleared -> usable again
  p.markOk('e:1')
  // 401/403 twice -> model banned, exit still serves other models
  assert.equal(p.recordPassive('e:1', 403, 'muse'), 'refused')
  assert.equal(p.recordPassive('e:1', 403, 'muse'), 'refused')
  assert.equal(p.isUsable('e:1', 'muse'), false)
  assert.equal(p.isUsable('e:1', 'other'), true)
  assert.equal(p.passiveStats('e:1').refused, 2)
  // 5xx -> counted dead for diagnostics but the exit stays usable: the 500
  // is often the MODEL failing behind a healthy exit; striking the exit
  // dead would empty the pool and silently fall ALL traffic back to direct
  assert.equal(p.recordPassive('e:1', 503, 'big-pickle'), 'dead')
  assert.equal(p.isUsable('e:1', 'other'), true)
  assert.equal(p.passiveStats('e:1').dead, 1)
})

test('recordPassive transport failures strike the exit dead and keep the row', () => {
  const p = pool()
  p.add(node({ id: 'e:1', exitIP: '9.9.9.9' }))
  p.recordPassiveTransport('e:1')
  p.recordPassiveTransport('e:1')
  assert.equal(p.has('e:1'), true)
  assert.equal(p.isDead('e:1'), true)
})

test('rerouteSession drops the sticky exit (degraded exit loses the session)', () => {
  const p = pool()
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  const first = p.pick('ses', 'm')
  assert.equal(first, 'a:1')
  p.recordPassive('a:1', 429, 'm')
  p.rerouteSession('ses')
  // the cooling exit is filtered and the sticky pointer is gone
  assert.notEqual(p.pick('ses', 'm'), 'a:1' === first ? first : first)
})

test('markStreamFailure counts passive buckets (mid-flight §3.4)', () => {
  const p = pool()
  p.add(node({ id: 'e:1', source: 'manual', exitIP: '9.9.9.9' }))
  p.markStreamFailure('e:1', '429')
  p.markStreamFailure('e:1', 'model', 'muse')
  assert.equal(p.passiveStats('e:1').limited, 1)
  assert.equal(p.passiveStats('e:1').refused, 1)
})

test('markDeadStrike stamps deadAt and markOk clears it (revival bookkeeping)', () => {
  const p = pool()
  p.add(node({ id: 'd:1', source: 'manual', exitIP: '7.7.7.7' }))
  p.markOk('d:1')
  assert.equal(p.list()[0]!.health.deadAt, 0)

  p.recordPassiveTransport('d:1')
  const dead = p.list()[0]!.health
  assert.equal(dead.state, 'dead')
  assert.equal(dead.deadAt, now(), 'death is stamped so the retry budget can be measured from it')

  p.markOk('d:1')
  const revived = p.list()[0]!.health
  assert.equal(revived.state, 'ok')
  assert.equal(revived.deadAt, 0)
  assert.equal(revived.deadStrikes, 0)
})

/**
 * Subscription exits whose probe failed are kept by admission.admitTrusted
 * (docs 4.5); marking them ok would park dead nodes in the verified tier at
 * grade S where they absorb real requests. markUnverified() is the correct
 * mark: node kept, claim dropped.
 */
test('markUnverified: keeps the node, drops the ok claim, and yields to verified exits', () => {
  const p = pool()
  p.add(node({ id: 'sub:1', source: 'subscription', exitIP: '', latencyMs: 0, quality: 'C' }))
  p.markOk('sub:1')
  assert.equal(p.list()[0]!.health.state, 'ok')

  p.markUnverified('sub:1')
  assert.equal(p.list()[0]!.health.state, 'unknown', 'the ok claim is gone')
  assert.ok(p.has('sub:1'), 'the paid line stays in the pool for the next probe')

  // Still usable when nothing better is left (a probe-side failure must not
  // empty a healthy pool), but never ranked above an exit that was verified.
  p.add(node({ id: 'sub:2', source: 'subscription', exitIP: '9.9.9.9', latencyMs: 400 }))
  p.markOk('sub:2')
  for (let i = 0; i < 16; i += 1) {
    assert.equal(p.pick(`ses-${i}`, 'm'), 'sub:2', 'verified exits are picked first')
  }
  p.markDead('sub:2')
  assert.equal(p.pick('ses-last', 'm'), 'sub:1', 'unverified is still a last resort')

  // A real transport failure still strikes it dead (it is not protected).
  p.recordPassiveTransport('sub:1')
  assert.equal(p.list().find((entry) => entry.id === 'sub:1')!.health.state, 'dead')
})

test('no periodic probe: a dead exit stays parked until a real-request or manual verdict', () => {
  // There is no due-probe loop (no periodic recheck, no deadRetryMs revival):
  // liveness is judged by real requests only, and the recovery paths are the
  // reserve swap (subscription) and the card's 探测 action. Asserted here: a dead row serves nothing, and a passing
  // manual probe revives it.
  const p = pool()
  p.add(node({ id: 'x:1', source: 'subscription', exitIP: '5.5.5.5' }))
  p.markOk('x:1')
  p.recordPassiveTransport('x:1')
  assert.equal(p.list()[0]!.health.state, 'dead')
  assert.equal(p.pick('ses-1', 'm'), null, 'the dead row serves nothing')
  clock += 5 * 60_000
  assert.equal(p.pick('ses-2', 'm'), null, 'and no timer brings it back')
  p.markOk('x:1') // the card's 探测 action, verdict pass
  assert.equal(p.pick('ses-3', 'm'), 'x:1', 'a passing manual probe revives it')
})

// -- admission watchers (the engage-routing seam) ------------------------------

test('onAdmitted: fires once per newly added node, never on an upsert', () => {
  const p = pool()
  let admitted = 0
  p.onAdmitted(() => { admitted += 1 })
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 999 }))
  assert.equal(admitted, 1, 'the probe refresh of a known exit is not an admission')
})

test('onAdmitted: a duplicate-exit-IP rejection admits nothing and notifies nobody', () => {
  const p = pool()
  const seen: string[] = []
  p.onAdmitted(() => { seen.push('admitted') })
  p.add(node({ id: 'a:1', exitIP: '9.9.9.9' }))
  assert.equal(p.add(node({ id: 'b:2', exitIP: '9.9.9.9' })), false)
  assert.equal(seen.length, 1)
})

test('onAdmitted: a throwing watcher never fails the admission', () => {
  const p = pool()
  p.onAdmitted(() => { throw new Error('watcher blew up') })
  assert.equal(p.add(node({ id: 'a:1' })), true)
  assert.ok(p.has('a:1'))
})

test('pin/unpin keep the row flag in step with the pinned slot', () => {
  const p = pool()
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  p.add(node({ id: 'b:2', exitIP: '2.2.2.2' }))
  p.pin('a:1')
  assert.equal(p.get('a:1')?.pinned, true)
  p.pin('b:2')
  assert.equal(p.get('a:1')?.pinned, false, 'only the current pin carries the flag')
  assert.equal(p.get('b:2')?.pinned, true)
  p.unpin()
  assert.ok(p.list().every((entry) => !entry.pinned))
})

// -- whole-pool capacity + tail demotion -------------

test('evictWorst drops the slowest unpinned exit and never the pinned one', () => {
  const p = pool({ poolSize: 2 })
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 100, quality: 'S' }))
  p.add(node({ id: 'b:2', exitIP: '2.2.2.2', latencyMs: 900, quality: 'A' }))
  p.pin('a:1')
  assert.equal(p.isFull(), true)
  // The pinned row is the best one here, but the guarantee is stronger: it is
  // never the eviction candidate even when it is the worst.
  assert.equal(p.evictWorst(), 'b:2', 'and it names the evicted exit')
  assert.ok(p.has('a:1'), 'the pinned exit survives')
  assert.ok(!p.has('b:2'), 'the slowest unpinned exit made room')

  const onlyPinned = pool({ poolSize: 1 })
  onlyPinned.add(node({ id: 'p:1', exitIP: '4.4.4.4' }))
  onlyPinned.pin('p:1')
  assert.equal(onlyPinned.evictWorst(), null, 'nothing is left to evict')
  assert.ok(onlyPinned.has('p:1'))
})

test('demoteToTail moves a refused exit to the end of the pool order', () => {
  const p = pool()
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  p.add(node({ id: 'b:2', exitIP: '2.2.2.2' }))
  p.add(node({ id: 'c:3', exitIP: '3.3.3.3' }))
  assert.deepEqual(p.list().map((entry) => entry.id), ['a:1', 'b:2', 'c:3'])

  assert.equal(p.demoteToTail('a:1'), true)
  assert.deepEqual(p.list().map((entry) => entry.id), ['b:2', 'c:3', 'a:1'], 'the pool order carries the demotion')
  assert.equal(p.demoted('a:1'), true)
  assert.equal(p.demoted('b:2'), false)
  assert.equal(p.demoteToTail('nope:1'), false)
})

test('a demoted exit is the last resort for pick(), and health clears the demotion', () => {
  const p = pool()
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 100 }))
  p.add(node({ id: 'b:2', exitIP: '2.2.2.2', latencyMs: 900 }))
  p.markOk('a:1')
  p.markOk('b:2')
  // Demote the FASTEST one: ranking by latency alone would still pick it.
  p.demoteToTail('a:1')
  for (let index = 0; index < 20; index += 1) {
    assert.equal(p.pick(`session-${index}`, 'm'), 'b:2', 'a demoted exit never outranks a live one')
  }

  p.markOk('a:1', 'm')
  assert.equal(p.demoted('a:1'), false, 'a verified probe clears the demotion')
  const picks = new Set(Array.from({ length: 40 }, (_, index) => p.pick(`s-${index}`, 'm')))
  assert.ok(picks.has('a:1'), 'and it competes again once healthy')
})

test('remove() forgets the demotion with the node', () => {
  const p = pool()
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  p.demoteToTail('a:1')
  p.remove('a:1')
  assert.equal(p.demoted('a:1'), false)
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  assert.equal(p.demoted('a:1'), false, 'a re-admitted exit starts at the head again')
})

// -- dead exits sink to the tail and ask the runtime to rotate ----

test('a dead exit moves to the end of the pool order, once per transition', () => {
  const p = pool()
  p.add(node({ id: 'a:1', source: 'subscription', exitIP: '1.1.1.1' }))
  p.add(node({ id: 'b:2', source: 'subscription', exitIP: '2.2.2.2' }))
  p.add(node({ id: 'c:3', source: 'subscription', exitIP: '3.3.3.3' }))
  p.markOk('a:1')
  p.markOk('b:2')
  p.markOk('c:3')
  assert.deepEqual(p.list().map((entry) => entry.id), ['a:1', 'b:2', 'c:3'])

  const deaths: string[] = []
  p.onDead((id) => deaths.push(id))

  p.markDeadStrike('a:1')
  assert.ok(p.has('a:1'), 'a struck row is never evicted')
  assert.deepEqual(p.list().map((entry) => entry.id), ['b:2', 'c:3', 'a:1'], 'the dead exit sinks to the tail')
  assert.deepEqual(deaths, ['a:1'], 'and the runtime is told to rotate')
  assert.equal(p.isDead('a:1'), true)

  // A second strike on the SAME exit must not re-insert it or fire again.
  p.markDeadStrike('a:1')
  p.markDeadStrike('a:1')
  assert.deepEqual(deaths, ['a:1'], 'one transition, one rotation request')
  assert.deepEqual(p.list().map((entry) => entry.id), ['b:2', 'c:3', 'a:1'])

  // markDead() (the disable-without-dropping path) reports the same way.
  p.markDead('b:2')
  assert.deepEqual(deaths, ['a:1', 'b:2'])
  assert.deepEqual(p.list().map((entry) => entry.id), ['c:3', 'a:1', 'b:2'])
})

test('a throwing dead watcher never fails the strike bookkeeping', () => {
  const p = pool()
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  p.onDead(() => { throw new Error('watcher blew up') })
  p.markDeadStrike('a:1')
  assert.equal(p.isDead('a:1'), true)
  assert.equal(p.list().length, 1)
})

test('a dead exit is not usable, whatever its position in the order', () => {
  const p = pool()
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 100 }))
  p.add(node({ id: 'b:2', exitIP: '2.2.2.2', latencyMs: 900 }))
  p.markOk('a:1')
  p.markOk('b:2')
  p.markDeadStrike('a:1')
  assert.equal(p.isUsable('a:1', 'm'), false)
  for (let index = 0; index < 10; index += 1) assert.equal(p.pick(`s-${index}`, 'm'), 'b:2')
})

test('pin: 固定本机 hands out no exit at all, and unpin restores rotation', () => {
  // The stats modal's 本机 row gets the same 固定
  // button as an exit row. "Fixed to this machine" can only mean pick()
  // returns null (the dispatcher's documented direct path) — falling through
  // to the rotation pool would silently ignore the click.
  const p = pool()
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 100 }))
  p.add(node({ id: 'b:2', exitIP: '2.2.2.2', latencyMs: 200 }))
  p.markOk('a:1')
  p.markOk('b:2')
  p.pin('a:1')
  assert.equal(p.pick('ses-a', 'm'), 'a:1')

  p.pinLocal()
  assert.equal(p.pinnedId, 'local', 'the sentinel is the local bucket id')
  assert.equal(p.pinnedLocal, true)
  for (const session of ['ses-a', 'ses-b', 'ses-c']) assert.equal(p.pick(session, 'm'), null)
  assert.equal(p.get('a:1')?.pinned, false, 'no row keeps the primary flag once the pin is 本机')

  p.unpin()
  assert.equal(p.pinnedLocal, false)
  assert.equal(p.pick('ses-d', 'm'), 'a:1', 'the fastest healthy exit is back in service')
})

test('pin: the 本机 sentinel survives a stale pinned-flag sweep, and remove() clears it', () => {
  const p = pool()
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1' }))
  p.markOk('a:1')
  p.pinLocal()
  // remove() clears a pin only when it names the row being dropped: the
  // sentinel is not a row, so dropping an exit must not turn 固定本机 off.
  p.remove('a:1')
  assert.equal(p.pinnedLocal, true)
  assert.equal(p.snapshot().pinned, 'local', 'the status view can report the local pin from snapshot()')
})

test('refresh: facts land on a live row, and a row that left the table is never resurrected', () => {
  // A probe holds an `entry` snapshot from before it ran; the exit can leave
  // the table meanwhile (dead rotation, refusal replacement, an operator's
  // 轮换). add() is an upsert, so writing that snapshot back would resurrect
  // the removed row — a capacity-exceeding, listenerless extra row. refresh()
  // must refuse it.
  const p = pool()
  p.add(node({ id: 'a:1', exitIP: '1.1.1.1', latencyMs: 900, quality: 'B' }))
  p.add(node({ id: 'b:2', exitIP: '2.2.2.2' }))

  assert.equal(p.refresh('a:1', { exitIP: '9.9.9.9', latencyMs: 120, quality: 'S' }), true)
  const row = p.get('a:1')!
  assert.equal(row.exitIP, '9.9.9.9')
  assert.equal(row.latencyMs, 120)
  assert.equal(row.quality, 'S')
  assert.deepEqual(p.list().map((entry) => entry.id), ['a:1', 'b:2'], 'the row keeps its position in the pool order')

  p.remove('a:1')
  assert.equal(p.refresh('a:1', { exitIP: '9.9.9.9' }), false, 'the removed row is not written back')
  assert.equal(p.has('a:1'), false)
  assert.equal(p.list().length, 1, 'the pool stays at its size')
})

test('refresh never rewrites identity, source or the pin flag', () => {
  const p = pool()
  p.add(node({ id: 'a:1', source: 'subscription', exitIP: '1.1.1.1' }))
  p.pin('a:1')
  // The seam is typed to the admission-measured fields, but a caller can still
  // hand over a whole ExitNode (probeOne does): identity fields must be ignored.
  p.refresh('a:1', { id: 'evil:1', source: 'manual', pinned: false, exitIP: '1.1.1.1', latencyMs: 50 } as never)
  const row = p.get('a:1')!
  assert.equal(row.id, 'a:1')
  assert.equal(row.source, 'subscription')
  assert.equal(row.pinned, true)
  assert.equal(row.latencyMs, 50, 'the measured field still lands')
})

/**
 * A retired sing-box port that keeps failing connects is struck dead, then
 * re-admitted as unverified by the trusted-admission fallback — and 'unknown'
 * is still USABLE, so it would be picked (and pinnable) again. Un-verifying
 * must never be a promotion.
 */
test('markUnverified never revives a dead exit', () => {
  const p = pool()
  p.add(node({ id: 'sing:30032', source: 'subscription', exitIP: '61.92.237.2', latencyMs: 0, quality: 'C' }))
  p.recordPassiveTransport('sing:30032')
  assert.equal(p.list()[0]!.health.state, 'dead', 'a connect failure strikes it dead')
  assert.equal(p.isUsable('sing:30032', 'm'), false)

  p.markUnverified('sing:30032')
  assert.equal(p.list()[0]!.health.state, 'dead', 'the corpse stays dead until a probe proves it alive')
  assert.equal(p.isUsable('sing:30032', 'm'), false, 'not pickable, and therefore not pinnable')

  // A probe that really answered is what re-arms it (markOk).
  p.markOk('sing:30032')
  assert.equal(p.list()[0]!.health.state, 'ok')
  assert.equal(p.isUsable('sing:30032', 'm'), true)
})

/**
 * OpenCode's IP-reputation refusal (…abusive traffic from this IP address…)
 * outlives any rotation, so the exit is benched for the long window and the
 * reason is recorded for the card.
 */
test('markAbusive benches the exit for the long window and records why', () => {
  const p = pool()
  p.add(node({ id: 'sub:jp', source: 'subscription', exitIP: '108.61.187.89' }))
  p.markOk('sub:jp')

  assert.equal(p.markAbusive('sub:jp'), clock + ABUSIVE_COOLDOWN_MS)
  const health = p.list()[0]!.health
  assert.equal(health.note, 'abusive')
  assert.equal(health.noteAt, clock)
  assert.equal(p.isUsable('sub:jp', 'm'), false, 'cooling counts, even though the state still reads ok')

  // A pin cannot walk back onto a benched exit: pick() returns null (direct).
  p.pin('sub:jp')
  assert.equal(p.pick('ses-1', 'm'), null)

  // Longer than any 429 backoff: still benched an hour later, free after three.
  clock += 60 * 60 * 1000
  assert.equal(p.isUsable('sub:jp', 'm'), false)
  clock += ABUSIVE_COOLDOWN_MS
  assert.equal(p.isUsable('sub:jp', 'm'), true, 'the window is a bench, not a ban')

  // A probe that passes against the real lane clears the verdict.
  p.markOk('sub:jp')
  assert.equal(p.list()[0]!.health.note, '', 'a verified exit is clean again')
  assert.equal(p.list()[0]!.health.noteAt, 0)
})

/**
 * The adapter blames the exit that answered through exitOfSession(session),
 * which is fed by the sticky binding pick() records. A pinned pick must record
 * that binding before returning: otherwise a refusal landing on a pinned exit
 * has no exit to blame and the row is never benched.
 */
test('pick records the sticky binding on the pin path too', () => {
  const p = pool()
  p.add(node({ id: 'sub:1', source: 'subscription', exitIP: '4.4.4.4' }))
  p.pin('sub:1')
  assert.equal(p.pick('ses-A', 'm'), 'sub:1')
  assert.equal(p.exitOfSession('ses-A'), 'sub:1', 'the verdict knows which exit answered')
  p.breakStickySession('ses-A')
  assert.equal(p.exitOfSession('ses-A'), null)
})

// -- revive / transport signal / pin skip -------------------------

/**
 * A dead mark is permanent until something proves the row alive, and the two
 * proofs (a real 2xx, the card's 探测) are both unavailable to a row that was
 * struck for a mislabelled protocol. `revive` is the missing third door: it
 * clears the sentence without claiming health.
 */
test('revive clears a dead strike but never claims the row is verified', () => {
  const p = pool()
  p.add(node({ id: 'manual:1', source: 'manual', exitIP: '' }))
  p.markOk('manual:1')
  p.recordPassiveTransport('manual:1')
  assert.equal(p.list()[0]!.health.state, 'dead')
  assert.equal(p.isUsable('manual:1', 'm'), false)

  assert.equal(p.revive('manual:1'), true)
  const health = p.list()[0]!.health
  assert.equal(health.state, 'unknown', 'usable again, but not in the verified tier')
  assert.equal(health.deadStrikes, 0, 'the strike counter restarts with the outage')
  assert.equal(health.deadAt, 0)
  assert.equal(p.isUsable('manual:1', 'm'), true)

  // A live row is untouched: revive is not a general health reset.
  p.markOk('manual:1')
  p.markLimited('manual:1')
  const cooldown = p.list()[0]!.health.cooldownUntil
  assert.equal(p.revive('manual:1'), true)
  assert.equal(p.list()[0]!.health.state, 'ok')
  assert.equal(p.list()[0]!.health.cooldownUntil, cooldown, 'a cooldown survives: it is not a strike')

  assert.equal(p.revive('gone:1'), false, 'a row that left the table cannot be revived')
})

test('recordTransportSignal counts a cut without judging the row', () => {
  // pool/transport.ts may still be asking what a cut means; the counter has to
  // be able to say "this row dropped a request" before the verdict lands.
  const p = pool()
  p.add(node({ id: 'manual:1', source: 'manual', exitIP: '' }))
  p.markOk('manual:1')
  p.recordTransportSignal('manual:1')
  assert.equal(p.list()[0]!.health.state, 'ok', 'no strike')
  assert.equal(p.passiveStats('manual:1').transport, 1)
  p.recordTransportSignal('gone:1')
  assert.deepEqual(p.passiveStats('gone:1'), { ok: 0, limited: 0, refused: 0, dead: 0, transport: 0 })
})

/**
 * A pin that is set but unusable falls through to the rotation (that is what
 * 主力+备胎 promises), and the fall-through must be loud: a session quietly
 * riding other exits reads as "the pin works". onPinnedSkip reports it from
 * the one place every routing seam passes through.
 */
test('pick reports a pin it had to skip, and never when the pin serves', () => {
  const p = pool()
  p.add(node({ id: 'pin:1', source: 'manual', exitIP: '' }))
  p.add(node({ id: 'other:1', source: 'manual', exitIP: '2.2.2.2' }))
  const skips: Array<[string, string]> = []
  p.onPinnedSkip((pinned, used) => { skips.push([pinned, used]) })

  p.pin('pin:1')
  assert.equal(p.pick('ses-1', 'm'), 'pin:1')
  assert.deepEqual(skips, [], 'the pin is serving: nothing to report')

  p.markDeadStrike('pin:1')
  assert.equal(p.pick('ses-2', 'm'), 'other:1')
  assert.deepEqual(skips, [['pin:1', 'other:1']], 'the fall-through is announced')

  p.revive('pin:1')
  assert.equal(p.pick('ses-3', 'm'), 'pin:1', 'a revived pin wins again')
  assert.equal(skips.length, 1, 'and the report is not repeated for the same outage')
})

test('pick reports a pin skipped in favour of the session\'s sticky exit', () => {
  // The sticky branch returns before the rotation sort, so it needs the same
  // report — otherwise the most common fall-through (a session that already
  // moved) would be the one case nobody hears about.
  const p = pool()
  p.add(node({ id: 'pin:1', source: 'manual', exitIP: '' }))
  p.add(node({ id: 'sticky:1', source: 'manual', exitIP: '3.3.3.3' }))
  p.pin('pin:1')
  p.breakStickySession('ses-1')
  p.markDeadStrike('pin:1')
  // Learn the sticky exit through a plain pick, then pin again.
  const first = p.pick('ses-1', 'm')
  assert.equal(first, 'sticky:1')
  const skips: Array<[string, string]> = []
  p.onPinnedSkip((pinned, used) => { skips.push([pinned, used]) })
  assert.equal(p.pick('ses-1', 'm'), 'sticky:1')
  assert.deepEqual(skips, [['pin:1', 'sticky:1']])
})
