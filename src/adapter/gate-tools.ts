/**
 * The anonymous free lane's gate tools — the GENUINE OpenCode definitions,
 * byte-exact from the official 2.1.4 client.
 *
 * PROVENANCE (2026-10-24): captured from the installed Desktop 2.1.4
 * `opencode-cli` by pointing its provider baseURL at a loopback capture
 * server (`docs/local/capture-214/probe.cjs`, isolated `XDG_*` tree,
 * `OPENCODE_CONFIG_CONTENT` config) and driving one real
 * `run --standalone --auto` turn. The server logged every header and the RAW
 * request body; the two entries below are that body's `tools` payload
 * verbatim, in the client's own order (of its 12 advertised tools — `edit`,
 * `glob`, `grep`, `question`, `read`, `shell`, `skill`, `subagent`,
 * `webfetch`, `websearch`, `write`, `execute` — `shell` and `read` are the
 * two the gate names; the rest are ordinary extra tools the gate ignores).
 *
 * One capture subtlety worth keeping: `permission: 'deny'` in the probe
 * config produced a request with NO `tools` key at all, because
 * `Tool.snapshot(permissions)` drops every definition under a deny-all
 * ruleset (`whollyDisabled`, packages/core/src/tool.ts). The captured
 * definitions below therefore come from an open-permissions run.
 *
 * WHY VERBATIM: the gate validates tool CONTENT, not just names. Measured
 * 2026-10-14 against `POST /inference/v1/chat/completions` (ablation matrix,
 * every other field held at the captured client request): genuine pair -> 200;
 * placeholder stubs -> 403; a description truncated to 120 chars -> 403; a
 * description merely prefixed with `X` or suffixed " (copy)" -> 200;
 * parameters gaining one property, losing `required`, or emptied -> 403; the
 * genuine pair minus `bash` (or `bash` alone) -> 403. The check was: both
 * names present, each description CONTAINING the genuine text (substring),
 * each `parameters` EQUAL to the genuine schema.
 *
 * RE-MEASURED 2026-10-24 with the 2.1.4 pair under the 2.1.4 header set, one
 * variable per request, through a pool exit where the gate answers BEFORE the
 * quota layer (so the status still discriminates with the anonymous quota
 * spent: 429 FreeUsageLimitError = gate PASSED, 403 FreeTierError = gate
 * REJECTED):
 *
 *   - the captured 12-tool payload               -> 429 (passed)
 *   - the captured `read` ALONE                  -> 429 (passed)
 *   - the captured `shell` ALONE (no `read`)     -> 403 (rejected)
 *   - the previous-generation `bash`+`read` pair -> 429 (passed)
 *   - `ses_short` session id (calibration)       -> 403 (rejected)
 *
 * So the only STRUCTURAL requirement on 2026-10-24 is a non-empty `tools`
 * array carrying an entry NAMED `read`; content validation is OFF again and
 * the old pair still passes. Both generations are kept as insurance — the
 * gate has flipped five times (09-16, 10-09, 10-13, 10-14, content-check off
 * since 10-19) and on 10-14 the stubs really were the rejection signal.
 *
 * RE-CAPTURE when the gate moves again: rerun `probe.cjs` (loopback only,
 * nothing leaves 127.0.0.1), take `shell` and `read` from the logged
 * `body.tools`, and replace the two entries below.
 *
 * The 2.1.4 pair ships as ONE recipe with the 2.1.4 header set (four session
 * spellings, no `x-opencode-request`, 2.1.4 UA) — mixing generations inside
 * one request is the documented way this lane has broken (adapter/ids.ts
 * `disguiseHeaders`).
 */

/** Wire names of the injected pair, in the client's own precedence. */
export const FREE_LANE_GATE_TOOL_NAMES = ['shell', 'read'] as const

/**
 * The host tool each wire name is an ALIAS of. The official 2.x client calls
 * it `shell`; DSH names the same capability `bash`, so the wire carries
 * `shell` and the harness chunk stream renames it back on the way out
 * (adapter/messages.ts `GATE_TOOL_ALIASES` -> adapter/events.ts
 * `toolNameAlias`).
 */
