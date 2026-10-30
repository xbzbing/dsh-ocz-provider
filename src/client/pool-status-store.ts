/**
 * One shared /status poller for every browser surface (settings card, footer
 * entry, stats modal). At most one request is in flight; a forced refresh
 * aborts and supersedes the running one, and a sequence guard drops any
 * answer older than the latest request. The interval is the fastest
 * subscriber's, and polling pauses while the document is hidden. Pure: the
 * environment (fetch, timers, visibility) is injected.
 */
import type { BridgeReply } from './bridge-client.ts'
import type { PoolStatusView } from './types.ts'

export interface PoolStatusState {
  /** The last good snapshot (kept through later failures). */
  status: PoolStatusView | null
  /** The latest refresh failed; `status` is then stale. */
  error: { code: string; message: string } | null
  /** Epoch ms of the last good answer (0 = none yet). */
  updatedAt: number
}

export interface PoolStatusEnv {
  fetchStatus(signal: AbortSignal): Promise<BridgeReply<PoolStatusView>>
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  isHidden(): boolean
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibilityChange(listener: () => void): () => void
  now(): number
}

export interface PoolStatusStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): PoolStatusState
  /** Fetch now, superseding any request in flight. */
  refresh(): Promise<void>
  /** Register or update one subscriber's poll interval. */
  setRate(key: symbol, ms: number): void
  removeRate(key: symbol): void
}

export function createPoolStatusStore(env: PoolStatusEnv): PoolStatusStore {
  let state: PoolStatusState = { status: null, error: null, updatedAt: 0 }
  const listeners = new Set<() => void>()
  const rates = new Map<symbol, number>()
  let seq = 0
  let inFlight: { controller: AbortController; promise: Promise<void> } | null = null
  let timer: unknown = null
  let detachVisibility: (() => void) | null = null

  const emit = (): void => { for (const listener of [...listeners]) listener() }

  const clearTimer = (): void => {
    if (timer !== null) env.clearTimer(timer)
    timer = null
  }

  const schedule = (): void => {
    clearTimer()
    if (rates.size === 0 || env.isHidden()) return
    timer = env.setTimer(() => { timer = null; void poll() }, Math.min(...rates.values()))
  }

  const start = (): Promise<void> => {
    inFlight?.controller.abort()
    const mine = ++seq
    const controller = new AbortController()
    const promise = (async () => {
      let reply: BridgeReply<PoolStatusView>
      try {
        reply = await env.fetchStatus(controller.signal)
      } catch (err) {
        reply = { ok: false, code: 'client-network', message: err instanceof Error ? err.message : String(err) }
      }
      if (mine !== seq) return
      inFlight = null
      if (reply.ok && reply.value != null) {
        state = { status: reply.value, error: null, updatedAt: env.now() }
      } else if (!reply.ok) {
        state = { ...state, error: { code: reply.code, message: reply.message } }
      } else {
        state = { ...state, error: { code: 'client-bad-response', message: '' } }
      }
      emit()
      schedule()
    })()
    inFlight = { controller, promise }
    return promise
  }

  /** A timer tick joins the request in flight instead of starting another. */
  const poll = (): Promise<void> => inFlight?.promise ?? start()

  const onVisibility = (): void => {
    if (env.isHidden()) clearTimer()
    else void poll()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => state,
    refresh: () => start(),
    setRate(key, ms) {
      const first = rates.size === 0
      rates.set(key, ms)
      if (!first) {
        if (inFlight === null) schedule()
        return
      }
      detachVisibility = env.onVisibilityChange(onVisibility)
      if (env.isHidden()) return
      void poll()
    },
    removeRate(key) {
      if (!rates.delete(key)) return
      if (rates.size > 0) {
        if (inFlight === null) schedule()
        return
      }
      clearTimer()
      detachVisibility?.()
      detachVisibility = null
    },
  }
}
