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
 * bits — a digest-derived prefix reads as a non-OpenCode client and 403s, so
 * the timestamp half must be MINTED from the clock (upstream fix:
 * jasonxu114514/opencode2api PR #69; the same defect in decolua/9router is
 * issue #4780). Live-verified 2026-10-13 against /zen/v1/chat/completions
 * with the full gate body: digest prefix -> 403, minted prefix -> 200, the
 * same minted id again -> 200.
 */
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * Bounded signal→session cache (upstream PR #69). Entries are keyed by
 * digest, because conversation seeds can be large; the whole map drops when
 * full, which only costs affinity for the oldest conversations.
 */
const SESSION_CACHE_LIMIT = 8192
const sessionCache = new Map<string, string>()

/** Clock state for the descending time prefix (mirrors the OpenCode client). */
let sessionCounter = 0

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

/**
 * The 12 hex characters OpenCode derives from `~(unix_ms * 0x1000 +
 * counter)` truncated to its low 48 bits — a descending scheme, so newer ids
 * sort first. The counter keeps same-millisecond ids distinct; the inversion
 * is arithmetic on a BigInt (sign-extended), so taking the low 6 bytes
 * yields exactly the official client's prefix.
 */
function mintedTimePrefix(): string {
  sessionCounter = (sessionCounter + 1) & 0xfff
  const value = ~(BigInt(Date.now()) * 0x1000n + BigInt(sessionCounter))
  let hex = ''
  for (let bit = 40; bit >= 0; bit -= 8) {
    hex += Number((value >> BigInt(bit)) & 0xffn).toString(16).padStart(2, '0')
  }
  return hex
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
 * is that request's own user turn).
 */
export function mintedMessageID(): string {
  messageCounter = (messageCounter + 1) & 0xfff
  const value = BigInt(Date.now()) * 0x1000n + BigInt(messageCounter)
  let hex = ''
  for (let bit = 40; bit >= 0; bit -= 8) {
    hex += Number((value >> BigInt(bit)) & 0xffn).toString(16).padStart(2, '0')
  }
  return `msg_${hex}${base62Fixed(BigInt('0x' + randomBytes(10).toString('hex')), 14)}`
}

/**
 * The session id sent upstream. A signal that already carries an official
 * OpenCode session passes through unchanged (preserving upstream prompt-cache
 * affinity). Any other identity — the conversation seed in adapter mode,
 * foreign client sessions, admission probes — keeps its digest-derived
 * Base62 tail (stable per conversation, so affinity does not change) but the
 * time prefix is MINTED from the clock: the free tier decodes the prefix and
 * rejects digest-shaped ones (2026-10-13, upstream PR #69). One signal
 * therefore returns one id for the life of the process.
 */
export function canonicalSessionID(signal: string): string {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal
  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  const key = sum.toString('hex')
  const cached = sessionCache.get(key)
  if (cached !== undefined) return cached
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14)
  const id = `ses_${mintedTimePrefix()}${randomPart}`
  if (sessionCache.size >= SESSION_CACHE_LIMIT) sessionCache.clear()
  sessionCache.set(key, id)
  return id
}

/** CLI-identical user agent (ids.go opencodeUserAgent, node runtime values). */
export function opencodeUserAgent(): string {
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
