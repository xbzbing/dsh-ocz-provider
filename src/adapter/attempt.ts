/**
 * The pieces of one upstream attempt that do not need the adapter: the
 * stream-liveness watchdog, the failure facts a pre-content error carries, the
 * next-step decision (origin switch / exit rotation / give up) and the
 * give-up story. zen-adapter.ts `#streamAttempt` wires them together.
 */

import type { HarnessChunk, PiDoneMessage, PiEvent } from './events.ts'
import { isOriginFailure } from './lane.ts'
import { classifyStreamFailure, isIpReputationRefusal, isRegionBlocked, type RotateFailure } from '../pool/rotate.ts'
import { isRelayTransportFailure, statusOfFailure, type RelayOutcome } from '../relay/egress.ts'

/**
 * Watchdog messages. Both carry "timeout", so classifyStreamFailure maps them
 * to 'transport' and the rotate loop can move the session to a live exit.
 */
export const WATCHDOG_FIRST_MESSAGE = 'oc2dsh: first stream event timeout (exit silent before any response)'
export const WATCHDOG_IDLE_MESSAGE = 'oc2dsh: stream body idle timeout (exit went silent mid-response)'

/**
 * pi-ai's own truncation wording, used when a stream closes with no terminal
 * event: both classifiers read it as a retryable transport cut.
 */
export const STREAM_ENDED_MESSAGE = 'Stream ended without finish_reason'

/** Upper bound on exit rotations per attempt chain; the pool's own bound is lower. */
export const ROTATE_SAFETY_CAP = 10

export interface WatchdogWindows {
  /** Silence allowed before the first event (docs/design.md §6.4). */
  firstEventMs: number
  /** Silence allowed between two events once the stream has started. */
  bodyIdleMs: number
}

/**
 * Pull `events` under the watchdog windows and guarantee exactly one terminal
 * event: the source's own done/error, a synthesized error on silence or a
 * thrown pull (after `abandon()` cancels the request), or STREAM_ENDED_MESSAGE
 * when the source closes without one. No timer is armed while suspended at a
 * yield, so an abandoned iterator leaks nothing.
 */
export async function* watchEvents(
  events: AsyncIterable<PiEvent>,
  windows: WatchdogWindows,
  terminal: (message: string) => PiEvent,
  abandon: () => void,
): AsyncGenerator<PiEvent> {
  const source = events[Symbol.asyncIterator]()
  let sawAnyEvent = false
  let lastEventAt = Date.now()
  for (;;) {
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      const window = sawAnyEvent ? windows.bodyIdleMs : windows.firstEventMs
      const message = sawAnyEvent ? WATCHDOG_IDLE_MESSAGE : WATCHDOG_FIRST_MESSAGE
      timer = setTimeout(() => reject(new Error(message)), Math.max(0, window - (Date.now() - lastEventAt)))
      timer.unref?.()
    })
    let next: IteratorResult<PiEvent>
    try {
      next = await Promise.race([source.next(), deadline])
    } catch (err) {
      abandon()
      yield terminal(err instanceof Error ? err.message : String(err))
      return
    } finally {
      clearTimeout(timer)
    }
    if (next.done === true) {
      yield terminal(STREAM_ENDED_MESSAGE)
      return
    }
    sawAnyEvent = true
    lastEventAt = Date.now()
    yield next.value
    if (next.value.type === 'done' || next.value.type === 'error') return
  }
}

/**
 * Pull an attempt until it proves itself: the first content event (or a
 * clean finish) means `failure: null`; an error before content carries its
 * message. `live` replays what was peeked, then the rest of the same stream,
 * so content is flushed at once and only pre-content events are held.
 */
export async function peekAttempt(
  events: AsyncGenerator<PiEvent>,
  onTerminal?: (message: PiDoneMessage) => void,
): Promise<{ failure: string | null; live: AsyncGenerator<PiEvent> }> {
  const buffered: PiEvent[] = []
  let failure: string | null = null
  let terminal = false
  for (;;) {
    const next = await events.next()
    if (next.done === true) {
      terminal = true
      break
    }
    const event = next.value
    buffered.push(event)
    if (event.type === 'error') {
      onTerminal?.(event.error)
      failure = event.error.errorMessage ?? 'pi-ai stream error'
      terminal = true
      break
    }
    if (event.type === 'done') {
      onTerminal?.(event.message)
      // pi-ai can also deliver the failure on done (stopReason: error)
      if (event.message.stopReason === 'error') failure = event.message.errorMessage ?? 'pi-ai stream error'
      terminal = true
      break
    }
    if (event.type !== 'start') break
  }
  const live = async function* (): AsyncGenerator<PiEvent> {
    try {
      yield* buffered
      if (terminal) return
      for (;;) {
        const next = await events.next()
        if (next.done === true) return
        const event = next.value
        if (event.type === 'done') onTerminal?.(event.message)
        if (event.type === 'error') onTerminal?.(event.error)
        yield event
      }
    } finally {
      await events.return(undefined)
    }
  }
  return { failure, live: live() }
}

