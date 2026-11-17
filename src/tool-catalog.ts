/**
 * The known-tools catalogue behind the wire's tool shaping: what dsh shipped,
 * what the host carries today, and the operator's per-tool overrides.
 *
 * A lane refuses on tool NAME, PARAMETER SHAPE and DESCRIPTION
 * (docs/wire-fingerprint.md), so a dsh upgrade that adds or renames a tool is a
 * wire change nobody can see from the settings card. This module keeps a
 * BASELINE — the tool set recorded while the lane was answering — beside what
 * the plugin sees NOW, and turns the difference into rows the modal can show.
 *
 * State lives in `<stateDir>/tool-catalog.json`, not in the settings schema:
 * one description runs to ~1 KB and the settings form re-serializes its whole
 * document twice per read.
 *
 * Two views feed the comparison and they are NOT equivalent: `observed` is the
 * `tools` array a real request carried, i.e. the truth for this preset;
 * `registered` is `ctx.tools.schemas()`, the host's registry before the preset
 * narrows it (`apply_patch` off, `office_*` only after its skill loads). The
 * baseline may only be recorded from an observation.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CLIENT_TOOL_DESCRIPTIONS, TOOL_NAME_ALIASES, WIRE_TOOL_RENAMES } from './adapter/messages.ts'
import { stateDir } from './paths.ts'

/** One tool entry as a request or the host registry spells it. */
export interface ObservedTool {
  name: string
  description: string
}

/** Where a tool was last seen. `observed` outranks `registered` (see module note). */
export type ToolSource = 'observed' | 'registered'

/** One baseline entry: enough to notice a rewrite without storing the text. */
interface BaselineEntry {
  chars: number
  descHash: string
}

/** What the operator changed for one tool; an empty field means "built-in". */
export interface ToolOverride {
  wire?: string
  description?: string
}

/** The on-disk document. Every field is plain JSON; no schema lives here. */
export interface ToolCatalogDocument {
  version: 1
  /** Host version the baseline was recorded under ('' when unreadable). */
  dshVersion: string
  /** Epoch ms of 录入基线. */
  recordedAt: number
  /** sha256 over the baseline's sorted names — cheap "did the set move". */
  fingerprint: string
  baseline: Record<string, BaselineEntry>
  seen: Record<string, { chars: number; descHash: string; seenAt: number; source: ToolSource }>
  overrides: Record<string, ToolOverride>
  /** Wire spellings that no longer apply but must still resolve in a reply —
   *  an alias change mid-session would otherwise break the tool call already
   *  in flight (`TOOL_NAME_ALIASES` extension). */
  retired: Record<string, string>
}

/** The state a row's tool is in, relative to the baseline. */
export type ToolRowState = 'ok' | 'added' | 'drifted' | 'renamed' | 'gone'

/** One row of the modal's 工具名录 table. */
export interface ToolCatalogRow {
  name: string
  /** The name that rides the wire. */
  wire: string
  /** `custom` = the operator set it; `identity` = unchanged; `builtin` = our table. */
  wireSource: 'custom' | 'builtin' | 'identity'
  /** The description text that would ride the wire. */
  description: string
  /** `client` = the official client's own wording, `custom` = operator, `host` = dsh's. */
  descriptionSource: 'client' | 'custom' | 'host'
  chars: number
  state: ToolRowState
  /** What the built-in tables alone would send: the editor's prefill fallback
   *  and the value that means "no override". */
  builtinWire: string
  /** Undefined = the host's own text (nothing built in to restore). */
  builtinDescription?: string
  /** For `renamed`: the baseline name this one took over. */
  renamedFrom?: string
  seenAt: number
  source: ToolSource
}

/** The /tools view. */
export interface ToolCatalogView {
  /** Host version the baseline was recorded under; '' when it could not be read. */
  dshVersion: string
  recordedAt: number
  /** Host version readable right now ('' when unavailable). */
  currentDshVersion: string
  /** Rows that differ from the baseline, in the order the table shows them. */
  pending: number
  /** The baseline exists; false means the table only shows today's set. */
  recorded: boolean
  rows: ToolCatalogRow[]
}

/** How a name would ride the wire, merge order: operator > our table > as-is. */
export interface ResolvedToolShape {
  wire: string
  wireSource: 'custom' | 'builtin' | 'identity'
  /** Undefined means "keep the host text" (still runs rewriteToolText). */
  description?: string
  descriptionSource: 'client' | 'custom' | 'host'
}