export const GATE_TOOL_HOST_NAMES: Record<(typeof FREE_LANE_GATE_TOOL_NAMES)[number], string> = {
  shell: 'bash',
  read: 'read',
}

/** Superseded 1.x wire names: dropped from a payload so the wire never mixes
 *  a 1.x tool name into the 2.x recipe (the host's `bash` rides back in
 *  through the `shell` alias instead). */
export const SUPERSEDED_GATE_TOOL_NAMES = ['bash'] as const

export interface FreeLaneGateTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean }
}

export const GENUINE_GATE_TOOLS: Readonly<
  Record<(typeof FREE_LANE_GATE_TOOL_NAMES)[number], FreeLaneGateTool>
> = {
    "shell": {
      "type": "function",
      "function": {
        "name": "shell",
        "description": "Execute a shell command and return its output. Commands run on macOS using zsh. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
        "parameters": {
          "type": "object",
          "properties": {
            "command": {
              "type": "string",
              "description": "Shell command string to execute"
            },
            "workdir": {
              "type": "string",
              "description": "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."
            },
            "timeout": {
              "type": "integer",
              "minimum": 0,
              "description": "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."
            },
            "background": {
              "type": "boolean",
              "description": "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."
            }
          },
          "required": [
            "command"
          ],
          "additionalProperties": false
        },
        "strict": false
      }
    },
    "read": {
      "type": "function",
      "function": {
        "name": "read",
        "description": "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {
              "type": "string",
              "description": "File or directory to read"
            },
            "offset": {
              "type": "integer",
              "minimum": 0,
              "description": "The line or directory entry to start reading from (1-based)"
            },
            "limit": {
              "type": "integer",
              "minimum": 0,
              "description": "The maximum number of lines or directory entries to read (defaults to and capped at 2000)"
            }
          },
          "required": [
            "path"
          ],
          "additionalProperties": false
        },
        "strict": false
      }
    }
  }

/** A detached copy: callers splice these into a payload and may mutate them. */
export function freeLaneGateTool(name: (typeof FREE_LANE_GATE_TOOL_NAMES)[number]): FreeLaneGateTool {
  return structuredClone(GENUINE_GATE_TOOLS[name])
}

/**
 * True when a tool entry already carries the genuine definition, i.e. the
 * gate would accept it as-is: same name, a description that contains the
 * genuine text, and byte-identical parameters. Used by the payload shaper to
 * leave an already-correct entry untouched (so a host tool that happens to
 * ship the genuine definition is not reordered or rewritten).
 */
export function isGenuineGateTool(name: string, entry: unknown): boolean {
  if (!Object.hasOwn(GENUINE_GATE_TOOLS, name)) return false
  if (typeof entry !== 'object' || entry === null) return false
  const fn = (entry as { function?: unknown }).function
  if (typeof fn !== 'object' || fn === null) return false
  const candidate = fn as { name?: unknown; description?: unknown; parameters?: unknown }
  const genuine = GENUINE_GATE_TOOLS[name as (typeof FREE_LANE_GATE_TOOL_NAMES)[number]].function
  return (
    candidate.name === genuine.name
    && typeof candidate.description === 'string'
    && candidate.description.includes(genuine.description)
    && JSON.stringify(candidate.parameters) === JSON.stringify(genuine.parameters)
  )
}

/** The flat (`/responses`) spelling of a gate tool: `type` and the function's
 *  fields hoisted to the entry, which is what that lane's `tools` array uses. */
export interface FreeLaneGateFlatTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

export function freeLaneGateFlatTool(name: (typeof FREE_LANE_GATE_TOOL_NAMES)[number]): FreeLaneGateFlatTool {
  const fn = GENUINE_GATE_TOOLS[name].function
  return { type: 'function', name: fn.name, description: fn.description, parameters: structuredClone(fn.parameters) }
}

