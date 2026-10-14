import { AsyncLocalStorage } from "node:async_hooks";
import "undici";

//#region src/pool/usage.ts
/** Pseudo exit id for pool-host traffic that fell back to a direct connection. */
const DIRECT_EXIT_ID = "direct";
/**
* Pseudo exit id for traffic this process sent out from the local machine
* instead of through a pool exit (hosts outside the pool, or every request
* while routing is off). Separate from {@link DIRECT_EXIT_ID}, which is the
* narrower diagnostic "should have used the pool but could not" bucket; the
* status bridge merges both into the modal's 本机 row.
*/
const LOCAL_EXIT_ID = "local";
function zeroTotals() {
	return {
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		outputMs: 0
	};
}
/** A fresh all-zero bucket (bridge stubs for a disabled pool). */
const emptyTotals = zeroTotals;
/** Mutable accumulator map keyed by exit id. One instance per process. */
var UsageTracker = class {
	#byExit = /* @__PURE__ */ new Map();
	/** Last record time per bucket (epoch ms) — the modal's 最后使用 column. */
	#lastAt = /* @__PURE__ */ new Map();
	/** Attribute one response's usage to one exit id. */
	record(exitId, usage, _meta) {
		const bucket = this.#byExit.get(exitId) ?? zeroTotals();
		const input = usage.inputTokens ?? 0;
		const output = usage.outputTokens ?? 0;
		bucket.requests += 1;
		bucket.inputTokens += input;
		bucket.outputTokens += output;
		bucket.cacheReadTokens += usage.cacheReadTokens ?? 0;
		bucket.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		bucket.totalTokens += input + output;
		bucket.outputMs += usage.durationMs ?? 0;
		this.#byExit.set(exitId, bucket);
		this.#lastAt.set(exitId, Date.now());
	}
	/** A copy of one bucket (zeros when nothing was recorded). */
	totals(exitId) {
		return { ...this.#byExit.get(exitId) ?? zeroTotals() };
	}
	/** Epoch ms of the last recorded response for one bucket (0 = never). */
	lastUsedAt(exitId) {
		return this.#lastAt.get(exitId) ?? 0;
	}
	/** Every exit id with recorded usage (diagnostics). */
	exits() {
		return [...this.#byExit.keys()];
	}
	/** Test seam / future reset action. */
	reset() {
		this.#byExit.clear();
		this.#lastAt.clear();
	}
};
/** The process-lifetime tracker: adapter writes, status bridge reads. */
const usageTracker = new UsageTracker();
/**
* Where `attributeUsage` writes by default. The plugin swaps in the persistent
* ledger at apply() time (usage-store.ts), which keeps the run-scope tracker
* inside itself — this seam exists so usage.ts never has to import the ledger
* (the two modules would form an import cycle, and the ledger pulls node:fs in
* with it). A composition without the swap keeps the plain in-process tracker,
* which is also what the unit tests exercise.
*/
let activeRecorder = usageTracker;
/** Install the recorder `attributeUsage` should write to (null restores the tracker). */
function setUsageRecorder(recorder) {
	activeRecorder = recorder ?? usageTracker;
}
/**
* Pass a chunk stream through, recording every `usage` chunk against the
* routing context's exit stamp. Placed around the adapter's per-attempt
* output so each attempt's tokens land on the exit that actually carried
* that attempt (a rotate restart therefore splits correctly across exits).
*
* Also measures each response's decode window — the wall time from the FIRST
* output delta (text/reasoning/tool-call) to the `usage` chunk — and hands
* it to the tracker as `durationMs`, the denominator of the tok/s column.
* Prompt processing and queueing before the first token are excluded on
* purpose: the number answers "how fast does this exit generate", not "how
* long did the user wait". Each usage closes the window the preceding
* deltas opened — a later response in the same stream starts a fresh one,
* so multi-response streams do not inflate a single window. A response with
* no output delta (empty/aborted before any token) records no window.
*
* A context with no stamp means nothing routed this request through a pool
* exit — the pool is off, the host is outside the proxy set, or routing was
* never installed. That is exactly the 本机 ledger, so the usage lands in
* {@link LOCAL_EXIT_ID} rather than being dropped: the modal can then show
* that model traffic is leaving from this machine even while the pool looks
* healthy (the failure mode this bucket was added for, live 2026-10-13).
*/
async function* attributeUsage(store, source, recorder = void 0, now = Date.now) {
	const target = recorder ?? activeRecorder;
	let firstDeltaAt;
	for await (const chunk of source) {
		if (chunk.type === "text-delta" || chunk.type === "reasoning-delta" || chunk.type === "tool-call-delta") firstDeltaAt ??= now();
		else if (chunk.type === "usage") {
			const durationMs = firstDeltaAt === void 0 ? void 0 : Math.max(1, now() - firstDeltaAt);
			firstDeltaAt = void 0;
			target.record(store.exitId ?? LOCAL_EXIT_ID, {
				...chunk.usage,
				durationMs
			}, {
				session: store.usageSession,
				label: store.usageLabel
			});
		}
		yield chunk;
	}
}

//#endregion
//#region src/pool/dispatcher.ts
/** Per-request routing context (docs/ip-pool.md 3.3): pi-ai builds the body
*  and dispatches on separate layers with no model channel between them, so
*  the adapter sets this at stream() entry and the dispatcher reads it. */
const routingContext = new AsyncLocalStorage();
const DEFAULT_PROXY_HOSTS = ["opencode.ai"];
const PROXY_PROTOCOL_PREFIX = /^[a-z0-9+.-]+:\/\//i;
/**
* The path prefixes this plugin's OWN traffic uses on the proxied hosts.
*
* Host matching alone is too coarse to mean "our traffic": one opencode.ai
* serves the free lane this plugin's adapter calls, the paid/go lane (driven
* by the separate `opencode-go` provider) and the usage-billing plugin's
* usage poll. Live 2026-10-13 with host-only routing: 77 `POST
* /zen/go/v1/chat/completions` in 6.3 minutes (≈12/min) were proxied through
* the airport exits and counted as requests with zero tokens (tokens are
* attributed only for traffic that flows through our adapter), so "I stopped
* using opencode2dsh models" and "the request count keeps climbing" were both
* true — and paid-lane traffic was egressing through free airport exits by
* accident.
*
* The lane moved on 2026-10-14: the adapter now calls
* `https://opencode.ai/inference/v1` (adapter/catalog.ts `ZEN_BASE_URL`) and
* the go lane sits at `/inference/go/v1`, so the default follows the adapter —
* `/inference/v1` does not take `/inference/go/v1` (segment-aware match
* below), which keeps the isolation this constant exists for. An operator whose
* profile still stores the old `/zen/v1` keeps their explicit value; the
* settings card shows it, and `/inference/v1` must be added there for the pool
* to carry the lane again.
*
* Empty means "every path on the proxied hosts" (the old behaviour), which
* stays reachable for anyone who wants the pool to carry the whole host.
*/
const DEFAULT_PROXY_PATH_PREFIXES = ["/inference/v1"];
/**
* The effective path-prefix list: an absent OR EMPTY list means the default.
* Same empty-equals-absent rule as {@link resolveProxyHosts}, and for the
* same reason: the settings schema hands the runtime `[]` when the user never
* touched the field, and an empty list read literally would exclude every
* path — the mirror image of the empty-host-list bug below.
*/
function resolveProxyPathPrefixes(prefixes) {
	const normalized = (prefixes ?? []).map((prefix) => normalizePathPrefix(prefix)).filter((prefix) => prefix !== "");
	return normalized.length > 0 ? normalized : [...DEFAULT_PROXY_PATH_PREFIXES];
}
/** 'inference/v1/', '/inference/v1?x=1' -> '/inference/v1'; an unusable entry -> '' (dropped). */
function normalizePathPrefix(prefix) {
	const trimmed = (prefix ?? "").trim().split("?")[0]?.trim() ?? "";
	if (trimmed === "") return "";
	const rooted = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	return rooted.length > 1 ? rooted.replace(/\/+$/, "") : rooted;
}
/** Segment-aware prefix match: '/inference/v1' takes '/inference/v1' and
*  '/inference/v1/chat/completions?x=1', never '/inference/v10' or
*  '/inference/go/v1'. */
function matchesPathPrefix(path, prefix) {
	const clean = path.split("?")[0] ?? "";
	if (prefix === "/") return true;
	return clean === prefix || clean.startsWith(`${prefix}/`);
}
/** The request path from either dispatch shape. undici's fetch builds
*  `{origin, path}` (lib/web/fetch/index.js: `url.pathname + url.search`); a
*  raw DispatchOptions or a Request-shaped argument carries the rest. */
function dispatchRequestPath(options) {
	const direct = options.path;
	if (typeof direct === "string") return direct;
	const candidate = options.url;
	const text = typeof candidate === "string" ? candidate : candidate !== null && typeof candidate === "object" && "url" in candidate ? String(candidate.url) : "";
	if (text === "") return "";
	try {
		const url = new URL(text);
		return `${url.pathname}${url.search}`;
	} catch {
		return "";
	}
}
/**
* The effective proxied-host set: an absent OR EMPTY list means the default.
*
* Empty must fall back exactly like absent. Live-observed 2026-10-13: the
* settings layer hands the runtime `proxyHosts: []` (that schema's own
* default), and the old `?? DEFAULT_PROXY_HOSTS` guard waved it straight
* through as an EMPTY host set — so every model call took the direct branch
* while the settings card kept displaying `opencode.ai` (its display
* fallback), i.e. the pool reported itself enabled and healthy and silently
* routed nothing.
*/
function resolveProxyHosts(hosts) {
	const normalized = (hosts ?? []).map((host) => normalizeHost(host)).filter((host) => host !== "");
	return normalized.length > 0 ? normalized : DEFAULT_PROXY_HOSTS.map((host) => normalizeHost(host));
}
/** 'host:port' -> 'host' (bracket-aware) for host matching. */
function normalizeHost(host) {
	if (!host) return "";
	let value = host.trim().toLowerCase();
	if (value.includes("://")) try {
		value = new URL(value).hostname;
	} catch {}
	return value.replace(/:\d+$/, "").replace(/^\[(.+)\]$/, "$1");
}
function isLoopback(host) {
	const normalized = normalizeHost(host);
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
/** Map an exit address to a ProxyAgent URI ('h:1' -> 'http://h:1'). */
function exitProxyUri(exitId, protocol) {
	const scheme = protocol === "socks5" ? "socks5" : "http";
	return PROXY_PROTOCOL_PREFIX.test(exitId) ? exitId : `${scheme}://${exitId}`;
}
var PoolRoutingDispatcher = class {
	#pool;
	#undici;
	#proxyHosts;
	#proxyPathPrefixes;
	#agentLruCap;
	#sentinelMs;
	#headersMs;
	#logger;
	/** Direct path for non-pool hosts and loopback. */
	#direct;
	/** LRU of per-exit ProxyAgents (docs/ip-pool.md 2, exit multi-instance). */
	#agents = /* @__PURE__ */ new Map();
	#agentsOrder = [];
	#closed = false;
	constructor(options) {
		this.#pool = options.pool;
		this.#undici = options.undici;
		this.#proxyHosts = new Set(resolveProxyHosts(options.proxyHosts));
		this.#proxyPathPrefixes = resolveProxyPathPrefixes(options.proxyPathPrefixes);
		this.#agentLruCap = options.agentLruCap ?? 16;
		this.#sentinelMs = options.sentinelMs ?? 2e3;
		this.#headersMs = options.headersMs ?? 3e4;
		this.#logger = options.logger;
		this.#direct = new options.undici.Agent();
	}
	/** Live re-apply of the proxied-host list (settings page, docs §5.1). */
	setProxyHosts(hosts) {
		this.#proxyHosts = new Set(resolveProxyHosts(hosts));
	}
	/** The proxied-host set as configured (diagnostics / status bridge). */
	get proxyHosts() {
		return [...this.#proxyHosts];
	}
	/** Live re-apply of the path scope (settings page, docs §5.1). */
	setProxyPathPrefixes(prefixes) {
		this.#proxyPathPrefixes = resolveProxyPathPrefixes(prefixes);
	}
	/** The path scope in force (diagnostics / status bridge). */
	get proxyPathPrefixes() {
		return [...this.#proxyPathPrefixes];
	}
	/**
	* Does this request belong to the pool's configured scope?
	*
	* An EMPTY path means the caller never exposed one (a raw dispatch, a future
	* undici shape): that counts as IN scope. Guessing "out" there would
	* silently disable routing — the failure class this file has already been
	* bitten by twice (empty host list, deferred dispatcher) — while guessing
	* "in" at worst sends one extra request through an exit on a host the user
	* explicitly opted into.
	*/
	#inScope(path) {
		if (path === "") return true;
		return this.#proxyPathPrefixes.some((prefix) => matchesPathPrefix(path, prefix));
	}
	/** The agent for one exit, LRU-capped (docs/ip-pool.md 2). */
	#agentFor(exitId) {
		const cached = this.#agents.get(exitId);
		if (cached) {
			const index = this.#agentsOrder.indexOf(exitId);
			if (index >= 0) this.#agentsOrder.splice(index, 1);
			this.#agentsOrder.push(exitId);
			return cached;
		}
		const exit = this.#pool.get(exitId);
		if (!exit) return null;
		try {
			const seam = this.#undici;
			const agent = new seam.ProxyAgent({
				uri: exitProxyUri(exit.id, exit.protocol),
				clientFactory: (origin, opts) => new seam.Agent({
					...opts,
					pipelining: 0
				})
			});
			this.#agents.set(exitId, agent);
			this.#agentsOrder.push(exitId);
			if (this.#agentsOrder.length > this.#agentLruCap) {
				const evict = this.#agentsOrder.shift();
				if (evict !== void 0) {
					const old = this.#agents.get(evict);
					this.#agents.delete(evict);
					old?.destroy().catch(() => {});
				}
			}
			return agent;
		} catch (err) {
			this.#logger?.warn(`opencode2dsh: failed to build proxy agent for ${exitId}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}
	dispatch(options, handler) {
		if (this.#closed) {
			handler.onResponseError?.({}, /* @__PURE__ */ new Error("opencode2dsh: routing dispatcher closed"));
			return false;
		}
		const host = normalizeHost(String(options.origin ?? ""));
		if (isLoopback(host)) return this.#direct.dispatch(options, handler);
		if (!this.#proxyHosts.has(host)) {
			const context$1 = routingContext.getStore();
			if (context$1 !== void 0) context$1.exitId = LOCAL_EXIT_ID;
			return this.#direct.dispatch(options, handler);
		}
		if (!this.#inScope(dispatchRequestPath(options))) return this.#direct.dispatch(options, handler);
		const context = routingContext.getStore() ?? {};
		const model = context.model ?? "default";
		const session = context.session ?? "default";
		const exitId = this.#pool.pick(session, model);
		if (exitId === null) {
			context.exitId = DIRECT_EXIT_ID;
			this.#pool.recordDirectRequest();
			return this.#direct.dispatch(options, handler);
		}
		const agent = this.#agentFor(exitId);
		if (!agent) {
			context.exitId = DIRECT_EXIT_ID;
			this.#pool.recordDirectRequest();
			return this.#direct.dispatch(options, handler);
		}
		context.exitId = exitId;
		this.#pool.beginRequest(exitId);
		return agent.dispatch(options, this.#observe(exitId, model, session, handler));
	}
	/**
	* Wrap the downstream handler with the passive-signal observer
	* (docs/ip-pool.md §4.2 rule table, §4.3 被动): the real request's own
	* outcome feeds the two-tier health — free liveness data no probe spends
	* quota on. Body bytes stream through untouched; only the response start
	* line and terminal transport errors are read.
	*
	* Forwarding discipline (measured against undici 8.10 on this host): the
	* fetch handler's methods live on a prototype with private state, so a
	* spread would strip them and Object.create delegation would re-enter
	* them with the wrong `this`. The wrapper is a fresh plain object that
	* forwards every DispatchHandler callback to the original with the
	* original as `this` — the same shape undici's own wrappers use.
	*
	* Response-silence sentinel: undici's Pool fires NONE of the handler
	* callbacks (not even onResponseError) when a proxy CONNECT fails at the
	* connection stage — the failure surfaces only as a fetch rejection (and
	* an APIConnectionError/"Connection error." upstream). Without a fallback
	* the passive signal is blind exactly when a dead exit needs to be evicted
	* (live repro: 10.255.255.1:9999 blackhole, seen:[] callbacks). So the
	* wrapper arms a timer at dispatch time; any handler callback disarms it,
	* and silence past the deadline counts as a transport failure (dead strike
	* + session reroute). The sentinel never aborts the request itself — fetch
	* and pi-ai own their own timeouts.
	*/
	#observe(exitId, model, session, handler) {
		const pool = this.#pool;
		const forward = (method, args) => {
			const fn = handler[method];
			if (typeof fn === "function") fn.apply(handler, args);
		};
		let classified = false;
		let ended = false;
		const end = () => {
			if (ended) return;
			ended = true;
			pool.endRequest(exitId);
		};
		const classify = (statusCode) => {
			if (classified) return;
			classified = true;
			if (pool.recordPassive(exitId, statusCode, model) !== "ok") pool.rerouteSession(session);
		};
		let liveController = null;
		const classifyTransport = (why) => {
			if (classified) return;
			classified = true;
			pool.recordPassiveTransport(exitId);
			pool.rerouteSession(session);
			end();
			this.#logger?.warn(`opencode2dsh: exit ${exitId} marked dead (${why})`);
			const reason = /* @__PURE__ */ new Error("opencode2dsh: exit response silence");
			if (typeof handler.onResponseError === "function") handler.onResponseError.call(handler, liveController ?? {}, reason);
			liveController?.abort?.(reason);
		};
		const armSentinel = () => {
			clearTimeout(sentinel);
			const window = sawRequestStart ? this.#headersMs : this.#sentinelMs;
			sentinel = setTimeout(() => classifyTransport(sawRequestStart ? `no response headers within ${this.#headersMs}ms of request start` : `no request start within ${this.#sentinelMs}ms of dispatch (proxy CONNECT never completed)`), window);
			sentinel.unref?.();
		};
		let sawRequestStart = false;
		let sentinel = void 0;
		armSentinel();
		const disarm = () => {
			clearTimeout(sentinel);
		};
		return {
			onRequestStart: (controller, context) => {
				liveController = controller;
				sawRequestStart = true;
				armSentinel();
				forward("onRequestStart", [controller, context]);
			},
			onRequestUpgrade: (controller, statusCode, headers, socket) => {
				liveController = controller;
				disarm();
				end();
				forward("onRequestUpgrade", [
					controller,
					statusCode,
					headers,
					socket
				]);
			},
			onResponseStart: (controller, statusCode, headers, statusMessage) => {
				liveController = controller;
				disarm();
				classify(statusCode);
				forward("onResponseStart", [
					controller,
					statusCode,
					headers,
					statusMessage
				]);
			},
			onResponseData: (controller, chunk) => {
				liveController = controller;
				forward("onResponseData", [controller, chunk]);
			},
			onResponseEnd: (controller, trailers) => {
				liveController = controller;
				disarm();
				end();
				forward("onResponseEnd", [controller, trailers]);
			},
			onResponseError: (controller, error) => {
				liveController = controller;
				disarm();
				classifyTransport(`transport error: ${error instanceof Error ? error.message : String(error)}`);
				end();
				forward("onResponseError", [controller, error]);
			},
			onResponseStarted: () => {
				disarm();
				forward("onResponseStarted", []);
			},
			onBodySent: (chunk) => forward("onBodySent", [chunk]),
			onRequestSent: () => forward("onRequestSent", [])
		};
	}
	close() {
		this.#closed = true;
		const jobs = [this.#direct.close(), ...[...this.#agents.values()].map((a) => a.close())];
		return Promise.all(jobs).then(() => void 0);
	}
	destroy() {
		this.#closed = true;
		const jobs = [this.#direct.destroy(), ...[...this.#agents.values()].map((a) => a.destroy())];
		this.#agents.clear();
		this.#agentsOrder = [];
		return Promise.all(jobs).then(() => void 0);
	}
};

//#endregion
export { resolveProxyPathPrefixes as a, LOCAL_EXIT_ID as c, emptyTotals as d, setUsageRecorder as f, resolveProxyHosts as i, UsageTracker as l, PoolRoutingDispatcher as n, routingContext as o, usageTracker as p, exitProxyUri as r, DIRECT_EXIT_ID as s, DEFAULT_PROXY_PATH_PREFIXES as t, attributeUsage as u };