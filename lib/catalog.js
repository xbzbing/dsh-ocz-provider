import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

//#region src/request-headers.ts
const HEADER_NAME = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/;
/** Headers the plugin owns: authentication, cookies, framing and body format. */
const MANAGED_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"host",
	"connection",
	"proxy-connection",
	"content-length",
	"transfer-encoding",
	"upgrade",
	"trailer",
	"te",
	"expect",
	"content-type",
	"content-encoding",
	"accept-encoding"
]);
const MAX_HEADERS = 32;
const MAX_BYTES = 8192;
/** One accepted entry, or undefined when the pair must be dropped. */
function accept(rawName, rawValue) {
	if (typeof rawName !== "string") return void 0;
	const name = rawName.toLowerCase();
	if (!HEADER_NAME.test(name) || MANAGED_HEADERS.has(name)) return void 0;
	if (typeof rawValue !== "string" || !HEADER_VALUE.test(rawValue)) return void 0;
	const value = rawValue.trim();
	if (value === "") return void 0;
	return [name, value];
}
/**
* Lenient boundary: every request, where a bad entry must never break the wire
* call. Invalid names, managed headers, blanks and oversize dictionaries are
* dropped instead of thrown, so a hand-edited profile patch cannot inject
* `authorization`/`cookie`/framing headers, and cannot fail a request either.
*/
function sanitizeRequestHeaders(input) {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
	const sanitized = /* @__PURE__ */ new Map();
	let size = 0;
	for (const [rawName, rawValue] of Object.entries(input)) {
		if (sanitized.size >= MAX_HEADERS) break;
		const pair = accept(rawName, rawValue);
		if (pair === void 0) continue;
		const [name, value] = pair;
		if (sanitized.has(name)) continue;
		const next = size + name.length + value.length + 4;
		if (next > MAX_BYTES) break;
		size = next;
		sanitized.set(name, value);
	}
	return Object.fromEntries(sanitized);
}