/** sha256 of the client name's description, truncated — a rewrite detector. */
export function descriptionHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** sha256 over the sorted name list; the set-level "did it move" answer. */
export function toolFingerprint(names: readonly string[]): string {
  return createHash('sha256').update([...names].sort().join('\n'), 'utf8').digest('hex').slice(0, 16)
}

/** A tool wire name the lane and the client both accept. */
const WIRE_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** Why a proposed override was refused, or undefined when it is usable. */
export type OverrideRejection = 'tool-unknown' | 'wire-invalid' | 'wire-taken'

const EMPTY: ToolCatalogDocument = {
  version: 1,
  dshVersion: '',
  recordedAt: 0,
  fingerprint: '',
  baseline: {},
  seen: {},
  overrides: {},
  retired: {},
}

/**
 * Resolve one tool's wire shape from a document.
 * @param name - the host's tool name.
 * @param overrides - the operator's table.
 * @returns the wire name, where it came from, and the description to send.
 */
export function resolveToolShape(
  name: string,
  overrides: Readonly<Record<string, ToolOverride>> = {},
): ResolvedToolShape {
  const custom = overrides[name]
  const builtinWire = WIRE_TOOL_RENAMES[name]
  const customWire = custom?.wire !== undefined && custom.wire !== '' ? custom.wire : undefined
  const wire = customWire ?? builtinWire ?? name
  const wireSource = customWire !== undefined ? 'custom' : builtinWire !== undefined ? 'builtin' : 'identity'
  const customText = custom?.description !== undefined && custom.description !== '' ? custom.description : undefined
  if (customText !== undefined) {
    return { wire, wireSource, description: customText, descriptionSource: 'custom' }
  }
  // Keyed by the HOST name: the client's wording travels with the capability,
  // not with the wire spelling we happen to give it (`edit` ships as
  // `file_edit`, and the lane refused the host text under that name).
  const clientText = CLIENT_TOOL_DESCRIPTIONS[name]
  if (clientText !== undefined) {
    return { wire, wireSource, description: clientText, descriptionSource: 'client' }
  }
  return { wire, wireSource, descriptionSource: 'host' }
}

/**
 * The reply-side alias table: built-in wire names first, then every live
 * override, then every retired spelling. Later entries win, so an override
 * applied mid-session still resolves the name already on the wire.
 * @param overrides - the operator's table.
 * @param retired - wire spellings that stopped applying.
 */
export function toolAliases(
  overrides: Readonly<Record<string, ToolOverride>> = {},
  retired: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const table: Record<string, string> = { ...TOOL_NAME_ALIASES }
  for (const [host, override] of Object.entries(overrides)) {
    if (override.wire !== undefined && override.wire !== '') table[override.wire] = host
  }
  for (const [wire, host] of Object.entries(retired)) table[wire] = host
  return table
}

/**
 * Compare the current set against the baseline.
 * @param baseline - the recorded names with their description digests.
 * @param current - what is seen now (observed outranks registered).
 * @returns added / removed / renamed / drifted buckets, all name-keyed.
 */
export function diffToolSets(
  baseline: Readonly<Record<string, BaselineEntry>>,
  current: Readonly<Record<string, { descHash: string }>>,
): {
  added: string[]
  removed: string[]
  renamed: Array<{ from: string; to: string }>
  drifted: string[]
} {
  const added = Object.keys(current).filter((name) => baseline[name] === undefined).sort()
  const removed = Object.keys(baseline).filter((name) => current[name] === undefined).sort()
  const drifted = Object.keys(current)
    .filter((name) => baseline[name] !== undefined && baseline[name]!.descHash !== current[name]!.descHash)
    .sort()
  // A rename keeps the description digest, so it is visible even though the
  // names differ — the cheapest upgrade to explain (`bash` -> `shell`).
  const renamed: Array<{ from: string; to: string }> = []
  const taken = new Set<string>()
  for (const from of removed) {
    const digest = baseline[from]!.descHash
    const to = added.find((candidate) => !taken.has(candidate) && current[candidate]!.descHash === digest)
    if (to !== undefined) {
      taken.add(to)
      renamed.push({ from, to })
    }
  }
  const renamedTo = new Set(renamed.map((pair) => pair.to))
  const renamedFrom = new Set(renamed.map((pair) => pair.from))
  return {
    added: added.filter((name) => !renamedTo.has(name)),
    removed: removed.filter((name) => !renamedFrom.has(name)),
    renamed,
    drifted,
  }
}

