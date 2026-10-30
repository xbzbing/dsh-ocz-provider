/**
 * The one way the browser half talks to the plugin's loopback bridge: a POST
 * with a JSON body, answered by `{ok:true,value}` or `{ok:false,code,message}`.
 * Network failures and non-bridge answers fold into the same failure shape, so
 * callers branch on `ok` only. Pure apart from `fetch`, which tests inject.
 */
import { BRIDGE_PREFIX } from './types.ts'

/** A bridge answer. `code` values minted here (not by the host) start with `client-`. */
export type BridgeReply<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string }

/** The bridge routes the browser half calls. */
export type BridgeRoute = '/status' | '/models' | '/probe' | '/exit' | '/usage'

export interface PostBridgeOptions {
  signal?: AbortSignal
  /** Defaults to the global fetch. */
  fetch?: typeof fetch
}

/** POST one bridge route and normalize every outcome to a {@link BridgeReply}. */
export async function postBridge<T>(route: BridgeRoute, body: unknown = {}, options: PostBridgeOptions = {}): Promise<BridgeReply<T>> {
  const send = options.fetch ?? fetch
  let response: Response
  try {
    response = await send(`${BRIDGE_PREFIX}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (err) {
    const aborted = options.signal?.aborted === true || (err instanceof Error && err.name === 'AbortError')
    return { ok: false, code: aborted ? 'client-aborted' : 'client-network', message: err instanceof Error ? err.message : String(err) }
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return { ok: false, code: 'client-bad-response', message: `HTTP ${response.status}` }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, code: 'client-bad-response', message: `HTTP ${response.status}` }
  }
  const record = parsed as Record<string, unknown>
  if (record.ok === true) return { ok: true, value: record.value as T }
  if (record.ok === false) {
    return {
      ok: false,
      code: typeof record.code === 'string' ? record.code : 'unknown',
      message: typeof record.message === 'string' ? record.message : '',
    }
  }
  // The route guard answers 403/405 as `{error}` without the ok envelope.
  const message = typeof record.error === 'string' ? record.error : `HTTP ${response.status}`
  return { ok: false, code: `client-http-${response.status}`, message }
}

/**
 * The text to show for a failed reply: the host's own message when the host
 * produced the failure (e.g. `exit-unreachable`), the caller's localized
 * fallback for transport-level failures.
 */
export function bridgeErrorText(reply: { code: string; message: string }, fallback: string): string {
  if (reply.code.startsWith('client-') || reply.message.trim() === '') return fallback
  return reply.message
}

/**
 * One row action on the exit tables. `pin-local` is the 本机 row's button: the
 * host owns the sentinel value, so the browser names the intent, never the
 * spelling. `rotate` deletes nothing: a reserve takes the slot, or the row
 * sinks to the pool tail.
 */
export type ExitAction = 'pin' | 'pin-local' | 'unpin' | 'rotate'

/** The /exit reply value. */
export interface ExitActionResult {
  pinned?: string
  local?: boolean
  persisted?: boolean
  /** The pinned row was relabelled to the protocol its listener speaks. */
  corrected?: string
  /** A reserve was promoted into the rotated row's slot. */
  promoted?: boolean
  /** A rotation round held the rebuild mutex: nothing moved. */
  busy?: boolean
}

/**
 * POST /exit. Pins go through here (never a direct settings write) because
 * the host probes the listener, relabels a protocol mismatch, refuses an
 * unreachable port and revives a dead row before it pins.
 */
export function exitAction(action: ExitAction, exitId?: string, options?: PostBridgeOptions): Promise<BridgeReply<ExitActionResult>> {
  const body = action === 'pin-local' || action === 'unpin' ? { action } : { action, exitId }
  return postBridge<ExitActionResult>('/exit', body, options)
}

/** /probe scopes: every exit, one exit, or a subscription re-pull. */
export type ProbeScope = { scope: 'all' | 'subscription' } | { scope: 'exit'; exitId: string }

/** POST /probe. */
export function probeAction(scope: ProbeScope, options?: PostBridgeOptions): Promise<BridgeReply<unknown>> {
  return postBridge('/probe', scope, options)
}
