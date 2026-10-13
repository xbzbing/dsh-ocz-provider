import test from 'node:test'
import assert from 'node:assert/strict'
import { ANYTLS_SUBSCRIPTION } from './fixtures/anytls.ts'

import { buildOutbound, generateConfig, SingBoxSupervisor, isDialableServer } from '../src/pool/singbox.ts'
import { parseSubscription, type ParsedNode } from '../src/pool/subscription.ts'
import { ExitPool } from '../src/pool/pool.ts'
import { Prober } from '../src/pool/prober.ts'
import { SubscriptionFetcher } from '../src/pool/subscription-fetcher.ts'

// -- outbound mapping matrix --------------------------------------------------

function vmessNode(overrides: Partial<ParsedNode> = {}): ParsedNode {
  return {
    name: 'vmess-node',
    type: 'vmess',
    server: 'v.example.com',
    port: 443,
    raw: {
      type: 'vmess', name: 'vmess-node', server: 'v.example.com', port: 443,
      uuid: 'uuid-1', alterId: 0, cipher: 'auto',
      tls: true, network: 'ws', 'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
    },
    ...overrides,
  }
}

test('buildOutbound: vmess maps uuid/security/TLS/ws transport', () => {
  const out = buildOutbound(vmessNode(), 'out-node-0')
  assert.deepEqual(out, {
    tag: 'out-node-0', type: 'vmess', server: 'v.example.com', server_port: 443,
    uuid: 'uuid-1', alter_id: 0, security: 'auto',
    tls: { enabled: true },
    transport: { type: 'ws', path: '/ws', headers: { Host: 'cdn.example.com' } },
  })
})

test('buildOutbound: trojan/vless/hysteria2/tuic map their credentials', () => {
  const trojan = buildOutbound({
    name: 't', type: 'trojan', server: 't.example.com', port: 443,
    raw: { type: 'trojan', password: 'pw', sni: 't.example.com', 'skip-cert-verify': true },
  }, 'out-t')
  assert.equal(trojan?.type, 'trojan')
  assert.equal(trojan?.password, 'pw')
  assert.deepEqual(trojan?.tls, { enabled: true, server_name: 't.example.com', insecure: true })

  const vless = buildOutbound({
    name: 'v', type: 'vless', server: 'vl.example.com', port: 443,
    raw: { type: 'vless', uuid: 'u1', flow: 'xtls-rprx-vision', 'reality-opts': { 'public-key': 'pk', 'short-id': 'sid' } },
  }, 'out-v')
  assert.equal(vless?.flow, 'xtls-rprx-vision')
  assert.deepEqual(vless?.tls, {
    enabled: true,
    reality: { enabled: true, public_key: 'pk', short_id: 'sid' },
  })

  // A bare hysteria2 node still gets tls — hysteria2 is TLS-mandatory, and
  // emitting it without TLS is what made `sing-box check` reject a whole
  // config (see the dedicated regression below).
  const hy2 = buildOutbound({
    name: 'h', type: 'hysteria2', server: 'h.example.com', port: 443,
    raw: { type: 'hysteria2', password: 'pw2' },
  }, 'out-h')
  assert.deepEqual(hy2, { tag: 'out-h', type: 'hysteria2', server: 'h.example.com', server_port: 443, password: 'pw2', tls: { enabled: true } })

  const tuic = buildOutbound({
    name: 'tu', type: 'tuic', server: 'q.example.com', port: 443,
    raw: { type: 'tuic', uuid: 'u', password: 'p' },
  }, 'out-tu')
  assert.equal(tuic?.congestion_control, 'bbr')
})

test('buildOutbound: anytls forces TLS on (GoProxy forceTLS)', () => {
  const out = buildOutbound({
    name: 'a', type: 'anytls', server: 'a.example.com', port: 18888,
    raw: { type: 'anytls', password: 'pw', sni: 'a.example.com' },
  }, 'out-a')
  assert.equal(out?.type, 'anytls')
  assert.deepEqual(out?.tls, { enabled: true, server_name: 'a.example.com' })
})

