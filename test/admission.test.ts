import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import * as realUndici from 'undici'

import { ExitPool } from '../src/pool/pool.ts'
import { admitCandidate, admitBySpeed, admitTrusted, coarseScreen, type AdmissionDeps } from '../src/pool/admission.ts'
import { GENUINE_GATE_TOOLS } from '../src/adapter/gate-tools.ts'
import { currentProjectID, setRequestHeadersReader } from '../src/adapter/ids.ts'

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
  // messages[0] is the system slot that carries the `<env>` block the free lane
  // requires (adapter/env-block.ts); the probe sentence is the user turn after it.
  return body.messages[1]!.content
}

test('admission: the four-step happy path admits with exit facts and grade', async () => {
  const transport = fakeTransport(okScript())
  const result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'manual' })
  assert.ok(result.admitted, result.reason)
  assert.equal(result.node?.exitIP, '5.5.5.5')
  assert.equal(result.node?.exitLocation, 'US city')
  assert.equal(result.node?.source, 'manual')
  assert.equal(result.node?.quality, 'S') // latency ~0
  // exactly the three scripted requests, in chain order
  assert.deepEqual(transport.calls, [ECHO_URL, MODELS_URL, CHAT_URL])
  // the proxy agent targeted the candidate
  assert.equal(transport.agents[0]?.uri, 'http://h:1')
})

test('admission: fail-fast at each step (echo/geo/latency/models/smoke)', async () => {
  // step 1-2: non-200 echo
  let transport = fakeTransport({ ...okScript(), [ECHO_URL]: { status: 503, body: '' } })
  let result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'manual' })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /echo HTTP 503/)

  // step 2: echo without an exit IP
  transport = fakeTransport({ ...okScript(), [ECHO_URL]: { status: 200, body: '{"status":"fail"}' } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'manual' })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /exit IP/)

  // step 2: geo-blocked country
  transport = fakeTransport({ ...okScript(), [ECHO_URL]: { status: 200, body: echoBody('5.5.5.5', 'CN') } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'manual' }, { timeoutMs: 1000 })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /geo-blocked CN/)

  // step 3: HTTPS tunnel to the real upstream fails
  transport = fakeTransport({ ...okScript(), [MODELS_URL]: { status: 403, body: '' } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'manual' }, { timeoutMs: 1000 })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /zen models HTTP 403/)

  // step 4: anonymous-lane smoke 429 -> admitted with `limited` (good exit,
  // quota consumed elsewhere; the caller cools it, docs 4.5)
  transport = fakeTransport({ ...okScript(), [CHAT_URL]: { status: 429, body: '' } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'manual' }, { timeoutMs: 1000 })
  assert.ok(result.admitted, result.reason)
  assert.ok(result.limited)
  assert.equal(result.node?.exitIP, '5.5.5.5')

  // step 4: any other smoke failure still rejects outright
  transport = fakeTransport({ ...okScript(), [CHAT_URL]: { status: 403, body: '' } })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'manual' }, { timeoutMs: 1000 })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /zen smoke HTTP 403/)

  // the smoke body must satisfy the free-lane gate recipe: streaming, the
  // GENUINE bash+read definitions, and a canonical ses_* session header.
  // `tool_choice` is left to the model — the gate rejects `'none'`.
  const okTransport = fakeTransport(okScript())
  const okResult = await admitCandidate(deps(okTransport), { address: 'h:1', protocol: 'http', source: 'manual' }, { timeoutMs: 1000 })
  assert.ok(okResult.admitted)
  const smokeBody = JSON.parse(okTransport.bodies.get(CHAT_URL)!) as {
    stream?: boolean
    tool_choice?: string
    messages?: Array<{ role: string; content: string }>
    tools?: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>
  }
  assert.equal(smokeBody.stream, true)
  assert.equal(smokeBody.tool_choice, undefined, 'none is a 403 of its own')
  // The system slot carries the `<env>` block the free lane demands,
  // so the probe sentence is the turn AFTER it.
  const smokeMessages = smokeBody.messages ?? []
  assert.equal(smokeMessages.length, 2)
  assert.equal(smokeMessages[0]!.role, 'system')
  assert.match(smokeMessages[0]!.content, /^Today's date: [^\n]+\n\nHere is some useful information about the environment you are running in:\n<env>\n/)
  assert.deepEqual(smokeMessages[1], { role: 'user', content: 'hello' }, 'the unconfigured probe content is hello')
  const smokeToolNames = smokeBody.tools?.map((t) => t.function.name) ?? []
  assert.deepEqual([...smokeToolNames].sort(), ['read', 'shell'])
  for (const tool of smokeBody.tools ?? []) {
    const genuine = GENUINE_GATE_TOOLS[tool.function.name as 'shell' | 'read']
    assert.deepEqual(tool.function, genuine.function, 'the smoke carries the genuine gate definitions')
  }
  const smokeHeaders = okTransport.headers.get(CHAT_URL)!
  assert.match(smokeHeaders['x-opencode-session'] ?? '', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, 'canonical session header')
  // the 2.1.4 recipe: four session spellings, no request header, prefix-less project
  assert.equal(smokeHeaders['x-session-affinity'], smokeHeaders['x-opencode-session'], 'the affinity pair carries the same id')
  assert.equal(smokeHeaders['x-opencode-request'], undefined, 'the 2.x wire carries no request header')
  assert.equal(smokeHeaders['x-opencode-project'], currentProjectID(), 'the client\'s project id for this directory')

  // transport errors surface as reasons (timeout / reset)
  transport = fakeTransport({ '*': new Error('connect ECONNREFUSED') })
  result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'manual' }, { timeoutMs: 1000 })
  assert.ok(!result.admitted)
  assert.match(result.reason!, /ECONNREFUSED/)
})

