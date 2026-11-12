/**
 * One exit row's state name, shared by the settings card's table and the stats
 * modal. The rule is a precedence, so it is tested once here instead of being
 * re-derived in two JSX chains that drift apart.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { exitRowState } from '../src/client/exit-state.ts'
import type { ExitRowView } from '../src/client/types.ts'

function row(overrides: Partial<ExitRowView> = {}): ExitRowView {
  return {
    id: '127.0.0.1:30001',
    source: 'subscription',
    protocol: 'socks5',
    pinned: false,
    // A measured row is the fixture default: that is what a subscription exit
    // looks like after its speed pass.
    exitIP: '23.94.213.251',
    exitLocation: 'US city',
    latencyMs: 766,
    quality: 'A',
    state: 'ok',
    cooling: false,
    cooldownUntil: 0,
    consecutiveLimited: 0,
    note: '',
    bannedModels: [],
    passive: { ok: 0, limited: 0, refused: 0, dead: 0, transport: 0 },
    requests: 0,
    lastUsedAt: 0,
    inFlight: 0,
    demoted: false,
    tokens: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    speed: 0,
    ...overrides,
  }
}

test('a probed-healthy row is usable', () => {
  assert.equal(exitRowState(row()), 'usable')
})

test('dead outranks every other mark', () => {
  assert.equal(exitRowState(row({ state: 'dead', demoted: true, cooling: true })), 'dead')
})

test('demoted outranks cooling and usability', () => {
  assert.equal(exitRowState(row({ demoted: true, cooling: true })), 'demoted')
  assert.equal(exitRowState(row({ demoted: true })), 'demoted')
})

test('cooling outranks the usable state it was admitted with', () => {
  assert.equal(exitRowState(row({ cooling: true })), 'cooling')
})

test('no health claim splits on whether anything measured the exit', () => {
  // The two faults shared one word before: a renumbered port / failed lane
  // probe keeps its facts (unproven), a row nothing reached has none (unknown).
  assert.equal(exitRowState(row({ state: 'unknown' })), 'unproven')
  assert.equal(exitRowState(row({ state: 'unknown', exitIP: '', latencyMs: 0 })), 'unknown')
})