test('buildOutbound: TLS-mandatory protocols get tls even without any TLS field', () => {
  // Regression (live 2026-10-12): a real airport's Clash YAML wrote 4
  // hysteria2 nodes with no sni/tls/client-fingerprint/reality-opts, so
  // applyTLS() bailed and sing-box rejected the WHOLE config with
  // "initialize outbound[N]: TLS required" — one round produced zero
  // converted exits and all 49 nodes stayed parked. Verified against
  // sing-box 1.14.3 that hysteria2, tuic and anytls all demand TLS, while
  // trojan does not, so only the mandatory three are forced.
  const bare = (type: string): Record<string, unknown> => ({ type, password: 'pw' })

  const hy2 = buildOutbound({ name: 'h', type: 'hysteria2', server: 'h.example.com', port: 2497, raw: bare('hysteria2') }, 'out-h')
  assert.deepEqual(hy2?.tls, { enabled: true }, 'hysteria2 without TLS fields still enables TLS')

  const tuic = buildOutbound({ name: 't', type: 'tuic', server: 't.example.com', port: 443, raw: { ...bare('tuic'), uuid: 'u' } }, 'out-t')
  assert.deepEqual(tuic?.tls, { enabled: true }, 'tuic without TLS fields still enables TLS')

  // A genuine sni must still win, and trojan must stay TLS-optional.
  const hy2Sni = buildOutbound({
    name: 'h2', type: 'hysteria2', server: 'h.example.com', port: 2497,
    raw: { ...bare('hysteria2'), sni: 'cdn.example.com' },
  }, 'out-h2')
  assert.deepEqual(hy2Sni?.tls, { enabled: true, server_name: 'cdn.example.com' })

  const trojan = buildOutbound({ name: 'j', type: 'trojan', server: 'j.example.com', port: 443, raw: bare('trojan') }, 'out-j')
  assert.equal(trojan?.tls, undefined, 'plain trojan stays valid without TLS')
})

test('buildOutbound: unknown types return null (skipped)', () => {
  assert.equal(buildOutbound({
    name: 'x', type: 'wireguard', server: 'x', port: 1, raw: {},
  }, 'out-x'), null)
})

test('generateConfig: per-node inbound/outbound/rule with ascending ports + direct default', () => {
  const nodes = [vmessNode(), vmessNode({ name: 'second', server: 'v2.example.com', raw: { type: 'vmess', uuid: 'u2' } })]
  const { config, ports } = generateConfig(nodes, 30_000)
  const cfg = config as {
    inbounds: Array<{ tag: string; listen: string; listen_port: number; type: string }>
    outbounds: Array<{ tag: string; type: string }>
    route: { rules: Array<{ inbound: string[]; outbound: string }>; final: string }
  }
  assert.deepEqual(cfg.inbounds.map((inbound) => inbound.listen_port), [30_001, 30_002])
  assert.ok(cfg.inbounds.every((inbound) => inbound.listen === '127.0.0.1' && inbound.type === 'socks'))
  // direct default outbound appended last
  assert.equal(cfg.outbounds[cfg.outbounds.length - 1]?.tag, 'direct')
  assert.equal(cfg.route.final, 'direct')
  // rules wire each inbound to its outbound
  assert.deepEqual(cfg.route.rules[0], { inbound: ['in-node-0'], outbound: 'out-node-0' })
  // ports are index-aligned with the input list
  assert.deepEqual(ports, [30_001, 30_002])
})

test('generateConfig: unsupported nodes are skipped without burning a port', () => {
  const nodes = [
    { name: 'bad', type: 'wireguard', server: 'x', port: 1, raw: {} },
    vmessNode(),
  ] satisfies ParsedNode[]
  const { config, ports } = generateConfig(nodes, 30_000)
  const cfg = config as { inbounds: unknown[]; outbounds: unknown[] }
  assert.equal(cfg.inbounds.length, 1)
  assert.equal(cfg.outbounds.length, 2) // vmess + direct
  // The port is the node's SLOT (input index + 1), so the unmappable node leaves
  // a gap rather than shifting the next node's port: slots have to survive the
  // onboarding's subset rebuilds, and a compacted numbering would repoint every
  // surviving exit the moment a reserve is promoted.
  assert.deepEqual(ports, [0, 30_002], 'the skipped node keeps its index slot and opens no listener')
})

/**
 * Live 2026-10-13: the exit table showed 13 exits for a 44-node subscription.
 * `generateConfig` keyed its port map by `type:server:port` — a GoProxy habit —
 * which is not a node identity for an airport that fronts many distinct nodes
 * on ONE edge host and separates them by the anytls TLS `server_name`. 44 nodes
 * collapsed into 13 keys, the LAST port per key won, every earlier node
 * resolved to that same port, and 31 generated inbounds were orphaned:
 * listening, never handed to the pool. The synthetic fixture hid this for
 * months because every node in it has a unique hostname.
 */