/** Read a name/description pair out of either lane's tool entry shape. */
export function observedToolsFrom(entries: unknown, flat: boolean): ObservedTool[] {
  if (!Array.isArray(entries)) return []
  const out: ObservedTool[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { name?: unknown; description?: unknown; function?: { name?: unknown; description?: unknown } }
    const name = flat ? record.name : record.function?.name
    const description = flat ? record.description : record.function?.description
    if (typeof name !== 'string' || name === '') continue
    out.push({ name, description: typeof description === 'string' ? description : '' })
  }
  return out
}

/** The installed host version, read once from the install dir the host exports. */
let hostVersionCache: string | undefined
export function hostVersion(): string {
  if (hostVersionCache !== undefined) return hostVersionCache
  hostVersionCache = ''
  const dir = process.env.DSH_INSTALL_DIR?.trim()
  if (dir !== undefined && dir !== '') {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string') hostVersionCache = version
    } catch {
      // A host without a readable manifest still records a baseline; the tab
      // shows the version as unknown and the operator can label the round.
    }
  }
  return hostVersionCache
}

/** Test seam: forget the cached host version. */
export function resetHostVersionCache(): void {
  hostVersionCache = undefined
}

/** Debounce window for the observation write (one request per chat turn). */
const FLUSH_MS = 30_000

export interface ToolCatalogOptions {
  /** State root; defaults to `stateDir()`. */
  dir?: string
  now?: () => number
  logger?: { warn(message: string): void; info(message: string): void }
}

/**
 * The catalogue: one document, loaded once, written atomically.
 *
 * `observe()` is called on every shaped request, so it never throws and never
 * blocks: a bad state file costs the table, not the chat.
 */
export class ToolCatalog {
  readonly path: string
  readonly #now: () => number
  readonly #logger: ToolCatalogOptions['logger']
  #doc: ToolCatalogDocument | undefined
  #dirty = false
  #timer: ReturnType<typeof setTimeout> | null = null
  #lastFlush = 0

  constructor(options: ToolCatalogOptions = {}) {
    this.path = join(options.dir ?? stateDir(), 'tool-catalog.json')
    this.#now = options.now ?? Date.now
    this.#logger = options.logger
  }

  /** The current document (loaded on first use; a bad file reads as empty). */
  document(): ToolCatalogDocument {
    this.#doc ??= this.#load()
    return this.#doc
  }

