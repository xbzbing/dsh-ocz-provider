import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalSessionID, conversationSeed, deriveRequestIDs, disguiseHeaders, opencodeUserAgent, randomID, stableID } from '../src/adapter/ids.ts'

test('stableID is deterministic and sha256-truncated', () => {
  const first = stableID('ses', 'hello')
  const second = stableID('ses', 'hello')
  assert.equal(first, second)
  assert.ok(first.startsWith('ses_'))
  const hex = first.slice('ses_'.length)
  assert.equal(hex.length, 24, '12 bytes hex')
  const expected = createHash('sha256').update('ses\x00hello').digest().subarray(0, 12).toString('hex')
  assert.equal(hex, expected)
  assert.notEqual(stableID('ses', 'world'), first)
  assert.notEqual(stableID('prj', 'hello'), first, 'prefix is part of the hash input')
})

test('randomID differs per call with the requested size', () => {
  const a = randomID('req', 16)
  const b = randomID('req', 16)
  assert.notEqual(a, b)
  assert.ok(a.startsWith('req_'))
  assert.equal(a.slice('req_'.length).length, 32, '16 bytes hex')
})

test('canonicalSessionID passes official sessions through unchanged', () => {
  const official = 'ses_00000000abc0ABCdefGHIjklMN'
  assert.match(official, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(canonicalSessionID(official), official)
  // foreign shapes do NOT match the canonical gate: 24-hex is the wrong length
  assert.doesNotMatch('ses_0123456789abcdef01234567', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

/**
 * The free tier decodes the 12-hex prefix as ~(unix_ms*0x1000+counter) in
 * its low 48 bits and 403s digest-shaped prefixes (2026-10-13; upstream
 * jasonxu114514/opencode2api PR #69, decolua/9router#4780). Live-verified
 * that day: digest prefix + gate body -> 403, minted prefix + gate body ->
 * 200, the same minted id again -> 200.
 */
function decodedTimePrefixMs(id: string): number {
  const field = BigInt('0x' + id.slice(4, 16))
  const current = ((1n << 48n) - 1n - field) & ((1n << 48n) - 1n)
  return Number(current >> 12n)
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

test('canonicalSessionID mints the time prefix from the clock (free-tier regression)', () => {
  const id = canonicalSessionID('regression-probe')
  assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)

  // The prefix must decode back to (now mod 2^36): the official scheme only
  // carries the low 36 bits of the millisecond timestamp, so compare modulo.
  const decoded = decodedTimePrefixMs(id)
  const now = Date.now() % 2 ** 36
  let delta = now - decoded
  if (delta > 2 ** 35) delta -= 2 ** 36
  if (delta < -(2 ** 35)) delta += 2 ** 36
  assert.ok(Math.abs(delta) < 60_000, `prefix decodes to ${decoded}ms, now is ${now}ms (delta ${delta}ms)`)

  // A digest-shaped prefix would NOT decode to now — the exact id shape the
  // gate rejects, pinned here so this fix cannot silently regress.
  const digestPrefix = createHash('sha256').update('ses\x00regression-probe').digest().subarray(0, 6).toString('hex')
  const digestDecoded = decodedTimePrefixMs(`ses_${digestPrefix}${digestTailOf('regression-probe')}`)
  const mintedDecoded = decodedTimePrefixMs(id)
  assert.notEqual(digestDecoded, mintedDecoded, 'a digest prefix must decode differently from a minted one')

  // The digest tail is what keeps affinity: still sha256-derived, not random.
  assert.ok(id.endsWith(digestTailOf('regression-probe')), 'tail stays digest-derived (affinity unchanged)')
})

test('canonicalSessionID is stable per signal and distinct across signals', () => {
  // same conversation keeps a stable session (upstream PR #69 cache)
  assert.equal(canonicalSessionID('anything'), canonicalSessionID('anything'))
  // distinct identities stay distinct — different tails at minimum
  assert.notEqual(canonicalSessionID('a'), canonicalSessionID('b'))
  // two signals minted in the same millisecond still differ (counter + tail)
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
  assert.ok(first.project.startsWith('prj_'))
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
  assert.equal(headers['x-session-affinity'], ids.session)
  assert.equal(headers['X-Session-Id'], ids.session)
  assert.equal(headers['x-opencode-request'], ids.request)
  assert.equal(headers['x-opencode-project'], ids.project)
  assert.ok(headers['user-agent'].startsWith('opencode/'))
  assert.ok(headers['user-agent'].includes(process.platform))
})
