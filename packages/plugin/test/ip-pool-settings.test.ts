/**
 * IP-5 host-side tests: the settings namespace (schema defaults, value
 * mapping), the loopback-guarded bridge (status view, probe scopes, guard
 * semantics, envelopes) and the apply controller's live reconfigure path.
 * No real network, no global dispatcher install.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IpPoolConfigSchema, resolveIpPoolSettings, resolveProbeModels, toIpPoolConfig, IP_POOL_NAMESPACE } from '../src/ip-pool-settings/namespace.ts'
import { buildStatusView, buildUsageView, isTrustedBridgeRequest, makeBridgeHandlers, makeBridgeRoutes, IP_POOL_BRIDGE_PREFIX } from '../src/ip-pool-settings/bridge.ts'
import { UsageStore } from '../src/pool/usage-store.ts'
import { DIRECT_EXIT_ID, LOCAL_EXIT_ID, usageTracker } from '../src/pool/usage.ts'
import { ExitPool, type ExitNode } from '../src/pool/pool.ts'

// -- namespace ---------------------------------------------------------------

test('ip-pool settings are served under the Loader entry id', () => {
  // DSH 0.1.7 derives the namespace from the loader entry, so it is
  // 'opencode2dsh' — not a name the plugin registers for itself.
  assert.equal(String(IP_POOL_NAMESPACE), 'opencode2dsh')
})

test('schema fills every default from an empty section', () => {
  const value = IpPoolConfigSchema({}) as Record<string, unknown>
  assert.equal(value.enabled, false)
  assert.deepEqual(value.probeModels, [])
  assert.equal(value.maxConcurrentProbes, 3)
  assert.equal(value.poolSize, 10, 'whole-pool capacity defaults to 10')
  assert.equal((value.free as Record<string, unknown>).enabled, true)
  assert.equal((value.free as Record<string, unknown>).targetSize, 20)
  assert.deepEqual((value.free as Record<string, unknown>).blockedCountries, ['CN'])
  assert.deepEqual(value.manual, [])
  assert.deepEqual((value.subscription as Record<string, unknown>).urls, [])
  // The built-in fetch UA is the airport allow-listed spelling, not 1.6.0 —
  // a real airport answers 502 Bad Gateway for the latter (docs 4.6).
  assert.equal((value.subscription as Record<string, unknown>).userAgent, 'clash-verge/v2.4.2')
  assert.equal((value.singbox as Record<string, unknown>).path, 'sing-box')
  assert.equal(value.pinnedExitId, '')
  assert.equal(value.pinnedStrict, false)
})

test('schema rejects out-of-range probe concurrency', () => {
  assert.throws(() => IpPoolConfigSchema({ maxConcurrentProbes: 9 }))
  assert.throws(() => IpPoolConfigSchema({ maxConcurrentProbes: 0 }))
})

test('a schema-resolved value keeps its nested subscription urls (legacy [] must not shadow them)', () => {
  // Regression (live 2026-10-12): the settings page saved a subscription URL,
  // the Host persisted it, and the pool still assembled with zero subscription
  // URLs — `/status` reported `subscriptions: null`, so no fetcher was ever
  // created and the card's subscription count stayed 0. `Schema.array()` hands
  // an absent array an implicit `[]`, so the resolved value ALWAYS carries the
  // legacy flat key, and `raw.subscriptions ?? raw.subscription?.urls` resolved
  // to that empty array. The value must be fed through the schema here: a raw
  // hand-written section (no flat key at all) cannot reproduce it.
  const resolved = IpPoolConfigSchema({
    subscription: { urls: ['https://sub.example.com/token'], refreshMs: 1800000 },
  } as never)
  assert.deepEqual((resolved as Record<string, unknown>).subscriptions, [], 'the flat key is present-but-empty in a served value')

  const settings = resolveIpPoolSettings(resolved as never)
  assert.deepEqual(settings.subscription.urls, ['https://sub.example.com/token'])
  assert.deepEqual(toIpPoolConfig(settings).subscriptions, ['https://sub.example.com/token'])
})

test('proxyPathPrefixes survives the schema → resolve → config round trip', () => {
  // Same round-trip discipline the rest of the section has: the routing scope
  // is read by the runtime, so a live commit must not reset it to a default.
  const configured = resolveIpPoolSettings(IpPoolConfigSchema({
    proxyHosts: ['opencode.ai'],
    proxyPathPrefixes: ['/zen/v1/', 'zen/go/v1'],
  } as never) as never)
  assert.deepEqual(configured.proxyPathPrefixes, ['/zen/v1/', 'zen/go/v1'], 'the raw entries survive resolution (normalization is the router\'s)')
  assert.deepEqual(toIpPoolConfig(configured).proxyPathPrefixes, ['/zen/v1/', 'zen/go/v1'])

  // An untouched field resolves to the empty list, which the router then
  // treats as "the default" — never as "no path is in scope".
  const untouched = resolveIpPoolSettings({})
  assert.deepEqual(untouched.proxyPathPrefixes, [])
})

test('the legacy flat spelling still carries urls when the nested list is empty', () => {  // Older compositions write the flat key only; it must keep working.
  const settings = resolveIpPoolSettings({ subscriptions: ['https://legacy.example.com/sub'] })
  assert.deepEqual(settings.subscription.urls, ['https://legacy.example.com/sub'])

  // And when the nested spelling has content it wins over a stale flat list.
  const both = resolveIpPoolSettings({
    subscriptions: ['https://stale.example.com/sub'],
    subscription: { urls: ['https://canonical.example.com/sub'], refreshMs: 60_000, userAgent: 'clash-verge/v2.0' },
  })
  assert.deepEqual(both.subscription.urls, ['https://canonical.example.com/sub'])
})

test('resolveProbeModels defaults to S3 first and dedupes user entries', () => {
  assert.deepEqual(resolveProbeModels([]), ['big-pickle'])
  assert.deepEqual(resolveProbeModels(['muse', 'muse']), ['muse'])
})

test('toIpPoolConfig maps the settings value onto the plugin config shape', () => {
  const mapped = toIpPoolConfig(IpPoolConfigSchema({
    enabled: true,
    manual: ['http://1.2.3.4:8080'],
    pinnedExitId: 'http://127.0.0.1:7897',
    pinnedStrict: true,
    maxConcurrentProbes: 7,
    poolSize: 12,
    subscription: { urls: ['https://sub.example.com/token'], refreshMs: 123_456, userAgent: 'mihomo/1.19.0' },
  }) as never)
  assert.equal(mapped.enabled, true)
  assert.deepEqual(mapped.manual, ['http://1.2.3.4:8080'])
  assert.equal(mapped.pinnedExitId, 'http://127.0.0.1:7897')
  assert.equal(mapped.pinnedStrict, true)
  assert.deepEqual(mapped.subscriptions, ['https://sub.example.com/token'])
  assert.deepEqual(mapped.probeModels, ['big-pickle'])
  assert.deepEqual(mapped.singbox, { path: 'sing-box' })
  // The runtime reads these two off the config shape (ip-pool.ts:
  // Prober construction + SubscriptionFetcher interval/UA), so dropping them
  // here would reset them to the default on every live commit.
  assert.equal(mapped.maxConcurrentProbes, 7)
  // Dropping this on a live commit would silently reset the pool capacity.
  assert.equal(mapped.poolSize, 12)
  assert.deepEqual(mapped.subscription, { refreshMs: 123_456, userAgent: 'mihomo/1.19.0' })
})

// -- bridge: status view -------------------------------------------------------

/** Minimal fake runtime face buildStatusView/probe handlers consume. */
function fakeRuntime(overrides: Record<string, unknown> = {}): unknown {
  const pool = {
    snapshot: () => ({ state: 'warning', total: 2, bySource: { free: 1, manual: 1, subscription: 0, goproxy: 0 }, availableFree: 1, pinned: 'http://10.0.0.1:3128' }),
    targetSize: 20,
    poolSize: 20,
    demoted: (id: string) => id === '1.2.3.4:8080',
    list: () => [
      {
        id: 'http://10.0.0.1:3128', source: 'manual', protocol: 'http', pinned: true,
        exitIP: '10.0.0.1', exitLocation: 'US test', latencyMs: 120, quality: 'S',
        health: { state: 'ok', cooldownUntil: 0, consecutiveLimited: 0 },
        bans: [],
      },
      {
        id: '1.2.3.4:8080', source: 'free', protocol: 'http', pinned: false,
        exitIP: '1.2.3.4', exitLocation: 'SG test', latencyMs: 410, quality: 'S',
        health: { state: 'ok', cooldownUntil: Date.now() + 60_000, consecutiveLimited: 1 },
        bans: [{ model: 'muse-spark-1.2-contributor-free', ban: { state: 'banned', bannedAt: 123, consecutiveFailures: 2 } }],
      },
    ],
    has: (id: string) => id === 'http://10.0.0.1:3128',
    passiveStats: () => ({ ok: 12, limited: 2, refused: 0, dead: 1, transport: 0 }),
    activity: (id: string) => id === 'http://10.0.0.1:3128'
      ? { lastUsedAt: 1_700_000_000_000, inFlight: 2 }
      : { lastUsedAt: 0, inFlight: 0 },
    directRequests: 7,
    rerouteSession: () => {},
  }
  return {
    pool,
    installer: { enabled: true, deferredReason: null, install() {}, disable() {}, dispose() {} },
    prober: { stats: { queued: 0, inFlight: 1, enqueued: 5, completed: 4 } },
    refill: { lastRound: { admitted: 2, rejected: 30, fetched: 1600, coarsePassed: 8, state: 'warning', at: 456 } },
    subscriptions: {
      urlCount: 2,
      state: { pendingConversion: [{}, {}], convertedAdmitted: 1, plaintextAdmitted: 0, lastFetch: 789, lastError: '' },
    },
    probeAll: async () => 2,
    probeExit: async () => 1,
    refillNow: async () => {},
    refreshSubscriptions: async () => {},
    reconfigure: async () => {},
    dispose: async () => {},
    ...overrides,
  }
}

