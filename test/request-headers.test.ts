import test from 'node:test'
import assert from 'node:assert/strict'
import Schema from '@deepseek-ai/schemastery'
import { Config, ordinaryConfig, type ResolvedPluginConfig } from '../src/config.ts'
import { normalizeRequestHeaders, parseRequestHeaders, formatRequestHeaders, sanitizeRequestHeaders } from '../src/request-headers.ts'
import { disguiseHeaders, deriveRequestIDs, opencodeUserAgent, setUserAgentOverride, setRequestHeadersReader, zenRequestHeaders } from '../src/adapter/ids.ts'
import { fetchZenModels } from '../src/adapter/catalog.ts'
import { buildStatusView } from '../src/ip-pool-settings/bridge.ts'
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'

import { requestHeadersWriteOps } from '../src/client/settings-writes.ts'

const customUA = 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/node.js/24'

test('request headers are editable volatile config and ordinary consumers receive no reference', () => {
  // The schema stores the dictionary verbatim (case-insensitive folding happens
  // at the request/editor boundary, not in the schema — see config.ts).
  const config = Config({ userAgent: 'legacy-agent', requestHeaders: { 'User-Agent': customUA, 'X-OpenCode-Client': 'desktop' } })
  assert.equal(typeof config.requestHeaders.get, 'function')
  assert.deepEqual(config.requestHeaders.get(), { 'User-Agent': customUA, 'X-OpenCode-Client': 'desktop' })
  assert.equal('requestHeaders' in ordinaryConfig(config as unknown as ResolvedPluginConfig), false)
  assert.equal(ordinaryConfig(config as unknown as ResolvedPluginConfig).userAgent, 'legacy-agent')
  // ...and the wire sees the folded UA override while the client flag stays
  // pinned to the CLI (the managed header is dropped at the request boundary).
  const release = setRequestHeadersReader(() => config.requestHeaders.get())
  try {
    assert.equal(zenRequestHeaders()['user-agent'], customUA)
    assert.equal(zenRequestHeaders()['x-opencode-client'], 'cli')
  } finally { release() }
})

/** Collect every serialized node carrying `type: 'transform'`. */
function transformNodes(value: unknown): unknown[] {
  const found: unknown[] = []
  const seen = new Set<object>()
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    if ((node as { type?: unknown }).type === 'transform') found.push(node)
    for (const child of Object.values(node)) walk(child)
  }
  walk(value)
  return found
}

test('the Config schema survives the settings form round trip (no transform nodes)', () => {
  // dsh-settings' volatileForm() rebuilds the served form from Config.toJSON()
  // (`new z(schema.toJSON())`) and the browser rehydrates THAT serialization.
  // A transform node keeps its callback through the first toJSON() but loses it
  // on the rebuild, so the rehydrated node throws "callback is not a function",
  // decode() returns undefined and the settings card stays loading forever.
  // The schema must therefore contain no transform at all.
  const serialized = JSON.parse(JSON.stringify(Config.toJSON()))
  assert.deepEqual(transformNodes(serialized), [], 'a transform callback cannot survive the form round trip')

  // The practical path: rebuild (the form) then rehydrate (the browser) and
  // validate a real draft — empty and non-empty headers, plus the ip pool.
  const rebuilt = new Schema(JSON.parse(JSON.stringify(new Schema(serialized).toJSON())))
  for (const draft of [
    { requestHeaders: {}, ipPool: { enabled: false } },
    { requestHeaders: { 'User-Agent': 'custom-agent' }, ipPool: { enabled: true, manual: ['http://127.0.0.1:7897'] } },
  ]) {
    assert.doesNotThrow(() => rebuilt(draft), 'the settings form must decode the stored value')
  }
})

test('the request path is lenient while the editor boundary stays strict', () => {
  // Managed, malformed and blank entries are dropped at request time, so a
  // hand-edited profile patch can never inject them onto the wire.
  assert.deepEqual(sanitizeRequestHeaders({
    'User-Agent': ' agent ',
    Authorization: 'Bearer stolen',
    Cookie: 'a=b',
    Host: 'elsewhere',
    'Content-Length': '0',
    'X-OpenCode-Client': 'desktop',
    'Bad Name': 'x',
    'X-Blank': '   ',
    'X-Ok': 'kept',
  }), { 'user-agent': 'agent', 'x-ok': 'kept' })
  assert.deepEqual(sanitizeRequestHeaders(undefined), {})
  assert.deepEqual(sanitizeRequestHeaders([1, 2]), {})
  assert.deepEqual(sanitizeRequestHeaders({ 'X-Test': 'a'.repeat(9000) }), {})
  assert.deepEqual(
    sanitizeRequestHeaders(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`x-${String(i)}`, 'a']))),
    Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`x-${String(i)}`, 'a'])),
  )
})

