import { _ as setRequestHeadersReader, f as conversationLabel, g as opencodeUserAgent, m as disguiseHeaders, n as ModelCatalog, o as defaultCachePath, p as deriveRequestIDs, r as ZEN_BASE_URL, v as setUserAgentOverride, y as zenRequestHeaders } from "./catalog.js";
import { a as freeLaneGateFlatTool, c as isGenuineFlatGateTool, i as FREE_LANE_GATE_TOOL_NAMES, l as isGenuineGateTool, n as normalizeSmokeContents, o as freeLaneGateTool, s as gateToolArgumentBridge, t as DEFAULT_SMOKE_CONTENT } from "./smoke-content.js";
import { c as LOCAL_EXIT_ID, d as emptyTotals, f as setUsageRecorder, l as UsageTracker, o as routingContext, p as usageTracker, s as DIRECT_EXIT_ID, t as DEFAULT_PROXY_PATH_PREFIXES, u as attributeUsage } from "./dispatcher.js";
import { c as shouldRotate, i as classifyStreamFailure, n as DEFAULT_SUBSCRIPTION_USER_AGENT, o as isRegionBlocked, t as stateDir } from "./paths.js";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createProvider } from "@earendil-works/pi-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as openaiResponses from "@earendil-works/pi-ai/api/openai-responses";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { platform } from "node:process";
import Schema from "@deepseek-ai/schemastery";

//#region src/adapter/events.ts
const CONTEXT_WINDOW_EXCEEDED = "CONTEXT_WINDOW_EXCEEDED";
const EMPTY_RESPONSE = "EMPTY_RESPONSE";
const QUOTA_EXCEEDED = "QUOTA_EXCEEDED";
function classifyError(text) {
	if (/\bRegionError\b|not available in your country/i.test(text)) return "REGION_BLOCKED";
	if (/\b(?:401|403)\b/.test(text)) return "AUTH";
	if (/insufficient|quota|billing/i.test(text)) return QUOTA_EXCEEDED;
	if (/\b429\b|rate.?limit/i.test(text)) return "RATE_LIMIT";
	if (/\b413\b|payload too large|request body too large/i.test(text)) return "INVALID_REQUEST";
	if (/\b400\b|invalid.?request/i.test(text)) return "INVALID_REQUEST";
	if (/\b5\d\d\b/.test(text)) return "SERVER";
	if (/\btime(?:d)?\s*out\b|timeout/i.test(text)) return "TIMEOUT";
	if (/stream ended (?:before|without)\b/i.test(text)) return "TRANSPORT";
	if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|terminated|premature close/i.test(text)) return "TRANSPORT";
	return "UPSTREAM";
}
function isContextOverflow(message, contextWindow) {
	return message.stopReason === "stop" && message.usage.input > contextWindow;
}
/** mapStopReason (dsh-llm-pi-ai index.js:1286-1330). */
function mapStopReason(message, contextWindow) {
	if (isContextOverflow(message, contextWindow) || message.stopReason === "error" && message.errorMessage !== void 0 && /context/i.test(message.errorMessage) && /exceed|window|length|token/i.test(message.errorMessage)) return {
		kind: "error",
		failure: {
			message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
			code: CONTEXT_WINDOW_EXCEEDED
		}
	};
	switch (message.stopReason) {
		case "stop":
			if (message.content.length === 0) return {
				kind: "error",
				failure: {
					message: `model "${message.model}" returned a completed response with no content`,
					code: EMPTY_RESPONSE
				}
			};
			return { kind: "stop" };
		case "length": return { kind: "max-tokens" };
		case "toolUse": return { kind: "tool-calls" };
		case "aborted": return {
			kind: "aborted",
			failure: {
				message: message.errorMessage ?? "pi-ai stream aborted",
				code: "ABORTED"
			}
		};
		case "error": return {
			kind: "error",
			failure: {
				message: message.errorMessage ?? "pi-ai stream error",
				code: classifyError(message.errorMessage ?? "")
			}
		};
	}
}
function mapUsage(usage) {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
		...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}
	};
}
/**
* Translate one pi-ai event stream into harness chunks. pi-ai never throws
* mid-stream: failures arrive as `error` events and become error/aborted
* finish chunks.
*/
async function* toStreamChunks(events, contextWindow, toolNameAlias, toolArgumentBridge) {
	const toolIds = /* @__PURE__ */ new Map();
	const mapName = (name$1) => toolNameAlias?.[name$1] ?? name$1;
	/** Raw argument fragments of a bridged call, held back until its end. */
	const withheld = /* @__PURE__ */ new Map();
	for await (const event of events) switch (event.type) {
		case "start": break;
		case "text_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "text"
			};
			break;
		case "text_delta":
			yield {
				type: "text-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "text_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "text",
					text: event.content
				}
			};
			break;
		case "thinking_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "reasoning"
			};
			break;
		case "thinking_delta":
			yield {
				type: "reasoning-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "thinking_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "reasoning",
					text: event.content
				}
			};
			break;
		case "toolcall_start": {
			const partial = event.partial.content[event.contentIndex];
			const id = partial?.type === "toolCall" ? partial.id ?? "" : "";
			const name$1 = partial?.type === "toolCall" ? mapName(partial.name ?? "") : "";
			toolIds.set(event.contentIndex, {
				id,
				name: name$1
			});
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "tool-call"
			};
			break;
		}
		case "toolcall_delta": {
			const known = toolIds.get(event.contentIndex);
			if (toolArgumentBridge?.names.has(known?.name ?? "")) {
				const parts = withheld.get(event.contentIndex) ?? [];
				parts.push(event.delta);
				withheld.set(event.contentIndex, parts);
				break;
			}
			yield {
				type: "tool-call-delta",
				index: event.contentIndex,
				id: known?.id ?? "",
				...known?.name !== void 0 && known.name.length > 0 ? { name: known.name } : {},
				argumentsDelta: event.delta
			};
			break;
		}
		case "toolcall_end": {
			const name$1 = mapName(event.toolCall.name);
			const rewritten = toolArgumentBridge?.rewrite(name$1, event.toolCall.arguments);
			const argumentsJson = JSON.stringify(rewritten ?? event.toolCall.arguments);
			const parts = withheld.get(event.contentIndex);
			if (parts !== void 0) {
				withheld.delete(event.contentIndex);
				if (rewritten !== void 0) yield {
					type: "tool-call-delta",
					index: event.contentIndex,
					id: event.toolCall.id,
					...name$1.length > 0 ? { name: name$1 } : {},
					argumentsDelta: argumentsJson
				};
				else for (const delta of parts) yield {
					type: "tool-call-delta",
					index: event.contentIndex,
					id: event.toolCall.id,
					...name$1.length > 0 ? { name: name$1 } : {},
					argumentsDelta: delta
				};
			}
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "tool-call",
					id: event.toolCall.id,
					name: name$1,
					arguments: argumentsJson
				}
			};
			break;
		}
		case "done":
			yield {
				type: "usage",
				usage: mapUsage(event.message.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.message, contextWindow)
			};
			return;
		case "error":
			yield {
				type: "usage",
				usage: mapUsage(event.error.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.error, contextWindow)
			};
			return;
	}
	throw new Error("opencode2dsh: pi-ai event stream ended without done/error");
}

//#endregion
//#region src/adapter/routing.ts
const RESPONSES_ONLY_PREFIX = "muse-spark";
function isResponsesModel(id) {
	return String(id ?? "").toLowerCase().startsWith(RESPONSES_ONLY_PREFIX);
}
function apiForModel(id) {
	return isResponsesModel(id) ? "openai-responses" : "openai-completions";
}

//#endregion
//#region src/adapter/messages.ts
function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
function parseArguments(raw) {
	if (typeof raw !== "string" || raw.length === 0) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
	} catch {
		return { raw };
	}
}
/**
* Harness attachment root (mirrors dsh-attachment-local's resolveDshHome).
* DSH_HOME is always set by the harness child; the homedir fallback covers
* direct invocation (tests, tooling).
*/
function dshHome() {
	const configured = process.env.DSH_HOME?.trim();
	if (configured) return configured;
	return join(homedir(), ".dsh");
}
/**
* Convert one harness image block to pi-ai ImageContent by reading the
* content-addressed normalized object (DSH_HOME/attachments/v1/objects/<2>/<sha>).
* Falls back to stable text on any failure so a missing object can never
* fail the whole stream.
*/
async function toPiImage(ref) {
	const attachment = ref ?? {};
	const id = typeof attachment.attachmentId === "string" ? attachment.attachmentId : "";
	const sha = id.startsWith("sha256:") ? id.slice(7) : id;
	if (!/^[0-9a-f]{64}$/.test(sha)) return {
		type: "text",
		text: `[image omitted: unreadable attachment reference ${JSON.stringify(id)}]`
	};
	const path = join(dshHome(), "attachments", "v1", "objects", sha.slice(0, 2), sha);
	try {
		return {
			type: "image",
			data: (await readFile(path)).toString("base64"),
			mimeType: typeof attachment.mediaType === "string" && attachment.mediaType.length > 0 ? attachment.mediaType : "image/png"
		};
	} catch {
		return {
			type: "text",
			text: `[image omitted: failed to read normalized attachment ${JSON.stringify(id)}]`
		};
	}
}
/**
* Host-budget-offloaded images were routed out of the request by dsh-llm on
* purpose (`offloaded: true`); re-reading their bytes from disk would defy the
* image budget the host already enforced. Emit a stable placeholder instead —
* the same semantics as the host adapter's projectOffloadedImages.
*/
function offloadedImagePart(ref) {
	const id = ref?.attachmentId;
	return {
		type: "text",
		text: `[image omitted: offloaded to fit the request image budget${typeof id === "string" && id.length > 0 ? ` ${id.slice(0, 30)}` : ""}]`
	};
}
/** One image block, respecting the host's offload flag. */
async function imagePart(block) {
	return block.offloaded === true ? offloadedImagePart(block.attachment) : toPiImage(block.attachment);
}
/** Text/image parts of one user message's content, in block order. */
async function userParts(blocks) {
	const parts = [];
	for (const block of blocks) if (block.type === "text") {
		if (block.text.length > 0) parts.push({
			type: "text",
			text: block.text
		});
	} else if (block.type === "image") parts.push(await imagePart(block));
	return parts;
}
/** Text/image parts of one tool result's content, walking nested results. */
async function toolResultParts(blocks) {
	const parts = [];
	for (const block of blocks) if (block.type === "text") parts.push({
		type: "text",
		text: block.text
	});
	else if (block.type === "image") parts.push(await imagePart(block));
	else if (block.type === "tool-result") parts.push(...await toolResultParts(block.content));
	return parts;
}
function toPiAssistant(message, providerId) {
	const content = [];
	for (const block of message.content) switch (block.type) {
		case "text":
			content.push({
				type: "text",
				text: block.text
			});
			break;
		case "reasoning":
			content.push({
				type: "thinking",
				thinking: block.text
			});
			break;
		case "tool-call":
			content.push({
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: parseArguments(block.arguments)
			});
			break;
		case "image": break;
		default: break;
	}
	const source = message.source;
	const model = source?.kind === "model" && typeof source.model === "string" ? source.model : providerId;
	return {
		role: "assistant",
		content,
		api: apiForModel(model),
		provider: source?.kind === "model" && typeof source.provider === "string" ? source.provider : providerId,
		model,
		usage: zeroUsage(),
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 0
	};
}
function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/**
* Call id of a message-level tool result (DSH >= 0.2: `role: 'tool'`,
* `toolCallId` on the message, plain content blocks, `source.callId` as a
* mirror). Returns undefined for ordinary user/system messages. Only consult
* `source.callId` when the source is a tool, so model/user provenance can
* never be mistaken for a tool result.
*/
function messageToolCallId(message) {
	if (typeof message.toolCallId === "string" && message.toolCallId.length > 0) return message.toolCallId;
	const source = message.source;
	if (source?.kind === "tool" && typeof source.callId === "string" && source.callId.length > 0) return source.callId;
}
/** Emit one pi-ai toolResult, substituting a placeholder for empty output. */
async function pushToolResult(messages, toolNames, toolCallId, content, isError) {
	let rparts = await toolResultParts(content);
	const hasImage = rparts.some((part) => part.type === "image");
	const hasText = rparts.some((part) => part.type === "text" && part.text.length > 0);
	if (!hasImage && !hasText) rparts = [{
		type: "text",
		text: "(no output)"
	}];
	messages.push({
		role: "toolResult",
		toolCallId,
		toolName: toolNames.get(toolCallId) ?? "unknown",
		content: rparts,
		isError,
		timestamp: 0
	});
}
/**
* Convert the harness conversation into a pi-ai Context. User and tool-result
* messages keep text AND image blocks (images load from the harness
* attachment store); tool results as toolResult messages, assistant history as
* pi-ai assistant messages. Async because image bytes are read from disk.
*/
async function toPiContext(options) {
	const providerId = options.provider;
	const toolNames = /* @__PURE__ */ new Map();
	const messages = [];
	for (const message of options.messages) {
		if (message.role === "system") {
			const text = flattenText(message);
			if (text.length > 0) messages.push({
				role: "user",
				content: text,
				timestamp: 0
			});
			continue;
		}
		if (message.role === "assistant") {
			const assistant = toPiAssistant(message, providerId);
			for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(block.id, block.name);
			messages.push(assistant);
			continue;
		}
		const results = message.content.filter((block) => block.type === "tool-result");
		if (results.length === 0) {
			const toolCallId = messageToolCallId(message);
			if (toolCallId !== void 0) {
				await pushToolResult(messages, toolNames, toolCallId, message.content, message.isError ?? false);
				continue;
			}
		}
		const parts = await userParts(message.content);
		if (parts.length > 0 || results.length === 0) {
			const first = parts[0];
			let content;
			if (parts.length === 0) content = "";
			else if (parts.length === 1 && first?.type === "text") content = first.text;
			else content = parts;
			messages.push({
				role: "user",
				content,
				timestamp: 0
			});
		}
		for (const result of results) await pushToolResult(messages, toolNames, result.toolCallId, result.content, result.isError ?? false);
	}
	const context = { messages };
	if (typeof options.system === "string" && options.system.length > 0) context.systemPrompt = options.system;
	const tools = options.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
	if (tools && tools.length > 0) context.tools = tools;
	return context;
}
/**
* The anonymous free-lane gate, as re-probed on 2026-10-14 against
* `POST https://opencode.ai/inference/v1/chat/completions` — the lane moved
* there the same day (adapter/catalog.ts `ZEN_BASE_URL`). A chat request
* answers 200 only when ALL of these hold:
*
*   1. the endpoint is `/inference/v1`: the old `/zen/v1` now answers 403
*      FreeTierError for EVERY shape, including a byte-copy of the client's
*      own request. `/zen/v1/models` alone still answers 200, which is why
*      the catalog and the settings card's `/status` stayed green while every
*      chat died;
*   2. a canonical `ses_*` id rides `x-opencode-session` (or
*      `x-opencode-session-id`) — and NOT `x-session-affinity` /
*      `X-Session-Id`, which the client sends only for its other providers and
*      which now mark a foreign client (adapter/ids.ts). The id's 12-hex
*      prefix must be the client's DESCENDING word with its 12-bit counter in
*      0-63: live-probed 2026-10-15, counters 0/1/32/63 -> 200, 64/128 -> 403,
*      the timestamp half unchecked, so a clock-minted counter 403s everything
*      minted after the 64th (the prefix is now digest-derived, counter 1);
*   3. `x-opencode-request` is a `msg_*` message id and `x-opencode-project`
*      is the prefix-less project id (`global`, or a 40-hex worktree hash) —
*      `req_*` and `prj_*` each 403 on their own (adapter/ids.ts); the request
*      header is optional (the 2.x client omits it) and its word is never
*      decoded by the gate, while the project header is required;
*   4. a streaming body (`stream: true`);
*   5. a `tools` array carrying `bash` AND `read` with the GENUINE definitions
*      (adapter/gate-tools.ts — the placeholder stubs this file used to inject
*      are now themselves a rejection signal), while extra tools are ignored;
*   6. `tool_choice` is never `'none'` (403; omitted and `'auto'` both pass).
*
* NOT gates, measured live: `Bearer public`, `max_tokens`, `temperature`, and
* the system prompt's content (the client's title prompt must not ride WITH
* tools — that pair 403s — but any other prompt passes). The UA string is not
* pinned either, but its SHAPE is per generation: a 1.x string carries the
* platform/parenthetical runtime tail (`opencode/1.18.31 (darwin arm64;
* node24.21.0)` passed while a bare `opencode/1.19.0` failed, 2026-10-14),
* whereas the 2.x shape `opencode/<channel>/<version>/<client>` is complete
* without any tail — `opencode/latest/2.0.32/cli` and `.../desktop` each
* answered 200 with this adapter's v1 body (2026-10-17).
*
* The two shapes are mutually exclusive at the edges: a no-tools request is
* only accepted with the client's exact title-generator prompt, which is why
* this adapter always ensures the gate tools are present rather than ever
* sending an empty `tools` array.
*/
const GATE_TOOL_ALIASES = {};
/** The name of a tool entry in either lane's shape (chat nests it, responses
*  hoists it). */
function toolEntryName(entry, flat) {
	if (typeof entry !== "object" || entry === null) return void 0;
	const record = entry;
	const name$1 = flat ? record.name : record.function?.name;
	return typeof name$1 === "string" ? name$1 : void 0;
}
/** Responses uses flat function tools and its Zen gateway accepts auto only. */
function ensureResponsesFreeLaneShape(payload) {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return void 0;
	const body = payload;
	if (!Array.isArray(body.input)) return void 0;
	const tools = Array.isArray(body.tools) ? [...body.tools] : [];
	let changed = false;
	for (const name$1 of FREE_LANE_GATE_TOOL_NAMES) {
		const index = tools.findIndex((tool) => toolEntryName(tool, true) === name$1);
		if (index === -1) {
			tools.push(freeLaneGateFlatTool(name$1));
			changed = true;
		} else if (!isGenuineFlatGateTool(name$1, tools[index])) {
			tools[index] = freeLaneGateFlatTool(name$1);
			changed = true;
		}
	}
	const invalidChoice = body.tool_choice !== void 0 && body.tool_choice !== "auto";
	if (!changed && !invalidChoice) return void 0;
	return {
		...body,
		tools,
		tool_choice: "auto"
	};
}
/**
* Rewrite an outgoing chat-completions payload so it satisfies the free-lane
* gate (wired through pi-ai's onPayload).
*
* The gate tools must be the GENUINE definitions, so an entry that already
* carries a gate name is REPLACED unless it is already genuine: the host's own
* `bash`/`read` (DSH's are named exactly that) would otherwise ride out with
* the host's schema and draw a 403. The adapter bridges the call's arguments
* back to the host's shape on the way in (gate-tools.ts
* `gateToolArgumentBridge`). Missing gate tools are appended, a
* `tool_choice: 'none'` is dropped (the gate rejects it), and the function
* returns undefined when nothing had to change — pi-ai then keeps the
* original payload untouched.
*/
function ensureFreeLaneShape(payload) {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return void 0;
	const body = payload;
	if (!Array.isArray(body.messages)) return void 0;
	const tools = Array.isArray(body.tools) ? [...body.tools] : [];
	let changed = false;
	for (const name$1 of FREE_LANE_GATE_TOOL_NAMES) {
		const index = tools.findIndex((tool) => toolEntryName(tool, false) === name$1);
		if (index === -1) {
			tools.push(freeLaneGateTool(name$1));
			changed = true;
		} else if (!isGenuineGateTool(name$1, tools[index])) {
			tools[index] = freeLaneGateTool(name$1);
			changed = true;
		}
	}
	const dropsNone = body.tool_choice === "none";
	if (!changed && !dropsNone) return void 0;
	const next = {
		...body,
		tools
	};
	if (dropsNone) delete next.tool_choice;
	return next;
}