test('status view projects the four-state machine, exits, bans and prober progress', () => {
  const view = buildStatusView(fakeRuntime() as never, true, ['opencode.ai'])
  assert.equal(view.enabled, true)
  // The routing scope is part of the answer to "what is this pool carrying?",
  // so /status must carry both halves of the rule (live 2026-10-13: host-only
  // routing silently proxied another provider's /zen/go lane).
  assert.deepEqual(view.proxyHosts, ['opencode.ai'])
  assert.deepEqual(view.proxyPathPrefixes, ['/zen/v1'], 'the path scope defaults to this plugin lane')
  assert.equal(view.state, 'warning')
  assert.equal(view.total, 2)
  assert.equal(view.availableFree, 1)
  // The whole-pool usable count must count across sources. A live profile
  // rendered the free-source subset bare as "可用 0/20" while every usable
  // exit was a subscription one, which read as "nothing is usable".
  assert.equal(view.availableTotal, 2, 'both healthy exits count, whatever their source')
  assert.equal(view.pinned?.id, 'http://10.0.0.1:3128')
  assert.equal(view.pinned?.strict, true)
  assert.equal(view.exits.length, 2)
  assert.equal(view.poolSize, 20, 'the whole-pool capacity rides the bridge (the card renders it)')
  const cooling = view.exits.find((e) => e.id === '1.2.3.4:8080')
  assert.equal(cooling?.cooling, true)
  assert.equal(cooling?.demoted, true, 'a demoted exit is projected so the table can say so')
  assert.deepEqual(cooling?.bannedModels, [{ model: 'muse-spark-1.2-contributor-free', state: 'banned', bannedAt: 123 }])
  assert.deepEqual(cooling?.passive, { ok: 12, limited: 2, refused: 0, dead: 1, transport: 0 })
  assert.deepEqual(view.prober, { queued: 0, inFlight: 1, enqueued: 5, completed: 4 })
  assert.equal(view.refill?.admitted, 2)
  // URL count only — subscription URLs never ride the bridge.
  assert.equal(view.subscription?.urlCount, 2)
  assert.equal(view.subscription?.pendingConversion, 2)
  assert.equal('urls' in (view.subscription ?? {}), false)
  // exit-stats fields: classified totals, live activity, direct fallback.
  assert.equal(view.exits[0]?.requests, 15, 'requests = the sum of the passive buckets')
  assert.equal(view.exits[0]?.lastUsedAt, 1_700_000_000_000)
  assert.equal(view.exits[0]?.inFlight, 2)
  assert.equal(view.exits[1]?.lastUsedAt, 0, 'an exit never dispatched reads 0, not NaN')
  assert.equal(view.direct.requests, 7)
})

