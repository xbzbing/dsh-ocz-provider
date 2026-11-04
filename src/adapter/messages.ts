import { apiForModel } from './routing.ts'
import {
  FREE_LANE_GATE_TOOL_NAMES,
  freeLaneGateFlatTool,
  freeLaneGateTool,
  isGenuineFlatGateTool,
  isGenuineGateTool,
  SUPERSEDED_GATE_TOOL_NAMES,
} from './gate-tools.ts'
import { hasEnvBlock, renderEnvSection, withEnvBlock, type EnvFacts } from './env-block.ts'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Harness GenerateOptions -> pi-ai Context conversion (clean-room version of
 * dsh-llm-pi-ai's textOnlyContext). Unlike the host's text-only projection,
 * user and tool-result image blocks are kept: the adapter declares image
 * input modalities, so dsh-llm forwards them untouched and the bytes load
 * from the harness attachment store here.
 */

export interface HarnessTool {
  name: string
  description: string
  parameters: unknown
}

export type HarnessBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature?: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'image'; [key: string]: unknown }
  | { type: 'tool-result'; toolCallId: string; content: HarnessBlock[]; isError?: boolean; [key: string]: unknown }

export interface HarnessMessage {
  /**
   * DSH >= 0.2 delivers tool results as `role: 'tool'` messages with the call
   * id at the message level; older hosts wrap them in `role: 'user'` messages
   * carrying `tool-result` content blocks. Both shapes are handled.
   */
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: HarnessBlock[]
  toolCallId?: string
  isError?: boolean
  source?: { kind: string; provider?: string; model?: string; callId?: string; [key: string]: unknown }
}

export interface HarnessGenerateOptions {
  provider: string
  model: string
  messages: HarnessMessage[]
  system?: string
  tools?: HarnessTool[]
  maxTokens?: number
  temperature?: number
  reasoning?: string
  reasoningEffort?: string
  signal?: AbortSignal
  [key: string]: unknown
}

/** pi-ai message vocabulary (subset we emit). */
export type PiMessage =
  | { role: 'user'; content: string | PiContentBlock[]; timestamp: number }
  | {
      role: 'assistant'
      content: PiAssistantBlock[]
      api: 'openai-completions' | 'openai-responses'
      provider: string
      model: string
      usage: PiUsage
      stopReason: 'stop' | 'toolUse'
      timestamp: number
    }
  | { role: 'toolResult'; toolCallId: string; toolName: string; content: PiContentBlock[]; isError: boolean; timestamp: number }

export type PiAssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; thinkingSignature?: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

export type PiContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}

export interface PiTool {
  name: string
  description: string
  parameters: unknown
}

export interface PiContext {
  systemPrompt?: string
  messages: PiMessage[]
  tools?: PiTool[]
}

export function zeroUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed }
  } catch {
    return { raw }
  }
}

/**
 * Harness attachment root (mirrors dsh-attachment-local's resolveDshHome).
 * DSH_HOME is always set by the harness child; the homedir fallback covers
 * direct invocation (tests, tooling).
 */
function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  if (configured) return configured
  return join(homedir(), '.dsh')
}

/**
 * Convert one harness image block to pi-ai ImageContent by reading the
 * content-addressed normalized object (DSH_HOME/attachments/v1/objects/<2>/<sha>).
 * Falls back to stable text on any failure so a missing object can never
 * fail the whole stream.
 */
async function toPiImage(ref: unknown): Promise<PiContentBlock> {
  const attachment = (ref ?? {}) as { attachmentId?: unknown; mediaType?: unknown }
  const id = typeof attachment.attachmentId === 'string' ? attachment.attachmentId : ''
  const sha = id.startsWith('sha256:') ? id.slice(7) : id
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    return { type: 'text', text: `[image omitted: unreadable attachment reference ${JSON.stringify(id)}]` }
  }
  const path = join(dshHome(), 'attachments', 'v1', 'objects', sha.slice(0, 2), sha)
  try {
    const bytes = await readFile(path)
    return {
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: typeof attachment.mediaType === 'string' && attachment.mediaType.length > 0 ? attachment.mediaType : 'image/png',
    }
  } catch {
    return { type: 'text', text: `[image omitted: failed to read normalized attachment ${JSON.stringify(id)}]` }
  }
}