//#endregion
//#region src/adapter/zen-adapter.ts
/**
* The TS adapter: registers as a DSH LlmAdapter for the `oc2dsh` route
* and streams directly from the OpenCode Zen anonymous lane. The wire layer is
* pi-ai's openai-completions implementation for most models (the same one DSH
* uses for every OpenAI-compatible provider), plus pi-ai's openai-responses
* for Responses-only models (muse-spark-*); this module adds the CLI disguise
* headers, the derived session/request ids, and the free-model catalog.
*
* Adapter contract: dsh-llm LlmAdapter (providerInfo/listModels/resolveModel/
* prepareCall/stream) — structural, no host import.
*/
const PROVIDER_ID = "oc2dsh";
/**
* The provider's DISPLAY name — the model picker's group label. Deliberately
* separate from the route id above: the id keys llm-pi-ai settings, adapter
* registration and the request header, and renaming it would split every
* existing session's model selection; the label is free to move.
*/
const PROVIDER_NAME = "OpenCode-Zen-Free";
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;
/** The advertised context window: the models.dev declaration when the
* metadata speaks, the host default otherwise (pending/absent metadata or a
* model that declares no `limit.context`). */
function contextWindowFor(limits) {
	const declared = limits?.contextWindow;
	return typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_CONTEXT_WINDOW;
}
/**
* Use the declared output budget, including models that can answer beyond
* 32768 tokens. Keep the fallback when metadata cannot provide a valid cap.
*/
function defaultMaxTokensFor(limits) {
	const declared = limits?.maxOutput;
	return typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0 ? declared : DEFAULT_MAX_TOKENS;
}
/**
* Reasoning-effort vocabulary the adapter owns end to end (dsh-llm treats the
* ids as opaque: whatever resolveModel advertises comes back on
* GenerateOptions.reasoningEffort). The ladder mirrors pi-ai's ThinkingLevel
* so selected levels pass through untouched; `off` is the only id that maps
* to a different wire spelling.
*/
const REASONING_EFFORT_LADDER = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Levels offered for reasoning models whose metadata declares no ladder. */
const DEFAULT_EFFORT_LADDER = [
	"off",
	"minimal",
	"low",
	"medium",
	"high"
];
/**
* Turn the catalog's models.dev capability into the advertised effort list.
* A declared ladder (models.dev `reasoning_options` effort values) wins — its
* values are the upstream-honored spellings, with metadata `none` folded into
* our `off`. Without a declaration, a reasoning model gets the standard
* ladder the Zen gateway accepts for every model. Non-reasoning models
* advertise nothing (the picker then offers only the provider default).
*/
function reasoningEfforts(capability) {
	if (!capability?.reasoning) return void 0;
	const declared = [];
	for (const value of capability.effortValues) {
		const level = value === "none" ? "off" : value;
		if (REASONING_EFFORT_LADDER.includes(level) && !declared.includes(level)) declared.push(level);
	}
	return (declared.length > 0 ? declared.sort((a, b) => REASONING_EFFORT_LADDER.indexOf(a) - REASONING_EFFORT_LADDER.indexOf(b)) : DEFAULT_EFFORT_LADDER).map((level) => ({
		id: level,
		name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`
	}));
}
/**
* The `reasoning_effort` wire value for a selected effort id. The Zen gateway
* validates the field against `minimal|low|medium|high|xhigh|max|none`
* (live-probed 2026-09-18: any other value is a hard 400), and `none` is the
* only spelling that stops the always-think free models from thinking — a
* mere omission keeps the provider default. So `off` maps to wire `none`,
* ladder levels pass through verbatim, and unknown ids (never advertised)
* inject nothing rather than risk the 400.
*/
function reasoningEffortWire(id) {
	if (id === void 0) return void 0;
	if (id === "off") return "none";
	return REASONING_EFFORT_LADDER.includes(id) ? id : void 0;
}
/** Anonymous credential: the literal upstream accepts for the free lane. */
const ANONYMOUS_KEY = "public";
/**
* Retry policy the host (dsh-llm-retry) runs for this provider. Resolved
* shape is FLAT (backoff fields at top level — see ResolvedNormalRetryPolicy,
* dsh-llm index.js:1867 consumes the adapter value verbatim). Retryable codes
* mirror the host default set so behavior differs only in patience, not in
* which failures qualify. Every transport cut the adapter can name rides this
* window — including pi-ai's "Stream ended without finish_reason" truncation
* sentinel, which adapter/events.ts classifyError maps to TRANSPORT precisely
* so a mid-stream cut cannot escape the retry budget. Cumulative worst case
* per step:
* 1+2+4+8+16+20+20+20 ≈ 91s of silent retries before the error surfaces.
*/
const FREE_LANE_RETRY_POLICY = Object.freeze({
	mode: "normal",
	maxRetries: 8,
	retryableCodes: Object.freeze([
		"EMPTY_RESPONSE",
		"RATE_LIMIT",
		"SERVER",
		"TIMEOUT",
		"TRANSPORT"
	]),
	initialDelayMs: 1e3,
	maxDelayMs: 2e4,
	jitterRatio: .2
});
/**
* Stream-liveness watchdogs (live-observed 2026-09-07): neither fetch nor
* pi-ai owns a body-silence timeout, so a tunnel that stands but never
* streams hangs the turn forever (70 minutes observed). Both messages
* carry "timeout" so classifyStreamFailure maps them to 'transport' and
* the rotate loop gets to move the session to a live exit.
*/
const WATCHDOG_FIRST_MESSAGE = "oc2dsh: first stream event timeout (exit silent before any response)";
const WATCHDOG_IDLE_MESSAGE = "oc2dsh: stream body idle timeout (exit went silent mid-response)";
/** Default watchdog windows (docs/ip-pool.md; test-injectable via constructor). */
const DEFAULT_FIRST_EVENT_MS = 3e4;
const DEFAULT_BODY_IDLE_MS = 12e4;
/**
* Body-idle window for Responses models (muse-spark-*, issue #7): their
* chain-of-thought streams pace in bursts with long mid-stream pauses, so
* the chat default misreads slow reasoning as a dead tunnel. Named and
* constructor-injectable so tests can exercise the wider window without
* waiting out five real minutes.
*/
const RESPONSES_BODY_IDLE_MS = 3e5;
/** The terminal error event pi-ai owes but never sent (watchdog teardown). */
function terminalErrorEvent(errorMessage, model) {
	return {
		type: "error",
		error: {
			api: model.api ?? "openai-completions",
			provider: PROVIDER_ID,
			model: model.id,
			content: [],
			stopReason: "error",
			errorMessage,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0
			}
		}
	};
}
/**
* Responses-only models (issue #7): `muse-spark-*` return a bare 500 on
* `POST /inference/v1/chat/completions` but 200 on
* `POST /inference/v1/responses` (opencode #44659/#44847, DSH #3957). Route by
* model id; extend this list if the lane moves more models (candidates:
* gpt-5.6-luna, grok-4.6).
*
* The gate covers BOTH surfaces: since 2026-10-14 the chat lane validates the
* request's content (adapter/gate-tools.ts, adapter/messages.ts) and the whole
* lane lives at `/inference/v1` — the old `/zen/v1` answers 403 for every
* shape, so it is no longer "the lane of record" for anything.
*/
/**
* Vision gate: whether a model accepts image input on the Zen lane.
*
* models.dev `modalities.input` decides whenever it speaks — the same
* declaration that already drives `limit.context` / `limit.output` lists the
* input kinds each model takes, and the free roster rotates constantly, so a
* family-scoped pattern cannot track it: space-bunny-free,
* muse-spark-1.*-contributor-free, mimo-v2.5-free, fledge-alpha-free and
* longcat-2.5-preview-free all declare `image` upstream and are refused today
* with `Model "<id>" does not support image input.` A declared text-only model
* stays refused, so the gate still protects the lane in both directions.
*
* The built-in pattern remains the fallback for the ids whose image input was
* live-verified end-to-end on 2026-09-28 (the mimo-v2.6 family), so metadata
* being pending, absent or silent never changes what those models can do.
* Models that end up text-only make DSH's attachment gates and pi-ai's image
* downgrade refuse image parts instead of forwarding them to a model that
* cannot see them.
*/
function isVisionModel(id, declaredModalities) {
	if (Array.isArray(declaredModalities) && declaredModalities.length > 0) return declaredModalities.includes("image");
	return /^mimo-v2\.6/i.test(String(id ?? ""));
}
function toPiModel(id, reasoning, limits, declaredModalities) {
	return {
		id,
		name: id,
		api: apiForModel(id),
		provider: PROVIDER_ID,
		baseUrl: `${ZEN_BASE_URL.replace(/\/+$/, "")}/v1`,
		reasoning,
		input: isVisionModel(id, declaredModalities) ? ["text", "image"] : ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: contextWindowFor(limits),
		maxTokens: defaultMaxTokensFor(limits)
	};
}
function normalizeResponsesEffort(value) {
	if (!value || value === "off" || value === "none") return void 0;
	return REASONING_EFFORT_LADDER.includes(value) ? value : void 0;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Normalize pi-ai's mixed reasoning shapes before a Responses request. */
function normalizeResponsesPayload(payload, requestedEffort) {
	const shaped = ensureFreeLaneShape(payload);
	const base = shaped ?? payload;
	if (!isRecord(base)) return shaped;
	const next = { ...base };
	const legacyEffort = typeof next.reasoning_effort === "string" ? next.reasoning_effort : void 0;
	delete next.reasoning_effort;
	const reasoning = isRecord(next.reasoning) ? { ...next.reasoning } : {};
	const existingEffort = normalizeResponsesEffort(typeof reasoning.effort === "string" ? reasoning.effort : void 0);
	const effort = normalizeResponsesEffort(requestedEffort) ?? existingEffort ?? normalizeResponsesEffort(legacyEffort);
	if (effort) reasoning.effort = effort;
	else delete reasoning.effort;
	if (Object.keys(reasoning).length > 0) next.reasoning = reasoning;
	else delete next.reasoning;
	return next;
}
var ZenAdapter = class {
	#catalog;
	#provider;
	#responsesProvider;
	#firstEventMs;
	#bodyIdleMs;
	#responsesBodyIdleMs;
	constructor(catalog, options = {}) {
		this.#catalog = catalog;
		this.#firstEventMs = options.firstEventMs ?? DEFAULT_FIRST_EVENT_MS;
		this.#bodyIdleMs = options.bodyIdleMs ?? DEFAULT_BODY_IDLE_MS;
		this.#responsesBodyIdleMs = options.responsesBodyIdleMs ?? RESPONSES_BODY_IDLE_MS;
		if (options.providerOverride !== void 0) {
			this.#provider = options.providerOverride;
			this.#responsesProvider = null;
			return;
		}
		const baseUrl = `${(options.zenBaseUrl ?? ZEN_BASE_URL).replace(/\/+$/, "")}/v1`;
		const auth = { apiKey: {
			name: "OpenCode Zen anonymous lane",
			resolve: async () => ({ auth: { apiKey: ANONYMOUS_KEY } })
		} };
		this.#provider = createProvider({
			id: PROVIDER_ID,
			name: PROVIDER_NAME,
			baseUrl,
			auth,
			models: [],
			api: openaiCompletions
		});
		this.#responsesProvider = createProvider({
			id: PROVIDER_ID,
			name: PROVIDER_NAME,
			baseUrl,
			auth,
			models: [],
			api: openaiResponses
		});
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: PROVIDER_NAME
		};
	}
	/**
	* Provider-owned retry policy (dsh-llm calls this unconditionally at
	* registration, index.js:1208). The anonymous free lane 429s in bursts —
	* live-probed 2026-10-09 (issue #51): 5/8 immediate failures on
	* step-5-preview-free, with contention windows that outlast the host
	* default (5 retries over ~15s), so transient throttling surfaced as
	* user-visible errors. This policy stretches the silent absorption window
	* to ~90s per step (8 retries, 1s→20s backoff, wider jitter). Retryable
	* codes mirror the host default set; deterministic failures (AUTH,
	* REGION_BLOCKED, INVALID_REQUEST) stay non-retryable.
	*/
	providerRetryPolicy(_provider) {
		return FREE_LANE_RETRY_POLICY;
	}
	/** No image pricing for the free Zen lane. */
	imageRequestPricing(_provider, _model) {}
	/** The input kinds DSH is told about for one model (isVisionModel). */
	#inputModalities(model) {
		return isVisionModel(model, this.#catalog.modalities?.(model)) ? ["text", "image"] : ["text"];
	}
	/**
	* Advisory catalog for the DSH model picker (deduped; dsh-llm rejects
	* duplicates). Async on purpose (issue #45): the host awaits this call and
	* caches its answer per host generation, so the first read waits —
	* bounded, inside the catalog — for the live Zen fetch instead of handing
	* the host the staticFreeModels bootstrap list it would then keep showing.
	*/
	async listModels(provider) {
		await this.#catalog.warm?.();
		const seen = /* @__PURE__ */ new Set();
		const models = [];
		for (const id of this.#catalog.list()) {
			if (seen.has(id)) continue;
			seen.add(id);
			models.push({
				provider,
				id,
				name: id,
				inputModalities: this.#inputModalities(id)
			});
		}
		return models;
	}
	resolveModel(provider, model) {
		const resolved = {
			provider,
			id: model,
			name: model,
			inputModalities: this.#inputModalities(model),
			context: { contextWindow: contextWindowFor(this.#catalog.limits?.(model)) },
			defaultMaxTokens: defaultMaxTokensFor(this.#catalog.limits?.(model))
		};
		const declaredEfforts = reasoningEfforts(this.#catalog.reasoningCapability(model));
		const efforts = isResponsesModel(model) ? declaredEfforts?.filter((effort) => effort.id !== "off") : declaredEfforts;
		if (efforts) resolved.reasoning = { efforts };
		return resolved;
	}
	async prepareCall(provider, model, _signal) {
		return {
			model: this.resolveModel(provider, model),
			stream: (options) => this.stream(options)
		};
	}
	/**
	* Recover once from a reasoning-only output limit on models that offer Off.
	* Keep the first attempt's reasoning visible, but withhold its terminal
	* chunks until recovery finishes. Answer/tool events forbid replay; retry
	* blocks get fresh indices and the final usage includes both requests.
	*/
	async *stream(options) {
		const selectedEffort = options.reasoningEffort ?? options.reasoning;
		const canDisableThinking = selectedEffort !== "off" && selectedEffort !== "none" && this.resolveModel(options.provider, options.model).reasoning?.efforts.some((effort) => effort.id === "off") === true;
		let request = options;
		let indexOffset = 0;
		let nextIndex = 0;
		let priorUsage;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			let sawReasoning = false;
			let sawAnswerOrTool = false;
			let usage;
			let finish;
			for await (const chunk of this.#streamAttempt(request, (message) => {
				for (const block of message.content) {
					if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) sawReasoning = true;
					if (block.type !== "thinking" && (block.type !== "text" || typeof block.text === "string" && block.text.length > 0)) sawAnswerOrTool = true;
				}
			})) {
				if (chunk.type === "usage") {
					usage = chunk;
					continue;
				}
				if (chunk.type === "finish") {
					finish = chunk;
					continue;
				}
				if (chunk.type === "reasoning-delta" && chunk.text.length > 0) sawReasoning = true;
				if (chunk.type === "text-delta" && chunk.text.length > 0) sawAnswerOrTool = true;
				if (chunk.type === "block-start" && chunk.blockType === "tool-call" || chunk.type === "tool-call-delta") sawAnswerOrTool = true;
				if (chunk.type === "block-end") {
					if (chunk.block.type === "reasoning" && chunk.block.text.length > 0) sawReasoning = true;
					if (chunk.block.type === "tool-call" || chunk.block.type === "text" && chunk.block.text.length > 0) sawAnswerOrTool = true;
				}
				if (typeof chunk.index === "number") nextIndex = Math.max(nextIndex, chunk.index + indexOffset + 1);
				yield indexOffset === 0 ? chunk : {
					...chunk,
					index: chunk.index + indexOffset
				};
			}
			if (attempt === 0 && canDisableThinking && sawReasoning && !sawAnswerOrTool && finish?.reason.kind === "max-tokens" && !options.signal?.aborted) {
				priorUsage = usage?.usage;
				indexOffset = nextIndex;
				request = {
					...options,
					reasoningEffort: "off",
					reasoning: "off"
				};
				continue;
			}
			if (usage || priorUsage) {
				const current = usage?.usage;
				const cacheReadTokens = (priorUsage?.cacheReadTokens ?? 0) + (current?.cacheReadTokens ?? 0);
				const cacheWriteTokens = (priorUsage?.cacheWriteTokens ?? 0) + (current?.cacheWriteTokens ?? 0);
				yield priorUsage === void 0 ? usage : {
					type: "usage",
					usage: {
						inputTokens: priorUsage.inputTokens + (current?.inputTokens ?? 0),
						outputTokens: priorUsage.outputTokens + (current?.outputTokens ?? 0),
						...cacheReadTokens > 0 ? { cacheReadTokens } : {},
						...cacheWriteTokens > 0 ? { cacheWriteTokens } : {}
					}
				};
			}
			if (finish) yield finish;
			return;
		}
	}
	/** Stream one attempt from the Zen anonymous lane.
	*
	* IP-7 rotate loop (docs/ip-pool.md §3.4 / §8.1): a stream that dies
	* BEFORE any content landed restarts on a fresh exit — the pool's health
	* marks already degraded the failed exit, so the restarted pick routes
	* elsewhere, and the host's retry budget never sees the intermediate
	* error. Once ANY content event has flowed, rotation stops (§3.4: a
	* partially delivered stream is never replayed). No pool running (or the
	* failure is not exit-shaped) = the original stream surface untouched.
	*/
	async *#streamAttempt(options, onTerminal) {
		const context = await toPiContext(options);
		const ids = deriveRequestIDs(options.messages);
		const argumentBridge = gateToolArgumentBridge(context.tools);
		const model = toPiModel(options.model, this.#catalog.reasoningCapability(options.model)?.reasoning === true, this.#catalog.limits?.(options.model), this.#catalog.modalities?.(options.model));
		const hostSession = typeof options.sessionId === "string" ? options.sessionId : "";
		const contextStore = {
			model: options.model,
			session: ids.session,
			usageSession: hostSession !== "" ? hostSession : ids.session,
			usageLabel: conversationLabel(options.messages)
		};
		const MAX_ROTATES = 3;
		const firstEventMs = this.#firstEventMs;
		const bodyIdleMs = model.api === "openai-responses" ? Math.max(this.#bodyIdleMs, this.#responsesBodyIdleMs) : this.#bodyIdleMs;
		const rotateStory = [];
		for (let attempt = 0;; attempt += 1) {
			const events = routingContext.run(contextStore, () => this.#eventsFor(options, context, ids, model));
			let deliveredContent = false;
			let preContentFailure = null;
			const buffered = [];
			/** Replay the buffered pre-content events alone (no live tail). */
			const replayBuffered = async function* () {
				for (const e of buffered) yield e;
			};
			const source = events[Symbol.asyncIterator]();
			let sawAnyEvent = false;
			let lastEventAt = Date.now();
			let deadlineTimer;
			const raceDeadline = () => {
				clearTimeout(deadlineTimer);
				const idleWindow = sawAnyEvent ? bodyIdleMs : firstEventMs;
				const message = sawAnyEvent ? WATCHDOG_IDLE_MESSAGE : WATCHDOG_FIRST_MESSAGE;
				const ms = Math.max(0, idleWindow - (Date.now() - lastEventAt));
				return new Promise((_, reject) => {
					deadlineTimer = setTimeout(() => reject(new Error(message)), ms);
					deadlineTimer.unref?.();
				});
			};
			const pumpLive = async function* () {
				for (const e of buffered) yield e;
				for (;;) {
					let next;
					try {
						next = await Promise.race([source.next(), raceDeadline()]);
					} catch (err) {
						yield terminalErrorEvent(err instanceof Error ? err.message : String(err), model);
						return;
					}
					if (next.done) {
						clearTimeout(deadlineTimer);
						return;
					}
					const event = next.value;
					lastEventAt = Date.now();
					if (event.type === "error" || event.type === "done") {
						clearTimeout(deadlineTimer);
						onTerminal?.(event.type === "done" ? event.message : event.error);
						yield event;
						return;
					}
					yield event;
				}
			};
			for (;;) {
				let next;
				try {
					next = await Promise.race([source.next(), raceDeadline()]);
				} catch (err) {
					preContentFailure = { message: err instanceof Error ? err.message : String(err) };
					buffered.push(terminalErrorEvent(preContentFailure.message, model));
					break;
				}
				if (next.done) break;
				const event = next.value;
				lastEventAt = Date.now();
				sawAnyEvent = true;
				if (event.type === "error") {
					onTerminal?.(event.error);
					preContentFailure = { message: event.error.errorMessage ?? "pi-ai stream error" };
					buffered.push(event);
					break;
				}
				if (event.type === "done") {
					onTerminal?.(event.message);
					if (event.message.stopReason === "error" && !deliveredContent) preContentFailure = { message: event.message.errorMessage ?? "pi-ai stream error" };
					buffered.push(event);
					break;
				}
				buffered.push(event);
				if (event.type !== "start") deliveredContent = true;
				if (deliveredContent) break;
			}
			clearTimeout(deadlineTimer);
			if (preContentFailure === null && deliveredContent) {
				yield* attributeUsage(contextStore, toStreamChunks(pumpLive(), model.contextWindow, GATE_TOOL_ALIASES, argumentBridge));
				return;
			}
			if (preContentFailure === null && !deliveredContent) {
				yield* attributeUsage(contextStore, toStreamChunks(replayBuffered(), model.contextWindow, GATE_TOOL_ALIASES, argumentBridge));
				return;
			}
			const failureMessage = preContentFailure.message;
			const failure = classifyStreamFailure(failureMessage);
			const deterministic = isRegionBlocked(failureMessage);
			const rotate = failure !== null && attempt < MAX_ROTATES && shouldRotate(failure, options.model, ids.session, attempt + 1, deterministic);
			rotateStory.push(`#${attempt + 1} ${failure ?? "unknown"}: ${failureMessage.slice(0, 80)}`);
			if (!rotate) {
				for (let i = 0; i < buffered.length; i += 1) {
					const e = buffered[i];
					if (e.type === "error" && e.error) {
						e.error.errorMessage = rotateStory.length > 1 ? `${e.error.errorMessage} (oc2dsh 轮换 ${rotateStory.length - 1} 次后放弃: ${rotateStory.join(" -> ")})` : e.error.errorMessage;
						break;
					}
					if (e.type === "done" && e.message?.stopReason === "error") {
						e.message.errorMessage = rotateStory.length > 1 ? `${e.message.errorMessage} (oc2dsh 轮换 ${rotateStory.length - 1} 次后放弃: ${rotateStory.join(" -> ")})` : e.message.errorMessage;
						break;
					}
				}
				yield* attributeUsage(contextStore, toStreamChunks(replayBuffered(), model.contextWindow, GATE_TOOL_ALIASES, argumentBridge));
				return;
			}
		}
	}
	#eventsFor(options, context, ids, model) {
		const isResponses = model.api === "openai-responses";
		const requestedReasoning = typeof options.reasoningEffort === "string" ? options.reasoningEffort : typeof options.reasoning === "string" ? options.reasoning : void 0;
		const responseReasoning = isResponses ? normalizeResponsesEffort(requestedReasoning) : void 0;
		const effortWire = isResponses ? void 0 : reasoningEffortWire(options.reasoningEffort);
		const onPayload = isResponses ? (payload) => {
			const normalized = normalizeResponsesPayload(payload, responseReasoning);
			return ensureResponsesFreeLaneShape(normalized ?? payload) ?? normalized;
		} : effortWire === void 0 ? ensureFreeLaneShape : (payload) => {
			const shaped = ensureFreeLaneShape(payload);
			if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return shaped;
			return {
				...shaped ?? payload,
				reasoning_effort: effortWire
			};
		};
		return (isResponsesModel(model.id) && this.#responsesProvider ? this.#responsesProvider : this.#provider).streamSimple(model, context, {
			apiKey: ANONYMOUS_KEY,
			sessionId: ids.session,
			headers: disguiseHeaders(ids),
			onPayload,
			signal: options.signal,
			maxRetries: 0,
			temperature: options.temperature,
			maxTokens: options.maxTokens,
			...responseReasoning ? { reasoning: responseReasoning } : {}
		});
	}
	/** Expose the live catalog snapshot for diagnostics. */
	catalogStatus() {
		const list = this.#catalog.list();
		return {
			total: list.length,
			exposed: list.length
		};
	}
	decisionFor(model) {
		const decision = this.#catalog.decision(model);
		return {
			allowed: decision.allowed,
			source: decision.source
		};
	}
};