test('status view: per-exit tokens, direct and 本机 ride the bridge', () => {
  // Tokens are attributed by the adapter into the process-lifetime tracker
  // (pool/usage.ts); the bridge only projects them. Reset keeps the
  // singleton clean for the rest of the suite.
  usageTracker.record('http://10.0.0.1:3128', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 40 })
  usageTracker.record('http://10.0.0.1:3128', { inputTokens: 20, outputTokens: 10 })
  usageTracker.record(DIRECT_EXIT_ID, { inputTokens: 7, outputTokens: 3 })
  usageTracker.record(LOCAL_EXIT_ID, { inputTokens: 5, outputTokens: 1 })
  try {
    const view = buildStatusView(fakeRuntime() as never, false, [])
    const manual = view.exits.find((e) => e.id === 'http://10.0.0.1:3128')
    assert.deepEqual(manual?.tokens, {
      requests: 2, inputTokens: 120, outputTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0, totalTokens: 180, outputMs: 0,
    })
    assert.deepEqual(view.direct.tokens, {
      requests: 1, inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10, outputMs: 0,
    })
    // 本机 merges the two local-egress buckets: pool-host fallbacks plus
    // hosts outside the proxy set. This is the row that catches a pool
    // which looks healthy while every request leaves from this machine.
    assert.deepEqual(view.local, {
      requests: 2,
      tokens: { requests: 2, inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 16, outputMs: 0 },
      lastUsedAt: view.local.lastUsedAt,
    })
    assert.ok(view.local.lastUsedAt > 0, 'the 本机 row carries its own last-used stamp')
    // A disabled stub reports zeros everywhere — no stale lifetime numbers.
    const stub = buildStatusView(null, false, [])
    assert.deepEqual(stub.direct, { requests: 0, tokens: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, outputMs: 0 } })
  } finally {
    usageTracker.reset()
  }
})

