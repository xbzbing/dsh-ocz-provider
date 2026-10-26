import { normalizeResponsesPayload } from '../src/adapter/zen-adapter.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelCatalog } from '../src/adapter/catalog.ts'
import { isResponsesModel, PROVIDER_ID, PROVIDER_NAME, reasoningEfforts, reasoningEffortWire, toPiModel, WATCHDOG_FIRST_MESSAGE, ZenAdapter } from '../src/adapter/zen-adapter.ts'
import { Config, resolveConfig } from '../src/config.ts'
import { resetRetryDelays } from '../src/adapter/retry-delay.ts'
import { FREE_LANE_GATE_TOOL_NAMES, freeLaneGateTool } from '../src/adapter/gate-tools.ts'
import { withEnvBlock } from '../src/adapter/env-block.ts'

/**
 * The exact method surface dsh-llm touches on a registered adapter. A missing
 * member throws inside registerAdapter and silently drops the provider from
 * the model selector.
 */
test('ZenAdapter implements the full dsh-llm adapter surface', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  for (const method of ['providerInfo', 'providerRetryPolicy', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    assert.equal(typeof (adapter as unknown as Record<string, unknown>)[method], 'function', `missing method: ${method}`)
  }
})

test('providerInfo names the provider for the picker', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  // the route id keys settings/adapter registration; the display name is the
  // model picker's group label and is free to move without the id.
  assert.deepEqual(adapter.providerInfo('oc2dsh'), { id: 'oc2dsh', name: PROVIDER_NAME })
  assert.equal(PROVIDER_NAME, 'OpenCode-Zen-Free')
  assert.notEqual(PROVIDER_NAME, PROVIDER_ID)
})

test('providerRetryPolicy tunes the host retry for free-lane 429 bursts', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  const policy = adapter.providerRetryPolicy('oc2dsh')
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 10, 'the documented retry budget (host default: 5)')
  assert.deepEqual([...policy.retryableCodes], ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
  assert.equal(policy.initialDelayMs, 5_000, 'untagged-fallback backoff starts at one ladder rung')
  assert.ok(policy.maxDelayMs >= 20_000, 'backoff must outlast measured quota windows (~60s)')
  assert.equal(policy.maxDelayMs, 30_000, 'the ladder ceiling: above this the host stops retrying')
  // flat resolved shape — dsh-llm consumes the adapter value verbatim
  assert.equal('backoff' in policy, false)
  assert.ok(Object.isFrozen(policy))
})