//#endregion
//#region src/agent-process.ts
const GRACEFUL_STOP_TIMEOUT_MS = 5e3;
/**
* Uptime after which a run counts as "stable": the consecutive-crash counter
* resets. Prevents an infinite fast-crash loop from never tripping the breaker
* just because each spawn briefly reaches READY.
*/
const STABLE_UPTIME_MS = 3e4;
var AgentProcess = class extends EventEmitter {
	child = null;
	state = "stopped";
	consecutiveCrashes = 0;
	restartTimer = null;
	stopping = false;
	disposed = false;
	backoffMs;
	readySinceMs = 0;
	#ready = null;
	agentPath;
	args;
	options;
	constructor(agentPath, args, options) {
		super();
		this.agentPath = agentPath;
		this.args = args;
		this.options = options;
		this.backoffMs = options.restartDelayMs;
	}
	getState() {
		return this.state;
	}
	get readyInfo() {
		return this.#ready;
	}
	/** Spawn the agent and resolve with the READY handshake result. */
	async start(readyTimeoutMs = 1e4) {
		if (this.state === "ready" && this.#ready) return this.#ready;
		if (this.state === "starting") throw new Error("agent start already in progress");
		if (this.state === "tripped") throw new Error("agent circuit breaker tripped; restart the plugin");
		this.stopping = false;
		this.setState("starting");
		const child = spawn(this.agentPath, this.args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		this.child = child;
		this.pipeLogs(child);
		const spawnError = new Promise((_, reject) => {
			child.once("error", reject);
		});
		const stdoutReady = this.readReadyLine(child);
		const earlyExit = new Promise((_, reject) => {
			child.once("exit", (code) => reject(/* @__PURE__ */ new Error(`agent exited before READY (code ${code})`)));
		});
		try {
			this.#ready = await Promise.race([
				stdoutReady,
				spawnError,
				earlyExit,
				new Promise((_, reject) => setTimeout(() => reject(/* @__PURE__ */ new Error(`agent READY handshake timed out after ${readyTimeoutMs}ms`)), readyTimeoutMs))
			]);
		} catch (err) {
			this.detach(child);
			await this.killTree(child).catch(() => {});
			this.setState("stopped");
			throw err;
		}
		this.setState("ready");
		this.readySinceMs = Date.now();
		child.once("exit", (code) => this.onExit(child, code));
		return this.#ready;
	}
	/** Read stdout until the READY line (design.md section 8.2). */
	readReadyLine(child) {
		return new Promise((resolve, reject) => {
			const stdout = child.stdout;
			if (!stdout) return reject(/* @__PURE__ */ new Error("agent stdout is not piped"));
			const rl = createInterface({ input: stdout });
			let settled = false;
			const settle = (fn) => {
				if (settled) return;
				settled = true;
				fn();
				rl.close();
			};
			rl.on("line", (line) => {
				this.options.onLog?.(line);
				const match = /^READY (\{.*\})\s*$/.exec(line);
				if (!match?.[1]) return;
				try {
					const info = JSON.parse(match[1]);
					if (!Number.isInteger(info.port) || info.port <= 0) throw new Error(`invalid READY payload: ${line}`);
					settle(() => resolve(info));
				} catch (err) {
					settle(() => reject(err instanceof Error ? err : new Error(String(err))));
				}
			});
			rl.on("close", () => {
				if (settled) return;
				settled = true;
				reject(/* @__PURE__ */ new Error("agent stdout closed before READY"));
			});
		});
	}
	pipeLogs(child) {
		child.stderr?.on("data", (chunk) => {
			for (const line of chunk.toString("utf8").split("\n")) if (line.length > 0) this.options.onLog?.(line);
		});
	}
	onExit(child, code) {
		if (child !== this.child || this.disposed) return;
		this.#ready = null;
		if (this.stopping) {
			this.setState("stopped");
			return;
		}
		if (this.readySinceMs !== 0 && Date.now() - this.readySinceMs >= STABLE_UPTIME_MS) {
			this.consecutiveCrashes = 0;
			this.backoffMs = this.options.restartDelayMs;
		}
		this.readySinceMs = 0;
		this.consecutiveCrashes += 1;
		if (this.consecutiveCrashes >= this.options.maxConsecutiveCrashes) {
			this.setState("tripped");
			this.emit("circuit-tripped", this.consecutiveCrashes);
			return;
		}
		const delay = this.backoffMs;
		this.backoffMs = Math.min(this.backoffMs * 2, this.options.restartMaxDelayMs);
		this.emit("exit-restart", delay, this.consecutiveCrashes);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			this.start().catch(() => {});
		}, delay);
	}
	detach(child) {
		child.removeAllListeners("exit");
		child.stderr?.removeAllListeners("data");
		if (this.child === child) this.child = null;
	}
	/** Graceful stop: terminate, wait, then force-kill the whole tree. */
	async stop() {
		this.stopping = true;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		const child = this.child;
		if (!child || child.exitCode !== null) {
			this.setState("stopped");
			return;
		}
		await this.terminate(child);
		this.setState("stopped");
	}
	/** Idempotent teardown: no more restarts after dispose. */
	async dispose() {
		this.disposed = true;
		await this.stop();
	}
	async terminate(child) {
		const exited = new Promise((resolve) => child.once("exit", () => resolve()));
		if (process.platform === "win32") await this.taskkill(child, false).catch(() => {});
		else child.kill("SIGTERM");
		let timer;
		const timeout = new Promise((resolve) => {
			timer = setTimeout(() => resolve("timeout"), GRACEFUL_STOP_TIMEOUT_MS);
		});
		const result = await Promise.race([exited.then(() => "exit"), timeout]);
		clearTimeout(timer);
		if (result === "timeout") {
			if (process.platform === "win32") await this.taskkill(child, true).catch(() => child.kill());
			else child.kill("SIGKILL");
			await exited;
		}
	}
	async killTree(child) {
		if (child.exitCode !== null) return;
		if (process.platform === "win32") await this.taskkill(child, true).catch(() => child.kill());
		else child.kill("SIGKILL");
	}
	taskkill(child, force) {
		return new Promise((resolve, reject) => {
			if (!child.pid) return resolve();
			const killer = spawn("taskkill", force ? [
				"/T",
				"/F",
				"/PID",
				String(child.pid)
			] : [
				"/T",
				"/PID",
				String(child.pid)
			], {
				stdio: "ignore",
				windowsHide: true,
				timeout: GRACEFUL_STOP_TIMEOUT_MS
			});
			killer.once("error", reject);
			killer.once("exit", (code) => code === 0 ? resolve() : reject(/* @__PURE__ */ new Error(`taskkill failed: exit ${code}`)));
		});
	}
	setState(state) {
		this.state = state;
		this.emit("state", state);
	}
};

