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
 * `ses_9f2c…` says nothing about which conversation burned the tokens (live
 * request 2026-10-14). Text blocks are concatenated; images and tool results
 * contribute nothing.
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
 * sha1 (live-observed `global` and `c956d9742c6f72c5f22ab1c75bd9b47ad294161c`).
 * It has no prefix: the client's id prefix table lists job/event/session/
 * message/permission/question/part/pty/tool/workspace and NOT project. The
 * `prj_<24hex>` this adapter used to mint is now a rejection signal —
 * live-probed 2026-10-14 against `/inference/v1` with an otherwise-passing
 * request: `prj_*` -> 403 FreeTierError, `global` / a 40-hex id / the header
 * omitted -> 200. The adapter has no worktree, so it sends what the client
 * sends for a non-git directory.
 *
 * The 40-hex derivation, pinned 2026-10-22 by static extraction of the 2.1.3
 * `opencode-cli` and confirmed by recomputing the observed value: for a git
 * repo it prefers `sha1("git-remote:" + host + "/" + path)` of the normalized
 * `origin` URL (`git@github.com:xbzbing/dsh-git-panel.git` ->
 * `github.com/xbzbing/dsh-git-panel` -> `c956d974…`), falling back to the
 * repo's oldest root commit; a non-git directory hashes
 * `sha1("directory:" + absPath)`; `"global"` is now only the no-VCS fallback.
 * The adapter keeps `global` — a legitimate client value in the gate's
 * accepted set — rather than fabricating a directory hash for a path the
 * upstream has never seen. Decision re-affirmed 2026-10-24: the workspace
 * dimension stays as-is (no login, no project hash), and the 2.1.4 probe
 * confirmed `global` still passes the gate alongside a 40-hex id and even
 * with the project header omitted entirely.
 */
export const DEFAULT_PROJECT_ID = 'global'

/**
 * Derive the correlation ids for one upstream request. In adapter mode there
 * are no inbound opencode headers, so the seed is the conversation itself.
 *
 * `request` (a `msg_*` id) is still minted but NO LONGER SENT: the 2.x
 * client's wire carries no `x-opencode-request` header (byte-capture
 * 2026-10-24). It stays in the record because the pool's admission probe
 * reuses the same shape-checked minter and because `req_*` remains a
 * documented rejection signal if the header ever has to come back.
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
 * characters + 14 Base62 characters. Since 2026-09-16 the Zen free tier
 * rejects any other session shape with 403 FreeTierError ("free tier can
 * only be used from within OpenCode") — the plain User-Agent gate stopped
 * being sufficient (upstream fix: jasonxu114514/opencode2api 8185202).
 * Live-probed 2026-09-18: the gate has a second, body-shape half (streaming
 * + bash/read tools, adapter/messages.ts); both must pass.
 *
 * Since 2026-10-13 the tier additionally DECODES the 12 hex characters as an
 * inverted millisecond timestamp, ~(unix_ms*0x1000+counter) in its low 48
 * bits (upstream fixes: jasonxu114514/opencode2api PR #69, then PR #70; the
 * same defect in decolua/9router is issue #4780). Two rules, both re-probed
 * live 2026-10-15 against /inference/v1 with the full gate body and this
 * adapter's header set, one variable at a time:
 *
 *   1. the word must be INVERTED — a digest-shaped or ascending prefix 403s;
 *   2. the 12-bit counter must land in 0-63. After the inversion the low 12
 *      bits read 0xFFF-counter, so anything below 0xFC0 403s: counters 0, 1,
 *      32 and 63 -> 200, counters 64 and 128 -> 403. The timestamp half is
 *      not checked at all — a prefix decoding to ts36=1 (epoch+1ms) -> 200.
 *
 * So a clock-derived counter dies after 64 mints in a long-lived process
 * (exactly what PR #70 replaced), and this adapter mints often: one session
 * per new conversation AND one per pool exit address (pool/admission.ts), so
 * a single refill round could burn the window and 403 every session minted
 * afterwards. The prefix is therefore DERIVED FROM THE DIGEST with counter 1
 * — always inside the window, stateless, and one conversation keeps one id
 * even across restarts (PR #70's encoding; the in-memory cache it replaces
 * could not do that).
 */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/**
 * The acceptance window for the inverted counter: after the bitwise NOT the
 * low 12 bits read 0xFFF-counter, so a genuine descending id always has `f`
 * followed by `[c-f]` in the 10th/11th hex character (counter 0-63). A
 * canonical-shaped id outside it is re-encoded rather than passed through.
 */
