import { createHash, randomBytes } from 'node:crypto'
import { sanitizeRequestHeaders, type RequestHeaders } from '../request-headers.ts'

/**
 * Port of agent/internal/ids (opencode2api ids.go, verbatim semantics):
 * stable session/project ids derived from the conversation's first user turn,
 * and a per-request random id. The upstream sees CLI-identical correlation
 * headers built from these (zen-adapter.ts).
 */

export interface RequestIDs {
  session: string
  request: string
  project: string
  parentSession: string
}

export function randomID(prefix: string, size: number): string {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

export function firstString(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/**
 * The conversation signal: JSON of the first user message's content. Using the
 * first user turn keeps a multi-turn conversation stable as its history grows
 * while separating conversations with different beginnings (ids.go:59-76).
 */
export function conversationSeed(messages: Array<{ role: string; content: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

/**
 * A readable label for one conversation: its first user turn, flattened and
 * truncated. The usage ledger's top-session list is unusable without one —
 * `ses_9f2c…` says nothing about which conversation burned the tokens. Text
 * blocks are concatenated; images and tool results contribute nothing.
 */
export function conversationLabel(messages: Array<{ role: string; content: unknown }>, limit = 64): string {
  const seed = conversationSeed(messages)
  if (seed === '') return ''
  let text = ''
  try {
    const parsed = JSON.parse(seed) as unknown
    if (typeof parsed === 'string') text = parsed
    else if (Array.isArray(parsed)) {
      for (const block of parsed as Array<{ type?: string; text?: string }>) {
        if (block?.type === 'text' && typeof block.text === 'string') text += ` ${block.text}`
      }
    }
  } catch {
    text = seed
  }
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * The project id sent upstream. `ProjectID` in the client is a PLAIN string —
 * `"global"` for a directory that is not a git worktree, otherwise a 40-hex
 * sha1 (values seen on the wire: `global` and
 * `c956d9742c6f72c5f22ab1c75bd9b47ad294161c`). It has no prefix: the client's
 * id prefix table lists job/event/session/message/permission/question/part/
 * pty/tool/workspace and NOT project, and `prj_*` is a rejection signal
 * (`prj_*` -> 403 FreeTierError; `global`, a 40-hex id or the header omitted
 * -> 200). The adapter has no worktree, so it sends what the client sends for
 * a non-git directory.
 *
 * The 40-hex derivation (static extraction of the 2.1.3 `opencode-cli`): for a
 * git repo it prefers `sha1("git-remote:" + host + "/" + path)` of the
 * normalized `origin` URL (`git@github.com:xbzbing/dsh-git-panel.git` ->
 * `github.com/xbzbing/dsh-git-panel` -> `c956d974…`), falling back to the
 * repo's oldest root commit; a non-git directory hashes
 * `sha1("directory:" + absPath)`; `"global"` is only the no-VCS fallback. The
 * adapter keeps `global` — a legitimate client value in the gate's accepted
 * set — rather than fabricating a directory hash for a path the upstream has
 * never seen: the workspace dimension stays unsimulated (no login, no project
 * hash), and `global` passes alongside a 40-hex id and with the header
 * omitted entirely.
 */
export const DEFAULT_PROJECT_ID = 'global'

/**
 * Derive the correlation ids for one upstream request. There are no inbound
 * opencode headers, so the seed is the conversation itself.
 *
 * `request` (a `msg_*` id) is minted but NOT SENT: the 2.x client's wire
 * carries no `x-opencode-request` header (absent repo-wide in 2.1.3 and
 * 2.1.4). It stays in the record because the pool's admission probe reuses
 * the same shape-checked minter and because `req_*` remains a documented
 * rejection signal if the header ever has to come back.
 * `x-opencode-project` must be the prefix-less project id above.
 */
export function deriveRequestIDs(messages: Array<{ role: string; content: unknown }>): RequestIDs {
  let signal = conversationSeed(messages)
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: canonicalSessionID(signal),
    request: mintedMessageID(),
    project: DEFAULT_PROJECT_ID,
    parentSession: '',
  }
}

/**
 * OpenCode's canonical session shape: "ses_" + 12 lowercase hex timestamp
 * characters + 14 Base62 characters. Any other shape is refused with 403
 * FreeTierError ("free tier can only be used from within OpenCode"), and the
 * gate has a second, body-shape half (streaming + a non-empty `tools` array
 * carrying an entry named `read`, adapter/messages.ts); both must pass.
 *
 * The 12 hex characters are the client's DESCENDING word: the low 48 bits of
 * `~(unix_ms * 0x1000 + counter)`, so a digest-shaped or ascending prefix is
 * refused. The TIMESTAMP is the half the lane checks — it must decode to a
 * recent moment (see `SESSION_TS_MAX_AGE_MS`); the 12-bit counter is only a
 * sort tiebreak (0 refused, wide values pass), so a clock-derived counter
 * cannot exhaust any window.
 */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/**
 * How far the decoded timestamp of an inbound session id may sit from now and
 * still be treated as the client's own. The window is "recent past": prefixes
 * decoding to now / now-1h / now-1d / now-7d / now-30d pass; a FUTURE
 * timestamp and every effectively-random prefix (raw random bytes, or a
 * digest-derived prefix) are refused with 429. An all-zero prefix decodes to
 * the sentinel `2^36-1` and passes. The future side is the one that must stay
 * tight.
 */
const SESSION_TS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Allowed clock skew into the future (a client a few seconds ahead still passes). */
const SESSION_TS_MAX_SKEW_MS = 60 * 60 * 1000
/** The 36-bit timestamp field the inverted word carries (2^36 ms ≈ 2.2 years). */
const SESSION_TS_MASK = (1n << 36n) - 1n
/** The 12-bit counter the mint appends (1-based: counter 0 is refused). */
const SESSION_COUNTER_MAX = 0xfff

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62Fixed(value: bigint, width: number): string {
  const base = 62n
  let n = value
  const out = new Array<string>(width)
  for (let i = width - 1; i >= 0; i--) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base))
    n /= base
  }
  return out.join('')
}

/** The low 6 bytes of a 48-bit id word, lowercase hex (the client's carry width). */
function hex48(value: bigint): string {
  let hex = ''
  for (let bit = 40; bit >= 0; bit -= 8) {
    hex += Number((value >> BigInt(bit)) & 0xffn).toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * The 12 hex characters of a descending session id for one timestamp+counter:
 * `~(unix_ms * 0x1000 + counter)` in the low 48 bits, so newer ids sort first.
 *
 * The value is CLOCK-BASED on purpose (see {@link canonicalSessionID}): the
 * lane decodes this field and refuses a timestamp it cannot believe, so a
 * digest-derived "timestamp" — effectively a random moment — is a rejection
 * signal.
 */
function descendingTimePrefix(ms: number, counter: number): string {
  const word = (BigInt(ms) << 12n) | BigInt(counter & SESSION_COUNTER_MAX)
  return hex48(~word & ((1n << 48n) - 1n))
}

/** The 36-bit timestamp an inverted prefix decodes to, or null when it is not inverted. */
function decodedSessionTime(field: string): number | null {
  if (!/^[0-9a-f]{12}$/.test(field)) return null
  const word = ~BigInt('0x' + field) & ((1n << 48n) - 1n)
  return Number((word >> 12n) & SESSION_TS_MASK)
}

/**
 * Is this a session id the client itself could have minted just now — the right
 * shape, an inverted (descending) word, and a timestamp inside the window the
 * lane enforces? Such an id is passed through so its upstream affinity (and the
 * prompt cache keyed on it) survives; anything else is re-minted.
 */
function isFreshSessionID(id: string): boolean {
  if (!CANONICAL_SESSION_PATTERN.test(id)) return false
  const ms = decodedSessionTime(id.slice(4, 16))
  if (ms === null) return false
  // BOTH sides live in the 36-bit field the id carries (~2.2 years of ms), so
  // comparing against a raw Date.now() would call every id stale. The signed
  // delta is unwrapped to the shorter arc, which is what makes this correct
  // across the field's own wrap-around.
  const delta = signedDelta(Number(BigInt(Date.now()) & SESSION_TS_MASK), ms)
  return delta >= -SESSION_TS_MAX_AGE_MS && delta <= SESSION_TS_MAX_SKEW_MS
}

/** `to - from` on a 2^36 clock, normalized to the shorter arc. */
function signedDelta(from: number, to: number): number {
  // `2 ** 36`, NOT `1 << 36`: JavaScript's shift operators are 32-bit, so
  // `1 << 36` silently evaluates to 16 and every delta collapses to ~0 —
  // which makes every id look fresh.
  const span = 2 ** 36
  const half = span / 2
  let delta = (to - from) % span
  if (delta > half) delta -= span
  if (delta < -half) delta += span
  return delta
}

/** Clock state for the ascending message-id prefix (kept apart from sessions). */
let messageCounter = 0

/**
 * A `msg_*` request id, shaped exactly like the client's
 * `Session.Message.ID.create()`: `"msg_" + ascending()`, where the ascending
 * scheme is the same `unix_ms * 0x1000 + counter` low-48-bit encoding as the
 * session prefix WITHOUT the inversion, plus a random Base62 tail. It would
 * ride only as the `x-opencode-request` header, which the 2.x wire does not
 * carry, so the tail carries no affinity: one fresh id per request is what the
 * client does (`input.user.id` is that request's own user turn). Unlike the
 * session word, this one is not decoded by the gate at all — counters 64 and
 * 4095, ts36=1, an inverted word and a junk tail all pass — so the process
 * counter behind it can never walk out of a window.
 */
export function mintedMessageID(): string {
  messageCounter = (messageCounter + 1) & 0xfff
  const value = BigInt(Date.now()) * 0x1000n + BigInt(messageCounter)
  return `msg_${hex48(value)}${base62Fixed(BigInt('0x' + randomBytes(10).toString('hex')), 14)}`
}

/**
 * The session id sent upstream.
 *
 * The lane DECODES the 12-hex prefix as `~(unix_ms*0x1000+counter)` and
 * refuses a timestamp it cannot believe: a prefix decoding to now, an hour, a
 * day or 30 days back passes; a future timestamp and every effectively-random
 * prefix (raw random bytes, or a digest-derived one) answer 429
 * FreeUsageLimitError — indistinguishable from a spent quota. The counter
 * window older ports chased (0-63) is gone: 1/32/63/64/128/4095 all pass,
 * only 0 fails.
 *
 * The mint is therefore CLOCK-BASED: `~(unix_ms * 0x1000 + counter)`, counter
 * 1-based and per-process monotonic (a sort tiebreak only). The 14-char
 * Base62 tail stays DIGEST-DERIVED, so one conversation still keeps one id
 * and its prompt-cache affinity — the prefix carries freshness, the tail
 * identity.
 *
 * Stability: an id is cached per signal for the life of the process (the lane
 * only accepts a fresh timestamp, so a conversation restarted days later must
 * mint a new id — the same thing the official client does per session). An
 * inbound id that is already canonical AND fresh passes through untouched.
 */
const sessionCache = new Map<string, string>()
/** Cap on the per-process cache: conversation ids are small, but unbounded is unbounded. */
const SESSION_CACHE_LIMIT = 512
let sessionCounter = 0

export function canonicalSessionID(signal: string): string {
  const cached = sessionCache.get(signal)
  if (cached !== undefined) return cached
  const id = isFreshSessionID(signal) ? signal : mintSessionID(signal)
  if (sessionCache.size >= SESSION_CACHE_LIMIT) {
    const oldest = sessionCache.keys().next()
    if (oldest.done !== true) sessionCache.delete(oldest.value)
  }
  sessionCache.set(signal, id)
  return id
}

/** The digest tail plus a freshly minted prefix (never a random "timestamp"). */
function mintSessionID(signal: string): string {
  // A canonical id whose timestamp went stale keeps its own tail: only the
  // prefix carries freshness, so re-minting preserves every bit of upstream
  // affinity the id had. Anything else gets the digest tail of the signal.
  const randomPart = CANONICAL_SESSION_PATTERN.test(signal)
    ? signal.slice(16)
    : base62Fixed(BigInt('0x' + createHash('sha256').update('ses\x00' + signal).digest().subarray(6, 16).toString('hex')), 14)
  // 1..0xFFF, wrapping: 0 is the one counter value the lane refused.
  sessionCounter = (sessionCounter % SESSION_COUNTER_MAX) + 1
  return `ses_${descendingTimePrefix(Date.now(), sessionCounter)}${randomPart}`
}

/** Drop the process' cached session ids (tests only: the cache is a lifetime cache). */
export function resetSessionIDCache(): void {
  sessionCache.clear()
  sessionCounter = 0
}

/**
 * The User-Agent override from plugin config (`userAgent`). Empty = the
 * built-in value below. Module state on purpose: the three senders (the chat
 * adapter, the model catalog and the pool's admission probes) all call
 * {@link opencodeUserAgent} at request time, so one setting moves every wire
 * request without threading it through four signatures.
 */
let userAgentOverride = ''
let readRequestHeaders: (() => RequestHeaders | undefined) | undefined

/** Read the Loader's stable reference on each request, never cache a snapshot. */
export function setRequestHeadersReader(reader: () => RequestHeaders | undefined): () => void {
  readRequestHeaders = reader
  return () => { if (readRequestHeaders === reader) readRequestHeaders = undefined }
}

/**
 * The built-in Zen User-Agent: the shape the current (2.x) client sends,
 * `opencode/<channel>/<version>/<client>`.
 *
 * Static extraction of OpenCode Desktop 2.0.32 and of Desktop 2.1.3 with its
 * bundled `opencode-cli` (a Bun binary, JS in cleartext) put the builder at
 * `opencode/${channel}/${version}/${name}`, where `name` is the SAME value the
 * client puts in its `x-opencode-client` header: version, channel and default
 * name are plain strings ("2.1.3", "latest", "cli"), and the Electron shell
 * spawns the CLI with `OPENCODE_CLIENT=desktop`, so Desktop sends
 * `opencode/latest/<version>/desktop`. The gate does not pin the UA string,
 * but it does read fingerprint coherence, so the string is derived from the
 * effective client flag rather than frozen with one segment: the Desktop
 * toggle moves both spellings together. Moving this string alone is NOT a
 * generation mix; the 1.x shape was `opencode/1.18.31 (<platform> <arch>;
 * node<ver>)`.
 *
 * The value below tracks the installed client's version segment; the rest of
 * the fingerprint (header set, tool pair, `<env>` block) is the captured 2.x
 * recipe, which the gate reads as a whole — the probe record is AGENTS.md.
 */
export const ZEN_UA_CHANNEL = 'latest'
export const ZEN_UA_VERSION = '2.2.0'
/** `x-opencode-client` value the client uses when no mode toggle is set. */
export const DEFAULT_ZEN_CLIENT = 'cli'

/** The built-in User-Agent for one `x-opencode-client` value. */
export function zenUserAgent(client: string = DEFAULT_ZEN_CLIENT): string {
  return `opencode/${ZEN_UA_CHANNEL}/${ZEN_UA_VERSION}/${client}`
}

/**
 * Case-insensitive header merge: a later set wins, and a differently-cased
 * spelling of the same name collapses instead of riding out twice (HTTP names
 * are case-insensitive). Live overrides already arrive lowercased from
 * `sanitizeRequestHeaders`; this gives caller-supplied base sets the same
 * behaviour, which is what keeps the derived User-Agent coherent with the
 * `x-opencode-client` the request actually carries.
 */
function mergeHeaders(...sets: RequestHeaders[]): RequestHeaders {
  const merged: RequestHeaders = {}
  for (const set of sets) {
    for (const [name, value] of Object.entries(set)) {
      const key = name.toLowerCase()
      for (const existing of Object.keys(merged)) if (existing.toLowerCase() === key) delete merged[existing]
      merged[key] = value
    }
  }
  return merged
}

/** Common merge for chat, catalog and admission; caller-owned transport headers stay intact. */
export function zenRequestHeaders(base: RequestHeaders = {}): RequestHeaders {
  const merged = mergeHeaders(
    { 'x-opencode-client': DEFAULT_ZEN_CLIENT },
    base,
    // Lenient on purpose: the Config schema is a plain dict (a transform would
    // break the settings form — see config.ts), so this is where a hand-edited
    // profile patch is filtered down to safe, plugin-agnostic overrides.
    sanitizeRequestHeaders(readRequestHeaders?.() ?? {}),
  )
  return {
    // Built-in only: an explicit `user-agent` (the `userAgent` config field or a
    // live settings override) sits in `merged` below and wins over this one.
    'user-agent': userAgentOverride || zenUserAgent(merged['x-opencode-client'] ?? DEFAULT_ZEN_CLIENT),
    ...merged,
  }
}

/**
 * Set the configured User-Agent. Empty or whitespace restores the built-in
 * value, so a cleared field in a profile patch cannot put a blank header on
 * the wire.
 */
export function setUserAgentOverride(value: string | undefined): void {
  userAgentOverride = (value ?? '').trim()
}

/**
 * The User-Agent every Zen request carries: the built-in 2.x shape above
 * (`opencode/latest/<ZEN_UA_VERSION>/<client>`) unless the `userAgent` config
 * field or a live settings override names another string.
 *
 * The anonymous lane reads a whole FINGERPRINT — this header plus the
 * session/project/request id shapes and the tool definitions — so the two ways
 * to change it are: move THIS string alone, or move the recipe whole. The gate
 * does not pin the UA string: the built-in value, an installed app's branch
 * string (`opencode/1.19.0 (darwin 27.0.0; arm64)`) and upstream's 2.x shape
 * (`opencode/latest/2.0.29/cli`) all pass with this fingerprint held
 * constant. What is refused is mixing GENERATIONS inside one request — a 1.x
 * tool name (`bash`) beside 2.x ones, or the 1.x-only `x-opencode-request`
 * header inside this 2.x set ({@link disguiseHeaders}).
 */
export function opencodeUserAgent(): string {
  return zenRequestHeaders()['user-agent']!
}

/**
 * The full disguise header set sent with every upstream request
 * (design.md 2.4; gateway.go newUpstreamRequest) — the official 2.x
 * client's own set, captured by driving the installed `opencode-cli 2.1.4`
 * against a loopback server (16 headers logged, nothing left 127.0.0.1) and
 * byte-stable through the 2.2.0 CLI binary. The client sends exactly:
 *
 *   authorization: Bearer public      content-type: application/json
 *   user-agent: opencode/latest/<version>/cli      accept: `*` + `/` star
 *   b3: <trace>-<span>-1-<parent>     traceparent: 00-<trace>-<span>-01
 *   x-opencode-client: cli
 *   x-opencode-project: <40-hex | global>
 *   x-opencode-session / x-opencode-session-id /
 *   x-session-affinity / x-session-id   (all four = the same ses_* id)
 *
 * and NO `x-opencode-request` — the header is absent from every 2.x
 * extraction (static, through 2.2.0) and absent from this capture. This set
 * therefore carries the four session spellings and drops
 * `x-opencode-request`, the
 * reverse of the 1.x generation's rule: under a 1.x header set the affinity
 * pair marked a FOREIGN client, while this 2.x set rides it for the client's
 * own provider. The gate reads the fingerprint as a WHOLE, never one header in
 * isolation — the whole 2.x recipe passes and mixed generations are refused —
 * so the recipe ships whole.
 *
 * Reading the answers with this set: 403 FreeTierError = SHAPE REJECTED (a
 * malformed session id, or a `tools` array without a `read` entry —
 * adapter/gate-tools.ts); 429 FreeUsageLimitError = one of the gate's three
 * halves is missing (the `<env>` payload block, the Bun connection stack, the
 * session-id freshness — adapter/env-block.ts, src/relay/, adapter/ids.ts),
 * not a spent quota. These headers are unchanged by that gate: the relay
 * re-originates the CONNECTION, not the request.
 *
 * The OTel pair (`b3`/`traceparent`) is deliberately NOT fabricated: the
 * client mints it per request from its tracer, the gate ignores it (a set
 * without it passes), and a hand-rolled trace id would be one more shape to
 * keep coherent for no measured benefit.
 */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return zenRequestHeaders({
    'x-opencode-session': ids.session,
    'x-opencode-session-id': ids.session,
    'x-session-affinity': ids.session,
    'x-session-id': ids.session,
    'x-opencode-project': ids.project,
  })
}