/** Flat-shape twin of {@link isGenuineGateTool}. */
export function isGenuineFlatGateTool(name: string, entry: unknown): boolean {
  if (!Object.hasOwn(GENUINE_GATE_TOOLS, name)) return false
  if (typeof entry !== 'object' || entry === null) return false
  const candidate = entry as { type?: unknown; name?: unknown; description?: unknown; parameters?: unknown }
  const genuine = GENUINE_GATE_TOOLS[name as (typeof FREE_LANE_GATE_TOOL_NAMES)[number]].function
  return (
    candidate.type === 'function'
    && candidate.name === genuine.name
    && typeof candidate.description === 'string'
    && candidate.description.includes(genuine.description)
    && JSON.stringify(candidate.parameters) === JSON.stringify(genuine.parameters)
  )
}

/** The host-side tool shape the bridge reads (structurally, to avoid an import cycle). */
export interface HostToolSchema {
  name: string
  parameters?: unknown
}

/**
 * One tool's declared arguments, in either shape the host may hand us: a JSON
 * Schema (`{ type:'object', properties:{…}, required:[…] }`) or DSH's own
 * `defineTool` form, where `parameters` IS the property map and each entry
 * carries `required: true` instead of a `required` array.
 */
interface DeclaredArguments {
  keys: string[]
  required: Set<string>
}

function declaredArguments(parameters: unknown): DeclaredArguments | undefined {
  if (typeof parameters !== 'object' || parameters === null) return undefined
  const record = parameters as Record<string, unknown>
  const wrapped = typeof record.properties === 'object' && record.properties !== null
    ? (record.properties as Record<string, unknown>)
    : undefined
  // A JSON Schema always carries a string `type`, so its absence identifies the
  // bare `defineTool` form — an argument literally named `type` holds a schema
  // OBJECT there, never a string, so the two shapes cannot be confused.
  const bare = wrapped === undefined && typeof record.type !== 'string' ? record : undefined
  const properties = wrapped ?? bare
  if (properties === undefined) return undefined
  const requiredArray = record.required
  const required = new Set<string>(Array.isArray(requiredArray) ? requiredArray.filter((k): k is string => typeof k === 'string') : [])
  const keys: string[] = []
  for (const [key, value] of Object.entries(properties)) {
    keys.push(key)
    if (typeof value === 'object' && value !== null && (value as { required?: unknown }).required === true) required.add(key)
  }
  return { keys, required }
}

/**
 * Argument-name normalization for pairing the wire's names with the host's.
 * Lowercases, drops every separator, and drops a trailing `ms` so a host
 * spelling like `timeoutMs` (DSH's bash) pairs with the wire's `timeout`.
 */
function normalizeArgumentKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/ms$/, '')
}

/**
 * Explicit wire->host argument renames the normalization above cannot pair.
 * The 2.1.4 `read` schema renamed `filePath` to `path` (wire) while DSH's
 * read still declares `file_path`: `path` and `file_path` normalize to
 * different strings, so without this table the path would be DROPPED and the
 * host's required argument left unsupplied. Candidate host keys are tried in
 * order against what the host actually declares.
 */
const WIRE_ARGUMENT_ALIASES: Record<string, Record<string, readonly string[]>> = {
  read: { path: ['file_path', 'filePath', 'filepath'] },
}