test('resolveModel declares image input from models.dev, and the built-in pattern otherwise', () => {
  // No metadata loaded: the built-in live-verified family is the only source.
  const adapter = new ZenAdapter(new ModelCatalog())
  const textOnly = adapter.resolveModel('oc2dsh', 'big-pickle')
  assert.deepEqual(textOnly.inputModalities, ['text'])
  assert.equal(textOnly.context.contextWindow > 0, true)
  assert.equal(textOnly.defaultMaxTokens > 0, true)
  assert.equal(textOnly.provider, 'oc2dsh')
  assert.equal(textOnly.id, 'big-pickle')
  // The mimo-v2.6 family is the vision lane.
  const vision = adapter.resolveModel('oc2dsh', 'mimo-v2.6-flash-free')
  assert.deepEqual(vision.inputModalities, ['text', 'image'])

  // A declared `image` opens a model outside the family, and a declared
  // text-only model is refused even inside it — the declaration wins both ways.
  const declared = new ZenAdapter(catalogWithModalities({
    'space-bunny-free': ['text', 'image', 'video'],
    'text-only-free': ['text'],
    'mimo-v2.6-text-free': ['text'],
    'undeclared-free': undefined,
  }))
  assert.deepEqual(declared.resolveModel('oc2dsh', 'space-bunny-free').inputModalities, ['text', 'image'])
  assert.deepEqual(declared.resolveModel('oc2dsh', 'text-only-free').inputModalities, ['text'])
  assert.deepEqual(declared.resolveModel('oc2dsh', 'mimo-v2.6-text-free').inputModalities, ['text'])
  // metadata silent for this id: the built-in pattern still decides
  assert.deepEqual(declared.resolveModel('oc2dsh', 'undeclared-free').inputModalities, ['text'])
  assert.deepEqual(declared.resolveModel('oc2dsh', 'mimo-v2.6-undeclared-free').inputModalities, ['text', 'image'])
  // a catalog without a modalities() member at all (structural CatalogLike)
  const legacy = new ZenAdapter({
    list: () => ['space-bunny-free', 'mimo-v2.6-flash-free'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => undefined,
  })
  assert.deepEqual(legacy.resolveModel('oc2dsh', 'space-bunny-free').inputModalities, ['text'])
  assert.deepEqual(legacy.resolveModel('oc2dsh', 'mimo-v2.6-flash-free').inputModalities, ['text', 'image'])
})

/** A catalog whose models.dev `modalities.input` is `byModel` (undefined = silent). */
function catalogWithModalities(byModel: Record<string, string[] | undefined>) {
  return {
    list: () => Object.keys(byModel),
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => undefined,
    modalities: (model: string) => byModel[model],
  }
}

test('resolveModel prefers models.dev limits and keeps the defaults without them', () => {
  const catalog = (limits?: { contextWindow?: number; maxOutput?: number }) => ({
    list: () => ['big-pickle', 'ghost'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => undefined,
    limits: (model: string) => (model === 'big-pickle' ? limits : undefined),
  })
  // declared window wins over the flat host default
  const windowed = new ZenAdapter(catalog({ contextWindow: 131072, maxOutput: 16384 }))
  assert.equal(windowed.resolveModel('oc2dsh', 'big-pickle').context.contextWindow, 131072)
  assert.equal(windowed.resolveModel('oc2dsh', 'big-pickle').defaultMaxTokens, 16384)

  // A larger declared budget must remain available for reasoning and answers.
  const capped = new ZenAdapter(catalog({ maxOutput: 4096 }))
  assert.equal(capped.resolveModel('oc2dsh', 'big-pickle').defaultMaxTokens, 4096)
  const roomy = new ZenAdapter(catalog({ contextWindow: 1048576, maxOutput: 384000 }))
  assert.equal(roomy.resolveModel('oc2dsh', 'big-pickle').context.contextWindow, 1048576)
  assert.equal(roomy.resolveModel('oc2dsh', 'big-pickle').defaultMaxTokens, 384000)

  // metadata cannot speak: flat defaults win
  const plain = new ZenAdapter(catalog())
  assert.equal(plain.resolveModel('oc2dsh', 'ghost').context.contextWindow, 262144)
  assert.equal(plain.resolveModel('oc2dsh', 'ghost').defaultMaxTokens, 32768)

  // a catalog without a limits() member at all (structural CatalogLike)
  const legacy = new ZenAdapter({
    list: () => ['big-pickle'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => undefined,
  })
  assert.equal(legacy.resolveModel('oc2dsh', 'big-pickle').context.contextWindow, 262144)
})

test('prepareCall returns the resolved model and a stream dispatcher', async () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  const call = await adapter.prepareCall('oc2dsh', 'big-pickle')
  assert.equal(call.model.id, 'big-pickle')
  assert.equal(typeof call.stream, 'function')
})

test('the pi-ai model declares the DeepSeek reasoning replay requirement', () => {
  // DeepSeek's thinking mode rejects replayed turns without reasoning_content;
  // pi-ai only auto-detects that for provider 'deepseek' (or a deepseek.com
  // baseUrl), neither of which matches this lane, so the model literal
  // declares it — the flag gates pi-ai's empty reasoning_content backfill for
  // thinking-free assistant turns.
  assert.deepEqual(toPiModel('deepseek-v4.1-flash-free', true).compat, { requiresReasoningContentOnAssistantMessages: true })
})

test('listModels mirrors the catalog without duplicates', async () => {
  const adapter = new ZenAdapter({
    list: () => ['big-pickle', 'big-pickle', 'mimo-v2.5-free', 'mimo-v2.6-flash-free', 'space-bunny-free'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => ({ reasoning: true, effortValues: [] }),
    modalities: (model: string) => (model === 'mimo-v2.5-free' ? ['text', 'image'] : undefined),
  })
  const models = await adapter.listModels('oc2dsh')
  assert.deepEqual(models.map((m) => m.id), ['big-pickle', 'mimo-v2.5-free', 'mimo-v2.6-flash-free', 'space-bunny-free'])
  // models.dev declares the modality per model; the built-in family is the fallback.
  assert.deepEqual(models.map((m) => m.inputModalities), [['text'], ['text', 'image'], ['text', 'image'], ['text']])
})

test('listModels awaits the catalog warm before reading', async () => {
  let warmCalls = 0
  let readAfterWarm = false
  const adapter = new ZenAdapter({
    list: () => {
      if (warmCalls > 0) readAfterWarm = true
      return ['step-5-preview-free']
    },
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => undefined,
    warm: async () => {
      warmCalls += 1
    },
  })
  const models = await adapter.listModels('oc2dsh')
  assert.equal(warmCalls, 1)
  assert.ok(readAfterWarm, 'the roster was read only after warm() resolved')
  assert.deepEqual(models.map((m) => m.id), ['step-5-preview-free'])
})

test('listModels answers from the live roster once the first fetch lands', async () => {
  // The registration-time read races the first Zen fetch: without the await the
  // host is handed the 7-id bootstrap list, which the picker keeps for the
  // whole host generation.
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const fetchImpl = (async (url: string | URL) => {
    if (String(url).includes('/v1/models')) await gate
    const body = String(url).includes('/v1/models')
      ? { data: [{ id: 'step-5-preview-free' }, { id: 'fledge-alpha-free' }] }
      : { opencode: { models: { 'step-5-preview-free': { cost: { input: 0, output: 0 } }, 'fledge-alpha-free': { cost: { input: 0, output: 0 } } } } }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const catalog = new ModelCatalog({ fetchImpl })
  const adapter = new ZenAdapter(catalog)
  try {
    const listing = adapter.listModels('oc2dsh')
    queueMicrotask(() => release?.())
    const models = await listing
    assert.deepEqual(models.map((m) => m.id), ['fledge-alpha-free', 'step-5-preview-free'])
  } finally {
    catalog.stop()
  }
})

test('reasoningEfforts: declared ladder wins, none folds into off, default ladder otherwise', () => {
  // no capability / non-reasoning model: advertise nothing
  assert.equal(reasoningEfforts(undefined), undefined)
  assert.equal(reasoningEfforts({ reasoning: false, effortValues: ['low'] }), undefined)
  // reasoning without a declared ladder: the standard five the gateway accepts
  assert.deepEqual(
    reasoningEfforts({ reasoning: true, effortValues: [] })?.map((e) => e.id),
    ['off', 'minimal', 'low', 'medium', 'high'],
  )
  // declared ladder (muse-spark shape) is offered verbatim, ladder-ordered
  assert.deepEqual(
    reasoningEfforts({ reasoning: true, effortValues: ['xhigh', 'low', 'medium'] })?.map((e) => e.id),
    ['low', 'medium', 'xhigh'],
  )
  // metadata `none` folds into our `off`; out-of-vocabulary values drop
  assert.deepEqual(
    reasoningEfforts({ reasoning: true, effortValues: ['none', 'high', 'banana'] })?.map((e) => e.id),
    ['off', 'high'],
  )
  // selector labels are the capitalized level names
  assert.deepEqual(reasoningEfforts({ reasoning: true, effortValues: [] })?.[0], { id: 'off', name: 'Off' })
})

test('reasoningEffortWire maps picker ids to the gateway spelling', () => {
  // no selection: inject nothing (provider default keeps always-think models thinking)
  assert.equal(reasoningEffortWire(undefined), undefined)
  // off must SEND none — a mere omission never disables Zen's thinking models
  assert.equal(reasoningEffortWire('off'), 'none')
  // ladder levels pass through verbatim
  assert.equal(reasoningEffortWire('low'), 'low')
  assert.equal(reasoningEffortWire('xhigh'), 'xhigh')
  // unknown ids were never advertised; inject nothing rather than risk the 400
  assert.equal(reasoningEffortWire('banana'), undefined)
})

test('resolveModel advertises the thinking-level picker for reasoning models only', () => {
  const adapter = new ZenAdapter({
    list: () => ['big-pickle', 'ghost'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: (model: string) =>
      model === 'big-pickle' ? { reasoning: true, effortValues: ['low', 'high'] } : undefined,
  })
  assert.deepEqual(
    adapter.resolveModel('oc2dsh', 'big-pickle').reasoning?.efforts.map((e) => e.id),
    ['low', 'high'],
  )
  // unknown metadata: no reasoning field — dsh-llm then offers only the default
  assert.equal(adapter.resolveModel('oc2dsh', 'ghost').reasoning, undefined)
})

/** Scripted provider that records the streamSimple options it receives. */
function capturingProvider() {
  const captured: Array<{ onPayload?: (payload: unknown) => unknown }> = []
  const provider = {
    streamSimple(_model: unknown, _context: unknown, options: { onPayload?: (payload: unknown) => unknown }): AsyncIterable<{ type: string }> {
      captured.push(options)
      return (async function* () {
        yield { type: 'start' }
        yield { type: 'text_delta', delta: 'hi' }
        yield { type: 'done', message: { stopReason: 'stop', content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }
      })()
    },
  }
  return { provider, captured }
}

/** A body already satisfying BOTH halves of the free-lane payload gate: the
 *  genuine tool definitions (adapter/gate-tools.ts) and a system slot carrying
 *  the `<env>` block (env-block.ts). */
// Shaped this way, onPayload leaves it untouched unless a test asks for more —
// which is what keeps these cases about the reasoning effort alone.
const gateBody = {
  model: 'big-pickle',
  messages: [
    { role: 'system', content: withEnvBlock('You are OpenCode, an AI coding agent.') },
    { role: 'user', content: 'hi' },
  ],
  stream: true,
  tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => freeLaneGateTool(name)),
}

async function runStream(catalogReasoning: boolean, effort?: string): Promise<Array<{ onPayload?: (payload: unknown) => unknown }>> {
  const { provider, captured } = capturingProvider()
  const adapter = new ZenAdapter(
    {
      list: () => ['big-pickle'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => ({ reasoning: catalogReasoning, effortValues: [] }),
    },
    { providerOverride: provider },
  )
  const options = { provider: 'oc2dsh', model: 'big-pickle', messages: [], temperature: 0, maxTokens: 16 }
  const stream = adapter.stream({ ...options, ...(effort !== undefined ? { reasoningEffort: effort } : {}) } as never)
  for await (const chunk of stream) void chunk
  return captured
}

test('stream injects the selected reasoning_effort into the outgoing body', async () => {
  // off -> wire none (the only spelling that stops the always-think models)
  const offOptions = (await runStream(true, 'off'))[0]!
  assert.deepEqual(offOptions.onPayload?.({ ...gateBody }), { ...gateBody, reasoning_effort: 'none' })

  // ladder levels ride verbatim
  const lowOptions = (await runStream(true, 'low'))[0]!
  assert.deepEqual(lowOptions.onPayload?.({ ...gateBody }), { ...gateBody, reasoning_effort: 'low' })

  // no selection: the onPayload stays the plain gate shaper (a gate-satisfied
  // body needs no rewrite -> undefined, and no effort field is ever added)
  const defaultOptions = (await runStream(true))[0]!
  assert.equal(defaultOptions.onPayload?.({ ...gateBody }), undefined)
})

test('stream keeps the free-lane gate rewrite alongside the effort injection', async () => {
  // a body missing the gate tools gets them AND the effort in one rewrite
  const offOptions = (await runStream(true, 'off'))[0]!
  const shaped = offOptions.onPayload?.({ model: 'big-pickle', messages: [], stream: true }) as Record<string, unknown>
  assert.equal(shaped.reasoning_effort, 'none')
  assert.deepEqual(
    (shaped.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort(),
    ['read', 'shell'],
  )
  // the injected tools are the genuine definitions and are NOT call-disabled:
  // `tool_choice: 'none'` is a 403 of its own
  assert.equal(shaped.tool_choice, undefined)

  // non-chat payloads pass through untouched even with an effort selected
  assert.equal(offOptions.onPayload?.(null), undefined)
})

test('stream builds the pi-ai wire model with the catalog limits', async () => {
  let seen: { contextWindow?: number; maxTokens?: number } | undefined
  const provider = {
    streamSimple(model: { contextWindow?: number; maxTokens?: number }, _context: unknown, _options: unknown): AsyncIterable<{ type: string }> {
      seen = model
      return (async function* () {
        yield { type: 'start' }
        yield { type: 'done', message: { stopReason: 'stop', content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }
      })()
    },
  }
  const adapter = new ZenAdapter(
    {
      list: () => ['big-pickle'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => undefined,
      limits: () => ({ contextWindow: 65536, maxOutput: 8192 }),
    },
    { providerOverride: provider },
  )
  for await (const chunk of adapter.stream({ provider: 'oc2dsh', model: 'big-pickle', messages: [] })) void chunk
  assert.equal(seen?.contextWindow, 65536)
  assert.equal(seen?.maxTokens, 8192)
})

test('isResponsesModel routes muse-spark to responses, everything else to chat', () => {
  for (const id of ['muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free', 'muse-spark-1.2', 'MUSE-SPARK-1.3']) {
    assert.equal(isResponsesModel(id), true, id)
  }
  for (const id of ['big-pickle', 'mimo-v2.5-free', 'deepseek-v4-flash', '']) {
    assert.equal(isResponsesModel(id), false, id || '(empty)')
  }
})

test('ZenAdapter constructs the responses provider alongside chat', () => {
  const adapter = new ZenAdapter(new ModelCatalog())
  assert.equal(typeof adapter.stream, 'function')
})

test('responses models use the wider body-idle window, injectable for tests', async () => {
  // A provider that emits `start` immediately, then never speaks again: the
  // stream can only end through the body-idle watchdog, so the surfaced
  // error's arrival time measures the window actually applied per model.
  // keepAlive is REF'D (and cleared below) for the reason spelled out in
  // rotate.test.ts's muteProvider(): the adapter's deadline is unref'd, so a
  // fake parked on a bare promise drains the event loop and `node --test`
  // cancels the file before the watchdog can fire.
  let keepAlive: NodeJS.Timeout | undefined
  async function* hangAfterStart(): AsyncGenerator<{ type: string; partial: unknown }> {
    yield { type: 'start', partial: { content: [] } }
    await new Promise((resolve) => { keepAlive = setTimeout(resolve, 60_000) })
  }
  const measure = async (model: string) => {
    const adapter = new ZenAdapter(
      {
        list: () => [],
        decision: () => ({ allowed: true, source: 'test', known: true }),
        reasoningCapability: () => undefined,
      },
      { providerOverride: { streamSimple: () => hangAfterStart() }, firstEventMs: 50, bodyIdleMs: 50, responsesBodyIdleMs: 400 },
    )
    const began = Date.now()
    let reason: { kind: string } | undefined
    try {
      for await (const chunk of adapter.stream({ provider: 'oc2dsh', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
        if (chunk.type === 'finish') {
          reason = chunk.reason as { kind: string }
          break
        }
      }
    } finally {
      clearTimeout(keepAlive)
    }
    return { reason, elapsed: Date.now() - began }
  }
  try {
    const chat = await measure('big-pickle')
    assert.equal(chat.reason?.kind, 'error')
    assert.ok(chat.elapsed < 200, `chat should honor the injected 50ms window, took ${chat.elapsed}ms`)
    const responses = await measure('muse-spark-1.2-contributor-free')
    assert.equal(responses.reason?.kind, 'error')
    assert.ok(responses.elapsed > 350, `responses should honor the injected 400ms window, took ${responses.elapsed}ms`)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('ZenAdapter arms the first-event window the plugin config carries, not the 30s default', async () => {
  // Measure constructor injection with a silent provider. Production entry
  // wiring is covered separately in watchdog-config.test.ts.
  let keepAlive: NodeJS.Timeout | undefined
  async function* mute(): AsyncGenerator<{ type: string; partial: unknown }> {
    await new Promise((resolve) => { keepAlive = setTimeout(resolve, 60_000) })
  }
  const cfg = resolveConfig({ firstEventMs: Config({ firstEventMs: 300 }).firstEventMs })
  assert.equal(cfg.firstEventMs, 300, 'the configured window must reach resolveConfig')
  const adapter = new ZenAdapter(
    {
      list: () => [],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => undefined,
    },
    {
      providerOverride: { streamSimple: () => mute() },
      firstEventMs: cfg.firstEventMs,
      bodyIdleMs: cfg.bodyIdleMs,
      responsesBodyIdleMs: cfg.responsesBodyIdleMs,
    },
  )
  const began = Date.now()
  let reason: { kind: string; failure?: { message: string; code: string } } | undefined
  try {
    for await (const chunk of adapter.stream({ provider: 'oc2dsh', model: 'big-pickle', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
      if (chunk.type === 'finish') {
        reason = chunk.reason
        break
      }
    }
  } finally {
    clearTimeout(keepAlive)
  }
  const elapsed = Date.now() - began
  assert.equal(reason?.kind, 'error')
  // Verbatim watchdog message: the "timeout" keyword is load-bearing, it is
  // what classifyStreamFailure() reads to rotate the egress.
  assert.equal(reason?.failure?.message, WATCHDOG_FIRST_MESSAGE)
  assert.equal(reason?.failure?.code, 'TIMEOUT')
  assert.ok(elapsed > 200, `should honor the configured 300ms first-event window, took ${elapsed}ms`)
  assert.ok(elapsed < 1500, `must not fall back to the 30s default window, took ${elapsed}ms`)
})

test('Responses payloads use reasoning and remove unsupported none/off fields', () => {
  assert.deepEqual(
    normalizeResponsesPayload({ input: [], reasoning: { effort: 'none' }, reasoning_effort: 'none' }),
    { input: [] },
  )
  assert.deepEqual(
    normalizeResponsesPayload({ input: [], reasoning_effort: 'low' }),
    { input: [], reasoning: { effort: 'low' } },
  )
  assert.deepEqual(
    normalizeResponsesPayload({ input: [], reasoning: { summary: 'auto' } }, 'high'),
    { input: [], reasoning: { summary: 'auto', effort: 'high' } },
  )
})

test('Responses streams pass a valid reasoning option and sanitize the payload', async () => {
  let capturedOptions: { reasoning?: string; onPayload?: (payload: unknown) => unknown } | undefined
  const provider = {
    streamSimple: (_model: unknown, _context: unknown, options: { reasoning?: string; onPayload?: (payload: unknown) => unknown }) => {
      capturedOptions = options
      return (async function* () {
        yield { type: 'start' }
        yield { type: 'text_delta', delta: 'ok' }
        yield { type: 'done', message: { stopReason: 'stop', content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }
      })()
    },
  }
  const adapter = new ZenAdapter(
    {
      list: () => ['muse-spark-1.2-contributor-free'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => ({ reasoning: true, effortValues: ['minimal', 'low', 'high'] }),
    },
    { providerOverride: provider },
  )
  const stream = adapter.stream({
    provider: 'oc2dsh',
    model: 'muse-spark-1.2-contributor-free',
    messages: [],
    reasoningEffort: 'high',
  })
  for await (const _chunk of stream) void _chunk
  assert.equal(capturedOptions?.reasoning, 'high')
  const payload = capturedOptions?.onPayload?.({ input: [], reasoning: { effort: 'none' }, reasoning_effort: 'none' }) as Record<string, unknown>
  assert.deepEqual(payload.reasoning, { effort: 'high' })
  assert.equal(payload.reasoning_effort, undefined)
  assert.equal(payload.tool_choice, 'auto')
  assert.deepEqual((payload.tools as Array<{ name: string }>).map((tool) => tool.name), ['shell', 'read'])
})

test('the wire request carries the correlation headers the free-lane gate requires', async () => {
  let headers: Record<string, string> | undefined
  const provider = {
    streamSimple(_model: unknown, _context: unknown, options: { headers?: Record<string, string> }): AsyncIterable<{ type: string }> {
      headers = options.headers
      return (async function* () {
        yield { type: 'start' }
        yield { type: 'done', message: { stopReason: 'stop', content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }
      })()
    },
  }
  const adapter = new ZenAdapter(
    {
      list: () => ['big-pickle'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => undefined,
    },
    { providerOverride: provider },
  )
  for await (const chunk of adapter.stream({ provider: 'oc2dsh', model: 'big-pickle', messages: [] })) void chunk
  // The 2.1.4 recipe: a canonical ses_* id rides ALL FOUR session spellings,
  // `x-opencode-request` is absent, and `x-opencode-project` is the
  // prefix-less project id (`prj_*` 403s).
  for (const name of ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']) {
    assert.match(headers?.[name] ?? '', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, name + ' carries the canonical shape')
  }
  assert.equal(headers?.['x-opencode-request'], undefined, 'the 2.x wire carries no request header')
  assert.match(headers?.['x-opencode-project'] ?? '', /^(global|[0-9a-f]{40})$/, 'the client sends a prefix-less project id')
  assert.equal(headers?.['x-opencode-client'], 'cli')
  assert.match(headers?.['user-agent'] ?? '', /^opencode\/latest\/2\.1\.4\//)
})

test('the tool-name alias seam renames the wire `shell` back to the host `bash`', async () => {
  // The shipped recipe puts the 2.1.4 `shell` definition on the wire, so the
  // model CALLS `shell`; GATE_TOOL_ALIASES maps that back to DSH's `bash`
  // before the chunks leave the adapter, and the argument bridge (wired in
  // zen-adapter) rewrites the call's arguments to the host's declared shape.
  const provider = {
    streamSimple(_model: unknown, _context: unknown, _options: unknown): AsyncIterable<{ type: string }> {
      return (async function* () {
        yield { type: 'start' }
        yield { type: 'toolcall_start', contentIndex: 0, partial: { content: [{ type: 'toolCall', id: 'call_1', name: 'shell' }] } }
        yield { type: 'toolcall_delta', contentIndex: 0, delta: '{"command":"ls"}' }
        yield { type: 'toolcall_end', contentIndex: 0, toolCall: { id: 'call_1', name: 'shell', arguments: { command: 'ls' } } }
        yield { type: 'done', message: { stopReason: 'toolUse', content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } }
      })()
    },
  }
  const adapter = new ZenAdapter(
    {
      list: () => ['big-pickle'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => undefined,
    },
    { providerOverride: provider },
  )
  const names: string[] = []
  for await (const chunk of adapter.stream({ provider: 'oc2dsh', model: 'big-pickle', messages: [] })) {
    if (chunk.type === 'tool-call-delta' && chunk.name !== undefined) names.push(chunk.name)
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') names.push(chunk.block.name)
  }
  assert.ok(names.length > 0)
  assert.ok(names.every((name) => name === 'bash'), 'shell is renamed to the host bash: ' + JSON.stringify(names))
})

test('a retryable failure carries the next ladder rung as providerRetryAfterMs', async () => {
  // dsh-llm-retry waits failure.providerRetryAfterMs VERBATIM when it is ≤ the
  // policy ceiling (its exponential schedule is only the untagged fallback),
  // so the adapter's ladder — 5/8/10/15/20/30s, clamped at 30s — is what the
  // host actually sleeps between retries of one step.
  resetRetryDelays()
  const provider = {
    streamSimple(_model: unknown, _context: unknown, _options: unknown): AsyncIterable<{ type: string }> {
      return (async function* () {
        yield {
          type: 'error',
          error: {
            api: 'openai-completions',
            provider: 'oc2dsh',
            model: 'big-pickle',
            content: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            stopReason: 'error',
            errorMessage: 'HTTP 429 rate limited',
          },
        }
      })()
    },
  }
  const adapter = new ZenAdapter(
    {
      list: () => ['big-pickle'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => undefined,
    },
    { providerOverride: provider },
  )
  const finishOf = async (content: string) => {
    let finish: Extract<import('../src/adapter/events.ts').HarnessChunk, { type: 'finish' }> | undefined
    for await (const chunk of adapter.stream({ provider: 'oc2dsh', model: 'big-pickle', messages: [{ role: 'user', content: [{ type: 'text', text: content }] }] } as never)) {
      if (chunk.type === 'finish') finish = chunk
    }
    assert.ok(finish !== undefined, 'the stream must end with a finish chunk')
    return finish
  }
  const first = await finishOf('step request')
  assert.equal(first.reason.kind, 'error')
  if (first.reason.kind !== 'error') assert.fail('expected an error finish')
  assert.equal(first.reason.failure.code, 'RATE_LIMIT')
  assert.equal(first.reason.failure.providerRetryAfterMs, 5_000)

  // a host retry re-enters with the SAME step request: the ladder walks on
  const waits: Array<number | undefined> = [first.reason.failure.providerRetryAfterMs]
  for (let i = 0; i < 5; i += 1) {
    const retry = await finishOf('step request')
    if (retry.reason.kind !== 'error') assert.fail('expected an error finish')
    waits.push(retry.reason.failure.providerRetryAfterMs)
  }
  assert.deepEqual(waits, [5_000, 8_000, 10_000, 15_000, 20_000, 30_000])

  // the ceiling clamps, and the clamp must not exceed the host's give-up limit
  for (let i = 0; i < 2; i += 1) {
    const clamped = await finishOf('step request')
    if (clamped.reason.kind !== 'error') assert.fail('expected an error finish')
    assert.equal(clamped.reason.failure.providerRetryAfterMs, 30_000)
  }

  // a DIFFERENT step (different messages) starts its own ladder at the first rung
  const other = await finishOf('another step request')
  if (other.reason.kind !== 'error') assert.fail('expected an error finish')
  assert.equal(other.reason.failure.providerRetryAfterMs, 5_000)
})

test('a deterministic refusal stays untagged — the host must not wait on it', async () => {
  resetRetryDelays()
  const provider = {
    streamSimple(_model: unknown, _context: unknown, _options: unknown): AsyncIterable<{ type: string }> {
      return (async function* () {
        yield {
          type: 'error',
          error: {
            api: 'openai-completions',
            provider: 'oc2dsh',
            model: 'big-pickle',
            content: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            stopReason: 'error',
            errorMessage: 'OpenAI API error (403): {"type":"RegionError","message":"This model is not available in your country."}',
          },
        }
      })()
    },
  }
  const adapter = new ZenAdapter(
    {
      list: () => ['big-pickle'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => undefined,
    },
    { providerOverride: provider },
  )
  let finish: Extract<import('../src/adapter/events.ts').HarnessChunk, { type: 'finish' }> | undefined
  for await (const chunk of adapter.stream({ provider: 'oc2dsh', model: 'big-pickle', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)) {
    if (chunk.type === 'finish') finish = chunk
  }
  assert.ok(finish !== undefined)
  if (finish?.reason.kind !== 'error') assert.fail('expected an error finish')
  assert.equal(finish.reason.failure.code, 'REGION_BLOCKED')
  assert.equal(finish.reason.failure.providerRetryAfterMs, undefined, 'REGION_BLOCKED is not in retryableCodes — no wait, no retry')
})

/**
 * The origin ladder (adapter/lane.ts), from the adapter's side: the same
 * request bytes go to the second door only when the first one answers with an
 * ORIGIN-shaped failure, and that switch never spends an exit rotation.
 */
function laneProvider(outcomes: Array<'refuse' | 'limited' | 'answer'>, seen: string[]) {
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }
  const failure = (errorMessage: string) => ({
    type: 'error',
    error: { api: 'openai-completions', provider: 'oc2dsh', model: 'big-pickle', content: [], usage, stopReason: 'error', errorMessage },
  })
  return {
    streamSimple(model: { baseUrl: string }, _context: unknown, _options: unknown): AsyncIterable<unknown> {
      seen.push(model.baseUrl)
      const outcome = outcomes[seen.length - 1] ?? 'answer'
      return (async function* () {
        if (outcome === 'refuse') {
          yield failure('403: {"type":"error","error":{"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode."}}')
          return
        }
        if (outcome === 'limited') {
          yield failure('429: Too Many Requests')
          return
        }
        yield { type: 'start' }
        yield { type: 'text_start', contentIndex: 0, partial: { content: [] } }
        yield { type: 'text_delta', contentIndex: 0, delta: 'ok', partial: { content: [{ type: 'text', text: 'ok' }] } }
        yield { type: 'text_end', contentIndex: 0, content: 'ok', partial: { content: [{ type: 'text', text: 'ok' }] } }
        yield {
          type: 'done',
          message: { api: 'openai-completions', provider: 'oc2dsh', model: 'big-pickle', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage },
        }
      })()
    },
  }
}

async function laneStream(outcomes: Array<'refuse' | 'limited' | 'answer'>, seen: string[]) {
  const adapter = new ZenAdapter(
    {
      list: () => ['big-pickle'],
      decision: () => ({ allowed: true, source: 'test', known: true }),
      reasoningCapability: () => undefined,
    },
    { zenBaseUrl: 'https://primary.test', fallbackBaseUrl: 'https://fallback.test', providerOverride: laneProvider(outcomes, seen) },
  )
  const chunks: Array<{ type: string; reason?: { kind: string; failure?: { message?: string; code?: string } } }> = []
  for await (const chunk of adapter.stream({ provider: 'oc2dsh', model: 'big-pickle', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)) {
    chunks.push(chunk as never)
  }
  return chunks
}

test('an origin refusal is retried on the ladder\'s second rung, not on a new exit', async () => {
  const seen: string[] = []
  const chunks = await laneStream(['refuse', 'answer'], seen)
  assert.deepEqual(seen, ['https://primary.test/v1', 'https://fallback.test/v1'])
  assert.equal(chunks.some((chunk) => chunk.type === 'text-delta'), true, 'the fallback answer reached the host')
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  assert.equal(finish?.reason?.kind, 'stop')
})

test('a 429 is exit-shaped: it never buys a second origin', async () => {
  const seen: string[] = []
  const chunks = await laneStream(['limited'], seen)
  assert.deepEqual(seen, ['https://primary.test/v1'])
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  assert.equal(finish?.reason?.kind, 'error')
})

test('both doors refusing surfaces one error that names both', async () => {
  const seen: string[] = []
  const chunks = await laneStream(['refuse', 'refuse'], seen)
  assert.deepEqual(seen, ['https://primary.test/v1', 'https://fallback.test/v1'])
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  const message = finish?.reason?.failure?.message ?? ''
  assert.match(message, /两条来源均失败/)
  assert.match(message, /primary\.test -> fallback\.test/)
  // No exit rotation happened, so the story must not claim one.
  assert.equal(/轮换 \d+ 次/.test(message), false)
})
