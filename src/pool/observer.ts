/**
 * The passive-signal observer around one exit-routed dispatch
 * (docs/ip-pool.md §4.2 rule table, §4.3 被动): the real request's outcome
 * feeds the two-tier health. Body bytes stream through untouched; only the
 * response start line and terminal transport errors are read.
 *
 * Forwarding discipline (undici 8.10): the fetch handler's methods live on a
 * prototype with private state, so the wrapper is a fresh plain object that
 * forwards every callback with the original handler as `this`.
 *
 * Exactly ONE terminal callback reaches the handler: once a response end,
 * error or upgrade is forwarded (or the sentinel synthesizes an error), every
 * later callback is dropped, including the abort error undici raises for the
 * sentinel's own abort.
 *
 * Response-silence sentinel, two windows: (a) dispatch -> first callback,
 * because undici fires NO handler callback when a proxy CONNECT dies; (b)
 * request start -> response headers, much looser, because the remaining wait
 * is the upstream composing its first token. Silence past either deadline is a
 * transport cut: the sentinel synthesizes the error the handler is owed and
 * aborts the live controller, so fetch rejects and the adapter can rotate.
 * Body pacing is not covered (response headers disarm it).
 */

import type { Dispatcher } from 'undici'

import type { ExitPool } from './pool.ts'
import { settleStatus, settleTransport } from './outcome.ts'

export interface ObserveOptions {
  pool: ExitPool
  exitId: string
  model: string
  session: string
  /** Window (a): dispatch -> first callback. */
  sentinelMs: number
  /** Window (b): request start -> response headers. */
  headersMs: number
  /** Judge one transport cut (pool/transport.ts); unset = a cut is a strike. */
  onTransportCut?: (exitId: string) => void
  logger?: { warn(message: string): void }
}

export function observeExitRequest(options: ObserveOptions, handler: Dispatcher.DispatchHandler): Dispatcher.DispatchHandler {
  const { pool, exitId, model, session } = options
  const pick = { exitId, model, session }
  const forward = (method: keyof Dispatcher.DispatchHandler, args: unknown[]): void => {
    const fn = handler[method]
    if (typeof fn === 'function') (fn as (...a: unknown[]) => void).apply(handler, args)
  }
  /** A status or a cut has graded this request; nothing grades it twice. */
  let classified = false
  /** A terminal callback reached the handler; everything after is dropped. */
  let terminated = false
  /** The begun request is booked as ended (exactly once per dispatch). */
  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    pool.endRequest(exitId)
  }
  const classify = (statusCode: number): void => {
    if (classified) return
    classified = true
    settleStatus(pool, pick, statusCode)
  }
  const cut = (why: string): void => {
    if (classified) return
    classified = true
    settleTransport(pool, pick, options.onTransportCut)
    options.logger?.warn(`oc2dsh: exit ${exitId} transport cut (${why})`)
  }
  // undici hands a fresh controller to each callback; abort must reach the live one.
  let liveController: { abort?(reason: Error): void } | null = null

  let sawRequestStart = false
  let sentinel: NodeJS.Timeout | undefined
  const disarm = (): void => {
    clearTimeout(sentinel)
  }
  const onSilence = (why: string): void => {
    if (terminated) return
    cut(why)
    end()
    terminated = true
    const reason = new Error('oc2dsh: exit response silence')
    forward('onResponseError', [liveController ?? {}, reason])
    liveController?.abort?.(reason)
  }
  const armSentinel = (): void => {
    disarm()
    const window = sawRequestStart ? options.headersMs : options.sentinelMs
    sentinel = setTimeout(() => onSilence(sawRequestStart
      ? `no response headers within ${options.headersMs}ms of request start`
      : `no request start within ${options.sentinelMs}ms of dispatch (proxy CONNECT never completed)`), window)
    sentinel.unref?.()
  }
  armSentinel()

  /** Forward a non-terminal callback unless the request already terminated. */
  const pass = (method: keyof Dispatcher.DispatchHandler, args: unknown[]): void => {
    if (!terminated) forward(method, args)
  }
  /** Forward the one terminal callback the handler gets. */
  const finish = (method: keyof Dispatcher.DispatchHandler, args: unknown[]): void => {
    if (terminated) return
    terminated = true
    disarm()
    end()
    forward(method, args)
  }

  return {
    onRequestStart: (controller, context) => {
      if (terminated) return
      liveController = controller
      sawRequestStart = true
      armSentinel()
      forward('onRequestStart', [controller, context])
    },
    onRequestUpgrade: (controller, statusCode, headers, socket) => {
      liveController = controller
      finish('onRequestUpgrade', [controller, statusCode, headers, socket])
    },
    onResponseStart: (controller, statusCode, headers, statusMessage) => {
      if (terminated) return
      liveController = controller
      disarm()
      classify(statusCode)
      forward('onResponseStart', [controller, statusCode, headers, statusMessage])
    },
    onResponseData: (controller, chunk) => {
      liveController = controller
      pass('onResponseData', [controller, chunk])
    },
    onResponseEnd: (controller, trailers) => {
      liveController = controller
      finish('onResponseEnd', [controller, trailers])
    },
    onResponseError: (controller, error) => {
      if (terminated) return
      liveController = controller
      cut(`transport error: ${error instanceof Error ? error.message : String(error)}`)
      finish('onResponseError', [controller, error])
    },
    onResponseStarted: () => {
      if (terminated) return
      disarm()
      forward('onResponseStarted', [])
    },
    onBodySent: (chunk) => pass('onBodySent', [chunk]),
    onRequestSent: () => pass('onRequestSent', []),
  }
}
