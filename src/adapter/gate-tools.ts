/**
 * The anonymous free lane's gate tools — the GENUINE OpenCode definitions.
 *
 * Why verbatim: the gate that went live 2026-10-14 does not merely require a
 * `bash` and a `read` entry (the 2026-09-18 recipe); it validates their
 * CONTENT. Live-probed 2026-10-14 against `POST /inference/v1/chat/completions`
 * (ablation matrix, every other field held at the captured client request):
 *
 *   - `bash` + `read` with the definitions below            -> 200
 *   - the placeholder stubs shipped since 2026-09-18
 *     (description "Reserved for the host runtime; do not call it.",
 *     parameters `{type:'object',properties:{}}`)           -> 403
 *   - the genuine pair with `bash`'s description truncated
 *     to 120 chars                                          -> 403
 *   - ... with the genuine text prefixed by `X` or with
 *     " (copy)" appended                                    -> 200
 *   - ... with `bash`'s parameters gaining one property,
 *     losing `required`, or emptied                         -> 403
 *   - the genuine pair plus one extra unrelated tool         -> 200
 *   - the genuine pair minus `bash`, or `bash` alone         -> 403
 *
 * So the check was, as measured 2026-10-14: both names present, each
 * `description` CONTAINING the genuine text (substring, not equality) and each
 * `parameters` EQUAL to the genuine schema (`$schema` included). Extra tools
 * were ignored — which is why the adapter can keep forwarding the host's own
 * tool set beside these two.
 *
 * RE-MEASURED 2026-10-19 (same endpoint, captured adapter bytes replayed, one
 * variable per request, two models): that content check is GONE. Both
 * definitions replaced by a bare `{description:"Agent tool X", parameters:`
 * `{type:"object", properties:{}}}` answered 200, under this adapter's 2.x UA,
 * under the 1.19.3 AI-SDK UA and under the 1.18.31 UA alike. The only
 * structural requirement that day was a NON-EMPTY `tools` array carrying an
 * entry NAMED `read` (bash-only / shell-only / edit-only / unrelated-only each
 * 403, `read` alone 200). The genuine pair is nevertheless KEPT: the gate has
 * flipped four times (09-16, 10-09, 10-13, 10-14) and on 10-14 the stubs above
 * really were the rejection signal — carrying 300 lines of insurance is much
 * cheaper than rediscovering this under a user-facing 403.
 *
 * Provenance: captured 2026-10-14 from OpenCode Desktop 1.19.0 by running the
 * app's own bundled server (`out/main/chunks/node-bfcslolZ.js`, started the
 * way its sidecar starts it: `Server.listen({username:'opencode',...})`) in an
 * isolated `XDG_*` tree with a `globalThis.fetch` spy, then driving one real
 * agent turn through its HTTP API; the captured request answered 200. The two
 * entries below are that request's `body.tools` verbatim.
 *
 * Re-capture (the gate WILL move again — it has on 2026-09-16, 2026-10-09,
 * 2026-10-13 and 2026-10-14): run the same spy, take `bash` and `read` from
 * the logged request's `body.tools`, and replace the two entries below. The
 * expected text is platform-independent — verified by re-sending the captured
 * `bash` description with `OS: darwin, Shell: zsh` rewritten to
 * `OS: linux, Shell: bash` (200) and with that line deleted (200) — so this
 * macOS/zsh rendering is valid on every host.
 *
 * The CURRENT client (static extraction 2026-10-22 from Desktop 2.1.3 + its
 * bundled `opencode-cli`) no longer ships this pair. Its wire tools are:
 *
 *   - `shell` — `bash` is GONE. The description is joined from fixed
 *     sentences with NO OS/shell line ("Execute a shell command and return
 *     its output." plus quoting, prefer-dedicated-tools, truncation, timeout
 *     and background bullets). Parameters: `command` (required), `workdir`,
 *     `timeout` (its default value is interpolated at runtime, not
 *     statically recoverable), `background` (new).
 *   - `read` — parameter `filePath` RENAMED to `path` (`offset`/`limit`
 *     unchanged); description fully rewritten ("Read the contents of a file
 *     or directory. Supports text files, images, and PDFs. …").
 *
 * The 1.19.0 pair below stays the INJECTED pair on purpose. The gate as
 * re-probed 2026-10-19 does not validate tool content, and swapping this
 * pair in under the adapter's v1 header set would be a single-variable
 * generation mix — the documented way this lane has broken three times.
 * Migrating to the 2.1.3 pair has to move the whole recipe (four session
 * spellings, no `x-opencode-request`, 40-hex project id) one live-probed
 * variable at a time, starting from a wire capture that pins the
 * runtime-interpolated `timeout` default and the byte-exact rendered
 * schemas.
 */