/**
 * Host-budget-offloaded images were routed out of the request by dsh-llm on
 * purpose (`offloaded: true`); re-reading their bytes from disk would defy the
 * image budget the host already enforced. Emit a stable placeholder instead —
 * the same semantics as the host adapter's projectOffloadedImages.
 */
function offloadedImagePart(ref: unknown): PiContentBlock {
  const id = (ref as { attachmentId?: unknown } | null | undefined)?.attachmentId
  const short = typeof id === 'string' && id.length > 0 ? ` ${id.slice(0, 30)}` : ''
  return { type: 'text', text: `[image omitted: offloaded to fit the request image budget${short}]` }
}

/** One image block, respecting the host's offload flag. */
async function imagePart(block: { type?: unknown; attachment?: unknown; offloaded?: unknown }): Promise<PiContentBlock> {
  return block.offloaded === true ? offloadedImagePart(block.attachment) : toPiImage(block.attachment)
}

/** Text/image parts of one user message's content, in block order. */
async function userParts(blocks: HarnessBlock[]): Promise<PiContentBlock[]> {
  const parts: PiContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(await imagePart(block))
    }
  }
  return parts
}

/** Text/image parts of one tool result's content, walking nested results. */
async function toolResultParts(blocks: HarnessBlock[]): Promise<PiContentBlock[]> {
  const parts: PiContentBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(await imagePart(block))
    } else if (block.type === 'tool-result') {
      parts.push(...(await toolResultParts(block.content)))
    }
  }
  return parts
}

function toPiAssistant(message: HarnessMessage, providerId: string): Extract<PiMessage, { role: 'assistant' }> {
  const content: PiAssistantBlock[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        // opencode2dsh #97: DeepSeek's thinking mode rejects a replayed turn
        // whose reasoning_content is missing, so the streamed signature (the
        // wire field the thinking arrived on, events.ts thinking_end) rides
        // back with the block; pi-ai's serializer then writes the thinking
        // under that exact field. Unsigned blocks stay bare — the model's
        // compat flag covers them with an empty reasoning_content.
        content.push({
          type: 'thinking',
          thinking: block.text,
          ...(block.signature !== undefined && block.signature.length > 0 ? { thinkingSignature: block.signature } : {}),
        })
        break
      case 'tool-call':
        content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) })
        break
      case 'image':
        break // assistant images are not replayable; drop rather than fail the stream
      default:
        break
    }
  }
  const source = message.source
  const model = source?.kind === 'model' && typeof source.model === 'string' ? source.model : providerId
  return {
    role: 'assistant',
    content,
    api: apiForModel(model),
    provider: source?.kind === 'model' && typeof source.provider === 'string' ? source.provider : providerId,
    model,
    usage: zeroUsage(),
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

function flattenText(message: HarnessMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('')
}

/**
 * Call id of a message-level tool result (DSH >= 0.2: `role: 'tool'`,
 * `toolCallId` on the message, plain content blocks, `source.callId` as a
 * mirror). Returns undefined for ordinary user/system messages. Only consult
 * `source.callId` when the source is a tool, so model/user provenance can
 * never be mistaken for a tool result.
 */
function messageToolCallId(message: HarnessMessage): string | undefined {
  if (typeof message.toolCallId === 'string' && message.toolCallId.length > 0) return message.toolCallId
  const source = message.source
  if (source?.kind === 'tool' && typeof source.callId === 'string' && source.callId.length > 0) return source.callId
  return undefined
}

/** Emit one pi-ai toolResult, substituting a placeholder for empty output. */
async function pushToolResult(
  messages: PiMessage[],
  toolNames: Map<string, string>,
  toolCallId: string,
  content: HarnessBlock[],
  isError: boolean,
): Promise<void> {
  let rparts = await toolResultParts(content)
  const hasImage = rparts.some((part) => part.type === 'image')
  const hasText = rparts.some((part) => part.type === 'text' && part.text.length > 0)
  if (!hasImage && !hasText) rparts = [{ type: 'text', text: '(no output)' }]
  messages.push({
    role: 'toolResult',
    toolCallId,
    toolName: toolNames.get(toolCallId) ?? 'unknown',
    content: rparts,
    isError,
    timestamp: 0,
  })
}

/**
 * Convert the harness conversation into a pi-ai Context. User and tool-result
 * messages keep text AND image blocks (images load from the harness
 * attachment store); tool results as toolResult messages, assistant history as
 * pi-ai assistant messages. Async because image bytes are read from disk.
 */
export async function toPiContext(options: HarnessGenerateOptions): Promise<PiContext> {
  const providerId = options.provider
  const toolNames = new Map<string, string>()
  const messages: PiMessage[] = []
  // The leading system messages ARE the system prompt (the loop puts it
  // there), and the client sends its prompt in the system role; a system
  // message after the conversation started stays user-side text.
  const systemParts: string[] = []
  if (typeof options.system === 'string' && options.system.length > 0) systemParts.push(options.system)
  let leading = true
  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = flattenText(message)
      if (text.length === 0) continue
      if (leading) systemParts.push(text)
      else messages.push({ role: 'user', content: text, timestamp: 0 })
      continue
    }
    leading = false
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, providerId)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }
    const results = message.content.filter((block) => block.type === 'tool-result') as Array<
      Extract<HarnessBlock, { type: 'tool-result' }>
    >
    if (results.length === 0) {
      // DSH >= 0.2 tool result: call id lives on the message, content is
      // plain text/image blocks. It must land in the toolResult slot only —
      // emitting it as a user message makes the model mistake tool output
      // for user input (and the real toolResult is never sent).
      const toolCallId = messageToolCallId(message)
      if (toolCallId !== undefined) {
        await pushToolResult(messages, toolNames, toolCallId, message.content, message.isError ?? false)
        continue
      }
    }
    const parts = await userParts(message.content)
    if (parts.length > 0 || results.length === 0) {
      const first = parts[0]
      let content: string | PiContentBlock[]
      if (parts.length === 0) content = ''
      else if (parts.length === 1 && first?.type === 'text') content = first.text
      else content = parts
      messages.push({ role: 'user', content, timestamp: 0 })
    }
    for (const result of results) {
      await pushToolResult(messages, toolNames, result.toolCallId, result.content, result.isError ?? false)
    }
  }
  const context: PiContext = { messages }
  if (systemParts.length > 0) context.systemPrompt = [...new Set(systemParts)].join('\n\n')
  const tools = options.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
  if (tools && tools.length > 0) context.tools = tools
  return context
}

