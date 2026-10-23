import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalSessionID, conversationSeed, DEFAULT_PROJECT_ID, deriveRequestIDs, disguiseHeaders, mintedMessageID, opencodeUserAgent, randomID, setUserAgentOverride, ZEN_UA_CHANNEL, ZEN_UA_VERSION, zenRequestHeaders, zenUserAgent } from '../src/adapter/ids.ts'

test('randomID differs per call with the requested size', () => {
  const a = randomID('req', 16)
  const b = randomID('req', 16)
  assert.notEqual(a, b)
  assert.ok(a.startsWith('req_'))
  assert.equal(a.slice('req_'.length).length, 32, '16 bytes hex')
})

test('canonicalSessionID passes in-window official sessions through unchanged', () => {
  // the client's own descending layout with counter 1 (upstream PR #70 fixture)
  const official = 'ses_ecc5beb7cffe2U0aluUnb5nnpZ'
  assert.match(official, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(canonicalSessionID(official), official)
  // foreign shapes do NOT match the canonical gate: 24-hex is the wrong length
  assert.doesNotMatch('ses_0123456789abcdef01234567', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

/**
 * The free tier decodes the 12-hex prefix as ~(unix_ms*0x1000+counter) in its
 * low 48 bits, requires the inversion, and accepts only counters 0-63
 * (2026-10-13 upstream jasonxu114514/opencode2api PR #69 + #70,
 * decolua/9router#4780). Re-probed live 2026-10-15 against /inference/v1 with
 * the full gate body, one variable at a time: counters 0, 1, 32, 63 -> 200;
 * 64, 128 -> 403; ts36=1 -> 200 (the timestamp half is not checked); a
 * digest-shaped or ascending prefix -> 403.
 */
function decodedWord(id: string): bigint {
  const field = BigInt('0x' + id.slice(4, 16))
  return ~field & ((1n << 48n) - 1n)
}

function decodedCounter(id: string): number {
  return Number(decodedWord(id) & 0xfffn)
}

function digestTailOf(signal: string): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  let n = BigInt('0x' + sum.subarray(6, 16).toString('hex'))
  const out = new Array<string>(14)
  for (let i = 13; i >= 0; i--) {
    out[i] = alphabet.charAt(Number(n % 62n))
    n /= 62n
  }
  return out.join('')
}

test('canonicalSessionID mints the descending layout with counter 1 (free-tier regression)', () => {
  const id = canonicalSessionID('regression-probe')
  assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  // the acceptance window: the low 12 bits read 0xFFF-counter = 0xFFE
  assert.match(id.slice(4, 16), /^[0-9a-f]{9}f[c-f][0-9a-f]$/)
  assert.equal(decodedCounter(id), 1, 'counter 1 is always inside the accepted 0-63 window')

  // digest-derived, not clock-derived: no shared counter to walk out of the
  // window, and the same signal keeps the same id across process restarts
  // (the removed in-memory cache could only promise that per process).
  assert.equal(canonicalSessionID('regression-probe'), id)

  // the exact id shape the gate rejects: raw sha256 bytes labelled as a
  // timestamp (~word would not decode to counter 1)
  const digestPrefix = createHash('sha256').update('ses\x00regression-probe').digest().subarray(0, 6).toString('hex')
  assert.notEqual(id.slice(4, 16), digestPrefix)

  // The digest tail is what keeps affinity: still sha256-derived, not random.
  assert.ok(id.endsWith(digestTailOf('regression-probe')), 'tail stays digest-derived (affinity unchanged)')
})

test('canonicalSessionID re-encodes canonical ids whose counter is outside the window', () => {
  // right shape, rejected encoding: ascending word, counter 64 (0xFBF) and the
  // raw-hash layout this adapter used before the PR #69 port
  const rejected = [
    'ses_133a414840012U0aluUnb5nnpZ',
    'ses_ecc1f76c9fbf3zWGdD1GSCEwPf',
    'ses_088a704c30424N5kWDK0snKFbd',
  ]
  for (const id of rejected) {
    const got = canonicalSessionID(id)
    assert.notEqual(got, id, `${id} kept a rejected encoding`)
    assert.match(got, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    assert.match(got.slice(4, 16), /^[0-9a-f]{9}f[c-f][0-9a-f]$/)
    assert.equal(decodedCounter(got), 1)
  }
  // boundary: counter 63 (field low 12 bits 0xFC0) is the last accepted value,
  // counter 64 (0xFBF) the first rejected one
  const at63 = 'ses_000000000fc02U0aluUnb5nnpZ'
  const at64 = 'ses_000000000fbf2U0aluUnb5nnpZ'
  assert.equal(decodedCounter(at63), 63)
  assert.equal(decodedCounter(at64), 64)
  assert.equal(canonicalSessionID(at63), at63)
  assert.notEqual(canonicalSessionID(at64), at64)
})

test('canonicalSessionID is stable per signal and distinct across signals', () => {
  // same conversation keeps a stable session (deterministic mint, PR #70 —
  // no cache and no counter, so this also survives a process restart)
  assert.equal(canonicalSessionID('anything'), canonicalSessionID('anything'))
  // distinct identities stay distinct — different tails at minimum
  assert.notEqual(canonicalSessionID('a'), canonicalSessionID('b'))
  // two signals minted in the same millisecond still differ (digest tails)
  assert.notEqual(canonicalSessionID('same-ms-a'), canonicalSessionID('same-ms-b'))
})

test('deriveRequestIDs emits canonical-shape sessions', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }])
  assert.match(ids.session, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

test('conversationSeed uses the first user turn and skips non-user messages', () => {
  const messages = [
    { role: 'system', content: 'sys prompt' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: { text: 'first question' } },
    { role: 'user', content: 'second' },
  ]
  assert.equal(conversationSeed(messages), JSON.stringify({ text: 'first question' }))
  assert.equal(conversationSeed([]), '')
  assert.equal(conversationSeed([{ role: 'assistant', content: 'x' }]), '')
  assert.equal(conversationSeed([{ role: 'user', content: null }]), '', 'null content is skipped')
})

test('deriveRequestIDs keeps the session stable across turns and randomizes requests', () => {
  const turnOne = [{ role: 'user', content: 'hello' }]
  const turnTwo = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'more' },
  ]
  const first = deriveRequestIDs(turnOne)
  const second = deriveRequestIDs(turnTwo)
  assert.equal(first.session, second.session)
  assert.notEqual(first.request, second.request)
  assert.equal(first.project, second.project)
  // 2026-10-14: the request id must be a msg_* MESSAGE id and the project id
  // must be the client's prefix-less `ProjectID` — `req_*` and `prj_*` each
  // answer 403 FreeTierError on their own (live-probed against /inference/v1).
  assert.match(first.request, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(first.project, DEFAULT_PROJECT_ID)
  assert.equal(first.project, 'global')
  assert.equal(first.parentSession, '')
  // fallback: no user content at all still yields usable ids
  const empty = deriveRequestIDs([{ role: 'system', content: 'only system' }])
  assert.ok(empty.session.startsWith('ses_'))
  assert.notEqual(empty.session, deriveRequestIDs([{ role: 'system', content: 'only system' }]).session)
})

test('disguiseHeaders carries the CLI-identical correlation set', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }])
  const headers = disguiseHeaders(ids)
  assert.equal(headers['user-agent'], opencodeUserAgent())
  assert.equal(headers['x-opencode-client'], 'cli')
  assert.equal(headers['x-opencode-session'], ids.session)
  assert.equal(headers['x-opencode-session-id'], ids.session)
  // the client sends x-session-affinity / X-Session-Id only for its NON-opencode
  // providers; adding them to an opencode-provider request is a 403 since
  // 2026-10-14 (they were the 2026-10-09 workaround).
  assert.equal(headers['x-session-affinity'], undefined)
  assert.equal(headers['X-Session-Id'], undefined)
  assert.equal(headers['x-opencode-request'], ids.request)
  assert.equal(headers['x-opencode-project'], ids.project)
  assert.ok(headers['user-agent'].startsWith('opencode/'))
  // The built-in UA is the current client's shape, and its last segment is the
  // same flag the request carries in x-opencode-client (OpenCode Desktop
  // 2.1.3 builds `opencode/${channel}/${version}/${name}`).
  assert.equal(headers['user-agent'], `opencode/${ZEN_UA_CHANNEL}/${ZEN_UA_VERSION}/cli`)
  assert.equal(headers['user-agent'], zenUserAgent(headers['x-opencode-client']))
})

