import { networkInterfaces } from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import "undici";
import { lookup } from "node:dns";

//#region src/pool/local-family.ts
/** Shipped default: prefer IPv6 where this machine has it (mirrors the app). */
const DEFAULT_LOCAL_IP_FAMILY = "auto";
/**
* Anything that is not one of the two explicit positions resolves to `auto` —
* a hand-edited profile patch must not be able to make the field unreadable
* (same tolerance `resolveUsageScope` has for its own string setting).
*/
function resolveLocalIpFamily(value) {
	return value === "ipv4" || value === "ipv6" ? value : DEFAULT_LOCAL_IP_FAMILY;
}
/**
* Does this machine carry an IPv6 address it could actually leave by?
*
* Link-local (`fe80::/10`) does not count: every interface has one and it is
* never routable off-link, so counting it would send the lane to a family the
* host may not have at all — the exact mistake this check exists to avoid.
* Unique-local (`fd00::/8`, `fc00::/7`) DOES count: the installed app reaches
* opencode.ai from a ULA source on this host, so it is a working path here
* (docs/ip-pool.md §3.7).
*/
function hasIpv6Address(listInterfaces = networkInterfaces) {
	let table;
	try {
		table = listInterfaces();
	} catch {
		return false;
	}
	for (const rows of Object.values(table)) for (const row of rows ?? []) {
		if ((typeof row.family === "string" ? row.family : row.family === 6 ? "IPv6" : "IPv4") !== "IPv6" || row.internal === true) continue;
		const address = row.address.toLowerCase().split("%")[0] ?? "";
		if (address === "" || address === "::1" || address.startsWith("fe80")) continue;
		return true;
	}
	return false;
}
/** IPv6 ranks above IPv4; a family-0 answer (not an IP at all) ranks last. */
function rank(address) {
	return address.family === 6 ? 2 : address.family === 4 ? 1 : 0;
}
/**
* The resolver's answers with AAAA first, every answer kept.
*
* Exported because this ordering IS the behaviour worth testing: it is the one
* thing that makes `auto` reach IPv6 at all on a host whose resolver hands
* back A records before AAAA (this machine does exactly that for opencode.ai).
*/
function sortIpv6First(addresses) {
	return [...addresses].sort((a, b) => rank(b) - rank(a));
}
/**
* `dns.lookup` with the AAAA answers first.
*
* The ordering is the whole point: `autoSelectFamily` only races the next
* address when the previous CONNECTION fails, and the free lane's refusal is
* an HTTP-level 403 that arrives over a perfectly healthy IPv4 socket — so a
* happy-eyeballs setup that starts on IPv4 never reaches IPv6. Reversing the
* resolver's order is what makes the IPv6 attempt first; keeping every answer
* (never filtering to one family) is what keeps the fallback intact for hosts
* and networks where IPv6 is absent, unroutable or black-holed.
*/
const ipv6FirstLookup = (hostname, options, callback) => {
	const opts = options ?? {};
	lookup(hostname, {
		...opts,
		all: true
	}, (err, addresses) => {
		if (err) {
			callback(err, "", 0);
			return;
		}
		const sorted = sortIpv6First(Array.isArray(addresses) ? addresses : []);
		const first = sorted[0];
		if (first === void 0) {
			callback(Object.assign(/* @__PURE__ */ new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
				code: "ENOTFOUND",
				errno: -3008,
				syscall: "getaddrinfo",
				hostname
			}), "", 0);
			return;
		}
		if (opts.all === true) callback(null, sorted);
		else callback(null, first.address, first.family);
	});
};
/**
* The `connect` options for the local-egress Agent, from one dropdown position.
*
* An empty object means "no opinion": the Agent then resolves with Node's own
* order (IPv4 first on hosts like this one).
*/
function localEgressConnectOptions(family = DEFAULT_LOCAL_IP_FAMILY, listInterfaces = networkInterfaces) {
	if (family === "ipv4") return { family: 4 };
	if (family === "ipv6") return { family: 6 };
	return hasIpv6Address(listInterfaces) ? { lookup: ipv6FirstLookup } : {};
}

