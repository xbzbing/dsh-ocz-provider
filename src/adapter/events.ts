/**
 * pi-ai AssistantMessageEvent -> harness StreamChunks. Clean-room port of
 * dsh-llm-pi-ai toStreamChunks (verified against its source, index.js:1342-1452):
 * the chunk stream must end with `usage` then `finish`.
 *
 * Two inbound rewrites live here, both seams for the free-lane gate's spelling:
 *
 *  - `toolNameAlias`: wire tool names rewritten before the chunks
 *    leave the adapter. ON the shipped 2.1.4 recipe (adapter/messages.ts
 *    `GATE_TOOL_ALIASES`) it is `{ shell: 'bash' }`: the wire carries the
 *    official `shell` definition while DSH names the same capability `bash`,
 *    so the model's `shell` call arrives at the host as `bash`.
 *  - `toolArgumentBridge`: the wire carries the GENUINE gate definitions
 *    (adapter/gate-tools.ts), so the adapter maps the model's arguments back
 *    to the host's declared shape — the 2.1.4 wire's `path` ->
 *    the host's `file_path`, `timeout` -> `timeoutMs`, and the host's required
 *    `description` synthesized from the command. The bridge is keyed by the
 *    POST-alias (host) name, because the alias is applied first.
 *    A bridged call's argument deltas are withheld until
 *    `toolcall_end`, because the mapping is a whole-object rewrite while the
 *    deltas are JSON fragments; and the durable replay record joins the deltas
 *    (dsh-llm `expandAssistantStream`), so emitting raw deltas plus a corrected
 *    `block-end` would leave a resumed session showing arguments that never
 *    ran. Execution is correct either way: dsh-llm's BlockAssembler prefers the
 *    `block-end` block when one arrived (`assemble()` returns `partial.block`).
 */

import type { GateToolArgumentBridge } from './gate-tools.ts'

export type HarnessChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'block-end'; index: number; block: { type: 'text'; text: string } | { type: 'reasoning'; text: string; signature?: string } | { type: 'tool-call'; id: string; name: string; arguments: string } }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }

/**
 * The failure facts a terminal finish carries. `providerRetryAfterMs` is the
 * host-sanctioned provider wait (LlmFailure, dsh-llm types): when present and
 * ≤ the policy's maxDelayMs, dsh-llm-retry waits it VERBATIM instead of its
 * own exponential schedule — the seam retry-delay.ts's ladder rides on.
 */
export interface FailureFacts {
  message: string
  code: string
  providerRetryAfterMs?: number
}

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'max-tokens' }
  | { kind: 'tool-calls' }
  | { kind: 'aborted'; failure: FailureFacts }
  | { kind: 'error'; failure: FailureFacts }

/** pi-ai AssistantMessageEvent vocabulary (subset we consume). */
export type PiEvent =
  | { type: 'start'; partial: PiAssistantPartial }
  | { type: 'text_start'; contentIndex: number; partial: PiAssistantPartial }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: PiAssistantPartial }
  | { type: 'text_end'; contentIndex: number; content: string; partial: PiAssistantPartial }
  | { type: 'thinking_start'; contentIndex: number; partial: PiAssistantPartial }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: PiAssistantPartial }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: PiAssistantPartial }
  | { type: 'toolcall_start'; contentIndex: number; partial: PiAssistantPartial }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: PiAssistantPartial }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: { id: string; name: string; arguments: Record<string, unknown> }; partial: PiAssistantPartial }
  | { type: 'done'; message: PiDoneMessage }
  | { type: 'error'; error: PiDoneMessage }

export interface PiAssistantPartial {
  content: Array<{ type: string; id?: string; name?: string; [key: string]: unknown }>
  [key: string]: unknown
}

/** pi-ai AssistantMessage content block (done/error messages carry these). */
export type PiAssistantBlock = { type: string; [key: string]: unknown }

export interface PiDoneMessage {
  api: string
  provider: string
  model: string
  responseModel?: string
  responseId?: string
  content: PiAssistantBlock[]
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
  stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  errorMessage?: string
  [key: string]: unknown
}

const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'
const EMPTY_RESPONSE = 'EMPTY_RESPONSE'
const QUOTA_EXCEEDED = 'QUOTA_EXCEEDED'