  #load(): ToolCatalogDocument {
    try {
      if (!existsSync(this.path)) return { ...EMPTY, baseline: {}, seen: {}, overrides: {}, retired: {} }
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY, baseline: {}, seen: {}, overrides: {}, retired: {} }
      const record = parsed as Partial<ToolCatalogDocument>
      return {
        version: 1,
        dshVersion: typeof record.dshVersion === 'string' ? record.dshVersion : '',
        recordedAt: typeof record.recordedAt === 'number' ? record.recordedAt : 0,
        fingerprint: typeof record.fingerprint === 'string' ? record.fingerprint : '',
        baseline: isRecord(record.baseline) ? (record.baseline as Record<string, BaselineEntry>) : {},
        seen: isRecord(record.seen) ? (record.seen as ToolCatalogDocument['seen']) : {},
        overrides: isRecord(record.overrides) ? (record.overrides as Record<string, ToolOverride>) : {},
        retired: isRecord(record.retired) ? (record.retired as Record<string, string>) : {},
      }
    } catch (err) {
      this.#logger?.warn(
        `oc2dsh: tool-catalog unreadable (${err instanceof Error ? err.message : String(err)}); starting empty`,
      )
      return { ...EMPTY, baseline: {}, seen: {}, overrides: {}, retired: {} }
    }
  }

  /** The shape one host tool rides the wire with, overrides applied. */
  resolve(name: string): ResolvedToolShape {
    return resolveToolShape(name, this.document().overrides)
  }

  /** The reply-side alias table for this process. */
  aliases(): Record<string, string> {
    const doc = this.document()
    return toolAliases(doc.overrides, doc.retired)
  }

  /**
   * Record what a request actually carried. The baseline is recorded from the
   * FIRST observation of an install, because that is the set that was working;
   * every later observation only updates `seen`, so an upgrade keeps showing
   * until the operator accepts it.
   */
  observe(tools: readonly ObservedTool[]): void {
    if (tools.length === 0) return
    const doc = this.document()
    const at = this.#now()
    let changed = this.#replaceSeen(doc, tools, 'observed', at)
    if (doc.recordedAt === 0) {
      this.#recordBaseline(doc)
      changed = true
    }
    if (changed) this.#schedule()
  }

  /**
   * The `seen` table holds the CURRENT set, not a history: a name that a newer
   * observation no longer carries is dropped, which is what lets the diff name
   * a rename instead of reporting an add beside a stale entry. The baseline is
   * the history.
   * @returns whether anything moved.
   */
  #replaceSeen(doc: ToolCatalogDocument, tools: readonly ObservedTool[], source: ToolSource, at: number): boolean {
    let changed = false
    const incoming = new Map(tools.map((tool) => [tool.name, descriptionHash(tool.description)]))
    for (const [name, entry] of Object.entries(doc.seen)) {
      if (entry.source !== source) continue
      if (incoming.has(name)) continue
      delete doc.seen[name]
      changed = true
    }
    for (const tool of tools) {
      const digest = incoming.get(tool.name)!
      const prior = doc.seen[tool.name]
      // An observation outranks a registry entry for the same name.
      if (prior !== undefined && prior.source === 'observed' && source === 'registered') continue
      if (prior !== undefined && prior.descHash === digest && prior.source === source) {
        prior.seenAt = at
        continue
      }
      doc.seen[tool.name] = { chars: tool.description.length, descHash: digest, seenAt: at, source }
      changed = true
    }
    return changed
  }

  /** Record the host registry's view (early warning only — see the module note). */
  observeRegistered(tools: readonly ObservedTool[]): void {
    if (tools.length === 0) return
    const doc = this.document()
    // The registry carries tools this preset never sends, and an observation
    // outranks it for any name both know.
    if (this.#replaceSeen(doc, tools, 'registered', this.#now())) this.#schedule()
  }

  /** 录入基线: freeze the current set as the reference for future upgrades. */
  recordBaseline(): ToolCatalogView {
    const doc = this.document()
    this.#recordBaseline(doc)
    this.#dirty = true
    void this.flush()
    return this.view()
  }

  #recordBaseline(doc: ToolCatalogDocument): void {
    const names = Object.keys(doc.seen)
    doc.recordedAt = this.#now()
    doc.fingerprint = toolFingerprint(names)
    doc.dshVersion = hostVersion()
    doc.baseline = Object.fromEntries(names.map((name) => [name, { chars: doc.seen[name]!.chars, descHash: doc.seen[name]!.descHash }]))
  }

  /**
   * Write one override. An empty `wire`/`description` clears that field back to
   * the built-in value; a wire that another live tool already uses is refused,
   * because two tools on one wire name cannot be told apart in a reply.
   */
  saveOverride(name: string, override: ToolOverride): { ok: true } | { ok: false; reason: OverrideRejection } {
    const doc = this.document()
    if (doc.seen[name] === undefined && WIRE_TOOL_RENAMES[name] === undefined) return { ok: false, reason: 'tool-unknown' }
    const wire = override.wire?.trim() ?? ''
    if (wire !== '' && !WIRE_NAME.test(wire)) return { ok: false, reason: 'wire-invalid' }
    if (wire !== '' && wire !== name) {
      for (const [otherName, other] of Object.entries(doc.overrides)) {
        if (otherName !== name && other.wire === wire) return { ok: false, reason: 'wire-taken' }
      }
      for (const [otherName, builtin] of Object.entries(WIRE_TOOL_RENAMES)) {
        if (otherName !== name && builtin === wire && doc.overrides[otherName]?.wire === undefined) {
          return { ok: false, reason: 'wire-taken' }
        }
      }
    }
    const previous = doc.overrides[name]
    // The alias that was on the wire until now has to keep resolving: a rename
    // between two requests of one turn would otherwise strand the tool call.
    if (previous?.wire !== undefined && previous.wire !== '' && previous.wire !== wire) {
      doc.retired[previous.wire] = name
    }
    const next: ToolOverride = {}
    if (wire !== '') next.wire = wire
    const description = override.description ?? ''
    if (description !== '') next.description = description
    if (next.wire === undefined && next.description === undefined) delete doc.overrides[name]
    else doc.overrides[name] = next
    this.#dirty = true
    void this.flush()
    return { ok: true }
  }

  /** Drop one tool's overrides (its built-in shape comes back). */
  resetOverride(name: string): void {
    const doc = this.document()
    const previous = doc.overrides[name]
    if (previous?.wire !== undefined && previous.wire !== '') doc.retired[previous.wire] = name
    delete doc.overrides[name]
    this.#dirty = true
    void this.flush()
  }

  /**
   * The modal's table: today's set (registered + observed) diffed against the
   * baseline, one row per name either may carry.
   * @param registered - the host registry's current view; omitted = observed only.
   */
  view(registered: readonly ObservedTool[] = []): ToolCatalogView {
    const doc = this.document()
    if (registered.length > 0) this.observeRegistered(registered)
    const current: Record<string, { descHash: string; chars: number; seenAt: number; source: ToolSource; description?: string }> = {}
    for (const [name, entry] of Object.entries(doc.seen)) current[name] = { ...entry }
    for (const tool of registered) {
      const existing = current[tool.name]
      if (existing !== undefined && existing.source === 'observed') continue
      current[tool.name] = {
        chars: tool.description.length,
        descHash: descriptionHash(tool.description),
        seenAt: doc.seen[tool.name]?.seenAt ?? this.#now(),
        source: 'registered',
        description: tool.description,
      }
    }
    // No baseline = nothing to compare against: every row would read "added",
    // which is noise on a fresh install. The header says the baseline is unset.
    const diff = doc.recordedAt === 0
      ? { added: [] as string[], removed: [] as string[], renamed: [] as Array<{ from: string; to: string }>, drifted: [] as string[] }
      : diffToolSets(doc.baseline, current)
    const addedSet = new Set(diff.added)
    const driftedSet = new Set(diff.drifted)
    const renamedFrom = new Map(diff.renamed.map((pair) => [pair.to, pair.from]))
    const renamedFromSet = new Set(diff.renamed.map((pair) => pair.from))

    const rows: ToolCatalogRow[] = []
    const names = Object.keys(current).sort()
    for (const name of names) {
      const entry = current[name]!
      const shape = this.resolve(name)
      const builtin = resolveToolShape(name)
      const state: ToolRowState = addedSet.has(name)
        ? 'added'
        : renamedFrom.has(name)
          ? 'renamed'
          : driftedSet.has(name)
            ? 'drifted'
            : 'ok'
      rows.push({
        name,
        wire: shape.wire,
        wireSource: shape.wireSource,
        description: shape.description ?? entry.description ?? '',
        descriptionSource: shape.descriptionSource,
        chars: shape.description?.length ?? entry.chars,
        state,
        builtinWire: builtin.wire,
        ...(builtin.description === undefined ? {} : { builtinDescription: builtin.description }),
        ...(renamedFrom.has(name) ? { renamedFrom: renamedFrom.get(name)! } : {}),
        seenAt: entry.seenAt,
        source: entry.source,
      })
    }
    // Baseline names the host no longer carries: the operator needs to see them
    // to drop an override that would otherwise map a tool nobody sends.
    for (const name of diff.removed) {
      const shape = this.resolve(name)
      const builtin = resolveToolShape(name)
      rows.push({
        name,
        wire: shape.wire,
        wireSource: shape.wireSource,
        description: shape.description ?? '',
        descriptionSource: shape.descriptionSource,
        chars: shape.description?.length ?? 0,
        state: 'gone',
        builtinWire: builtin.wire,
        ...(builtin.description === undefined ? {} : { builtinDescription: builtin.description }),
        seenAt: doc.seen[name]?.seenAt ?? 0,
        source: doc.seen[name]?.source ?? 'registered',
      })
    }
    const pending = rows.filter((row) => row.state !== 'ok' && !(row.state === 'gone' && renamedFromSet.has(row.name))).length
    return {
      dshVersion: doc.dshVersion,
      recordedAt: doc.recordedAt,
      currentDshVersion: hostVersion(),
      pending,
      recorded: doc.recordedAt !== 0,
      rows,
    }
  }

  #schedule(): void {
    this.#dirty = true
    if (this.#timer !== null) return
    const wait = Math.max(0, FLUSH_MS - (this.#now() - this.#lastFlush))
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.flush()
    }, wait)
    this.#timer.unref?.()
  }

  /** Write the document atomically; a failure costs the table, not the chat. */
  async flush(): Promise<void> {
    if (!this.#dirty) return
    this.#dirty = false
    this.#lastFlush = this.#now()
    const temp = `${this.path}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(temp, JSON.stringify(this.document(), null, 2), 'utf8')
      renameSync(temp, this.path)
    } catch (err) {
      this.#dirty = true
      this.#logger?.warn(
        `oc2dsh: could not persist the tool-catalog (${err instanceof Error ? err.message : String(err)}); the modal's baseline will be stale`,
      )
    }
  }

  /** Drop the debounce timer (tests and plugin disposal). */
  dispose(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