//#endregion
//#region src/proxy-entry.ts
const SCHEMES = {
	http: "http",
	https: "http",
	socks4: "socks5",
	socks5: "socks5",
	socks5h: "socks5"
};
const AUTHORITY = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):(\d{1,5})$/;
/**
* Parse `[scheme://]host:port`. Credentials (`user:pw@`) are refused: the
* entry is the row id, which lands in logs, /status and usage.json.
*/
function parseManualProxy(entry) {
	const trimmed = entry.trim();
	if (trimmed === "") return null;
	const schemeMatch = /^([a-z0-9+.-]+):\/\//i.exec(trimmed);
	let protocol = "http";
	if (schemeMatch) {
		const mapped = SCHEMES[schemeMatch[1].toLowerCase()];
		if (mapped === void 0) return null;
		protocol = mapped;
	}
	const rest = schemeMatch ? trimmed.slice(schemeMatch[0].length) : trimmed;
	const match = AUTHORITY.exec(rest);
	if (match === null) return null;
	const port = Number(match[2]);
	if (port < 1 || port > 65535) return null;
	return {
		id: trimmed,
		protocol,
		host: match[1],
		port
	};
}

//#endregion
//#region src/pool/agent-cache.ts
var ExitAgentCache = class {
	#cap;
	#build;
	/** Map insertion order is the LRU order (oldest first). */
	#entries = /* @__PURE__ */ new Map();
	constructor(cap, build) {
		this.#cap = Math.max(1, cap);
		this.#build = build;
	}
	get size() {
		return this.#entries.size;
	}
	/** The agent dialling `uri` for this exit; `build` errors propagate. */
	get(exitId, uri) {
		const cached = this.#entries.get(exitId);
		if (cached !== void 0) {
			this.#entries.delete(exitId);
			if (cached.uri === uri) {
				this.#entries.set(exitId, cached);
				return cached.agent;
			}
			retire(cached.agent);
		}
		const agent = this.#build(uri);
		this.#entries.set(exitId, {
			uri,
			agent
		});
		while (this.#entries.size > this.#cap) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === void 0) break;
			const evicted = this.#entries.get(oldest);
			this.#entries.delete(oldest);
			if (evicted !== void 0) retire(evicted.agent);
		}
		return agent;
	}
	/** Every cached agent (dispatcher close/destroy). */
	agents() {
		return [...this.#entries.values()].map((entry) => entry.agent);
	}
	clear() {
		this.#entries.clear();
	}
};
function retire(agent) {
	agent.close().catch(() => {});
}

//#endregion
//#region src/pool/outcome.ts
/**
* May a request the pool cannot carry leave from this machine? Only with
* 本地出口兜底 on, or under an explicit 固定本机 pin (docs/ip-pool.md §3.3).
*/
function mayEgressLocally(pool, localFallback) {
	return localFallback || pool.pinnedLocal;
}
/** Grade one upstream status against its exit; a degraded exit loses the session binding. */
function settleStatus(pool, pick, status) {
	const verdict = pool.recordPassive(pick.exitId, status, pick.model);
	if (verdict !== "ok") pool.rerouteSession(pick.session);
	return verdict;
}
/**
* One transport cut: handed to the judge (pool/transport.ts) when one is
* wired, a strike otherwise. The session moves to another exit either way.
*/
function settleTransport(pool, pick, judge) {
	if (judge !== void 0) judge(pick.exitId);
	else pool.recordPassiveTransport(pick.exitId);
	pool.rerouteSession(pick.session);
}

