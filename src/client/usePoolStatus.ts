/**
 * React binding for the shared /status poller (pool-status-store.ts). Every
 * mounted caller registers its wanted interval; the store polls at the
 * fastest one, so the card and the footer entry never race each other.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { postBridge } from './bridge-client.ts'
import { createPoolStatusStore, type PoolStatusState, type PoolStatusStore } from './pool-status-store.ts'
import type { PoolStatusView } from './types.ts'

let shared: PoolStatusStore | null = null

/** The page-wide store, created on first use with the browser environment. */
function poolStatusStore(): PoolStatusStore {
  shared ??= createPoolStatusStore({
    fetchStatus: (signal) => postBridge<PoolStatusView>('/status', {}, { signal }),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    isHidden: () => document.hidden,
    onVisibilityChange: (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
    now: () => Date.now(),
  })
  return shared
}

/**
 * Subscribe to the pool status.
 * @param interval - this caller's poll interval in ms, or a function of the
 *   current status (e.g. faster while probing); null = read only, no polling.
 * @returns the shared state plus a forced refresh.
 */
export function usePoolStatus(
  interval: number | null | ((status: PoolStatusView | null) => number | null),
): PoolStatusState & { refresh: () => Promise<void> } {
  const store = poolStatusStore()
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const intervalMs = typeof interval === 'function' ? interval(state.status) : interval
  const key = useRef<symbol | null>(null)
  key.current ??= Symbol('pool-status')
  useEffect(() => {
    const id = key.current!
    if (intervalMs === null) store.removeRate(id)
    else store.setRate(id, intervalMs)
  }, [store, intervalMs])
  useEffect(() => () => store.removeRate(key.current!), [store])
  return { ...state, refresh: store.refresh }
}