test('admission: the probe content is drawn at random from the configured pool', async () => {
  // The operator may configure several probe contents; admission draws one
  // of them at random.
  const pool = ['alpha', 'beta', 'gamma']
  const first = fakeTransport(okScript())
  await admitCandidate(deps(first, { smokeContents: pool, random: () => 0 }), { address: 'h:1', protocol: 'http', source: 'manual' })
  assert.equal(smokeContentOf(first), 'alpha')

  const last = fakeTransport(okScript())
  await admitCandidate(deps(last, { smokeContents: pool, random: () => 0.99 }), { address: 'h:2', protocol: 'http', source: 'manual' })
  assert.equal(smokeContentOf(last), 'gamma')

  // A hand-typed list with blanks and duplicates still yields a valid turn.
  const messy = fakeTransport(okScript())
  await admitCandidate(deps(messy, { smokeContents: ['  ', 'only'], random: () => 0.5 }), { address: 'h:3', protocol: 'http', source: 'manual' })
  assert.equal(smokeContentOf(messy), 'only')

  // A pre-drawn pass value wins: one random probe content per exit — the
  // caller probing ONE exit across several models draws once and hands the
  // same turn to every model of that pass.
  const pinned = fakeTransport(okScript())
  await admitCandidate(deps(pinned, { smokeContents: pool, smokeContent: 'drawn-once', random: () => 0.99 }), { address: 'h:4', protocol: 'http', source: 'manual' })
  assert.equal(smokeContentOf(pinned), 'drawn-once', 'the pass value is not re-drawn')
})

test('admission: latency gate', async () => {
  // The gate rejects a candidate whose echo answers slower than 3000 ms. It
  // reads latencyMs from Date.now(), so this pins only the fast path: a
  // latency-~0 answer admits.
  const transport = fakeTransport(okScript())
  // fast path admits (latency ~0)
  const fastResult = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'manual' })
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
 * The trusted fallback re-admits unreachable subscription exits on every probe
 * round and the caller markOk()s them — state `ok`, grade `S` (gradeOf(0) is
 * 'S'), exitIP unknown — so the picker would rank them FIRST and feed them
 * real requests that die in transport. It must report `unverified` and grade
 * an unmeasured exit C instead.
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

/**
 * The subscription contract: a subscription add/refresh probes nothing on
 * OpenCode, it only shows the speed-test latency. admitBySpeed therefore runs
 * the ip-api echo ONLY — the models list and the anonymous smoke are never
 * touched, and a failed speed test keeps the paid line unverified instead of
 * rejecting it (docs 4.5).
 */