test('the plugin control prefix x-oc2dsh- is managed at both boundaries', async () => {
  // The relay reads x-oc2dsh-egress as its exit directive: an override must
  // neither steer it past the pool nor leak upstream on catalog/admission.
  assert.deepEqual(sanitizeRequestHeaders({
    'X-OC2DSH-Egress': 'http://127.0.0.1:9',
    'x-oc2dsh-anything': 'x',
    'X-Ok': 'kept',
  }), { 'x-ok': 'kept' })
  assert.throws(() => normalizeRequestHeaders({ 'x-oc2dsh-egress': 'http://127.0.0.1:9' }), /managed/)
  assert.throws(() => parseRequestHeaders('X-OC2DSH-Egress: socks5://127.0.0.1:9'), /managed/)
  const release = setRequestHeadersReader(() => ({ 'x-oc2dsh-egress': 'http://127.0.0.1:9' }))
  try {
    assert.equal(zenRequestHeaders()['x-oc2dsh-egress'], undefined)
    assert.equal(disguiseHeaders(deriveRequestIDs([{ role: 'user', content: 'hello' }]))['x-oc2dsh-egress'], undefined)
    let seen: Headers | undefined
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = new Headers(init?.headers)
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 })
    }) as typeof fetch
    await fetchZenModels('https://zen.test', fetchImpl, opencodeUserAgent())
    assert.equal(seen?.get('x-oc2dsh-egress'), null, 'the catalog request never carries it')
  } finally { release() }
})

test('the header editor parses HTTP header lines and preserves colons in values', () => {
  const headers = parseRequestHeaders(`User-Agent: ${customUA}\nX-Trace: scope: local\n\n`)
  assert.deepEqual(headers, { 'user-agent': customUA, 'x-trace': 'scope: local' })
  assert.deepEqual(parseRequestHeaders(formatRequestHeaders(headers)), headers)
  assert.deepEqual(parseRequestHeaders(' \n '), {})
  assert.throws(() => parseRequestHeaders('User-Agent missing-colon'))
  assert.throws(() => parseRequestHeaders('User-Agent: a\nUSER-agent: b'), /duplicate/i)
})

test('invalid headers are rejected at the editor boundary', () => {
  for (const invalid of [
    { 'Bad Name': 'x' }, { 'User-Agent': 'x\r\nInjected: yes' }, { 'X-Test': '\0' },
    { 'X-Test': '' }, { 'X-Test': '💥' }, { Host: 'elsewhere' }, { Authorization: 'test' },
    { Cookie: 'test' }, { 'Content-Length': '0' }, { Connection: 'close' },
    { 'Content-Type': 'text/plain' }, { 'Transfer-Encoding': 'chunked' },
    { 'X-OpenCode-Client': 'desktop' },
    { 'X-Test': 'a'.repeat(8193) }, { 'X-Test': 123 },
    Object.fromEntries(Array.from({length:33}, (_, i) => [`x-${i}`, 'a'])),
  ]) {
    assert.throws(() => normalizeRequestHeaders(invalid), `must reject ${JSON.stringify(invalid).slice(0, 60)}`)
  }
  // The editor takes TEXT, so it is judged on what a draft line can express:
  // a bad name, a duplicate, a managed header, a blank value and an oversize
  // value are all refused before a save can be attempted. A CRLF is not a value
  // problem here — it is a second line, validated as its own header.
  for (const text of [
    'Bad Name: x', 'User-Agent: a\nUSER-agent: b', 'Host: elsewhere',
    'Authorization: Bearer stolen', 'Cookie: a=b', 'x-opencode-client: desktop',
    'X-Test:', `X-Test: ${'a'.repeat(8193)}`,
  ]) {
    assert.throws(() => parseRequestHeaders(text), `editor must refuse ${JSON.stringify(text.slice(0, 40))}`)
  }
})