test('generateConfig: nodes sharing host:port but differing in TLS SNI each keep their own port (live regression)', () => {
  const edge = 'b2efc912.edge.0443.me.uk'
  const node = (sni: string): ParsedNode => ({
    name: sni,
    type: 'anytls',
    server: edge,
    port: 443,
    raw: { type: 'anytls', password: 'shared-password', sni },
  })
  const nodes = [node('hk01.0443node.org.uk'), node('hk02.0443node.org.uk'), node('jp01.0443node.org.uk')]
  const { config, ports } = generateConfig(nodes, 30_000)
  const cfg = config as {
    inbounds: Array<{ listen_port: number }>
    outbounds: Array<{ tag: string; tls?: { server_name?: string } }>
    route: { rules: Array<{ inbound: string[]; outbound: string }> }
  }
  assert.deepEqual(ports, [30_001, 30_002, 30_003], 'one port per node, never one per host:port key')
  assert.equal(cfg.inbounds.length, 3)
  assert.deepEqual(
    cfg.outbounds.slice(0, 3).map((outbound) => outbound.tls?.server_name),
    ['hk01.0443node.org.uk', 'hk02.0443node.org.uk', 'jp01.0443node.org.uk'],
    'the SNI that distinguishes the nodes survives into their own outbounds',
  )
  assert.deepEqual(
    cfg.route.rules.map((rule) => rule.outbound),
    ['out-node-0', 'out-node-1', 'out-node-2'],
    'each inbound routes to its own outbound',
  )
})

test('generateConfig: a keep subset reuses each node\'s own stable port (onboarding shrink/promote)', () => {
  // The onboarding converts every candidate to measure it, then rebuilds the
  // config with only the fastest N — and later adds a reserve back. Ports must
  // follow the node's SLOT, not its position in the emitted subset, or every
  // survivor would be repointed at a different node on each rebuild (and the
  // pool's exit ids, health and counters would all go stale).
  const edge = 'shared.edge.example.test'
  const node = (sni: string): ParsedNode => ({
    name: sni,
    type: 'anytls',
    server: edge,
    port: 443,
    raw: { type: 'anytls', password: 'pw', sni },
  })
  const nodes = [node('a'), node('b'), node('c'), node('d')]
  const full = generateConfig(nodes, 30_000)
  assert.deepEqual(full.ports, [30_001, 30_002, 30_003, 30_004])

  // Keep slots 1 and 3: they must land on their ORIGINAL ports.
  const shrunk = generateConfig(nodes, 30_000, [1, 3])
  assert.deepEqual(shrunk.ports, [0, 30_002, 0, 30_004])
  const shrunkCfg = shrunk.config as { inbounds: Array<{ listen_port: number }> }
  assert.deepEqual(shrunkCfg.inbounds.map((inbound) => inbound.listen_port), [30_002, 30_004])

  // Promote slot 2 back in: the two survivors keep their ports.
  const promoted = generateConfig(nodes, 30_000, [1, 2, 3])
  assert.deepEqual(promoted.ports, [0, 30_002, 30_003, 30_004])
})

test('generateConfig: byte-identical nodes still get one port each — the pool owns exit-IP dedupe', () => {
  // Conversion is not the dedupe layer: two entries that really are one exit
  // must each be dialable so the pool can MEASURE them, and then `add()`
  // refuses the second address carrying the same exit IP (docs §3.1, one IP =
  // one anonymous quota bucket). Collapsing them here is what made the loss
  // invisible: no probe, no measurement, no evidence in the exit table.
  const node = (): ParsedNode => ({
    name: 'same',
    type: 'anytls',
    server: 'edge.example.test',
    port: 443,
    raw: { type: 'anytls', password: 'pw', sni: 'same.example.test' },
  })
  const { config, ports } = generateConfig([node(), node()], 30_000)
  const cfg = config as { inbounds: unknown[] }
  assert.deepEqual(ports, [30_001, 30_002])
  assert.equal(cfg.inbounds.length, 2)
})

// -- conversion pipeline (fetcher + supervisor seam) ---------------------------