function classifyError(text: string): string {
  // Zen uses HTTP 403 for regional availability too. AUTH makes DSH replace
  // the actual upstream message with "API key is invalid".
  if (/\bRegionError\b|not available in your country/i.test(text)) return 'REGION_BLOCKED'
  if (/\b(?:401|403)\b/.test(text)) return 'AUTH'
  if (/insufficient|quota|billing/i.test(text)) return QUOTA_EXCEEDED
  if (/\b429\b|rate.?limit/i.test(text)) return 'RATE_LIMIT'
  if (/\b413\b|payload too large|request body too large/i.test(text)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(text)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(text)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return 'TIMEOUT'
  // Port parity with dsh-llm-pi-ai classifyPiAiError (lib/index.js:1456): the
  // host maps pi-ai's "Stream ended without finish_reason" sentinel to
  // TRANSPORT, and without this line the bare message falls through to the
  // UPSTREAM fallback below, which is NOT in FREE_LANE_RETRY_POLICY.retryableCodes,
  // so dsh-llm-retry ends the turn instead of retrying a mid-stream cut.
  // Keep the host's own wording so the two stay in step.
  if (/stream ended (?:before|without)\b/i.test(text)) return 'TRANSPORT'
  // opencode2dsh #105: the same cut arrives under spellings the two regexes
  // above miss. `\bsocket\b` never matches inside "WebSocket" (no boundary in
  // the compound), `other side closed` is undici's SocketError
  // (node_modules/undici/lib/dispatcher/client-h1.js and client-h2.js — the
  // realistic cut through the exit pool), and `http2 request did not get a
  // response` is undici's h2 premature close. All transport, all retryable.
  if (/\bwebsocket\b|other side closed|http2 request did not get a response/i.test(text)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|terminated|premature close/i.test(text)) return 'TRANSPORT'
  return 'UPSTREAM'
}

/**
 * mapStopReason (dsh-llm-pi-ai index.js:1286-1330, minus the usage heuristic
 * upstream dropped in opencode2api #101, ported as opencode2dsh #101).
 *
 * A usage-based CONTEXT_WINDOW_EXCEEDED heuristic must NOT come back: the
 * request that reaches the wire carries 4-5k tokens more than the host
 * estimates its history at (system prompt + the gate's genuine tool
 * definitions + serialization), so a conversation filled to the declared
 * window arrives with `usage.input > contextWindow` on a HEALTHY finish, and
 * rewriting that answered turn as CONTEXT_WINDOW_EXCEEDED — a non-retryable
 * code — kills the whole turn. Only the provider's own overflow WORDING (an
 * error whose message says context + exceed/window/length/token) classifies
 * as such.
 */
function mapStopReason(message: PiDoneMessage): FinishReason {
  if (message.stopReason === 'error' && message.errorMessage !== undefined && /context/i.test(message.errorMessage) && /exceed|window|length|token/i.test(message.errorMessage)) {
    return {
      kind: 'error',
      failure: { message: message.errorMessage, code: CONTEXT_WINDOW_EXCEEDED },
    }
  }
  switch (message.stopReason) {
    case 'stop':
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: { message: `model "${message.model}" returned a completed response with no content`, code: EMPTY_RESPONSE },
        }
      }
      return { kind: 'stop' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'toolUse':
      return { kind: 'tool-calls' }
    case 'aborted':
      return { kind: 'aborted', failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' } }
    case 'error':
      return {
        kind: 'error',
        failure: { message: message.errorMessage ?? 'pi-ai stream error', code: classifyError(message.errorMessage ?? '') },
      }
  }
}

function mapUsage(usage: PiDoneMessage['usage']): Extract<HarnessChunk, { type: 'usage' }>['usage'] {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  }
}

/**
 * Translate one pi-ai event stream into harness chunks. pi-ai never throws
 * mid-stream: failures arrive as `error` events and become error/aborted
 * finish chunks.
 */
export async function* toStreamChunks(
  events: AsyncIterable<PiEvent>,
  toolNameAlias?: Record<string, string>,
  toolArgumentBridge?: GateToolArgumentBridge,
): AsyncGenerator<HarnessChunk> {
  const toolIds = new Map<number, { id: string; name: string }>()
  const mapName = (name: string): string => toolNameAlias?.[name] ?? name
  /** Raw argument fragments of a bridged call, held back until its end. */
  const withheld = new Map<number, string[]>()
  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end': {
        // opencode2dsh #97: pi-ai stamps the wire field the thinking arrived
        // on (`reasoning_content`) into the partial block's thinkingSignature;
        // carrying it back on the harness block is what lets the replay put
        // the reasoning text under that exact field (messages.ts toPiAssistant
        // -> pi-ai's openai-completions serializer). Absent -> bare block.
        const partial = event.partial.content[event.contentIndex]
        const signature = typeof partial?.thinkingSignature === 'string' && partial.thinkingSignature.length > 0 ? partial.thinkingSignature : undefined
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: { type: 'reasoning', text: event.content, ...(signature !== undefined ? { signature } : {}) },
        }
        break
      }
      case 'toolcall_start': {
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? (partial.id ?? '') : ''
        const name = partial?.type === 'toolCall' ? mapName(partial.name ?? '') : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        if (toolArgumentBridge?.names.has(known?.name ?? '')) {
          const parts = withheld.get(event.contentIndex) ?? []
          parts.push(event.delta)
          withheld.set(event.contentIndex, parts)
          break
        }
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: known?.id ?? '',
          ...(known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {}),
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end': {
        const name = mapName(event.toolCall.name)
        const rewritten = toolArgumentBridge?.rewrite(name, event.toolCall.arguments)
        const argumentsJson = JSON.stringify(rewritten ?? event.toolCall.arguments)
        const parts = withheld.get(event.contentIndex)
        if (parts !== undefined) {
          withheld.delete(event.contentIndex)
          if (rewritten !== undefined) {
            // One fragment: the durable record must carry the arguments that
            // actually reach the host, not the wire shape they arrived in.
            yield {
              type: 'tool-call-delta',
              index: event.contentIndex,
              id: event.toolCall.id,
              ...(name.length > 0 ? { name } : {}),
              argumentsDelta: argumentsJson,
            }
          } else {
            // Nothing to rewrite after all: replay the fragments exactly as
            // they streamed, so granularity is unchanged.
            for (const delta of parts) {
              yield {
                type: 'tool-call-delta',
                index: event.contentIndex,
                id: event.toolCall.id,
                ...(name.length > 0 ? { name } : {}),
                argumentsDelta: delta,
              }
            }
          }
        }
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: event.toolCall.id,
            name,
            arguments: argumentsJson,
          },
        }
        break
      }
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield { type: 'finish', reason: mapStopReason(event.message) }
        return
      case 'error':
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield { type: 'finish', reason: mapStopReason(event.error) }
        return
    }
  }
  throw new Error('opencode2dsh: pi-ai event stream ended without done/error')
}