test('status view: with the free source off the badge follows the whole pool', () => {
  // Regression (live 2026-10-12): the badge came from the free-source machine
  // unconditionally, so a subscription-only profile (free disabled, 12 healthy
  // exits) read "emergency" forever — 0 free nodes against a target of 20.
  const view = buildStatusView(fakeRuntime() as never, false, [], { freeEnabled: false })
  assert.equal(view.stateBasis, 'pool')
  assert.equal(view.state, 'healthy', '2 of 2 exits are usable')

  const freeBasis = buildStatusView(fakeRuntime() as never, false, [], { freeEnabled: true })
  assert.equal(freeBasis.stateBasis, 'free')
  assert.equal(freeBasis.state, 'warning', 'the documented free-source machine is untouched')
})

test('status view: an empty pool is never "emergency" on the whole-pool basis', () => {
  const view = buildStatusView(null, false, [], { freeEnabled: false })
  assert.equal(view.state, 'warning', 'an enabled pool whose exits have not landed yet is not a drained pool')
  assert.equal(view.stateBasis, 'pool')
})

test('status view reports the R1 deferral when routing is deferred', () => {
  const rt = fakeRuntime() as never
  ;(rt as { installer: { enabled: boolean; deferredReason: string | null; install(): void; disable(): void; dispose(): void } }).installer = {
    enabled: false,
    deferredReason: 'deferred: global dispatcher is owned by "RetryAgent" — install dsh-llm-proxy or the IP pool in one profile only, not both (R1)',
    install() {}, disable() {}, dispose() {},
  }
  const view = buildStatusView(rt, false, [])
  assert.equal(view.enabled, false)
  assert.match(view.deferredReason, /RetryAgent/)
})

test('status view degrades to a disabled stub without a runtime', () => {
  const view = buildStatusView(null, false, [])
  assert.equal(view.enabled, false)
  assert.equal(view.total, 0)
  assert.equal(view.pinned, null)
  assert.deepEqual(view.exits, [])
})

// -- bridge: handlers ------------------------------------------------------------

test('probe handlers: scope all/refill/exit/subscription dispatch and reject unknowns', async () => {
  const refreshed: number[] = []
  const rt = fakeRuntime({ refreshSubscriptions: async () => { refreshed.push(1) } }) as never
  const handlers = makeBridgeHandlers(() => rt, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const all = await handlers.probe({ scope: 'all' })
  assert.deepEqual(all, { ok: true, value: { queued: 2 } })
  const one = await handlers.probe({ scope: 'exit', exitId: 'http://10.0.0.1:3128' })
  assert.deepEqual(one, { ok: true, value: { queued: 1 } })
  const refill = await handlers.probe({ scope: 'refill' })
  assert.deepEqual(refill, { ok: true, value: { refilled: true } })
  // Regression (live 2026-10-12): the card's 订阅「立即刷新」 button sent
  // 'refill' (free sources) and no scope reached refreshSubscriptions(), so a
  // subscription could never be re-pulled on demand — filling singbox.path
  // then appeared to do nothing.
  const subscription = await handlers.probe({ scope: 'subscription' })
  assert.deepEqual(subscription, { ok: true, value: { refreshed: true } })
  assert.equal(refreshed.length, 1, 'the subscription refresh must be the one that ran')
  const bad = await handlers.probe({ scope: 'nope' })
  assert.equal(bad.ok, false)
  assert.equal((bad as { code: string }).code, 'settings-rejected')
  const missing = await handlers.probe({ scope: 'exit', exitId: 'http://9.9.9.9:1' })
  assert.equal((missing as { code: string }).code, 'unknown-exit')
})

test('probe handlers: pool-disabled refusal when no runtime', async () => {
  const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const result = await handlers.probe({ scope: 'all' })
  assert.equal(result.ok, false)
  assert.equal((result as { code: string }).code, 'pool-disabled')
})

// -- bridge: guard + routes --------------------------------------------------------

function fakeRequest(overrides: Record<string, unknown> = {}): { socket: { remoteAddress: string }; headers: Record<string, string> } {
  return {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3928' },
    ...overrides,
  }
}

test('guard accepts loopback + canonical host + same-origin, rejects everything else', () => {
  assert.equal(isTrustedBridgeRequest(fakeRequest()), true)
  assert.equal(isTrustedBridgeRequest(fakeRequest({ socket: { remoteAddress: '192.168.1.5' } })), false)
  assert.equal(isTrustedBridgeRequest(fakeRequest({ headers: { host: 'evil.com' } })), false)
  assert.equal(isTrustedBridgeRequest(fakeRequest({ headers: { host: '127.0.0.1.evil.com' } })), false)
  assert.equal(isTrustedBridgeRequest(fakeRequest({ headers: { host: 'localhost:3928' } })), true)
  assert.equal(isTrustedBridgeRequest(fakeRequest({ headers: {} })), false)
  assert.equal(
    isTrustedBridgeRequest(fakeRequest({ headers: { host: '127.0.0.1:3928', origin: 'http://evil.com' } })),
    false,
  )
  assert.equal(
    isTrustedBridgeRequest(fakeRequest({ headers: { host: '127.0.0.1:3928', origin: 'http://127.0.0.1:3928' } })),
    true,
  )
})

test('routes carry the exact paths and POST-only method guard', async () => {
  const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const routes = makeBridgeRoutes(handlers, { guard: () => true }) as unknown as Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }>
  assert.deepEqual(
    routes.map((r) => r.path),
    [`${IP_POOL_BRIDGE_PREFIX}/status`, `${IP_POOL_BRIDGE_PREFIX}/models`, `${IP_POOL_BRIDGE_PREFIX}/probe`, `${IP_POOL_BRIDGE_PREFIX}/exit`],
  )
  assert.ok(routes.every((r) => r.kind === 'exact'))

  // method guard: a GET must 405 before any handler runs
  let written: { status?: number; body?: unknown } = {}
  const res = {
    writeHead(status: number) { written.status = status },
    end(body: string) { written.body = JSON.parse(body) },
  }
  await routes[0]!.handler({ method: 'GET', headers: { host: '127.0.0.1:3928' } }, res)
  assert.equal(written.status, 405)

  // status happy path via the injected guard
  written = {}
  await routes[0]!.handler({ method: 'POST', headers: { host: '127.0.0.1:3928' } }, res)
  assert.equal(written.status, 200)
  assert.equal((written.body as { ok: boolean }).ok, true)

  // probe with unreadable body -> 400 envelope, never a thrown route
  // (routes[2]: pick by path — the route order is part of what this test pins,
  //  but the probe handler itself must be found by name)
  const probeRoute = routes.find((r) => r.path === `${IP_POOL_BRIDGE_PREFIX}/probe`)!
  written = {}
  await probeRoute.handler({ method: 'POST', headers: { host: '127.0.0.1:3928' } }, res)
  assert.equal(written.status, 400)
  assert.equal((written.body as { code: string }).code, 'settings-rejected')
})