/**
 * The anonymous free-lane contract this file enforces
 * (`ensureFreeLaneShape` / `ensureResponsesFreeLaneShape` below):
 *
 *   1. endpoint: chats go to the client's family path `/inference/openai/v1`,
 *      the catalog to the flat `/inference/v1` (the family `/models` 404s),
 *      and `/zen/v1` is the second door on an origin-shaped failure
 *      (adapter/lane.ts `chatApiPath`);
 *   2. session id: one canonical `ses_*` (`ses_` + 12 lowercase hex + 14
 *      Base62) rides all FOUR spellings — `x-opencode-session`,
 *      `x-opencode-session-id`, `x-session-affinity`, `x-session-id` —
 *      `x-opencode-request` is ABSENT, and the 12-hex prefix must decode to a
 *      recent unix_ms (adapter/ids.ts mints it and caches one id per
 *      conversation);
 *   3. project: `x-opencode-project` is prefix-less, the client's own id for
 *      this host's directory (adapter/project.ts); `prj_*` is refused;
 *   4. body: `stream: true`, a NON-EMPTY `tools` array carrying an entry
 *      NAMED `read` (the genuine `shell` + `read` pair is injected,
 *      adapter/gate-tools.ts), and `tool_choice` never `'none'`;
 *   5. system prompt: a non-empty `<env>` block (adapter/env-block.ts),
 *      appended by the shapers below.
 *
 * Status codes: 403 FreeTierError = the SHAPE was rejected. 429
 * FreeUsageLimitError = one of the three gate halves is missing — no `<env>`
 * block, a request not sent through the Bun relay (src/relay/), or a session
 * prefix that does not decode to a recent time — not a spent quota.
 *
 * Not gates: `Bearer public`, `max_tokens`, `temperature`, and the system
 * prompt's content (the client's title-generator prompt must not ride WITH
 * tools — that pair is refused — but any other prompt passes). The UA string
 * is not pinned, only its per-generation SHAPE: 2.x is
 * `opencode/<channel>/<version>/<client>` with no runtime tail.
 *
 * A no-tools request is only accepted with the client's exact title-generator
 * prompt, so the gate tools are always present rather than an empty `tools`
 * array: one recipe, two origins (adapter/lane.ts), never a mixture of
 * generations.
 */
