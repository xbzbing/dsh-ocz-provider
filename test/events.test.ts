import test from 'node:test'
import assert from 'node:assert/strict'
import { toStreamChunks, type HarnessChunk, type PiEvent } from '../src/adapter/events.ts'
import { FREE_LANE_RETRY_POLICY } from '../src/adapter/zen-adapter.ts'

const CONTEXT_WINDOW = 262144

function done(overrides: Partial<Parameters<typeof event>[0]> = {}): PiEvent {
  return event({ type: 'done', ...overrides })
}

function event(message: Record<string, unknown>): PiEvent {
  return {
    type: 'done',
    message: {
      api: 'openai-completions',
      provider: 'oc2dsh',
      model: 'qwen-free',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
      stopReason: 'stop',
      ...message,
    },
  } as unknown as PiEvent
}

async function collect(events: PiEvent[]): Promise<HarnessChunk[]> {
  const chunks: HarnessChunk[] = []
  for await (const chunk of toStreamChunks(
    (async function* () {
      for (const event of events) yield event
    })(),
  )) {
    chunks.push(chunk)
  }
  return chunks
}

type FinishChunk = Extract<HarnessChunk, { type: 'finish' }>

function expectFinish(chunk: HarnessChunk | undefined): FinishChunk {
  assert.equal(chunk?.type, 'finish')
  return chunk as FinishChunk
}

function failureOf(chunk: FinishChunk): { message: string; code: string } {
  if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') assert.fail('expected a failure reason')
  return chunk.reason.failure
}

test('text deltas flow through and the stream ends with usage then finish', async () => {
  const chunks = await collect([
    { type: 'start', partial: { content: [] } },
    { type: 'text_start', contentIndex: 0, partial: { content: [] } },
    { type: 'text_delta', contentIndex: 0, delta: 'hel', partial: { content: [] } },
    { type: 'text_delta', contentIndex: 0, delta: 'lo', partial: { content: [] } },
    { type: 'text_end', contentIndex: 0, content: 'hello', partial: { content: [] } },
    done({ usage: { input: 7, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 12 } }),
  ])
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(chunks[chunks.length - 1]?.type, 'finish')
  assert.equal(chunks[chunks.length - 2]?.type, 'usage', 'usage immediately precedes finish')
})

test('tool calls stream as tool-call blocks with stringified arguments', async () => {
  const partial = { content: [{ type: 'toolCall', id: 't1', name: 'shell' }] }
  const chunks = await collect([
    { type: 'toolcall_start', contentIndex: 0, partial },
    { type: 'toolcall_delta', contentIndex: 0, delta: '{"cm', partial },
    { type: 'toolcall_delta', contentIndex: 0, delta: 'd":"ls"}', partial },
    {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: 't1', name: 'shell', arguments: { cmd: 'ls' } },
      partial,
    },
    done({ content: [{ type: 'toolCall', id: 't1', name: 'shell', arguments: { cmd: 'ls' } }], stopReason: 'toolUse' }),
  ])
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'tool-call' })
  assert.deepEqual(chunks[1], { type: 'tool-call-delta', index: 0, id: 't1', name: 'shell', argumentsDelta: '{"cm' })
  assert.deepEqual(chunks[2], { type: 'tool-call-delta', index: 0, id: 't1', name: 'shell', argumentsDelta: 'd":"ls"}' })
  assert.deepEqual(chunks[3], {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 't1', name: 'shell', arguments: '{"cmd":"ls"}' },
  })
  assert.deepEqual(chunks[5], { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('thinking events map to reasoning blocks', async () => {
  const chunks = await collect([
    { type: 'thinking_start', contentIndex: 0, partial: { content: [] } },
    { type: 'thinking_delta', contentIndex: 0, delta: 'hmm', partial: { content: [] } },
    { type: 'thinking_end', contentIndex: 0, content: 'hmm', partial: { content: [] } },
    done(),
  ])
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'reasoning' })
  assert.deepEqual(chunks[1], { type: 'reasoning-delta', index: 0, text: 'hmm' })
  assert.deepEqual(chunks[2], { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hmm' } })
})

test('a streamed thinkingSignature rides back on the reasoning block (#97)', async () => {
  // pi-ai stamps the wire field the thinking arrived on into the partial
  // block; DeepSeek's thinking mode needs it back on replay (messages.ts
  // restores it as thinkingSignature so the text is sent as reasoning_content).
  const partial = { content: [{ type: 'thinking', thinking: 'hmm', thinkingSignature: 'reasoning_content' }] }
  const chunks = await collect([{ type: 'thinking_end', contentIndex: 0, content: 'hmm', partial }, done()])
  assert.deepEqual(chunks[0], {
    type: 'block-end',
    index: 0,
    block: { type: 'reasoning', text: 'hmm', signature: 'reasoning_content' },
  })
})

test('finish reasons: length, aborted, rate limit and other errors', async () => {
  const length = await collect([done({ stopReason: 'length' })])
  assert.deepEqual(length[1], { type: 'finish', reason: { kind: 'max-tokens' } })
  const aborted = await collect([event({ stopReason: 'aborted', errorMessage: 'user aborted' })])
  assert.deepEqual(aborted[1], {
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: 'user aborted', code: 'ABORTED' } },
  })
  const rate = await collect([event({ stopReason: 'error', errorMessage: 'HTTP 429 rate limited' })])
  assert.equal(failureOf(expectFinish(rate[1])).code, 'RATE_LIMIT')
  const server = await collect([event({ stopReason: 'error', errorMessage: 'HTTP 500 oops' })])
  assert.equal(failureOf(expectFinish(server[1])).code, 'SERVER')
})

