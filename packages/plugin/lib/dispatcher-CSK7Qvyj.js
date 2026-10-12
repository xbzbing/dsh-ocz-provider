import { AsyncLocalStorage } from "node:async_hooks";
import "undici";

//#region src/pool/usage.ts
/** Pseudo exit id for pool-host traffic that fell back to a direct connection. */
const DIRECT_EXIT_ID = "direct";
function zeroTotals() {
	return {
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0
	};
}
/** A fresh all-zero bucket (bridge stubs for a disabled pool). */
const emptyTotals = zeroTotals;
/** Mutable accumulator map keyed by exit id. One instance per process. */
var UsageTracker = class {
	#byExit = /* @__PURE__ */ new Map();
	/** Attribute one response's usage to one exit id. */
	record(exitId, usage) {
		const bucket = this.#byExit.get(exitId) ?? zeroTotals();
		const input = usage.inputTokens ?? 0;
		const output = usage.outputTokens ?? 0;
		bucket.requests += 1;
		bucket.inputTokens += input;
		bucket.outputTokens += output;
		bucket.cacheReadTokens += usage.cacheReadTokens ?? 0;
		bucket.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
		bucket.totalTokens += input + output;
		this.#byExit.set(exitId, bucket);
	}
	/** A copy of one bucket (zeros when nothing was recorded). */
	totals(exitId) {
		return { ...this.#byExit.get(exitId) ?? zeroTotals() };
	}
	/** Every exit id with recorded usage (diagnostics). */
	exits() {
		return [...this.#byExit.keys()];
	}
	/** Test seam / future reset action. */
	reset() {
		this.#byExit.clear();
	}
};
/** The process-lifetime tracker: adapter writes, status bridge reads. */
const usageTracker = new UsageTracker();
/**
* Pass a chunk stream through, recording every `usage` chunk against the
* routing context's exit stamp. Placed around the adapter's per-attempt
* output so each attempt's tokens land on the exit that actually carried
* that attempt (a rotate restart therefore splits correctly across exits).
*
* A context without an `exitId` means the request never entered the pool
* dispatcher — those tokens are out of scope and pass through untouched.
*/
async function* attributeUsage(store, source, tracker = usageTracker) {
	for await (const chunk of source) {
		if (chunk.type === "usage" && store.exitId !== void 0) tracker.record(store.exitId, chunk.usage);
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
		this.#proxyHosts = new Set((options.proxyHosts ?? DEFAULT_PROXY_HOSTS).map((host) => normalizeHost(host)));
		this.#agentLruCap = options.agentLruCap ?? 16;
		this.#sentinelMs = options.sentinelMs ?? 2e3;
		this.#headersMs = options.headersMs ?? 3e4;
		this.#logger = options.logger;
		this.#direct = new options.undici.Agent();
	}
	/** Live re-apply of the proxied-host list (settings page, docs §5.1). */
	setProxyHosts(hosts) {
		this.#proxyHosts = hosts && hosts.length > 0 ? new Set(hosts.map((host) => normalizeHost(host))) : new Set(DEFAULT_PROXY_HOSTS.map((host) => normalizeHost(host)));
	}
	/** The proxied-host set as configured (diagnostics / status bridge). */
	get proxyHosts() {
		return [...this.#proxyHosts];
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
		if (isLoopback(host) || !this.#proxyHosts.has(host)) return this.#direct.dispatch(options, handler);
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
export { attributeUsage as a, DIRECT_EXIT_ID as i, exitProxyUri as n, emptyTotals as o, routingContext as r, usageTracker as s, PoolRoutingDispatcher as t };