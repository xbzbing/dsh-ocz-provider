/**
 * IP-5 live-apply tests: the apply controller over the DSH 0.1.7 settings
 * model — a stable volatile reference plus `loader/volatile-update` instead of
 * the 0.1.1 `ctx.settings.register()/watch()` scope. Boot-time enable,
 * event-driven reconfigure (enabled flip included) and the section-shape
 * mapping from either layer's spelling. The real startIpPool is replaced
 * through the assemble seam, so no undici or global dispatcher is ever
 * installed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyIpPoolSettings, type AssembleIpPool } from '../src/ip-pool-settings/apply.ts'
import { IP_POOL_NAMESPACE, resolveIpPoolSettings, type AnyIpPoolSection, type IpPoolSettings, type VolatileRef } from '../src/ip-pool-settings/namespace.ts'
import { IP_POOL_BRIDGE_PREFIX } from '../src/ip-pool-settings/bridge.ts'
import { resolveConfig, type OrdinaryPluginConfig } from '../src/config.ts'
import type { PluginContext } from '../src/index.ts'
import { UsageStore } from '../src/pool/usage-store.ts'

/** Recorded assembly + reconfigure calls (reset per test). */
let starts: Array<{ config: Record<string, unknown> }> = []
let reconfigures: Array<Record<string, unknown>> = []

function resetCalls(): void {
  starts = []
  reconfigures = []
}

/** Test assembly seam: a runtime face with just what apply.ts touches. */
const assemble: AssembleIpPool = async (config) => {
  const runtime = {
    pool: { snapshot: () => ({ total: 1 }), targetSize: 20, list: () => [], has: () => true },
    installer: { enabled: false, install() { this.enabled = true }, disable() { this.enabled = false }, dispose() {} },
    prober: { stats: { queued: 0, inFlight: 0, enqueued: 0, completed: 0 }, setMaxConcurrent() {} },
    refill: null,
    subscriptions: null,
    reconfigure: async (next: Record<string, unknown>) => { reconfigures.push(next) },
    probeAll: async () => 0,
    probeExit: async () => 1,
    refillNow: async () => {},
    refreshSubscriptions: async () => {},
    dispose: async () => {},
  }
  starts.push({ config: config as Record<string, unknown> })
  return runtime as never
}

/** The ordinary half of a config, as the Loader would resolve it. */
const ordinary = (over: Partial<OrdinaryPluginConfig> = {}): OrdinaryPluginConfig =>
  resolveConfig({ ...over } as never)

/**
 * A DSH 0.1.7-shaped host: the Loader hands `apply()` a stable volatile
 * reference, commits a settings save into it, and announces it with
 * `loader/volatile-update`. No `register`, no `watch` — the 0.1.7 contract.
 */
function makeVolatileHost(initial?: AnyIpPoolSection) {
  let current: IpPoolSettings = resolveIpPoolSettings(initial)
  const listeners = new Set<() => void>()
  const ref: VolatileRef<IpPoolSettings> = { get: () => current }

  const ctx: PluginContext = {
    logger: { info() {}, warn() {}, error() {} },
    on(event: string, listener: () => void) {
      assert.equal(event, 'loader/volatile-update')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  return {
    ctx,
    ref,
    get value(): IpPoolSettings { return current },
    /** Simulate a settings-page save: commit into the ref, then announce. */
    commit(next: AnyIpPoolSection): void {
      current = resolveIpPoolSettings({ ...current, ...next })
      for (const listener of [...listeners]) listener()
    },
  }
}

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

test('edits during pool startup share one runtime and apply the latest value', async () => {
  const host = makeVolatileHost({ enabled: true })
  let release = (): void => {}
  const gate = new Promise<void>((done) => { release = done })
  let starts = 0
  const applied: unknown[] = []
  applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble: async () => {
    starts++
    await gate
    return { reconfigure: async (config: unknown) => { applied.push(config) }, dispose: async () => {} } as never
  } })
  host.commit({ enabled: true, manual: ['http://127.0.0.1:7897'] })
  host.commit({ enabled: false })
  release()
  await tick()
  assert.equal(starts, 1)
  assert.ok(applied.length > 0)
  for (const config of applied as Array<{ ipPool: { enabled: boolean; manual: string[] } }>) {
    assert.equal(config.ipPool.enabled, false)
    assert.deepEqual(config.ipPool.manual, ['http://127.0.0.1:7897'])
  }
})

