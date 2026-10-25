import { createProvider, type Api, type Context, type Model } from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'
import * as openaiResponses from '@earendil-works/pi-ai/api/openai-responses'

import { ModelCatalog, ZEN_BASE_URL } from './catalog.ts'
import { toStreamChunks, type HarnessChunk, type PiDoneMessage, type PiEvent } from './events.ts'
import { conversationLabel, deriveRequestIDs, disguiseHeaders } from './ids.ts'
import { isOriginFailure, laneOrigins } from './lane.ts'
import { gateToolArgumentBridge } from './gate-tools.ts'
import { nextRetryDelayMs, retryDelayKey } from './retry-delay.ts'
import { ensureFreeLaneShape, ensureResponsesFreeLaneShape, GATE_TOOL_ALIASES, toPiContext, type HarnessGenerateOptions, type PiContext } from './messages.ts'
import { apiForModel, isResponsesModel } from './routing.ts'
export { apiForModel, isResponsesModel } from './routing.ts'
import { routingContext, type RoutingContext } from '../pool/dispatcher.ts'
import { classifyStreamFailure, isIpReputationRefusal, isRegionBlocked, shouldRotate } from '../pool/rotate.ts'
import { attributeUsage, LOCAL_EXIT_ID } from '../pool/usage.ts'
import { EGRESS_HEADER, hasRelayEgress, pickRelayEgress, settleRelayEgress, statusOfFailure, type RelayEgressPick } from '../relay/egress.ts'
import type { RelaySupervisor } from '../relay/supervisor.ts'

/**
 * The TS adapter: registers as a DSH LlmAdapter for the `oc2dsh` route
 * and streams directly from the OpenCode Zen anonymous lane. The wire layer is
 * pi-ai's openai-completions implementation for most models (the same one DSH
 * uses for every OpenAI-compatible provider), plus pi-ai's openai-responses
 * for Responses-only models (muse-spark-*); this module adds the CLI disguise
 * headers, the derived session/request ids, and the free-model catalog.
 *
 * Adapter contract: dsh-llm LlmAdapter (providerInfo/listModels/resolveModel/
 * prepareCall/stream) — structural, no host import.
 */

export const PROVIDER_ID = 'oc2dsh'

/**
 * The provider's DISPLAY name — the model picker's group label. Deliberately
 * separate from the route id above: the id keys llm-pi-ai settings, adapter
 * registration and the request header, and renaming it would split every
 * existing session's model selection; the label is free to move.
 */
export const PROVIDER_NAME = 'OpenCode-Zen-Free'