export const GATE_TOOL_ALIASES: Record<string, string> = { shell: 'bash' }

/**
 * Host tool spelling -> the spelling this lane is spoken in.
 *
 * Two reasons, one table:
 *
 *  - the lane REFUSES some names outright. A body carrying `subagent_fork` is
 *    answered `429 FreeUsageLimitError` — the same words, and the same daily
 *    `retry-after`, as a genuinely spent quota — on every exit, on this
 *    machine's own egress and on every free model. Measured 2026-10-31 on one
 *    otherwise identical body: the exact name 429s; `subagent_fork2`,
 *    `subagent_fork_x` and `SUBAGENT_FORK` 429; `subagentfork`, `fork`,
 *    `subagent_two` and `fork_task` answer 200. The refusal follows the NAME
 *    alone — schema, description, tool count and body size were each ruled out
 *    (152 synthetic tools / 35 KB and 40 real schemas / 131 KB both pass).
 *  - every other entry moves a host name onto the OFFICIAL client's vocabulary
 *    where the meaning is the same, so the wire speaks one dialect: `webfetch`,
 *    `question` and `execute` are what the captured 2.2.5 client ships, and a
 *    name it has never sent is one more thing a future refusal can key on.
 *
 * Names with no honest counterpart stay as they are (`web_search` has none —
 * the client's `search` discovers tool signatures, it is not a web search).
 * MCP tools already match the client's own `mcp__<server>__<tool>` form (the
 * binary carries `mcp__puppeteer__*`, `mcp__github__get_*`), so they need no
 * entry.
 *
 * One more refusal shape, and it is a PAIR rule: some names the lane keeps are
 * tolerated once and refused as soon as TWO of them ride the same body.
 * `read_image` and `working_directory` each answer 200 alone and `429
 * FreeUsageLimitError` together, holding body bytes and tool count constant, so
 * neither a name-by-name blocklist nor a size cap describes it. Both move to
 * neutral spellings; the full host tool set then passes, which is what rules
 * out a third member hiding behind them.
 *
 * The model's call is renamed back ({@link TOOL_NAME_ALIASES}), exactly like
 * `shell` -> `bash`: the host never learns the wire spelling.
 */
export const WIRE_TOOL_RENAMES: Record<string, string> = {
  // refused by name: a neutral spelling the lane answers 200 to
  subagent_fork: 'fork_conversation',
  // the same delegation family: a name the lane never sees in a client build is
  // one more thing a refusal can key on, so 0.2.2's second delegation tool ships
  // under a neutral spelling as well (preventive — not yet measured refused)
  subagent_oar: 'oar_agent',
  // refused only in pairs: neutral spellings, because the host name and its
  // natural counterpart (`read`, a bare `cwd`) are names the lane refuses or
  // the client already uses
  read_image: 'image_read',
  working_directory: 'cwd',
  // the official vocabulary, where the two tools mean the same thing
  ask_user_question: 'question',
  web_fetch: 'webfetch',
  workflow: 'execute',
}

/** Wire name -> host name: what the chunk stream applies (events.ts `toolNameAlias`). */
export const TOOL_NAME_ALIASES: Record<string, string> = {
  ...GATE_TOOL_ALIASES,
  ...Object.fromEntries(Object.entries(WIRE_TOOL_RENAMES).map(([host, wire]) => [wire, host])),
}

/** The name of a tool entry in either lane's shape (chat nests it, responses
 *  hoists it). */