//#endregion
//#region src/pool/observer.ts
function observeExitRequest(options, handler) {
	const { pool, exitId, model, session } = options;
	const pick = {
		exitId,
		model,
		session
	};
	const forward = (method, args) => {
		const fn = handler[method];
		if (typeof fn === "function") fn.apply(handler, args);
	};
	/** A status or a cut has graded this request; nothing grades it twice. */
	let classified = false;
	/** A terminal callback reached the handler; everything after is dropped. */
	let terminated = false;
	/** The begun request is booked as ended (exactly once per dispatch). */
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		pool.endRequest(exitId);
	};
	const classify = (statusCode) => {
		if (classified) return;
		classified = true;
		settleStatus(pool, pick, statusCode);
	};
	const cut = (why) => {
		if (classified) return;
		classified = true;
		settleTransport(pool, pick, options.onTransportCut);
		options.logger?.warn(`oc2dsh: exit ${exitId} transport cut (${why})`);
	};
	let liveController = null;
	let sawRequestStart = false;
	let sentinel;
	const disarm = () => {
		clearTimeout(sentinel);
	};
	const onSilence = (why) => {
		if (terminated) return;
		cut(why);
		end();
		terminated = true;
		const reason = /* @__PURE__ */ new Error("oc2dsh: exit response silence");
		forward("onResponseError", [liveController ?? {}, reason]);
		liveController?.abort?.(reason);
	};
	const armSentinel = () => {
		disarm();
		const window = sawRequestStart ? options.headersMs : options.sentinelMs;
		sentinel = setTimeout(() => onSilence(sawRequestStart ? `no response headers within ${options.headersMs}ms of request start` : `no request start within ${options.sentinelMs}ms of dispatch (proxy CONNECT never completed)`), window);
		sentinel.unref?.();
	};
	armSentinel();
	/** Forward a non-terminal callback unless the request already terminated. */
	const pass = (method, args) => {
		if (!terminated) forward(method, args);
	};
	/** Forward the one terminal callback the handler gets. */
	const finish = (method, args) => {
		if (terminated) return;
		terminated = true;
		disarm();
		end();
		forward(method, args);
	};
	return {
		onRequestStart: (controller, context) => {
			if (terminated) return;
			liveController = controller;
			sawRequestStart = true;
			armSentinel();
			forward("onRequestStart", [controller, context]);
		},
		onRequestUpgrade: (controller, statusCode, headers, socket) => {
			liveController = controller;
			finish("onRequestUpgrade", [
				controller,
				statusCode,
				headers,
				socket
			]);
		},
		onResponseStart: (controller, statusCode, headers, statusMessage) => {
			if (terminated) return;
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
			pass("onResponseData", [controller, chunk]);
		},
		onResponseEnd: (controller, trailers) => {
			liveController = controller;
			finish("onResponseEnd", [controller, trailers]);
		},
		onResponseError: (controller, error) => {
			if (terminated) return;
			liveController = controller;
			cut(`transport error: ${error instanceof Error ? error.message : String(error)}`);
			finish("onResponseError", [controller, error]);
		},
		onResponseStarted: () => {
			if (terminated) return;
			disarm();
			forward("onResponseStarted", []);
		},
		onBodySent: (chunk) => pass("onBodySent", [chunk]),
		onRequestSent: () => pass("onRequestSent", [])
	};
}