test('subscription refresh with supervisor: encrypted nodes convert and smoke into the pool', async () => {
  const fixture = ANYTLS_SUBSCRIPTION
  const report = parseSubscription(fixture)
  assert.equal(report.nodes.length, 38)

  const pool = new ExitPool()
  const prober = new Prober({ pool })
  // A fake supervisor: converts every node to a local address without a
  // real binary (the SingBoxSupervisor's process paths are covered by the
  // config-generation tests; the fetcher only needs the seam contract). It
  // honours `keep` like the real one, so the onboarding's shrink is visible.
  const shrinks: number[] = []
  const supervisor = {
    async reload(nodes: ParsedNode[], keep?: readonly number[]) {
      const slots = keep ?? nodes.map((_, index) => index)
      if (keep !== undefined) shrinks.push(slots.length)
      return slots.map((index) => ({
        address: `127.0.0.1:${31000 + index}`,
        protocol: 'socks5' as const,
        node: nodes[index]!,
        slot: index,
      }))
    },
    async stop() {},
    get running() {
      return true
    },
  }
  const seam = {
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      uri: string
      close() { return Promise.resolve() }
      destroy() { return Promise.resolve() }
    },
    request: (async (url: string, init: { dispatcher: { uri: string } }) => {
      const address = init.dispatcher.uri.replace(/^[a-z0-9+.-]+:\/\//, '')
      if (url.includes('ip-api')) {
        // exit IP derived from the port so distinct local ports are
        // distinct quota buckets (the pool dedupes shared exit IPs, 3.1)
        const port = address.split(':')[1] ?? '0'
        // No artificial latency here: the onboarding ranks by MEASURED latency,
        // so with an instant echo the top-20 is decided by timer jitter. This
        // test asserts the CAP and the SHRINK (the contract); the ranking
        // itself is covered by test/onboard.test.ts, which spaces its
        // candidates widely enough for the order to be deterministic.
        return {
          statusCode: 200,
          body: { text: async () => JSON.stringify({ status: 'success', query: `7.7.${Number(port) % 250}.${(Number(port) / 250) | 0}`, countryCode: 'US', city: 'c', country: 'c' }) },
        }
      }
      return { statusCode: 200, body: { text: async () => '{"ok":true}' } }
    }) as never,
  }
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: seam as never, supervisor, fetchImpl: (async () => new Response(fixture)) as unknown as typeof fetch },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token'])
  const state = await fetcher.refresh()
  // 38 anytls nodes convert, but the onboarding keeps only the pool's capacity
  // (10 by default) and shrinks the conversion to them — the whole point of
  // "池子数量 10 个 / 避免建立太多本地连接" (live request 2026-10-13/14).
  assert.equal(state.convertedAdmitted, 10)
  assert.equal(state.pendingConversion.length, 0)
  assert.equal(pool.list().length, 10, 'the pool holds its capacity, not all 38 candidates')
  assert.deepEqual(shrinks, [10], 'the conversion is rebuilt with exactly the selected slots')
  assert.ok(pool.list().every((entry) => entry.source === 'subscription'))
  // Every admitted address is one of the converted candidates (slot-stable
  // ports), and the other 18 are reserve rather than listeners.
  assert.ok(pool.list().every((entry) => /^127\.0\.0\.1:310\d\d$/.test(entry.id)))
})

test('subscription refresh without supervisor: encrypted nodes park as pending', async () => {
  const fixture = ANYTLS_SUBSCRIPTION
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: {} as never, fetchImpl: (async () => new Response(fixture)) as unknown as typeof fetch },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token'])
  const state = await fetcher.refresh()
  assert.equal(state.pendingConversion.length, 38)
  assert.equal(state.convertedAdmitted, 0)
  assert.equal(pool.list().length, 0)
})

/**
 * Live 2026-10-13: a subscription node with `server: 10.255.255.255` was
 * converted into a local SOCKS5 exit anyway — it took a port, joined the
 * pool through the trusted fallback and showed up in the exit table as an
 * unreachable "127.0.0.1:30005" row for the life of the process.
 */
test('isDialableServer: placeholder literals are never nodes', () => {
  for (const server of [
    '10.255.255.255', '10.0.0.1', '127.0.0.1', '0.0.0.0', '169.254.1.1',
    '172.16.0.9', '192.168.1.5', '100.64.0.1', '224.0.0.1', '198.18.0.1',
    '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1',
    'localhost', 'sub.localhost', '', '   ',
  ]) {
    assert.equal(isDialableServer(server), false, `${server} must be rejected`)
  }
  for (const server of ['166.0.16.46', 'b7b3cd58.edge.0443.me.uk', '1.1.1.1', '2001:db8::1', '[2001:db8::1]']) {
    assert.equal(isDialableServer(server), true, `${server} must be kept`)
  }
  assert.equal(isDialableServer('[fd00::1]'), false, 'bracketed IPv6 literals still parse')
})