test('live overrides reach chat, catalog and effective-UA status without reinstalling a reader', async () => {
  let value = { 'User-Agent': customUA, 'X-OpenCode-Client': 'desktop', 'X-Local-Probe': 'one' }
  setUserAgentOverride('legacy-agent')
  const dispose = setRequestHeadersReader(() => value)
  try {
    const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }])
    const headers = disguiseHeaders(ids)
    assert.equal(headers['user-agent'], customUA)
    assert.equal(headers['x-opencode-client'], 'cli', 'the override dict cannot move the client flag')
    assert.equal(headers['x-local-probe'], 'one')
    assert.equal(headers['x-opencode-session'], ids.session)
    assert.equal(opencodeUserAgent(), customUA)
    assert.equal(buildStatusView(null, false, []).zenUserAgent, customUA)
    const seen: Headers[] = []
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return Response.json({ data: [{ id: 'big-pickle' }] })
    }) as typeof fetch
    await fetchZenModels('https://zen.test', fetcher, opencodeUserAgent())
    assert.equal(seen[0]?.get('user-agent'), customUA)
    assert.equal(seen[0]?.get('x-local-probe'), 'one')
    assert.equal(seen[0]?.get('authorization'), 'Bearer public')
    value = { 'User-Agent': 'updated-agent', 'X-OpenCode-Client': 'cli', 'X-Local-Probe': 'two' }
    assert.equal(disguiseHeaders(ids)['user-agent'], 'updated-agent')
    assert.equal(buildStatusView(null, false, []).zenUserAgent, 'updated-agent')
    assert.equal(zenRequestHeaders()['x-local-probe'], 'two')
  } finally { dispose(); setUserAgentOverride(undefined) }
})

test('clearing overrides restores the built-in UA and disposing restores defaults', () => {
  let value: Record<string, string> = { 'user-agent': customUA }
  setUserAgentOverride('legacy-agent')
  const dispose = setRequestHeadersReader(() => value)
  try {
    assert.equal(opencodeUserAgent(), customUA)
    value = {}
    assert.equal(opencodeUserAgent(), 'legacy-agent')
    assert.equal(zenRequestHeaders()['x-opencode-client'], 'cli')
  } finally { dispose(); setUserAgentOverride(undefined) }
  assert.match(opencodeUserAgent(), /^opencode\/latest\/\d+\.\d+\.\d+\/cli$/)
})


test('header save writes only the dedicated field and blank restores inherited defaults', () => {
  assert.deepEqual(requestHeadersWriteOps('User-Agent: custom', {}, {}), [
    { op: 'set', path: ['requestHeaders'], value: { 'user-agent': 'custom' } },
  ])
  assert.deepEqual(requestHeadersWriteOps('', { 'user-agent': 'custom' }, {}), [
    { op: 'unset', path: ['requestHeaders'] },
  ])
  assert.deepEqual(requestHeadersWriteOps('User-Agent: custom', { 'user-agent': 'custom' }, {}), [])
})

test('the real pi-ai dispatch sends exact overrides for chat and Responses and reads live edits', async (t) => {
  let value: Record<string, string> = { 'user-agent': customUA, 'x-local-probe': 'first' }
  const release = setRequestHeadersReader(() => value)
  t.after(release)
  const seen: Array<{ url: string; headers: Headers }> = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) })
    return Response.json({ error: { message: 'local terminal response', type: 'invalid_request_error' } }, { status: 400 })
  })
  const adapter = new ZenAdapter({
    list: () => ['big-pickle', 'muse-spark-1.2-contributor-free'],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => undefined,
  })
  for (const model of ['big-pickle', 'muse-spark-1.2-contributor-free']) {
    const before = seen.length
    for await (const chunk of adapter.stream({ provider: 'oc2dsh', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'local test' }] }] })) void chunk
    assert.equal(seen.length, before + 1)
    const request = seen.at(-1)!
    assert.equal(request.headers.get('user-agent'), value['user-agent'])
    assert.equal(request.headers.get('x-local-probe'), value['x-local-probe'])
    assert.equal(request.headers.get('x-opencode-client'), 'cli')
    assert.equal(request.headers.get('authorization'), 'Bearer public')
    assert.match(request.url, model === 'big-pickle' ? /chat\/completions/ : /responses/)
    value = { 'user-agent': 'updated-agent', 'x-local-probe': 'second' }
  }
})