test('models handler lists S3 static rows plus live catalog through the seam', async () => {
  const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }), {
    listLiveModels: () => ['muse-spark-1.3-contributor-free', 'big-pickle', 'brand-new-model'],
  })
  const result = await handlers.models()
  assert.equal(result.ok, true)
  const value = (result as { value: { models: Array<{ id: string; verified: boolean }> } }).value
  // S3 static list first, all marked verified
  assert.deepEqual(value.models.slice(0, 6).map((row) => row.verified), [true, true, true, true, true, true])
  // big-pickle deduped (already static), live-only rows appended unverified
  const ids = value.models.map((row) => row.id)
  assert.equal(ids.indexOf('muse-spark-1.3-contributor-free') > 5, true, 'live-only row appended after statics')
  assert.equal(ids.lastIndexOf('big-pickle'), ids.indexOf('big-pickle'), 'no duplicate big-pickle')
  assert.equal(value.models.find((row) => row.id === 'brand-new-model')?.verified, false)
})

test('models handler falls back to the static list without a live seam', async () => {
  const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const result = await handlers.models()
  assert.equal(result.ok, true)
  const value = (result as { value: { models: Array<{ id: string; verified: boolean }> } }).value
  assert.ok(value.models.length >= 6)
  assert.equal(value.models[0]!.id, 'big-pickle')
})

test('bridge routes include /models', () => {
  const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const routes = makeBridgeRoutes(handlers, { guard: () => true }) as Array<{ path: string }>
  assert.ok(routes.some((r) => r.path === `${IP_POOL_BRIDGE_PREFIX}/models`))
})

test('guard-rejected requests get 403 and never reach the handler', async () => {
  const handlers = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const routes = makeBridgeRoutes(handlers, { guard: () => false }) as unknown as Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> }>
  let written: { status?: number; body?: unknown } = {}
  const res = {
    writeHead(status: number) { written.status = status },
    end(body: string) { written.body = JSON.parse(body) },
  }
  await routes[0]!.handler({ method: 'POST', headers: { host: '127.0.0.1:3928' } }, res)
  assert.equal(written.status, 403)
  assert.deepEqual(written.body, { error: 'forbidden' })
})

// -- bridge: the exit tables' row actions (固定 / 删除) ------------------------------

/** One exit node for the row-action tests. */
function exitNode(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: '127.0.0.1:30001',
    protocol: 'socks5',
    source: 'subscription',
    pinned: false,
    exitIP: '1.1.1.1',
    exitLocation: 'HK Central',
    latencyMs: 120,
    quality: 'S',
    addedAt: 0,
    ...overrides,
  }
}

/**
 * A runtime fake over a REAL ExitPool (the row actions read `pinnedId`,
 * `has`, `demoteToTail` and `snapshot`), plus a recording subscription seam.
 */