test('unloading while the pool starts disposes the late runtime', async () => {
  const host = makeVolatileHost({ enabled: true })
  const effects: Array<() => void> = []
  host.ctx.effect = (fn) => { effects.push(fn()) }
  let release = (): void => {}
  const gate = new Promise<void>((done) => { release = done })
  let disposed = false
  const controller = applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble: async () => {
    await gate
    return { reconfigure: async () => { assert.fail('a disposed plugin must not reconfigure') }, dispose: async () => { disposed = true } } as never
  } })
  for (const dispose of effects) dispose()
  release()
  await tick()
  assert.equal(disposed, true)
  assert.equal(controller.runtime, null)
})

test('the served namespace is the Loader entry id, not a hand-registered "ip-pool"', () => {
  assert.equal(IP_POOL_NAMESPACE, 'opencode-zen')
})

test('disabled at boot: nothing assembles', async () => {
  resetCalls()
  const host = makeVolatileHost()
  const controller = applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble })
  await tick(20)
  assert.equal(starts.length, 0)
  assert.equal(controller.runtime, null)
})

test('boot-enabled: runtime assembles once from the resolved volatile value', async () => {
  resetCalls()
  const host = makeVolatileHost({ enabled: true, manual: ['http://1.1.1.1:1'] })
  const controller = applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble })
  await tick(30)
  assert.equal(starts.length, 1)
  assert.ok(controller.runtime !== null)
  const passed = starts[0]!.config as { ipPool?: { manual?: string[] } }
  assert.deepEqual(passed.ipPool?.manual, ['http://1.1.1.1:1'])
})

test('a persisted enabled:true assembles at boot even with a disabled entry config', async () => {
  // The old namespace model got this for free (register() took the persisted
  // document as its base). The volatile reference carries the same fact, and
  // reading only the entry config would strand the pool until the next save.
  resetCalls()
  const host = makeVolatileHost({ enabled: true })
  applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble })
  await tick(30)
  assert.equal(starts.length, 1)
})

test('settings-page enable: volatile-update assembles, later commits reconfigure live', async () => {
  resetCalls()
  const host = makeVolatileHost()
  const controller = applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble })
  await tick(10)
  assert.equal(starts.length, 0)

  host.commit({ enabled: true, manual: ['http://2.2.2.2:2'], maxConcurrentProbes: 5 })
  await tick(30)
  assert.equal(starts.length, 1, 'enable commit assembles the runtime')
  assert.ok(controller.runtime !== null)

  // A later commit (no enable flip) goes through reconfigure, never re-assembles.
  const before = starts.length
  host.commit({ pinnedExitId: 'http://127.0.0.1:7897', pinnedStrict: true })
  await tick(30)
  assert.equal(starts.length, before, 'no re-assembly without an enable flip')
  assert.equal(reconfigures.length, 2)
  const applied = reconfigures[1]!.ipPool as Record<string, unknown>
  assert.equal(applied.pinnedExitId, 'http://127.0.0.1:7897')
  assert.equal(applied.pinnedStrict, true)
})

test('every field the runtime reads survives the settings->config round trip', async () => {
  // Reconfigure consumes this shape, so a field dropped by toIpPoolConfig()
  // resets to its default on every commit — silently, and only in adapter
  // mode, which is the shipped default.
  resetCalls()
  const host = makeVolatileHost()
  applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble })
  host.commit({
    enabled: true,
    maxConcurrentProbes: 7,
    subscription: { urls: ['https://x/y'], refreshMs: 60_000 },
  })
  await tick(30)
  const applied = starts[0]!.config.ipPool as Record<string, unknown>
  assert.equal(applied.maxConcurrentProbes, 7, 'probe concurrency must reach the runtime')
  // The commit names no UA, so this is the schema DEFAULT reaching the runtime
  // (the literal ages with the airport's floor; see DEFAULT_SUBSCRIPTION_USER_AGENT).
  assert.deepEqual(applied.subscription, { refreshMs: 60_000, userAgent: 'clash-verge/v2.4.2' }, 'subscription interval + fetch UA must reach the runtime')
  assert.deepEqual(applied.subscriptions, ['https://x/y'])
})