function toolEntryName(entry: unknown, flat: boolean): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as { name?: unknown; function?: { name?: unknown } }
  const name = flat ? record.name : record.function?.name
  return typeof name === 'string' ? name : undefined
}

/**
 * Drop a SUPERSEDED 1.x wire name (`bash`) from a copied tool array. The
 * host's own `bash` rides back in through the `shell` alias
 * ({@link GATE_TOOL_ALIASES}), so the wire never mixes a 1.x tool name into
 * the 2.x recipe. Returns the same array reference when nothing matched.
 */
function dropSupersededTools(tools: unknown[], flat: boolean): unknown[] {
  const next = tools.filter((tool) => {
    const name = toolEntryName(tool, flat)
    return name === undefined || !(SUPERSEDED_GATE_TOOL_NAMES as readonly string[]).includes(name)
  })
  return next.length === tools.length ? tools : next
}

/**
 * Host wording that names this harness, rewritten on the wire.
 *
 * The lane does not validate tool text (arbitrary descriptions pass, and the
 * official client's own prompts differ far more than this), so these are for
 * COHERENCE, not to pass a gate: a description is the one place the harness can
 * be named without anything reading it, and the vocabulary should still read as
 * the client's. Only strings that identify this host are listed — general
 * wording is left alone, because the description is what the model reads when it
 * decides how to call the tool.
 */
const WIRE_TEXT_REWRITES: ReadonlyArray<readonly [string, string]> = [
  ['Managed `$DSH_*` variables expose current harness environment facts.', 'Managed environment variables expose current host facts.'],
  ['Create a new local DSH skill in DSH_HOME/skills.', 'Create a new local skill in the agent skills directory.'],
  ['```dsh-ui fence', '```ui fence'],
  ['dsh-go native projection', 'native projection'],
  ['[dsh-ui reply]', '[ui reply]'],
]

/** The description with this host's tells rewritten; undefined when none matched. */
function rewriteToolText(text: string): string | undefined {
  let next = text
  for (const [from, to] of WIRE_TEXT_REWRITES) {
    if (next.includes(from)) next = next.split(from).join(to)
  }
  return next === text ? undefined : next
}

/**
 * Shape a copied tool array in place: rename refused names
 * ({@link WIRE_TOOL_RENAMES}) and rewrite this host's wording
 * ({@link WIRE_TEXT_REWRITES}), keeping each entry's shape. Returns whether
 * anything changed, so the shapers only claim a change they made.
 *
 * A target spelling already present in the array is left alone: two tools under
 * one wire name draw 400 from the lane (measured 2026-10-31), so a host that
 * offers both spellings keeps its own name rather than becoming unroutable.
 */
function shapeWireTools(tools: unknown[], flat: boolean): boolean {
  const taken = new Set<string>()
  for (const entry of tools) {
    const name = toolEntryName(entry, flat)
    if (name !== undefined) taken.add(name)
  }
  let changed = false
  for (let index = 0; index < tools.length; index++) {
    const entry = tools[index]
    const name = toolEntryName(entry, flat)
    const wire = name === undefined ? undefined : WIRE_TOOL_RENAMES[name]
    const rename = wire !== undefined && !taken.has(wire) ? wire : undefined
    const description = toolEntryDescription(entry, flat)
    const text = description === undefined ? undefined : rewriteToolText(description)
    if (rename === undefined && text === undefined) continue
    if (rename !== undefined) taken.add(rename)
    tools[index] = shapeToolEntry(entry, flat, rename, text)
    changed = true
  }
  return changed
}

/** The description of a tool entry in either lane's shape. */
function toolEntryDescription(entry: unknown, flat: boolean): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const record = entry as { description?: unknown; function?: { description?: unknown } }
  const value = flat ? record.description : record.function?.description
  return typeof value === 'string' ? value : undefined
}

/** One tool entry with its name and/or description replaced, in the lane's shape. */
function shapeToolEntry(entry: unknown, flat: boolean, wire?: string, text?: string): unknown {
  if (typeof entry !== 'object' || entry === null) return entry
  if (flat) {
    return {
      ...(entry as Record<string, unknown>),
      ...(wire === undefined ? {} : { name: wire }),
      ...(text === undefined ? {} : { description: text }),
    }
  }
  const record = entry as { function?: Record<string, unknown> }
  if (typeof record.function !== 'object' || record.function === null) return entry
  return {
    ...(entry as Record<string, unknown>),
    function: {
      ...record.function,
      ...(wire === undefined ? {} : { name: wire }),
      ...(text === undefined ? {} : { description: text }),
    },
  }
}

