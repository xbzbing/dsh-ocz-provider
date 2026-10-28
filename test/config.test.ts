import test from 'node:test'
import assert from 'node:assert/strict'

import { Config, defaults, resolveConfig } from '../src/config.ts'
import { resolveIpPoolSettings } from '../src/ip-pool-settings/namespace.ts'

test('resolveConfig fills defaults and keeps overrides', () => {
  const base = resolveConfig()
  assert.equal(base.refreshSeconds, defaults.refreshSeconds)
  assert.equal(base.userAgent, undefined, 'no configured UA means the adapter keeps its built-in one')
  const custom = resolveConfig({ refreshSeconds: 60, userAgent: 'opencode/1.19.0 (darwin 27.0.0; arm64)' })
  assert.equal(custom.refreshSeconds, 60)
  assert.equal(custom.userAgent, 'opencode/1.19.0 (darwin 27.0.0; arm64)')
})

test('the schema carries no child-process knobs', () => {
  // The Go-agent integration is gone: nothing spawns a process, so the fields
  // that drove one (mode, agentPath, agentArgs, providerId, apiKeyEnv and the
  // restart/crash budgets) must stay undeclared — an undeclared key would ride
  // through a hand-edited patch unvalidated and read as live config.
  const config = Config({})
  for (const key of ['mode', 'agentPath', 'agentArgs', 'providerId', 'apiKeyEnv', 'restartDelayMs', 'restartMaxDelayMs', 'maxConsecutiveCrashes']) {
    assert.equal(key in config, false, `${key} must not be a Config field`)
  }
})

test('Config preserves subscription URLs from an older profile patch', () => {
  const config = Config({ ipPool: { subscriptions: ['https://example.test/sub'] } })
  const value = resolveIpPoolSettings(JSON.parse(JSON.stringify(config.ipPool.get())))
  assert.deepEqual(value.subscription.urls, ['https://example.test/sub'])
})

test('Config declares and bounds the stream watchdog windows, undefined when unset', () => {
  // The windows must be declared in the schema to reach ZenAdapter's
  // constructor; unlike an undeclared key (schemastery passes those through
  // unvalidated), declaring them also makes the schema reject a nonsensical
  // window instead of arming it.
  const config = Config({ firstEventMs: 300, bodyIdleMs: 900, responsesBodyIdleMs: 1800 })
  assert.equal(config.firstEventMs, 300)
  assert.equal(config.bodyIdleMs, 900)
  assert.equal(config.responsesBodyIdleMs, 1800)
  for (const key of ['firstEventMs', 'bodyIdleMs', 'responsesBodyIdleMs'] as const) {
    for (const value of [-1, 0, 0.5, 600_001, 2 ** 31, Infinity, NaN, '300']) {
      assert.throws(() => Config({ [key]: value }), new RegExp(key))
    }
    assert.equal(Config({ [key]: 1 })[key], 1)
    assert.equal(Config({ [key]: 600_000 })[key], 600_000)
  }
  // No schema default on purpose: an unset window must stay undefined so the
  // adapter's own `?? DEFAULT_*_MS` owns the shipped number (one source).
  const bare = Config({})
  assert.equal(bare.firstEventMs, undefined)
  assert.equal(bare.bodyIdleMs, undefined)
  assert.equal(bare.responsesBodyIdleMs, undefined)
  // resolveConfig() is `{ ...defaults, ...config }`: the keys ride through the
  // plain ordinary half apply() hands it, untouched by `defaults`.
  assert.equal(resolveConfig({ firstEventMs: 300 }).firstEventMs, 300)
  assert.equal(resolveConfig().firstEventMs, undefined)
})