const DESCENDING_TIME_PART_PATTERN = /^[0-9a-f]{9}f[c-f][0-9a-f]$/

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
 * The 12 hex characters of a descending session id: the digest's leading 36
 * bits as the "timestamp", counter 1 in the low 12 bits, then the client's
 * bitwise NOT, so newer ids sort first. The inversion is arithmetic on a
 * BigInt (sign-extended), and taking the low 6 bytes yields exactly the
 * official client's prefix — with the counter inside the 0-63 window the
 * gate accepts, whatever the digest says.
 */
function descendingTimePrefix(sum: Buffer): string {
  // the digest's leading 36 bits = first 32 bits + the top nibble of byte 4
  const timestamp = (BigInt(sum.readUInt32BE(0)) << 4n) | BigInt((sum[4] ?? 0) >> 4)
  return hex48(~((timestamp << 12n) | 1n) & ((1n << 48n) - 1n))
}

/** Clock state for the ascending message-id prefix (kept apart from sessions). */
let messageCounter = 0

/**
 * A `msg_*` request id, shaped exactly like the client's
 * `Session.Message.ID.create()`: `"msg_" + ascending()`, where the ascending
 * scheme is the same `unix_ms * 0x1000 + counter` low-48-bit encoding as the
 * session prefix WITHOUT the inversion, plus a random Base62 tail. The gate
 * only ever sees it as the `x-opencode-request` header, so the tail carries no
 * affinity: one fresh id per request is what the client does (`input.user.id`
 * is that request's own user turn). Unlike the session word, this one is not
 * decoded by the gate at all — live-probed 2026-10-15: counters 64 and 4095,
 * ts36=1, an inverted word and a junk tail all return 200 — so the process
 * counter behind it can never walk out of a window.
 */
export function mintedMessageID(): string {
  messageCounter = (messageCounter + 1) & 0xfff
  const value = BigInt(Date.now()) * 0x1000n + BigInt(messageCounter)
  return `msg_${hex48(value)}${base62Fixed(BigInt('0x' + randomBytes(10).toString('hex')), 14)}`
}

/**
 * The session id sent upstream. A signal that already carries an official
 * OpenCode session whose counter is inside the acceptance window passes
 * through unchanged (preserving upstream prompt-cache affinity); a canonical
 * but out-of-window id — or any foreign identity (the conversation seed in
 * adapter mode, admission probes) — is re-encoded from its digest: the
 * 14-char Base62 tail stays digest-derived so per-conversation affinity does
 * not change, and the prefix is the digest's own descending timestamp with
 * counter 1. Pure function of the signal: one signal always returns one id,
 * in this process and the next one (2026-10-15, upstream PR #70).
 */
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal) && DESCENDING_TIME_PART_PATTERN.test(signal.slice(4, 16))) return signal
  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14)
  return `ses_${descendingTimePrefix(sum)}${randomPart}`
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
 * Static extraction of OpenCode Desktop 2.0.32 put the builder at
 * `opencode/${channel}/${version}/${name}`, where `name` is the SAME value the
 * client puts in its `x-opencode-client` header (`opencode/latest/2.0.32/desktop`
 * was captured live on its wire the same night). Re-extracted 2026-10-22 from
 * Desktop 2.1.3 and its bundled `opencode-cli` (Bun binary, JS in cleartext):
 * the builder and its wiring are unchanged — version const "2.1.3", channel
 * "latest", default name "cli", and the Electron shell still spawns the CLI
 * with `OPENCODE_CLIENT=desktop`, so a real Desktop now sends
 * `opencode/latest/2.1.3/desktop` (its local server log confirms
 * `cli starting version=2.1.3 channel=latest`). The gate does not pin the UA
 * string, but it does read fingerprint coherence, so the string is derived from
 * the effective client flag rather than frozen with one segment: the Desktop
 * toggle moves both spellings together.
 *
 * Live-probed 2026-10-17 against /inference/v1 through a non-CN egress, the v1
 * recipe held constant (bash+read gate tools, `x-opencode-request: msg_*`,
 * project `global`, no `x-session-affinity`): `opencode/latest/2.0.32/desktop`
 * with client `desktop` -> 200 and `opencode/latest/2.0.32/cli` with client
 * `cli` -> 200, both live SSE streams. Moving this string alone is therefore
 * NOT a generation mix; the previous built-in was the 1.18.x CLI string
 * `opencode/1.18.31 (<platform> <arch>; node<ver>)`.
 *
 * Re-probed 2026-10-23 against /inference/v1 through a Tokyo egress (local
 * HTTP proxy), one variable at a time — same session id (digest-stable), same
 * body, same bash+read tools: `opencode/latest/2.0.32/cli` -> 200,
 * `opencode/latest/2.1.3/cli` -> 200 and `opencode/latest/2.1.3/desktop` ->
 * 200, all live SSE on mimo-v2.6-flash-free. The version bump therefore rides
 * the same proven-safe UA-only dimension.
 *
 * The CURRENT value tracks the installed client byte-for-byte: the 2.1.4
 * CLI's own loopback capture (2026-10-24, `docs/local/capture-214/`) sent
 * `user-agent: opencode/latest/2.1.4/cli` with `x-opencode-client: cli`.
 */