/** `tool_choice` can pin the refused name; keep the pin, move the spelling. */
function renameToolChoice(choice: unknown): unknown {
  if (typeof choice !== 'object' || choice === null) return choice
  const record = choice as { name?: unknown; function?: { name?: unknown } }
  const flatName = typeof record.name === 'string' ? record.name : undefined
  const nestedName = typeof record.function?.name === 'string' ? record.function.name : undefined
  const name = flatName ?? nestedName
  const wire = name === undefined ? undefined : WIRE_TOOL_RENAMES[name]
  if (name === undefined || wire === undefined) return choice
  return flatName !== undefined
    ? { ...record, name: wire }
    : { ...record, function: { ...record.function, name: wire } }
}

/** Text of one message's content: a plain string, or the text parts of an array. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    if (typeof part === 'string') {
      text += part
      continue
    }
    if (typeof part !== 'object' || part === null) continue
    const value = (part as { text?: unknown }).text
    if (typeof value === 'string') text += value
  }
  return text
}

/** Both roles that hold the system prompt: chat sends `system`, newer APIs `developer`. */
function isSystemRole(role: unknown): boolean {
  return role === 'system' || role === 'developer'
}

/** What the two shapers changed, if anything. */
interface EnvShape {
  changed: boolean
  /** The rewritten message list (absent when only `instructions` was shaped). */
  list?: unknown[]
  /** The rewritten `instructions` string (Responses; absent for chat). */
  instructions?: string
}

/**
 * Ensure a message list's system slot carries a non-empty `<env>` block
 * (env-block.ts has the probe matrix that makes this a requirement).
 *
 * The block is APPENDED, never substituted: the harness' own system prompt
 * (identity, skills, tool policy) must reach the model unchanged, and the gate
 * only reads the block's presence. A list with no system entry gets one
 * inserted at index 0 — a body whose whole system prompt is the block is one
 * of the shapes measured 200, so a toolless/plain call is still legal.
 *
 * `partType` is the text part spelling of the surface being shaped: chat uses
 * `text`, the Responses input array uses `input_text`.
 */
function shapeEnvMessages(list: unknown[], partType: 'text' | 'input_text' = 'text', facts?: EnvFacts): EnvShape {
  let index = -1
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i]
    if (typeof entry !== 'object' || entry === null) continue
    if (!isSystemRole((entry as { role?: unknown }).role)) continue
    index = i
    break
  }
  if (index === -1) {
    return { changed: true, list: [{ role: 'system', content: renderEnvSection(facts) }, ...list] }
  }
  const entry = list[index] as Record<string, unknown>
  const content = entry.content
  if (hasEnvBlock(contentText(content))) return { changed: false, list }
  const next = [...list]
  if (Array.isArray(content)) {
    next[index] = { ...entry, content: [...content, { type: partType, text: renderEnvSection(facts) }] }
  } else {
    next[index] = { ...entry, content: withEnvBlock(typeof content === 'string' ? content : '', facts) }
  }
  return { changed: true, list: next }
}

/** The same rule for a Responses `instructions` string. */
function shapeEnvInstructions(instructions: string, facts?: EnvFacts): EnvShape {
  if (hasEnvBlock(instructions)) return { changed: false, instructions }
  return { changed: true, instructions: withEnvBlock(instructions, facts) }
}