export const FREE_LANE_GATE_TOOL_NAMES = ['bash', 'read'] as const

export interface FreeLaneGateTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export const GENUINE_GATE_TOOLS: Readonly<
  Record<(typeof FREE_LANE_GATE_TOOL_NAMES)[number], FreeLaneGateTool>
> = {
    "bash": {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nBe aware: OS: darwin, Shell: zsh\n\nAll commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.\n\nUse `/var/folders/yf/m3z0fmjd7j71qwfz736rkvg00000gn/T/opencode` for temporary work outside the workspace. This directory has already been created, already exists, and is pre-approved for external directory access.\n\nIMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use `ls` to verify the parent directory exists and is the correct location\n   - For example, before running \"mkdir foo/bar\", first use `ls foo` to check that \"foo\" exists and is the intended parent directory\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., rm \"path with spaces/file.txt\")\n   - Examples of proper quoting:\n     - mkdir \"/Users/name/My Documents\" (correct)\n     - mkdir /Users/name/My Documents (incorrect - will fail)\n     - python \"/path/with spaces/script.py\" (correct)\n     - python /path/with spaces/script.py (incorrect - will fail)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n  - The command argument is required.\n  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after 120000ms.\n  - If the output exceeds 2000 lines or 51200 bytes, it will be truncated and the full output will be written to a file. You can use Read with offset/limit to read specific sections or Grep to search the full content. Do NOT use `head`, `tail`, or other truncation commands to limit output; the full output will already be captured to a file for more precise searching.\n\n  - Avoid using Bash with the `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:\n    - File search: Use Glob (NOT find or ls)\n    - Content search: Use Grep (NOT grep or rg)\n    - Read files: Use Read (NOT cat/head/tail)\n    - Edit files: Use Edit (NOT sed/awk)\n    - Write files: Use Write (NOT echo >/cat <<EOF)\n    - Communication: Output text directly (NOT echo/printf)\n  - When issuing multiple commands:\n    - If the commands are independent and can run in parallel, make multiple bash tool calls in a single message. For example, if you need to run \"git status\" and \"git diff\", send a single message with two bash tool calls in parallel.\n    - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead.\n    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail\n    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)\n  - AVOID using `cd <directory> && <command>`. Use the `workdir` parameter to change directories instead.\n    <good-example>\n    Use workdir=\"/foo/bar\" with command: pytest tests\n    </good-example>\n    <bad-example>\n    cd /foo/bar && pytest tests\n    </bad-example>\n\n# Git and GitHub\n- Only commit, amend, push, or create PRs when explicitly requested.\n- Before committing, inspect `git status`, `git diff`, and `git log --oneline -10`; stage only intended files and never commit secrets.\n- Write a concise commit message that matches the repo style.\n- Do not update git config, skip hooks, use interactive `-i`, force-push, or create empty commits unless explicitly requested.\n- If a commit fails or hooks reject it, fix the issue and create a new commit; do not amend the failed commit.\n- Before creating a PR, inspect status, diff, remote tracking, recent commits, and the diff from the base branch.\n- Review all commits included in the PR, not just the latest commit.\n- Use `gh` for GitHub tasks, including PRs, issues, checks, and releases; return the PR URL when done.\n",
        "parameters": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "type": "object",
          "properties": {
            "command": {
              "type": "string",
              "description": "The command to execute"
            },
            "timeout": {
              "minimum": -9007199254740991,
              "exclusiveMinimum": 0,
              "type": "integer",
              "maximum": 9007199254740991,
              "description": "Optional timeout in milliseconds"
            },
            "workdir": {
              "type": "string",
              "description": "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands."
            }
          },
          "required": [
            "command"
          ]
        }
      }
    },
    "read": {
      "type": "function",
      "function": {
        "name": "read",
        "description": "Read a file or directory from the local filesystem. If the path does not exist, an error is returned.\n\nUsage:\n- The filePath parameter should be an absolute path.\n- By default, this tool returns up to 2000 lines from the start of the file.\n- The offset parameter is the line number to start from (1-indexed).\n- To read later sections, call this tool again with a larger offset.\n- Use the grep tool to find specific content in large files or files with long lines.\n- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.\n- Contents are returned with each line prefixed by its line number as `<line>: <content>`. For example, if a file has contents \"foo\\n\", you will receive \"1: foo\\n\". For directories, entries are returned one per line (without line numbers) with a trailing `/` for subdirectories.\n- Any line longer than 2000 characters is truncated.\n- Call this tool in parallel when you know there are multiple files you want to read.\n- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.\n- This tool can read image files and PDFs and return them as file attachments.\n",
        "parameters": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "type": "object",
          "properties": {
            "filePath": {
              "type": "string",
              "description": "The absolute path to the file or directory to read"
            },
            "offset": {
              "minimum": 0,
              "type": "integer",
              "maximum": 9007199254740991,
              "description": "The line number to start reading from (1-indexed)"
            },
            "limit": {
              "minimum": 0,
              "type": "integer",
              "maximum": 9007199254740991,
              "description": "The maximum number of lines to read (defaults to 2000)"
            }
          },
          "required": [
            "filePath"
          ]
        }
      }
    }
  }

