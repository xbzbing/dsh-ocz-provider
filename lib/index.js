import { S as setUserAgentOverride, _ as deriveRequestIDs, b as opencodeUserAgent, d as chatApiPath, f as isOriginFailure, h as conversationLabel, n as ModelCatalog, o as defaultCachePath, p as laneOrigins, r as ZEN_BASE_URL, u as MIN_CONTEXT_WINDOW, v as disguiseHeaders, x as setRequestHeadersReader } from "./catalog.js";
import { _ as freeLaneGateTool, a as hasRelayEgress, b as isGenuineGateTool, d as hasEnvBlock, f as renderEnvSection, g as freeLaneGateFlatTool, h as SUPERSEDED_GATE_TOOL_NAMES, i as EGRESS_HEADER, l as settleRelayEgress, m as FREE_LANE_GATE_TOOL_NAMES, n as normalizeSmokeContents, o as isRelayTransportFailure, p as withEnvBlock, s as pickRelayEgress, t as DEFAULT_SMOKE_CONTENT, u as statusOfFailure, v as gateToolArgumentBridge, y as isGenuineFlatGateTool } from "./smoke-content.js";
import { c as DIRECT_EXIT_ID, d as attributeUsage, f as emptyTotals, g as resolveLocalIpFamily, h as DEFAULT_LOCAL_IP_FAMILY, l as LOCAL_EXIT_ID, m as usageTracker, p as setUsageRecorder, s as routingContext, t as DEFAULT_PROXY_PATH_PREFIXES, u as UsageTracker } from "./dispatcher.js";
import { a as classifyStreamFailure, c as isRegionBlocked, n as stateDir, r as DEFAULT_SUBSCRIPTION_USER_AGENT, s as isIpReputationRefusal, t as detectProxyProtocol, u as shouldRotate } from "./protocol.js";
import { delimiter, dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createProvider } from "@earendil-works/pi-ai";
import * as openaiCompletions from "@earendil-works/pi-ai/api/openai-completions";
import * as openaiResponses from "@earendil-works/pi-ai/api/openai-responses";
import Schema from "@deepseek-ai/schemastery";
import { get } from "node:http";
import { fileURLToPath } from "node:url";

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
	if (/\bwebsocket\b|other side closed|http2 request did not get a response/i.test(text)) return "TRANSPORT";
	if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|terminated|premature close/i.test(text)) return "TRANSPORT";
	return "UPSTREAM";
}
/**
* mapStopReason (dsh-llm-pi-ai index.js:1286-1330, minus the usage heuristic
* upstream dropped in opencode2api #101, ported as opencode2dsh #101).
*
* A usage-based CONTEXT_WINDOW_EXCEEDED heuristic must NOT come back: the
* request that reaches the wire carries 4-5k tokens more than the host
* estimates its history at (system prompt + the gate's genuine tool
* definitions + serialization), so a conversation filled to the declared
* window arrives with `usage.input > contextWindow` on a HEALTHY finish, and
* rewriting that answered turn as CONTEXT_WINDOW_EXCEEDED — a non-retryable
* code — kills the whole turn. Only the provider's own overflow WORDING (an
* error whose message says context + exceed/window/length/token) classifies
* as such.
*/
function mapStopReason(message) {
	if (message.stopReason === "error" && message.errorMessage !== void 0 && /context/i.test(message.errorMessage) && /exceed|window|length|token/i.test(message.errorMessage)) return {
		kind: "error",
		failure: {
			message: message.errorMessage,
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
async function* toStreamChunks(events, toolNameAlias, toolArgumentBridge) {
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
		case "thinking_end": {
			const partial = event.partial.content[event.contentIndex];
			const signature = typeof partial?.thinkingSignature === "string" && partial.thinkingSignature.length > 0 ? partial.thinkingSignature : void 0;
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "reasoning",
					text: event.content,
					...signature !== void 0 ? { signature } : {}
				}
			};
			break;
		}
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
				reason: mapStopReason(event.message)
			};
			return;
		case "error":
			yield {
				type: "usage",
				usage: mapUsage(event.error.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.error)
			};
			return;
	}
	throw new Error("opencode2dsh: pi-ai event stream ended without done/error");
}

