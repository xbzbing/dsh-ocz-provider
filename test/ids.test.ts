import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalSessionID, conversationSeed, DEFAULT_PROJECT_ID, deriveRequestIDs, disguiseHeaders, mintedMessageID, opencodeUserAgent, randomID, resetSessionIDCache, setUserAgentOverride, ZEN_UA_CHANNEL, ZEN_UA_VERSION, zenRequestHeaders, zenUserAgent } from '../src/adapter/ids.ts'

test('randomID differs per call with the requested size', () => {
  const a = randomID('req', 16)
  const b = randomID('req', 16)
  assert.notEqual(a, b)
  assert.ok(a.startsWith('req_'))
  assert.equal(a.slice('req_'.length).length, 32, '16 bytes hex')
})

test('canonicalSessionID passes a FRESH official session through unchanged', () => {
  resetSessionIDCache()
  // The client's own layout — inverted word, unix_ms in the 36-bit field — but
  // with a timestamp of "now": that is what the lane accepts.
  const word = (BigInt(Date.now()) << 12n) | 1n
  const official = `ses_${(~word & ((1n << 48n) - 1n)).toString(16).padStart(12, '0')}2U0aluUnb5nnpZ`
  assert.match(official, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(canonicalSessionID(official), official, 'a fresh client id keeps its identity')
  // The fixture's prefix decodes to about two weeks ago, so it is still inside
  // the freshness window and keeps its identity — freshness, not age in days,
  // is the rule.
  const fixture = 'ses_ecc5beb7cffe2U0aluUnb5nnpZ'
  assert.equal(canonicalSessionID(fixture), fixture)
  // An id whose timestamp is outside the window is re-minted instead (the full
  // matrix lives in the stale/future test below).
  const staleWord = (BigInt(Date.now() - 90 * 24 * 60 * 60 * 1000) << 12n) | 1n
  const stale = `ses_${(~staleWord & ((1n << 48n) - 1n)).toString(16).padStart(12, '0')}2U0aluUnb5nnpZ`
  assert.notEqual(canonicalSessionID(stale), stale)
  // foreign shapes do NOT match the canonical gate: 24-hex is the wrong length
  assert.doesNotMatch('ses_0123456789abcdef01234567', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

/**
 * The free tier decodes the 12-hex prefix as ~(unix_ms*0x1000+counter) in its
 * low 48 bits and requires the inversion; it refuses a timestamp it cannot
 * believe (future or effectively random) and counter 0. The tests below pin
 * that rule: a fresh, inverted, clock-based prefix.
 */
function decodedWord(id: string): bigint {
  const field = BigInt('0x' + id.slice(4, 16))
  return ~field & ((1n << 48n) - 1n)
}

function decodedCounter(id: string): number {
  return Number(decodedWord(id) & 0xfffn)
}

/**
 * The unix-ms timestamp the inverted prefix decodes to, as the lane reads it:
 * a 36-bit field, so `unix_ms mod 2^36` (≈ 2.2 years of range). Compare it with
 * {@link timeFieldOf} rather than with a raw `Date.now()`.
 */
function decodedTime(id: string): number {
  return Number((decodedWord(id) >> 12n) & ((1n << 36n) - 1n))
}

/** The 36-bit field a given wall-clock instant lands in. */
function timeFieldOf(ms: number): number {
  return Number(BigInt(ms) & ((1n << 36n) - 1n))
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

test('canonicalSessionID mints a FRESH clock-based prefix (the 2026-10-25 rule)', () => {
  resetSessionIDCache()
  const before = Date.now()
  const id = canonicalSessionID('regression-probe')
  assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)

  // The gate decodes this field as ~(unix_ms*0x1000+counter): the timestamp it
  // reads back must be the moment of minting, not a digest — a digest-derived
  // prefix decodes to a random timestamp, which the lane refuses with 429.
  const ms = decodedTime(id)
  assert.ok(Math.abs(ms - timeFieldOf(before)) < 5_000, `prefix decodes to ${ms}, expected ~${timeFieldOf(before)}`)
  assert.ok(decodedCounter(id) >= 1, 'counter 0 is the one refused value (probed 2026-10-25)')

  // stable per signal for the life of the process (the lane only accepts a
  // fresh timestamp, so this is a process cache, not a pure function)
  assert.equal(canonicalSessionID('regression-probe'), id)

  // the digest tail is what keeps affinity: sha256-derived, not random
  assert.ok(id.endsWith(digestTailOf('regression-probe')), 'tail stays digest-derived (affinity unchanged)')
  // and the rejected scheme really is rejected: the digest is not a timestamp
  const digestPrefix = createHash('sha256').update('ses\x00regression-probe').digest().subarray(0, 6).toString('hex')
  assert.notEqual(id.slice(4, 16), digestPrefix)
})

test('canonicalSessionID re-mints ids whose decoded timestamp is stale or in the future', () => {
  resetSessionIDCache()
  const encode = (ms: number, counter = 1): string => {
    const word = (BigInt(ms) << 12n) | BigInt(counter)
    return (~word & ((1n << 48n) - 1n)).toString(16).padStart(12, '0')
  }
  const fresh = `ses_${encode(Date.now())}2U0aluUnb5nnpZ`
  // A fresh client id passes through untouched (affinity preserved).
  assert.equal(canonicalSessionID(fresh), fresh)

  // Stale (older than the window) and future (beyond clock skew) ids are
  // re-minted with a fresh prefix — the lane answers 429 to both.
  for (const [label, ms] of [
    ['90 days old', Date.now() - 90 * 24 * 60 * 60 * 1000],
    ['30 days ahead', Date.now() + 30 * 24 * 60 * 60 * 1000],
  ] as const) {
    const stale = `ses_${encode(ms)}2U0aluUnb5nnpZ`
    const got = canonicalSessionID(stale)
    assert.notEqual(got, stale, `${label} kept a rejected timestamp`)
    assert.match(got, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    assert.ok(Math.abs(decodedTime(got) - timeFieldOf(Date.now())) < 5_000, `${label} was re-minted fresh`)
    assert.ok(got.endsWith('2U0aluUnb5nnpZ'), 'the tail (and its affinity) is kept')
  }
})

test('canonicalSessionID is stable per signal and distinct across signals', () => {
  resetSessionIDCache()
  // same conversation keeps one id for the life of the process (the prefix
  // must stay fresh, so this is a cache, not a pure function)
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
  // The request id must be a msg_* MESSAGE id and the project id must be the
  // client's prefix-less `ProjectID` — `req_*` and `prj_*` each answer 403
  // FreeTierError on their own against /inference/v1.
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
  // The 2.1.4 client sends ALL FOUR session spellings carrying the same id;
  // the affinity pair is a foreign-client signal only under the 1.x header set.
  assert.equal(headers['x-session-affinity'], ids.session)
  assert.equal(headers['x-session-id'], ids.session)
  // The 2.x wire carries no x-opencode-request.
  assert.equal(headers['x-opencode-request'], undefined)
  assert.equal(headers['x-opencode-project'], ids.project)
  assert.ok(headers['user-agent'].startsWith('opencode/'))
  // The built-in UA is the current client's shape, and its last segment is the
  // same flag the request carries in x-opencode-client (OpenCode Desktop
  // 2.1.4 builds `opencode/${channel}/${version}/${name}`).
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