//#endregion
//#region src/ip-pool-settings/namespace.ts
/**
* Settings namespace owned by this plugin: the Loader entry id declared by
* `cordis.patch.yml`. Mirrored by `SETTINGS_NAMESPACE` in src/client/index.ts.
*/
const IP_POOL_NAMESPACE = "oc2dsh";
/** True when a value is one of the Loader's stable volatile references. */
function isVolatileRef(value) {
	return typeof value === "object" && value !== null && typeof value.get === "function";
}
/**
* Read a volatile reference, tolerating an absent one and a host that handed
* over a plain object instead (a composition predating the `Config` export, or
* a direct unit-test invocation of `apply()`).
*/
function readVolatile(value) {
	if (value === void 0) return void 0;
	return isVolatileRef(value) ? value.get() : value;
}
/** docs/ip-pool.md §4.6 probe defaults (S3 first entry is the doc-mandated default). */
const DEFAULT_PROBE_MODEL = "big-pickle";
const IpPoolConfigSchema = Schema.object({
	enabled: Schema.boolean().default(false),
	probeModels: Schema.array(Schema.string()).default([]),
	probeContents: Schema.array(Schema.string()).default([]),
	maxConcurrentProbes: Schema.number().min(1).max(8).step(1).default(3),
	poolSize: Schema.number().min(1).max(100).step(1).default(10),
	free: Schema.object({
		enabled: Schema.boolean().default(true),
		targetSize: Schema.number().min(1).max(100).step(1).default(20),
		blockedCountries: Schema.array(Schema.string()).default(["CN"])
	}),
	manual: Schema.array(Schema.string()).default([]),
	subscriptions: Schema.array(Schema.string()),
	subscription: Schema.object({
		urls: Schema.array(Schema.string()).default([]),
		refreshMs: Schema.number().min(6e4).max(1440 * 6e4).step(1).default(30 * 6e4),
		userAgent: Schema.string().default(DEFAULT_SUBSCRIPTION_USER_AGENT)
	}),
	singbox: Schema.object({ path: Schema.string().default("sing-box") }),
	pinnedExitId: Schema.string().default(""),
	pinnedStrict: Schema.boolean().default(false),
	proxyHosts: Schema.array(Schema.string()).default([]),
	proxyPathPrefixes: Schema.array(Schema.string()).default([]),
	localFallback: Schema.boolean().default(false),
	maxRotateAttempts: Schema.number().min(0).max(10).step(1).default(3),
	usageScope: Schema.string().default("total")
});
/** Anything but 'run' resolves to the persisted scope. */
function resolveUsageScope(value) {
	return value === "run" ? "run" : "total";
}
/** Resolve the schema-level default for the probe model set (§4.6). */
function resolveProbeModels(configured) {
	if (configured.length > 0) return [...new Set(configured)];
	return [DEFAULT_PROBE_MODEL];
}
/**
* Resolve the probe-content pool (§4.5 step 4): trimmed and deduped, or the
* single default when nothing is configured — the runtime always hands
* admission a non-empty pool, so the random pick has something to choose from.
*/
function resolveProbeContents(configured) {
	const pool = normalizeSmokeContents(configured);
	return pool.length > 0 ? pool : [DEFAULT_SMOKE_CONTENT];
}
/**
* Fill every default into one ip-pool value, from whichever layer produced
* it. Deliberately schema-independent: the volatile reference is the
* authoritative source, but a composition that predates the `Config` export
* (or a hand-edited profile patch) can still present the flat spelling, and
* neither may crash the boot path.
*/
function resolveIpPoolSettings(value) {
	const raw = value ?? {};
	const nestedUrls = raw.subscription?.urls ?? [];
	const legacyUrls = raw.subscriptions ?? [];
	const urls = nestedUrls.length > 0 ? nestedUrls : legacyUrls;
	return {
		enabled: raw.enabled ?? false,
		probeModels: raw.probeModels ?? [],
		probeContents: raw.probeContents ?? [],
		maxConcurrentProbes: raw.maxConcurrentProbes ?? 3,
		poolSize: raw.poolSize ?? 10,
		free: {
			enabled: raw.free?.enabled ?? true,
			targetSize: raw.free?.targetSize ?? 20,
			blockedCountries: raw.free?.blockedCountries ?? ["CN"]
		},
		manual: raw.manual ?? [],
		subscription: {
			urls,
			refreshMs: raw.subscription?.refreshMs ?? 30 * 6e4,
			userAgent: raw.subscription?.userAgent ?? DEFAULT_SUBSCRIPTION_USER_AGENT
		},
		singbox: { path: raw.singbox?.path ?? "sing-box" },
		pinnedExitId: raw.pinnedExitId ?? "",
		pinnedStrict: raw.pinnedStrict ?? false,
		proxyHosts: raw.proxyHosts ?? [],
		proxyPathPrefixes: raw.proxyPathPrefixes ?? [],
		localFallback: raw.localFallback ?? false,
		maxRotateAttempts: raw.maxRotateAttempts ?? 3,
		usageScope: resolveUsageScope(raw.usageScope)
	};
}
/**
* Map one resolved settings value onto the plugin config shape (config.ts).
* Round-trip complete: every field the runtime reads must survive here, or a
* live commit silently resets it to the default.
*/
function toIpPoolConfig(value) {
	return {
		enabled: value.enabled,
		manual: value.manual,
		pinnedExitId: value.pinnedExitId,
		pinnedStrict: value.pinnedStrict,
		proxyHosts: value.proxyHosts,
		proxyPathPrefixes: value.proxyPathPrefixes,
		localFallback: value.localFallback,
		free: {
			enabled: value.free.enabled,
			targetSize: value.free.targetSize,
			blockedCountries: value.free.blockedCountries
		},
		subscriptions: value.subscription.urls,
		subscription: {
			refreshMs: value.subscription.refreshMs,
			userAgent: value.subscription.userAgent
		},
		singbox: { path: value.singbox.path },
		probeModels: resolveProbeModels(value.probeModels),
		probeContents: resolveProbeContents(value.probeContents),
		maxConcurrentProbes: value.maxConcurrentProbes,
		poolSize: value.poolSize,
		maxRotateAttempts: value.maxRotateAttempts,
		usageScope: value.usageScope
	};
}