test('the built-in user-agent follows the effective x-opencode-client flag', () => {
  // Desktop mode (a live settings override, or a caller-supplied base header)
  // must move the UA's client segment with it, or the fingerprint stops being
  // coherent with the header.
  assert.equal(zenRequestHeaders({ 'x-opencode-client': 'desktop' })['user-agent'], `opencode/${ZEN_UA_CHANNEL}/${ZEN_UA_VERSION}/desktop`)
  assert.equal(zenRequestHeaders({ 'X-Opencode-Client': 'desktop' })['user-agent'], `opencode/${ZEN_UA_CHANNEL}/${ZEN_UA_VERSION}/desktop`)
  // an explicit user-agent still wins over the derived one
  assert.equal(zenRequestHeaders({ 'user-agent': 'opencode/latest/2.1.3/desktop' })['user-agent'], 'opencode/latest/2.1.3/desktop')
})

test('the configured user-agent override moves every header set, and clearing restores the built-in value', () => {
  const ids = deriveRequestIDs([{ role: 'user', content: 'hello' }])
  const builtIn = opencodeUserAgent()
  assert.match(builtIn, /^opencode\/latest\/\d+\.\d+\.\d+\/cli$/, 'the shipped value is the current client shape')
  const desktop = 'opencode/latest/2.1.3/desktop'
  try {
    setUserAgentOverride(desktop)
    assert.equal(opencodeUserAgent(), desktop, 'the override wins')
    assert.equal(disguiseHeaders(ids)['user-agent'], desktop, 'the wire header set follows it')
    // whitespace-only is "unset", never a blank header on the wire
    setUserAgentOverride('   ')
    assert.equal(opencodeUserAgent(), builtIn)
  } finally {
    setUserAgentOverride('')
  }
  assert.equal(opencodeUserAgent(), builtIn, 'a cleared setting leaves the shipped value in force')
  assert.equal(disguiseHeaders(ids)['user-agent'], builtIn, 'and so does every header set built after it')
})