test('a stream cut before its terminal chunk is TRANSPORT, never UPSTREAM', async () => {
  // pi-ai's openai-completions stream throws this exact message when the SSE
  // body ends without any chunk carrying choices[0].finish_reason. The host's
  // own classifier maps it to TRANSPORT (dsh-llm-pi-ai classifyPiAiError,
  // lib/index.js:1456) and so must this port: the UPSTREAM fallback is NOT in
  // FREE_LANE_RETRY_POLICY.retryableCodes, so a bare sentinel used to end the
  // turn instead of being retried (15 bare failures died, 0 recovered), while
  // the same cut on the host's own provider was retried and recovered.
  const messages = [
    'Stream ended without finish_reason',
    // Parity guard for the host's wording — not an observed pi-ai message.
    'Stream ended before any event arrived',
    // opencode2dsh #105: the same mid-stream cut under spellings \bsocket\b
    // misses. "WebSocket" has no inner word boundary, and undici's own cuts
    // arrive as "other side closed" (SocketError, client-h1.js/client-h2.js —
    // the realistic cut through the exit pool) or the h2 premature close.
    'WebSocket closed',
    'websocket stream closed before response.completed',
    'other side closed',
    'http2 request did not get a response',
  ]
  for (const message of messages) {
    const completed = event({ stopReason: 'error', errorMessage: message })
    assert.equal(completed.type, 'done')
    if (completed.type !== 'done') assert.fail('expected a done event')
    for (const upstream of [completed, { type: 'error', error: completed.message } as PiEvent]) {
      const failure = failureOf(expectFinish((await collect([upstream]))[1]))
      assert.deepEqual(failure, { message, code: 'TRANSPORT' })
      assert.ok(
        (FREE_LANE_RETRY_POLICY.retryableCodes as readonly string[]).includes(failure.code),
        `${failure.code} must be retryable, otherwise a mid-stream cut ends the turn`,
      )
    }
  }
})

test('zero-cache usage omits the optional keys', async () => {
  const chunks = await collect([done()])
  assert.deepEqual(chunks[0], { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } })
})

test('Muse regional 403 keeps its upstream explanation in both error event shapes', async () => {
  const message = 'OpenAI API error (403): {"type":"RegionError","message":"This model is not available in your country."}'
  const completed = event({ stopReason: 'error', errorMessage: message })
  assert.equal(completed.type, 'done')
  if (completed.type !== 'done') assert.fail('expected a done event')
  for (const upstream of [completed, { type: 'error', error: completed.message } as PiEvent]) {
    const chunks = await collect([upstream])
    assert.deepEqual(failureOf(expectFinish(chunks[1])), { message, code: 'REGION_BLOCKED' })
  }
})

test('authentication failures retain AUTH when the upstream does not report a region block', async () => {
  for (const status of [401, 403]) {
    const message = `OpenAI API error (${status}): {"error":{"code":"invalid_api_key","message":"Invalid API key"}}`
    const chunks = await collect([event({ stopReason: 'error', errorMessage: message })])
    assert.deepEqual(failureOf(expectFinish(chunks[1])), { message, code: 'AUTH' })
  }
})

test('an empty completed response is an EMPTY_RESPONSE error', async () => {
  const chunks = await collect([event({ content: [] })])
  const failure = failureOf(expectFinish(chunks[1]))
  assert.match(failure.message, /no content/)
  assert.equal(failure.code, 'EMPTY_RESPONSE')
})

test('a healthy finish over the declared window is NOT a context overflow (#101)', async () => {
  // The wire carries 4-5k tokens more than the host estimates its history at
  // (system prompt + the gate's genuine tool definitions + serialization), so
  // usage.input alone can exceed the declared window on a turn the upstream
  // already answered; the pre-fix heuristic rewrote exactly such turns into
  // CONTEXT_WINDOW_EXCEEDED, which is not retryable and killed the turn.
  const chunks = await collect([
    event({ usage: { input: CONTEXT_WINDOW * 4, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: CONTEXT_WINDOW * 4 } }),
  ])
  assert.deepEqual(expectFinish(chunks[1]).reason, { kind: 'stop' })
})

test('the provider\'s own overflow wording is still CONTEXT_WINDOW_EXCEEDED (#101)', async () => {
  const message = 'OpenAI API error (400): {"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 65536 tokens. However, your messages resulted in 71233 tokens."}}'
  const chunks = await collect([event({ stopReason: 'error', errorMessage: message })])
  assert.deepEqual(failureOf(expectFinish(chunks[1])), { message, code: 'CONTEXT_WINDOW_EXCEEDED' })
})

test('a stream that ends without done/error is a bug and throws', async () => {
  await assert.rejects(collect([{ type: 'start', partial: { content: [] } }]), /without done\/error/)
})
