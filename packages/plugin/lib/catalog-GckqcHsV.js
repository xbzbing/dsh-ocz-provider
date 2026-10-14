import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

//#region src/adapter/ids.ts
/** sha256("prefix\0value") truncated to 12 bytes: stable, non-reversible. */
function stableID(prefix, value) {
	return `${prefix}_${createHash("sha256").update(prefix + "\0" + value).digest().subarray(0, 12).toString("hex")}`;
}
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
* Derive the correlation ids for one upstream request. In adapter mode there
* are no inbound opencode headers, so the seed is the conversation itself.
*/
function deriveRequestIDs(messages) {
	let signal = conversationSeed(messages);
	if (signal === "" || signal === "{}") signal = randomID("fallback", 16);
	return {
		session: canonicalSessionID(signal),
		request: randomID("req", 16),
		project: stableID("prj", "opencode2dsh:default-project"),
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
* bits — a digest-derived prefix reads as a non-OpenCode client and 403s, so
* the timestamp half must be MINTED from the clock (upstream fix:
* jasonxu114514/opencode2api PR #69; the same defect in decolua/9router is
* issue #4780). Live-verified 2026-10-13 against /zen/v1/chat/completions
* with the full gate body: digest prefix -> 403, minted prefix -> 200, the
* same minted id again -> 200.
*/
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/**
* Bounded signal→session cache (upstream PR #69). Entries are keyed by
* digest, because conversation seeds can be large; the whole map drops when
* full, which only costs affinity for the oldest conversations.
*/
const SESSION_CACHE_LIMIT = 8192;
const sessionCache = /* @__PURE__ */ new Map();
/** Clock state for the descending time prefix (mirrors the OpenCode client). */
let sessionCounter = 0;
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
/**
* The 12 hex characters OpenCode derives from `~(unix_ms * 0x1000 +
* counter)` truncated to its low 48 bits — a descending scheme, so newer ids
* sort first. The counter keeps same-millisecond ids distinct; the inversion
* is arithmetic on a BigInt (sign-extended), so taking the low 6 bytes
* yields exactly the official client's prefix.
*/
function mintedTimePrefix() {
	sessionCounter = sessionCounter + 1 & 4095;
	const value = ~(BigInt(Date.now()) * 4096n + BigInt(sessionCounter));
	let hex = "";
	for (let bit = 40; bit >= 0; bit -= 8) hex += Number(value >> BigInt(bit) & 255n).toString(16).padStart(2, "0");
	return hex;
}
/**
* The session id sent upstream. A signal that already carries an official
* OpenCode session passes through unchanged (preserving upstream prompt-cache
* affinity). Any other identity — the conversation seed in adapter mode,
* foreign client sessions, admission probes — keeps its digest-derived
* Base62 tail (stable per conversation, so affinity does not change) but the
* time prefix is MINTED from the clock: the free tier decodes the prefix and
* rejects digest-shaped ones (2026-10-13, upstream PR #69). One signal
* therefore returns one id for the life of the process.
*/
function canonicalSessionID(signal) {
	if (CANONICAL_SESSION_PATTERN.test(signal)) return signal;
	const sum = createHash("sha256").update("ses\0" + signal).digest();
	const key = sum.toString("hex");
	const cached = sessionCache.get(key);
	if (cached !== void 0) return cached;
	const randomPart = base62Fixed(BigInt("0x" + sum.subarray(6, 16).toString("hex")), 14);
	const id = `ses_${mintedTimePrefix()}${randomPart}`;
	if (sessionCache.size >= SESSION_CACHE_LIMIT) sessionCache.clear();
	sessionCache.set(key, id);
	return id;
}
/** CLI-identical user agent (ids.go opencodeUserAgent, node runtime values). */
function opencodeUserAgent() {
	return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`;
}
/**
* The full disguise header set sent with every upstream request
* (design.md 2.4; gateway.go newUpstreamRequest:640-669).
*/
function disguiseHeaders(ids) {
	return {
		"user-agent": opencodeUserAgent(),
		"x-opencode-client": "cli",
		"x-opencode-session": ids.session,
		"x-session-affinity": ids.session,
		"X-Session-Id": ids.session,
		"x-opencode-request": ids.request,
		"x-opencode-project": ids.project
	};
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
const ZEN_BASE_URL = "https://opencode.ai/zen";
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
* section of models.dev, preferring the exact `opencode`/`opencode-zen` key.
*/
function decodeModelsDev(data) {
	const result = /* @__PURE__ */ new Map();
	if (!data || typeof data !== "object") return result;
	const providers = data;
	const keys = Object.keys(providers);
	const rank = (key) => {
		const lower = key.toLowerCase();
		if (lower === "opencode" || lower === "opencode-zen" || lower === "opencode_zen") return 0;
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
	async refreshMetadata() {
		if (this.#cachePath && !this.#pricesReady) {
			const cached = await loadMetadataCache(this.#cachePath, this.#now).catch(() => null);
			if (cached && cached.size > 0) {
				this.#prices = cached;
				this.#pricesReady = true;
			}
		}
		try {
			const response = await withTimeout(this.#fetch(this.#metadataUrl, { headers: { accept: "application/json" } }));
			if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
			const prices = decodeModelsDev(await response.json());
			if (prices.size === 0) throw new Error("models.dev contains no OpenCode model metadata");
			this.#prices = prices;
			this.#pricesReady = true;
			if (this.#cachePath) await saveMetadataCache(this.#cachePath, prices, this.#now());
		} catch (err) {
			if (this.#cachePath && !this.#pricesReady) {
				const cached = await loadMetadataCache(this.#cachePath, this.#now).catch(() => null);
				if (cached && cached.size > 0) {
					this.#prices = cached;
					this.#pricesReady = true;
					return;
				}
			}
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
	const response = await withTimeout(fetchImpl(`${zenBaseUrl.replace(/\/+$/, "")}/v1/models`, { headers: {
		authorization: "Bearer public",
		"user-agent": userAgent,
		"x-opencode-client": "cli",
		accept: "application/json"
	} }));
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
export { decodeModelsDev as a, isFreeModel as c, conversationLabel as d, deriveRequestIDs as f, stableID as g, randomID as h, decide as i, staticFreeModels as l, opencodeUserAgent as m, ModelCatalog as n, defaultCachePath as o, disguiseHeaders as p, ZEN_BASE_URL as r, fetchZenModels as s, FREE_LANE_BLOCKLIST as t, canonicalSessionID as u };