//#endregion
//#region src/adapter/retry-delay.ts
/**
* The schedule: retries 1-6 wait 5/8/10/15/20/30s; retries 7-10 stay on the
* last rung (30s — the documented ceiling). Cumulative worst case per step:
* 5+8+10+15+20+30+30+30+30+30 = 208s of silent waiting before the error
* surfaces.
*/
const RETRY_DELAY_LADDER_MS = Object.freeze([
	5e3,
	8e3,
	1e4,
	15e3,
	2e4,
	3e4
]);
/** A slot untouched for this long restarts the ladder. Comfortably above the
*  worst within-chain gap (a rung wait ≤30s plus a hanging attempt), small
*  enough that an unrelated later request with an identical digest begins at
*  the first rung. */
const STALE_RETRY_GAP_MS = 10 * 6e4;
/** LRU cap: distinct step digests tracked at once (oldest evicted). */
const MAX_RETRY_KEYS = 64;
const slots = /* @__PURE__ */ new Map();
/**
* The identity of one host-retried step: the model plus a digest of the exact
* messages. Retries of the same step re-send byte-identical input; the next
* step (more history) digests differently and starts a fresh ladder.
*/
function retryDelayKey(model, messages) {
	let encoded;
	try {
		encoded = JSON.stringify(messages ?? null) ?? "null";
	} catch {
		encoded = "unhashable";
	}
	return `${model}|${createHash("sha256").update(encoded).digest("hex").slice(0, 24)}`;
}
/**
* The wait this surfaced failure asks the host for: one rung further along the
* key's ladder. Called exactly once per failure that reaches the host, i.e.
* once per scheduled host retry.
*/
function nextRetryDelayMs(key, now = Date.now()) {
	const existing = slots.get(key);
	if (existing === void 0 || now - existing.at > STALE_RETRY_GAP_MS) {
		slots.delete(key);
		slots.set(key, {
			count: 1,
			at: now
		});
	} else {
		existing.count += 1;
		existing.at = now;
		slots.delete(key);
		slots.set(key, existing);
	}
	while (slots.size > MAX_RETRY_KEYS) {
		const oldest = slots.keys().next().value;
		if (oldest === void 0) break;
		slots.delete(oldest);
	}
	const slot = slots.get(key);
	return RETRY_DELAY_LADDER_MS[Math.min((slot?.count ?? 1) - 1, RETRY_DELAY_LADDER_MS.length - 1)] ?? RETRY_DELAY_LADDER_MS[0];
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
				thinking: block.text,
				...block.signature !== void 0 && block.signature.length > 0 ? { thinkingSignature: block.signature } : {}
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
	const systemParts = [];
	if (typeof options.system === "string" && options.system.length > 0) systemParts.push(options.system);
	let leading = true;
	for (const message of options.messages) {
		if (message.role === "system") {
			const text = flattenText(message);
			if (text.length === 0) continue;
			if (leading) systemParts.push(text);
			else messages.push({
				role: "user",
				content: text,
				timestamp: 0
			});
			continue;
		}
		leading = false;
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
	if (systemParts.length > 0) context.systemPrompt = [...new Set(systemParts)].join("\n\n");
	const tools = options.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
	if (tools && tools.length > 0) context.tools = tools;
	return context;
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
const GATE_TOOL_ALIASES = { shell: "bash" };
/** The name of a tool entry in either lane's shape (chat nests it, responses
*  hoists it). */
function toolEntryName(entry, flat) {
	if (typeof entry !== "object" || entry === null) return void 0;
	const record = entry;
	const name$1 = flat ? record.name : record.function?.name;
	return typeof name$1 === "string" ? name$1 : void 0;
}
/**
* Drop a SUPERSEDED 1.x wire name (`bash`) from a copied tool array. The
* host's own `bash` rides back in through the `shell` alias
* ({@link GATE_TOOL_ALIASES}), so the wire never mixes a 1.x tool name into
* the 2.x recipe. Returns the same array reference when nothing matched.
*/
function dropSupersededTools(tools, flat) {
	const next = tools.filter((tool) => {
		const name$1 = toolEntryName(tool, flat);
		return name$1 === void 0 || !SUPERSEDED_GATE_TOOL_NAMES.includes(name$1);
	});
	return next.length === tools.length ? tools : next;
}
/** Text of one message's content: a plain string, or the text parts of an array. */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (typeof part === "string") {
			text += part;
			continue;
		}
		if (typeof part !== "object" || part === null) continue;
		const value = part.text;
		if (typeof value === "string") text += value;
	}
	return text;
}
/** Both roles that hold the system prompt: chat sends `system`, newer APIs `developer`. */
function isSystemRole(role) {
	return role === "system" || role === "developer";
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
function shapeEnvMessages(list, partType = "text", facts) {
	let index = -1;
	for (let i = 0; i < list.length; i += 1) {
		const entry$1 = list[i];
		if (typeof entry$1 !== "object" || entry$1 === null) continue;
		if (!isSystemRole(entry$1.role)) continue;
		index = i;
		break;
	}
	if (index === -1) return {
		changed: true,
		list: [{
			role: "system",
			content: renderEnvSection(facts)
		}, ...list]
	};
	const entry = list[index];
	const content = entry.content;
	if (hasEnvBlock(contentText(content))) return {
		changed: false,
		list
	};
	const next = [...list];
	if (Array.isArray(content)) next[index] = {
		...entry,
		content: [...content, {
			type: partType,
			text: renderEnvSection(facts)
		}]
	};
	else next[index] = {
		...entry,
		content: withEnvBlock(typeof content === "string" ? content : "", facts)
	};
	return {
		changed: true,
		list: next
	};
}
/** The same rule for a Responses `instructions` string. */
function shapeEnvInstructions(instructions, facts) {
	if (hasEnvBlock(instructions)) return {
		changed: false,
		instructions
	};
	return {
		changed: true,
		instructions: withEnvBlock(instructions, facts)
	};
}
/** Responses uses flat function tools and its Zen gateway accepts auto only. */
function ensureResponsesFreeLaneShape(payload) {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return void 0;
	const body = payload;
	if (!Array.isArray(body.input)) return void 0;
	const original = Array.isArray(body.tools) ? body.tools : [];
	const dropped = dropSupersededTools(original, true);
	const tools = [...dropped];
	let changed = dropped !== original;
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
	const instructions = typeof body.instructions === "string" ? body.instructions : void 0;
	const env = instructions !== void 0 && instructions !== "" ? shapeEnvInstructions(instructions) : shapeEnvMessages(body.input, "input_text");
	const invalidChoice = body.tool_choice !== void 0 && body.tool_choice !== "auto";
	if (!changed && !invalidChoice && !env.changed) return void 0;
	return {
		...body,
		...env.list !== void 0 ? { input: env.list } : {},
		...env.changed && typeof env.instructions === "string" ? { instructions: env.instructions } : {},
		tools,
		tool_choice: "auto"
	};
}
/** The client's chat-completions body keys, in its order. */
const CLIENT_CHAT_KEY_ORDER = [
	"model",
	"messages",
	"tools",
	"stream",
	"stream_options",
	"max_completion_tokens"
];
/**
* The same body with the client's key order: its six keys first, every other
* key after them in its original order. Values are untouched.
*/
function inClientKeyOrder(body) {
	const ordered = {};
	for (const key of CLIENT_CHAT_KEY_ORDER) if (key in body) ordered[key] = body[key];
	for (const [key, value] of Object.entries(body)) if (!(key in ordered)) ordered[key] = value;
	return ordered;
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
function ensureFreeLaneShape(payload) {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return void 0;
	const body = payload;
	if (!Array.isArray(body.messages)) return void 0;
	const original = Array.isArray(body.tools) ? body.tools : [];
	const dropped = dropSupersededTools(original, false);
	const tools = [...dropped];
	let changed = dropped !== original;
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
	const env = shapeEnvMessages(body.messages, "text");
	if (!changed && !dropsNone && !env.changed) return void 0;
	const next = {
		...body,
		tools
	};
	if (env.list !== void 0) next.messages = env.list;
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
* (any other value is a hard 400), and `none` is the
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
* so a mid-stream cut cannot escape the retry budget.
*
* The WAIT between retries is not this policy's exponential schedule: stream()
* tags every retryable failure with retry-delay.ts's ladder through
* `failure.providerRetryAfterMs`, and dsh-llm-retry waits that value VERBATIM
* (5/8/10/15/20/30s, then 30s for rungs 7-10 — cumulative worst case per step
* ≈ 208s of silent waiting). initialDelayMs/maxDelayMs/jitterRatio stay as the
* fallback for an untagged failure, and maxDelayMs doubles as the ladder
* ceiling: a providerRetryAfterMs ABOVE it makes normal mode give up without
* retrying (dsh-llm-retry recover()), so every rung must stay ≤ 30s — pinned
* by test/retry-delay.test.ts.
*/
const FREE_LANE_RETRY_POLICY = Object.freeze({
	mode: "normal",
	maxRetries: 10,
	retryableCodes: Object.freeze([
		"EMPTY_RESPONSE",
		"RATE_LIMIT",
		"SERVER",
		"TIMEOUT",
		"TRANSPORT"
	]),
	initialDelayMs: 5e3,
	maxDelayMs: 3e4,
	jitterRatio: .2
});
/**
* Tag a retryable failure with the next ladder rung (retry-delay.ts): the
* host waits it verbatim in place of its exponential schedule and still counts
* it against maxRetries as usual. The key is the step request itself, so a
* host retry of the same step walks the ladder and a fresh step starts over —
* mirroring the host's projection, which resets on step/start. Untagged paths:
* non-retryable codes (the host never waits on them anyway) and the thinking
* recovery, whose max-tokens finish is not an error.
*/
function withRetryDelay(finish, options) {
	const reason = finish.reason;
	if (reason.kind !== "error") return finish;
	if (!FREE_LANE_RETRY_POLICY.retryableCodes.includes(reason.failure.code)) return finish;
	const providerRetryAfterMs = nextRetryDelayMs(retryDelayKey(options.model, options.messages));
	return {
		...finish,
		reason: {
			...reason,
			failure: {
				...reason.failure,
				providerRetryAfterMs
			}
		}
	};
}
/**
* Stream-liveness watchdogs: neither fetch nor pi-ai owns a body-silence
* timeout, so a tunnel that stands but never streams hangs the turn forever.
* Both messages carry "timeout" so classifyStreamFailure maps them to
* 'transport' and the rotate loop gets to move the session to a live exit.
*/
const WATCHDOG_FIRST_MESSAGE = "oc2dsh: first stream event timeout (exit silent before any response)";
const WATCHDOG_IDLE_MESSAGE = "oc2dsh: stream body idle timeout (exit went silent mid-response)";
/** Default watchdog windows (docs/design.md §6.4); injected in tests. */
const DEFAULT_FIRST_EVENT_MS = 3e4;
const DEFAULT_BODY_IDLE_MS = 12e4;
/**
* Wider body-idle window for Responses models (`muse-spark-*`): their
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
/** A stream that carries one terminal error and nothing else (dispatch refusal). */
function failedStream(message, model) {
	return (async function* () {
		yield terminalErrorEvent(message, model);
	})();
}
/**
* Responses-only models: `muse-spark-*` return a bare 500 on
* `POST /inference/v1/chat/completions` but 200 on
* `POST /inference/v1/responses` (opencode #44659/#44847, DSH #3957). Route by
* model id; extend this list if the lane moves more models (candidates:
* gpt-5.6-luna, grok-4.6).
*
* The free-lane gate covers BOTH surfaces: `/responses` carries the same
* tools, `<env>` block and session shape as chat (adapter/messages.ts).
*/
/**
* Vision gate: whether a model accepts image input on the Zen lane.
*
* models.dev `modalities.input` decides whenever it speaks — the same
* declaration that already drives `limit.context` / `limit.output` lists the
* input kinds each model takes, and the free roster rotates constantly, so a
* family-scoped pattern cannot track it: space-bunny-free,
* muse-spark-1.*-contributor-free, mimo-v2.5-free, fledge-alpha-free and
* longcat-2.5-preview-free all declare `image` upstream and sit outside the
* mimo family. A declared text-only model stays refused, so the gate still
* protects the lane in both directions.
*
* The built-in pattern remains the fallback for the ids whose image input is
* verified end-to-end (the mimo-v2.6 family), so metadata being pending,
* absent or silent never changes what those models can do. Models that end up
* text-only make DSH's attachment gate (`Model "<id>" does not support image
* input.`) and pi-ai's image downgrade refuse image parts instead of
* forwarding them to a model that cannot see them.
*/
function isVisionModel(id, declaredModalities) {
	if (Array.isArray(declaredModalities) && declaredModalities.length > 0) return declaredModalities.includes("image");
	return /^mimo-v2\.6/i.test(String(id ?? ""));
}
/** The pi-ai model literal for one catalog entry (exported for shape tests). */
function toPiModel(id, reasoning, limits, declaredModalities, baseUrl = ZEN_BASE_URL) {
	return {
		id,
		name: id,
		api: apiForModel(id),
		provider: PROVIDER_ID,
		baseUrl: `${baseUrl.replace(/\/+$/, "")}/v1`,
		reasoning,
		compat: {
			requiresReasoningContentOnAssistantMessages: true,
			supportsStore: false,
			supportsDeveloperRole: false
		},
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
	/** The lane's origin ladder, primary first (adapter/lane.ts). */
	#origins;
	/**
	* The Bun relay (relay/supervisor.ts), when one is running or expected.
	* Read PER REQUEST (`baseUrlFor`), because the relay can restart onto a
	* different port mid-session; null = no relay configured, requests go direct.
	*/
	#relay;
	constructor(catalog, options = {}) {
		this.#catalog = catalog;
		this.#relay = options.relay ?? null;
		this.#firstEventMs = options.firstEventMs ?? DEFAULT_FIRST_EVENT_MS;
		this.#bodyIdleMs = options.bodyIdleMs ?? DEFAULT_BODY_IDLE_MS;
		this.#responsesBodyIdleMs = options.responsesBodyIdleMs ?? RESPONSES_BODY_IDLE_MS;
		this.#origins = laneOrigins(options.zenBaseUrl ?? ZEN_BASE_URL, options.fallbackBaseUrl);
		if (options.providerOverride !== void 0) {
			this.#provider = options.providerOverride;
			this.#responsesProvider = null;
			return;
		}
		const baseUrl = `${this.#origins[0] ?? ZEN_BASE_URL}/v1`;
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
	* registration, index.js:1208). The anonymous free lane 429s in bursts with
	* contention windows that outlast the host default (5 retries over ~15s),
	* so transient throttling would surface as user-visible errors. This policy
	* stretches the silent absorption window to ~208s per step (10 retries;
	* waits come from the 5s/8s/10s/15s/20s/30s ladder in retry-delay.ts,
	* tagged per failure as providerRetryAfterMs; the exponential backoff below
	* is only the untagged fallback). Retryable codes mirror the host default
	* set; deterministic failures (AUTH, REGION_BLOCKED, INVALID_REQUEST) stay
	* non-retryable.
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
	* duplicates). Async on purpose: the host awaits this call and caches its
	* answer per host generation, so the first read waits — bounded, inside the
	* catalog — for the live Zen fetch instead of handing the host the
	* staticFreeModels bootstrap list it would then keep showing.
	*/
	async listModels(provider) {
		this.#relay?.warm();
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
		this.#relay?.warm();
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
			if (finish) yield withRetryDelay(finish, options);
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
		const model = toPiModel(options.model, this.#catalog.reasoningCapability(options.model)?.reasoning === true, this.#catalog.limits?.(options.model), this.#catalog.modalities?.(options.model), this.#origins[0] ?? ZEN_BASE_URL);
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
		const origins = this.#origins;
		const originLabel = (origin) => origin.replace(/^https?:\/\//, "");
		let attempt = 0;
		let originIndex = 0;
		/** EXIT rotations actually spent — the origin switches above are not ones. */
		let rotations = 0;
		for (;;) {
			const origin = origins[originIndex] ?? origins[0] ?? ZEN_BASE_URL;
			const attemptStart = routingContext.run(contextStore, () => this.#eventsFor(options, context, ids, model, origin));
			if (attemptStart.meta.egress !== null) contextStore.exitId = attemptStart.meta.egress.exitId;
			else if (attemptStart.meta.viaRelay && attemptStart.meta.fail === null) contextStore.exitId = LOCAL_EXIT_ID;
			const events = attemptStart.stream;
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
				settleRelayEgress(attemptStart.meta.egress, { status: 200 });
				yield* attributeUsage(contextStore, toStreamChunks(pumpLive(), GATE_TOOL_ALIASES, argumentBridge));
				return;
			}
			if (preContentFailure === null && !deliveredContent) {
				settleRelayEgress(attemptStart.meta.egress, { status: 200 });
				yield* attributeUsage(contextStore, toStreamChunks(replayBuffered(), GATE_TOOL_ALIASES, argumentBridge));
				return;
			}
			const failureMessage = preContentFailure.message;
			const failure = classifyStreamFailure(failureMessage);
			const deterministic = isRegionBlocked(failureMessage);
			const failureStatus = isRelayTransportFailure(failureMessage) ? void 0 : statusOfFailure(failureMessage);
			settleRelayEgress(attemptStart.meta.egress, failureStatus !== void 0 ? { status: failureStatus } : { transport: failure === "transport" });
			const abusive = isIpReputationRefusal(failureMessage);
			const nextOrigin = origins[originIndex + 1];
			if (nextOrigin !== void 0 && isOriginFailure(failureMessage)) {
				rotateStory.push(`#${attempt + 1} ${failure ?? "origin"} ${originLabel(origin)} -> ${originLabel(nextOrigin)}: ${failureMessage.slice(0, 60)}`);
				originIndex += 1;
				continue;
			}
			const rotate = failure !== null && attempt < MAX_ROTATES && shouldRotate(failure, options.model, ids.session, attempt + 1, deterministic, abusive);
			rotateStory.push(`#${attempt + 1} ${failure ?? "unknown"}: ${failureMessage.slice(0, 80)}`);
			if (!rotate) {
				const story = rotateStory.length > 1 ? ` (oc2dsh ${rotations > 0 ? `轮换 ${rotations} 次后放弃` : "两条来源均失败"}: ${rotateStory.join(" -> ")})` : "";
				for (let i = 0; i < buffered.length; i += 1) {
					const e = buffered[i];
					if (e.type === "error" && e.error) {
						e.error.errorMessage = `${e.error.errorMessage}${story}`;
						break;
					}
					if (e.type === "done" && e.message?.stopReason === "error") {
						e.message.errorMessage = `${e.message.errorMessage}${story}`;
						break;
					}
				}
				yield* attributeUsage(contextStore, toStreamChunks(replayBuffered(), GATE_TOOL_ALIASES, argumentBridge));
				return;
			}
			attempt += 1;
			rotations += 1;
			originIndex = 0;
		}
	}
	#eventsFor(options, context, ids, model, origin) {
		const isResponses = model.api === "openai-responses";
		const requestedReasoning = typeof options.reasoningEffort === "string" ? options.reasoningEffort : typeof options.reasoning === "string" ? options.reasoning : void 0;
		const responseReasoning = isResponses ? normalizeResponsesEffort(requestedReasoning) : void 0;
		const effortWire = isResponses ? void 0 : reasoningEffortWire(options.reasoningEffort);
		const onPayload = isResponses ? (payload) => {
			const normalized = normalizeResponsesPayload(payload, responseReasoning);
			return ensureResponsesFreeLaneShape(normalized ?? payload) ?? normalized;
		} : (payload) => {
			const shaped = ensureFreeLaneShape(payload);
			if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return shaped;
			const body = shaped ?? payload;
			return inClientKeyOrder(effortWire === void 0 ? body : {
				...body,
				reasoning_effort: effortWire
			});
		};
		const provider = isResponsesModel(model.id) && this.#responsesProvider ? this.#responsesProvider : this.#provider;
		const relayBase = this.#relay?.baseUrlFor(origin ?? this.#origins[0] ?? ZEN_BASE_URL) ?? null;
		const viaRelay = relayBase !== null;
		const decision = viaRelay && hasRelayEgress() ? pickRelayEgress({
			model: options.model,
			session: ids.session
		}) : null;
		const egress = decision !== null && !("fail" in decision) ? decision : null;
		const refusal = decision !== null && "fail" in decision ? decision.fail : null;
		const meta = {
			egress,
			viaRelay,
			fail: refusal
		};
		if (refusal !== null) return {
			stream: failedStream(refusal, model),
			meta
		};
		const laneOrigin = origin ?? this.#origins[0] ?? ZEN_BASE_URL;
		const apiPath = chatApiPath(laneOrigin);
		const targetBase = relayBase !== null ? `${relayBase}${apiPath}` : `${laneOrigin.replace(/\/+$/, "")}${apiPath}`;
		const target = {
			...model,
			baseUrl: targetBase
		};
		const headers = disguiseHeaders(ids);
		if (meta.egress !== null) headers[EGRESS_HEADER] = meta.egress.url;
		return {
			meta,
			stream: provider.streamSimple(target, context, {
				apiKey: ANONYMOUS_KEY,
				sessionId: ids.session,
				headers,
				onPayload,
				signal: options.signal,
				maxRetries: 0,
				temperature: options.temperature,
				maxTokens: options.maxTokens,
				...responseReasoning ? { reasoning: responseReasoning } : {}
			})
		};
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
	localIpFamily: Schema.string().default(DEFAULT_LOCAL_IP_FAMILY),
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
		localIpFamily: resolveLocalIpFamily(raw.localIpFamily),
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
		localIpFamily: value.localIpFamily,
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
const defaults = { refreshSeconds: 300 };
function resolveConfig(config = {}) {
	return {
		...defaults,
		...config
	};
}
/**
* The plugin's `Config` — the whole DSH settings contract in one schema.
* DSH 0.1.7 has no imperative `ctx.settings.register(ns, schema)`: a plugin
* declares editable settings by exporting this schema, and dsh-settings derives
* the served namespace from the Loader entry id. Three consequences shape it:
*
*  - `ipPool` is ONE `.volatile()` node, so the whole subtree is the settings
*    form (nesting `.volatile()` deeper is a hard schemastery error, and
*    per-field marks would fragment the card's form value into siblings).
*  - `requestHeaders` and `modelContextWindows` are separate volatile
*    dictionaries, read at request / model-resolution time.
*  - the remaining fields are ORDINARY configuration, which `volatileForm()`
*    drops from the form; `userAgent` remains a profile-only field.
*
* The reference is `dsh-llm-deepseek`'s `deepSeekConfigFields`.
*/
/**
* `requestHeaders` must stay a PLAIN dict — never a `.transform()`.
*
* dsh-settings rebuilds the served form from `Config.toJSON()` (`plainSchema`)
* and serializes it a second time for the browser; a transform's `callback`
* survives the first `toJSON()` but is dropped on that rebuild, so the
* rehydrated node throws `callback is not a function`, the
* `ConfigFormController.decode()` result is undefined, and the 配置 card never
* leaves its loading state. Validation therefore lives at the editor
* (`parseRequestHeaders`, strict) and at the request boundary
* (`sanitizeRequestHeaders`, lenient), not in the schema;
* `test/request-headers.test.ts` and `scripts/smoke-dsh-compat.mjs` guard the
* round trip.
*/
const RequestHeadersConfigSchema = Schema.dict(Schema.string()).default({}).volatile();
/**
* Per-model context windows, also a PLAIN dict for the same reason as
* `requestHeaders`: no `.transform()` (or any callback) may survive into the
* served form. Range/format validation lives in src/model-context.ts at the
* editor and catalog boundaries; the schema only keeps the value a dictionary
* of positive integers so the form still decodes a hand-edited profile.
*/
const ModelContextWindowsConfigSchema = Schema.dict(Schema.number().step(1).min(MIN_CONTEXT_WINDOW)).default({}).volatile();
/**
* The Bun relay node, as a plain schemastery object. Ordinary config (not
* volatile): it is a profile/yml knob, it changes when the operator installs
* or moves bun, and it must not depend on the settings form round-tripping —
* see the `requestHeaders` note above for what a callback-bearing node does to
* the whole configuration page.
*/
const RelayConfigSchema = Schema.object({
	enabled: Schema.boolean().default(true),
	bunPath: Schema.string().default(""),
	port: Schema.number().step(1).min(0).max(65535).default(0),
	upstream: Schema.string().default("")
});
const Config = Schema.object({
	refreshSeconds: Schema.number().step(1).min(1).default(defaults.refreshSeconds),
	firstEventMs: Schema.number().step(1).min(1).max(6e5),
	bodyIdleMs: Schema.number().step(1).min(1).max(6e5),
	responsesBodyIdleMs: Schema.number().step(1).min(1).max(6e5),
	userAgent: Schema.string(),
	requestHeaders: RequestHeadersConfigSchema,
	modelContextWindows: ModelContextWindowsConfigSchema,
	relay: RelayConfigSchema,
	ipPool: IpPoolConfigSchema.volatile()
});
/**
* The ordinary half of a resolved config, for the call sites that reconfigure
* the pool runtime and need a plain object. Spreading the whole config instead
* would hand `startIpPool` the volatile reference where it expects values.
*/
function ordinaryConfig(config) {
	const { ipPool: _ipPool, requestHeaders: _requestHeaders, modelContextWindows: _modelContextWindows,...ordinary } = config;
	return ordinary;
}

//#endregion
//#region src/pool/usage-store.ts
/** How long day buckets are kept (docs/ip-pool.md §5.6). */
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
	/** This process's buckets — the 本次重启 scope. */
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
	* Operator-facing clear (docs/ip-pool.md §5.6): drop every bucket AND make
	* the empty document the one on disk, so a restart cannot bring the numbers
	* back.
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
//#region src/ip-pool-settings/views.ts
/**
* Sessions listed in the 流量 tab. Shared by the status prefetch and the view
* builder so both slice the ledger to the same population — the title join
* must ask for exactly the ids the table will render.
*/
const USAGE_SESSION_LIMIT = 20;
/** Build the /status view over the live runtime (or a disabled stub). */
function buildStatusView(runtime, pinnedStrict, proxyHosts, options = {}) {
	const proxyPathPrefixes = options.proxyPathPrefixes ?? [...DEFAULT_PROXY_PATH_PREFIXES];
	const store = options.usage;
	const scope = options.usageScope ?? "total";
	/**
	* Per-exit numbers follow the scope switch: the ledger's persisted buckets
	* for 总览, the in-process tracker for 本次重启. A composition with no ledger
	* falls back to the tracker.
	*/
	const tokensOf = (id) => store === void 0 ? usageTracker.totals(id) : store.exitTotals(id, scope);
	/**
	* Recent speed always reads the PROCESS tracker's rolling window: the
	* lifetime ledger cannot answer "how fast is it now", and the window has no
	* scope dimension.
	*/
	const tracker = store === void 0 ? usageTracker : store.run;
	/** 最后使用: the live dispatch stamp for 本次重启, the ledger's last recorded
	*  response for 总览 (a dispatch that produced no usage event never reached
	*  the ledger, so the two are not the same signal — the column says which). */
	const lastUsedOf = (id, live) => store === void 0 || scope === "run" ? live : store.exitLastUsedAt(id, "total");
	const snapshot = runtime ? runtime.pool.snapshot() : {
		total: 0,
		bySource: {
			manual: 0,
			subscription: 0,
			goproxy: 0
		},
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
			note: entry.health.note,
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
	/** Usable exits across the whole pool, any source. */
	const availableTotal = exits.filter((exit) => exit.state === "ok").length;
	/**
	* Is the pin actually carrying traffic? Only the two states that stop
	* `isUsable()` on their own are reported: dead and a live cooldown. A
	* (exit, model) ban cannot be answered here — it depends on the model the
	* next request picks — and inventing an answer would be worse than silence.
	*/
	const pinnedRow = snapshot.pinned !== "" && snapshot.pinned !== LOCAL_EXIT_ID ? exits.find((exit) => exit.id === snapshot.pinned) : void 0;
	const pinnedSkip = pinnedRow === void 0 ? null : pinnedRow.state === "dead" ? "dead" : pinnedRow.cooling ? "cooling" : null;
	return {
		enabled: runtime !== null && runtime.installer.enabled,
		deferredReason: runtime !== null && !runtime.installer.enabled ? runtime.installer.deferredReason ?? "" : "",
		total: snapshot.total,
		bySource: snapshot.bySource,
		availableTotal,
		poolSize: runtime ? runtime.pool.poolSize : 10,
		pinned: snapshot.pinned !== "" ? {
			id: snapshot.pinned,
			strict: pinnedStrict,
			local: snapshot.pinned === LOCAL_EXIT_ID
		} : null,
		pinnedSkip,
		proxyHosts,
		proxyPathPrefixes,
		exits,
		prober: runtime ? runtime.prober.stats : {
			queued: 0,
			inFlight: 0,
			enqueued: 0,
			completed: 0
		},
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
		recentSpeed: tracker.speedAll(),
		todayTokens: todayTokensOf(store, now),
		localFallback: runtime?.installer?.localFallback ?? options.localFallback ?? false,
		localIpFamily: resolveLocalIpFamily(runtime?.installer?.localIpFamily ?? options.localIpFamily),
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
* off). Both left this machine, so the row sums them — requests and tokens on
* the same recorded-usage-event basis as the per-exit column (a response with
* no usage event is not counted).
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
* session title; the recorded first-prompt fragment is only the fallback for
* sessions the host cannot title (docs §5.5).
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

//#endregion
//#region src/ip-pool-settings/guard.ts
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
/**
* The full admission decision: the HTTP status to refuse with, or undefined
* when the request may proceed. Fails closed when the connection service is
* absent or throws.
*/
function bridgeRejection(request, connection) {
	if (!isTrustedBridgeRequest(request)) return 403;
	const fence = connection?.();
	if (fence === void 0 || typeof fence.requestRejection !== "function") return 403;
	let rejection;
	try {
		rejection = fence.requestRejection(request);
	} catch {
		return 403;
	}
	if (rejection === void 0) return void 0;
	return rejection === 401 ? 401 : 403;
}

//#endregion
//#region src/ip-pool-settings/handlers.ts
/** Build the bridge handlers over the runtime + current settings. */
function makeBridgeHandlers(runtime, settings, deps = {}) {
	return {
		async status() {
			const current = settings();
			/**
			* The top-session join: ask the host for the titles of exactly the rows
			* the view will render, before building it — the resolver is TTL-cached,
			* so the modal's 2s poll mostly reads cache. A missing resolver or a
			* failed batch just yields no map: every row keeps its recorded label
			* and /status still answers.
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
				message: "probe scope must be 'all', 'exit' or 'subscription'"
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
				/**
				* Verify BEFORE pinning (AGENTS.md egress-row hygiene): a pin makes
				* `pick()` hand the row to every request, so a row whose protocol was
				* typed wrong (or a port with nothing behind it) fails EVERY request
				* instead of one. The two outcomes are deliberately different:
				*   - a listener that speaks the OTHER protocol is self-correcting:
				*     the row is relabelled and the pin proceeds (the operator's
				*     intent — "route through this port" — is unambiguous);
				*   - nothing answering at all is refused, because no relabel can make
				*     it work and a pin would silence the whole lane.
				* Rows with measured facts (a verified subscription exit) skip the
				* probe: their protocol came from a real request, so probing would
				* only add latency to every pin click.
				*/
				let corrected = null;
				if (raw !== "" && raw !== LOCAL_EXIT_ID) {
					const node = rt.pool.get(raw);
					if (node === void 0 || node.exitIP === "" || node.source === "manual") {
						let found;
						try {
							found = await (deps.detectProtocol ?? detectProxyProtocol)(raw);
						} catch {
							found = null;
						}
						if (found === null) return {
							ok: false,
							code: "exit-unreachable",
							message: `出口 ${raw} 没有监听（或不是代理），未固定：换一个出口，或先确认该端口已启动`
						};
						if (node !== void 0 && found !== node.protocol) {
							rt.pool.refresh(raw, { protocol: found });
							corrected = found;
						}
						rt.pool.revive(raw);
					}
				}
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
						persisted,
						...corrected === null ? {} : { corrected }
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

//#endregion
//#region src/ip-pool-settings/routes.ts
/** Bridge route prefix (same-origin, loopback-only). */
const IP_POOL_BRIDGE_PREFIX = "/api/oc2dsh/ip-pool";
/** Cap on JSON request bodies (a probe trigger is tiny). */
const MAX_JSON_BODY_BYTES = 16 * 1024;
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
/** Build the guarded routes. The route bodies are host-shaped (node:http req/res). */
function makeBridgeRoutes(handlers, deps = {}) {
	const rejection = (req) => deps.guard !== void 0 ? deps.guard(req) ? void 0 : 403 : bridgeRejection(req, deps.connection);
	const admit = (req, res) => {
		const status = rejection(req);
		if (status !== void 0) {
			writeJson(res, status, { error: status === 401 ? "unauthorized" : "forbidden" });
			return false;
		}
		if (req.method !== "POST") {
			writeJson(res, 405, { error: "method not allowed: " + (req.method ?? "") });
			return false;
		}
		return true;
	};
	/** Admit, run, and turn a throw into the JSON 500 envelope. */
	const route = (path, run) => ({
		kind: "exact",
		path,
		handler: async (req, res) => {
			const rawReq = req;
			const rawRes = res;
			try {
				if (!admit(rawReq, rawRes)) return;
				await run(rawReq, rawRes);
			} catch (err) {
				if (rawRes.headersSent === true) return;
				writeJson(rawRes, 500, {
					ok: false,
					code: "internal",
					message: err instanceof Error ? err.message : String(err)
				});
			}
		}
	});
	/** A route with no request body (/status, /models). */
	const postRoute = (path, handle) => route(path, async (_req, res) => {
		writeJson(res, 200, await handle());
	});
	/** A route that reads a JSON object body. */
	const jsonRoute = (path, handle) => route(path, async (req, res) => {
		let body;
		try {
			body = await readJsonBody(req);
		} catch {
			body = void 0;
		}
		if (body === void 0 || typeof body !== "object" || body === null) {
			writeJson(res, 400, {
				ok: false,
				code: "settings-rejected",
				message: "unreadable JSON body"
			});
			return;
		}
		writeJson(res, 200, await handle(body));
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
const defaultAssemble = (relayBaseUrl) => async (config, logger) => {
	const { startIpPool } = await import("./ip-pool.js");
	return startIpPool(config, logger, relayBaseUrl === void 0 ? {} : { relayBaseUrl });
};
/**
* Register the ip-pool namespace, own the live runtime, mount the bridge.
* Returns the controller handle; disposal rides the plugin fiber.
*/
function applyIpPoolSettings(ctx, ordinary, readIpPool, logger, deps = {}) {
	const assemble = deps.assemble ?? defaultAssemble(deps.relayBaseUrl);
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
	* The ledger records SESSION ids only (a request carries no workspace), and
	* the registry is the authority on which project each session belongs to
	* (`list()` returns every workspace with its `sessionIds`), so this is a
	* read-time join (docs §5.6). Optional service: a composition without the
	* registry simply reports no project.
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
	* The ledger records the first user turn at request time, so rows fall back
	* to that fragment; the real title lives in the host's session log
	* (`session/title` events) under `ctx.sessionQuery`, joined READ-TIME — the
	* same optional-service pattern as projectOf: no service, or an empty title
	* corpus, keeps the recorded labels (docs §5.5).
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
	* surface that never read the descriptor.
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
	/**
	* The host's `connection` service authenticates bridge callers (guard.ts):
	* read at request time, so the routes can mount before it composes, and a
	* request that arrives while it is absent is refused (403), never admitted.
	*/
	let connection;
	if (typeof ctx.inject === "function") Promise.resolve(ctx.inject(["connection"], (cctx) => {
		const service = Reflect.get(cctx, "connection");
		if (service === void 0 || typeof service.requestRejection !== "function") return;
		connection = service;
		const maybeEffect$1 = cctx.effect;
		if (typeof maybeEffect$1 === "function") maybeEffect$1.call(cctx, () => () => {
			if (connection === service) connection = void 0;
		});
	}));
	if (typeof ctx.inject === "function") Promise.resolve(ctx.inject(["webServer"], (bctx) => {
		if (!bctx.webServer) return;
		const handlers = makeBridgeHandlers(() => controller.runtime, () => ({
			pinnedStrict: controller.settings().pinnedStrict,
			proxyHosts: controller.runtime?.installer?.proxyHosts !== void 0 ? [...controller.runtime.installer.proxyHosts] : controller.settings().proxyHosts.length > 0 ? controller.settings().proxyHosts : ["opencode.ai"],
			proxyPathPrefixes: controller.runtime?.installer?.proxyPathPrefixes !== void 0 ? [...controller.runtime.installer.proxyPathPrefixes] : controller.settings().proxyPathPrefixes.length > 0 ? controller.settings().proxyPathPrefixes : [...DEFAULT_PROXY_PATH_PREFIXES],
			localFallback: controller.settings().localFallback,
			localIpFamily: controller.settings().localIpFamily,
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
		for (const route of makeBridgeRoutes(handlers, { connection: () => connection })) disposers.push(bctx.webServer.register(route));
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
//#region src/relay/supervisor.ts
/** The lane origin the relay forwards to by default. */
const DEFAULT_RELAY_UPSTREAM = "https://opencode.ai";
/** Readiness marker the relay prints on stdout (relay/oc2dsh-relay.mjs). */
const READY_MARKER = "OC2DSH_RELAY_READY";
/** Health path behind the token prefix (relay/oc2dsh-relay.mjs). */
const HEALTH_PATH = "/__oc2dsh/health";
/** Startup stdout kept for the failure message; a longer line is cut. */
const STARTUP_EXCERPT_CHARS = 400;
const MAX_LINE_CHARS = 8192;
/** Restart backoff: 500 ms doubling, 30 s ceiling (docs/relay.md §1). */
function backoffMs(strikes) {
	return Math.min(3e4, 500 * 2 ** Math.max(0, strikes - 1));
}
/** warm() retry spacing once the restart budget is spent, or bun/the script is missing. */
const EXHAUSTED_RETRY_MS = 5 * 6e4;
const UNAVAILABLE_RETRY_MS = 6e4;
/**
* Environment the child inherits: what bun needs to run on macOS, Linux and
* Windows, plus CA settings. Proxy variables are deliberately absent — Bun's
* fetch honours HTTP(S)_PROXY, which would turn `direct` into an env proxy.
*/
const CHILD_ENV_NAMES = new Set([
	"PATH",
	"PATHEXT",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"TMP",
	"TEMP",
	"TZ",
	"LANG",
	"LANGUAGE",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"HOMEDRIVE",
	"HOMEPATH",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
	"XDG_RUNTIME_DIR",
	"XDG_CACHE_HOME",
	"BUN_INSTALL",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS"
]);
/** The allowlisted slice of `source` (names compared case-insensitively, as Windows does). */
function relayChildEnv(source = process.env) {
	const env = {};
	for (const [name$1, value] of Object.entries(source)) {
		if (value === void 0) continue;
		const upper = name$1.toUpperCase();
		if (CHILD_ENV_NAMES.has(upper) || upper.startsWith("LC_")) env[name$1] = value;
	}
	return env;
}
/**
* Candidate relay scripts, in order: next to the built `lib/` (the installed
* layout), then the source checkout's own `relay/` (running from `src/` in
* tests). The first existing file wins.
*/
function defaultScriptCandidates() {
	const here = () => {
		try {
			return fileURLToPath(new URL(".", import.meta.url));
		} catch {
			return process.cwd();
		}
	};
	const base = here();
	return [
		join(base, "..", "..", "relay", "oc2dsh-relay.mjs"),
		join(base, "..", "relay", "oc2dsh-relay.mjs"),
		join(base, "relay", "oc2dsh-relay.mjs")
	];
}
/** Resolve the shipped relay script; empty string when the package is broken. */
function defaultRelayScript() {
	for (const candidate of defaultScriptCandidates()) if (existsSync(candidate)) return candidate;
	return "";
}
/**
* Find a bun binary: explicit config, then `OC2DSH_BUN`, then PATH, then the
* usual install locations (bun's own installer, Homebrew on both prefixes, and
* nvm's node bin dirs where this machine's bun lives).
*/
function findBun(configured) {
	const explicit = (configured ?? "").trim();
	if (explicit !== "") return existsSync(explicit) ? explicit : null;
	const fromEnv = (process.env.OC2DSH_BUN ?? "").trim();
	if (fromEnv !== "") return existsSync(fromEnv) ? fromEnv : null;
	if (process.env.BUN_INSTALL !== void 0) {
		const candidate = join(process.env.BUN_INSTALL, "bin", "bun");
		if (existsSync(candidate)) return candidate;
	}
	const exe = process.platform === "win32" ? "bun.exe" : "bun";
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir === "") continue;
		const candidate = join(dir, exe);
		if (existsSync(candidate)) return candidate;
	}
	const home = homedir();
	const fixed = [
		join(home, ".bun", "bin", exe),
		`/opt/homebrew/bin/${exe}`,
		`/usr/local/bin/${exe}`
	];
	for (const candidate of fixed) if (existsSync(candidate)) return candidate;
	const nvmRoot = join(home, ".nvm", "versions", "node");
	try {
		if (existsSync(nvmRoot)) for (const version of readdirSync(nvmRoot).sort().reverse()) {
			const candidate = join(nvmRoot, version, "bin", exe);
			if (existsSync(candidate)) return candidate;
		}
	} catch {}
	return null;
}
/**
* Owns one relay child process. Idempotent start/stop; safe to call start()
* repeatedly (a second call joins the running one).
*/
var RelaySupervisor = class {
	#config;
	#logger;
	#spawn;
	#scriptPath;
	#healthFetch;
	#readyTimeoutMs;
	#maxRestarts;
	#healthyResetMs;
	#child = null;
	/** `http://127.0.0.1:<port>` of the live relay. */
	#origin = null;
	/** {@link #origin} plus the per-spawn `/_/<token>` prefix every request needs. */
	#baseUrl = null;
	/** Earliest time warm() may spawn again (startup-failure backoff). */
	#nextAttemptAt = 0;
	#bunPath = null;
	#lastError = "";
	#restarts = 0;
	#starting = null;
	#stopping = false;
	constructor(options = {}) {
		this.#config = options.config ?? {};
		this.#logger = options.logger;
		this.#spawn = options.spawnImpl ?? spawn;
		this.#scriptPath = options.scriptPath ?? defaultRelayScript();
		this.#healthFetch = options.healthFetch ?? defaultHealthFetch;
		this.#readyTimeoutMs = options.readyTimeoutMs ?? 15e3;
		this.#maxRestarts = options.maxRestarts ?? 5;
		this.#healthyResetMs = options.healthyResetMs ?? 6e4;
	}
	get upstream() {
		const configured = (this.#config.upstream ?? "").trim();
		return configured !== "" ? configured.replace(/\/+$/, "") : DEFAULT_RELAY_UPSTREAM;
	}
	/**
	* The base URL of a live relay (`http://127.0.0.1:<port>/_/<token>`), or null
	* when it is not running. The adapter reads this PER REQUEST: a relay that
	* died and came back (new port, new token) is picked up without rebuilding
	* anything.
	*/
	get baseUrl() {
		return this.#baseUrl;
	}
	/** Diagnostics for the status file / bridge. */
	status() {
		return {
			active: this.#baseUrl !== null,
			baseUrl: this.#baseUrl === null ? null : this.#origin,
			bunPath: this.#bunPath,
			upstream: this.upstream,
			lastError: this.#lastError,
			restarts: this.#restarts
		};
	}
	/**
	* Fire-and-forget warm-up for the paths that precede traffic (the host's
	* registration-time model list, and every prepareCall). `apply()` does not do
	* this at load time: loading the plugin must not fork a process for a host
	* that never uses this provider.
	*/
	warm() {
		if (this.#stopping || this.#baseUrl !== null || this.#starting !== null || this.#config.enabled === false) return;
		if (Date.now() < this.#nextAttemptAt) return;
		this.start().catch(() => {});
	}
	/**
	* Start (or join) the relay. Resolves with the base URL, or null when the
	* relay cannot run here (no bun, missing script, disabled) — the caller then
	* keeps sending directly and logs `lastError` once.
	*/
	start() {
		if (this.#stopping) return Promise.resolve(null);
		if (this.#baseUrl !== null) return Promise.resolve(this.#baseUrl);
		if (this.#config.enabled === false) {
			this.#lastError = "relay disabled by config";
			return Promise.resolve(null);
		}
		if (this.#starting !== null) return this.#starting;
		this.#starting = this.#spawnAndWait().finally(() => {
			this.#starting = null;
		});
		return this.#starting;
	}
	/**
	* The relay's own base for one upstream ORIGIN (the lane ladder moves between
	* `/inference` and `/zen`): the relay forwards pathnames verbatim, so the
	* origin's path is preserved and only the scheme/host change.
	*/
	baseUrlFor(origin) {
		if (this.#baseUrl === null) return null;
		let pathname = "";
		try {
			pathname = new URL(origin).pathname.replace(/\/+$/, "");
		} catch {
			pathname = "";
		}
		return `${this.#baseUrl}${pathname}`;
	}
	async #spawnAndWait() {
		const bun = findBun(this.#config.bunPath);
		this.#bunPath = bun;
		if (bun === null) {
			this.#lastError = "no bun binary found (安装 bun 后重启，或设置 relay.bunPath)";
			this.#logger?.warn(`oc2dsh: ${this.#lastError} — upstream requests stay direct and will be answered 429 by the free lane`);
			this.#nextAttemptAt = Date.now() + UNAVAILABLE_RETRY_MS;
			return null;
		}
		if (this.#scriptPath === "") {
			this.#lastError = "relay script missing from the installed package (relay/oc2dsh-relay.mjs)";
			this.#logger?.warn(`oc2dsh: ${this.#lastError}`);
			this.#nextAttemptAt = Date.now() + UNAVAILABLE_RETRY_MS;
			return null;
		}
		const token = randomBytes(24).toString("hex");
		try {
			const port = await this.#spawnOnce(bun, token);
			if (this.#stopping) {
				await this.#killChild();
				return null;
			}
			this.#origin = `http://127.0.0.1:${port}`;
			this.#baseUrl = `${this.#origin}/_/${token}`;
			this.#lastError = "";
			this.#nextAttemptAt = 0;
			this.#logger?.info(`oc2dsh: upstream relay ready at ${this.#origin} (bun ${bun})`);
			return this.#baseUrl;
		} catch (err) {
			if (this.#stopping) return null;
			this.#lastError = err instanceof Error ? err.message : String(err);
			this.#restarts += 1;
			this.#nextAttemptAt = Date.now() + (this.#restarts >= this.#maxRestarts ? EXHAUSTED_RETRY_MS : backoffMs(this.#restarts));
			this.#logger?.warn(`oc2dsh: upstream relay failed to start: ${this.#lastError}`);
			return null;
		}
	}
	/** One spawn attempt: start, read the ready line, health-check. */
	#spawnOnce(bun, token) {
		return new Promise((resolve$1, reject) => {
			const env = {
				...relayChildEnv(),
				OC2DSH_RELAY_HOST: "127.0.0.1",
				OC2DSH_RELAY_PORT: String(this.#config.port ?? 0),
				OC2DSH_RELAY_UPSTREAM: this.upstream,
				OC2DSH_RELAY_TOKEN: token,
				OC2DSH_RELAY_WATCH_STDIN: "1"
			};
			let child;
			try {
				child = this.#spawn(bun, [this.#scriptPath], { env });
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			this.#child = child;
			let settled = false;
			let sawReady = false;
			let excerpt = "";
			let pending = "";
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				this.#killChild();
				reject(/* @__PURE__ */ new Error(`relay did not report readiness within ${this.#readyTimeoutMs}ms`));
			}, this.#readyTimeoutMs);
			timer.unref?.();
			const settle = (fn) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn();
			};
			const onReady = (port) => {
				sawReady = true;
				this.#probe(`http://127.0.0.1:${port}/_/${token}${HEALTH_PATH}`).then(() => settle(() => {
					this.#detach(child);
					this.#armBudgetReset(child);
					resolve$1(port);
				})).catch((err) => settle(() => {
					this.#killChild();
					reject(err instanceof Error ? err : new Error(String(err)));
				}));
			};
			/**
			* One stdout line: the ready marker while starting, an excerpt kept for a
			* startup failure, and the `OC2DSH_RELAY_TRACE=1` mirror to stderr (the
			* child's log stays out of the host's stdout).
			*/
			const onLine = (line) => {
				if (line.startsWith(READY_MARKER)) {
					const port = Number(line.slice(18).trim());
					if (!sawReady && Number.isFinite(port) && port > 0) onReady(port);
					return;
				}
				if (!settled && excerpt.length < STARTUP_EXCERPT_CHARS) excerpt = `${excerpt}${line}\n`.slice(0, STARTUP_EXCERPT_CHARS);
				if (line.trim() !== "" && process.env.OC2DSH_RELAY_TRACE === "1") console.error("[relay]", line);
			};
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk) => {
				pending += chunk;
				let newline = pending.indexOf("\n");
				while (newline !== -1) {
					onLine(pending.slice(0, newline).replace(/\r$/, ""));
					pending = pending.slice(newline + 1);
					newline = pending.indexOf("\n");
				}
				if (pending.length > MAX_LINE_CHARS) {
					onLine(pending);
					pending = "";
				}
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk) => {
				const text = chunk.trim();
				if (text !== "") this.#lastError = text.slice(0, 400);
			});
			child.on("error", (err) => {
				this.#detach(child);
				settle(() => reject(err instanceof Error ? err : new Error(String(err))));
			});
			child.on("exit", (code, signal) => {
				this.#child = null;
				if (!settled) {
					this.#detach(child);
					settle(() => reject(/* @__PURE__ */ new Error(`relay exited during startup (code ${code ?? "null"}, signal ${signal ?? "none"}): ${excerpt.trim()}`)));
					return;
				}
				this.#onExit(code, signal);
			});
		});
	}
	/**
	* Give the restart budget back after {@link #healthyResetMs} of continuous
	* uptime: the budget exists to stop a crash LOOP, not to cap a process
	* lifetime, and a child that dies before the window keeps its strikes.
	*/
	#armBudgetReset(child) {
		setTimeout(() => {
			if (this.#stopping) return;
			if (this.#child !== child || this.#baseUrl === null) return;
			this.#restarts = 0;
		}, this.#healthyResetMs).unref?.();
	}
	/**
	* Release a ready (or failed) child from the parent's event loop: the child
	* handle and its three stdio pipes are unref'd here, and only here — startup
	* needs those handles to deliver the readiness line. The child still dies
	* with us: its stdin is a pipe, and EOF is its own shutdown signal.
	*/
	#detach(child) {
		try {
			child.unref();
			for (const stream of [
				child.stdin,
				child.stdout,
				child.stderr
			]) stream.unref?.();
		} catch {}
	}
	/** After a crash of a ready relay: restart with backoff, bounded. */
	#onExit(code, signal) {
		this.#baseUrl = null;
		this.#origin = null;
		if (this.#stopping) return;
		this.#lastError = `relay exited (code ${code ?? "null"}, signal ${signal ?? "none"})`;
		this.#logger?.warn(`oc2dsh: ${this.#lastError}`);
		if (this.#restarts >= this.#maxRestarts) {
			this.#nextAttemptAt = Date.now() + EXHAUSTED_RETRY_MS;
			this.#logger?.warn(`oc2dsh: upstream relay gave up after ${this.#restarts} restarts; requests will go direct (429 expected)`);
			return;
		}
		this.#restarts += 1;
		const delay = backoffMs(this.#restarts);
		this.#nextAttemptAt = Date.now() + delay;
		setTimeout(() => {
			if (this.#stopping) return;
			this.start().catch(() => {});
		}, delay).unref?.();
	}
	/** GET the health endpoint, bounded. */
	#probe(url) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5e3);
		timer.unref?.();
		return this.#healthFetch(url, controller.signal).then(() => void 0).finally(() => clearTimeout(timer));
	}
	async #killChild() {
		const child = this.#child;
		this.#child = null;
		if (child === null) return;
		try {
			child.stdin?.end();
			child.kill("SIGTERM");
		} catch {}
	}
	/** Stop the relay (plugin dispose). Idempotent. */
	async stop() {
		this.#stopping = true;
		this.#baseUrl = null;
		this.#origin = null;
		await this.#killChild();
	}
};
/**
* Default health probe: `node:http` against loopback, deliberately NOT `fetch`:
* the pool's installer swaps `globalThis.fetch` while routing is on, so a
* `fetch` probe could be routed by that layer — or answered by a host/test
* mock of it — instead of reaching this process.
*/
function defaultHealthFetch(url, signal) {
	return new Promise((resolve$1, reject) => {
		get(url, { signal }, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => {
				if (response.statusCode !== 200) {
					reject(/* @__PURE__ */ new Error(`relay health probe answered HTTP ${response.statusCode}`));
					return;
				}
				try {
					resolve$1(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});
		}).on("error", reject);
	});
}

//#endregion
//#region src/index.ts
const name = "oc2dsh";
/**
* Only `llm` gates this fiber, because the Zen lane needs nothing else: its
* credential is the literal `'public'` and the ip-pool settings ride the
* `Config` volatile reference. DSH 0.1.7 composes `ctx.settings` as
* `SettingsForms`, which injects `['configEditor', 'profileContext']` and
* ships disabled wherever no `profileContext` exists (headless/CLI) —
* demanding it here would keep the fiber (and the provider route) from
* activating. The `configure({ auto: false })` page claim asks for that seam
* through `ctx.inject` instead.
*/
const inject = ["llm"];
function apply(ctx, config = {}) {
	const resolved = config;
	setUserAgentOverride(resolveConfig(config).userAgent);
	const releaseHeaders = setRequestHeadersReader(() => readVolatile(resolved.requestHeaders));
	if (typeof ctx.effect === "function") ctx.effect.call(ctx, () => releaseHeaders);
	applyAdapter(ctx, resolved, () => readVolatile(resolved.ipPool));
}
/**
* Catalog + LlmAdapter registration. The adapter registration is disposed
* with the plugin fiber (registerAdapter uses ctx.effect internally); we only
* own the catalog refresh loop here.
*/
function applyAdapter(ctx, config, readIpPool) {
	const logger = ctx.logger;
	const ordinary = ordinaryConfig(config);
	const cfg = resolveConfig(ordinary);
	if (!ctx.llm || typeof ctx.llm.registerAdapter !== "function") {
		logger.error("oc2dsh: llm service unavailable; the adapter cannot register");
		return;
	}
	const dataDir = stateDir();
	const statusPath = join(dataDir, "adapter-status.json");
	/** The last relay snapshot, written into the status file (diagnostics). */
	let relayStatus = null;
	const writeStatus = (status, lastError) => {
		writeFile(statusPath, JSON.stringify({
			...status,
			zenUserAgent: opencodeUserAgent(),
			...relayStatus !== null ? { relay: relayStatus } : {},
			lastError,
			writtenAt: (/* @__PURE__ */ new Date()).toISOString()
		}, null, 2), "utf8").catch(() => {});
	};
	/**
	* The Bun upstream relay, constructed here but started lazily (catalog
	* refresh, then `listModels`/`prepareCall`): loading the plugin must not fork
	* a process. A machine without bun keeps working — the supervisor resolves
	* null, the adapter sends direct, and the warning says what is missing.
	*/
	const relay = new RelaySupervisor({
		...cfg.relay !== void 0 ? { config: cfg.relay } : {},
		logger
	});
	const catalog = new ModelCatalog({
		refreshSeconds: cfg.refreshSeconds,
		cachePath: defaultCachePath(dataDir),
		contextWindows: () => readVolatile(config.modelContextWindows),
		onRefresh: (status, lastError) => {
			relay.warm();
			relayStatus = relay.status();
			writeStatus(status, lastError);
			if (lastError) logger.warn(`oc2dsh: catalog refresh issue: ${lastError}`);
		}
	});
	const adapter = new ZenAdapter(catalog, {
		firstEventMs: cfg.firstEventMs,
		bodyIdleMs: cfg.bodyIdleMs,
		responsesBodyIdleMs: cfg.responsesBodyIdleMs,
		relay
	});
	setUsageRecorder(usageStore);
	if (typeof ctx.effect === "function") ctx.effect.call(ctx, () => () => {
		usageStore.dispose();
	});
	else usageStore.load();
	ctx.llm.registerAdapter([PROVIDER_ID], adapter);
	logger.info(`oc2dsh: adapter registered for "${PROVIDER_ID}" (catalog warms up in background)`);
	if (typeof ctx.effect === "function") ctx.effect.call(ctx, () => () => {
		relayStatus = relay.status();
		relay.stop();
	});
	else process.once("exit", () => {
		relay.stop();
	});
	try {
		applyIpPoolSettings(ctx, ordinary, readIpPool, logger, {
			listLiveModels: () => catalog.list(),
			usage: usageStore,
			relayBaseUrl: () => relay.baseUrl
		});
	} catch (err) {
		logger.error(`oc2dsh: ip-pool settings wiring failed; the provider route stays direct: ${err instanceof Error ? err.message : String(err)}`);
	}
	catalog.start().catch((err) => {
		logger.error(`oc2dsh: catalog start failed: ${err instanceof Error ? err.message : String(err)}`);
	});
	if (typeof ctx.effect === "function") ctx.effect.call(ctx, () => () => {
		catalog.stop();
	});
}

//#endregion
export { Config, RelaySupervisor, apply, defaultRelayScript, findBun, inject, name, resolveConfig };