//#endregion
//#region src/adapter/ids.ts
function randomID(prefix, size) {
	return `${prefix}_${randomBytes(size).toString("hex")}`;
}
/**
* The conversation signal: JSON of the first user message's content. Using the
* first user turn keeps a multi-turn conversation stable as its history grows
* while separating conversations with different beginnings (ids.go:59-76).
*/
function conversationSeed(messages) {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const encoded = JSON.stringify(message.content ?? null);
		if (encoded !== "null" && encoded.length > 0) return encoded;
	}
	return "";
}
/**
* A readable label for one conversation: its first user turn, flattened and
* truncated. The usage ledger's top-session list is unusable without one —
* `ses_9f2c…` says nothing about which conversation burned the tokens (live
* request 2026-10-14). Text blocks are concatenated; images and tool results
* contribute nothing.
*/
function conversationLabel(messages, limit = 64) {
	const seed = conversationSeed(messages);
	if (seed === "") return "";
	let text = "";
	try {
		const parsed = JSON.parse(seed);
		if (typeof parsed === "string") text = parsed;
		else if (Array.isArray(parsed)) {
			for (const block of parsed) if (block?.type === "text" && typeof block.text === "string") text += ` ${block.text}`;
		}
	} catch {
		text = seed;
	}
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat === "") return "";
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
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
const DEFAULT_PROJECT_ID = "global";
/**
* Derive the correlation ids for one upstream request. In adapter mode there
* are no inbound opencode headers, so the seed is the conversation itself.
*
* Both non-session ids are now shape-checked by the gate (live-probed
* 2026-10-14): `x-opencode-request` must be a `msg_*` MESSAGE id — the client
* sends `input.user.id`, i.e. the user turn's id — and a `req_<hex>` there
* answers 403; `x-opencode-project` must be the prefix-less project id above.
*/
function deriveRequestIDs(messages) {
	let signal = conversationSeed(messages);
	if (signal === "" || signal === "{}") signal = randomID("fallback", 16);
	return {
		session: canonicalSessionID(signal),
		request: mintedMessageID(),
		project: DEFAULT_PROJECT_ID,
		parentSession: ""
	};
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
* bits (upstream fixes: jasonxu114514/opencode2api PR #69, then PR #70; the
* same defect in decolua/9router is issue #4780). Two rules, both re-probed
* live 2026-10-15 against /inference/v1 with the full gate body and this
* adapter's header set, one variable at a time:
*
*   1. the word must be INVERTED — a digest-shaped or ascending prefix 403s;
*   2. the 12-bit counter must land in 0-63. After the inversion the low 12
*      bits read 0xFFF-counter, so anything below 0xFC0 403s: counters 0, 1,
*      32 and 63 -> 200, counters 64 and 128 -> 403. The timestamp half is
*      not checked at all — a prefix decoding to ts36=1 (epoch+1ms) -> 200.
*
* So a clock-derived counter dies after 64 mints in a long-lived process
* (exactly what PR #70 replaced), and this adapter mints often: one session
* per new conversation AND one per pool exit address (pool/admission.ts), so
* a single refill round could burn the window and 403 every session minted
* afterwards. The prefix is therefore DERIVED FROM THE DIGEST with counter 1
* — always inside the window, stateless, and one conversation keeps one id
* even across restarts (PR #70's encoding; the in-memory cache it replaces
* could not do that).
*/
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
/**
* The acceptance window for the inverted counter: after the bitwise NOT the
* low 12 bits read 0xFFF-counter, so a genuine descending id always has `f`
* followed by `[c-f]` in the 10th/11th hex character (counter 0-63). A
* canonical-shaped id outside it is re-encoded rather than passed through.
*/
const DESCENDING_TIME_PART_PATTERN = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function base62Fixed(value, width) {
	const base = 62n;
	let n = value;
	const out = new Array(width);
	for (let i = width - 1; i >= 0; i--) {
		out[i] = BASE62_ALPHABET.charAt(Number(n % base));
		n /= base;
	}
	return out.join("");
}
/** The low 6 bytes of a 48-bit id word, lowercase hex (the client's carry width). */
function hex48(value) {
	let hex = "";
	for (let bit = 40; bit >= 0; bit -= 8) hex += Number(value >> BigInt(bit) & 255n).toString(16).padStart(2, "0");
	return hex;
}
/**
* The 12 hex characters of a descending session id: the digest's leading 36
* bits as the "timestamp", counter 1 in the low 12 bits, then the client's
* bitwise NOT, so newer ids sort first. The inversion is arithmetic on a
* BigInt (sign-extended), and taking the low 6 bytes yields exactly the
* official client's prefix — with the counter inside the 0-63 window the
* gate accepts, whatever the digest says.
*/
function descendingTimePrefix(sum) {
	return hex48(~((BigInt(sum.readUInt32BE(0)) << 4n | BigInt((sum[4] ?? 0) >> 4)) << 12n | 1n) & (1n << 48n) - 1n);
}
/** Clock state for the ascending message-id prefix (kept apart from sessions). */
let messageCounter = 0;
/**
* A `msg_*` request id, shaped exactly like the client's
* `Session.Message.ID.create()`: `"msg_" + ascending()`, where the ascending
* scheme is the same `unix_ms * 0x1000 + counter` low-48-bit encoding as the
* session prefix WITHOUT the inversion, plus a random Base62 tail. The gate
* only ever sees it as the `x-opencode-request` header, so the tail carries no
* affinity: one fresh id per request is what the client does (`input.user.id`
* is that request's own user turn). Unlike the session word, this one is not
* decoded by the gate at all — live-probed 2026-10-15: counters 64 and 4095,
* ts36=1, an inverted word and a junk tail all return 200 — so the process
* counter behind it can never walk out of a window.
*/
function mintedMessageID() {
	messageCounter = messageCounter + 1 & 4095;
	return `msg_${hex48(BigInt(Date.now()) * 4096n + BigInt(messageCounter))}${base62Fixed(BigInt("0x" + randomBytes(10).toString("hex")), 14)}`;
}
/**
* The session id sent upstream. A signal that already carries an official
* OpenCode session whose counter is inside the acceptance window passes
* through unchanged (preserving upstream prompt-cache affinity); a canonical
* but out-of-window id — or any foreign identity (the conversation seed in
* adapter mode, admission probes) — is re-encoded from its digest: the
* 14-char Base62 tail stays digest-derived so per-conversation affinity does
* not change, and the prefix is the digest's own descending timestamp with
* counter 1. Pure function of the signal: one signal always returns one id,
* in this process and the next one (2026-10-15, upstream PR #70).
*/
function canonicalSessionID(signal) {
	if (CANONICAL_SESSION_PATTERN.test(signal) && DESCENDING_TIME_PART_PATTERN.test(signal.slice(4, 16))) return signal;
	const sum = createHash("sha256").update("ses\0" + signal).digest();
	const randomPart = base62Fixed(BigInt("0x" + sum.subarray(6, 16).toString("hex")), 14);
	return `ses_${descendingTimePrefix(sum)}${randomPart}`;
}
/**
* The User-Agent override from plugin config (`userAgent`). Empty = the
* built-in value below. Module state on purpose: the three senders (the chat
* adapter, the model catalog and the pool's admission probes) all call
* {@link opencodeUserAgent} at request time, so one setting moves every wire
* request without threading it through four signatures.
*/
let userAgentOverride = "";
let readRequestHeaders;
/** Read the Loader's stable reference on each request, never cache a snapshot. */
function setRequestHeadersReader(reader) {
	readRequestHeaders = reader;
	return () => {
		if (readRequestHeaders === reader) readRequestHeaders = void 0;
	};
}
/** Common merge for chat, catalog and admission; caller-owned transport headers stay intact. */
function zenRequestHeaders(base = {}) {
	return {
		"user-agent": legacyUserAgent(),
		"x-opencode-client": "cli",
		...base,
		...sanitizeRequestHeaders(readRequestHeaders?.() ?? {})
	};
}
function legacyUserAgent() {
	return userAgentOverride || `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`;
}
/**
* Set the configured User-Agent. Empty or whitespace restores the built-in
* value, so a cleared field in a profile patch cannot put a blank header on
* the wire.
*/
function setUserAgentOverride(value) {
	userAgentOverride = (value ?? "").trim();
}
/**
* The User-Agent every Zen request carries: CLI-identical by default (ids.go
* opencodeUserAgent, node runtime values), the configured `userAgent` when one
* is set.
*
* The anonymous lane reads a whole FINGERPRINT — this header plus the
* session/project/request id shapes and the tool definitions — so the two ways
* to change it are: move THIS string alone, or move the recipe whole. Live
* 2026-10-15 against /inference/v1 with this adapter's fingerprint held
* constant and one variable at a time, each of these answered 200: the
* built-in value, the installed app's OpenAI/Codex branch string
* (`opencode/1.19.0 (darwin 27.0.0; arm64)`, extracted from `app.asar`)
* and upstream's 2.x shape (`opencode/latest/2.0.29/cli`). The
* gate does not pin the UA string. What still 403s is mixing GENERATIONS
* inside one request — 2.x tool names under this header set, or upstream's
* header set carrying our `x-opencode-request` ({@link disguiseHeaders}).
*/
function opencodeUserAgent() {
	return zenRequestHeaders()["user-agent"];
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
*
* 2026-10-15: that check is FINGERPRINT COHERENCE, not a fixed allow-list.
* Replaying upstream's own 2.x recipe (jasonxu114514/opencode2api PR #83: UA
* `opencode/latest/<ver>/cli`, all four session spellings, a 40-hex project
* and the 2.x `shell/edit/glob/grep/read` definitions) also answers 200 —
* while mixing the two fingerprints 403s every time (this UA with 2.x tool
* names, their UA with our `x-opencode-request: msg_*`). Dropping
* `x-opencode-request` from THIS set stays 200 as well, so the header is
* optional here; it is kept because the 1.18.31 client sends it and `req_*`
* is a rejection signal. Adopting any part of another generation's recipe
* without the rest is what fails, not this set.
*/
function disguiseHeaders(ids) {
	return zenRequestHeaders({
		"x-opencode-session": ids.session,
		"x-opencode-session-id": ids.session,
		"x-opencode-request": ids.request,
		"x-opencode-project": ids.project
	});
}

//#endregion
//#region src/adapter/catalog.ts
/**
* Port of agent/internal/catalog (opencode2api models.go + model_metadata.go,
* trimmed to the single anonymous Zen lane) plus the S3 static fallback:
*
*   S1  GET {zen}/v1/models            live catalog (in-sale ids, free or paid)
*   S2  GET https://models.dev/api.json  pricing metadata -> free decision
*   S3  compile-time verified ids       last-resort bootstrap list
*
* /v1/models-equivalent exposure = S1 ∩ S2-allowed (or S3 while S1 is pending).
*/
/**
* The anonymous lane's base URL (every caller appends `/v1`).
*
* It was `https://opencode.ai/zen` until 2026-10-14, when OpenCode moved the
* whole lane — free models included — to `https://opencode.ai/inference/v1`.
* Four independent sources agree: the client's runtime catalog
* (`https://models.opencode.ai/api.json`, read at every boot, whose `opencode`
* provider entry now carries `api: https://opencode.ai/inference/v1`),
* models.dev's `opencode` entry (the same URL), the Console model table at
* `https://opencode.ai/v2/docs/console/models/` (every free id is listed with
* an `/inference/v1/...` endpoint), and the client's own request, captured
* 2026-10-14 from OpenCode Desktop 1.19.0 (a `POST` to
* `/inference/v1/chat/completions` that answered 200).
*
* Live-probed the same day: a request that passes on `/inference/v1` — the
* genuine gate tools, a `msg_*` request id, the real project id, the minted
* `ses_*` session — answers **403 FreeTierError** on `/zen/v1`, so the old
* lane is closed rather than merely deprecated. `/zen/v1/models` alone still
* answers 200, which is why this plugin's catalog stayed green (and its
* `adapter-status.json` reported `ready`) while every chat request failed.
*/
const ZEN_BASE_URL = "https://opencode.ai/inference";
/**
* Free-lane blocklist (issue #56 live matrix, 2026-10-10): models the live
* chat lane can never serve. The Zen catalog still lists them, so S1 alone
* exposes dead ids — one exclusion reason per model:
*   exo-free                             410 ModelDeprecated (upstream delisted)
*   jev-1.13-free                        400 ModelProtocolUnsupported (SystemOne-only)
*   ling-3.0-flash-fin-free              400 "Model is unavailable" (upstream-side)
*   muse-spark-1.*-contributor-free      403 RegionError, chat and responses alike
* Remove an entry only after a live probe of the chat lane answers 200/429.
*/
const FREE_LANE_BLOCKLIST = new Set([
	"exo-free",
	"jev-1.13-free",
	"ling-3.0-flash-fin-free",
	"muse-spark-1.2-contributor-free",
	"muse-spark-1.3-contributor-free"
]);
/** Verified against the anonymous lane with a real chat (agent/internal/catalog/static_models.go). */
const staticFreeModels = [
	"big-pickle",
	"mimo-v2.5-free",
	"mimo-v2.6-flash-free",
	"ling-3.0-flash-fin-free",
	"nemotron-3.5-lightning-free",
	"nemotron-3-ultra-free",
	"muse-spark-1.2-contributor-free"
];
function isFreeModel(model) {
	return model.toLowerCase().includes("free");
}
/** Decide (model_metadata.go Decide, ported with the deprecation fix).
*
* The upstream short-circuits on isFreeModel before consulting metadata, so a
* delisted-but-still-cataloged id like deepseek-v4-flash-free stays exposed
* forever. Here the order is: a ready metadata verdict (including deprecated)
* always wins; the name fallback only fires when metadata cannot speak
* (pending or model missing) — its original documented intent (design.md 4.2).
*/
function decide(model, prices, ready) {
	const nameFree = isFreeModel(model);
	const fallback = (source) => {
		if (nameFree) return {
			allowed: true,
			source: "name_free",
			known: false
		};
		return {
			allowed: false,
			source,
			known: false
		};
	};
	if (!ready || prices.size === 0) return fallback("metadata_pending");
	const price = prices.get(model);
	if (!price) return fallback("metadata_model_missing");
	if (price.deprecated) return {
		allowed: false,
		source: "metadata_deprecated",
		known: true
	};
	if (price.input === 0 && price.output === 0) return {
		allowed: true,
		source: nameFree ? "name_and_metadata_free" : "metadata_free",
		known: true
	};
	if (price.input === void 0 || price.output === void 0) return {
		allowed: false,
		source: "metadata_cost_unknown",
		known: false
	};
	return {
		allowed: false,
		source: "metadata_paid",
		known: true
	};
}
/**
* models.dev fields the plugin knowingly overrides (issue #56 metadata note):
* the feed declares `mimo-v2.6-flash-free` with `limit.context: 200000`, while
* the MiMo V2.6 Flash model card and the official OpenCode CLI config use
* 1048576. Checked BEFORE the metadata in `limits()`/`reasoningCapability()`/
* `modalities()` — a fixed feed deletes its entry here.
*/
const LOCAL_MODEL_OVERRIDES = { "mimo-v2.6-flash-free": { contextWindow: 1048576 } };
/** Shallow per-field override: declared fields win, the rest pass through. */
function applyLocalOverride(model, price) {
	const override = LOCAL_MODEL_OVERRIDES[model];
	if (override === void 0) return price;
	return {
		...price,
		...override
	};
}
/**
* decodeModelsDev (model_metadata.go:253-335): use the OpenCode provider
* section of models.dev, preferring the exact `opencode`/`oc2dsh` key.
*/
function decodeModelsDev(data) {
	const result = /* @__PURE__ */ new Map();
	if (!data || typeof data !== "object") return result;
	const providers = data;
	const keys = Object.keys(providers);
	const rank = (key) => {
		const lower = key.toLowerCase();
		if (lower === "opencode" || lower === "oc2dsh" || lower === "opencode_zen") return 0;
		if (lower.includes("opencode")) return 1;
		return 2;
	};
	keys.sort((left, right) => {
		const leftRank = rank(left);
		const rightRank = rank(right);
		if (leftRank !== rightRank) return leftRank - rightRank;
		return left.localeCompare(right);
	});
	for (const key of keys) {
		if (rank(key) > 1) continue;
		const provider = providers[key];
		if (!provider || typeof provider !== "object") continue;
		if (rank(key) === 1) {
			if (!`${provider.id ?? ""} ${provider.name ?? ""}`.toLowerCase().trim().includes("opencode")) continue;
		}
		const models = provider.models;
		if (!models || typeof models !== "object") continue;
		for (const [modelKey, raw] of Object.entries(models)) {
			if (!raw || typeof raw !== "object") continue;
			const modelId = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : modelKey;
			const cost = raw.cost ?? {};
			const limit = raw.limit ?? {};
			const modalities = raw.modalities ?? {};
			const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
			const contextWindow = num(limit.context);
			const maxOutput = num(limit.output);
			const inputModalities = decodeModalities(modalities.input);
			result.set(modelId, {
				input: num(cost.input),
				output: num(cost.output),
				deprecated: metadataDeprecated(raw),
				reasoning: raw.reasoning === true,
				...decodeEffortValues(raw.reasoning_options),
				...contextWindow !== void 0 ? { contextWindow } : {},
				...maxOutput !== void 0 ? { maxOutput } : {},
				...inputModalities !== void 0 ? { modalities: inputModalities } : {}
			});
		}
		if (result.size > 0) return result;
	}
	return result;
}
function metadataDeprecated(model) {
	if (model.deprecated === true) return true;
	const status = String(model.status ?? model.lifecycle ?? "").toLowerCase();
	if (status === "deprecated" || status === "retired" || status === "disabled") return true;
	return model.deprecated_at != null || model.retirement_date != null;
}
/**
* models.dev `reasoning_options` (live shape 2026-09-18): an array of
* `{type: "effort", values: [...]} | {type: "toggle"} | {type: "budget_tokens", ...}`
* entries, absent when the model never thinks. Only the `effort` entries carry
* selectable levels; `toggle`/`budget_tokens` map to "reasoning, no declared
* ladder" and are reported as an empty array. Omitted entirely when the field
* is absent so cached pre-reasoning metadata stays structurally valid.
*/
function decodeEffortValues(raw) {
	if (!Array.isArray(raw)) return {};
	const values = [];
	for (const option of raw) {
		if (typeof option !== "object" || option === null) continue;
		const entry = option;
		if (entry.type !== "effort" || !Array.isArray(entry.values)) continue;
		for (const value of entry.values) if (typeof value === "string" && value.length > 0 && !values.includes(value)) values.push(value);
	}
	return values.length > 0 ? { effortValues: values } : { effortValues: [] };
}
/**
* models.dev `modalities.input` (live shape 2026-09-28): an array of lowercase
* kind strings such as ["text","image","video","pdf","audio"]. Only a non-empty
* array of non-empty strings is kept, so a malformed or absent field speaks for
* nothing and the adapter keeps its own vision pattern (isVisionModel).
*/
function decodeModalities(input) {
	if (!Array.isArray(input)) return void 0;
	const kinds = [];
	for (const kind of input) if (typeof kind === "string" && kind.length > 0 && !kinds.includes(kind)) kinds.push(kind);
	return kinds.length > 0 ? kinds : void 0;
}
const METADATA_REFRESH_MS = 1440 * 60 * 1e3;
const FETCH_TIMEOUT_MS = 3e4;
/**
* Live model directory with the S1/S2/S3 fallback chain and the timer-driven
* refresh loop. All state is in-memory; only the models.dev cache persists.
*
* Decision chain (design.md 4.1/4.2, with the deprecation-first fix):
*   1. ready metadata verdict — deprecated/paid deny, free cost allows; a
*      "free" name never overrides a negative metadata verdict
*   2. metadata cannot speak (pending/missing) — name fallback, or the
*      compile-time verified S3 list for known-good ids
*/
var ModelCatalog = class {
	#zen = /* @__PURE__ */ new Set();
	#updatedAt = 0;
	#prices = /* @__PURE__ */ new Map();
	#pricesReady = false;
	#lastError = "";
	#refreshSeconds;
	#cachePath;
	#zenBaseUrl;
	#metadataUrl;
	#fetch;
	#now;
	#timer = null;
	#stopped = false;
	#onRefresh;
	#startupRetryMs;
	/** In-flight refresh round (deduped so warm() shares start()'s first fetch). */
	#refreshing = null;
	constructor(options = {}) {
		this.#refreshSeconds = options.refreshSeconds ?? 300;
		this.#cachePath = options.cachePath;
		this.#zenBaseUrl = options.zenBaseUrl ?? ZEN_BASE_URL;
		this.#metadataUrl = options.metadataUrl ?? "https://models.dev/api.json";
		this.#fetch = options.fetchImpl ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#onRefresh = options.onRefresh;
		this.#startupRetryMs = options.startupRetryMs ?? 15e3;
	}
	/**
	* Start the refresh loop: immediate S1+S2, fast retries while the live
	* catalog is still empty (the first fetch often races the machine's network
	* coming up — VPN/TUN reconnect, DNS), then the normal cadence (S2 24h).
	*/
	async start() {
		await this.refreshOnce();
		let attempts = 0;
		while (this.#zen.size === 0 && attempts < 4 && !this.#stopped) {
			attempts += 1;
			await new Promise((resolve) => setTimeout(resolve, this.#startupRetryMs));
			if (this.#stopped) return;
			await this.refreshOnce();
		}
		if (this.#stopped) return;
		this.#timer = setInterval(() => {
			this.refreshOnce();
		}, this.#refreshSeconds * 1e3);
		this.#timer.unref?.();
	}
	stop() {
		this.#stopped = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}
	/** One refresh round, deduped while in flight: a concurrent caller (warm()
	*  racing start()'s first round, or the interval timer) joins the running
	*  round instead of firing a parallel fetch of the same endpoints. */
	refreshOnce() {
		if (this.#refreshing === null) this.#refreshing = this.#refreshRound().finally(() => {
			this.#refreshing = null;
		});
		return this.#refreshing;
	}
	async #refreshRound() {
		await Promise.allSettled([this.refreshZen(), this.refreshMetadata()]);
		if (this.#onRefresh) try {
			this.#onRefresh(this.snapshot(), this.#lastError);
		} catch {}
	}
	async refreshZen() {
		try {
			const ids = await fetchZenModels(this.#zenBaseUrl, this.#fetch, opencodeUserAgent());
			this.#zen = new Set(ids);
			this.#updatedAt = this.#now();
			this.#lastError = "";
		} catch (err) {
			this.#lastError = err instanceof Error ? err.message : String(err);
		}
	}
	/**
	* Adopt a fresh disk cache as the prices baseline. False when there is no
	* cache path, the prices are already ready, or the file is missing/empty —
	* the caller then keeps whatever state it had.
	*/
	async #adoptCachedPrices() {
		if (!this.#cachePath || this.#pricesReady) return false;
		const cached = await loadMetadataCache(this.#cachePath, this.#now).catch(() => null);
		if (cached === null || cached.size === 0) return false;
		this.#prices = cached;
		this.#pricesReady = true;
		return true;
	}
	async refreshMetadata() {
		await this.#adoptCachedPrices();
		try {
			const response = await withTimeout(this.#fetch(this.#metadataUrl, { headers: { accept: "application/json" } }));
			if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
			const prices = decodeModelsDev(await response.json());
			if (prices.size === 0) throw new Error("models.dev contains no OpenCode model metadata");
			this.#prices = prices;
			this.#pricesReady = true;
			if (this.#cachePath) await saveMetadataCache(this.#cachePath, prices, this.#now());
		} catch (err) {
			if (await this.#adoptCachedPrices()) return;
			this.#lastError = err instanceof Error ? err.message : String(err);
		}
	}
	/**
	* Resolve once the first live fetch has settled, so a model-list read is
	* never answered from the bootstrap list (issue #45: the host caches the
	* snapshot its picker took at adapter registration, and the re-read
	* triggers are topology/settings events a warming catalog never fires —
	* so the 7-id staticFreeModels roster could stick for the whole host
	* generation). Bounded: a dead network still answers promptly with the
	* static list. Joins start()'s in-flight round when one exists (no
	* duplicate fetch), or triggers a round of its own when none does.
	*/
	async warm(ms = 4e3) {
		if (this.#zen.size > 0 || this.#stopped) return;
		const timeout = new Promise((resolve) => {
			setTimeout(resolve, ms).unref?.();
		});
		await Promise.race([this.refreshOnce().catch(() => {}), timeout]);
	}
	decision(model) {
		if (FREE_LANE_BLOCKLIST.has(model)) return {
			allowed: false,
			source: "local_blocklist",
			known: true
		};
		const metadata = decide(model, this.#prices, this.#pricesReady);
		if (!metadata.allowed && metadata.source === "metadata_deprecated" && staticFreeModels.includes(model)) return {
			allowed: true,
			source: "static_verified",
			known: false
		};
		if (!metadata.allowed && !metadata.known && staticFreeModels.includes(model)) return {
			allowed: true,
			source: "static_verified",
			known: false
		};
		return metadata;
	}
	/** ids exposed to DSH: S1 ∩ allowed, or S3 while the live catalog is pending. */
	list() {
		if (this.#zen.size === 0) return staticFreeModels.filter((model) => !FREE_LANE_BLOCKLIST.has(model));
		const out = [];
		for (const model of this.#zen) if (this.decision(model).allowed) out.push(model);
		return out.sort();
	}
	/**
	* models.dev declared limits for one model: `contextWindow` (limit.context)
	* and `maxOutput` (limit.output). undefined when the metadata cannot speak
	* for the model (pending, or id absent) or declares no limits — the caller
	* then keeps its own defaults.
	*/
	limits(model) {
		const price = applyLocalOverride(model, this.#prices.get(model));
		if (!price) return void 0;
		if (price.contextWindow === void 0 && price.maxOutput === void 0) return void 0;
		return {
			...price.contextWindow !== void 0 ? { contextWindow: price.contextWindow } : {},
			...price.maxOutput !== void 0 ? { maxOutput: price.maxOutput } : {}
		};
	}
	/**
	* models.dev `modalities.input` for one model: the input kinds it accepts
	* (["text","image","video",…]). undefined when the metadata cannot speak for
	* the model (pending, or id absent) or declares no modalities — the caller
	* then keeps its own vision pattern (isVisionModel).
	*/
	modalities(model) {
		const modalities = applyLocalOverride(model, this.#prices.get(model))?.modalities;
		return modalities === void 0 ? void 0 : [...modalities];
	}
	/**
	* models.dev reasoning capability for one model: `reasoning` flags the
	* always-think models, `effortValues` the declared selectable levels
	* (empty array = reasons but declares no ladder). undefined when the
	* metadata cannot speak for the model (pending, or id absent).
	*/
	reasoningCapability(model) {
		const price = applyLocalOverride(model, this.#prices.get(model));
		if (!price) return void 0;
		return {
			reasoning: price.reasoning === true,
			effortValues: price.effortValues ?? []
		};
	}
	/** healthz models block (design.md 6.1). */
	snapshot() {
		const age = this.#updatedAt === 0 ? Infinity : this.#now() - this.#updatedAt;
		const stale = this.#updatedAt !== 0 && age > 600 * 1e3;
		return {
			status: this.#updatedAt === 0 ? "pending" : stale ? "stale" : "ready",
			total: this.#zen.size,
			exposed: this.list().length,
			...this.#updatedAt !== 0 ? { lastRefresh: new Date(this.#updatedAt).toISOString() } : {}
		};
	}
	get lastError() {
		return this.#lastError;
	}
};
async function withTimeout(promise, timeoutMs = FETCH_TIMEOUT_MS) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await promise;
	} finally {
		clearTimeout(timer);
	}
}
/** S1: fetchModels (models.go:587-618) with the CLI disguise headers. */
async function fetchZenModels(zenBaseUrl, fetchImpl, userAgent) {
	const response = await withTimeout(fetchImpl(`${zenBaseUrl.replace(/\/+$/, "")}/v1/models`, { headers: zenRequestHeaders({
		authorization: "Bearer public",
		"user-agent": userAgent,
		accept: "application/json"
	}) }));
	if (!response.ok) throw new Error(`models endpoint returned HTTP ${response.status}`);
	const payload = await response.json();
	const models = [];
	for (const item of payload.data ?? []) if (typeof item?.id === "string" && item.id.length > 0) models.push(item.id);
	if (models.length === 0) throw new Error("models endpoint returned an empty list");
	return models;
}
async function saveMetadataCache(path, prices, now) {
	const cache = {
		updatedAt: now,
		prices: [...prices]
	};
	const tmp = `${path}.${process.pid}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(tmp, JSON.stringify(cache), "utf8");
	await rm(path, { force: true });
	await rename(tmp, path);
}
async function loadMetadataCache(path, now = Date.now) {
	const raw = JSON.parse(await readFile(path, "utf8"));
	if (now() - raw.updatedAt > 7 * METADATA_REFRESH_MS) throw new Error("models.dev cache too old");
	return new Map(raw.prices);
}
/** Default cache location next to the agent data dir (config.ts convention). */
function defaultCachePath(dataDir) {
	return join(dataDir, "agent-config.json.models.dev.json");
}

//#endregion
export { setRequestHeadersReader as _, decodeModelsDev as a, isFreeModel as c, canonicalSessionID as d, conversationLabel as f, opencodeUserAgent as g, mintedMessageID as h, decide as i, staticFreeModels as l, disguiseHeaders as m, ModelCatalog as n, defaultCachePath as o, deriveRequestIDs as p, ZEN_BASE_URL as r, fetchZenModels as s, FREE_LANE_BLOCKLIST as t, DEFAULT_PROJECT_ID as u, setUserAgentOverride as v };