export const ZEN_UA_CHANNEL = 'latest'
export const ZEN_UA_VERSION = '2.1.4'
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
 * (`opencode/latest/2.1.4/<client>`) unless the `userAgent` config field or a
 * live settings override names another string.
 *
 * The anonymous lane reads a whole FINGERPRINT — this header plus the
 * session/project/request id shapes and the tool definitions — so the two ways
 * to change it are: move THIS string alone, or move the recipe whole. Live
 * 2026-10-15 against /inference/v1 with this adapter's fingerprint held
 * constant and one variable at a time, each of these answered 200: the
 * built-in value, the installed app's OpenAI/Codex branch string
 * (`opencode/1.19.0 (darwin 27.0.0; arm64)`, extracted from `app.asar`)
 * and upstream's 2.x shape (`opencode/latest/2.0.29/cli`). The
 * gate does not pin the UA string. What still 403s is mixing GENERATIONS
 * inside one request — 2.x tool names under this header set, or upstream's
 * header set carrying our `x-opencode-request` ({@link disguiseHeaders}).
 */
export function opencodeUserAgent(): string {
  return zenRequestHeaders()['user-agent']!
}

/**
 * The full disguise header set sent with every upstream request
 * (design.md 2.4; gateway.go newUpstreamRequest), now the official 2.1.4
 * client's own set — byte-captured 2026-10-24 by driving the installed
 * `opencode-cli 2.1.4` against a loopback server (16 headers logged, nothing
 * left 127.0.0.1). The client sends exactly:
 *
 *   authorization: Bearer public      content-type: application/json
 *   user-agent: opencode/latest/2.1.4/cli      accept: `*` + `/` star
 *   b3: <trace>-<span>-1-<parent>     traceparent: 00-<trace>-<span>-01
 *   x-opencode-client: cli
 *   x-opencode-project: <40-hex | global>
 *   x-opencode-session / x-opencode-session-id /
 *   x-session-affinity / x-session-id   (all four = the same ses_* id)
 *
 * and NO `x-opencode-request` — the header is absent repo-wide in 2.1.3 and
 * 2.1.4 (static extraction) and absent from this capture. This set therefore
 * carries the four session spellings and drops `x-opencode-request`, which is
 * the reverse of the 1.x generation's rule below.
 *
 * HISTORY (each point live-probed against `/inference/v1`):
 *   - 2026-10-14, 1.x generation: the client sent only `x-opencode-session` +
 *     `x-opencode-session-id` + `x-opencode-request` for its `opencode`
 *     provider, and adding `x-session-affinity`/`X-Session-Id` -> 403: the
 *     affinity pair marked a FOREIGN client under that fingerprint;
 *   - 2026-10-15: that was fingerprint COHERENCE, not an allow-list —
 *     replaying upstream's 2.x recipe (all four spellings, 40-hex project,
 *     2.x tool names) also answered 200, while mixing the generations 403'd
 *     every time;
 *   - 2026-10-24, 2.x generation (this set, one variable per request through
 *     a pool exit where the gate answers before the quota layer: 429 =
 *     gate PASSED, 403 = gate REJECTED): the whole 2.1.4 recipe -> 429;
 *     minus the affinity pair -> 429; plus `x-opencode-request` -> 429;
 *     UA `2.1.3` -> 429; project 40-hex -> 429; project header omitted ->
 *     429; `ses_short` session id -> 403 (calibration). On that day the only
 *     live rejection signals were a malformed session id and a `tools` array
 *     without a `read` entry (adapter/gate-tools.ts) — but the RECIPE is
 *     still shipped whole, because that is what has stayed green while the
 *     gate flipped five times.
 *
 * The OTel pair (`b3`/`traceparent`) is deliberately NOT fabricated: the
 * client mints it per request from its tracer, the gate ignores it (this set
 * passed without it on 2026-10-24), and a hand-rolled trace id would be one
 * more shape to keep coherent for no measured benefit.
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
