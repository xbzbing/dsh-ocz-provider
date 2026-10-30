import { createProvider, type Api, type Context, type Model } from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'
import * as openaiResponses from '@earendil-works/pi-ai/api/openai-responses'

import { ModelCatalog, ZEN_BASE_URL } from './catalog.ts'
import { attemptAbort, attemptEntry, describeFailure, giveUpStory, nextStep, originSwitchEntry, peekAttempt, watchEvents, withFailureSuffix, type WatchdogWindows } from './attempt.ts'
import { toStreamChunks, type HarnessChunk, type PiDoneMessage, type PiEvent } from './events.ts'
import { conversationLabel, deriveRequestIDs, disguiseHeaders } from './ids.ts'
import { chatApiPath, laneOrigins } from './lane.ts'
import { gateToolArgumentBridge } from './gate-tools.ts'
import { hostProjectAsync } from './project.ts'
import { nextRetryDelayMs, retryDelayKey } from './retry-delay.ts'
import { ensureFreeLaneShape, ensureResponsesFreeLaneShape, GATE_TOOL_ALIASES, inClientKeyOrder, toPiContext, type HarnessGenerateOptions, type PiContext } from './messages.ts'
import { apiForModel, isResponsesModel } from './routing.ts'
export { apiForModel, isResponsesModel } from './routing.ts'
export { WATCHDOG_FIRST_MESSAGE, WATCHDOG_IDLE_MESSAGE } from './attempt.ts'
import { normalizeResponsesEffort, normalizeResponsesPayload, reasoningEfforts, reasoningEffortWire, selectedEffort, type ZenReasoningEffort } from './reasoning-effort.ts'
export { normalizeResponsesPayload, REASONING_EFFORT_LADDER, reasoningEfforts, reasoningEffortWire, type ZenReasoningEffort } from './reasoning-effort.ts'
import { routingContext, type RoutingContext } from '../pool/dispatcher.ts'
import { shouldRotate } from '../pool/rotate.ts'
import { attributeUsage, DIRECT_EXIT_ID, LOCAL_EXIT_ID } from '../pool/usage.ts'
import { EGRESS_HEADER, hasRelayEgress, pickRelayEgress, settleRelayEgress, type RelayEgressPick } from '../relay/egress.ts'
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

/**
 * A models.dev-declared limit (`limit.context` / `limit.output`) when it is a
 * positive integer, the host default otherwise (pending/absent metadata).
 */