function rowActionRuntime(options: { exits?: ExitNode[]; replaceExit?: (id: string) => Promise<boolean>; busy?: boolean } = {}): {
  runtime: unknown
  pool: ExitPool
  replaced: string[]
  demoted: string[]
} {
  const pool = new ExitPool()
  for (const entry of options.exits ?? [exitNode(), exitNode({ id: '127.0.0.1:30002', exitIP: '2.2.2.2' })]) {
    pool.add(entry)
    pool.markOk(entry.id)
  }
  const replaced: string[] = []
  const demoted: string[] = []
  const demoteToTail = pool.demoteToTail.bind(pool)
  pool.demoteToTail = (id: string) => { demoted.push(id); return demoteToTail(id) }
  const runtime = {
    pool,
    installer: { enabled: true, deferredReason: null, install() {}, disable() {}, dispose() {} },
    prober: { stats: { queued: 0, inFlight: 0, enqueued: 0, completed: 0 } },
    subscriptions: options.replaceExit === undefined
      ? null
      : {
        get busy() { return options.busy === true },
        replaceExit: async (id: string) => {
          replaced.push(id)
          return options.replaceExit!(id)
        },
      },
  }
  return { runtime, pool, replaced, demoted }
}

test('exit handler: 固定 persists pinnedExitId and pins live', async () => {
  const { runtime, pool } = rowActionRuntime()
  const writes: string[] = []
  const handlers = makeBridgeHandlers(() => runtime as never, () => ({ pinnedStrict: false, proxyHosts: [] }), {
    writePin: async (value) => { writes.push(value); return true },
  })
  const pinned = await handlers.exit({ action: 'pin', exitId: '127.0.0.1:30002' })
  assert.deepEqual(pinned, { ok: true, value: { pinned: '127.0.0.1:30002', local: false, persisted: true } })
  assert.deepEqual(writes, ['127.0.0.1:30002'], 'the settings field is the persisted half of the click')
  assert.equal(pool.pinnedId, '127.0.0.1:30002', 'and the live pool is pinned in the same click')

  const unpinned = await handlers.exit({ action: 'unpin' })
  assert.deepEqual(unpinned, { ok: true, value: { pinned: '', local: false, persisted: true } })
  assert.deepEqual(writes, ['127.0.0.1:30002', ''], 'an empty write is the unpin spelling')
  assert.equal(pool.pinnedId, '')
})

test('exit handler: 固定 on the 本机 row pins the local sentinel', async () => {
  const { runtime, pool } = rowActionRuntime()
  const handlers = makeBridgeHandlers(() => runtime as never, () => ({ pinnedStrict: false, proxyHosts: [] }), {
    writePin: async () => true,
  })
  // The client never spells the sentinel: its 本机 button sends `pin-local`.
  const result = await handlers.exit({ action: 'pin-local' })
  assert.equal(result.ok, true)
  assert.deepEqual((result as { value: unknown }).value, { pinned: 'local', local: true, persisted: true })
  assert.equal(pool.pinnedLocal, true)
  assert.equal(pool.pick('ses', 'm'), null, 'every request then egresses from this machine')
})

test('exit handler: a read-only profile still pins live, and says it did not persist', async () => {
  const { runtime, pool } = rowActionRuntime()
  const handlers = makeBridgeHandlers(() => runtime as never, () => ({ pinnedStrict: false, proxyHosts: [] }), {
    writePin: async () => { throw new Error('read-only profile') },
  })
  const result = await handlers.exit({ action: 'pin', exitId: '127.0.0.1:30001' })
  assert.deepEqual((result as { value: unknown }).value, { pinned: '127.0.0.1:30001', local: false, persisted: false })
  assert.equal(pool.pinnedId, '127.0.0.1:30001', 'the click is honest about being volatile, not silently dropped')
})

