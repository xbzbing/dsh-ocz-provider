import test from 'node:test'
import assert from 'node:assert/strict'
import { ANYTLS_SUBSCRIPTION } from './fixtures/anytls.ts'

import { buildOutbound, generateConfig, nodeKeyOf, SingBoxSupervisor, isDialableServer } from '../src/pool/singbox.ts'
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
  const { config, portMap } = generateConfig(nodes, 30_000)
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
  // portMap keys are GoProxy node keys
  assert.deepEqual([...portMap.values()], [30_001, 30_002])
  assert.equal(portMap.get(nodeKeyOf(nodes[0]!)), 30_001)
})

test('generateConfig: unsupported nodes are skipped without burning a port', () => {
  const nodes = [
    { name: 'bad', type: 'wireguard', server: 'x', port: 1, raw: {} },
    vmessNode(),
  ] satisfies ParsedNode[]
  const { config, portMap } = generateConfig(nodes, 30_000)
  const cfg = config as { inbounds: unknown[]; outbounds: unknown[] }
  assert.equal(cfg.inbounds.length, 1)
  assert.equal(cfg.outbounds.length, 2) // vmess + direct
  assert.equal(portMap.size, 1)
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
  // config-generation tests; the fetcher only needs the seam contract).
  const converted: Array<{ address: string; protocol: 'socks5'; node: ParsedNode }> = []
  const supervisor = {
    async reload(nodes: ParsedNode[]) {
      for (const [index, node] of nodes.entries()) {
        converted.push({ address: `127.0.0.1:${31000 + index}`, protocol: 'socks5', node })
      }
      return converted
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
  // all 38 anytls nodes converted and admitted (trusted smoke always passes here)
  assert.equal(state.convertedAdmitted, 38)
  assert.equal(state.pendingConversion.length, 0)
  assert.equal(pool.list().length, 38)
  assert.ok(pool.list().every((entry) => entry.source === 'subscription'))
  // addresses are the local converted ports
  assert.ok(pool.has('127.0.0.1:31000'))
  assert.ok(pool.has('127.0.0.1:31037'))
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
    async reload(nodes: ParsedNode[]) {
      converted.push(nodes)
      return nodes.map((node, index) => ({ address: `127.0.0.1:${33000 + index}`, protocol: 'socks5' as const, node }))
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
 */
test('subscription refresh: converted nodes that fail the smoke stay unverified', async () => {
  const fixture = ANYTLS_SUBSCRIPTION
  const pool = new ExitPool()
  const prober = new Prober({ pool })
  const supervisor = {
    async reload(nodes: ParsedNode[]) {
      return nodes.map((node, index) => ({ address: `127.0.0.1:${34000 + index}`, protocol: 'socks5' as const, node }))
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

  assert.equal(state.convertedAdmitted, 38, 'the nodes are still kept (paid line, docs 4.5)')
  assert.equal(pool.list().length, 38)
  const health = pool.list().map((entry) => entry.health.state)
  assert.ok(health.every((state) => state !== 'ok'), `nothing may claim health: ${health.join(',')}`)
  assert.ok(pool.list().every((entry) => entry.exitIP === ''))
  assert.ok(pool.list().every((entry) => entry.quality === 'C'), 'and none of them claims a measured grade')
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