test('subscription refresh: a node whose server cannot be dialled is skipped, never parked', async () => {
  const body = [
    'proxies:',
    '  - name: placeholder',
    '    type: trojan',
    '    server: 10.255.255.255',
    '    port: 443',
    '    password: x',
    '    skip-cert-verify: true',
    '  - name: real',
    '    type: trojan',
    '    server: 166.0.16.46',
    '    port: 443',
    '    password: x',
    '    skip-cert-verify: true',
  ].join('\n')
  const warnings: string[] = []
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const converted: ParsedNode[][] = []
  const supervisor = {
    async reload(nodes: ParsedNode[], keep?: readonly number[]) {
      converted.push(nodes)
      const slots = keep ?? nodes.map((_, index) => index)
      return slots.map((index) => ({ address: `127.0.0.1:${33000 + index}`, protocol: 'socks5' as const, node: nodes[index]!, slot: index }))
    },
    async stop() {},
    get running() {
      return true
    },
  }
  const seam = {
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      uri: string
      close() { return Promise.resolve() }
      destroy() { return Promise.resolve() }
    },
    request: (async (url: string) => {
      if (url.includes('ip-api')) {
        return { statusCode: 200, body: { text: async () => JSON.stringify({ status: 'success', query: '8.8.8.8', countryCode: 'US', city: 'c', country: 'c' }) } }
      }
      return { statusCode: 200, body: { text: async () => '{"ok":true}' } }
    }) as never,
  }
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: seam as never, supervisor, fetchImpl: (async () => new Response(body)) as unknown as typeof fetch },
    { logger: { info: () => {}, warn: (message: string) => warnings.push(message) } },
  )
  fetcher.setUrls(['https://sub.example.com/token'])
  const state = await fetcher.refresh()

  assert.deepEqual(converted.map((nodes) => nodes.map((node) => node.server)), [['166.0.16.46']], 'sing-box never sees the placeholder')
  assert.equal(state.pendingConversion.length, 0, 'and it is not left parked as pending')
  assert.deepEqual(pool.list().map((entry) => entry.id), ['127.0.0.1:33000'])
  assert.ok(warnings.some((line) => line.includes('10.255.255.255')), 'the skip is logged, not silent')
})

/**
 * The end-to-end shape of the 2026-10-13 outage: every converted node whose
 * smoke fails comes back `admitted: true` from the trusted fallback. Before
 * the fix the fetcher called markOk() on all of them, so dead exits entered
 * the pool as healthy, grade-S candidates.
 *
 * Under the onboarding pipeline (live request 2026-10-13) the same input ends
 * differently by design: the speed pass measures nothing, so the candidates go
 * unranked, the connectivity test refuses every one, and — with no reserve left
 * to promote — each is KEPT but demoted to the tail. The pool holds its
 * capacity instead of draining, and nothing claims health.
 */
test('subscription refresh: nodes that fail every measurement stay unverified at the tail', async () => {
  const fixture = ANYTLS_SUBSCRIPTION
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const supervisor = {
    async reload(nodes: ParsedNode[], keep?: readonly number[]) {
      const slots = keep ?? nodes.map((_, index) => index)
      return slots.map((index) => ({ address: `127.0.0.1:${34000 + index}`, protocol: 'socks5' as const, node: nodes[index]!, slot: index }))
    },
    async stop() {},
    get running() {
      return true
    },
  }
  const seam = {
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        this.uri = opts.uri
      }
      uri: string
      close() { return Promise.resolve() }
      destroy() { return Promise.resolve() }
    },
    request: (async () => {
      throw new Error('connect ETIMEDOUT')
    }) as never,
  }
  const fetcher = new SubscriptionFetcher(
    { pool, prober, undici: seam as never, supervisor, fetchImpl: (async () => new Response(fixture)) as unknown as typeof fetch },
    { logger: { info: () => {}, warn: () => {} } },
  )
  fetcher.setUrls(['https://sub.example.com/token'])
  const state = await fetcher.refresh()

  assert.equal(state.convertedAdmitted, 0, 'nothing passed the connectivity test')
  assert.equal(pool.list().length, 10, 'the pool still holds its capacity (paid line, docs 4.5)')
  const health = pool.list().map((entry) => entry.health.state)
  assert.ok(health.every((state) => state !== 'ok'), `nothing may claim health: ${health.join(',')}`)
  assert.ok(pool.list().every((entry) => entry.exitIP === ''))
  assert.ok(pool.list().every((entry) => entry.quality === 'C'), 'and none of them claims a measured grade')
  assert.ok(pool.list().every((entry) => pool.demoted(entry.id)), 'every one of them is parked at the tail')
})

test('supervisor: reload([]) stops cleanly; missing binary surfaces a clear error', async () => {
  const supervisor = new SingBoxSupervisor({
    binPath: 'definitely-not-on-path-sing-box',
    dataDir: 'test-tmp-singbox',
    logger: { info: () => {}, warn: () => {} },
  })
  // empty node list never touches the binary
  const exits = await supervisor.reload([])
  assert.deepEqual(exits, [])
  assert.ok(!supervisor.running)
  // a binary that cannot be resolved rejects with an actionable message
  await assert.rejects(() => supervisor.reload([vmessNode()]), /not found/i)
})