test('subscription urls from the settings shape flow into the config assembly', async () => {
  resetCalls()
  const host = makeVolatileHost()
  applyIpPoolSettings(host.ctx, ordinary(), () => host.ref.get(), host.ctx.logger, { assemble })
  host.commit({ enabled: true, subscription: { urls: ['https://x/y'] } })
  await tick(30)
  assert.equal(starts.length, 1)
  const passed = starts[0]!.config as { ipPool?: { subscriptions?: string[] } }
  assert.deepEqual(passed.ipPool?.subscriptions, ['https://x/y'])
})

test('an absent volatile reference degrades to defaults instead of throwing', async () => {
  // A host predating the `Config` export hands over no reference at all.
  resetCalls()
  const host = makeVolatileHost()
  const controller = applyIpPoolSettings(host.ctx, ordinary(), () => undefined, host.ctx.logger, { assemble })
  await tick(20)
  assert.equal(controller.settings().enabled, false)
  assert.equal(starts.length, 0)
})

test('the settings page is claimed lazily and never gates the fiber', async () => {
  // `settings` stays out of `inject`: SettingsForms needs a profileContext and
  // ships disabled headless, so demanding it up front kept the provider route
  // from ever activating. configure({ auto: false }) is requested on demand.
  resetCalls()
  const configureCalls: Array<unknown> = []
  const injections: string[][] = []
  const host = makeVolatileHost()
  const ctx: PluginContext = {
    logger: { info() {}, warn() {}, error() {} },
    on: host.ctx.on,
    inject(services, callback) {
      injections.push([...services])
      if (services.includes('settings')) {
        callback({
          logger: { info() {}, warn() {}, error() {} },
          settings: { configure: (presentation: unknown) => { configureCalls.push(presentation); return () => {} } },
        })
      }
    },
  }
  applyIpPoolSettings(ctx, ordinary(), () => undefined, ctx.logger, { assemble })
  await tick(10)
  assert.ok(injections.some((list) => list.includes('settings')), 'settings is requested on demand')
  assert.equal(injections.some((list) => list.includes('webServer')), true, 'webServer is still requested for the bridge')
  assert.deepEqual(configureCalls, [{ auto: false }], 'the plugin serves its own IP 池 card')
})