/** A detached copy: callers splice these into a payload and may mutate them. */
export function freeLaneGateTool(name: (typeof FREE_LANE_GATE_TOOL_NAMES)[number]): FreeLaneGateTool {
  return structuredClone(GENUINE_GATE_TOOLS[name])
}

/**
 * True when a tool entry already carries the genuine definition, i.e. the gate
 * would accept it as-is: same name, a description that contains the genuine
 * text, and byte-identical parameters. Used by the payload shaper to leave an
 * already-correct entry untouched (so a host tool that happens to ship the
 * genuine definition is not reordered or rewritten).
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
 * host's `bash`/`read` definitions with the genuine ones (see the module doc):
 * the model is told what the WIRE schema declares (`filePath`, `timeout`),
 * while the host validates against its own (`file_path`, `timeoutMs`).
 *
 * The pairing is derived from the host's declared arguments, so a host that
 * renames a field still pairs correctly: exact name first, then the
 * separator/`ms`-insensitive normalized match. A wire argument the host does
 * not declare is dropped, a required host argument the wire cannot supply is
 * synthesized, and a call whose result would equal its input is reported as
 * unchanged (`undefined`) so the chunk stream is left alone.
 */
export interface GateToolArgumentBridge {
  /** Wire tool names whose finished arguments need rewriting. */
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
  /** wire name -> wire key -> host key (undefined: the host does not declare it) */
  const plans = new Map<string, Map<string, string | undefined>>()
  const synthesize = new Map<string, string[]>()
  for (const wireName of FREE_LANE_GATE_TOOL_NAMES) {
    const host = hostByName.get(wireName)
    if (host === undefined) continue
    const wireKeys = Object.keys(
      (GENUINE_GATE_TOOLS[wireName].function.parameters.properties ?? {}) as Record<string, unknown>,
    )
    const byNormalized = new Map(host.keys.map((key) => [normalizeArgumentKey(key), key]))
    const plan = new Map<string, string | undefined>()
    const covered = new Set<string>()
    for (const wireKey of wireKeys) {
      const hostKey = host.keys.includes(wireKey) ? wireKey : byNormalized.get(normalizeArgumentKey(wireKey))
      plan.set(wireKey, hostKey)
      if (hostKey !== undefined) covered.add(hostKey)
    }
    plans.set(wireName, plan)
    synthesize.set(wireName, [...host.required].filter((key) => !covered.has(key)))
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
