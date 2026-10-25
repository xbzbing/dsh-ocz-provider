/**
 * Acceptance for the exit-verdict behaviours: drives the REAL path —
 * ZenAdapter through a REAL PoolRoutingDispatcher over a REAL ExitPool —
 * against two exits of the operator's own subscription, so the verdicts are
 * the ones the plugin will meet in the field:
 *
 *  1. a LIVE exit whose IP OpenCode flags    -> the abuse 403 must bench that
 *     row for the long window and record the reason (`note: 'abusive'`);
 *  2. a RETIRED local port (no listener)     -> the connect failure must strike
 *     it dead, and the trusted-admission fallback (markUnverified) must NOT
 *     re-arm it (markUnverified is not a promotion).
 *
 * The pool and dispatcher are the probe's own; the running host is untouched.
 *
 * Run: node test/live-pool-verdicts-e2e.mts
 * Env: PROBE_FLAGGED (comma-separated candidates, default the three local
 *      ports in FLAGGED below — only an exit refused by BOTH origins qualifies:
 *      one refused by a single door is a SUCCESS for the ladder and must not be
 *      benched),
 *      PROBE_CORPSE  (default socks5://127.0.0.1:30032 — retired port)
 */
import * as undici from 'undici'

import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import { PoolRoutingDispatcher } from '../src/pool/dispatcher.ts'
import { createRotateDelegate, setRotateDelegate } from '../src/pool/rotate.ts'

/** Candidate exits refused by BOTH origins, tried in order: the subscription's
 *  nodes flap, so the first one that answers must not end the run. */
const FLAGGED = (process.env.PROBE_FLAGGED ?? 'socks5://127.0.0.1:30024,socks5://127.0.0.1:30004,socks5://127.0.0.1:30001').split(',')
const CORPSE = process.env.PROBE_CORPSE ?? 'socks5://127.0.0.1:30032'
const MODEL = 'mimo-v2.6-flash-free'

function node(id: string, protocol: ExitNode['protocol']): ExitNode {
  return { id, protocol, source: 'subscription', pinned: false, exitIP: '', exitLocation: '', latencyMs: 100, quality: 'A', addedAt: 0 }
}

/** One real adapter request through the pool with `id` pinned. */
async function requestThrough(pool: ExitPool, id: string): Promise<{ chunks: string[]; finish: string; wire: string[] }> {
  pool.pin(id)
  const router = new PoolRoutingDispatcher({ pool, undici, proxyHosts: ['opencode.ai'], localFallback: false })
  const previous = undici.getGlobalDispatcher()
  const realFetch = globalThis.fetch
  undici.setGlobalDispatcher(router)
  globalThis.fetch = undici.fetch
  const wireFetch = globalThis.fetch
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const response = await wireFetch(input, init)
    wire.push(`${response.status} ${url.replace('https://opencode.ai', '')}`)
    return response
  }
  const chunks: string[] = []
  const wire: string[] = []
  let finish = 'no-finish'
  try {
    const adapter = new ZenAdapter({
      list: () => [MODEL],
      decision: () => ({ allowed: true, source: 'probe', known: true }),
      reasoningCapability: () => undefined,
      limits: () => undefined,
      modalities: () => undefined,
    } as never, {})
    const controller = new AbortController()
    const killer = setTimeout(() => controller.abort(new Error('probe timeout')), 60_000)
    try {
      for await (const chunk of adapter.stream({
        provider: 'oc2dsh', model: MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        maxTokens: 8, signal: controller.signal,
      } as never)) {
        if (chunk.type === 'finish') {
          finish = chunk.reason.kind === 'error' ? `${chunk.reason.failure.code}` : 'ok'
        } else {
          chunks.push(chunk.type)
        }
      }
    } finally {
      clearTimeout(killer)
      try { controller.abort(new Error('done')) } catch { /* already aborted */ }
    }
  } finally {
    undici.setGlobalDispatcher(previous)
    globalThis.fetch = realFetch
    await router.destroy().catch(() => {})
  }
  return { chunks, finish, wire }
}

function report(label: string, pool: ExitPool, id: string, extra = ''): void {
  const entry = pool.list().find((row) => row.id === id)
  const health = entry?.health
  const coolingMs = health === undefined ? 0 : Math.max(0, health.cooldownUntil - Date.now())
  console.log(
    `${label}\n` +
    `  state=${health?.state ?? '?'} usable=${pool.isUsable(id, MODEL)} note="${health?.note ?? ''}" ` +
    `cooldown=${coolingMs === 0 ? 'none' : `${Math.round(coolingMs / 60_000)}min`}` +
    `${extra === '' ? '' : `\n  ${extra}`}`,
  )
}

// --- 1. a live exit whose IP the lane flags ---------------------------------
{
  let proven = ''
  for (const candidate of FLAGGED) {
    const pool = new ExitPool({ poolSize: 10 })
    pool.add(node(candidate, 'socks5'))
    setRotateDelegate(createRotateDelegate(pool, { maxAttempts: 2 }))
    try {
      const { finish, wire } = await requestThrough(pool, candidate)
      report(`1) flagged exit ${candidate}`, pool, candidate, `lane verdict: ${finish} · wire: ${wire.join(' | ') || 'none'}`)
      const health = pool.list()[0]!.health
      if (finish !== 'AUTH') continue // refused by one door only (the ladder won), or unreachable: try the next
      proven = candidate
      if (health.note === 'abusive' && !pool.isUsable(candidate, MODEL)) {
        console.log('  ok: benched for the long window with note=abusive, and unusable for pick()')
      } else {
        console.log('  FAIL: the row was not benched with the reason recorded')
      }
      break
    } finally {
      setRotateDelegate(null)
    }
  }
  if (proven === '') console.log('  (no candidate answered the abuse refusal from both origins right now)')
}

// --- 2. a retired local port ------------------------------------------------
{
  const pool = new ExitPool()
  pool.add(node(CORPSE, 'socks5'))
  setRotateDelegate(createRotateDelegate(pool, { maxAttempts: 1 }))
  try {
    const { finish, wire } = await requestThrough(pool, CORPSE)
    const afterFailure = pool.list()[0]!.health.state
    // The trusted-admission fallback runs on every re-admission round:
    pool.markUnverified(CORPSE)
    const afterReadmit = pool.list()[0]!.health.state
    report(`2) retired port ${CORPSE}`, pool, CORPSE, `lane verdict: ${finish} · wire: ${wire.join(' | ') || 'none'}`)
    console.log(`  state after the failure: ${afterFailure} (expected dead)`)
    console.log(`  state after markUnverified (the re-admission round): ${afterReadmit} (expected dead, NOT unknown)`)
    if (afterFailure !== 'dead' || afterReadmit !== 'dead' || pool.isUsable(CORPSE, MODEL)) {
      console.log('  FAIL: the corpse was re-armed')
    } else {
      console.log('  ok: a corpse stays dead until a probe proves it alive')
    }
  } finally {
    setRotateDelegate(null)
  }
}