export interface ZenModelInfo {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

export interface CatalogLike {
  list(): string[]
  decision(model: string): { allowed: boolean; source: string; known: boolean }
  /**
   * Optional: bounded wait for the first live fetch (issue #45). listModels
   * awaits it so the host's registration-time snapshot is the live roster,
   * never the bootstrap list. Catalogs without it answer immediately from
   * whatever they have.
   */
  warm?(ms?: number): Promise<void>
  reasoningCapability(model: string): { reasoning: boolean; effortValues: string[] } | undefined
  /** Optional: models.dev-declared limits; absent catalogs keep the defaults. */
  limits?(model: string): { contextWindow?: number; maxOutput?: number } | undefined
  /** Optional: models.dev `modalities.input`, the input kinds the model
   *  accepts (["text","image","video",…]). Absent catalogs keep the built-in
   *  vision pattern. */
  modalities?(model: string): string[] | undefined
}

const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768

/** The advertised context window: the models.dev declaration when the
 * metadata speaks, the host default otherwise (pending/absent metadata or a
 * model that declares no `limit.context`). */
function contextWindowFor(limits: { contextWindow?: number } | undefined): number {
  const declared = limits?.contextWindow
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0
    ? declared
    : DEFAULT_CONTEXT_WINDOW
}

/**
 * Use the declared output budget, including models that can answer beyond
 * 32768 tokens. Keep the fallback when metadata cannot provide a valid cap.
 */
function defaultMaxTokensFor(limits: { maxOutput?: number } | undefined): number {
  const declared = limits?.maxOutput
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0
    ? declared
    : DEFAULT_MAX_TOKENS
}

/**
 * Reasoning-effort vocabulary the adapter owns end to end (dsh-llm treats the
 * ids as opaque: whatever resolveModel advertises comes back on
 * GenerateOptions.reasoningEffort). The ladder mirrors pi-ai's ThinkingLevel
 * so selected levels pass through untouched; `off` is the only id that maps
 * to a different wire spelling.
 */
export const REASONING_EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Levels offered for reasoning models whose metadata declares no ladder. */
const DEFAULT_EFFORT_LADDER: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high']

/** Selectable reasoning effort as dsh-llm's resolveModel contract describes it. */
export interface ZenReasoningEffort {
  id: string
  name: string
  description?: string
}

/**
 * Turn the catalog's models.dev capability into the advertised effort list.
 * A declared ladder (models.dev `reasoning_options` effort values) wins — its
 * values are the upstream-honored spellings, with metadata `none` folded into
 * our `off`. Without a declaration, a reasoning model gets the standard
 * ladder the Zen gateway accepts for every model. Non-reasoning models
 * advertise nothing (the picker then offers only the provider default).
 */
export function reasoningEfforts(capability: { reasoning: boolean; effortValues: string[] } | undefined): ZenReasoningEffort[] | undefined {
  if (!capability?.reasoning) return undefined
  const declared: string[] = []
  for (const value of capability.effortValues) {
    const level = value === 'none' ? 'off' : value
    if ((REASONING_EFFORT_LADDER as readonly string[]).includes(level) && !declared.includes(level)) declared.push(level)
  }
  const levels = declared.length > 0
    ? declared.sort(
        (a, b) =>
          (REASONING_EFFORT_LADDER as readonly string[]).indexOf(a) -
          (REASONING_EFFORT_LADDER as readonly string[]).indexOf(b),
      )
    : DEFAULT_EFFORT_LADDER
  return levels.map((level) => ({ id: level, name: `${level.charAt(0).toUpperCase()}${level.slice(1)}` }))
}

/**
 * The `reasoning_effort` wire value for a selected effort id. The Zen gateway
 * validates the field against `minimal|low|medium|high|xhigh|max|none`
 * (live-probed 2026-09-18: any other value is a hard 400), and `none` is the
 * only spelling that stops the always-think free models from thinking — a
 * mere omission keeps the provider default. So `off` maps to wire `none`,
 * ladder levels pass through verbatim, and unknown ids (never advertised)
 * inject nothing rather than risk the 400.
 */
export function reasoningEffortWire(id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  if (id === 'off') return 'none'
  return (REASONING_EFFORT_LADDER as readonly string[]).includes(id) ? id : undefined
}

/** Anonymous credential: the literal upstream accepts for the free lane. */
const ANONYMOUS_KEY = 'public'

/**
 * Retry policy the host (dsh-llm-retry) runs for this provider. Resolved
 * shape is FLAT (backoff fields at top level — see ResolvedNormalRetryPolicy,
 * dsh-llm index.js:1867 consumes the adapter value verbatim). Retryable codes
 * mirror the host default set so behavior differs only in patience, not in
 * which failures qualify. Every transport cut the adapter can name rides this
 * window — including pi-ai's "Stream ended without finish_reason" truncation
 * sentinel, which adapter/events.ts classifyError maps to TRANSPORT precisely
 * so a mid-stream cut cannot escape the retry budget.
 *
 * The WAIT between retries is not this policy's exponential schedule: stream()
 * tags every retryable failure with retry-delay.ts's ladder through
 * `failure.providerRetryAfterMs`, and dsh-llm-retry waits that value VERBATIM
 * (5/8/10/15/20/30s, then 30s for rungs 7-10 — cumulative worst case per step
 * ≈ 208s of silent waiting). initialDelayMs/maxDelayMs/jitterRatio stay as the
 * fallback for an untagged failure, and maxDelayMs doubles as the ladder
 * ceiling: a providerRetryAfterMs ABOVE it makes normal mode give up without
 * retrying (dsh-llm-retry recover()), so every rung must stay ≤ 30s — pinned
 * by test/retry-delay.test.ts.
 */
export const FREE_LANE_RETRY_POLICY = Object.freeze({
  mode: 'normal' as const,
  maxRetries: 10,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 5_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
})

type FinishChunk = Extract<HarnessChunk, { type: 'finish' }>

/**
 * Tag a retryable failure with the next ladder rung (retry-delay.ts): the
 * host waits it verbatim in place of its exponential schedule and still counts
 * it against maxRetries as usual. The key is the step request itself, so a
 * host retry of the same step walks the ladder and a fresh step starts over —
 * mirroring the host's projection, which resets on step/start. Untagged paths:
 * non-retryable codes (the host never waits on them anyway) and the thinking
 * recovery, whose max-tokens finish is not an error.
 */
function withRetryDelay(finish: FinishChunk, options: HarnessGenerateOptions): FinishChunk {
  const reason = finish.reason
  if (reason.kind !== 'error') return finish
  if (!(FREE_LANE_RETRY_POLICY.retryableCodes as readonly string[]).includes(reason.failure.code)) return finish
  const providerRetryAfterMs = nextRetryDelayMs(retryDelayKey(options.model, options.messages))
  return { ...finish, reason: { ...reason, failure: { ...reason.failure, providerRetryAfterMs } } }
}

/**
 * Stream-liveness watchdogs (live-observed 2026-09-07): neither fetch nor
 * pi-ai owns a body-silence timeout, so a tunnel that stands but never
 * streams hangs the turn forever (70 minutes observed). Both messages
 * carry "timeout" so classifyStreamFailure maps them to 'transport' and
 * the rotate loop gets to move the session to a live exit.
 */
export const WATCHDOG_FIRST_MESSAGE = 'oc2dsh: first stream event timeout (exit silent before any response)'
export const WATCHDOG_IDLE_MESSAGE = 'oc2dsh: stream body idle timeout (exit went silent mid-response)'

/** Default watchdog windows (docs/ip-pool.md; test-injectable via constructor). */
export const DEFAULT_FIRST_EVENT_MS = 30_000
export const DEFAULT_BODY_IDLE_MS = 120_000
/**
 * Body-idle window for Responses models (muse-spark-*, issue #7): their
 * chain-of-thought streams pace in bursts with long mid-stream pauses, so
 * the chat default misreads slow reasoning as a dead tunnel. Named and
 * constructor-injectable so tests can exercise the wider window without
 * waiting out five real minutes.
 */
export const RESPONSES_BODY_IDLE_MS = 300_000

/** The terminal error event pi-ai owes but never sent (watchdog teardown). */
function terminalErrorEvent(errorMessage: string, model: Model<Api>): PiEvent {
  return {
    type: 'error',
    error: {
      api: model.api ?? 'openai-completions',
      provider: PROVIDER_ID,
      model: model.id,
      content: [],
      stopReason: 'error',
      errorMessage,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    },
  }
}

/** A stream that carries one terminal error and nothing else (dispatch refusal). */
function failedStream(message: string, model: Model<Api>): AsyncIterable<PiEvent> {
  return (async function* (): AsyncGenerator<PiEvent> {
    yield terminalErrorEvent(message, model)
  })()
}

/**
 * What one attempt was sent through — the pieces the rotate loop needs to
 * grade the connection it used, on top of the events pi-ai emits.
 */
interface AttemptMeta {
  /** The pool exit that carried the request (relay traffic only). */
  egress: RelayEgressPick | null
  /** True when the request was addressed to the Bun relay. */
  viaRelay: boolean
  /** Non-null = the pool refused to carry it and local egress is off. */
  fail: string | null
}

/**
 * Responses-only models (issue #7): `muse-spark-*` return a bare 500 on
 * `POST /inference/v1/chat/completions` but 200 on
 * `POST /inference/v1/responses` (opencode #44659/#44847, DSH #3957). Route by
 * model id; extend this list if the lane moves more models (candidates:
 * gpt-5.6-luna, grok-4.6).
 *
 * The gate covers BOTH surfaces: since 2026-10-14 the chat lane validates the
 * request's content (adapter/gate-tools.ts, adapter/messages.ts) and the whole
 * lane lives at `/inference/v1` — the old `/zen/v1` answers 403 for every
 * shape, so it is no longer "the lane of record" for anything.
 */


/**
 * Vision gate: whether a model accepts image input on the Zen lane.
 *
 * models.dev `modalities.input` decides whenever it speaks — the same
 * declaration that already drives `limit.context` / `limit.output` lists the
 * input kinds each model takes, and the free roster rotates constantly, so a
 * family-scoped pattern cannot track it: space-bunny-free,
 * muse-spark-1.*-contributor-free, mimo-v2.5-free, fledge-alpha-free and
 * longcat-2.5-preview-free all declare `image` upstream and are refused today
 * with `Model "<id>" does not support image input.` A declared text-only model
 * stays refused, so the gate still protects the lane in both directions.
 *
 * The built-in pattern remains the fallback for the ids whose image input was
 * live-verified end-to-end on 2026-09-28 (the mimo-v2.6 family), so metadata
 * being pending, absent or silent never changes what those models can do.
 * Models that end up text-only make DSH's attachment gates and pi-ai's image
 * downgrade refuse image parts instead of forwarding them to a model that
 * cannot see them.
 */
export function isVisionModel(id: string, declaredModalities?: string[]): boolean {
  if (Array.isArray(declaredModalities) && declaredModalities.length > 0) {
    return declaredModalities.includes('image')
  }
  return /^mimo-v2\.6/i.test(String(id ?? ''))
}

/** The pi-ai model literal for one catalog entry (exported for shape tests). */
export function toPiModel(
  id: string,
  reasoning: boolean,
  limits?: { contextWindow?: number; maxOutput?: number },
  declaredModalities?: string[],
  baseUrl: string = ZEN_BASE_URL,
): Model<Api> {
  return {
    id,
    name: id,
    api: apiForModel(id),
    provider: PROVIDER_ID,
    baseUrl: `${baseUrl.replace(/\/+$/, '')}/v1`,
    // The honest capability flag: gates pi-ai's reasoning_effort branch and
    // keeps developer-role replay suppressed (the Zen lane's compat detects
    // supportsDeveloperRole=false for opencode.ai, so the system slot is
    // unchanged either way). `image` (see isVisionModel) keeps pi-ai's
    // downgradeUnsupportedImages from dropping the image parts toPiContext
    // loads from the attachment store (the Zen gateway accepts image_url
    // data URLs, live-probed 2026-09-23; full round-trip through
    // DSH 0.1.7-rc.2 with mimo-v2.6-flash-free 2026-09-28).
    reasoning,
    // opencode2dsh #97: DeepSeek's thinking mode rejects any replayed
    // assistant turn without a reasoning_content field ("The reasoning_content
    // in the thinking mode must be passed back to the API"), and pi-ai only
    // auto-detects that requirement for provider 'deepseek' / a deepseek.com
    // baseUrl — neither matches this lane. The flag makes pi-ai emit an empty
    // reasoning_content for replayed turns that carried no thinking; turns
    // that DID think carry their text under the streamed field via the
    // signature on the reasoning block (events.ts -> messages.ts).
    compat: { requiresReasoningContentOnAssistantMessages: true },
    input: isVisionModel(id, declaredModalities) ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextWindowFor(limits),
    maxTokens: defaultMaxTokensFor(limits),
  }
}

function normalizeResponsesEffort(value: string | undefined): string | undefined {
  if (!value || value === 'off' || value === 'none') return undefined
  return (REASONING_EFFORT_LADDER as readonly string[]).includes(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize pi-ai's mixed reasoning shapes before a Responses request. */
export function normalizeResponsesPayload(payload: unknown, requestedEffort?: string): unknown | undefined {
  const shaped = ensureFreeLaneShape(payload)
  const base = shaped ?? payload
  if (!isRecord(base)) return shaped

  const next = { ...base }
  const legacyEffort = typeof next.reasoning_effort === 'string' ? next.reasoning_effort : undefined
  delete next.reasoning_effort

  const reasoning = isRecord(next.reasoning) ? { ...next.reasoning } : {}
  const existingEffort = normalizeResponsesEffort(typeof reasoning.effort === 'string' ? reasoning.effort : undefined)
  const effort = normalizeResponsesEffort(requestedEffort) ?? existingEffort ?? normalizeResponsesEffort(legacyEffort)
  if (effort) reasoning.effort = effort
  else delete reasoning.effort

  if (Object.keys(reasoning).length > 0) next.reasoning = reasoning
  else delete next.reasoning
  return next
}

export class ZenAdapter {
  readonly #catalog: CatalogLike
  readonly #provider: { streamSimple(model: unknown, context: unknown, options: unknown): unknown }
  readonly #responsesProvider: { streamSimple(model: unknown, context: unknown, options: unknown): unknown } | null
  readonly #firstEventMs: number
  readonly #bodyIdleMs: number
  readonly #responsesBodyIdleMs: number
  /** The lane's origin ladder, primary first (adapter/lane.ts). */
  readonly #origins: string[]
  /**
   * The Bun relay (relay/supervisor.ts), when one is running or expected.
   * Read PER REQUEST (`baseUrlFor`), because the relay can restart onto a
   * different port mid-session; null = no relay configured, requests go direct.
   */
  readonly #relay: Pick<RelaySupervisor, 'baseUrlFor' | 'warm'> | null

  constructor(catalog: CatalogLike, options: {
    zenBaseUrl?: string
    /** Second origin rung; defaults to the lane ladder for a known origin. */
    fallbackBaseUrl?: string
    providerOverride?: unknown
    /** Watchdog windows (tests inject short ones; defaults are live-tuned). */
    firstEventMs?: number
    bodyIdleMs?: number
    /** Overrides RESPONSES_BODY_IDLE_MS (watchdog tests inject short ones). */
    responsesBodyIdleMs?: number
    /**
     * The upstream relay. Its presence is what makes a request pass the free
     * lane's connection-stack gate: a Node-side fetch is answered 429 no
     * matter what the payload says (relay/supervisor.ts has the measurements).
     */
    relay?: Pick<RelaySupervisor, 'baseUrlFor' | 'warm'> | null
  } = {}) {
    this.#catalog = catalog
    this.#relay = options.relay ?? null
    this.#firstEventMs = options.firstEventMs ?? DEFAULT_FIRST_EVENT_MS
    this.#bodyIdleMs = options.bodyIdleMs ?? DEFAULT_BODY_IDLE_MS
    this.#responsesBodyIdleMs = options.responsesBodyIdleMs ?? RESPONSES_BODY_IDLE_MS
    this.#origins = laneOrigins(options.zenBaseUrl ?? ZEN_BASE_URL, options.fallbackBaseUrl)
    if (options.providerOverride !== undefined) {
      this.#provider = options.providerOverride as never
      this.#responsesProvider = null
      return
    }
    const baseUrl = `${this.#origins[0] ?? ZEN_BASE_URL}/v1`
    const auth = {
      apiKey: {
        name: 'OpenCode Zen anonymous lane',
        resolve: async () => ({ auth: { apiKey: ANONYMOUS_KEY } }),
      },
    }
    this.#provider = createProvider<Api>({
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      baseUrl,
      auth,
      models: [],
      api: openaiCompletions,
    })
    this.#responsesProvider = createProvider<Api>({
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      baseUrl,
      auth,
      models: [],
      api: openaiResponses,
    })
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: PROVIDER_NAME }
  }

  /**
   * Provider-owned retry policy (dsh-llm calls this unconditionally at
   * registration, index.js:1208). The anonymous free lane 429s in bursts —
   * live-probed 2026-10-09 (issue #51): 5/8 immediate failures on
   * step-5-preview-free, with contention windows that outlast the host
   * default (5 retries over ~15s), so transient throttling surfaced as
   * user-visible errors. This policy stretches the silent absorption window
   * to ~208s per step (10 retries; waits come from the 5s/8s/10s/15s/20s/30s
   * ladder in retry-delay.ts, tagged per failure as providerRetryAfterMs;
   * the exponential backoff below is only the untagged fallback). Retryable
   * codes mirror the host default set; deterministic failures (AUTH,
   * REGION_BLOCKED, INVALID_REQUEST) stay non-retryable.
   */
  providerRetryPolicy(_provider: string): typeof FREE_LANE_RETRY_POLICY {
    return FREE_LANE_RETRY_POLICY
  }

  /** No image pricing for the free Zen lane. */
  imageRequestPricing(_provider: string, _model: string): undefined {
    return undefined
  }

  /** The input kinds DSH is told about for one model (isVisionModel). */
  #inputModalities(model: string): string[] {
    return isVisionModel(model, this.#catalog.modalities?.(model)) ? ['text', 'image'] : ['text']
  }

  /**
   * Advisory catalog for the DSH model picker (deduped; dsh-llm rejects
   * duplicates). Async on purpose (issue #45): the host awaits this call and
   * caches its answer per host generation, so the first read waits —
   * bounded, inside the catalog — for the live Zen fetch instead of handing
   * the host the staticFreeModels bootstrap list it would then keep showing.
   */
  async listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string; inputModalities: string[] }>> {
    // The host calls this at registration, so it is the earliest honest moment
    // to bring the relay up: by the first turn it is listening and no request
    // has to take the direct (429) path (relay/supervisor.ts warm()).
    this.#relay?.warm()
    await this.#catalog.warm?.()
    const seen = new Set<string>()
    const models: Array<{ provider: string; id: string; name: string; inputModalities: string[] }> = []
    for (const id of this.#catalog.list()) {
      if (seen.has(id)) continue
      seen.add(id)
      models.push({ provider, id, name: id, inputModalities: this.#inputModalities(id) })
    }
    return models
  }

  resolveModel(provider: string, model: string): {
    provider: string
    id: string
    name: string
    inputModalities: string[]
    context: { contextWindow: number }
    defaultMaxTokens: number
    reasoning?: { efforts: ZenReasoningEffort[] }
  } {
    const resolved: ReturnType<ZenAdapter['resolveModel']> = {
      provider,
      id: model,
      name: model,
      inputModalities: this.#inputModalities(model),
      context: { contextWindow: contextWindowFor(this.#catalog.limits?.(model)) },
      defaultMaxTokens: defaultMaxTokensFor(this.#catalog.limits?.(model)),
    }
    // The thinking-level picker: dsh-llm validates every selected id against
    // this list and echoes the choice back on GenerateOptions.reasoningEffort.
    const declaredEfforts = reasoningEfforts(this.#catalog.reasoningCapability(model))
    const efforts = isResponsesModel(model) ? declaredEfforts?.filter((effort) => effort.id !== 'off') : declaredEfforts
    if (efforts) resolved.reasoning = { efforts }
    return resolved
  }

  async prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<{
    model: ReturnType<ZenAdapter['resolveModel']>
    stream: (options: HarnessGenerateOptions) => AsyncGenerator<HarnessChunk>
  }> {
    // Second warm-up seam: hosts that never list models before a turn still
    // get the relay brought up one call ahead of the request.
    this.#relay?.warm()
    return {
      model: this.resolveModel(provider, model),
      stream: (options) => this.stream(options),
    }
  }

  /**
   * Recover once from a reasoning-only output limit on models that offer Off.
   * Keep the first attempt's reasoning visible, but withhold its terminal
   * chunks until recovery finishes. Answer/tool events forbid replay; retry
   * blocks get fresh indices and the final usage includes both requests.
   */
  async *stream(options: HarnessGenerateOptions): AsyncGenerator<HarnessChunk> {
    const selectedEffort = options.reasoningEffort ?? options.reasoning
    const canDisableThinking = selectedEffort !== 'off' && selectedEffort !== 'none'
      && this.resolveModel(options.provider, options.model).reasoning?.efforts.some((effort) => effort.id === 'off') === true
    let request = options
    let indexOffset = 0
    let nextIndex = 0
    let priorUsage: Extract<HarnessChunk, { type: 'usage' }>['usage'] | undefined

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let sawReasoning = false
      let sawAnswerOrTool = false
      let usage: Extract<HarnessChunk, { type: 'usage' }> | undefined
      let finish: Extract<HarnessChunk, { type: 'finish' }> | undefined

      for await (const chunk of this.#streamAttempt(request, (message) => {
        for (const block of message.content) {
          if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) sawReasoning = true
          if (block.type !== 'thinking' && (block.type !== 'text' || (typeof block.text === 'string' && block.text.length > 0))) sawAnswerOrTool = true
        }
      })) {
        if (chunk.type === 'usage') {
          usage = chunk
          continue
        }
        if (chunk.type === 'finish') {
          finish = chunk
          continue
        }
        if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) sawReasoning = true
        if (chunk.type === 'text-delta' && chunk.text.length > 0) sawAnswerOrTool = true
        if ((chunk.type === 'block-start' && chunk.blockType === 'tool-call') || chunk.type === 'tool-call-delta') sawAnswerOrTool = true
        if (chunk.type === 'block-end') {
          if (chunk.block.type === 'reasoning' && chunk.block.text.length > 0) sawReasoning = true
          if (chunk.block.type === 'tool-call' || (chunk.block.type === 'text' && chunk.block.text.length > 0)) sawAnswerOrTool = true
        }
        if (typeof chunk.index === 'number') nextIndex = Math.max(nextIndex, chunk.index + indexOffset + 1)
        yield indexOffset === 0 ? chunk : { ...chunk, index: chunk.index + indexOffset }
      }

      const recover = attempt === 0 && canDisableThinking && sawReasoning && !sawAnswerOrTool
        && finish?.reason.kind === 'max-tokens' && !options.signal?.aborted
      if (recover) {
        priorUsage = usage?.usage
        indexOffset = nextIndex
        request = { ...options, reasoningEffort: 'off', reasoning: 'off' }
        continue
      }
      if (usage || priorUsage) {
        const current = usage?.usage
        const cacheReadTokens = (priorUsage?.cacheReadTokens ?? 0) + (current?.cacheReadTokens ?? 0)
        const cacheWriteTokens = (priorUsage?.cacheWriteTokens ?? 0) + (current?.cacheWriteTokens ?? 0)
        yield priorUsage === undefined ? usage! : {
          type: 'usage',
          usage: {
            inputTokens: priorUsage.inputTokens + (current?.inputTokens ?? 0),
            outputTokens: priorUsage.outputTokens + (current?.outputTokens ?? 0),
            ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
          },
        }
      }
      if (finish) yield withRetryDelay(finish, options)
      return
    }
  }

  /** Stream one attempt from the Zen anonymous lane.
   *
   * IP-7 rotate loop (docs/ip-pool.md §3.4 / §8.1): a stream that dies
   * BEFORE any content landed restarts on a fresh exit — the pool's health
   * marks already degraded the failed exit, so the restarted pick routes
   * elsewhere, and the host's retry budget never sees the intermediate
   * error. Once ANY content event has flowed, rotation stops (§3.4: a
   * partially delivered stream is never replayed). No pool running (or the
   * failure is not exit-shaped) = the original stream surface untouched.
   */
  async *#streamAttempt(options: HarnessGenerateOptions, onTerminal?: (message: PiDoneMessage) => void): AsyncGenerator<HarnessChunk> {
    const context = await toPiContext(options)
    const ids = deriveRequestIDs(options.messages)
    // The gate demands the GENUINE `bash`/`read` definitions on the wire, so
    // the host's own definitions for those two names are replaced by
    // ensureFreeLaneShape/ensureResponsesFreeLaneShape (messages.ts). The
    // model is therefore told what the WIRE schema declares (`filePath`,
    // `timeout`) while the host validates its own (`file_path`, `timeoutMs`):
    // this bridge maps a finished call back before the chunks leave the
    // adapter. It is derived from the host's declared tool schemas, so a host
    // that renames a field still pairs, and a call whose shape already matches
    // is passed through untouched.
    const argumentBridge = gateToolArgumentBridge(context.tools)
    const model = toPiModel(
      options.model,
      this.#catalog.reasoningCapability(options.model)?.reasoning === true,
      this.#catalog.limits?.(options.model),
      this.#catalog.modalities?.(options.model),
      this.#origins[0] ?? ZEN_BASE_URL,
    )
    // IP-pool routing context (docs/ip-pool.md 3.3): pi-ai builds the request
    // body and dispatches it on separate layers with no channel for "which
    // model is this fetch for", so the per-request context rides AsyncLocalStorage.
    // The ledger's session key prefers the HOST's session id (GenerateOptions
    // carries it since DSH 0.2): that is the id the workspace registry can map
    // back to a project, while our digest id is conversation-derived and known
    // only to us. The stickiness key stays `ids.session` — changing it would
    // change routing behaviour, which is not what this accounting is for.
    const hostSession = typeof options.sessionId === 'string' ? options.sessionId : ''
    const contextStore: RoutingContext = {
      model: options.model,
      session: ids.session,
      usageSession: hostSession !== '' ? hostSession : ids.session,
      usageLabel: conversationLabel(options.messages),
    }
    const MAX_ROTATES = 3
    // Watchdog windows (live-observed 2026-09-07): the OpenAI SDK timeout
    // only covers time-to-response-headers — once headers arrive it clears
    // its timer and NOTHING on any layer owns body silence. FIRST_EVENT: no
    // pi-ai event at all (not even `start`, which only arrives after
    // response headers). BODY_IDLE: content flowing, then a long gap (LLM
    // streams may pace slowly, but minutes of nothing mid-stream is a dead
    // tunnel, not pacing). The race fires the watchdog INTO the pending
    // next() — a background return() could never cancel one (it queues
    // behind the pending request), so timeout-promise racing is the only
    // mechanism that actually interrupts a hung stream.
    const firstEventMs = this.#firstEventMs
    // Responses models (muse-spark-*) get RESPONSES_BODY_IDLE_MS (see the
    // constant); chat models keep the live-tuned default. Derived from
    // model.api — the same routing flag that picked the provider — so the
    // watchdog and the wire layer can never disagree.
    const bodyIdleMs = model.api === 'openai-responses'
      ? Math.max(this.#bodyIdleMs, this.#responsesBodyIdleMs)
      : this.#bodyIdleMs
    const rotateStory: string[] = []
    // The origin ladder (adapter/lane.ts): the same request bytes are sent to
    // the next origin when the current one answers with an ORIGIN-shaped
    // failure — a gate refusal (401/403/404) or an edge 5xx. That switch costs
    // one round trip and does NOT spend a pool rotation: a refusing origin is
    // not a bad exit, and on 2026-10-19 both origins served the identical
    // recipe, so the second door is a real second chance rather than a retry.
    const origins = this.#origins
    const originLabel = (origin: string): string => origin.replace(/^https?:\/\//, '')
    let attempt = 0
    let originIndex = 0
    /** EXIT rotations actually spent — the origin switches above are not ones. */
    let rotations = 0
    for (;;) {
      const origin = origins[originIndex] ?? origins[0] ?? ZEN_BASE_URL
      const attemptStart = routingContext.run(contextStore, () =>
        this.#eventsFor(options, context, ids, model, origin),
      ) as { stream: unknown; meta: AttemptMeta }
      // A relayed request carries its own exit: stamp it so the usage ledger
      // attributes the response to that exit (the dispatcher is out of the
      // loop for relay traffic, so nobody else sets this). Refused dispatches
      // stamp nothing — 本机 did not carry them.
      if (attemptStart.meta.egress !== null) contextStore.exitId = attemptStart.meta.egress.exitId
      else if (attemptStart.meta.viaRelay && attemptStart.meta.fail === null) contextStore.exitId = LOCAL_EXIT_ID
      const events = attemptStart.stream as AsyncIterable<PiEvent>
      let deliveredContent = false
      let preContentFailure: { message: string } | null = null
      const buffered: PiEvent[] = []
      /** Replay the buffered pre-content events alone (no live tail). */
      const replayBuffered = async function* (): AsyncGenerator<PiEvent> {
        for (const e of buffered) yield e
      }
      const source = events[Symbol.asyncIterator]()
      // Peek events until the stream proves itself one way or the other:
      // content -> flush and stream through; error before content -> maybe
      // rotate. Content flushes IMMEDIATELY (only the pre-content events are
      // buffered): holding every token hostage to a failure that may never
      // come would also kill streaming for the UI.
      let sawAnyEvent = false
      let lastEventAt = Date.now()
      // One deadline timer at a time, re-armed per pull (a timer per pull
      // would accumulate thousands over a long token stream). While no event
      // has arrived at all, the FIRST-EVENT window applies (stricter — the
      // tunnel/connect stage should answer within seconds); once ANY event
      // has landed (start, or content directly), the looser BODY-IDLE
      // window applies so slow TTFT pacing on healthy exits is not misread
      // as a dead tunnel.
      let deadlineTimer: NodeJS.Timeout | undefined
      const raceDeadline = (): Promise<never> => {
        clearTimeout(deadlineTimer)
        const idleWindow = sawAnyEvent ? bodyIdleMs : firstEventMs
        const message = sawAnyEvent ? WATCHDOG_IDLE_MESSAGE : WATCHDOG_FIRST_MESSAGE
        const ms = Math.max(0, idleWindow - (Date.now() - lastEventAt))
        return new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => reject(new Error(message)), ms)
          deadlineTimer.unref?.()
        })
      }
      // The pump the consumer sees after flush: buffered events first, then
      // the live rest of the stream, through ONE toStreamChunks pass so the
      // done/error terminator is never missing (the pre-fix flush fed it a
      // terminator-less slice and threw "ended without done/error").
      const pumpLive = async function* (): AsyncGenerator<PiEvent> {
        for (const e of buffered) yield e
        for (;;) {
          let next: IteratorResult<PiEvent>
          try {
            next = await Promise.race([source.next(), raceDeadline()])
          } catch (err) {
            // watchdog or foreign teardown tore the stream down mid-content:
            // the consumer already saw partial content, so surface the
            // terminal error honestly and stop — never a hang, never a replay
            yield terminalErrorEvent(err instanceof Error ? err.message : String(err), model)
            return
          }
          if (next.done) {
            clearTimeout(deadlineTimer)
            return
          }
          const event = next.value as PiEvent
          lastEventAt = Date.now()
          if (event.type === 'error' || event.type === 'done') {
            clearTimeout(deadlineTimer)
            onTerminal?.(event.type === 'done' ? event.message : event.error)
            yield event
            return
          }
          yield event
        }
      }
      // Peek phase (pre-content): pull with the first-event deadline armed.
      for (;;) {
        let next: IteratorResult<PiEvent>
        try {
          next = await Promise.race([source.next(), raceDeadline()])
        } catch (err) {
          // pre-content silence: synthesize the terminal error pi-ai never
          // delivered so the rotate decision sees a transport failure
          preContentFailure = { message: err instanceof Error ? err.message : String(err) }
          buffered.push(terminalErrorEvent(preContentFailure.message, model))
          break
        }
        if (next.done) break
        const event = next.value as PiEvent
        lastEventAt = Date.now()
        sawAnyEvent = true
        if (event.type === 'error') {
          onTerminal?.(event.error)
          preContentFailure = { message: event.error.errorMessage ?? 'pi-ai stream error' }
          // the event still flows to the consumer unless we rotate
          buffered.push(event)
          break
        }
        if (event.type === 'done') {
          onTerminal?.(event.message)
          // pi-ai can also deliver the failure on done (stopReason: error)
          if (event.message.stopReason === 'error' && !deliveredContent) {
            preContentFailure = { message: event.message.errorMessage ?? 'pi-ai stream error' }
          }
          buffered.push(event)
          break
        }
        buffered.push(event)
        if (event.type !== 'start') deliveredContent = true
        if (deliveredContent) {
          // first content event: flush everything buffered and go live
          break
        }
      }
      // peek phase over: whatever path exited the loop, this attempt's
      // deadline timer is spent (pumpLive re-arms its own per pull)
      clearTimeout(deadlineTimer)
      if (preContentFailure === null && deliveredContent) {
        // The stream proved itself: the exit the relay used is a good exit
        // (the dispatcher's passive verdict, relay edition).
        settleRelayEgress(attemptStart.meta.egress, { status: 200 })
        // attributeUsage: this attempt's usage rides the exit the dispatcher
        // stamped into contextStore (exit-stats accounting, pool/usage.ts).
        yield* attributeUsage(contextStore, toStreamChunks(pumpLive(), GATE_TOOL_ALIASES, argumentBridge))
        return
      }
      if (preContentFailure === null && !deliveredContent) {
        // stream ended cleanly with no content and no error: pass through
        // (pi-ai's empty-response classification owns this case)
        settleRelayEgress(attemptStart.meta.egress, { status: 200 })
        yield* attributeUsage(contextStore, toStreamChunks(replayBuffered(), GATE_TOOL_ALIASES, argumentBridge))
        return
      }
      // Exit-shaped failure before content: ask the pool whether rotating is
      // worth another attempt; otherwise surface the buffered events as-is.
      const failureMessage = (preContentFailure as { message: string }).message
      const failure = classifyStreamFailure(failureMessage)
      const deterministic = isRegionBlocked(failureMessage)
      // Grade the exit the relay used with the same verdict table the
      // dispatcher applies to a real status code: a named status rides
      // through (429 -> limited, 403 -> ok-but-refused, 5xx -> degraded), and a
      // failure that named no status was a transport cut.
      const failureStatus = statusOfFailure(failureMessage)
      settleRelayEgress(
        attemptStart.meta.egress,
        failureStatus !== undefined ? { status: failureStatus } : { transport: failure === 'transport' },
      )
      // The gate's IP-reputation answer (…abusive traffic from this IP
      // address…) is a property of the EXIT, so the pool benches that exit for
      // hours instead of rotating back onto it in a moment.
      const abusive = isIpReputationRefusal(failureMessage)
      const nextOrigin = origins[originIndex + 1]
      if (nextOrigin !== undefined && isOriginFailure(failureMessage)) {
        // Origin-shaped, and there is another door: re-run the same attempt
        // against it. `attempt` is deliberately NOT incremented, so a refusal
        // that both origins share still leaves the full pool budget intact.
        rotateStory.push(`#${attempt + 1} ${failure ?? 'origin'} ${originLabel(origin)} -> ${originLabel(nextOrigin)}: ${failureMessage.slice(0, 60)}`)
        originIndex += 1
        continue
      }
      const rotate = failure !== null
        && attempt < MAX_ROTATES
        && shouldRotate(failure, options.model, ids.session, attempt + 1, deterministic, abusive)
      rotateStory.push(`#${attempt + 1} ${failure ?? 'unknown'}: ${failureMessage.slice(0, 80)}`)
      if (!rotate) {
        // last resort: rewrite the terminal error to tell the whole story
        // (the user saw minutes of silence — the surfaced error must say
        // what was tried, not just the last attempt's failure). The count is
        // of EXIT rotations; an origin failover says so instead.
        const story = rotateStory.length > 1
          ? ` (oc2dsh ${rotations > 0 ? `轮换 ${rotations} 次后放弃` : '两条来源均失败'}: ${rotateStory.join(' -> ')})`
          : ''
        for (let i = 0; i < buffered.length; i += 1) {
          const e = buffered[i] as PiEvent & { error?: { errorMessage?: string }; message?: { errorMessage?: string; stopReason?: string } }
          if (e.type === 'error' && e.error) {
            e.error.errorMessage = `${e.error.errorMessage}${story}`
            break
          }
          if (e.type === 'done' && e.message?.stopReason === 'error') {
            e.message.errorMessage = `${e.message.errorMessage}${story}`
            break
          }
        }
        yield* attributeUsage(contextStore, toStreamChunks(replayBuffered(), GATE_TOOL_ALIASES, argumentBridge))
        return
      }
      // rotate: loop re-runs #eventsFor inside the same ALS store; the pool
      // has already degraded the failed exit, so pick lands elsewhere. A fresh
      // exit starts at the ladder's first rung again.
      attempt += 1
      rotations += 1
      originIndex = 0
    }
  }

  #eventsFor(
    options: HarnessGenerateOptions,
    context: PiContext,
    ids: ReturnType<typeof deriveRequestIDs>,
    model: ReturnType<typeof toPiModel>,
    origin?: string,
  ): { stream: unknown; meta: AttemptMeta } {
    // Structural boundary: PiContext (own types, unit-tested) -> pi-ai Context.
    const isResponses = model.api === 'openai-responses'
    const requestedReasoning = typeof options.reasoningEffort === 'string'
      ? options.reasoningEffort
      : typeof options.reasoning === 'string'
        ? options.reasoning
        : undefined
    const responseReasoning = isResponses ? normalizeResponsesEffort(requestedReasoning) : undefined
    const effortWire = isResponses ? undefined : reasoningEffortWire(options.reasoningEffort)

    // onPayload injects the free-lane gate tools (adapter/messages.ts) into the
    // serialized body right before dispatch — plain-chat contexts carry no
    // tools and the anonymous lane 403s every body without bash+read. The same
    // seam carries the selected reasoning effort: pi-ai has no option with the
    // wire semantics this lane needs (selected off must SEND `none`, not omit),
    // so the effort rides the payload rewrite instead.
    const onPayload =
      isResponses
        ? (payload: unknown): unknown => {
            const normalized = normalizeResponsesPayload(payload, responseReasoning)
            return ensureResponsesFreeLaneShape(normalized ?? payload) ?? normalized
          }
        : effortWire === undefined
        ? ensureFreeLaneShape
        : (payload: unknown): unknown => {
            const shaped = ensureFreeLaneShape(payload)
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return shaped
            return { ...((shaped ?? payload) as Record<string, unknown>), reasoning_effort: effortWire }
          }
    // Responses-only models (muse-spark-*) must hit /responses, not /chat/completions.
    const provider = isResponsesModel(model.id) && this.#responsesProvider
      ? this.#responsesProvider
      : this.#provider
    // WHICH CONNECTION STACK SENDS THIS REQUEST (relay/supervisor.ts).
    //
    // The free lane gates on the client's TLS/HTTP fingerprint: a Node fetch is
    // answered 429 whatever its payload says, while the same bytes leaving the
    // Bun relay are served. So while a relay is up, the request is addressed to
    // it — same path (the relay forwards the pathname verbatim, preserving the
    // lane origin the ladder picked), same headers, same body — and the relay's
    // own bun-native fetch opens the upstream connection.
    const relayBase = this.#relay?.baseUrlFor(origin ?? this.#origins[0] ?? ZEN_BASE_URL) ?? null
    const viaRelay = relayBase !== null
    // The exit is picked HERE for relay traffic (the pool's dispatcher never
    // sees a loopback URL): same pick(session, model) the dispatcher calls, so
    // pinning, stickiness and two-tier health still decide, and the answer
    // travels to the relay in a header it strips before forwarding.
    const decision = viaRelay && hasRelayEgress() ? pickRelayEgress({ model: options.model, session: ids.session }) : null
    const egress: RelayEgressPick | null = decision !== null && !('fail' in decision) ? decision : null
    const refusal: string | null = decision !== null && 'fail' in decision ? decision.fail : null
    const meta: AttemptMeta = { egress, viaRelay, fail: refusal }
    if (refusal !== null) {
      // 本地出口兜底 is off and the pool has nothing: refuse to egress (the
      // dispatcher's #failClosed does the same for non-relay traffic) instead
      // of quietly putting this machine's address on the wire.
      return { stream: failedStream(refusal, model), meta }
    }
    const targetBase = relayBase !== null
      ? `${relayBase}/v1`
      : `${(origin ?? this.#origins[0] ?? ZEN_BASE_URL).replace(/\/+$/, '')}/v1`
    const target = { ...model, baseUrl: targetBase }
    const headers = disguiseHeaders(ids)
    if (meta.egress !== null) headers[EGRESS_HEADER] = meta.egress.url
    return {
      meta,
      stream: provider.streamSimple(target, context as unknown as Context, {
        apiKey: ANONYMOUS_KEY,
        sessionId: ids.session,
        headers,
        onPayload,
        signal: options.signal,
        maxRetries: 0,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        ...(responseReasoning ? { reasoning: responseReasoning } : {}),
      }),
    }
  }

  /** Expose the live catalog snapshot for diagnostics. */
  catalogStatus(): { total: number; exposed: number } {
    const list = this.#catalog.list()
    return { total: list.length, exposed: list.length }
  }

  decisionFor(model: string): { allowed: boolean; source: string } {
    const decision = this.#catalog.decision(model)
    return { allowed: decision.allowed, source: decision.source }
  }
}

/** Build the adapter over a live catalog. */
export function createZenAdapter(catalog: ModelCatalog): ZenAdapter {
  return new ZenAdapter(catalog)
}