//#endregion
//#region src/config.ts
const defaults = {
	providerId: "oc2dsh",
	apiKeyEnv: "OC2DSH_TOKEN",
	refreshSeconds: 300,
	restartDelayMs: 1e3,
	restartMaxDelayMs: 6e4,
	maxConsecutiveCrashes: 5
};
function resolveConfig(config = {}) {
	return {
		...defaults,
		...config
	};
}
/**
* The plugin's `Config` — the whole DSH settings contract in one schema.
*
* DSH 0.1.7 has no imperative `ctx.settings.register(ns, schema)`. A plugin
* declares editable settings by exporting this schema, and dsh-settings derives
* the served namespace from the Loader entry id. Two consequences drive this
* shape:
*
*  - `ipPool` is ONE `.volatile()` node, so the entire ip-pool subtree is the
*    settings form (dsh-settings' `volatileForm()` selects a node's whole plain
*    schema once that node is volatile). Nesting `.volatile()` deeper is a hard
*    schemastery error, and per-field marks would also fragment the card's
*    form value into siblings instead of one `ipPool` object.
*  - `requestHeaders` is a separate volatile dictionary, edited by the Zen
*    section and read at request time by all three senders.
*  - the remaining fields are ORDINARY configuration. `volatileForm()` drops
*    them from the form; legacy `userAgent` remains a profile-only fallback.
*
* The reference is `dsh-llm-deepseek`'s `deepSeekConfigFields`.
*/
/**
* `requestHeaders` must stay a PLAIN dict — never a `.transform()`.
*
* dsh-settings builds the served form by REBUILDING the schema from
* `Config.toJSON()` (`plainSchema`: `new z(schema.toJSON())`) and then
* serializing that form a second time for the browser, which rehydrates it
* (`new Schema(view.schema)`) and validates the draft. A transform node keeps
* its `callback` through the first `toJSON()` but loses it on the rebuild, so
* the rehydrated node throws `callback is not a function`,
* `ConfigFormController.decode()` returns undefined, and the card never leaves
* its loading state — the whole 配置 page goes blank (live 2026-10-15, when the
* Zen 请求头 field was added with a transform).
*
* Validation therefore lives at the editor (`parseRequestHeaders`, strict) and
* at the request boundary (`sanitizeRequestHeaders`, lenient), not in the
* schema. `test/request-headers.test.ts` and `scripts/smoke-dsh-compat.mjs`
* guard the round trip.
*/
const RequestHeadersConfigSchema = Schema.dict(Schema.string()).default({}).volatile();
const Config = Schema.object({
	mode: Schema.union(["adapter", "sidecar"]).default("adapter"),
	agentPath: Schema.string(),
	agentArgs: Schema.array(Schema.string()).default([]),
	providerId: Schema.string().default(defaults.providerId),
	apiKeyEnv: Schema.string().default(defaults.apiKeyEnv),
	refreshSeconds: Schema.number().step(1).min(1).default(defaults.refreshSeconds),
	restartDelayMs: Schema.number().step(1).min(0).default(defaults.restartDelayMs),
	restartMaxDelayMs: Schema.number().step(1).min(0).default(defaults.restartMaxDelayMs),
	maxConsecutiveCrashes: Schema.number().step(1).min(0).default(defaults.maxConsecutiveCrashes),
	firstEventMs: Schema.number().step(1).min(1).max(6e5),
	bodyIdleMs: Schema.number().step(1).min(1).max(6e5),
	responsesBodyIdleMs: Schema.number().step(1).min(1).max(6e5),
	userAgent: Schema.string(),
	requestHeaders: RequestHeadersConfigSchema,
	ipPool: IpPoolConfigSchema.volatile()
});
/**
* The ordinary half of a resolved config, for the call sites that reconfigure
* the pool runtime and need a plain object. Spreading the whole config instead
* would hand `startIpPool` the volatile reference where it expects values.
*/
function ordinaryConfig(config) {
	const { ipPool: _ipPool, requestHeaders: _requestHeaders,...ordinary } = config;
	return ordinary;
}
function configPaths(dataDir) {
	return {
		dataDir,
		configPath: join(dataDir, "agent-config.json"),
		tokenPath: join(dataDir, "agent-token.txt")
	};
}
/** 32-byte random token, base64url (design.md section 7). */
function generateToken() {
	return randomBytes(32).toString("base64url");
}
async function fileExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}
/**
* Read the persisted token or generate and persist a fresh one.
* Best-effort 0600 on POSIX; Windows profile dirs are user-scoped already.
*/
async function ensureToken(paths) {
	if (await fileExists(paths.tokenPath)) {
		const existing = (await readFile(paths.tokenPath, "utf8")).trim();
		if (existing.length > 0) return existing;
	}
	const token = generateToken();
	await mkdir(dirname(paths.tokenPath), { recursive: true });
	await writeFile(paths.tokenPath, token + "\n", { encoding: "utf8" });
	if (platform !== "win32") await chmod(paths.tokenPath, 384).catch(() => {});
	return token;
}
/**
* Write agent-config.json atomically (tmp + rename) every plugin start, so a
* version upgrade or option change reaches the next agent spawn. The agent
* accepts JSON with comments; we emit plain JSON.
*/
async function writeAgentConfig(paths, options) {
	const config = {
		listen: "127.0.0.1:0",
		server_keys: [options.token],
		anonymous: true,
		zen_keys: [],
		go_keys: [],
		upstream: { zen: "https://opencode.ai/inference" },
		models: { refresh_seconds: options.refreshSeconds },
		retry: {
			max_attempts: 2,
			timeout_seconds: 300
		},
		proxies: ["direct"],
		logging: { level: "info" }
	};
	await mkdir(paths.dataDir, { recursive: true });
	const tmpPath = paths.configPath + ".tmp";
	await writeFile(tmpPath, JSON.stringify(config, null, 2), "utf8");
	await rm(paths.configPath, { force: true });
	await rename(tmpPath, paths.configPath);
}

//#endregion
//#region src/pool/usage-store.ts
/** How long day buckets are kept (live request: 最长 90 天). */
const USAGE_RETENTION_DAYS = 90;
/** Bounds on the two keyed maps; the oldest activity is dropped first. */
const SESSION_CAP = 500;
const EXIT_CAP = 200;
/** Debounce window for the atomic rewrite. */
const FLUSH_DEBOUNCE_MS = 1e4;
/** Sum a list of buckets into one. */
function sumTotals(buckets) {
	const total = emptyTotals();
	for (const bucket of buckets) addInto(total, bucket);
	return total;
}
/** Add one bucket into another (mutating the first). */
function addInto(target, source) {
	target.requests += source.requests;
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	target.totalTokens += source.totalTokens;
	target.outputMs += source.outputMs;
}
/** Local calendar day key, `YYYY-MM-DD` (the operator's own timezone). */
function localDay(at) {
	const date = new Date(at);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}
