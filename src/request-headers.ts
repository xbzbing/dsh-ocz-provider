/** Shared validation for the settings editor and the Zen request path. */
export type RequestHeaders = Record<string, string>

const HEADER_NAME = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/
/** Headers the plugin owns: authentication, cookies, framing and body format. */
const MANAGED_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'host', 'connection', 'proxy-connection', 'content-length', 'transfer-encoding',
  'upgrade', 'trailer', 'te', 'expect', 'content-type', 'content-encoding', 'accept-encoding',
])
const MAX_HEADERS = 32
const MAX_BYTES = 8192

/** One accepted entry, or undefined when the pair must be dropped. */
function accept(rawName: unknown, rawValue: unknown): [string, string] | undefined {
  if (typeof rawName !== 'string') return undefined
  const name = rawName.toLowerCase()
  if (!HEADER_NAME.test(name) || MANAGED_HEADERS.has(name)) return undefined
  if (typeof rawValue !== 'string' || !HEADER_VALUE.test(rawValue)) return undefined
  const value = rawValue.trim()
  if (value === '') return undefined
  return [name, value]
}

/**
 * Strict boundary: the settings editor and any explicit write path. Throws with
 * a user-facing message so the card can show why a draft was refused.
 */
export function normalizeRequestHeaders(input: unknown): RequestHeaders {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Request headers must be an object')
  const entries = Object.entries(input)
  if (entries.length > MAX_HEADERS) throw new Error(`At most ${String(MAX_HEADERS)} request headers are allowed`)
  const normalized = new Map<string, string>()
  let size = 0
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase()
    if (!HEADER_NAME.test(name)) throw new Error('Invalid request header name')
    if (MANAGED_HEADERS.has(name)) throw new Error(`Header is managed by the plugin: ${name}`)
    if (normalized.has(name)) throw new Error(`Duplicate request header: ${name}`)
    const pair = accept(rawName, rawValue)
    if (pair === undefined) throw new Error(`Invalid request header value: ${name}`)
    const [, value] = pair
    size += name.length + value.length + 4
    if (size > MAX_BYTES) throw new Error(`Request headers must fit within ${String(MAX_BYTES)} bytes`)
    normalized.set(name, value)
  }
  return Object.fromEntries(normalized)
}

/**
 * Lenient boundary: every request, where a bad entry must never break the wire
 * call. Invalid names, managed headers, blanks and oversize dictionaries are
 * dropped instead of thrown, so a hand-edited profile patch cannot inject
 * `authorization`/`cookie`/framing headers, and cannot fail a request either.
 */
export function sanitizeRequestHeaders(input: unknown): RequestHeaders {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  const sanitized = new Map<string, string>()
  let size = 0
  for (const [rawName, rawValue] of Object.entries(input)) {
    if (sanitized.size >= MAX_HEADERS) break
    const pair = accept(rawName, rawValue)
    if (pair === undefined) continue
    const [name, value] = pair
    if (sanitized.has(name)) continue
    const next = size + name.length + value.length + 4
    if (next > MAX_BYTES) break
    size = next
    sanitized.set(name, value)
  }
  return Object.fromEntries(sanitized)
}

/** HTTP-style lines keep colon-containing values intact; blank restores defaults. */
export function parseRequestHeaders(text: string): RequestHeaders {
  const entries: Array<[string, string]> = []
  const names = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const colon = line.indexOf(':')
    if (colon <= 0) throw new Error('Use one Header-Name: value per line')
    const name = line.slice(0, colon).trim().toLowerCase()
    if (names.has(name)) throw new Error(`Duplicate request header: ${name}`)
    names.add(name)
    entries.push([name, line.slice(colon + 1)])
  }
  return normalizeRequestHeaders(Object.fromEntries(entries))
}

export function formatRequestHeaders(headers: RequestHeaders): string {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n')
}

// -- Desktop-mode toggle (client draft sugar over x-opencode-client) ----------

/**
 * The client-identity header the Desktop-mode checkbox manages. Deliberately
 * NOT in {@link MANAGED_HEADERS}: the wire already lets `requestHeaders`
 * override the built-in `cli` (ids.ts `zenRequestHeaders` spreads the
 * sanitized dict last), so the toggle is pure draft text sugar and needs no
 * schema or host change.
 */
const CLIENT_HEADER = 'x-opencode-client'

/** Lenient draft scan: the current `x-opencode-client` value, if any. */
export function effectiveClientHeader(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    if (line.slice(0, colon).trim().toLowerCase() === CLIENT_HEADER) return line.slice(colon + 1).trim()
  }
  return undefined
}

/** True when the draft sends the desktop client identity. */
export function isDesktopModeDraft(text: string): boolean {
  return effectiveClientHeader(text) === 'desktop'
}

/**
 * Return the draft with the Desktop-mode checkbox applied. ON upserts
 * `x-opencode-client: desktop` (replacing any existing value, so a stale
 * `cli` cannot survive the toggle); OFF removes that line only when it reads
 * `desktop`, leaving a hand-typed non-desktop value untouched. Pure text
 * manipulation on a possibly-mid-edit draft, hence the lenient line scan.
 */
export function desktopModeDraft(text: string, on: boolean): string {
  const lines = text.split(/\r?\n/)
  const index = lines.findIndex((line) => {
    const colon = line.indexOf(':')
    return colon > 0 && line.slice(0, colon).trim().toLowerCase() === CLIENT_HEADER
  })
  const entry = `${CLIENT_HEADER}: desktop`
  if (on) {
    if (index >= 0) lines[index] = entry
    else {
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
      if (lines.length > 0) lines.push('')
      lines.push(entry)
    }
    return lines.join('\n')
  }
  if (index >= 0 && lines[index]!.slice(lines[index]!.indexOf(':') + 1).trim() === 'desktop') {
    lines.splice(index, 1)
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  }
  return lines.join('\n')
}