/** What a pre-content failure says about the exit, the origin and the request. */
export interface AttemptFailure {
  message: string
  /** Rotate taxonomy; null = not exit-shaped (never rotated). */
  failure: RotateFailure | null
  /** RegionError: the (exit, model) pairing is banned on sight. */
  deterministic: boolean
  /** IP-reputation refusal: the exit is benched for hours. */
  abusive: boolean
  /** A gate refusal or edge 5xx the next origin may not share (lane.ts). */
  originShaped: boolean
  /** The verdict for the exit that carried it, in the dispatcher's terms. */
  outcome: RelayOutcome
}

export function describeFailure(message: string): AttemptFailure {
  const failure = classifyStreamFailure(message)
  // The relay's own 502 envelope is a cut: no upstream status ever existed.
  const status = isRelayTransportFailure(message) ? undefined : statusOfFailure(message)
  return {
    message,
    failure,
    deterministic: isRegionBlocked(message),
    abusive: isIpReputationRefusal(message),
    originShaped: isOriginFailure(message),
    outcome: status !== undefined ? { status } : { transport: failure === 'transport' },
  }
}

export type NextStep = 'switch-origin' | 'ask-pool' | 'give-up'

/**
 * Pure next step after a pre-content failure. An origin-shaped failure with
 * another door left re-sends to it without spending a rotation; an exit-shaped
 * one asks the pool (which owns the rotation bound); anything else gives up.
 */
export function nextStep(failure: AttemptFailure, context: { hasNextOrigin: boolean; rotations: number }): NextStep {
  if (context.hasNextOrigin && failure.originShaped) return 'switch-origin'
  if (failure.failure === null || context.rotations >= ROTATE_SAFETY_CAP) return 'give-up'
  return 'ask-pool'
}

const originLabel = (origin: string): string => origin.replace(/^https?:\/\//, '')

/** One story line for an attempt that moved to the next origin. */
export function originSwitchEntry(attempt: number, failure: AttemptFailure, from: string, to: string): string {
  return `#${attempt} ${failure.failure ?? 'origin'} ${originLabel(from)} -> ${originLabel(to)}: ${failure.message.slice(0, 60)}`
}

/** One story line for an attempt that rotated or gave up. */
export function attemptEntry(attempt: number, failure: AttemptFailure): string {
  return `#${attempt} ${failure.failure ?? 'unknown'}: ${failure.message.slice(0, 80)}`
}

/** The suffix a given-up error carries: what was tried, or nothing for a single attempt. */
export function giveUpStory(story: readonly string[], rotations: number): string {
  if (story.length <= 1) return ''
  return ` (oc2dsh ${rotations > 0 ? `轮换 ${rotations} 次后放弃` : '两条来源均失败'}: ${story.join(' -> ')})`
}

/**
 * Append `suffix` to the surfaced failure message AFTER classification, so the
 * code still describes the last attempt (earlier attempts' words in the story
 * must not turn a 429 into AUTH).
 */
export async function* withFailureSuffix(chunks: AsyncIterable<HarnessChunk>, suffix: string): AsyncGenerator<HarnessChunk> {
  for await (const chunk of chunks) {
    if (suffix !== '' && chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      yield { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, message: `${chunk.reason.failure.message}${suffix}` } } }
      continue
    }
    yield chunk
  }
}

/**
 * One attempt's cancellation: aborted when the host's signal aborts, and by
 * the adapter when it abandons the attempt (watchdog, rotation, origin switch,
 * consumer gone). `release()` detaches it from the host signal.
 */
export function attemptAbort(parent: AbortSignal | undefined): { signal: AbortSignal; abort(): void; release(): void } {
  const controller = new AbortController()
  const follow = (): void => controller.abort(parent?.reason)
  if (parent?.aborted === true) follow()
  else parent?.addEventListener('abort', follow, { once: true })
  return {
    signal: controller.signal,
    abort: () => controller.abort(new Error('oc2dsh: attempt abandoned')),
    release: () => parent?.removeEventListener('abort', follow),
  }
}
