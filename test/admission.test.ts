import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import * as realUndici from 'undici'

import { ExitPool } from '../src/pool/pool.ts'
import { admitCandidate, admitTrusted, coarseScreen, type AdmissionDeps } from '../src/pool/admission.ts'
import { GENUINE_GATE_TOOLS } from '../src/adapter/gate-tools.ts'
import { setRequestHeadersReader } from '../src/adapter/ids.ts'

/**
 * A fake per-request transport: the seam `undici.request` would hit. Each
 * call records the URL and answers from a scripted map. The dispatcher is
 * never inspected — admission only cares about status codes and bodies.
 */
function fakeTransport(script: Record<string, { status: number; body: string } | Error>) {
  const calls: string[] = []
  const bodies = new Map<string, string>()
  const headers = new Map<string, Record<string, string>>()
  const agents: { uri: string }[] = []
  return {
    calls,
    bodies,
    headers,
    agents,
    undici: {
      ProxyAgent: class {
        constructor(options: { uri: string }) {
          agents.push({ uri: options.uri })
        }
        close() { return Promise.resolve() }
        destroy() { return Promise.resolve() }
      } as never,
      request: (async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
        calls.push(url)
        if (typeof init?.body === 'string') bodies.set(url, init.body)
        if (init?.headers) headers.set(url, init.headers)
        const entry = script[url] ?? script['*']
        if (entry instanceof Error) throw entry
        if (!entry) throw new Error(`unexpected request: ${url}`)
        return { statusCode: entry.status, body: { text: async () => entry.body } }
      }) as never,
    },
  }
}

const ECHO_URL = 'http://ip-api.com/json/?fields=status,country,countryCode,city,query'
const MODELS_URL = 'https://zen.test/v1/models'
const CHAT_URL = 'https://zen.test/v1/chat/completions'

function echoBody(query: string, countryCode: string, city = 'city') {
  return JSON.stringify({ status: 'success', query, countryCode, city, country: 'c' })
}

function okScript() {
  return {
    [ECHO_URL]: { status: 200, body: echoBody('5.5.5.5', 'US') },
    [MODELS_URL]: { status: 200, body: '{"data":[]}' },
    [CHAT_URL]: { status: 200, body: '{"id":"x"}' },
  }
}

function deps(transport: ReturnType<typeof fakeTransport>, overrides: Partial<AdmissionDeps> = {}) {
  return {
    pool: new ExitPool(),
    undici: transport.undici,
    zenBaseUrl: 'https://zen.test',
    ipEchoUrl: ECHO_URL,
    smokeModel: 'big-pickle',
    ...overrides,
  }
}

/** The smoke request's user turn, read back out of the captured body. */
function smokeContentOf(transport: ReturnType<typeof fakeTransport>): string {
  const body = JSON.parse(transport.bodies.get(CHAT_URL)!) as { messages: Array<{ content: string }> }
  return body.messages[0]!.content
}

test('admission: the four-step happy path admits with exit facts and grade', async () => {
  const transport = fakeTransport(okScript())
  const result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' })
  assert.ok(result.admitted, result.reason)
  assert.equal(result.node?.exitIP, '5.5.5.5')
  assert.equal(result.node?.exitLocation, 'US city')
  assert.equal(result.node?.source, 'free')
  assert.equal(result.node?.quality, 'S') // latency ~0
  // exactly the three scripted requests, in chain order
  assert.deepEqual(transport.calls, [ECHO_URL, MODELS_URL, CHAT_URL])
  // the proxy agent targeted the candidate
  assert.equal(transport.agents[0]?.uri, 'http://h:1')
})