test('admission: admitBySpeed runs the speed test alone and never touches OpenCode', async () => {
  const warnings: string[] = []
  const transport = fakeTransport({
    [ECHO_URL]: { status: 200, body: echoBody('203.0.113.7', 'JP', 'Tokyo') },
  })
  const silent = { ...deps(transport), logger: { warn: (m: string) => warnings.push(m) } }

  const result = await admitBySpeed(silent, { address: '1.2.3.4:8080', protocol: 'http', source: 'subscription' })
  assert.ok(result.admitted)
  assert.equal(result.unverified, undefined, 'a measured speed pass is a verification')
  assert.equal(result.node?.exitIP, '203.0.113.7')
  assert.equal(result.node?.exitLocation, 'JP Tokyo')
  assert.ok(['S', 'A', 'B', 'C'].includes(result.node!.quality), 'grade comes from the measured latency')
  // The ONLY request made was the echo: no models list, no chat smoke.
  assert.deepEqual(transport.calls, [ECHO_URL], 'admitBySpeed issues exactly one request — the speed test')

  // Failure keeps the paid line: admitted, unverified, no facts, worst grade.
  const failing = fakeTransport({ [ECHO_URL]: new Error('connect ETIMEDOUT') })
  const failed = await admitBySpeed(
    { ...deps(failing), logger: { warn: (m) => warnings.push(m) } },
    { address: '5.6.7.8:1080', protocol: 'socks5', source: 'subscription' },
  )
  assert.ok(failed.admitted, 'a paid line is never rejected over one probe failure (docs 4.5)')
  assert.equal(failed.unverified, true)
  assert.equal(failed.node?.exitIP, '')
  assert.equal(failed.node?.quality, 'C', 'unmeasured -> worst grade, never gradeOf(0)=S')
  assert.ok(warnings.some((line) => line.includes('5.6.7.8:1080')))
  assert.deepEqual(failing.calls, [ECHO_URL], 'even the failure path only ever ran the speed test')
})

test('admission: scheme-carrying manual addresses build a valid agent URI', async () => {
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
  // against npm undici's request API.
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
  const result = await admitCandidate(depsReal as never, { address: `127.0.0.1:${port}`, protocol: 'http', source: 'manual' })
  // All four steps answered 200 by the echo server, so the candidate is
  // admitted with the echo-reported exit facts — and every step rode the
  // candidate proxy (absolute-form requests), with no global dispatcher.
  assert.ok(proxied >= 3, 'admission chain did not ride the candidate proxy')
  assert.ok(result.admitted, result.reason)
  assert.equal(result.node?.exitIP, '5.5.5.5')

  // the scheme the card asks for must survive the real
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
  let headers = { 'user-agent': 'catalog-agent', 'x-local-probe': 'one' }
  const release = setRequestHeadersReader(() => headers)
  const transport = fakeTransport(okScript())
  const request = transport.undici.request as (url: string, init?: { body?: string; headers?: Record<string, string> }) => Promise<unknown>
  transport.undici.request = (async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    const response = await request(url, init)
    if (url === MODELS_URL) headers = { 'user-agent': 'smoke-agent', 'x-local-probe': 'two' }
    return response
  }) as never
  try {
    const result = await admitCandidate(deps(transport), { address: 'h:1', protocol: 'http', source: 'manual' })
    assert.ok(result.admitted)
    assert.equal(transport.headers.get(MODELS_URL)?.['user-agent'], 'catalog-agent')
    assert.equal(transport.headers.get(CHAT_URL)?.['user-agent'], 'smoke-agent')
    assert.equal(transport.headers.get(CHAT_URL)?.['x-local-probe'], 'two')
    assert.equal(transport.headers.get(CHAT_URL)?.['x-opencode-client'], 'cli', 'the client flag stays pinned across the edits')
    assert.equal(transport.headers.get(ECHO_URL)?.['user-agent'], undefined, 'overrides must not leak to geo echo')
  } finally { release() }
})

/**
 * The lane origin ladder (adapter/lane.ts), from the pool's side: the adapter
 * serves chat from whichever door answers, so an exit that reaches only ONE of
 * the two lane origins is a good exit. Probing a single origin would reject it
 * and churn the pool while real conversations kept working.
 */
