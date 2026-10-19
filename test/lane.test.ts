import test from 'node:test'
import assert from 'node:assert/strict'

import { isOriginFailure, laneOrigins, ZEN_FALLBACK_BASE_URL, ZEN_PRIMARY_BASE_URL } from '../src/adapter/lane.ts'

/**
 * The origin ladder (2026-10-19): `/inference` and `/zen` accept the SAME
 * fingerprint, so the lane has one recipe and two doors. These tests pin WHEN
 * a second door is worth a round trip and WHICH origins may form a ladder — a
 * test or an operator override must never silently reach the live console.
 */

test('the ladder puts the primary first and the console second, trailing slashes collapsed', () => {
  assert.deepEqual(laneOrigins(ZEN_PRIMARY_BASE_URL), [ZEN_PRIMARY_BASE_URL, ZEN_FALLBACK_BASE_URL])
  // An operator pointing the adapter at the console makes /inference the rung.
  assert.deepEqual(laneOrigins(ZEN_FALLBACK_BASE_URL), [ZEN_FALLBACK_BASE_URL, ZEN_PRIMARY_BASE_URL])
  assert.deepEqual(laneOrigins(`${ZEN_PRIMARY_BASE_URL}/`), [ZEN_PRIMARY_BASE_URL, ZEN_FALLBACK_BASE_URL])
})

test('a caller-chosen base is used alone, so no fixture reaches the live lane', () => {
  assert.deepEqual(laneOrigins('https://zen.test'), ['https://zen.test'])
  assert.deepEqual(laneOrigins('http://127.0.0.1:9/'), ['http://127.0.0.1:9'])
  assert.deepEqual(laneOrigins(''), [])
})

test('an explicit fallback builds the ladder the tests drive, duplicates collapsed', () => {
  assert.deepEqual(laneOrigins('https://a.test', 'https://b.test'), ['https://a.test', 'https://b.test'])
  assert.deepEqual(laneOrigins('https://a.test', 'https://a.test/'), ['https://a.test'])
  assert.deepEqual(laneOrigins('https://a.test', ''), ['https://a.test'])
})

test('origin-shaped failures fail over; exit-shaped ones keep to the pool', () => {
  for (const message of [
    '403: {"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}}',
    '401 Unauthorized',
    '404 models endpoint missing',
    '502 Bad Gateway',
    '503 Service Unavailable',
    '500 internal server error',
  ]) {
    assert.equal(isOriginFailure(message), true, message)
  }
  for (const message of [
    '429: Too Many Requests',
    'fetch failed',
    'read ECONNRESET',
    'The operation was aborted due to timeout',
    'stream ended before any content',
    // the door is fine; this exit's country is not (pool/rotate.ts isRegionBlocked)
    'OpenAI API error (403): {"type":"RegionError","message":"This model is not available in your country."}',
  ]) {
    assert.equal(isOriginFailure(message), false, message)
  }
})