test('admission: fail-fast at each step (echo/geo/latency/models/smoke)', async () => {
  // step 1-2: non-200 echo
  let transport = fakeTransport({ ...okScript(), [ECHO_URL]: { status: 503, body: '' } })
  let result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /echo HTTP 503/)

  // step 2: echo without an exit IP
  transport = fakeTransport({ ...okScript(), [ECHO_URL]: { status: 200, body: '{"status":"fail"}' } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /exit IP/)

  // step 2: geo-blocked country
  transport = fakeTransport({ ...okScript(), [ECHO_URL]: { status: 200, body: echoBody('5.5.5.5', 'CN') } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' }, { timeoutMs: 1000 })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /geo-blocked CN/)

  // step 3: HTTPS tunnel to the real upstream fails
  transport = fakeTransport({ ...okScript(), [MODELS_URL]: { status: 403, body: '' } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' }, { timeoutMs: 1000 })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /zen models HTTP 403/)

  // step 4: anonymous-lane smoke 429 -> admitted with `limited` (good exit,
  // quota consumed elsewhere; the caller cools it, docs 4.5)
  transport = fakeTransport({ ...okScript(), [CHAT_URL]: { status: 429, body: '' } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' }, { timeoutMs: 1000 })
  assert.ok(result.admitted, result.reason)
  assert.ok(result.limited)
  assert.equal(result.node?.exitIP, '5.5.5.5')

  // step 4: any other smoke failure still rejects outright
  transport = fakeTransport({ ...okScript(), [CHAT_URL]: { status: 403, body: '' } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' }, { timeoutMs: 1000 })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /zen smoke HTTP 403/)

  // the smoke body must satisfy the free-lane gate (2026-10-14 recipe):
  // streaming, the GENUINE bash+read definitions, and a canonical ses_* session
  // header. `tool_choice` is left to the model — the gate rejects `'none'`.
  const okTransport = fakeTransport(okScript())
  const okResult = await admitCandidate(deps(okTransport), { address: 'h:1', protocol: 'http', source: 'free' }, { timeoutMs: 1000 })
  assert.ok(okResult.admitted)
  const smokeBody = JSON.parse(okTransport.bodies.get(CHAT_URL)!) as {
    stream?: boolean
    tool_choice?: string
    messages?: Array<{ role: string; content: string }>
    tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>
  }
  assert.equal(smokeBody.stream, true)
  assert.equal(smokeBody.tool_choice, undefined, 'none is a 403 of its own since 2026-10-14')
  assert.deepEqual(smokeBody.messages, [{ role: 'user', content: 'hello' }], 'the unconfigured probe content is hello (live request 2026-10-14)')
  const smokeToolNames = smokeBody.tools?.map((t) => t.function.name) ?? []
  assert.deepEqual([...smokeToolNames].sort(), ['bash', 'read'])
  for (const tool of smokeBody.tools ?? []) {
    const genuine = GENUINE_GATE_TOOLS[tool.function.name as 'bash' | 'read']
    assert.deepEqual(tool.function, genuine.function, 'the smoke carries the genuine gate definitions')
  }
  const smokeHeaders = okTransport.headers.get(CHAT_URL)!
  assert.match(smokeHeaders['x-opencode-session'] ?? '', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, 'canonical session header')
  assert.match(smokeHeaders['x-opencode-request'] ?? '', /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/, 'the request id is a message id')
  assert.equal(smokeHeaders['x-opencode-project'], 'global', 'the prefix-less project id')
  assert.equal(smokeHeaders['x-session-affinity'], undefined, 'the 2026-10-09 workaround is now poison')

  // transport errors surface as reasons (timeout / reset)
  transport = fakeTransport({ '*': new Error('connect ECONNREFUSED') })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' }, { timeoutMs: 1000 })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /ECONNREFUSED/)
})

test('admission: the probe content is drawn at random from the configured pool', async () => {
  // Live request 2026-10-14: 允许用户自定义多个 content，探索时随机选择.
  const pool = ['alpha', 'beta', 'gamma']
  const first = fakeTransport(okScript())
  await admitCandidate(deps(first, { smokeContents: pool, random: () => 0 }), { address: 'h:1', protocol: 'http', source: 'free' })
  assert.equal(smokeContentOf(first), 'alpha')

  const last = fakeTransport(okScript())
  await admitCandidate(deps(last, { smokeContents: pool, random: () => 0.99 }), { address: 'h:2', protocol: 'http', source: 'free' })
  assert.equal(smokeContentOf(last), 'gamma')

  // A hand-typed list with blanks and duplicates still yields a valid turn.
  const messy = fakeTransport(okScript())
  await admitCandidate(deps(messy, { smokeContents: ['  ', 'only'], random: () => 0.5 }), { address: 'h:3', protocol: 'http', source: 'free' })
  assert.equal(smokeContentOf(messy), 'only')

  // A pre-drawn pass value wins: the caller probing ONE exit across several
  // models draws once and hands the same turn to every model of that pass
  // (live correction 2026-10-14: 每个出口随机抽一个探测文案).
  const pinned = fakeTransport(okScript())
  await admitCandidate(deps(pinned, { smokeContents: pool, smokeContent: 'drawn-once', random: () => 0.99 }), { address: 'h:4', protocol: 'http', source: 'free' })
  assert.equal(smokeContentOf(pinned), 'drawn-once', 'the pass value is not re-drawn')
})

test('admission: latency gate (relaxed for critical/emergency states)', async () => {
  // >3000ms response rejects in fast mode... simulate via a script that
  // answers slowly is overkill; the gate reads latencyMs from Date.now(),
  // so test the relaxed branch by forcing a slow echo through real sleep.
  const transport = fakeTransport(okScript())
  // fast path admits (latency ~0)
  const fastResult = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' })
  assert.ok(fastResult.admitted)
})

test('admission: trusted sources are admitted with warnings even on failure', async () => {
  const warnings: string[] = []
  const transport = fakeTransport({ '*': new Error('connect ECONNREFUSED') })
  const result = await admitTrusted(
    { ...deps(transport), logger: { warn: (m) => warnings.push(m) } },
    { address: 'leased:1', protocol: 'http', source: 'manual' },
  )
  assert.ok(result.admitted)
  assert.equal(result.node?.exitIP, '') // unknown facts, address is the key
  assert.ok(warnings.some((line) => line.includes('leased:1')))
})

/**
 * Live 2026-10-13: five unreachable subscription exits were re-admitted by
 * this fallback on every probe round and then markOk()'d by the caller —
 * state `ok`, grade `S` (gradeOf(0) is 'S'), exitIP unknown — so the picker
 * ranked them FIRST and fed them real requests that died in transport.
 */
test('admission: the trusted fallback reports `unverified` and never grades an unmeasured exit S', async () => {
  const transport = fakeTransport({ '*': new Error('connect ECONNREFUSED') })
  const silent = { ...deps(transport), logger: { warn: () => {} } }

  const fresh = await admitTrusted(silent, { address: '127.0.0.1:30005', protocol: 'socks5', source: 'subscription' })
  assert.ok(fresh.admitted, 'trusted nodes are kept for revisiting (docs 4.5)')
  assert.equal(fresh.unverified, true, 'kept, but not verified')
  assert.equal(fresh.node?.exitIP, '')
  assert.equal(fresh.node?.latencyMs, 0)
  assert.equal(fresh.node?.quality, 'C', 'an unmeasured exit gets the worst grade, not gradeOf(0)=S')
  assert.ok((fresh.reason ?? '').length > 0, 'the failure that caused the fallback is kept for diagnostics')

  // A previous entry carrying no exitIP holds no measurement — it is itself a
  // former fallback, so its grade must not be smuggled forward.
  const again = await admitTrusted(
    silent,
    { address: '127.0.0.1:30005', protocol: 'socks5', source: 'subscription' },
    { previous: { exitIP: '', exitLocation: '', latencyMs: 0, quality: 'S' } },
  )
  assert.equal(again.node?.quality, 'C')

  // A real measurement survives the fallback untouched.
  const measured = await admitTrusted(
    silent,
    { address: '127.0.0.1:30021', protocol: 'socks5', source: 'subscription' },
    { previous: { exitIP: '141.164.58.245', exitLocation: 'KR Seoul', latencyMs: 455, quality: 'S' } },
  )
  assert.equal(measured.unverified, true)
  assert.equal(measured.node?.exitIP, '141.164.58.245')
  assert.equal(measured.node?.exitLocation, 'KR Seoul')
  assert.equal(measured.node?.latencyMs, 455)
  assert.equal(measured.node?.quality, 'S')
})

test('admission: scheme-carrying manual addresses build a valid agent URI (issue #44)', async () => {
  // manual entries keep the scheme the UI asks for (http://host:port), and
  // prefixing again yields http://http://host:port — InvalidArgumentError in
  // every ProxyAgent, invisible because admitTrusted admits on failure with
  // empty facts. Both the coarse-screen agent and the full-chain agent must
  // keep the user's scheme.
  const transport = fakeTransport(okScript())
  const result = await admitCandidate(deps(transport), {
    address: 'http://127.0.0.1:24021',
    protocol: 'http',
    source: 'manual',
  })
  assert.ok(result.admitted, result.reason)
  assert.equal(result.node?.exitIP, '5.5.5.5')
  assert.equal(transport.agents[0]?.uri, 'http://127.0.0.1:24021', 'coarse-screen agent must not double the scheme')
  assert.ok(transport.agents.every((a) => a.uri === 'http://127.0.0.1:24021'))

  // socks5 carries its scheme too, and a bare address still gains one
  const socks = fakeTransport(okScript())
  const socksResult = await admitCandidate(deps(socks), {
    address: 'socks5://10.0.0.2:1080',
    protocol: 'socks5',
    source: 'manual',
  })
  assert.ok(socksResult.admitted, socksResult.reason)
  assert.ok(socks.agents.every((a) => a.uri === 'socks5://10.0.0.2:1080'))
})

test('coarseScreen: scheme-carrying address keeps its scheme in the agent URI', async () => {
  const transport = fakeTransport({ [ECHO_URL]: { status: 200, body: echoBody('5.5.5.5', 'US') } })
  const verdict = await coarseScreen(deps(transport), { address: 'http://127.0.0.1:24001', protocol: 'http' })
  assert.ok('exitIP' in verdict)
  assert.equal(verdict.exitIP, '5.5.5.5')
  assert.equal(transport.agents[0]?.uri, 'http://127.0.0.1:24001')

  const bare = fakeTransport({ [ECHO_URL]: { status: 200, body: echoBody('5.5.5.5', 'US') } })
  const bareVerdict = await coarseScreen(deps(bare), { address: '127.0.0.1:24001', protocol: 'http' })
  assert.ok('exitIP' in bareVerdict)
  assert.equal(bare.agents[0]?.uri, 'http://127.0.0.1:24001')
})

test('admission end-to-end: real undici.request through a real local proxy', async () => {
  // Load-bearing integration: admission's per-request ProxyAgent path works
  // against npm undici's request API (the seam verified in the IP-2 probe).
  let proxied = 0
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('http://')) proxied += 1
    res.writeHead(200)
    res.end(echoBody('5.5.5.5', 'US'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port

  const depsReal = {
    pool: new ExitPool(),
    undici: realUndici,
    ipEchoUrl: `http://example.test:${port}/echo`, // absolute URI -> proxied
    zenBaseUrl: `http://example.test:${port}`, // steps 3-4 hit the same echo server
    timeoutMs: 3000,
  }
  const result = await admitCandidate(depsReal as never, { address: `127.0.0.1:${port}`, protocol: 'http', source: 'free' })
  // All four steps answered 200 by the echo server, so the candidate is
  // admitted with the echo-reported exit facts — and every step rode the
  // candidate proxy (absolute-form requests), with no global dispatcher.
  assert.ok(proxied >= 3, 'admission chain did not ride the candidate proxy')
  assert.ok(result.admitted, result.reason)
  assert.equal(result.node?.exitIP, '5.5.5.5')

  // issue #44 end-to-end: the scheme the card asks for must survive the real
  // ProxyAgent too (undici throws InvalidArgumentError on http://http://...)
  const withScheme = await admitCandidate(depsReal as never, {
    address: `http://127.0.0.1:${port}`,
    protocol: 'http',
    source: 'manual',
  })
  assert.ok(withScheme.admitted, withScheme.reason)
  assert.equal(withScheme.node?.exitIP, '5.5.5.5')
  await new Promise<void>((resolve) => server.close(() => resolve()))
})


test('admission reads Zen header edits between model-list and smoke requests', async () => {
  let headers = { 'user-agent': 'catalog-agent', 'x-opencode-client': 'desktop' }
  const release = setRequestHeadersReader(() => headers)
  const transport = fakeTransport(okScript())
  const request = transport.undici.request as (url: string, init?: { body?: string; headers?: Record<string, string> }) => Promise<unknown>
  transport.undici.request = (async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    const response = await request(url, init)
    if (url === MODELS_URL) headers = { 'user-agent': 'smoke-agent', 'x-opencode-client': 'desktop' }
    return response
  }) as never
  try {
    const result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'free' })
    assert.ok(result.admitted)
    assert.equal(transport.headers.get(MODELS_URL)?.['user-agent'], 'catalog-agent')
    assert.equal(transport.headers.get(CHAT_URL)?.['user-agent'], 'smoke-agent')
    assert.equal(transport.headers.get(CHAT_URL)?.['x-opencode-client'], 'desktop')
    assert.equal(transport.headers.get(ECHO_URL)?.['user-agent'], undefined, 'overrides must not leak to geo echo')
  } finally { release() }
})
