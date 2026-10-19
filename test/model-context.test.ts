import test from 'node:test'
import assert from 'node:assert/strict'
import Schema from '@deepseek-ai/schemastery'

import { Config, ordinaryConfig, type ResolvedPluginConfig } from '../src/config.ts'
import {
  MAX_CONTEXT_WINDOW,
  MAX_MODEL_CONTEXT_WINDOWS,
  MIN_CONTEXT_WINDOW,
  formatModelContextWindows,
  normalizeModelContextWindows,
  parseModelContextWindows,
  sanitizeModelContextWindows,
  type ModelContextWindows,
} from '../src/model-context.ts'
import { ModelCatalog } from '../src/adapter/catalog.ts'
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import { modelContextWriteOps } from '../src/client/settings-writes.ts'

function fakeFetch(routes: Record<string, unknown>) {
  return (async (url: string | URL) => {
    const key = String(url).replace(/\?.*$/, '')
    const body = routes[key]
    if (body === undefined) throw new Error(`unexpected fetch: ${key}`)
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const zenBody = { data: [{ id: 'qwen-free' }, { id: 'ghost-free' }, { id: 'mimo-v2.6-flash-free' }] }
const metadataBody = {
  opencode: {
    models: {
      // The live models.dev shape: 200K declared, while the endpoint serves 1M.
      'qwen-free': { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32768 } },
      'ghost-free': { cost: { input: 0, output: 0 } },
      'mimo-v2.6-flash-free': { cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32768 } },
    },
  },
}

test('context windows are an editable volatile config node', () => {
  const config = Config({ modelContextWindows: { 'big-pickle': 1048576 } })
  assert.equal(typeof config.modelContextWindows.get, 'function', 'modelContextWindows is a volatile reference')
  assert.deepEqual(config.modelContextWindows.get(), { 'big-pickle': 1048576 })
  // Ordinary consumers never see the reference (or the field at all).
  const ordinary = ordinaryConfig(config as unknown as ResolvedPluginConfig)
  assert.equal('modelContextWindows' in ordinary, false)
  assert.equal('requestHeaders' in ordinary, false)
  assert.equal('ipPool' in ordinary, false)
})

test('the Config schema survives the settings-form round trip with a numeric dict', () => {
  // The same two serializations the settings page performs: plainSchema's
  // rebuild (new Schema(toJSON())) and the browser's rehydration of that
  // rebuild. A plain dict of numbers must decode there, and enforce its type.
  const serialized = JSON.parse(JSON.stringify(Config.toJSON()))
  const rebuilt = new Schema(JSON.parse(JSON.stringify(new Schema(serialized).toJSON())))
  for (const draft of [
    { modelContextWindows: {}, ipPool: { enabled: false } },
    { modelContextWindows: { 'big-pickle': 1048576, 'mimo-v2.6-flash-free': 1000000 }, ipPool: { enabled: false } },
  ]) {
    assert.doesNotThrow(() => rebuilt(draft), `the form must decode ${JSON.stringify(draft.modelContextWindows)}`)
  }
  assert.throws(() => rebuilt({ modelContextWindows: { 'big-pickle': 'huge' } }), /expected number/)
  assert.throws(() => rebuilt({ modelContextWindows: { 'big-pickle': MIN_CONTEXT_WINDOW - 1 } }), />= 1024/)
})

test('the editor parses one "model-id = tokens" per line, colon accepted', () => {
  const parsed = parseModelContextWindows(
    'big-pickle = 1048576\nmimo-v2.6-flash-free: 1000000\n\n  \nqwen-free=200000\n',
  )
  assert.deepEqual(parsed, {
    'big-pickle': 1048576,
    'mimo-v2.6-flash-free': 1000000,
    'qwen-free': 200000,
  })
  assert.equal(
    formatModelContextWindows(parsed),
    'big-pickle = 1048576\nmimo-v2.6-flash-free = 1000000\nqwen-free = 200000',
  )
  assert.deepEqual(parseModelContextWindows(formatModelContextWindows(parsed)), parsed)
  assert.deepEqual(parseModelContextWindows(''), {})
  assert.deepEqual(parseModelContextWindows(' \n\t\n'), {})
})

test('the editor boundary refuses malformed or out-of-range entries', () => {
  for (const text of [
    'big-pickle 1048576', // no separator
    'big-pickle =',
    'big-pickle = 1m', // multipliers are deliberately not guessed
    'big-pickle = 1.5',
    'big-pickle = -1',
    'big-pickle = 20000000', // above MAX_CONTEXT_WINDOW
    `big-pickle = ${String(MIN_CONTEXT_WINDOW - 1)}`,
    'bad id = 1048576',
  ]) {
    assert.throws(() => parseModelContextWindows(text), `must refuse ${JSON.stringify(text)}`)
  }
  assert.throws(() => parseModelContextWindows('big-pickle = 1048576\nbig-pickle = 1000000'), /duplicate/i)
  assert.throws(
    () => parseModelContextWindows(Array.from({ length: MAX_MODEL_CONTEXT_WINDOWS + 1 }, (_, i) => `model-${String(i)} = 1048576`).join('\n')),
    /at most/i,
  )
})

test('strict normalization rejects what the lenient sanitizer drops', () => {
  assert.deepEqual(normalizeModelContextWindows({ ' big-pickle ': MAX_CONTEXT_WINDOW }), { 'big-pickle': MAX_CONTEXT_WINDOW })
  for (const invalid of [
    null,
    [],
    'nope',
    { 'big-pickle': 0 },
    { 'big-pickle': MIN_CONTEXT_WINDOW - 1 },
    { 'big-pickle': MAX_CONTEXT_WINDOW + 1 },
    { 'big-pickle': 1.5 },
    { 'big-pickle': '1048576' },
    { 'bad id': 1048576 },
    { '': 1048576 },
    Object.fromEntries(Array.from({ length: MAX_MODEL_CONTEXT_WINDOWS + 1 }, (_, i) => [`model-${String(i)}`, 1048576])),
  ]) {
    assert.throws(() => normalizeModelContextWindows(invalid), `must reject ${JSON.stringify(invalid)?.slice(0, 60)}`)
  }

  assert.deepEqual(sanitizeModelContextWindows({
    ' big-pickle ': 1048576,
    'bad id': 1048576,
    'too-low': 100,
    'not-a-number': 'huge',
    'big-pickle': 200000, // duplicate after trimming: dropped
  }), { 'big-pickle': 1048576 })
  assert.deepEqual(sanitizeModelContextWindows(undefined), {})
  assert.deepEqual(sanitizeModelContextWindows([1, 2]), {})
  const many = Object.fromEntries(Array.from({ length: MAX_MODEL_CONTEXT_WINDOWS + 5 }, (_, i) => [`model-${String(i)}`, 1048576]))
  assert.equal(Object.keys(sanitizeModelContextWindows(many)).length, MAX_MODEL_CONTEXT_WINDOWS)
})

test('a live override beats models.dev and the built-in default', async () => {
  let overrides: ModelContextWindows = {
    'qwen-free': 1048576,
    // models.dev knows nothing about this id: the override still speaks.
    'ghost-free': 1000000,
  }
  const catalog = new ModelCatalog({
    contextWindows: () => overrides,
    fetchImpl: fakeFetch({
      'https://opencode.ai/inference/v1/models': zenBody,
      'https://models.dev/api.json': metadataBody,
    }),
  })
  try {
    await catalog.refreshOnce()
    // The declared 200K window is replaced; maxOutput still comes from models.dev.
    assert.deepEqual(catalog.limits('qwen-free'), { contextWindow: 1048576, maxOutput: 32768 })
    // No metadata at all: the override alone answers.
    assert.deepEqual(catalog.limits('ghost-free'), { contextWindow: 1000000 })

    // The reader is consulted on EVERY lookup: a settings save needs no rebuild.
    overrides = { 'qwen-free': 200000, 'ghost-free': 1000000 }
    assert.deepEqual(catalog.limits('qwen-free'), { contextWindow: 200000, maxOutput: 32768 })
    overrides = {}
    assert.deepEqual(catalog.limits('qwen-free'), { contextWindow: 200000, maxOutput: 32768 })

    // Built-in LOCAL_MODEL_OVERRIDES still repair the mimo feed value...
    assert.deepEqual(catalog.limits('mimo-v2.6-flash-free'), { contextWindow: 1048576, maxOutput: 32768 })
    // ...and the live setting wins over it.
    overrides = { 'mimo-v2.6-flash-free': 200000 }
    assert.deepEqual(catalog.limits('mimo-v2.6-flash-free'), { contextWindow: 200000, maxOutput: 32768 })
  } finally {
    catalog.stop()
  }
})

test('the catalog ignores invalid live overrides instead of failing', async () => {
  let overrides: unknown = {
    'qwen-free': 100, // below the floor
    'bad id': 1048576, // invalid id
  }
  const catalog = new ModelCatalog({
    contextWindows: () => overrides as ModelContextWindows,
    fetchImpl: fakeFetch({
      'https://opencode.ai/inference/v1/models': zenBody,
      'https://models.dev/api.json': metadataBody,
    }),
  })
  try {
    await catalog.refreshOnce()
    assert.deepEqual(catalog.limits('qwen-free'), { contextWindow: 200000, maxOutput: 32768 })
    // A reader that throws is "no override", never a broken model lookup.
    const throwing = new ModelCatalog({
      contextWindows: () => { throw new Error('volatile reader exploded') },
      fetchImpl: fakeFetch({
        'https://opencode.ai/inference/v1/models': zenBody,
        'https://models.dev/api.json': metadataBody,
      }),
    })
    try {
      await throwing.refreshOnce()
      assert.deepEqual(throwing.limits('qwen-free'), { contextWindow: 200000, maxOutput: 32768 })
    } finally {
      throwing.stop()
    }
  } finally {
    catalog.stop()
  }
})

test('resolveModel advertises the overridden window without touching the output budget', () => {
  const catalog = new ModelCatalog({ contextWindows: () => ({ 'big-pickle': 1048576 }) })
  const adapter = new ZenAdapter(catalog)
  const model = adapter.resolveModel('oc2dsh', 'big-pickle')
  assert.equal(model.context.contextWindow, 1048576)
  // maxOutput is not part of the override: metadata absent -> shipped default.
  assert.equal(model.defaultMaxTokens, 32768)
})

test('saving context windows writes its own root node', () => {
  assert.deepEqual(modelContextWriteOps('big-pickle = 1048576', {}, {}), [
    { op: 'set', path: ['modelContextWindows'], value: { 'big-pickle': 1048576 } },
  ])
  assert.deepEqual(modelContextWriteOps('', { 'big-pickle': 1048576 }, {}), [
    { op: 'unset', path: ['modelContextWindows'] },
  ])
  // Unchanged draft: no write at all.
  assert.deepEqual(modelContextWriteOps('big-pickle = 1048576', { 'big-pickle': 1048576 }, {}), [])
  // Reverting to the inherited (composition) value removes the override.
  assert.deepEqual(
    modelContextWriteOps('big-pickle = 200000', { 'big-pickle': 1048576 }, { 'big-pickle': 200000 }),
    [{ op: 'unset', path: ['modelContextWindows'] }],
  )
  assert.throws(() => modelContextWriteOps('big-pickle = 12', {}, {}))
})