/** Responses uses flat function tools and its Zen gateway accepts auto only. */
export function ensureResponsesFreeLaneShape(payload: unknown): unknown | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  if (!Array.isArray(body.input)) return undefined
  const original = Array.isArray(body.tools) ? (body.tools as unknown[]) : []
  const dropped = dropSupersededTools(original, true)
  const tools = [...dropped]
  let changed = dropped !== original
  if (shapeWireTools(tools, true)) changed = true
  for (const name of FREE_LANE_GATE_TOOL_NAMES) {
    const index = tools.findIndex((tool) => toolEntryName(tool, true) === name)
    if (index === -1) {
      tools.push(freeLaneGateFlatTool(name))
      changed = true
    } else if (!isGenuineFlatGateTool(name, tools[index])) {
      tools[index] = freeLaneGateFlatTool(name)
      changed = true
    }
  }
  // The `<env>` half of the gate (env-block.ts): the quota layer rejects a body
  // whose system prompt has no environment block, and Responses carries that
  // prompt either in `instructions` or as a system-role entry of `input`.
  const instructions = typeof body.instructions === 'string' ? body.instructions : undefined
  const env = instructions !== undefined && instructions !== ''
    ? shapeEnvInstructions(instructions)
    : shapeEnvMessages(body.input as unknown[], 'input_text')
  const invalidChoice = body.tool_choice !== undefined && body.tool_choice !== 'auto'
  if (!changed && !invalidChoice && !env.changed) return undefined
  return {
    ...body,
    ...(env.list !== undefined ? { input: env.list } : {}),
    ...(env.changed && typeof env.instructions === 'string' ? { instructions: env.instructions } : {}),
    tools,
    tool_choice: 'auto',
  }
}

/** The client's chat-completions body keys, in its order. */
const CLIENT_CHAT_KEY_ORDER = ['model', 'messages', 'tools', 'stream', 'stream_options', 'max_completion_tokens'] as const

/**
 * The same body with the client's key order: its six keys first, every other
 * key after them in its original order. Values are untouched.
 */
export function inClientKeyOrder(body: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {}
  for (const key of CLIENT_CHAT_KEY_ORDER) if (key in body) ordered[key] = body[key]
  for (const [key, value] of Object.entries(body)) if (!(key in ordered)) ordered[key] = value
  return ordered
}

/**
 * Rewrite an outgoing chat-completions payload so it satisfies the free-lane
 * gate (wired through pi-ai's onPayload).
 *
 * The gate tools must be the GENUINE definitions, so an entry that already
 * carries a gate name is REPLACED unless it is already genuine: the host's own
 * `read` (DSH names it exactly that) would otherwise ride out with the host's
 * schema, and the host's `bash` would put a superseded 1.x name on a 2.x wire
 * — `bash` is DROPPED and its role is taken by the injected `shell`, which the
 * harness chunk stream renames back to `bash` (GATE_TOOL_ALIASES) and whose
 * arguments are bridged to the host's declared shape on the way in (gate-tools.ts
 * `gateToolArgumentBridge`). Missing gate tools are appended, a
 * `tool_choice: 'none'` is dropped (the gate rejects it), and the function
 * returns undefined when nothing had to change — pi-ai then keeps the
 * original payload untouched.
 */
export function ensureFreeLaneShape(payload: unknown): unknown | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const body = payload as Record<string, unknown>
  if (!Array.isArray(body.messages)) return undefined
  const original = Array.isArray(body.tools) ? (body.tools as unknown[]) : []
  const dropped = dropSupersededTools(original, false)
  const tools = [...dropped]
  let changed = dropped !== original
  if (shapeWireTools(tools, false)) changed = true
  for (const name of FREE_LANE_GATE_TOOL_NAMES) {
    const index = tools.findIndex((tool) => toolEntryName(tool, false) === name)
    if (index === -1) {
      tools.push(freeLaneGateTool(name))
      changed = true
    } else if (!isGenuineGateTool(name, tools[index])) {
      tools[index] = freeLaneGateTool(name)
      changed = true
    }
  }
  const dropsNone = body.tool_choice === 'none'
  // The `<env>` half of the gate (env-block.ts): a body whose system prompt has
  // no environment block is answered 429 FreeUsageLimitError, indistinguishable
  // from "quota spent".
  const env = shapeEnvMessages(body.messages as unknown[], 'text')
  if (!changed && !dropsNone && !env.changed) return undefined
  const next: Record<string, unknown> = { ...body, tools }
  if (env.list !== undefined) next.messages = env.list
  if (dropsNone) delete next.tool_choice
  else if (body.tool_choice !== undefined) next.tool_choice = renameToolChoice(body.tool_choice)
  return next
}