//#endregion
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
/**
* Rolling window for the tok/s display (docs/ip-pool.md §5.5): a lifetime
* weighted mean has too much inertia to answer "how fast is this exit NOW" —
* one bad day poisons the number forever.
*/
const RECENT_WINDOW_MS = 18e4;
/**
* Display floor: a window carrying fewer output tokens than this reads 0 and
* the UI hides the chip. Without it, a window holding one half-second blip
* shows a confident number made of noise (the free lane's traffic is bursty).
*/
const RECENT_MIN_TOKENS = 50;
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
	/** Rolling timed samples per bucket — the recent-window tok/s ring. */
	#recent = /* @__PURE__ */ new Map();
	#now;
	constructor(options = {}) {
		this.#now = options.now ?? Date.now;
	}
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
		const at = this.#now();
		this.#lastAt.set(exitId, at);
		const ms = usage.durationMs ?? 0;
		if (ms > 0) {
			const samples = this.#recent.get(exitId) ?? [];
			samples.push({
				at,
				tokens: output,
				ms
			});
			pruneSamples(samples, at);
			this.#recent.set(exitId, samples);
		}
	}
	/** A copy of one bucket (zeros when nothing was recorded). */
	totals(exitId) {
		return { ...this.#byExit.get(exitId) ?? zeroTotals() };
	}
	/**
	* Recent output speed (tok/s) over the {@link RECENT_WINDOW_MS} window for
	* one bucket. Weighted mean of the windowed responses (sum tokens / sum
	* decode window); 0 when the window is empty or below
	* {@link RECENT_MIN_TOKENS} — the UI hides the number then.
	*/
	speed(exitId) {
		return this.speedFor([exitId]);
	}
	/** Recent speed merged over several buckets (the 本机 row's direct+local). */
	speedFor(exitIds, at = this.#now()) {
		let tokens = 0;
		let ms = 0;
		for (const id of exitIds) {
			const samples = this.#recent.get(id);
			if (samples === void 0) continue;
			for (const sample of samples) {
				if (sample.at < at - RECENT_WINDOW_MS) continue;
				tokens += sample.tokens;
				ms += sample.ms;
			}
		}
		if (ms <= 0 || tokens < RECENT_MIN_TOKENS) return 0;
		return Math.round(tokens * 1e3 / ms);
	}
	/** Pool-wide recent speed: every timed bucket in the window. */
	speedAll(at = this.#now()) {
		return this.speedFor([...this.#recent.keys()], at);
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
		this.#recent.clear();
	}
};
/** Drop samples that fell out of the recent window (oldest first). */
function pruneSamples(samples, now) {
	const cutoff = now - RECENT_WINDOW_MS;
	let firstLive = 0;
	while (firstLive < samples.length && samples[firstLive].at < cutoff) firstLive += 1;
	if (firstLive > 0) samples.splice(0, firstLive);
}
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
* it to the tracker as `durationMs`, the per-response window the recent
* tok/s ring and the ledger's cumulative outputMs both accumulate. Prompt
* processing and queueing before the first token are excluded on purpose:
* the number answers "how fast does this exit generate", not "how long did
* the user wait". Each usage closes the window the preceding deltas opened —
* a later response in the same stream starts a fresh one, so multi-response
* streams do not inflate a single window. A response with no output delta
* (empty/aborted before any token) records no window.
*
* A context with no stamp means nothing routed this request through a pool
* exit — the pool is off, the host is outside the proxy set, or routing was
* never installed. That is exactly the 本机 ledger, so the usage lands in
* {@link LOCAL_EXIT_ID} rather than being dropped: the modal can then show
* that model traffic is leaving from this machine even while the pool looks
* healthy.
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
/**
* The error a request gets when the pool cannot carry it and local egress is
* switched off. Fetch surfaces it as "fetch failed" with this as the cause;
* the message is the only place the reason is stated, so it names the switch.
*/
const NO_EXIT_MESSAGE = "oc2dsh: no usable pool exit and the local-egress fallback is off (本地出口兜底已关闭)";
const DEFAULT_PROXY_HOSTS = ["opencode.ai"];
const PROXY_PROTOCOL_PREFIX = /^[a-z0-9+.-]+:\/\//i;
/**
* The path prefixes this plugin's OWN traffic uses on the proxied hosts.
*
* Host matching alone is too coarse to mean "our traffic": one opencode.ai
* serves the free lane this plugin's adapter calls, the paid/go lane (driven
* by the separate `opencode-go` provider) and the usage-billing plugin's usage
* poll — with host-only routing, foreign lane traffic rides the airport exits
* and lands in this pool's request counters as zero-token requests.
*
* The default follows the adapter's `https://opencode.ai/inference/v1`
* (adapter/catalog.ts `ZEN_BASE_URL`), and the segment-aware match below keeps
* `/inference/v1` from taking `/inference/go/v1` — that isolation is what this
* constant exists for. An operator whose profile still stores `/zen/v1` keeps
* that explicit value and must add `/inference/v1` for the pool to carry the
* lane again.
*
* Empty means "every path on the proxied hosts", which stays reachable for
* anyone who wants the pool to carry the whole host.
*/
const DEFAULT_PROXY_PATH_PREFIXES = ["/inference/v1"];
/**
* The effective path-prefix list: an absent OR EMPTY list means the default.
* Same empty-equals-absent rule as {@link resolveProxyHosts}, and for the
* same reason: the settings schema hands the runtime `[]` when the user never
* touched the field, and an empty list read literally would exclude every
* path — the mirror image of the empty-host-list rule below.
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
* Empty must fall back exactly like absent: the settings layer hands the
* runtime `proxyHosts: []` (that schema's own default), and an empty host set
* read literally sends every model call down the direct branch while the
* settings card keeps displaying its `opencode.ai` fallback — the pool would
* report itself enabled and healthy and silently route nothing.
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
/**
* The URI an exit is dialled with: its host:port under the row's CURRENT
* protocol, never the scheme the id was typed with, so a relabelled row dials
* what the listener speaks. `https` survives only for an https entry still
* labelled http.
*/
function exitProxyUri(exitId, protocol) {
	const trimmed = exitId.trim();
	const parsed = parseManualProxy(trimmed);
	const authority = parsed !== null ? `${parsed.host}:${parsed.port}` : trimmed.replace(PROXY_PROTOCOL_PREFIX, "");
	if (protocol === "socks5") return `socks5://${authority}`;
	return /^https:\/\//i.test(trimmed) ? `https://${authority}` : `http://${authority}`;
}
var PoolRoutingDispatcher = class {
	#pool;
	#undici;
	#proxyHosts;
	#proxyPathPrefixes;
	#sentinelMs;
	#headersMs;
	/** 本地出口兜底 in force (docs §3.3); false = pool-only, never local. */
	#localFallback;
	/** 本机出口协议族 in force (local-family.ts). */
	#localFamily;
	/** Interface-table seam for `auto`; undefined = the real interface table. */
	#listInterfaces;
	/**
	* Who judges a transport cut. Wired by the runtime to pool/transport.ts,
	* which can tell a mislabelled listener from a dead line; unset means "a cut
	* is a strike".
	*/
	#onTransportCut;
	#logger;
	/** Direct path for non-pool hosts and loopback. */
	#direct;
	/**
	* The LOCAL egress agent — separate from {@link #direct} on purpose. This is
	* the agent that carries the Zen lane when the pool does not (固定本机 pin,
	* 本地出口兜底), so it is the only one the family setting may touch:
	* `#direct` also carries loopback (the settings bridge, sing-box control) and
	* every other host some other plugin fetches, and flipping those to another
	* family is not what 本机使用 IPv4 还是 IPv6 promises.
	*/
	#localEgress;
	/** Per-exit ProxyAgents (docs/ip-pool.md 2, exit multi-instance). */
	#agents;
	#closed = false;
	constructor(options) {
		this.#pool = options.pool;
		this.#undici = options.undici;
		this.#proxyHosts = new Set(resolveProxyHosts(options.proxyHosts));
		this.#proxyPathPrefixes = resolveProxyPathPrefixes(options.proxyPathPrefixes);
		const seam = options.undici;
		this.#agents = new ExitAgentCache(options.agentLruCap ?? 16, (uri) => new seam.ProxyAgent({
			uri,
			clientFactory: (_origin, opts) => new seam.Agent({
				...opts,
				pipelining: 0
			})
		}));
		this.#sentinelMs = options.sentinelMs ?? 2e3;
		this.#headersMs = options.headersMs ?? 3e4;
		this.#localFallback = options.localFallback === true;
		this.#localFamily = resolveLocalIpFamily(options.localIpFamily ?? DEFAULT_LOCAL_IP_FAMILY);
		this.#listInterfaces = options.listInterfaces;
		this.#onTransportCut = options.onTransportCut;
		this.#logger = options.logger;
		this.#direct = new options.undici.Agent();
		this.#localEgress = new options.undici.Agent({ connect: this.#localConnectOptions(this.#localFamily) });
	}
	/**
	* The connect options for one family position, through the injected
	* interface reader when a caller supplied one (the reader decides whether
	* `auto` prefers IPv6, so a test can pin either answer).
	*/
	#localConnectOptions(family) {
		return this.#listInterfaces === void 0 ? localEgressConnectOptions(family) : localEgressConnectOptions(family, this.#listInterfaces);
	}
	/** Live re-apply of 本地出口兜底 (settings page, docs §3.3/§5.1). */
	setLocalFallback(value) {
		this.#localFallback = value === true;
	}
	/** 本地出口兜底 in force (diagnostics / status bridge). */
	get localFallback() {
		return this.#localFallback;
	}
	/**
	* Live re-apply of 本机出口协议族 (settings page, local-family.ts).
	*
	* A family is a property of the socket, so the switch means a NEW agent; the
	* old one is closed after the swap, so requests already on it finish while
	* nothing new is dialled under the previous family. A no-op position does
	* not churn the socket pool — `auto` on an IPv4-only machine resolves to the
	* same empty options twice.
	*/
	setLocalIpFamily(value) {
		const family = resolveLocalIpFamily(value);
		const previous = this.#localConnectOptions(this.#localFamily);
		const next = this.#localConnectOptions(family);
		this.#localFamily = family;
		if (previous.family === next.family && previous.lookup === next.lookup) return;
		const dying = this.#localEgress;
		this.#localEgress = new this.#undici.Agent({ connect: next });
		if (!this.#closed) dying.close().catch(() => {});
	}
	/** 本机出口协议族 in force (diagnostics / status bridge). */
	get localIpFamily() {
		return this.#localFamily;
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
	* silently disable routing, while guessing "in" at worst sends one extra
	* request through an exit on a host the user explicitly opted into.
	*/
	#inScope(path) {
		if (path === "") return true;
		return this.#proxyPathPrefixes.some((prefix) => matchesPathPrefix(path, prefix));
	}
	/**
	* Pool-host traffic that could not ride an exit (no pick, or no agent):
	* stamp the direct bucket so the stats modal's 直连兜底 row stays honest,
	* then dispatch from this machine. Only reachable with 本地出口兜底 ON (or an
	* explicit 固定本机 pin) — {@link #failClosed} covers the other case.
	*
	* Rides {@link #localEgress}, not {@link #direct}: this is the branch the
	* 本机出口协议族 setting governs, and it is the one the free lane sees as
	* "outside OpenCode" when it leaves over a refused IPv4 address.
	*/
	#directFallback(context, options, handler) {
		context.exitId = DIRECT_EXIT_ID;
		this.#pool.recordDirectRequest();
		return this.#localEgress.dispatch(options, handler);
	}
	/**
	* 本地出口兜底 is OFF and the pool cannot carry this request: fail the
	* dispatch instead of egressing from this machine.
	*
	* The error travels the same channel undici uses for a transport failure
	* (the closed-dispatcher branch below sets the precedent), so fetch rejects
	* with "fetch failed" and this message as its cause — the adapter's rotate
	* loop then retries the pool, finds nothing, and surfaces the failure.
	* Nothing is stamped and nothing is counted: 本机 did not carry it.
	*/
	#failClosed(handler) {
		handler.onResponseError?.({}, new Error(NO_EXIT_MESSAGE));
		return false;
	}
	/**
	* The fallback decision shared by both "pool could not carry it" branches.
	* An explicit 固定本机 pin wins over the switch: `pick()` answers null for
	* it, but the operator asked for this machine, so the request rides direct.
	*/
	#poolMissed(context, options, handler) {
		if (mayEgressLocally(this.#pool, this.#localFallback)) return this.#directFallback(context, options, handler);
		return this.#failClosed(handler);
	}
	/** The agent for one exit, dialling its current protocol (docs/ip-pool.md 2). */
	#agentFor(exitId) {
		const exit = this.#pool.get(exitId);
		if (!exit) return null;
		try {
			return this.#agents.get(exitId, exitProxyUri(exit.id, exit.protocol));
		} catch (err) {
			this.#logger?.warn(`oc2dsh: failed to build proxy agent for ${exitId}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}
	dispatch(options, handler) {
		if (this.#closed) {
			handler.onResponseError?.({}, /* @__PURE__ */ new Error("oc2dsh: routing dispatcher closed"));
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
		if (exitId === null) return this.#poolMissed(context, options, handler);
		const agent = this.#agentFor(exitId);
		if (!agent) return this.#poolMissed(context, options, handler);
		context.exitId = exitId;
		this.#pool.beginRequest(exitId);
		return agent.dispatch(options, observeExitRequest({
			pool: this.#pool,
			exitId,
			model,
			session,
			sentinelMs: this.#sentinelMs,
			headersMs: this.#headersMs,
			onTransportCut: this.#onTransportCut,
			logger: this.#logger
		}, handler));
	}
	close() {
		this.#closed = true;
		const jobs = [
			this.#direct.close(),
			this.#localEgress.close(),
			...this.#agents.agents().map((a) => a.close())
		];
		return Promise.all(jobs).then(() => void 0);
	}
	destroy() {
		this.#closed = true;
		const jobs = [
			this.#direct.destroy(),
			this.#localEgress.destroy(),
			...this.#agents.agents().map((a) => a.destroy())
		];
		this.#agents.clear();
		return Promise.all(jobs).then(() => void 0);
	}
};

//#endregion
export { settleTransport as _, resolveProxyHosts as a, resolveLocalIpFamily as b, DIRECT_EXIT_ID as c, attributeUsage as d, emptyTotals as f, settleStatus as g, mayEgressLocally as h, exitProxyUri as i, LOCAL_EXIT_ID as l, usageTracker as m, NO_EXIT_MESSAGE as n, resolveProxyPathPrefixes as o, setUsageRecorder as p, PoolRoutingDispatcher as r, routingContext as s, DEFAULT_PROXY_PATH_PREFIXES as t, UsageTracker as u, parseManualProxy as v, DEFAULT_LOCAL_IP_FAMILY as y };