test('the bridge wires the modal 固定 button into the plugin\'s own settings namespace', async () => {
  // The stats modal is mounted on the sidebar footer, outside any settings
  // form, so it has no ConfigForm to mutate through: its 固定 button rides the
  // bridge, and the host side of that route has to write `pinnedExitId` into
  // THIS plugin's namespace with the field-name-prefixed path the card uses.
  resetCalls()
  const mutations: Array<{ ns: string; ops: unknown }> = []
  const pinCalls: string[] = []
  const routes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }> = []
  const host = makeVolatileHost({ enabled: true })
  const runtimeAssemble: AssembleIpPool = async () => ({
    pool: {
      snapshot: () => ({ total: 2, pinned: '' }),
      targetSize: 20,
      list: () => [],
      has: () => true,
      pinnedId: '',
      pin: (id: string) => { pinCalls.push(id); return true },
      unpin: () => { pinCalls.push('') },
      pinLocal: () => { pinCalls.push('local') },
      demoteToTail: () => true,
    },
    installer: { enabled: true, install() {}, disable() {}, dispose() {} },
    prober: { stats: { queued: 0, inFlight: 0, enqueued: 0, completed: 0 }, setMaxConcurrent() {} },
    refill: null,
    subscriptions: null,
    reconfigure: async () => {},
    probeAll: async () => 0,
    probeExit: async () => 1,
    refillNow: async () => {},
    refreshSubscriptions: async () => {},
    dispose: async () => {},
  }) as never
  const ctx: PluginContext = {
    logger: { info() {}, warn() {}, error() {} },
    on: host.ctx.on,
    inject(services, callback) {
      const logger = { info() {}, warn() {}, error() {} }
      if (services.includes('settings')) {
        callback({
          logger,
          settings: {
            configure: () => () => {},
            mutate: async (ns: string, ops: unknown) => { mutations.push({ ns, ops }) },
          },
        })
      }
      if (services.includes('webServer')) {
        callback({
          logger,
          webServer: { register: (route: never) => { routes.push(route); return () => {} } },
        })
      }
    },
  }
  applyIpPoolSettings(ctx, ordinary(), () => host.ref.get(), ctx.logger, { assemble: runtimeAssemble })
  await tick(30)

  const exitRoute = routes.find((route) => route.path === `${IP_POOL_BRIDGE_PREFIX}/exit`)
  assert.ok(exitRoute, 'the /exit route is mounted with the rest of the bridge')

  let written: { status?: number; body?: unknown } = {}
  const res = {
    writeHead(status: number) { written.status = status },
    end(body: string) { written.body = JSON.parse(body) },
  }
  const post = (body: unknown): unknown => ({
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  })
  await exitRoute.handler(post({ action: 'pin', exitId: '127.0.0.1:30033' }), res)
  assert.equal(written.status, 200)
  assert.equal((written.body as { ok: boolean }).ok, true)
  assert.deepEqual(mutations, [
    { ns: IP_POOL_NAMESPACE, ops: [{ op: 'set', path: ['ipPool', 'pinnedExitId'], value: '127.0.0.1:30033' }] },
  ], 'the write lands in this entry, on the same path the settings card writes')
  assert.deepEqual(pinCalls, ['127.0.0.1:30033'], 'and the live pool is pinned in the same request')

  // Unpin is the unset spelling, so no stored empty string shadows the default.
  written = {}
  await exitRoute.handler(post({ action: 'unpin' }), res)
  assert.deepEqual(mutations[1], {
    ns: IP_POOL_NAMESPACE,
    ops: [{ op: 'unset', path: ['ipPool', 'pinnedExitId'] }],
  })
})

test('the bridge wires the 清空 button to the same ledger the adapter writes', async () => {
  // Live request 2026-10-14: 总量统计保留 90 天自然过期，增加一个清空的功能按钮.
  // The route has to reach the SAME store (index.ts owns the singleton) and it
  // must work with the pool OFF — the ledger records every request regardless.
  resetCalls()
  const dir = mkdtempSync(join(tmpdir(), 'apply-usage-clear-'))
  const usagePath = join(dir, 'usage.json')
  const store = new UsageStore({ path: usagePath, flushMs: 0 })
  store.record('local', { inputTokens: 9, outputTokens: 4 }, { session: 'ses_hi', label: 'hi' })
  await store.flush()
  const routes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }> = []
  const host = makeVolatileHost({ enabled: false })
  const ctx: PluginContext = {
    logger: { info() {}, warn() {}, error() {} },
    on: host.ctx.on,
    inject(services, callback) {
      if (services.includes('webServer')) {
        callback({
          logger: { info() {}, warn() {}, error() {} },
          webServer: { register: (route: never) => { routes.push(route); return () => {} } },
        })
      }
    },
  }
  try {
    applyIpPoolSettings(ctx, ordinary(), () => host.ref.get(), ctx.logger, { usage: store })
    await tick(30)

    const usageRoute = routes.find((route) => route.path === `${IP_POOL_BRIDGE_PREFIX}/usage`)
    assert.ok(usageRoute, 'the /usage route is mounted with the rest of the bridge')

    let written: { status?: number; body?: unknown } = {}
    const res = {
      writeHead(status: number) { written.status = status },
      end(body: string) { written.body = JSON.parse(body) },
    }
    const post = (body: unknown): unknown => ({
      method: 'POST',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3080' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    })
    await usageRoute.handler(post({ action: 'reset' }), res)
    assert.equal(written.status, 200)
    assert.deepEqual(written.body, { ok: true, value: { cleared: true } })
    assert.equal(store.totals().requests, 0, 'the modal cleared the live ledger')
    assert.equal((JSON.parse(readFileSync(usagePath, 'utf8')) as { totals: { requests: number } }).totals.requests, 0, 'and the clear is on disk')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
