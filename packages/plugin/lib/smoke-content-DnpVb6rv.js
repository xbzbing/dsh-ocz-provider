import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

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
* The anonymous free-lane gate (~2026-10-09, issue #56; live-probed again
* 2026-10-11): a chat request passes with HTTP 200 only when ALL hold:
*   1. a canonical `ses_*` id in a session header (`x-opencode-session`,
*      `x-session-affinity` and `X-Session-Id` all work — any ONE suffices;
*      bad-shape ids 403);
*   2. a streaming body (`stream: true` — non-stream 403s);
*   3. an agent-shaped `tools` array: `bash`+`read` pass (200), `shell`+1
*      known name pass (200), but `bash` alone, `shell` alone, and 5 known
*      names WITHOUT bash/shell all 403. Schemas and descriptions go
*      uninspected.
* The `Bearer public` credential and the User-Agent spelling are NOT gates
* (both pass on /zen/v1; only /inference/openai 401s the Bearer). The shipped
* recipe stays the 2026-09-18 bash+read pair: minimal, host-named, and valid
* on both the /zen and /inference lanes.
*/
const FREE_LANE_GATE_TOOL_NAMES = ["bash", "read"];
/**
* Inbound tool-call names rewritten before the chunk stream leaves the
* adapter (zen-adapter.ts hands this to toStreamChunks). Empty on the shipped
* recipe: every injected stub is call-disabled or host-named, so nothing the
* model can call needs a rename. Kept as the seam for a future gate spelling
* that forces an alias (e.g. a mandatory `shell`).
*/
const GATE_TOOL_ALIASES = {};
function freeLaneGateTool(name) {
	return {
		type: "function",
		function: {
			name,
			description: "Reserved for the host runtime; do not call it.",
			parameters: {
				type: "object",
				properties: {}
			}
		}
	};
}
/** Responses uses flat function tools and its Zen gateway accepts auto only. */
function ensureResponsesFreeLaneShape(payload) {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return void 0;
	const body = payload;
	if (!Array.isArray(body.input)) return void 0;
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const names = new Set(tools.map((tool) => {
		if (typeof tool !== "object" || tool === null) return void 0;
		const candidate = tool;
		return candidate.type === "function" ? candidate.name : void 0;
	}));
	const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !names.has(name));
	const invalidChoice = body.tool_choice !== void 0 && body.tool_choice !== "auto";
	if (missing.length === 0 && !invalidChoice) return void 0;
	return {
		...body,
		tools: [...tools, ...missing.map((name) => ({
			type: "function",
			...freeLaneGateTool(name).function
		}))],
		tool_choice: "auto"
	};
}
/**
* Rewrite an outgoing chat-completions payload so it satisfies the free-lane
* agent-shape gate (wired through pi-ai's onPayload). Appends only the gate
* tools the payload is missing; when the context carried no tools at all,
* tool_choice 'none' keeps the model from ever calling the injected stubs,
* while client-provided tool choices are preserved untouched. Returns
* undefined when the payload already satisfies the gate or is not a
* chat-completions body (pi-ai keeps the original in that case).
*/
function ensureFreeLaneShape(payload) {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return void 0;
	const body = payload;
	if (!Array.isArray(body.messages)) return void 0;
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const names = new Set(tools.map((tool) => {
		const fn = typeof tool === "object" && tool !== null ? tool.function : void 0;
		return typeof fn === "object" && fn !== null ? fn.name : void 0;
	}));
	const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !names.has(name));
	if (missing.length === 0) return void 0;
	const next = { ...body };
	next.tools = [...tools, ...missing.map((name) => freeLaneGateTool(name))];
	if (tools.length === 0) next.tool_choice = "none";
	return next;
}

//#endregion
//#region src/pool/smoke-content.ts
/**
* The probe's user turn (live request 2026-10-14: "增加探测文案的配置，默认
* content 修改为「hello」，允许用户自定义多个 content，探索时随机选择").
*
* The smoke is a 1-token chat request that proves the anonymous lane answers
* through a candidate exit (docs/ip-pool.md §4.5 step 4). Its user turn is
* decoration — the gate is the request SHAPE (streaming + the free-lane tools)
* — so a pool of one-liners keeps the probe traffic from looking like one fixed
* synthetic pattern while every other property of the probe stays identical.
*
* The default lives HERE rather than in the settings schema: the settings layer
* resolves it for the UI (`resolveProbeContents`) and the admission path keeps
* its own fallback for direct callers, so one constant has to be the truth for
* both. (Same split as `DEFAULT_PROBE_MODEL` ↔ `deps.smokeModel`.)
*/
const DEFAULT_SMOKE_CONTENT = "hello";
/** Trim, drop empties and dedupe a configured pool (order preserved). */
function normalizeSmokeContents(contents) {
	const pool = [];
	for (const entry of contents ?? []) {
		const value = typeof entry === "string" ? entry.trim() : "";
		if (value !== "" && !pool.includes(value)) pool.push(value);
	}
	return pool;
}
/**
* One probe's user turn: a random entry of the configured pool, or the default
* when nothing is configured. `random` is a seam (tests, and any future
* deterministic caller); the index is clamped, so a seam returning 1 — or a
* negative, or NaN — can never read outside the pool.
*/
function pickSmokeContent(contents, random = Math.random) {
	const pool = normalizeSmokeContents(contents);
	if (pool.length === 0) return DEFAULT_SMOKE_CONTENT;
	const raw = random();
	return pool[Number.isFinite(raw) ? Math.min(pool.length - 1, Math.max(0, Math.floor(raw * pool.length))) : 0];
}

//#endregion
export { GATE_TOOL_ALIASES as a, freeLaneGateTool as c, isResponsesModel as d, FREE_LANE_GATE_TOOL_NAMES as i, toPiContext as l, normalizeSmokeContents as n, ensureFreeLaneShape as o, pickSmokeContent as r, ensureResponsesFreeLaneShape as s, DEFAULT_SMOKE_CONTENT as t, apiForModel as u };