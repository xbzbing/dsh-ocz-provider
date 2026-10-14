import { createHash, randomBytes } from 'node:crypto'

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
 * `"global"` for a directory that is not a git worktree, otherwise the 40-hex
 * worktree hash (`ids.ts` `init_project_id`; live-observed `global` and
 * `c956d9742c6f72c5f22ab1c75bd9b47ad294161c`). It has no prefix: the client's
 * id prefix table lists job/event/session/message/permission/question/part/
 * pty/tool/workspace and NOT project. The `prj_<24hex>` this adapter used to
 * mint is now a rejection signal — live-probed 2026-10-14 against
 * `/inference/v1` with an otherwise-passing request: `prj_*` -> 403
 * FreeTierError, `global` / a 40-hex id / the header omitted -> 200. The
 * adapter has no worktree, so it sends what the client sends for a non-git
 * directory.
 */
export const DEFAULT_PROJECT_ID = 'global'

/**
 * Derive the correlation ids for one upstream request. In adapter mode there
 * are no inbound opencode headers, so the seed is the conversation itself.
 *
 * Both non-session ids are now shape-checked by the gate (live-probed
 * 2026-10-14): `x-opencode-request` must be a `msg_*` MESSAGE id — the client
 * sends `input.user.id`, i.e. the user turn's id — and a `req_<hex>` there
 * answers 403; `x-opencode-project` must be the prefix-less project id above.
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

/**
 * Set the configured User-Agent. Empty or whitespace restores the built-in
 * value, so a cleared field in a profile patch cannot put a blank header on
 * the wire.
 */
export function setUserAgentOverride(value: string | undefined): void {
  userAgentOverride = (value ?? '').trim()
}

/**
 * The User-Agent every Zen request carries: CLI-identical by default (ids.go
 * opencodeUserAgent, node runtime values), the configured `userAgent` when one
 * is set.
 *
 * The anonymous lane reads a whole FINGERPRINT — this header plus the
 * session/project/request id shapes and the tool definitions — so the two ways
 * to change it are: move THIS string alone, or move the recipe whole. Live
 * 2026-10-15 against /inference/v1 with this adapter's fingerprint held
 * constant and one variable at a time, each of these answered 200: the
 * built-in value, this machine's real desktop shape
 * (`opencode/1.19.0 (darwin 27.0.0; arm64)`, extracted from the app's
 * `app.asar`) and upstream's 2.x shape (`opencode/latest/2.0.29/cli`). The
 * gate does not pin the UA string. What still 403s is mixing GENERATIONS
 * inside one request — 2.x tool names under this header set, or upstream's
 * header set carrying our `x-opencode-request` ({@link disguiseHeaders}).
 */
export function opencodeUserAgent(): string {
  if (userAgentOverride !== '') return userAgentOverride
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

/**
 * The full disguise header set sent with every upstream request
 * (design.md 2.4; gateway.go newUpstreamRequest:640-669), as re-derived from
 * the real client on 2026-10-14.
 *
 * For a provider whose id starts with `opencode` the client sends exactly
 * `x-opencode-session-id`, `x-opencode-session`, `x-opencode-request`,
 * `x-opencode-client` and `User-Agent`; `x-session-affinity` and `X-Session-Id`
 * belong to its OTHER providers' branch. The 2026-10-09 gate accepted any one
 * of the three session spellings, so this adapter sent all three — but the
 * 2026-10-14 gate treats them as a foreign-client signal: live-probed against
 * `/inference/v1` with an otherwise-passing request, adding
 * `x-session-affinity` and/or `X-Session-Id` -> 403 FreeTierError, while
 * `x-opencode-session` alone (or with `x-opencode-session-id`) -> 200.
 *
 * 2026-10-15: that check is FINGERPRINT COHERENCE, not a fixed allow-list.
 * Replaying upstream's own 2.x recipe (jasonxu114514/opencode2api PR #83: UA
 * `opencode/latest/<ver>/cli`, all four session spellings, a 40-hex project
 * and the 2.x `shell/edit/glob/grep/read` definitions) also answers 200 —
 * while mixing the two fingerprints 403s every time (this UA with 2.x tool
 * names, their UA with our `x-opencode-request: msg_*`). Dropping
 * `x-opencode-request` from THIS set stays 200 as well, so the header is
 * optional here; it is kept because the 1.18.31 client sends it and `req_*`
 * is a rejection signal. Adopting any part of another generation's recipe
 * without the rest is what fails, not this set.
 */
export function disguiseHeaders(ids: RequestIDs): Record<string, string> {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-opencode-session-id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}
