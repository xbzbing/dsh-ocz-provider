/**
 * The probe-content pool (pure functions): the default content, the cleanup a
 * hand-typed list needs (trim / drop empties / dedupe), and the pick — which
 * must never index outside the pool whatever a `random` seam returns.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SMOKE_CONTENT, normalizeSmokeContents, pickSmokeContent } from '../src/pool/smoke-content.ts'

test('the default probe content is hello', () => {
  assert.equal(DEFAULT_SMOKE_CONTENT, 'hello')
})

test('normalizeSmokeContents trims, drops empties and dedupes, keeping order', () => {
  assert.deepEqual(normalizeSmokeContents(undefined), [])
  assert.deepEqual(normalizeSmokeContents([]), [])
  assert.deepEqual(normalizeSmokeContents(['  ', '', '\t']), [], 'whitespace is not content')
  assert.deepEqual(normalizeSmokeContents([' hello ', 'hello', 'hi', ' hi ']), ['hello', 'hi'], 'trimmed, deduped, order kept')
})

test('pickSmokeContent falls back to the default when nothing is configured', () => {
  assert.equal(pickSmokeContent(undefined), 'hello')
  assert.equal(pickSmokeContent([]), 'hello')
  assert.equal(pickSmokeContent(['   ']), 'hello')
})

test('pickSmokeContent draws from the pool, and clamps whatever random returns', () => {
  const pool = ['alpha', 'beta', 'gamma']
  assert.equal(pickSmokeContent(pool, () => 0), 'alpha')
  assert.equal(pickSmokeContent(pool, () => 0.34), 'beta', 'the middle entry is reachable')
  assert.equal(pickSmokeContent(pool, () => 0.99), 'gamma')
  assert.equal(pickSmokeContent(pool, () => 1), 'gamma', 'a seam returning exactly 1 stays inside the pool')
  assert.equal(pickSmokeContent(pool, () => -1), 'alpha', 'and a negative cannot read backwards')
  assert.equal(pickSmokeContent(pool, () => Number.NaN), 'alpha', 'NaN falls back to the first entry')
})
