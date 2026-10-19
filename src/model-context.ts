/**
 * Per-model context-window overrides for the Zen lane (settings → 模型上下文).
 *
 * The Zen catalog and models.dev do not always agree with what the endpoint
 * actually serves: models.dev declares `limit.context: 200000` for ids whose
 * card (and live behaviour) is 1M — `mimo-v2.6-flash-free` is the original
 * case, covered by a built-in override in adapter/catalog.ts. This module is
 * the operator-facing knob for every other id: `model-id = <tokens>`.
 *
 * Like request-headers.ts this file is SHARED by the Host and the browser
 * halves, so it must stay dependency-free (no node imports). Validation lives
 * at both boundaries instead of the schema (AGENTS.md: a callback-bearing
 * `Config` node breaks the settings form round trip):
 *   - the editor calls {@link normalizeModelContextWindows} (strict: a bad
 *     draft is refused with a message);
 *   - every catalog read calls {@link sanitizeModelContextWindows} (lenient: a
 *     hand-edited profile patch cannot inject an invalid window, and a bad
 *     entry never breaks a request or a model lookup).
 */

/** Model id -> context window in tokens. */
export type ModelContextWindows = Record<string, number>

/** A window above 16,777,216 tokens is not a real model — reject typos. */
export const MAX_CONTEXT_WINDOW = 16_777_216
/**
 * Floor for an override. Smaller windows make the host's compaction budget
 * (`contextWindow - reservedCompletionTokens`) collapse, so they are refused
 * instead of producing a session that cannot compact.
 */
export const MIN_CONTEXT_WINDOW = 1024
/** A context override is a hand-written list; more than this is a mistake. */
export const MAX_MODEL_CONTEXT_WINDOWS = 128

/** Model ids are opaque; match everything a Zen id can contain except the
 *  separators and whitespace, so a stray space cannot create a phantom id. */
const MODEL_ID = /^[^\s=:]+$/
const MODEL_ID_MAX = 200

function validModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MODEL_ID_MAX && MODEL_ID.test(value)
}

function validWindow(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= MIN_CONTEXT_WINDOW
    && value <= MAX_CONTEXT_WINDOW
}

/**
 * Strict boundary: the settings editor and any explicit write path. Throws
 * with a user-facing message so the card can show why a draft was refused.
 */
export function normalizeModelContextWindows(input: unknown): ModelContextWindows {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Model context windows must be an object')
  }
  const entries = Object.entries(input)
  if (entries.length > MAX_MODEL_CONTEXT_WINDOWS) {
    throw new Error(`At most ${String(MAX_MODEL_CONTEXT_WINDOWS)} model context windows are allowed`)
  }
  const normalized = new Map<string, number>()
  for (const [rawId, rawWindow] of entries) {
    const id = rawId.trim()
    if (!validModelId(id)) throw new Error(`Invalid model id: ${rawId}`)
    if (!validWindow(rawWindow)) {
      throw new Error(`Context window for ${id} must be an integer between ${String(MIN_CONTEXT_WINDOW)} and ${String(MAX_CONTEXT_WINDOW)}`)
    }
    if (normalized.has(id)) throw new Error(`Duplicate model id: ${id}`)
    normalized.set(id, rawWindow)
  }
  return Object.fromEntries(normalized)
}

/**
 * Lenient boundary: the catalog and any config read where a bad entry must
 * never break a request. Invalid ids, non-integers, out-of-range windows,
 * duplicates after trimming and oversize dictionaries are dropped, so a
 * hand-edited profile patch cannot arm a broken window either.
 */
export function sanitizeModelContextWindows(input: unknown): ModelContextWindows {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  const sanitized = new Map<string, number>()
  for (const [rawId, rawWindow] of Object.entries(input)) {
    if (sanitized.size >= MAX_MODEL_CONTEXT_WINDOWS) break
    const id = rawId.trim()
    if (!validModelId(id) || !validWindow(rawWindow) || sanitized.has(id)) continue
    sanitized.set(id, rawWindow)
  }
  return Object.fromEntries(sanitized)
}

/**
 * Editor text -> dictionary. One `model-id = tokens` per line; `:` is accepted
 * as the separator too, matching the header editor's muscle memory. Blank
 * lines are ignored; a line without a separator, a duplicate id or an invalid
 * window throws. Values are plain decimal token counts on purpose: `1m` is
 * ambiguous (1,000,000 vs 1,048,576) and guessing here would be worse than a
 * refused draft.
 */
export function parseModelContextWindows(text: string): ModelContextWindows {
  const entries: Array<[string, number]> = []
  const ids = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const equals = line.indexOf('=')
    const colon = line.indexOf(':')
    const separator = equals < 0 ? colon : colon < 0 ? equals : Math.min(equals, colon)
    if (separator <= 0) throw new Error('Use one "model-id = tokens" per line')
    const id = line.slice(0, separator).trim()
    const rawValue = line.slice(separator + 1).trim()
    if (!/^\d+$/.test(rawValue)) throw new Error(`Context window for ${id} must be a whole number of tokens`)
    const window = Number(rawValue)
    if (!Number.isSafeInteger(window) || window < MIN_CONTEXT_WINDOW || window > MAX_CONTEXT_WINDOW) {
      throw new Error(`Context window for ${id} must be an integer between ${String(MIN_CONTEXT_WINDOW)} and ${String(MAX_CONTEXT_WINDOW)}`)
    }
    if (ids.has(id)) throw new Error(`Duplicate model id: ${id}`)
    ids.add(id)
    entries.push([id, window])
  }
  return normalizeModelContextWindows(Object.fromEntries(entries))
}

/** Dictionary -> editor text (`model-id = tokens`, one per line). */
export function formatModelContextWindows(overrides: ModelContextWindows): string {
  return Object.entries(overrides).map(([id, window]) => `${id} = ${String(window)}`).join('\n')
}
