import test from 'node:test'
import assert from 'node:assert/strict'

import { describeFailure, giveUpStory, nextStep, ROTATE_SAFETY_CAP, STREAM_ENDED_MESSAGE, watchEvents, WATCHDOG_FIRST_MESSAGE } from '../src/adapter/attempt.ts'
import type { PiEvent } from '../src/adapter/events.ts'

const terminal = (message: string): PiEvent => ({ type: 'error', error: { errorMessage: message } } as never)

async function drain(events: AsyncIterable<PiEvent>): Promise<PiEvent[]> {
  const out: PiEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

test('nextStep: origin-shaped failures switch doors first, exit-shaped ones ask the pool', () => {
  const refused = describeFailure('403: {"type":"FreeTierError"}')
  assert.equal(nextStep(refused, { hasNextOrigin: true, rotations: 0 }), 'switch-origin')
  assert.equal(nextStep(refused, { hasNextOrigin: false, rotations: 0 }), 'ask-pool')
  const limited = describeFailure('429: Too Many Requests')
  assert.equal(nextStep(limited, { hasNextOrigin: true, rotations: 0 }), 'ask-pool', 'a 429 never buys a second origin')
  assert.equal(nextStep(limited, { hasNextOrigin: false, rotations: ROTATE_SAFETY_CAP }), 'give-up', 'safety cap')
  assert.equal(nextStep(describeFailure('400 bad request'), { hasNextOrigin: false, rotations: 0 }), 'give-up')
})

test('describeFailure grades the exit like the dispatcher', () => {
  assert.deepEqual(describeFailure('429: x').outcome, { status: 429 })
  assert.deepEqual(describeFailure('Connection error.').outcome, { transport: true })
  assert.deepEqual(describeFailure('502: {"type":"relay_error"}').outcome, { transport: true }, 'the relay envelope is a cut')
  assert.equal(describeFailure('403: …abusive traffic from this IP address…').abusive, true)
  assert.equal(describeFailure('403: {"type":"RegionError"}').deterministic, true)
})

test('giveUpStory is empty for one attempt and names rotations otherwise', () => {
  assert.equal(giveUpStory(['#1 limited: 429'], 0), '')
  assert.match(giveUpStory(['#1 a', '#2 b'], 1), /轮换 1 次后放弃: #1 a -> #2 b/)
  assert.match(giveUpStory(['#1 a', '#1 b'], 0), /两条来源均失败/)
})

test('watchEvents always ends with exactly one terminal event', async () => {
  const closed = await drain(watchEvents((async function* () { yield { type: 'start' } as PiEvent })(), { firstEventMs: 1000, bodyIdleMs: 1000 }, terminal, () => {}))
  assert.deepEqual(closed.map((e) => e.type), ['start', 'error'])
  assert.equal((closed[1] as { error: { errorMessage: string } }).error.errorMessage, STREAM_ENDED_MESSAGE)

  let abandoned = 0
  let keepAlive: NodeJS.Timeout | undefined
  const silent = (async function* (): AsyncGenerator<PiEvent> {
    await new Promise((resolve) => { keepAlive = setTimeout(resolve, 60_000) })
  })()
  try {
    const timedOut = await drain(watchEvents(silent, { firstEventMs: 20, bodyIdleMs: 1000 }, terminal, () => { abandoned += 1 }))
    assert.equal((timedOut[0] as { error: { errorMessage: string } }).error.errorMessage, WATCHDOG_FIRST_MESSAGE)
    assert.equal(abandoned, 1, 'the silent request is abandoned')
  } finally {
    clearTimeout(keepAlive)
  }
})
