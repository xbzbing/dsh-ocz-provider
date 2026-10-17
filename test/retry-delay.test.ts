import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_RETRY_KEYS,
  RETRY_DELAY_LADDER_MS,
  STALE_RETRY_GAP_MS,
  nextRetryDelayMs,
  resetRetryDelays,
  retryDelayKey,
} from '../src/adapter/retry-delay.ts'
import { FREE_LANE_RETRY_POLICY } from '../src/adapter/zen-adapter.ts'

const messages = [{ role: 'user', content: 'hello' }]

test('the ladder walks 5/8/10/15/20/30s and clamps at 30s for rungs 7-10', () => {
  resetRetryDelays()
  const key = retryDelayKey('big-pickle', messages)
  const waits: number[] = []
  let now = 0
  for (let i = 0; i < 10; i += 1) {
    // 40s apart: inside one chain (host waits + attempt time), never stale
    waits.push(nextRetryDelayMs(key, now))
    now += 40_000
  }
  assert.deepEqual(waits, [5_000, 8_000, 10_000, 15_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000])
  // the budget the user set: 10 retries, ceiling 30s
  assert.equal(FREE_LANE_RETRY_POLICY.maxRetries, 10)
  assert.equal(waits.length, FREE_LANE_RETRY_POLICY.maxRetries)
})

test('a slot idle past the stale gap restarts at the first rung', () => {
  resetRetryDelays()
  const key = retryDelayKey('big-pickle', messages)
  assert.equal(nextRetryDelayMs(key, 0), 5_000)
  assert.equal(nextRetryDelayMs(key, 60_000), 8_000)
  // a much later request with the same digest is a NEW chain, not rung 3
  assert.equal(nextRetryDelayMs(key, 60_000 + STALE_RETRY_GAP_MS + 1), 5_000)
})

test('different step requests ladder independently', () => {
  resetRetryDelays()
  const first = retryDelayKey('big-pickle', messages)
  const other = retryDelayKey('big-pickle', [{ role: 'user', content: 'different' }])
  const otherModel = retryDelayKey('ghost', messages)
  assert.equal(nextRetryDelayMs(first, 0), 5_000)
  assert.equal(nextRetryDelayMs(other, 0), 5_000)
  assert.equal(nextRetryDelayMs(otherModel, 0), 5_000)
  // the first key keeps walking its own ladder
  assert.equal(nextRetryDelayMs(first, 1_000), 8_000)
})

test('the tracking map is LRU-capped at MAX_RETRY_KEYS', () => {
  resetRetryDelays()
  const oldest = retryDelayKey('big-pickle', [{ role: 'user', content: 'oldest' }])
  assert.equal(nextRetryDelayMs(oldest, 0), 5_000)
  assert.equal(nextRetryDelayMs(oldest, 1_000), 8_000)
  assert.equal(nextRetryDelayMs(oldest, 2_000), 10_000)
  // flood with fresh keys: the oldest slot is evicted, not grown without bound
  for (let i = 0; i < MAX_RETRY_KEYS; i += 1) {
    nextRetryDelayMs(retryDelayKey('big-pickle', [{ role: 'user', content: `filler-${i}` }]), 3_000)
  }
  // evicted = forgotten = a fresh ladder begins at the first rung
  assert.equal(nextRetryDelayMs(oldest, 4_000), 5_000)
})

test('every rung fits the host ceiling — above it the host gives up instead of retrying', () => {
  assert.ok(RETRY_DELAY_LADDER_MS.length > 0)
  for (const rung of RETRY_DELAY_LADDER_MS) {
    assert.ok(rung > 0, 'a zero wait would re-hammer the lane')
    assert.ok(
      rung <= FREE_LANE_RETRY_POLICY.maxDelayMs,
      `rung ${rung} exceeds maxDelayMs ${FREE_LANE_RETRY_POLICY.maxDelayMs}: dsh-llm-retry would surface the error WITHOUT retrying`,
    )
  }
  // ladder waits ride providerRetryAfterMs, which the host validates as a
  // positive finite number in llmFailureValue
  assert.equal(Object.isFrozen(RETRY_DELAY_LADDER_MS), true)
})