test('exit handler: 轮换 promotes a reserve through the subscription layer', async () => {
  const { runtime, replaced, demoted } = rowActionRuntime({ replaceExit: async () => true })
  const handlers = makeBridgeHandlers(() => runtime as never, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const result = await handlers.exit({ action: 'rotate', exitId: '127.0.0.1:30001' })
  assert.deepEqual((result as { value: unknown }).value, { rotated: true, promoted: true, remaining: 2 })
  assert.deepEqual(replaced, ['127.0.0.1:30001'])
  assert.deepEqual(demoted, [], 'a promoted reserve is the refill: nothing sinks')
})

test('exit handler: 轮换 with no reserve left moves the exit to the list tail', async () => {
  const { runtime, demoted, pool } = rowActionRuntime({ replaceExit: async () => false })
  const handlers = makeBridgeHandlers(() => runtime as never, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const result = await handlers.exit({ action: 'rotate', exitId: '127.0.0.1:30001' })
  assert.deepEqual((result as { value: unknown }).value, { rotated: true, promoted: false, remaining: 2 })
  assert.deepEqual(demoted, ['127.0.0.1:30001'], 'the row stays in the pool, ranked last')
  assert.equal(pool.demoted('127.0.0.1:30001'), true)
})

test('exit handler: no onboarder at all still sinks the row', async () => {
  const { runtime, demoted } = rowActionRuntime()
  const handlers = makeBridgeHandlers(() => runtime as never, () => ({ pinnedStrict: false, proxyHosts: [] }))
  await handlers.exit({ action: 'rotate', exitId: '127.0.0.1:30001' })
  assert.deepEqual(demoted, ['127.0.0.1:30001'], 'without a subscription round the row can only be demoted')
})

test('exit handler: rotating the pinned exit unpins first', async () => {
  // The pin lives in the settings, so a stale pinnedExitId would re-pin a row
  // that is no longer in the pool — and re-admit it as a manual row, because a
  // subscription id ("127.0.0.1:30001") parses as a manual address.
  const { runtime, pool } = rowActionRuntime({ replaceExit: async () => true })
  const writes: string[] = []
  pool.pin('127.0.0.1:30001')
  const handlers = makeBridgeHandlers(() => runtime as never, () => ({ pinnedStrict: false, proxyHosts: [] }), {
    writePin: async (value) => { writes.push(value); return true },
  })
  await handlers.exit({ action: 'rotate', exitId: '127.0.0.1:30001' })
  assert.deepEqual(writes, [''], 'the pin is cleared in the settings, not just in memory')
  assert.equal(pool.pinnedId, '')
})

test('exit handler: 轮换 during a rotation round reports busy instead of sinking the row', async () => {
  // A running onboarding/trim holds the rebuild mutex and replaceExit() answers
  // false without consulting the reserve; sinking the row there would violate
  // the request ("refill first, sink only when there is nothing to promote").
  const { runtime, demoted, pool } = rowActionRuntime({ replaceExit: async () => false, busy: true })
  const handlers = makeBridgeHandlers(() => runtime as never, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const result = await handlers.exit({ action: 'rotate', exitId: '127.0.0.1:30001' })
  assert.deepEqual((result as { value: unknown }).value, { rotated: false, promoted: false, busy: true, remaining: 2 })
  assert.deepEqual(demoted, [], 'the row is untouched: the operator can click again')
  assert.equal(pool.has('127.0.0.1:30001'), true)
})

test('exit handler: unknown exits and unknown actions are refused', async () => {
  const { runtime } = rowActionRuntime()
  const handlers = makeBridgeHandlers(() => runtime as never, () => ({ pinnedStrict: false, proxyHosts: [] }))
  const unknown = await handlers.exit({ action: 'pin', exitId: '127.0.0.1:9' })
  assert.equal((unknown as { code: string }).code, 'unknown-exit')
  const missing = await handlers.exit({ action: 'rotate', exitId: '127.0.0.1:9' })
  assert.equal((missing as { code: string }).code, 'unknown-exit')
  const bad = await handlers.exit({ action: 'explode' })
  assert.equal((bad as { code: string }).code, 'settings-rejected')
  const disabled = makeBridgeHandlers(() => null, () => ({ pinnedStrict: false, proxyHosts: [] }))
  assert.equal(((await disabled.exit({ action: 'pin', exitId: 'x' })) as { code: string }).code, 'pool-disabled')
})

test('status view marks the local pin so the modal can render 取消固定 on the 本机 row', () => {
  const { runtime, pool } = rowActionRuntime()
  pool.pinLocal()
  const view = buildStatusView(runtime as never, false, [])
  assert.deepEqual(view.pinned, { id: 'local', strict: false, local: true })
})

// -- bridge: the persistent usage ledger (流量 tab) --------------------------------

/** A store over an in-memory-only ledger (readOnly skips every disk touch). */
function ledger(): UsageStore {
  return new UsageStore({ readOnly: true, flushMs: 0, now: () => Date.UTC(2026, 9, 14, 3, 0, 0) })
}

test('usage view: days, sessions and the scope switch come from the ledger', () => {
  const store = ledger()
  store.record('a:1', { inputTokens: 100, outputTokens: 50, durationMs: 1000 }, { session: 'ses_1', label: 'first conversation' })
  store.record('a:1', { inputTokens: 10, outputTokens: 10, durationMs: 500 }, { session: 'ses_2', label: 'second conversation' })
  store.record('local', { inputTokens: 1, outputTokens: 1 }, { session: 'ses_2', label: 'second conversation' })

  const total = buildUsageView(store, 'total', { runSince: 123 })
  assert.ok(total)
  assert.equal(total.scope, 'total')
  assert.equal(total.retentionDays, 90)
  assert.equal(total.runSince, 123)
  assert.equal(total.total.requests, 3, 'the all-time figure rides along whatever the scope is')
  assert.equal(total.scoped.requests, 3)
  assert.deepEqual(total.days.map((row) => row.day), ['2026-10-14'])
  assert.equal(total.days[0]!.tokens, 172, 'all-in: input + output + cache')
  // Ordered by TOKENS, not requests: the first conversation sent 150 tokens in
  // one response, the second sent 22 across two.
  assert.deepEqual(total.sessions.map((row) => [row.label, row.tokens]), [
    ['first conversation', 150],
    ['second conversation', 22],
  ], 'heaviest session first')
  assert.deepEqual(total.projects, [], 'no resolver = no project claims')
  assert.deepEqual(total.stored, { sessions: 2, days: 1, exits: 2 })
})

test('usage view: sessions are joined to projects at read time', () => {
  const store = ledger()
  store.record('a:1', { inputTokens: 100, outputTokens: 50 }, { session: 'ses_1', label: 'alpha work' })
  store.record('a:1', { inputTokens: 100, outputTokens: 50 }, { session: 'ses_2', label: 'more alpha' })
  store.record('a:1', { inputTokens: 10, outputTokens: 5 }, { session: 'ses_3', label: 'beta work' })

  const projects: Record<string, { id: string; title: string; path: string }> = {
    ses_1: { id: 'w1', title: 'opencode2dsh', path: '/Users/ankh/workspace/private/opencode2dsh' },
    ses_2: { id: 'w1', title: 'opencode2dsh', path: '/Users/ankh/workspace/private/opencode2dsh' },
    ses_3: { id: 'w2', title: 'other-project', path: '/tmp/other' },
  }
  const view = buildUsageView(store, 'total', { projectOf: (sessionId) => projects[sessionId] ?? null })
  assert.ok(view)
  assert.equal(view.sessions.find((row) => row.id === 'ses_1')?.project?.title, 'opencode2dsh')
  assert.equal(view.sessions.find((row) => row.id === 'ses_unknown'), undefined)
  assert.deepEqual(view.projects.map((row) => [row.title, row.sessions, row.requests]), [
    ['opencode2dsh', 2, 2],
    ['other-project', 1, 1],
  ], 'rolled up per project, heaviest first')
})

test('usage view: the scope switch changes the scoped numbers, never the all-time one', () => {
  const store = ledger()
  store.record('a:1', { inputTokens: 10, outputTokens: 10 }, { session: 'ses_1', label: 'x' })
  const total = buildUsageView(store, 'total', {})
  const run = buildUsageView(store, 'run', {})
  assert.equal(total!.scoped.requests, 1)
  assert.equal(run!.scoped.requests, 1, 'the same process recorded it, so both scopes see it')
  assert.equal(run!.total.requests, 1, 'the footer figure is scope-independent')
  assert.equal(buildUsageView(undefined, 'total', {}), null, 'no ledger = no usage view (the tab says so)')
})

test('status view: per-exit usage numbers follow the scope, and the footer figure does not', () => {
  // A ledger written by an EARLIER process (this is the restart story): the
  // file has the exit's bucket, the fresh store's run scope is empty.
  const dir = mkdtempSync(join(tmpdir(), 'usage-scope-'))
  try {
    const path = join(dir, 'usage.json')
    const bucket = { requests: 1, inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1000, outputMs: 2000 }
    writeFileSync(path, JSON.stringify({
      version: 1,
      totals: bucket,
      days: { '2026-10-13': bucket },
      sessions: { ses_old: { label: 'previous run', firstAt: 1, lastAt: 2, totals: bucket } },
      exits: { '127.0.0.1:30001': { lastAt: 2, totals: bucket } },
      savedAt: 2,
    }), 'utf8')
    const store = new UsageStore({ path, flushMs: 0 })
    const { runtime } = rowActionRuntime({ exits: [exitNode({ id: '127.0.0.1:30001' })] })

    const total = buildStatusView(runtime as never, false, [], { usage: store, usageScope: 'total', runSince: 42 })
    const run = buildStatusView(runtime as never, false, [], { usage: store, usageScope: 'run', runSince: 42 })
    const row = (view: typeof total): number => view.exits.find((entry) => entry.id === '127.0.0.1:30001')!.tokens.inputTokens

    assert.equal(row(total), 900, '总览 shows the persisted bucket')
    assert.equal(row(run), 0, '本次重启 shows nothing until this process records something')
    assert.equal(total.usage?.total.requests, 1, 'the footer figure is the same in both views')
    assert.equal(run.usage?.total.requests, 1, '总览 rides along even while the modal shows 本次重启')
    assert.equal(run.usage?.scoped.requests, 0)
    assert.equal(run.usage?.runSince, 42, 'the run origin is served for the 本次重启 label')
    assert.deepEqual(run.usage?.days.map((row) => row.day), [], 'a fresh process has no days of its own yet')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('status view: a host without a ledger still reports the in-process numbers', () => {
  const { runtime } = rowActionRuntime()
  const view = buildStatusView(runtime as never, false, [])
  assert.equal(view.usage, null, 'the client hides the 流量 tab instead of inventing data')
  assert.equal(typeof view.exits[0]!.tokens.inputTokens, 'number')
})
