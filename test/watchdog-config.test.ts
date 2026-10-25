import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers'

import { apply, Config, type PluginContext } from '../src/index.ts'
import { ModelCatalog } from '../src/adapter/catalog.ts'
import { resolveIpPoolSettings } from '../src/ip-pool-settings/namespace.ts'
import { WATCHDOG_FIRST_MESSAGE, WATCHDOG_IDLE_MESSAGE, type ZenAdapter } from '../src/adapter/zen-adapter.ts'
import type { FinishReason } from '../src/adapter/events.ts'
import { usageStore } from '../src/pool/usage-store.ts'

/**
 * These scenarios drive the PRODUCTION entry — `apply()` registers the real
 * adapter AND installs the real on-disk ledger — so the plugin's state root is
 * pointed at a scratch directory first. The redirect is not cosmetic: without
 * it every run of this file wrote three rows into the user's own 流量统计,
 * because the sample request below is a genuine one. Label "hi" (its first
 * user turn), no host session id (so the adapter mints the id from the
 * conversation seed), no pool routing (本机/local), and a watchdog TIMEOUT
 * whose zero-usage error still counts as one request — with `Date` mocked to 0
 * the minted id reads `ses_fffffffffffe…`, i.e. the 36 phantom "hi" requests
 * the operator found in the modal (live 2026-10-14).
 *
 * Imports are hoisted, so this assignment lands after `src/index.ts` was
 * evaluated; the store resolves its path lazily for exactly this reason
 * (src/paths.ts, UsageStore#path).
 */
const scratch = mkdtempSync(join(tmpdir(), 'oc2dsh-watchdog-'))
process.env.OC2DSH_HOME = scratch

/** The scratch ledger's session rows (flush first: the debounce is 10s). */
async function ledgerSessions(): Promise<Record<string, { label: string; totals: { requests: number; totalTokens: number } }>> {
  await usageStore.flush()
  try {
    return JSON.parse(readFileSync(join(scratch, 'usage.json'), 'utf8')).sessions
  } catch {
    return {} // nothing recorded yet — flush() is a no-op while clean
  }
}

/** How many "hi" requests the scratch ledger holds so far. */
async function hiRequests(): Promise<number> {
  const row = Object.values(await ledgerSessions()).find((entry) => entry.label === 'hi')
  return row?.totals.requests ?? 0
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * Let the adapter reach its peek loop before the clock is advanced.
 *
 * One `flush()` is not enough and never was: the timer is armed at the first
 * PULL of the stream, several async hops after the fetch mock resolves
 * (pi-ai's SDK handshake, then the attempt's own setup), so the number of
 * immediate turns it needs depends on how much else the process is doing. The
 * relay's supervision added exactly one hop and this fixed-1 flush lost the
 * race: the deadline was re-armed at the already-advanced clock, never fired,
 * and the scenario read `finish === undefined`. A fixed handful of turns is
 * deterministic and asserts nothing extra — the window assertions below are
 * unchanged.
 */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await flush()
}

for (const scenario of [
  { name: 'first event', model: 'big-pickle', headers: false, window: 300 },
  { name: 'chat body idle', model: 'big-pickle', headers: true, window: 900 },
  { name: 'Responses body idle', model: 'muse-spark-1.2-contributor-free', headers: true, window: 1800 },
]) {
  test(`plugin entry applies the configured ${scenario.name} window`, { timeout: 5000 }, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
    t.mock.method(ModelCatalog.prototype, 'start', async () => {})
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    let requested!: () => void
    const requestStarted = new Promise<void>((resolve) => { requested = resolve })
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
      requested()
      if (!scenario.headers) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
        })
      }
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } }), {
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    let adapter: ZenAdapter | undefined
    const disposers: Array<() => void> = []
    const ctx: PluginContext = {
      logger: { info() {}, warn() {}, error() {} },
      llm: { registerAdapter(_providers, registered) { adapter = registered as ZenAdapter } },
      effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose },
    }
    const controller = new AbortController()
    t.after(() => {
      controller.abort()
      body?.close()
      for (const dispose of disposers) dispose()
    })
    apply(ctx, {
      ...Config({ firstEventMs: 300, bodyIdleMs: 900, responsesBodyIdleMs: 1800 }),
      ipPool: { get: () => resolveIpPoolSettings({ enabled: false }) },
    })
    assert.ok(adapter, 'the production plugin entry must register an adapter')
    const before = await hiRequests()
    const result: { finish?: FinishReason } = {}
    const pending = (async () => {
      for await (const chunk of adapter.stream({
        provider: 'oc2dsh', model: scenario.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        signal: controller.signal,
      })) {
        if (chunk.type === 'finish') result.finish = chunk.reason
      }
    })()
    await requestStarted
    await settle()
    // Advance the real registered adapter's clock, with transport kept silent.
    t.mock.timers.tick(scenario.window - 1)
    await settle()
    const earlyFinish = result.finish
    assert.equal(earlyFinish, undefined, 'the configured deadline must not fire early')
    t.mock.timers.tick(1)
    await settle()
    const finish = result.finish
    assert.equal(finish?.kind, 'error')
    if (finish?.kind === 'error') {
      assert.equal(finish.failure.code, 'TIMEOUT')
      assert.equal(finish.failure.message, scenario.headers ? WATCHDOG_IDLE_MESSAGE : WATCHDOG_FIRST_MESSAGE)
    }
    await pending
    // The sample request above went through the real entry, so it is accounted
    // for real — in the SCRATCH ledger. Both halves are asserted: the redirect
    // (this file can never touch the operator's stats again) and the row shape
    // that made the phantom "hi" session look mysterious in the modal.
    assert.ok(usageStore.path.startsWith(scratch), 'the state root is redirected')
    const hi = Object.values(await ledgerSessions()).find((row) => row.label === 'hi')
    assert.ok(hi, 'the watchdog sample request is accounted in the scratch ledger')
    assert.equal(hi.totals.requests, before + 1, 'one timed-out attempt is one request')
    assert.equal(hi.totals.totalTokens, 0, 'a watchdog timeout carries no usage')
  })
}