/**
* The default ledger path (same data dir as the catalog cache). Resolved on
* every call, so `OC2DSH_HOME` set after import still redirects it.
*/
function defaultUsagePath() {
	return join(stateDir(), "usage.json");
}
var UsageStore = class {
	/** This process's buckets — the 本次重启 scope, unchanged from before. */
	run = new UsageTracker();
	#pathOverride;
	#retentionDays;
	#flushMs;
	#now;
	#readOnly;
	#loaded = false;
	#dirty = false;
	#timer = null;
	#totals = emptyTotals();
	#days = /* @__PURE__ */ new Map();
	#sessions = /* @__PURE__ */ new Map();
	#exits = /* @__PURE__ */ new Map();
	/** Run-scope session buckets (this process only). */
	#runSessions = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		this.#pathOverride = options.path;
		this.#retentionDays = options.retentionDays ?? USAGE_RETENTION_DAYS;
		this.#flushMs = options.flushMs ?? FLUSH_DEBOUNCE_MS;
		this.#now = options.now ?? Date.now;
		this.#readOnly = options.readOnly ?? false;
	}
	/**
	* Where this ledger lives (diagnostics / the UI's footnote). Without an
	* injected path this resolves per call, so a test that drives the real entry
	* — `apply()` installs the process-wide store at import time — can still
	* redirect it by setting `OC2DSH_HOME` in its own body (paths.ts).
	*/
	get path() {
		return this.#pathOverride ?? defaultUsagePath();
	}
	get retentionDays() {
		return this.#retentionDays;
	}
	/** Read the document once, then trim it to the retention window. */
	load() {
		if (this.#loaded) return;
		this.#loaded = true;
		if (this.#readOnly) return;
		let raw;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch {
			return;
		}
		try {
			const parsed = JSON.parse(raw);
			if (parsed.version !== 1) return;
			this.#totals = {
				...emptyTotals(),
				...parsed.totals
			};
			for (const [day, bucket] of Object.entries(parsed.days ?? {})) this.#days.set(day, {
				...emptyTotals(),
				...bucket
			});
			for (const [id, row] of Object.entries(parsed.sessions ?? {})) this.#sessions.set(id, {
				label: row.label ?? "",
				firstAt: row.firstAt ?? 0,
				lastAt: row.lastAt ?? 0,
				totals: {
					...emptyTotals(),
					...row.totals
				}
			});
			for (const [id, row] of Object.entries(parsed.exits ?? {})) this.#exits.set(id, {
				lastAt: row.lastAt ?? 0,
				totals: {
					...emptyTotals(),
					...row.totals
				}
			});
		} catch {
			return;
		}
		this.prune();
	}
	/** Attribute one response's usage to one exit (and its session). */
	record(exitId, usage, meta = {}) {
		this.load();
		const at = this.#now();
		this.run.record(exitId, usage);
		const delta = emptyTotals();
		const input = usage.inputTokens ?? 0;
		const output = usage.outputTokens ?? 0;
		delta.requests = 1;
		delta.inputTokens = input;
		delta.outputTokens = output;
		delta.cacheReadTokens = usage.cacheReadTokens ?? 0;
		delta.cacheWriteTokens = usage.cacheWriteTokens ?? 0;
		delta.totalTokens = input + output;
		delta.outputMs = usage.durationMs ?? 0;
		addInto(this.#totals, delta);
		const day = localDay(at);
		const dayBucket = this.#days.get(day) ?? emptyTotals();
		addInto(dayBucket, delta);
		this.#days.set(day, dayBucket);
		const exit = this.#exits.get(exitId) ?? {
			lastAt: 0,
			totals: emptyTotals()
		};
		addInto(exit.totals, delta);
		exit.lastAt = at;
		this.#exits.set(exitId, exit);
		const sessionId = meta.session ?? "";
		if (sessionId !== "") {
			const stored = this.#sessions.get(sessionId) ?? {
				label: "",
				firstAt: at,
				lastAt: 0,
				totals: emptyTotals()
			};
			if (stored.label === "" && meta.label !== void 0 && meta.label !== "") stored.label = meta.label;
			addInto(stored.totals, delta);
			stored.lastAt = at;
			this.#sessions.set(sessionId, stored);
			const run = this.#runSessions.get(sessionId) ?? {
				label: stored.label,
				firstAt: at,
				lastAt: 0,
				totals: emptyTotals()
			};
			if (run.label === "" && meta.label !== void 0 && meta.label !== "") run.label = meta.label;
			addInto(run.totals, delta);
			run.lastAt = at;
			this.#runSessions.set(sessionId, run);
		}
		this.#dirty = true;
		this.#schedule();
	}
	/** All-time cumulative totals (never trimmed). */
	totals() {
		this.load();
		return { ...this.#totals };
	}
	/** This process's totals. */
	runTotals() {
		return sumTotals([...this.run.exits().map((id) => this.run.totals(id))]);
	}
	/** One exit's bucket in the requested scope. */
	exitTotals(exitId, scope) {
		if (scope === "run") return this.run.totals(exitId);
		this.load();
		return { ...this.#exits.get(exitId)?.totals ?? emptyTotals() };
	}
	/** One exit's last-use stamp in the requested scope (0 = never). */
	exitLastUsedAt(exitId, scope) {
		if (scope === "run") return this.run.lastUsedAt(exitId);
		this.load();
		return this.#exits.get(exitId)?.lastAt ?? 0;
	}
	/** Day buckets, oldest first, capped to the most recent `limit` days. */
	days(scope, limit) {
		this.load();
		const rows = [...(scope === "run" ? this.#runDays() : this.#days).entries()].map(([day, totals]) => ({
			day,
			totals: { ...totals }
		})).sort((left, right) => left.day.localeCompare(right.day));
		return limit === void 0 ? rows : rows.slice(-limit);
	}
	/** Session buckets, heaviest first, capped to `limit`. */
	sessions(scope, limit = 20) {
		this.load();
		return [...(scope === "run" ? this.#runSessions : this.#sessions).entries()].map(([id, row]) => ({
			id,
			label: row.label,
			totals: { ...row.totals },
			firstAt: row.firstAt,
			lastAt: row.lastAt
		})).sort((left, right) => right.totals.totalTokens - left.totals.totalTokens || right.lastAt - left.lastAt).slice(0, limit);
	}
	/** How many sessions/days the ledger is holding (the UI's footnote). */
	size() {
		this.load();
		return {
			sessions: this.#sessions.size,
			days: this.#days.size,
			exits: this.#exits.size
		};
	}
	/** Drop day buckets past the retention window and cap the keyed maps. */
	prune(at) {
		const cutoff = localDay((at ?? this.#now()) - this.#retentionDays * 24 * 60 * 60 * 1e3);
		for (const day of [...this.#days.keys()]) if (day < cutoff) this.#days.delete(day);
		this.#cap(this.#sessions, SESSION_CAP, (row) => row.lastAt);
		this.#cap(this.#exits, EXIT_CAP, (row) => row.lastAt);
	}
	#cap(map, limit, lastAt) {
		if (map.size <= limit) return;
		const doomed = [...map.entries()].sort((left, right) => lastAt(left[1]) - lastAt(right[1])).slice(0, map.size - limit);
		for (const [key] of doomed) map.delete(key);
	}
	/** The day buckets recorded since this process started. */
	#runDays() {
		const days = /* @__PURE__ */ new Map();
		for (const row of this.#runSessions.values()) {
			const day = localDay(row.lastAt);
			const bucket = days.get(day) ?? emptyTotals();
			addInto(bucket, row.totals);
			days.set(day, bucket);
		}
		return days;
	}
	#schedule() {
		if (this.#readOnly || this.#flushMs <= 0 || this.#timer !== null) return;
		this.#timer = setInterval(() => {
			this.flush();
		}, this.#flushMs);
		this.#timer.unref?.();
	}
	/** Write the document atomically (temp file + rename); no-op when clean. */
	async flush() {
		if (this.#readOnly || !this.#dirty) return;
		this.load();
		this.prune();
		const document = {
			version: 1,
			totals: this.#totals,
			days: Object.fromEntries(this.#days),
			sessions: Object.fromEntries(this.#sessions),
			exits: Object.fromEntries(this.#exits),
			savedAt: this.#now()
		};
		const temp = `${this.path}.tmp`;
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(temp, JSON.stringify(document), "utf8");
			renameSync(temp, this.path);
			this.#dirty = false;
		} catch {
			try {
				unlinkSync(temp);
			} catch {}
		}
	}
	/** Stop the timer and write whatever is pending (host shutdown). */
	async dispose() {
		if (this.#timer !== null) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
		await this.flush();
	}
	/**
	* Operator-facing clear (live request 2026-10-14: "总量统计保留 90 天，自然
	* 过期，增加一个清空的功能按钮"): drop every bucket AND make the empty
	* document the one on disk, so a restart cannot bring the numbers back.
	*
	* `load()` runs FIRST on purpose: a store that has not read the file yet
	* would otherwise re-read it inside `flush()` and merge the old totals back
	* over the clear. Both scopes go together — a cleared 总览 next to a live
	* 本次重启 would read as a bug, not as a feature.
	*/
	async clear() {
		this.load();
		this.reset();
		this.#dirty = true;
		await this.flush();
	}
	/** In-memory-only seam: drop every bucket and start over (tests). */
	reset() {
		this.run.reset();
		this.#totals = emptyTotals();
		this.#days.clear();
		this.#sessions.clear();
		this.#exits.clear();
		this.#runSessions.clear();
		this.#dirty = false;
	}
};
/** The process-wide ledger: adapter writes, status bridge reads. */
const usageStore = new UsageStore();

//#endregion
//#region src/ip-pool-settings/bridge.ts
/** Bridge route prefix (same-origin, loopback-only). */
const IP_POOL_BRIDGE_PREFIX = "/api/oc2dsh/ip-pool";
/** Cap on JSON request bodies (a probe trigger is tiny). */
const MAX_JSON_BODY_BYTES = 16 * 1024;
/**
* Sessions listed in the 流量 tab. Shared by the status prefetch and the view
* builder so both slice the ledger to the same population — the title join
* must ask for exactly the ids the table will render.
*/
const USAGE_SESSION_LIMIT = 20;
/**
* The four-state thresholds (docs 3.5) applied to a usable/capacity ratio.
* An empty population reads `warning`, never `emergency`: an enabled pool
* whose exits have not landed yet (subscription still fetching) is not the
* same failure as a pool that drained.
*/
function stateOfRatio(available, capacity) {
	if (capacity <= 0) return "warning";
	const ratio = available / capacity;
	if (ratio < .1) return "emergency";
	if (ratio < .3) return "critical";
	if (ratio < .95) return "warning";
	return "healthy";
}
/** Build the /status view over the live runtime (or a disabled stub). */
function buildStatusView(runtime, pinnedStrict, proxyHosts, options = {}) {
	const freeEnabled = options.freeEnabled ?? true;
	const proxyPathPrefixes = options.proxyPathPrefixes ?? [...DEFAULT_PROXY_PATH_PREFIXES];
	const store = options.usage;
	const scope = options.usageScope ?? "total";
	/**
	* Per-exit numbers follow the scope switch: the ledger's persisted buckets
	* for 总览, the in-process tracker for 本次重启. A composition with no ledger
	* falls back to the tracker, which is exactly the pre-ledger behaviour.
	*/
	const tokensOf = (id) => store === void 0 ? usageTracker.totals(id) : store.exitTotals(id, scope);
	/**
	* Recent speed always reads the PROCESS tracker's rolling window — the
	* lifetime ledger cannot answer "how fast is it now", and the window has
	* no scope dimension (live request 2026-10-15).
	*/
	const tracker = store === void 0 ? usageTracker : store.run;
	/** 最后使用: the live dispatch stamp for 本次重启, the ledger's last recorded
	*  response for 总览 (a dispatch that produced no usage event never reached
	*  the ledger, so the two are not the same signal — the column says which). */
	const lastUsedOf = (id, live) => store === void 0 || scope === "run" ? live : store.exitLastUsedAt(id, "total");
	const snapshot = runtime ? runtime.pool.snapshot() : {
		state: "healthy",
		total: 0,
		bySource: {
			free: 0,
			manual: 0,
			subscription: 0,
			goproxy: 0
		},
		availableFree: 0,
		pinned: ""
	};
	const now = options.now ?? Date.now();
	const exits = runtime ? runtime.pool.list().map((entry) => {
		const passive = runtime.pool.passiveStats(entry.id);
		const activity = runtime.pool.activity(entry.id);
		return {
			id: entry.id,
			source: entry.source,
			protocol: entry.protocol,
			pinned: entry.pinned,
			exitIP: entry.exitIP,
			exitLocation: entry.exitLocation,
			latencyMs: entry.latencyMs,
			quality: entry.quality,
			state: entry.health.state,
			cooling: entry.health.cooldownUntil > now,
			cooldownUntil: entry.health.cooldownUntil,
			consecutiveLimited: entry.health.consecutiveLimited,
			bannedModels: entry.bans.filter((b) => b.ban.state !== "ok").map((b) => ({
				model: b.model,
				state: b.ban.state,
				bannedAt: b.ban.bannedAt
			})),
			passive,
			requests: passive.ok + passive.limited + passive.refused + passive.dead + passive.transport,
			lastUsedAt: lastUsedOf(entry.id, activity.lastUsedAt),
			inFlight: activity.inFlight,
			demoted: runtime.pool.demoted(entry.id),
			tokens: tokensOf(entry.id),
			speed: tracker.speed(entry.id)
		};
	}) : [];
	/**
	* Usable exits across the WHOLE pool, any source. `availableFree` is only
	* the free-source subset, so rendering it as a bare "可用 n/capacity"
	* reads as "nothing is usable" to anyone running subscription/manual
	* exits only — a live profile showed "可用 0/20 · 手填 1 · 订阅 12" while
	* 7 of those 12 were healthy.
	*/
	const availableTotal = exits.filter((exit) => exit.state === "ok").length;
	const stateBasis = freeEnabled ? "free" : "pool";
	return {
		enabled: runtime !== null && runtime.installer.enabled,
		deferredReason: runtime !== null && !runtime.installer.enabled ? runtime.installer.deferredReason ?? "" : "",
		state: stateBasis === "free" ? snapshot.state : stateOfRatio(availableTotal, snapshot.total),
		stateBasis,
		total: snapshot.total,
		bySource: snapshot.bySource,
		availableFree: snapshot.availableFree,
		availableTotal,
		targetSize: runtime ? runtime.pool.targetSize : 20,
		poolSize: runtime ? runtime.pool.poolSize : 10,
		pinned: snapshot.pinned !== "" ? {
			id: snapshot.pinned,
			strict: pinnedStrict,
			local: snapshot.pinned === LOCAL_EXIT_ID
		} : null,
		proxyHosts,
		proxyPathPrefixes,
		exits,
		prober: runtime ? runtime.prober.stats : {
			queued: 0,
			inFlight: 0,
			enqueued: 0,
			completed: 0
		},
		refill: runtime?.refill ? {
			...runtime.refill.lastRound,
			progress: runtime.refill.progress
		} : null,
		subscription: runtime?.subscriptions ? {
			urlCount: runtime.subscriptions.urlCount,
			pendingConversion: runtime.subscriptions.state.pendingConversion.length,
			convertedAdmitted: runtime.subscriptions.state.convertedAdmitted,
			plaintextAdmitted: runtime.subscriptions.state.plaintextAdmitted,
			lastFetch: runtime.subscriptions.state.lastFetch,
			lastError: runtime.subscriptions.state.lastError
		} : null,
		direct: {
			requests: runtime ? runtime.pool.directRequests : 0,
			tokens: runtime ? tokensOf(DIRECT_EXIT_ID) : emptyTotals()
		},
		local: localView(store, scope, tracker),
		usage: buildUsageView(store, scope, {
			projectOf: options.projectOf,
			sessionTitles: options.sessionTitles,
			runSince: options.runSince
		}),
		zenUserAgent: opencodeUserAgent(),
		zenClient: zenRequestHeaders()["x-opencode-client"] ?? "cli",
		recentSpeed: tracker.speedAll(),
		todayTokens: todayTokensOf(store, now),
		localFallback: runtime?.installer?.localFallback ?? options.localFallback ?? false,
		at: now
	};
}
/** The all-in token figure the UI shows (input + output + cache read/write). */
function grandTotal(totals) {
	return totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
}
/**
* Today's all-in tokens: the ledger's local-calendar-day bucket when one is
* wired (scope-independent — "today" is a day, not a scope), the process
* tracker's totals otherwise, so a composition without a ledger still shows
* what this machine spent today.
*/
function todayTokensOf(store, now) {
	if (store === void 0) {
		let sum = 0;
		for (const id of usageTracker.exits()) sum += grandTotal(usageTracker.totals(id));
		return sum;
	}
	const key = localDay(now);
	const row = store.days("total").find((entry) => entry.day === key);
	return row === void 0 ? 0 : grandTotal(row.totals);
}
/**
* Merge the two local-egress buckets into the modal's 本机 row.
*
* `direct` = pool-host traffic that should have used an exit but could not;
* `local` = hosts outside the proxy set (and every request while routing is
* off). Both left this machine, so the row sums them, while the request
* count prefers the pool's dispatch counter when it has one: that counter
* sees the request even when no usage event follows (an aborted turn), which
* a token-only bucket would silently drop.
*/
function localView(store, scope, tracker) {
	const read = (id) => store === void 0 ? usageTracker.totals(id) : store.exitTotals(id, scope);
	const lastUsed = (id) => store === void 0 || scope === "run" ? usageTracker.lastUsedAt(id) : store.exitLastUsedAt(id, "total");
	const direct = read(DIRECT_EXIT_ID);
	const local = read(LOCAL_EXIT_ID);
	const tokens = {
		requests: direct.requests + local.requests,
		inputTokens: direct.inputTokens + local.inputTokens,
		outputTokens: direct.outputTokens + local.outputTokens,
		cacheReadTokens: direct.cacheReadTokens + local.cacheReadTokens,
		cacheWriteTokens: direct.cacheWriteTokens + local.cacheWriteTokens,
		totalTokens: direct.totalTokens + local.totalTokens,
		outputMs: direct.outputMs + local.outputMs
	};
	return {
		requests: tokens.requests,
		tokens,
		lastUsedAt: Math.max(lastUsed(DIRECT_EXIT_ID), lastUsed(LOCAL_EXIT_ID)),
		speed: tracker.speedFor([DIRECT_EXIT_ID, LOCAL_EXIT_ID])
	};
}
/**
* Project the ledger for the 流量 tab. `scope` picks the population; `total`
* (all-time) always rides along, because the footer is pinned to 总览 while the
* modal follows the switch.
*
* Sessions are listed heaviest-first and their projects resolved through the
* registry seam — a session whose project cannot be resolved keeps a null
* project rather than a fabricated one. The row NAME prefers the host's own
* session title over the recorded first-prompt label (live request
* 2026-10-14: the list "looks like part of the prompt" — the prompt fragment
* is now only the fallback for sessions the host cannot title).
*/
function buildUsageView(store, scope, options = {}) {
	if (store === void 0) return null;
	const sessionLimit = options.sessionLimit ?? USAGE_SESSION_LIMIT;
	const sessions = store.sessions(scope, sessionLimit).map((row) => ({
		id: row.id,
		label: options.sessionTitles?.get(row.id) || row.label,
		requests: row.totals.requests,
		tokens: row.totals.inputTokens + row.totals.outputTokens + row.totals.cacheReadTokens + row.totals.cacheWriteTokens,
		outputTokens: row.totals.outputTokens,
		outputMs: row.totals.outputMs,
		firstAt: row.firstAt,
		lastAt: row.lastAt,
		project: options.projectOf?.(row.id) ?? null
	}));
	const byProject = /* @__PURE__ */ new Map();
	for (const session of sessions) {
		if (session.project === null) continue;
		const row = byProject.get(session.project.id) ?? {
			...session.project,
			requests: 0,
			tokens: 0,
			sessions: 0,
			lastAt: 0
		};
		row.requests += session.requests;
		row.tokens += session.tokens;
		row.sessions += 1;
		row.lastAt = Math.max(row.lastAt, session.lastAt);
		byProject.set(session.project.id, row);
	}
	return {
		scope,
		retentionDays: store.retentionDays,
		runSince: options.runSince ?? 0,
		total: store.totals(),
		scoped: scope === "run" ? store.runTotals() : store.totals(),
		recentSpeed: store.run.speedAll(),
		days: store.days(scope).map((row) => ({
			day: row.day,
			requests: row.totals.requests,
			tokens: row.totals.inputTokens + row.totals.outputTokens + row.totals.cacheReadTokens + row.totals.cacheWriteTokens,
			outputTokens: row.totals.outputTokens,
			outputMs: row.totals.outputMs
		})),
		sessions,
		projects: [...byProject.values()].sort((left, right) => right.tokens - left.tokens),
		stored: store.size()
	};
}
/** Whether a socket address is a literal loopback peer. */
function isLoopbackAddress(address) {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
/** Whether a normalized hostname is a literal loopback authority. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** Parse one bare Host authority; undefined for anything non-canonical. */
function parseAuthority(authority) {
	if (authority.trim() !== authority) return void 0;
	const match = authority.startsWith("[") ? /^\[[^\]]+\](?::([0-9]+))?$/.exec(authority) : /^[^:@/?#\s]+(?::([0-9]+))?$/.exec(authority);
	if (match === null) return void 0;
	try {
		const url = new URL("http://" + authority);
		if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return void 0;
		const rawPort = match[1];
		if (rawPort !== void 0 && (String(Number(rawPort)) !== rawPort || Number(rawPort) > 65535)) return void 0;
		return { url };
	} catch {
		return;
	}
}
/** Browser same-origin marker (loopback hosts are always same-origin here). */
function isSameOriginRequest(request, hostUrl) {
	const headers = request.headers;
	if (headers["sec-fetch-site"] === "cross-site") return false;
	const origin = headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(String(origin)).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** Hot-path trust decision: loopback socket + canonical Host + same-origin. */
function isTrustedBridgeRequest(request) {
	if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	const parsed = parseAuthority(host);
	if (parsed === void 0 || parsed.url.host.toLowerCase() !== host.toLowerCase()) return false;
	if (!isSameOriginRequest(request, parsed.url)) return false;
	return isLoopbackHostname(parsed.url.hostname);
}
/** One JSON response. */
function writeJson(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(JSON.stringify(body));
}
/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_JSON_BODY_BYTES) return void 0;
		chunks.push(Buffer.from(chunk));
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return;
	}
}
/** Build the bridge handlers over the runtime + current settings. */
function makeBridgeHandlers(runtime, settings, deps = {}) {
	return {
		async status() {
			const current = settings();
			/**
			* The top-session join (live request 2026-10-14): ask the host for the
			* titles of exactly the rows the view will render, before building it —
			* the resolver is TTL-cached, so the modal's 2s poll mostly reads cache.
			* A missing resolver or a failed batch just yields no map: every row
			* keeps its recorded label and /status still answers.
			*/
			let sessionTitles;
			const store = deps.usage;
			if (deps.sessionTitles !== void 0 && store !== void 0) {
				const scope = current.usageScope ?? "total";
				try {
					sessionTitles = await deps.sessionTitles(store.sessions(scope, USAGE_SESSION_LIMIT).map((row) => row.id));
				} catch {
					sessionTitles = void 0;
				}
			}
			return {
				ok: true,
				value: buildStatusView(runtime(), current.pinnedStrict, current.proxyHosts, {
					freeEnabled: current.freeEnabled,
					proxyPathPrefixes: current.proxyPathPrefixes,
					usage: deps.usage,
					usageScope: current.usageScope,
					projectOf: deps.projectOf,
					sessionTitles,
					runSince: deps.runSince?.()
				})
			};
		},
		async probe(body) {
			const rt = runtime();
			if (rt === null) return {
				ok: false,
				code: "pool-disabled",
				message: "ip pool is not running (enabled off)"
			};
			const scope = body.scope;
			if (scope === "all") return {
				ok: true,
				value: { queued: await rt.probeAll() }
			};
			if (scope === "refill") {
				await rt.refillNow();
				return {
					ok: true,
					value: { refilled: true }
				};
			}
			if (scope === "subscription") {
				await rt.refreshSubscriptions();
				return {
					ok: true,
					value: { refreshed: true }
				};
			}
			if (scope === "exit") {
				const exitId = typeof body.exitId === "string" ? body.exitId : "";
				if (!rt.pool.has(exitId)) return {
					ok: false,
					code: "unknown-exit",
					message: `exit "${exitId}" is not in the pool`
				};
				return {
					ok: true,
					value: { queued: await rt.probeExit(exitId) }
				};
			}
			return {
				ok: false,
				code: "settings-rejected",
				message: "probe scope must be 'all', 'exit', 'refill' or 'subscription'"
			};
		},
		async models() {
			const { staticFreeModels } = await import("./catalog2.js");
			const rows = staticFreeModels.map((id) => ({
				id,
				verified: true
			}));
			const seen = new Set(staticFreeModels);
			for (const id of deps.listLiveModels?.() ?? []) {
				if (typeof id !== "string" || id === "" || seen.has(id)) continue;
				seen.add(id);
				rows.push({
					id,
					verified: false
				});
			}
			return {
				ok: true,
				value: { models: rows }
			};
		},
		async exit(body) {
			const rt = runtime();
			if (rt === null) return {
				ok: false,
				code: "pool-disabled",
				message: "ip pool is not running (enabled off)"
			};
			const action = body.action;
			if (action === "pin" || action === "pin-local" || action === "unpin") {
				const raw = action === "unpin" ? "" : action === "pin-local" ? LOCAL_EXIT_ID : typeof body.exitId === "string" ? body.exitId.trim() : "";
				if (raw !== "" && raw !== LOCAL_EXIT_ID && !rt.pool.has(raw)) return {
					ok: false,
					code: "unknown-exit",
					message: `exit "${raw}" is not in the pool`
				};
				let persisted = false;
				try {
					persisted = await deps.writePin?.(raw) ?? false;
				} catch {
					persisted = false;
				}
				if (raw === "") rt.pool.unpin();
				else if (raw === LOCAL_EXIT_ID) rt.pool.pinLocal();
				else rt.pool.pin(raw);
				return {
					ok: true,
					value: {
						pinned: raw,
						local: raw === LOCAL_EXIT_ID,
						persisted
					}
				};
			}
			if (action === "rotate") {
				const exitId = typeof body.exitId === "string" ? body.exitId : "";
				if (!rt.pool.has(exitId)) return {
					ok: false,
					code: "unknown-exit",
					message: `exit "${exitId}" is not in the pool`
				};
				if (rt.pool.pinnedId === exitId) {
					try {
						await deps.writePin?.("");
					} catch {}
					rt.pool.unpin();
				}
				const promoted = await rt.subscriptions?.replaceExit(exitId).catch(() => false) ?? false;
				if (!promoted && rt.pool.has(exitId)) {
					if (rt.subscriptions?.busy === true) return {
						ok: true,
						value: {
							rotated: false,
							promoted: false,
							busy: true,
							remaining: rt.pool.snapshot().total
						}
					};
					rt.pool.demoteToTail(exitId);
				}
				return {
					ok: true,
					value: {
						rotated: true,
						promoted,
						remaining: rt.pool.snapshot().total
					}
				};
			}
			return {
				ok: false,
				code: "settings-rejected",
				message: "exit action must be 'pin', 'pin-local', 'unpin' or 'rotate'"
			};
		},
		async usage(body) {
			const store = deps.usage;
			if (store === void 0) return {
				ok: false,
				code: "no-ledger",
				message: "this composition has no persistent usage ledger"
			};
			if (body.action !== "reset") return {
				ok: false,
				code: "settings-rejected",
				message: "usage action must be 'reset'"
			};
			await store.clear();
			return {
				ok: true,
				value: { cleared: true }
			};
		}
	};
}
/** Build the loopback-guarded routes. The route bodies are host-shaped
*  (node:http req/res); typed loosely because the plugin never touches the
*  webServer service itself — index.ts does. */
function makeBridgeRoutes(handlers, deps = {}) {
	const guard = deps.guard ?? isTrustedBridgeRequest;
	const check = (req, res) => {
		if (!guard(req)) {
			writeJson(res, 403, { error: "forbidden" });
			return false;
		}
		if (req.method !== "POST") {
			writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
			return false;
		}
		return true;
	};
	/** One guard-checked POST route with no request body (/status, /models). */
	const postRoute = (path, run) => ({
		kind: "exact",
		path,
		handler: async (req, res) => {
			const rawRes = res;
			if (!check(req, rawRes)) return;
			writeJson(rawRes, 200, await run(rawRes));
		}
	});
	/** One guard-checked POST route that reads a JSON object body. */
	const jsonRoute = (path, handle) => ({
		kind: "exact",
		path,
		handler: async (req, res) => {
			const rawRes = res;
			if (!check(req, rawRes)) return;
			let body;
			try {
				body = await readJsonBody(req);
			} catch {
				body = void 0;
			}
			if (body === void 0 || typeof body !== "object" || body === null) {
				writeJson(rawRes, 400, {
					ok: false,
					code: "settings-rejected",
					message: "unreadable JSON body"
				});
				return;
			}
			writeJson(rawRes, 200, await handle(body));
		}
	});
	return [
		postRoute(`${IP_POOL_BRIDGE_PREFIX}/status`, () => handlers.status()),
		postRoute(`${IP_POOL_BRIDGE_PREFIX}/models`, () => handlers.models()),
		jsonRoute(`${IP_POOL_BRIDGE_PREFIX}/probe`, (body) => handlers.probe(body)),
		jsonRoute(`${IP_POOL_BRIDGE_PREFIX}/exit`, (body) => handlers.exit(body)),
		jsonRoute(`${IP_POOL_BRIDGE_PREFIX}/usage`, (body) => handlers.usage(body))
	];
}

//#endregion
//#region src/pool/session-titles.ts
/** Cached RESOLVED titles are reused for this long (renames show up later). */
const TITLE_HIT_TTL_MS = 6e4;
/** A miss (no title yet / unknown session) is retried after this long. */
const TITLE_MISS_TTL_MS = 15e3;
/** Bound on the cache; dropped wholesale when exceeded (like ids.ts' session cache). */
const TITLE_CACHE_LIMIT = 2048;
/**
* Build a cached title resolver over one host session-query service.
*
* @param query - the host's `ctx.sessionQuery` (structural: any object with
*   a compatible `readTitleSnapshots`, or none of it).
* @param options - `now` clock seam (tests); TTLs follow the exported defaults.
* @returns a resolver that never rejects: query failures and rejected rows
*   resolve to "whatever was cached", so `/status` can never fail on titles.
*/
function makeSessionTitleResolver(query, options = {}) {
	const now = options.now ?? Date.now;
	const cache = /* @__PURE__ */ new Map();
	return async (sessionIds) => {
		const out = /* @__PURE__ */ new Map();
		if (typeof query.readTitleSnapshots !== "function") return out;
		const seen = /* @__PURE__ */ new Set();
		const missing = [];
		const stamp = now();
		for (const id of sessionIds) {
			if (id === "" || seen.has(id)) continue;
			seen.add(id);
			const hit = cache.get(id);
			const ttl = hit !== void 0 && hit.title !== "" ? TITLE_HIT_TTL_MS : TITLE_MISS_TTL_MS;
			if (hit !== void 0 && stamp - hit.at < ttl) {
				if (hit.title !== "") out.set(id, hit.title);
				continue;
			}
			missing.push(id);
		}
		if (missing.length === 0) return out;
		let rows = [];
		try {
			rows = await query.readTitleSnapshots(missing);
		} catch {
			return out;
		}
		const answered = now();
		for (const row of rows) {
			const id = typeof row.sessionId === "string" ? row.sessionId : "";
			if (id === "") continue;
			const title = row.status === "fulfilled" && typeof row.value?.title?.title === "string" ? row.value.title.title : "";
			if (cache.size >= TITLE_CACHE_LIMIT) cache.clear();
			cache.set(id, {
				title,
				at: answered
			});
			if (title !== "") out.set(id, title);
		}
		return out;
	};
}

//#endregion
//#region src/ip-pool-settings/apply.ts
const defaultAssemble = async (config, logger) => {
	const { startIpPool } = await import("./ip-pool.js");
	return startIpPool(config, logger);
};
/**
* Register the ip-pool namespace, own the live runtime, mount the bridge.
* Returns the controller handle; disposal rides the plugin fiber.
*/
function applyIpPoolSettings(ctx, ordinary, readIpPool, logger, deps = {}) {
	const assemble = deps.assemble ?? defaultAssemble;
	let disposed = false;
	let starting;
	const controller = {
		runtime: null,
		settings: () => resolveIpPoolSettings(readIpPool()),
		asConfig: (value) => ({
			...ordinary,
			ipPool: toIpPoolConfig(value)
		})
	};
	/** Assemble on first enable; reuse across later commits (live reconfigure). */
	const ensureRuntime = async () => {
		if (disposed || controller.runtime !== null) return;
		if (starting !== void 0) return starting;
		starting = (async () => {
			const runtime = await assemble(controller.asConfig(controller.settings()), logger);
			if (disposed) await runtime?.dispose();
			else controller.runtime = runtime;
		})();
		try {
			await starting;
		} finally {
			starting = void 0;
		}
	};
	const applyCommitted = (value) => {
		if (disposed) return;
		const rt = controller.runtime;
		if (value.enabled && rt === null) {
			ensureRuntime().then(() => controller.runtime?.reconfigure(controller.asConfig(controller.settings()))).catch((err) => {
				logger.warn(`oc2dsh: ip pool start failed: ${err instanceof Error ? err.message : String(err)}`);
			});
			return;
		}
		if (rt !== null) rt.reconfigure(controller.asConfig(value)).catch((err) => {
			logger.warn(`oc2dsh: ip pool live re-apply failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	};
	applyCommitted(controller.settings());
	const maybeOn = ctx.on;
	if (typeof maybeOn === "function") maybeOn.call(ctx, "loader/volatile-update", () => {
		applyCommitted(controller.settings());
	});
	let settingsHandle;
	if (typeof ctx.inject === "function") Promise.resolve(ctx.inject(["settings"], (sctx) => {
		const settings = sctx.settings;
		if (settings === void 0) return;
		settingsHandle = settings;
		if (typeof settings.configure !== "function") return;
		const fiber = ctx.fiber;
		const claim = () => settings.configure({ auto: false }, fiber);
		const maybeFiberEffect = sctx.effect;
		if (typeof maybeFiberEffect === "function") {
			maybeFiberEffect.call(sctx, claim);
			return;
		}
		claim();
	}));
	/**
	* Session id → project, resolved through the host's workspace registry.
	*
	* The ledger records SESSION ids (the LLM request carries no workspace —
	* DSH's own prompt says the cwd is not inferable), and the registry is the
	* authority on which project each session belongs to: `list()` returns every
	* workspace with its `sessionIds`, so this is a read-time join rather than a
	* fact the adapter would have to guess at record time. Optional service: a
	* composition without the registry simply reports no project.
	*/
	let projectOf;
	if (typeof ctx.inject === "function") Promise.resolve(ctx.inject(["workspaceRegistry"], (sctx) => {
		const registry = sctx.workspaceRegistry;
		if (registry === void 0 || typeof registry.list !== "function") return;
		projectOf = (sessionId) => {
			if (sessionId === "") return null;
			for (const workspace of registry.list?.() ?? []) {
				if (!(workspace.sessionIds ?? []).includes(sessionId)) continue;
				return {
					id: String(workspace.id),
					title: workspace.title,
					path: workspace.path
				};
			}
			return null;
		};
	}));
	/**
	* Session id → the HOST's session title, for the 流量 tab's Top 会话 names.
	*
	* The ledger records the first user turn at request time, so the list used
	* to read like "part of the prompt" (live request 2026-10-14). The real
	* title lives in the host's session log (`session/title` events), owned by
	* `ctx.sessionQuery`, so it is joined READ-TIME — the same optional-service
	* pattern as projectOf above: a composition without the service, or one
	* whose title corpus is empty, simply keeps the recorded labels.
	*/
	let sessionTitles;
	if (typeof ctx.inject === "function") Promise.resolve(ctx.inject(["sessionQuery"], (sctx) => {
		const query = sctx.sessionQuery;
		if (query === void 0 || typeof query.readTitleSnapshots !== "function") return;
		sessionTitles = makeSessionTitleResolver(query);
	}));
	/**
	* Persist one pin value into this plugin's own namespace. `pinnedExitId` is
	* a volatile field of the entry's Config, so the path carries the field name
	* in front (`['ipPool', 'pinnedExitId']`) exactly like the card's own writes;
	* an empty value unsets it so the schema default applies rather than a stored
	* empty string. No expectedRevision: this is a single-field path op from a
	* surface that never read the descriptor (the same tolerance
	* provider.ts::removeProviderRoute uses for the sidecar route).
	*/
	const writePin = async (value) => {
		const settings = settingsHandle;
		if (typeof settings?.mutate !== "function") return false;
		await settings.mutate(IP_POOL_NAMESPACE, [value === "" ? {
			op: "unset",
			path: ["ipPool", "pinnedExitId"]
		} : {
			op: "set",
			path: ["ipPool", "pinnedExitId"],
			value
		}]);
		return true;
	};
	if (typeof ctx.inject === "function") Promise.resolve(ctx.inject(["webServer"], (bctx) => {
		if (!bctx.webServer) return;
		const handlers = makeBridgeHandlers(() => controller.runtime, () => ({
			pinnedStrict: controller.settings().pinnedStrict,
			proxyHosts: controller.runtime?.installer?.proxyHosts !== void 0 ? [...controller.runtime.installer.proxyHosts] : controller.settings().proxyHosts.length > 0 ? controller.settings().proxyHosts : ["opencode.ai"],
			proxyPathPrefixes: controller.runtime?.installer?.proxyPathPrefixes !== void 0 ? [...controller.runtime.installer.proxyPathPrefixes] : controller.settings().proxyPathPrefixes.length > 0 ? controller.settings().proxyPathPrefixes : [...DEFAULT_PROXY_PATH_PREFIXES],
			freeEnabled: controller.settings().free.enabled,
			localFallback: controller.settings().localFallback,
			usageScope: controller.settings().usageScope
		}), {
			listLiveModels: deps.listLiveModels,
			writePin,
			usage: deps.usage,
			projectOf: (sessionId) => projectOf?.(sessionId) ?? null,
			sessionTitles: async (ids) => sessionTitles !== void 0 ? sessionTitles(ids) : /* @__PURE__ */ new Map(),
			runSince: () => Date.now() - Math.round(process.uptime() * 1e3)
		});
		const disposers = [];
		for (const route of makeBridgeRoutes(handlers)) disposers.push(bctx.webServer.register(route));
		logger.info(`oc2dsh: ip-pool bridge mounted at ${IP_POOL_BRIDGE_PREFIX} (${disposers.length} routes)`);
		const maybeEffect$1 = bctx.effect;
		if (typeof maybeEffect$1 === "function") maybeEffect$1.call(bctx, () => () => {
			for (const dispose of disposers) dispose();
		});
	}));
	logger.info(`oc2dsh: settings namespace "${IP_POOL_NAMESPACE}" served from the plugin's volatile Config — live apply via 设置 → 插件 → IP 池`);
	const maybeEffect = ctx.effect;
	if (typeof maybeEffect === "function") maybeEffect.call(ctx, () => () => {
		disposed = true;
		controller.runtime?.dispose();
		controller.runtime = null;
	});
	return controller;
}

//#endregion
//#region src/provider.ts
function providerBaseURL(port) {
	return `http://127.0.0.1:${port}/v1`;
}
/**
* Remove the llm-pi-ai provider route left behind by sidecar mode. Adapter
* mode serves the provider id itself; a stale route pointing at a dead
* sidecar port would shadow dispatch and fail every call with a connection
* error. Returns true when a route was actually removed.
*
* DSH 0.1.7 dropped the per-namespace `get(ns)` reader: `SettingsForms` serves
* every declared namespace from one `describe()` call, keyed by entry id, so
* the read is a lookup in that list. The 0.1.1 `get` is still tried first for a
* host that has not moved.
*/
async function removeProviderRoute(seams, providerId) {
	const namespace = readNamespace(seams.settings, "llm-pi-ai");
	if (!namespace?.providers || !(providerId in namespace.providers)) return false;
	if (typeof seams.settings.mutate !== "function") return false;
	await seams.settings.mutate("llm-pi-ai", [{
		op: "unset",
		path: ["providers", providerId]
	}]);
	return true;
}
/**
* One namespace's resolved value, from whichever read face the host offers.
* 0.1.7's `describe()` is preferred: it is the canonical face and the only one
* a 0.1.7 host has, and preferring it means a reduced composition that still
* carries a vestigial `get` is never routed through it.
*/
function readNamespace(settings, ns) {
	if (typeof settings.describe === "function") {
		const descriptors = settings.describe();
		if (Array.isArray(descriptors)) for (const descriptor of descriptors) {
			const row = descriptor;
			if (row?.ns === ns) return row.value;
		}
	}
	if (typeof settings.get === "function") return settings.get(ns);
}
/** Parse the agent's OpenAI-shaped /v1/models reply into pi-ai model entries. */
function toPiAiModels(data) {
	if (!data || typeof data !== "object") return [];
	const list = data.data;
	if (!Array.isArray(list)) return [];
	const seen = /* @__PURE__ */ new Set();
	const entries = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const id = item.id;
		if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
		seen.add(id);
		const name$1 = item.name;
		entries.push({
			id,
			name: typeof name$1 === "string" && name$1.length > 0 ? name$1 : id
		});
	}
	return entries;
}
async function fetchModels(port, token, timeoutMs = 1e4) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(providerBaseURL(port) + "/models", {
			headers: { authorization: `Bearer ${token}` },
			signal: controller.signal
		});
		if (!response.ok) throw new Error(`GET /v1/models failed: HTTP ${response.status}`);
		return toPiAiModels(await response.json());
	} finally {
		clearTimeout(timer);
	}
}
/** GET /healthz (no auth); throws on transport failure or non-2xx. */
async function fetchHealth(port, timeoutMs = 3e3) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
		if (!response.ok) throw new Error(`GET /healthz failed: HTTP ${response.status}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}
/**
* Ensure the credential and the llm-pi-ai provider route reflect the running
* agent. Safe to call repeatedly (every refresh): writes are no-ops when the
* stored shape already matches, and mutate keeps other namespaces/routes
* untouched because it edits only the oc2dsh subtree.
*/
async function registerProvider(seams, target, token, models) {
	await seams.credentials.set(target.apiKeyEnv, token);
	if (typeof seams.settings.mutate !== "function") {
		seams.logger.warn("oc2dsh: settings seam lacks mutate; the sidecar provider route cannot be published");
		return;
	}
	const route = {
		displayName: "oc2dsh",
		apiKeyEnv: target.apiKeyEnv,
		api: "openai-completions",
		baseURL: providerBaseURL(target.port),
		models
	};
	await seams.settings.mutate("llm-pi-ai", [{
		op: "set",
		path: ["providers", target.providerId],
		value: route
	}]);
	seams.logger.info(`oc2dsh: registered llm-pi-ai provider "${target.providerId}" with ${models.length} model(s) at ${route.baseURL}`);
}

//#endregion
//#region src/index.ts
const name = "oc2dsh";
/**
* Only `llm` gates this fiber, because adapter mode (the shipped default) uses
* nothing else: the Zen lane's credential is the literal `'public'`, and the
* ip-pool settings ride the `Config` volatile reference. DSH 0.1.7 composes
* `ctx.settings` as `SettingsForms`, which itself injects
* `['configEditor', 'profileContext']` and ships disabled wherever no
* `profileContext` exists (headless/CLI) — demanding it here kept the whole
* fiber from ever activating, and with it the provider route. Sidecar mode and
* the `configure({ auto: false })` page claim ask for the extra seams through
* `ctx.inject` instead.
*/
const inject = ["llm"];
function apply(ctx, config = {}) {
	const resolved = config;
	const cfg = resolveConfig(config);
	setUserAgentOverride(cfg.userAgent);
	const releaseHeaders = setRequestHeadersReader(() => readVolatile(resolved.requestHeaders));
	if (typeof ctx.effect === "function") ctx.effect.call(ctx, () => releaseHeaders);
	if (cfg.mode === "sidecar") applySidecar(ctx, config);
	else applyAdapter(ctx, resolved, () => readVolatile(resolved.ipPool));
}
/**
* Adapter mode: catalog + LlmAdapter registration. The adapter registration
* is disposed with the plugin fiber (registerAdapter uses ctx.effect
* internally); we only own the catalog refresh loop here.
*/
function applyAdapter(ctx, config, readIpPool) {
	const logger = ctx.logger;
	const ordinary = ordinaryConfig(config);
	const cfg = resolveConfig(ordinary);
	const ready = Promise.resolve({
		port: 0,
		version: "adapter"
	});
	if (!ctx.llm || typeof ctx.llm.registerAdapter !== "function") {
		logger.error("oc2dsh: llm service unavailable; adapter mode cannot register");
		return { ready };
	}
	const dataDir = stateDir();
	const statusPath = join(dataDir, "adapter-status.json");
	const writeStatus = (status, lastError) => {
		writeFile(statusPath, JSON.stringify({
			...status,
			zenUserAgent: opencodeUserAgent(),
			lastError,
			writtenAt: (/* @__PURE__ */ new Date()).toISOString()
		}, null, 2), "utf8").catch(() => {});
	};
	const catalog = new ModelCatalog({
		refreshSeconds: cfg.refreshSeconds,
		cachePath: defaultCachePath(dataDir),
		onRefresh: (status, lastError) => {
			writeStatus(status, lastError);
			if (lastError) logger.warn(`oc2dsh: catalog refresh issue: ${lastError}`);
		}
	});
	const adapter = new ZenAdapter(catalog, {
		firstEventMs: cfg.firstEventMs,
		bodyIdleMs: cfg.bodyIdleMs,
		responsesBodyIdleMs: cfg.responsesBodyIdleMs
	});
	setUsageRecorder(usageStore);
	if (typeof ctx.effect === "function") ctx.effect.call(ctx, () => () => {
		usageStore.dispose();
	});
	else usageStore.load();
	ctx.llm.registerAdapter([PROVIDER_ID], adapter);
	logger.info(`oc2dsh: adapter registered for "${PROVIDER_ID}" (catalog warms up in background)`);
	try {
		applyIpPoolSettings(ctx, ordinary, readIpPool, logger, {
			listLiveModels: () => catalog.list(),
			usage: usageStore
		});
	} catch (err) {
		logger.error(`oc2dsh: ip-pool settings wiring failed; the provider route stays direct: ${err instanceof Error ? err.message : String(err)}`);
	}
	catalog.start().catch((err) => {
		logger.error(`oc2dsh: catalog start failed: ${err instanceof Error ? err.message : String(err)}`);
	});
	if (typeof ctx.inject === "function") Promise.resolve(ctx.inject(["settings"], (sctx) => {
		if (!sctx.settings) return;
		removeProviderRoute({ settings: sctx.settings }, cfg.providerId).then((removed) => {
			if (removed) logger.info(`oc2dsh: removed stale sidecar route for "${cfg.providerId}" from llm-pi-ai settings`);
		}).catch((err) => {
			logger.warn(`oc2dsh: stale route cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	}));
	if (typeof ctx.effect === "function") ctx.effect.call(ctx, () => () => {
		catalog.stop();
	});
	return { ready };
}
function applySidecar(ctx, config) {
	const cfg = resolveConfig(config);
	const paths = configPaths(stateDir());
	const logger = ctx.logger;
	let agent = null;
	let refreshTimer = null;
	let disposed = false;
	let readyResolve = () => {};
	const ready = new Promise((resolve) => {
		readyResolve = resolve;
	});
	const onLog = (line) => {
		logger.info(`[agent] ${line}`);
	};
	/**
	* Sidecar mode's two extra seams, asked for lazily. `inject` declares only
	* `llm` so the shipped adapter mode never waits on services a headless
	* composition does not compose, which means sidecar has to request
	* `credentials`/`settings` itself. A bounded race keeps a composition that
	* composes neither from parking the first refresh forever: the attempt
	* settles on the next tick when the services are already up, and gives up
	* with the warn below when they never arrive.
	*/
	let seams;
	const resolveSeams = () => {
		if (seams !== void 0) return seams;
		const carried = {
			credentials: ctx.credentials,
			settings: ctx.settings
		};
		if (carried.credentials !== void 0 && carried.settings !== void 0 || typeof ctx.inject !== "function") {
			seams = Promise.resolve(carried);
			return seams;
		}
		const arrived = new Promise((resolve) => {
			Promise.resolve(ctx.inject(["credentials", "settings"], (sctx) => {
				resolve({
					credentials: sctx.credentials,
					settings: sctx.settings
				});
			}));
		});
		seams = Promise.race([arrived, new Promise((resolve) => setTimeout(() => resolve(void 0), 2e3))]).then((value) => value ?? carried);
		return seams;
	};
	/**
	* Wait until the agent's model catalog is no longer "pending" (it fetches
	* the live S1 list a moment after listen; registering before that bakes the
	* 3-model static fallback into the DSH provider until the next refresh).
	*/
	async function waitCatalogReady(port, timeoutMs = 15e3) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const status = (await fetchHealth(port, 2e3))?.models?.status;
				if (status && status !== "pending") return;
			} catch {}
			await new Promise((r) => setTimeout(r, 300));
		}
		logger.warn("oc2dsh: catalog still pending after timeout; registering whatever the agent exposes now");
	}
	async function refreshModels(info, token, { waitReady = false } = {}) {
		try {
			if (waitReady) await waitCatalogReady(info.port);
			const models = await fetchModels(info.port, token);
			const { credentials, settings } = await resolveSeams();
			if (credentials && settings) await registerProvider({
				credentials,
				settings,
				logger: {
					info: (m) => logger.info(m),
					warn: (m) => logger.warn(m)
				}
			}, {
				providerId: cfg.providerId,
				apiKeyEnv: cfg.apiKeyEnv,
				port: info.port
			}, token, models);
			else logger.warn("oc2dsh: credentials/settings services unavailable; provider route not registered");
		} catch (err) {
			logger.warn(`oc2dsh: model refresh failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	function scheduleRefresh(info, token) {
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			if (disposed) return;
			refreshModels(info, token).then(() => {
				if (!disposed && agent?.getState() === "ready") scheduleRefresh(info, token);
			});
		}, cfg.refreshSeconds * 1e3);
	}
	async function startOnce() {
		const token = await ensureToken(paths);
		await writeAgentConfig(paths, {
			token,
			refreshSeconds: cfg.refreshSeconds
		});
		agent = new AgentProcess(cfg.agentPath ?? defaultAgentPath(), [
			"--config",
			paths.configPath,
			"--print-ready",
			...cfg.agentArgs ?? []
		], {
			restartDelayMs: cfg.restartDelayMs,
			restartMaxDelayMs: cfg.restartMaxDelayMs,
			maxConsecutiveCrashes: cfg.maxConsecutiveCrashes,
			onLog
		});
		agent.on("exit-restart", (delay, crashes) => {
			logger.warn(`oc2dsh: agent exited unexpectedly; restarting in ${delay}ms (attempt ${crashes})`);
		});
		agent.on("circuit-tripped", (crashes) => {
			logger.error(`oc2dsh: agent crashed ${crashes} times consecutively; giving up`);
		});
		agent.on("state", (state) => {
			if (state === "ready") logger.info("oc2dsh: agent ready");
		});
		const info = await agent.start();
		readyResolve(info);
		await refreshModels(info, token, { waitReady: true });
		scheduleRefresh(info, token);
		return info;
	}
	startOnce().catch((err) => {
		logger.error(`oc2dsh: failed to start agent: ${err instanceof Error ? err.message : String(err)}`);
	});
	if (typeof ctx.effect === "function") ctx.effect.call(ctx, () => () => {
		teardown();
	});
	async function teardown() {
		disposed = true;
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
		if (agent) {
			await agent.dispose().catch(() => {});
			agent = null;
		}
	}
	return { ready };
}
/**
* Locate the agent binary (sidecar mode, legacy — the published package does
* not bundle it): explicit config wins; then a sibling `legacy/agent` dev
* build; then a bare name on PATH.
*/
function defaultAgentPath() {
	const bin = "oc2dsh-agent";
	const exe = process.platform === "win32" ? `${bin}.exe` : bin;
	const here = __dirnameSafe();
	for (const sibling of [join(here, "..", "..", "..", "legacy", "agent", exe), join(here, "..", "..", "legacy", "agent", exe)]) if (existsSync(sibling)) return sibling;
	return exe;
}
function __dirnameSafe() {
	try {
		return fileURLToPath(new URL(".", import.meta.url));
	} catch {
		return ".";
	}
}

//#endregion
export { AgentProcess, Config, apply, configPaths, defaultAgentPath, ensureToken, fetchHealth, fetchModels, inject, name, providerBaseURL, registerProvider, resolveConfig, toPiAiModels, writeAgentConfig };