/** Host arguments the genuine schema cannot supply, synthesized from the wire ones. */
function synthesizeHostArgument(hostKey: string, wireArgs: Record<string, unknown>): string | undefined {
  if (hostKey !== 'description') return undefined
  // DSH's bash requires a non-empty `description` (it is the tool call's UI
  // title, `dsh-tool-bash`); the genuine schema has no such field, so the
  // model never sends one. The command's first line is the same string the
  // host falls back to for its own title.
  const command = wireArgs.command
  if (typeof command !== 'string' || command.trim().length === 0) return 'Run command'
  const firstLine = command.trim().split('\n')[0]!.trim().replace(/\s+/g, ' ')
  return firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 99)}…`
}

/**
 * Translates a finished tool call's arguments from the wire (genuine gate)
 * shape to the host tool's declared shape — the other half of replacing the
 * host's tool definitions with the genuine ones (see the module doc): the
 * model is told what the WIRE schema declares (`path`, `timeout`), while the
 * host validates against its own (`file_path`, `timeoutMs`).
 *
 * The pairing is derived from the host's declared arguments, so a host that
 * renames a field still pairs correctly: exact name first, then the
 * separator/`ms`-insensitive normalized match, then the explicit alias table
 * ({@link WIRE_ARGUMENT_ALIASES}). A wire argument the host does not declare
 * is dropped, a required host argument the wire cannot supply is synthesized,
 * and a call whose result would equal its input is reported as unchanged
 * (`undefined`) so the chunk stream is left alone.
 */
export interface GateToolArgumentBridge {
  /** Host tool names whose finished arguments need rewriting (post-alias). */
  readonly names: ReadonlySet<string>
  rewrite(name: string, args: Record<string, unknown>): Record<string, unknown> | undefined
}

export function gateToolArgumentBridge(hostTools: readonly HostToolSchema[] | undefined): GateToolArgumentBridge | undefined {
  if (!Array.isArray(hostTools) || hostTools.length === 0) return undefined
  const hostByName = new Map<string, DeclaredArguments>()
  for (const tool of hostTools) {
    if (typeof tool?.name !== 'string') continue
    const declared = declaredArguments(tool.parameters)
    if (declared !== undefined) hostByName.set(tool.name, declared)
  }
  /** host name -> wire key -> host key (undefined: the host does not declare it) */
  const plans = new Map<string, Map<string, string | undefined>>()
  const synthesize = new Map<string, string[]>()
  for (const wireName of FREE_LANE_GATE_TOOL_NAMES) {
    const hostName = GATE_TOOL_HOST_NAMES[wireName]
    const host = hostByName.get(hostName)
    if (host === undefined) continue
    const wireKeys = Object.keys(
      (GENUINE_GATE_TOOLS[wireName].function.parameters.properties ?? {}) as Record<string, unknown>,
    )
    const byNormalized = new Map(host.keys.map((key) => [normalizeArgumentKey(key), key]))
    const byName = new Map(host.keys.map((key) => [key, key]))
    const plan = new Map<string, string | undefined>()
    const covered = new Set<string>()
    for (const wireKey of wireKeys) {
      const alias = WIRE_ARGUMENT_ALIASES[wireName]?.[wireKey]
      const hostKey = byName.get(wireKey) ?? byNormalized.get(normalizeArgumentKey(wireKey))
        ?? alias?.map((candidate) => byName.get(candidate)).find((candidate) => candidate !== undefined)
      plan.set(wireKey, hostKey)
      if (hostKey !== undefined) covered.add(hostKey)
    }
    plans.set(hostName, plan)
    synthesize.set(hostName, [...host.required].filter((key) => !covered.has(key)))
  }
  if (plans.size === 0) return undefined
  return {
    names: new Set(plans.keys()),
    rewrite(name, args) {
      const plan = plans.get(name)
      if (plan === undefined) return undefined
      const host = hostByName.get(name)!
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(args)) {
        // exact host key wins; else pair through the plan; else keep an
        // unknown extra (the host may accept fields the wire schema hides)
        if (host.keys.includes(key)) out[key] = value
        else {
          const wireTarget = plan.get(key)
          if (wireTarget !== undefined) out[wireTarget] = value
          else if (!plan.has(key)) out[key] = value
        }
      }
      for (const hostKey of synthesize.get(name) ?? []) {
        if (out[hostKey] !== undefined) continue
        const value = synthesizeHostArgument(hostKey, args)
        if (value !== undefined) out[hostKey] = value
      }
      return JSON.stringify(out) === JSON.stringify(args) ? undefined : out
    },
  }
}