function declaredOr(declared: number | undefined, fallback: number): number {
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0 ? declared : fallback
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
 * Waits come from retry-delay.ts's ladder (tagged as providerRetryAfterMs);
 * maxDelayMs is also its ceiling. Rationale: docs/design.md §6.5.
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

/** Default watchdog windows (docs/design.md §6.4); injected in tests. */
export const DEFAULT_FIRST_EVENT_MS = 30_000
export const DEFAULT_BODY_IDLE_MS = 120_000
/**
 * Wider body-idle window for Responses models (`muse-spark-*`): their
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

/** A pool exit id from the routing context; the local/direct sentinels are not exits. */
function poolExitOf(exitId: string | undefined): string | null {
  return exitId === undefined || exitId === LOCAL_EXIT_ID || exitId === DIRECT_EXIT_ID ? null : exitId
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
 * Vision gate: whether a model accepts image input on the Zen lane.
 *
 * models.dev `modalities.input` decides whenever it speaks — the same
 * declaration that already drives `limit.context` / `limit.output` lists the
 * input kinds each model takes, and the free roster rotates constantly, so a
 * family-scoped pattern cannot track it: space-bunny-free,
 * muse-spark-1.*-contributor-free, mimo-v2.5-free, fledge-alpha-free and
 * longcat-2.5-preview-free all declare `image` upstream and sit outside the
 * mimo family. A declared text-only model stays refused, so the gate still
 * protects the lane in both directions.
 *
 * The built-in pattern remains the fallback for the ids whose image input is
 * verified end-to-end (the mimo-v2.6 family), so metadata being pending,
 * absent or silent never changes what those models can do. Models that end up
 * text-only make DSH's attachment gate (`Model "<id>" does not support image
 * input.`) and pi-ai's image downgrade refuse image parts instead of
 * forwarding them to a model that cannot see them.
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
    // data URLs).
    reasoning,
    // opencode2dsh #97: DeepSeek's thinking mode rejects any replayed
    // assistant turn without a reasoning_content field ("The reasoning_content
    // in the thinking mode must be passed back to the API"), and pi-ai only
    // auto-detects that requirement for provider 'deepseek' / a deepseek.com
    // baseUrl — neither matches this lane. The flag makes pi-ai emit an empty
    // reasoning_content for replayed turns that carried no thinking; turns
    // that DID think carry their text under the streamed field via the
    // signature on the reasoning block (events.ts -> messages.ts).
    // Pinned rather than detected: behind the relay the base URL is loopback,
    // so pi-ai's opencode.ai detection would add `store` and the `developer`
    // role, neither of which the client sends.
    compat: { requiresReasoningContentOnAssistantMessages: true, supportsStore: false, supportsDeveloperRole: false },
    input: isVisionModel(id, declaredModalities) ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: declaredOr(limits?.contextWindow, DEFAULT_CONTEXT_WINDOW),
    maxTokens: declaredOr(limits?.maxOutput, DEFAULT_MAX_TOKENS),
  }
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

  /** Provider-owned retry policy, read by dsh-llm at registration (docs/design.md §6.5). */
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
   * duplicates). Async on purpose: the host awaits this call and caches its
   * answer per host generation, so the first read waits — bounded, inside the
   * catalog — for the live Zen fetch instead of handing the host the
   * staticFreeModels bootstrap list it would then keep showing.
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
      context: { contextWindow: declaredOr(this.#catalog.limits?.(model)?.contextWindow, DEFAULT_CONTEXT_WINDOW) },
      defaultMaxTokens: declaredOr(this.#catalog.limits?.(model)?.maxOutput, DEFAULT_MAX_TOKENS),
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
    const effort = selectedEffort(options)
    const canDisableThinking = effort !== 'off' && effort !== 'none'
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

  /** Stream one attempt chain from the Zen anonymous lane.
   *
   * IP-7 rotate loop (docs/ip-pool.md §3.4 / §8.1): a stream that dies
   * BEFORE any content landed restarts on another origin or a fresh exit
   * (attempt.ts `nextStep`), and the host's retry budget never sees the
   * intermediate error. Once content has flowed the stream is never replayed.
   * Every abandoned attempt is cancelled through its own abort signal.
   */
  async *#streamAttempt(options: HarnessGenerateOptions, onTerminal?: (message: PiDoneMessage) => void): AsyncGenerator<HarnessChunk> {
    const context = await toPiContext(options)
    // The project id resolves off the event loop; the sync reads below hit its cache.
    await hostProjectAsync()
    const hostSession = typeof options.sessionId === 'string' ? options.sessionId : ''
    const ids = deriveRequestIDs(options.messages, hostSession)
    // The wire carries the genuine `shell`/`read` definitions (messages.ts), so
    // the model answers in the wire schema (`path`, `timeout`); this bridge maps
    // a finished call back to the host's declared shape (gate-tools.ts).
    const argumentBridge = gateToolArgumentBridge(context.tools)
    const model = toPiModel(
      options.model,
      this.#catalog.reasoningCapability(options.model)?.reasoning === true,
      this.#catalog.limits?.(options.model),
      this.#catalog.modalities?.(options.model),
      this.#origins[0] ?? ZEN_BASE_URL,
    )
    // Per-request routing context (docs/ip-pool.md 3.3) rides AsyncLocalStorage.
    // The ledger files usage under the HOST's session id when it has one; the
    // stickiness key stays `ids.session`.
    const contextStore: RoutingContext = {
      model: options.model,
      session: ids.session,
      usageSession: hostSession !== '' ? hostSession : ids.session,
      usageLabel: conversationLabel(options.messages),
    }
    const windows: WatchdogWindows = {
      firstEventMs: this.#firstEventMs,
      // Derived from model.api, the flag that picked the provider, so the
      // watchdog and the wire layer can never disagree.
      bodyIdleMs: model.api === 'openai-responses' ? Math.max(this.#bodyIdleMs, this.#responsesBodyIdleMs) : this.#bodyIdleMs,
    }
    const chunksOf = (events: AsyncIterable<PiEvent>): AsyncGenerator<HarnessChunk> =>
      attributeUsage(contextStore, toStreamChunks(events, GATE_TOOL_ALIASES, argumentBridge))
    const origins = this.#origins
    const story: string[] = []
    let originIndex = 0
    /** EXIT rotations spent; an origin switch is not one. */
    let rotations = 0
    for (;;) {
      const origin = origins[originIndex] ?? origins[0] ?? ZEN_BASE_URL
      const cancel = attemptAbort(options.signal)
      /** True once the consumer received this attempt's terminal chunk. */
      let completed = false
      try {
        contextStore.exitId = undefined
        const started = routingContext.run(contextStore, () =>
          this.#eventsFor(options, context, ids, model, origin, cancel.signal),
        ) as { stream: unknown; meta: AttemptMeta }
        // Relay traffic never reaches the dispatcher, so the exit is stamped
        // here for the usage ledger; a refused dispatch stamps nothing.
        if (started.meta.egress !== null) contextStore.exitId = started.meta.egress.exitId
        else if (started.meta.viaRelay && started.meta.fail === null) contextStore.exitId = LOCAL_EXIT_ID
        const events = watchEvents(started.stream as AsyncIterable<PiEvent>, windows, (message) => terminalErrorEvent(message, model), cancel.abort)
        const peek = await peekAttempt(events, onTerminal)
        if (peek.failure === null) {
          // Content (or a clean empty finish): the exit is good, stream through.
          settleRelayEgress(started.meta.egress, { status: 200 })
          yield* chunksOf(peek.live)
          completed = true
          return
        }
        const failure = describeFailure(peek.failure)
        settleRelayEgress(started.meta.egress, failure.outcome)
        const nextOrigin = origins[originIndex + 1]
        const step = nextStep(failure, { hasNextOrigin: nextOrigin !== undefined, rotations })
        if (step === 'switch-origin' && nextOrigin !== undefined) {
          story.push(originSwitchEntry(rotations + 1, failure, origin, nextOrigin))
          originIndex += 1
          continue
        }
        const failedExit = started.meta.egress?.exitId ?? poolExitOf(contextStore.exitId)
        const rotate = step === 'ask-pool' && shouldRotate(
          failure.failure!, options.model, ids.session, rotations + 1, failure.deterministic, failure.abusive, failedExit,
        )
        story.push(attemptEntry(rotations + 1, failure))
        if (!rotate) {
          // The surfaced error names everything that was tried; its code still
          // describes this last attempt alone.
          yield* withFailureSuffix(chunksOf(peek.live), giveUpStory(story, rotations))
          completed = true
          return
        }
        // The pool has already degraded the failed exit, so the re-pick lands
        // elsewhere; a fresh exit starts at the ladder's first rung again.
        rotations += 1
        originIndex = 0
      } finally {
        // Watchdog, rotation, origin switch or a consumer that left early.
        if (!completed) cancel.abort()
        cancel.release()
      }
    }
  }

  #eventsFor(
    options: HarnessGenerateOptions,
    context: PiContext,
    ids: ReturnType<typeof deriveRequestIDs>,
    model: ReturnType<typeof toPiModel>,
    origin: string,
    signal: AbortSignal,
  ): { stream: unknown; meta: AttemptMeta } {
    // Structural boundary: PiContext (own types, unit-tested) -> pi-ai Context.
    const isResponses = model.api === 'openai-responses'
    const requestedReasoning = selectedEffort(options)
    const responseReasoning = isResponses ? normalizeResponsesEffort(requestedReasoning) : undefined
    const effortWire = isResponses ? undefined : reasoningEffortWire(requestedReasoning)

    // onPayload injects the gate's shell+read pair (adapter/messages.ts) right
    // before dispatch: the lane 403s a body whose tools lack `read`. It also
    // carries the selected effort, because a selected off must SEND `none`.
    const onPayload =
      isResponses
        ? (payload: unknown): unknown => {
            const normalized = normalizeResponsesPayload(payload, responseReasoning)
            return ensureResponsesFreeLaneShape(normalized ?? payload) ?? normalized
          }
        : (payload: unknown): unknown => {
            const shaped = ensureFreeLaneShape(payload)
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return shaped
            const body = (shaped ?? payload) as Record<string, unknown>
            return inClientKeyOrder(effortWire === undefined ? body : { ...body, reasoning_effort: effortWire })
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
    const relayBase = this.#relay?.baseUrlFor(origin) ?? null
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
    const apiPath = chatApiPath(origin)
    const targetBase = relayBase !== null
      ? `${relayBase}${apiPath}`
      : `${origin.replace(/\/+$/, '')}${apiPath}`
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
        signal,
        maxRetries: 0,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        ...(responseReasoning ? { reasoning: responseReasoning } : {}),
      }),
    }
  }
}

/** Build the adapter over a live catalog. */
export function createZenAdapter(catalog: ModelCatalog): ZenAdapter {
  return new ZenAdapter(catalog)
}