test('admission: walks the ladder and admits an exit that only reaches the console origin', async () => {
  const transport = fakeTransport({
    [ECHO_URL]: { status: 200, body: echoBody('5.5.5.5', 'US') },
    'https://primary.test/v1/models': { status: 403, body: '{"type":"error"}' },
    'https://console.test/v1/models': { status: 200, body: '{"data":[]}' },
    'https://primary.test/v1/chat/completions': { status: 403, body: '{}' },
    'https://console.test/v1/chat/completions': { status: 200, body: '{"id":"x"}' },
  })
  const result = await admitCandidate(
    deps(transport, { zenBaseUrl: 'https://primary.test', fallbackBaseUrl: 'https://console.test' }),
    { address: 'h:9', protocol: 'http', source: 'manual' },
  )
  assert.ok(result.admitted, result.reason)
  assert.deepEqual(transport.calls, [
    ECHO_URL,
    'https://primary.test/v1/models',
    'https://console.test/v1/models',
    'https://primary.test/v1/chat/completions',
    'https://console.test/v1/chat/completions',
  ])
})

test('admission: both doors failing rejects with the primary door\'s verdict', async () => {
  const transport = fakeTransport({
    [ECHO_URL]: { status: 200, body: echoBody('5.5.5.5', 'US') },
    'https://primary.test/v1/models': { status: 502, body: 'bad gateway' },
    'https://console.test/v1/models': { status: 503, body: 'unavailable' },
  })
  const result = await admitCandidate(
    deps(transport, { zenBaseUrl: 'https://primary.test', fallbackBaseUrl: 'https://console.test' }),
    { address: 'h:10', protocol: 'http', source: 'manual' },
  )
  assert.equal(result.admitted, false)
  assert.equal(result.reason, 'zen models HTTP 502')
})

/**
 * Probe sockets must not outlive the verdict. A wild proxy that never answers,
 * or an answer whose body the probe never reads, used to keep its socket open
 * for the life of the host (hundreds of ESTABLISHED/CLOSED sockets to random
 * proxy ports on a long-running host).
 */
async function proxyListener(onSocket: (socket: import('node:net').Socket) => void) {
  const net = await import('node:net')
  const open = new Set<import('node:net').Socket>()
  const server = net.createServer((socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    socket.on('error', () => {})
    onSocket(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const settled = async (): Promise<number> => {
    for (let i = 0; i < 40 && open.size > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25))
    return open.size
  }
  const stop = async () => {
    for (const socket of open) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return { port, settled, stop }
}

test('coarse screen: a proxy that never answers loses its socket at the timeout', async () => {
  // Reads but never replies: the request stays pending past the probe timeout.
  const proxy = await proxyListener((socket) => socket.resume())
  try {
    const verdict = await coarseScreen(
      { undici: realUndici, ipEchoUrl: 'http://example.test/echo' } as never,
      { address: `127.0.0.1:${proxy.port}`, protocol: 'http' },
      { timeoutMs: 150 },
    )
    assert.ok('rejected' in verdict && /timed out/.test(verdict.rejected), JSON.stringify(verdict))
    assert.equal(await proxy.settled(), 0, 'the probe left its proxy socket open')
  } finally { await proxy.stop() }
})

test('admission: an unread lane body does not pin the proxy socket', async () => {
  // Echo answers normally; the models probe gets a 503 whose chunked body never
  // ends. The probe reads only the status, so the body is never drained.
  const proxy = await proxyListener((socket) => {
    socket.on('data', (chunk) => {
      const line = chunk.toString('latin1')
      if (line.includes('/echo')) {
        const body = echoBody('5.5.5.5', 'US')
        socket.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      } else {
        socket.write('HTTP/1.1 503 Busy\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n')
      }
    })
  })
  try {
    const result = await admitCandidate(
      {
        pool: new ExitPool(),
        undici: realUndici,
        ipEchoUrl: 'http://example.test/echo',
        zenBaseUrl: 'http://example.test',
        timeoutMs: 1000,
      } as never,
      { address: `127.0.0.1:${proxy.port}`, protocol: 'http', source: 'manual' },
    )
    assert.equal(result.admitted, false)
    assert.equal(result.reason, 'zen models HTTP 503')
    assert.equal(await proxy.settled(), 0, 'the unread body kept the proxy socket open')
  } finally { await proxy.stop() }
})
