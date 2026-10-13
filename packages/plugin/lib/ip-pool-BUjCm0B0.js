import "./catalog-Bne5EZa-.js";
import "./messages-CLaBfusR.js";
import "./dispatcher-Duu4cMIa.js";
import { i as createRotateDelegate, n as parseSubscription, o as setRotateDelegate, t as DEFAULT_SUBSCRIPTION_USER_AGENT } from "./subscription-DwBzQlQT.js";
import { a as ExitPool, i as coarseScreenBatch, n as admitTrusted, o as gradeOf, t as admitCandidate } from "./admission-aq--x5xX.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";

//#region src/pool/prober.ts
var Prober = class {
	#pool;
	#maxConcurrent;
	#queue = [];
	#inFlight = 0;
	#drained = null;
	/** Queue snapshot counter for the settings-page progress (x/y). */
	#enqueued = 0;
	#completed = 0;
	constructor(options) {
		this.#pool = options.pool;
		this.#maxConcurrent = Math.max(1, options.maxConcurrentProbes ?? 3);
	}
	get stats() {
		return {
			queued: this.#queue.length,
			inFlight: this.#inFlight,
			enqueued: this.#enqueued,
			completed: this.#completed
		};
	}
	setMaxConcurrent(value) {
		this.#maxConcurrent = Math.max(1, value);
		this.#pump();
	}
	/** Enqueue one task; resolves when the task has fully run. */
	enqueue(task) {
		this.#enqueued += 1;
		return new Promise((resolve) => {
			this.#queue.push({
				task,
				resolve
			});
			this.#pump();
		});
	}
	/** Enqueue a batch; same-exit tasks are kept adjacent for back-to-back
	*  execution (constraint 3). Resolves when every task has run. */
	enqueueAll(tasks) {
		return Promise.all(tasks.map((task) => this.enqueue(task))).then(() => void 0);
	}
	/** True when no task is queued or running. */
	get idle() {
		return this.#queue.length === 0 && this.#inFlight === 0;
	}
	/** Resolves once the queue fully drains (test/UI hook). */
	async drained() {
		while (!this.idle) await new Promise((resolve) => {
			this.#drained = resolve;
		});
	}
	/** A worker slot finished; release and pump. */
	#finishSlot() {
		this.#inFlight -= 1;
		this.#completed += 1;
		this.#pump();
	}
	#pump() {
		while (this.#inFlight < this.#maxConcurrent) {
			const index = this.#queue.findIndex((slot$1) => !this.#isExitBusy(slot$1.task.exitId));
			if (index < 0) break;
			const [slot] = this.#queue.splice(index, 1);
			if (!slot) break;
			this.#inFlight += 1;
			this.#runSlot(slot);
		}
		if (this.idle) {
			const waiter = this.#drained;
			this.#drained = null;
			waiter?.();
		}
	}
	#isExitBusy(exitId) {
		return this.#pool.get(exitId) !== void 0 && !this.#pool.takeProbeLock(exitId);
	}
	async #runSlot(slot) {
		try {
			await slot.task.run();
		} catch {} finally {
			this.#pool.releaseProbeLock(slot.task.exitId);
			slot.resolve();
			this.#finishSlot();
		}
	}
};

//#endregion
//#region src/pool/sources.ts
const freeSources = [
	{
		url: "https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/http.txt",
		protocol: "http",
		tier: "fast"
	},
	{
		url: "https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/socks4.txt",
		protocol: "socks5",
		tier: "fast"
	},
	{
		url: "https://raw.githubusercontent.com/ProxyScraper/ProxyScraper/main/socks5.txt",
		protocol: "socks5",
		tier: "fast"
	},
	{
		url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
		protocol: "http",
		tier: "fast"
	},
	{
		url: "https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt",
		protocol: "http",
		tier: "fast"
	},
	{
		url: "https://raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt",
		protocol: "socks5",
		tier: "fast"
	},
	{
		url: "https://raw.githubusercontent.com/prxchk/proxy-list/main/socks4.txt",
		protocol: "socks5",
		tier: "fast"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/sunny9577/proxy-scraper/generated/http_proxies.txt",
		protocol: "http",
		tier: "fast"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/sunny9577/proxy-scraper/generated/socks5_proxies.txt",
		protocol: "socks5",
		tier: "fast"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/sunny9577/proxy-scraper/generated/socks4_proxies.txt",
		protocol: "socks5",
		tier: "fast"
	},
	{
		url: "https://raw.githubusercontent.com/proxio-io/proxy-list/main/http.txt",
		protocol: "http",
		tier: "fast"
	},
	{
		url: "https://raw.githubusercontent.com/proxio-io/proxy-list/main/socks5.txt",
		protocol: "socks5",
		tier: "fast"
	},
	{
		url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
		protocol: "http",
		tier: "fast"
	},
	{
		url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt",
		protocol: "socks5",
		tier: "fast"
	},
	{
		url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
		protocol: "http",
		tier: "fast"
	},
	{
		url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
		protocol: "socks5",
		tier: "fast"
	},
	{
		url: "https://proxyspace.pro/http.txt",
		protocol: "http",
		tier: "fast"
	},
	{
		url: "https://proxyspace.pro/socks5.txt",
		protocol: "socks5",
		tier: "fast"
	},
	{
		url: "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/databay-labs/free-proxy-list/http.txt",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/databay-labs/free-proxy-list/socks5.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/Anonym0usWork1221/Free-Proxies/proxy_files/http_proxies.txt",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/Anonym0usWork1221/Free-Proxies/proxy_files/socks5_proxies.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/Anonym0usWork1221/Free-Proxies/proxy_files/socks4_proxies.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/ALIILAPRO/Proxy/http.txt",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/ALIILAPRO/Proxy/socks4.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/vakhov/fresh-proxy-list/http.txt",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/vakhov/fresh-proxy-list/socks5.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/vakhov/fresh-proxy-list/socks4.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/Zaeem20/FREE_PROXIES_LIST/http.txt",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/hookzof/socks5_list/proxy.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/proxy4parsing/proxy-list/http.txt",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "https://cdn.jsdelivr.net/gh/proxy4parsing/proxy-list/socks5.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/Tianndev/free-proxy/main/proxy/http.txt",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/Tianndev/free-proxy/main/proxy/socks5.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/socks5.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/http.txt",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/socks5.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/Ian-Lusule/Proxies/main/proxies/http.txt",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "https://raw.githubusercontent.com/Ian-Lusule/Proxies/main/proxies/socks5.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "http://openproxylist.xyz/http.txt",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "http://openproxylist.xyz/socks5.txt",
		protocol: "socks5",
		tier: "slow"
	},
	{
		url: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all",
		protocol: "http",
		tier: "slow"
	},
	{
		url: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all",
		protocol: "socks5",
		tier: "slow"
	}
];
/** One raw free-list line -> host:port address, or null when malformed. */
function parseFreeListLine(line) {
	const trimmed = line.trim();
	if (trimmed === "" || trimmed.startsWith("#")) return null;
	const address = trimmed.replace(/^[a-z0-9+.-]+:\/\//i, "");
	const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(address);
	if (!match?.[1] || !match[2]) return null;
	const port = Number(match[2]);
	if (port < 1 || port > 65535) return null;
	return {
		address,
		host: match[1],
		port
	};
}
/** Deduplicate a raw address list while preserving order. */
function dedupeAddresses(lines) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const line of lines) {
		const parsed = parseFreeListLine(line);
		if (!parsed) continue;
		if (seen.has(parsed.address)) continue;
		seen.add(parsed.address);
		out.push(parsed);
	}
	return out;
}
/**
* Per-source circuit breaker (GoProxy SourceManager semantics, in-memory):
* N consecutive fetch failures disable the source for a cooldown, after which
* it is re-enabled with its counter reset.
*/
var SourceBreaker = class {
	#entries = /* @__PURE__ */ new Map();
	#threshold;
	#cooldownMs;
	#now;
	constructor(options = {}) {
		this.#threshold = options.failureThreshold ?? 3;
		this.#cooldownMs = options.cooldownMs ?? 10 * 6e4;
		this.#now = options.now ?? Date.now;
	}
	canUse(url) {
		const entry = this.#entries.get(url);
		if (!entry) return true;
		if (entry.disabledUntil > this.#now()) return false;
		if (entry.consecutiveFails >= this.#threshold) {
			entry.consecutiveFails = 0;
			entry.disabledUntil = 0;
		}
		return true;
	}
	recordSuccess(url) {
		this.#entries.set(url, {
			consecutiveFails: 0,
			disabledUntil: 0
		});
	}
	recordFailure(url) {
		const entry = this.#entries.get(url) ?? {
			consecutiveFails: 0,
			disabledUntil: 0
		};
		entry.consecutiveFails += 1;
		if (entry.consecutiveFails >= this.#threshold) entry.disabledUntil = this.#now() + this.#cooldownMs;
		this.#entries.set(url, entry);
	}
	disabledCount() {
		let count = 0;
		for (const entry of this.#entries.values()) if (entry.disabledUntil > this.#now()) count += 1;
		return count;
	}
};
/** Select sources for a refill round by pool state (docs/ip-pool.md 3.5):
*  warning/critical -> fast tier; emergency -> all sources (breaker ignored). */
function selectSources(state) {
	if (state === "emergency") return freeSources;
	if (state === "healthy") return [];
	return freeSources.filter((source) => source.tier === "fast");
}
/** Fetch one source and parse its list. Transport errors propagate to the
*  caller (the breaker records them); HTTP-level failures throw. */
async function fetchSource(source, fetchImpl = fetch, timeoutMs = 3e4) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(source.url, { signal: controller.signal });
		if (!response.ok) throw new Error(`source ${source.url} returned HTTP ${response.status}`);
		return {
			source,
			addresses: dedupeAddresses((await response.text()).split(/\r?\n/))
		};
	} finally {
		clearTimeout(timer);
	}
}

//#endregion
//#region src/pool/refill.ts
var RefillScheduler = class {
	#pool;
	#deps;
	#breaker = new SourceBreaker();
	#intervalMs;
	/** Candidate cap per source per round (a source can return thousands of
	*  rows; admission cost is 4 requests per candidate). */
	#maxPerRound;
	#timer = null;
	#running = false;
	#stopped = false;
	#lastRound = {
		admitted: 0,
		rejected: 0,
		fetched: 0,
		coarsePassed: 0,
		state: "healthy",
		at: 0
	};
	/** Live progress of the in-flight round (settings page 立即补充 feedback). */
	#progress = {
		running: false,
		stage: "idle",
		sourcesDone: 0,
		sourcesTotal: 0,
		fetched: 0,
		candidates: 0,
		coarsePassed: 0,
		coarseDone: 0,
		admissions: 0,
		admitted: 0
	};
	/** Notified after every real admission — the runtime assembly uses it to
	*  engage routing the moment a free-source pool stops being empty (the
	*  initial install is skipped exactly then, live-observed 2026-09-09). */
	#admittedCallbacks = [];
	constructor(pool, deps, options = {}) {
		this.#pool = pool;
		this.#deps = deps;
		this.#intervalMs = options.intervalMs ?? 10 * 6e4;
		this.#maxPerRound = options.maxAdmissionsPerRound ?? 10;
	}
	/** Register a callback fired after every node the round really admits. */
	onAdmitted(callback) {
		this.#admittedCallbacks.push(callback);
	}
	#notifyAdmitted() {
		for (const callback of this.#admittedCallbacks) try {
			callback();
		} catch {}
	}
	get lastRound() {
		return this.#lastRound;
	}
	/** The in-flight round's live progress (status bridge, docs §5.3). */
	get progress() {
		return { ...this.#progress };
	}
	/** Start the periodic refill check (one round immediately). */
	start() {
		if (this.#timer !== null || this.#stopped) return;
		this.tick();
		this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
		this.#timer.unref?.();
	}
	stop() {
		this.#stopped = true;
		if (this.#timer !== null) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}
	/** One refill round; skipped while a previous round is still draining. */
	async tick() {
		if (this.#running) return;
		this.#running = true;
		try {
			await this.#round();
		} finally {
			this.#running = false;
		}
	}
	async #round() {
		const state = this.#pool.state();
		const quota = Math.min(this.#pool.admissionQuota(), this.#maxPerRound);
		this.#lastRound = {
			...this.#lastRound,
			state,
			at: Date.now()
		};
		if (state === "healthy" || quota <= 0) {
			this.#progress = {
				running: false,
				stage: "idle",
				sourcesDone: 0,
				sourcesTotal: 0,
				fetched: 0,
				candidates: 0,
				coarsePassed: 0,
				coarseDone: 0,
				admissions: 0,
				admitted: 0
			};
			return;
		}
		const sources = selectSources(state).filter((source) => state === "emergency" || this.#breaker.canUse(source.url));
		this.#progress = {
			running: true,
			stage: "fetch",
			sourcesDone: 0,
			sourcesTotal: sources.length,
			fetched: 0,
			candidates: 0,
			coarsePassed: 0,
			coarseDone: 0,
			admissions: 0,
			admitted: 0
		};
		let fetched = 0;
		let admitted = 0;
		let rejected = 0;
		const candidateCap = 2e4;
		const perSourceCap = 5e3;
		const candidates = [];
		const seen = new Set(this.#poolAddresses());
		for (const source of sources) {
			if (candidates.length >= candidateCap) break;
			try {
				const result = this.#deps.fetchSourceImpl ? await this.#deps.fetchSourceImpl(source, this.#deps.fetchImpl ?? fetch) : await fetchSource(source, this.#deps.fetchImpl ?? fetch);
				this.#breaker.recordSuccess(source.url);
				fetched += result.addresses.length;
				this.#progress.fetched = fetched;
				this.#progress.sourcesDone += 1;
				this.#progress.candidates = candidates.length;
				const rows = result.addresses.slice();
				for (let i = rows.length - 1; i > 0; i -= 1) {
					const j = Math.floor(Math.random() * (i + 1));
					[rows[i], rows[j]] = [rows[j], rows[i]];
				}
				let fromThisSource = 0;
				for (const entry of rows) {
					if (candidates.length >= candidateCap) break;
					if (fromThisSource >= perSourceCap) break;
					if (seen.has(entry.address)) continue;
					seen.add(entry.address);
					if (source.protocol !== "http") continue;
					candidates.push({
						...entry,
						protocol: "http"
					});
					fromThisSource += 1;
				}
				this.#progress.candidates = candidates.length;
			} catch {
				this.#breaker.recordFailure(source.url);
				this.#progress.sourcesDone += 1;
			}
		}
		this.#progress.stage = "coarse";
		const relaxed = state === "critical" || state === "emergency";
		const facts = await coarseScreenBatch(this.#deps, candidates, {
			fanout: this.#deps.admissionFanout ?? 300,
			relaxed,
			timeoutMs: 5e3,
			onProgress: (done, passed) => {
				this.#progress.coarseDone = done;
				this.#progress.coarsePassed = passed;
			}
		});
		rejected += candidates.length - facts.size;
		this.#progress.stage = "admit";
		this.#lastRound = {
			admitted,
			rejected,
			fetched,
			state,
			at: Date.now(),
			coarsePassed: facts.size
		};
		const tasks = [];
		let admittedLimited = 0;
		let claimed = 0;
		const survivors = candidates.filter((candidate) => facts.has(candidate.address)).sort((left, right) => (facts.get(left.address)?.latencyMs ?? 0) - (facts.get(right.address)?.latencyMs ?? 0));
		for (const candidate of survivors) {
			const echoFacts = facts.get(candidate.address);
			if (!echoFacts) continue;
			tasks.push({
				exitId: candidate.address,
				kind: "admission",
				run: async () => {
					if (claimed >= quota || this.#pool.admissionQuota() <= 0) return;
					claimed += 1;
					try {
						const verdict = await admitCandidate(this.#deps, {
							address: candidate.address,
							protocol: candidate.protocol,
							source: "free"
						}, {
							relaxed,
							echoFacts
						});
						if (verdict.admitted && verdict.node) {
							if (this.#pool.isFreeFull()) this.#pool.evictWorstFree();
							if (this.#pool.add(verdict.node)) {
								if (verdict.limited) {
									this.#pool.markLimited(verdict.node.id);
									admittedLimited += 1;
								} else {
									this.#pool.markOk(verdict.node.id);
									admitted += 1;
								}
								this.#progress.admitted = admitted + admittedLimited;
								this.#notifyAdmitted();
							}
						} else rejected += 1;
					} finally {
						this.#progress.admissions += 1;
					}
				}
			});
		}
		if (tasks.length > 0) {
			await this.#deps.prober.enqueueAll(tasks);
			this.#lastRound = {
				...this.#lastRound,
				admitted: admitted + admittedLimited,
				rejected,
				at: Date.now()
			};
		}
		this.#progress.running = false;
		this.#progress.stage = "idle";
	}
	#poolAddresses() {
		return new Set(this.#pool.list().map((entry) => entry.id));
	}
};

//#endregion
//#region src/pool/singbox.ts
/**
* Can this node's server address ever be dialled from THIS machine?
*
* A public subscription handing out a private / loopback / link-local /
* multicast literal is carrying a placeholder, not a node. Live 2026-10-13: a
* trojan node with `server: 10.255.255.255` was converted anyway, got a local
* SOCKS5 port, was admitted through the trusted fallback and sat in the exit
* table as a `127.0.0.1:30005` row — a rotation slot that could only ever
* fail. Dropping it at conversion is the only place the pool never sees it.
*
* Hostnames always pass: resolving them is sing-box's job, and a hostname may
* legitimately point at something reachable only through another hop.
*/
function isDialableServer(server) {
	const host = server.trim().toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "") return false;
	if (host === "localhost" || host.endsWith(".localhost")) return false;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (v4) return !isUnroutableIPv4(Number(v4[1]), Number(v4[2]));
	const mapped = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (mapped) return !isUnroutableIPv4(Number(mapped[1]), Number(mapped[2]));
	if (host.includes(":")) return !isUnroutableIPv6(host);
	return true;
}
/** RFC1918 plus the literals that never route (0/8, 127/8, link-local, CGNAT, benchmark, multicast). */
function isUnroutableIPv4(a, b) {
	if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
	if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	return false;
}
function isUnroutableIPv6(host) {
	if (host === "::" || host === "::1") return true;
	if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
	if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
	if (/^ff[0-9a-f]{2}:/.test(host)) return true;
	return false;
}
const getStr = (raw, key) => {
	const value = raw[key];
	return typeof value === "string" ? value : value === void 0 || value === null ? "" : String(value);
};
const getStrDefault = (raw, key, fallback) => {
	const value = getStr(raw, key);
	return value !== "" ? value : fallback;
};
const getInt = (raw, key) => {
	const value = Number(raw[key]);
	return Number.isFinite(value) ? value : 0;
};
const getBool = (raw, key) => raw[key] === true;
function applyTLS(raw, out) {
	if (!(getBool(raw, "tls") || getStr(raw, "sni") !== "" || getStr(raw, "client-fingerprint") !== "" || raw["reality-opts"] !== void 0 && typeof raw["reality-opts"] === "object")) return;
	const tls = { enabled: true };
	const sni = getStr(raw, "sni") || getStr(raw, "servername");
	if (sni !== "") tls.server_name = sni;
	if (getBool(raw, "skip-cert-verify")) tls.insecure = true;
	const alpn = raw.alpn;
	if (Array.isArray(alpn)) {
		const list = alpn.filter((entry) => typeof entry === "string");
		if (list.length > 0) tls.alpn = list;
	}
	const fingerprint = getStr(raw, "client-fingerprint");
	if (fingerprint !== "") tls.utls = {
		enabled: true,
		fingerprint
	};
	const reality = raw["reality-opts"];
	if (reality && typeof reality === "object") {
		const opts = reality;
		tls.reality = {
			enabled: true,
			public_key: getStr(opts, "public-key"),
			short_id: getStr(opts, "short-id")
		};
	}
	out.tls = tls;
}
function applyTransport(raw, out) {
	const network = getStrDefault(raw, "network", "tcp");
	if (network === "ws") {
		const transport = { type: "ws" };
		const opts = raw["ws-opts"];
		if (opts && typeof opts === "object") {
			const ws = opts;
			const path = getStr(ws, "path");
			if (path !== "") transport.path = path;
			const headers = ws.headers;
			if (headers && typeof headers === "object") transport.headers = headers;
		}
		out.transport = transport;
	} else if (network === "grpc") {
		const transport = { type: "grpc" };
		const opts = raw["grpc-opts"];
		if (opts && typeof opts === "object") {
			const sn = getStr(opts, "grpc-service-name");
			if (sn !== "") transport.service_name = sn;
		}
		out.transport = transport;
	} else if (network === "h2") {
		const transport = { type: "http" };
		const opts = raw["h2-opts"];
		if (opts && typeof opts === "object") {
			const h2 = opts;
			const path = getStr(h2, "path");
			if (path !== "") transport.path = path;
			const host = h2.host;
			if (Array.isArray(host) && typeof host[0] === "string") transport.host = [host[0]];
		}
		out.transport = transport;
	} else if (network === "httpupgrade") {
		const transport = { type: "httpupgrade" };
		const opts = raw["ws-opts"];
		if (opts && typeof opts === "object") {
			const ws = opts;
			const path = getStr(ws, "path");
			if (path !== "") transport.path = path;
			const headers = ws.headers;
			if (headers && typeof headers === "object") {
				const host = headers.Host;
				if (typeof host === "string") transport.host = host;
			}
		}
		out.transport = transport;
	}
}
/** One ParsedNode -> one sing-box outbound (GoProxy buildOutbound). */
function buildOutbound(node, tag) {
	const raw = node.raw;
	const out = {
		tag,
		server: node.server,
		server_port: node.port
	};
	switch (node.type) {
		case "vmess":
			out.type = "vmess";
			out.uuid = getStr(raw, "uuid");
			out.alter_id = getInt(raw, "alterId");
			out.security = getStrDefault(raw, "cipher", "auto");
			applyTLS(raw, out);
			applyTransport(raw, out);
			break;
		case "vless":
			out.type = "vless";
			out.uuid = getStr(raw, "uuid");
			const flow = getStr(raw, "flow");
			if (flow !== "") out.flow = flow;
			applyTLS(raw, out);
			applyTransport(raw, out);
			break;
		case "trojan":
			out.type = "trojan";
			out.password = getStr(raw, "password");
			applyTLS(raw, out);
			applyTransport(raw, out);
			break;
		case "shadowsocks": {
			out.type = "shadowsocks";
			out.method = getStr(raw, "cipher") || getStr(raw, "method");
			out.password = getStr(raw, "password");
			const plugin = getStr(raw, "plugin");
			if (plugin !== "") {
				out.plugin = plugin;
				const opts = raw["plugin-opts"];
				if (opts && typeof opts === "object") out.plugin_opts = Object.entries(opts).map(([key, value]) => `${key}=${String(value)}`).join(";");
			}
			break;
		}
		case "hysteria2":
			out.type = "hysteria2";
			out.password = getStr(raw, "password");
			applyTLS({
				...raw,
				tls: true
			}, out);
			break;
		case "tuic":
			out.type = "tuic";
			out.uuid = getStr(raw, "uuid");
			out.password = getStr(raw, "password");
			out.congestion_control = getStrDefault(raw, "congestion-controller", "bbr");
			applyTLS({
				...raw,
				tls: true
			}, out);
			break;
		case "anytls":
			out.type = "anytls";
			out.password = getStr(raw, "password");
			applyTLS({
				...raw,
				tls: true
			}, out);
			break;
		default: return null;
	}
	return out;
}
/** nodeKey (GoProxy): type:server:port. */
function nodeKeyOf(node) {
	return `${node.type}:${node.server}:${node.port}`;
}
/** The full sing-box config for a node list (GoProxy generateConfig). */
function generateConfig(nodes, basePort = 3e4) {
	const portMap = /* @__PURE__ */ new Map();
	const inbounds = [];
	const outbounds = [];
	const rules = [];
	let port = basePort;
	nodes.forEach((node, index) => {
		port += 1;
		const tag = `node-${index}`;
		portMap.set(nodeKeyOf(node), port);
		inbounds.push({
			type: "socks",
			tag: `in-${tag}`,
			listen: "127.0.0.1",
			listen_port: port
		});
		const outbound = buildOutbound(node, `out-${tag}`);
		if (outbound === null) {
			portMap.delete(nodeKeyOf(node));
			inbounds.pop();
			return;
		}
		outbounds.push(outbound);
		rules.push({
			inbound: [`in-${tag}`],
			outbound: `out-${tag}`
		});
	});
	outbounds.push({
		type: "direct",
		tag: "direct"
	});
	return {
		config: {
			log: { level: "warn" },
			inbounds,
			outbounds,
			route: {
				rules,
				final: "direct"
			}
		},
		portMap
	};
}
const STOP_GRACE_MS = 5e3;
function canConnect(port, timeoutMs = 1e3) {
	return new Promise((resolve) => {
		const socket = createConnection({
			host: "127.0.0.1",
			port
		});
		const finish = (ok) => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(timeoutMs, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}
var SingBoxSupervisor = class {
	#options;
	#child = null;
	#running = false;
	#configPath;
	#dataDir;
	#portMap = /* @__PURE__ */ new Map();
	#nodes = [];
	constructor(options) {
		this.#options = options;
		this.#dataDir = options.dataDir;
		this.#configPath = join(options.dataDir, "singbox-config.json");
	}
	/** Live re-apply of the binary path (settings page, docs §5.1). The next
	*  reload() resolves through it; a running child keeps serving until then. */
	setBinPath(path) {
		this.#options.binPath = path;
	}
	get running() {
		return this.#running;
	}
	get portMap() {
		return new Map(this.#portMap);
	}
	/** The binary location: absolute path as-is; bare name must exist on PATH
	*  (verified through `sing-box version` — LookPath equivalent). */
	async #resolveBinary() {
		const bin = this.#options.binPath;
		if (bin.includes("/") || bin.includes("\\") || bin.includes(":")) {
			if (existsSync(bin)) return bin;
			throw new Error(`sing-box not found at ${bin}`);
		}
		if (!await new Promise((resolve) => {
			const child = spawn(bin, ["version"], { stdio: "ignore" });
			child.once("error", () => resolve(false));
			child.once("exit", (code) => resolve(code === 0));
		})) throw new Error(`sing-box not found on PATH ("${bin}"); install it or set singbox.path`);
		return bin;
	}
	/** Full reload: regenerate the config for the node list and (re)start. */
	async reload(input) {
		const unroutable = input.filter((node) => !isDialableServer(node.server));
		if (unroutable.length > 0) {
			const sample = unroutable.slice(0, 5).map((node) => `${node.type} ${node.server}:${node.port}`).join(", ");
			this.#options.logger?.warn(`opencode2dsh: sing-box conversion skipped ${unroutable.length} node(s) whose server address cannot be dialled from this machine (${sample}${unroutable.length > 5 ? ", …" : ""})`);
		}
		const nodes = input.filter((node) => isDialableServer(node.server));
		if (nodes.length === 0) {
			await this.stop();
			this.#nodes = [];
			this.#portMap = /* @__PURE__ */ new Map();
			return [];
		}
		const binary = await this.#resolveBinary();
		const { config, portMap } = generateConfig(nodes, this.#options.basePort ?? 3e4);
		await mkdir(this.#dataDir, { recursive: true });
		const tmp = `${this.#configPath}.tmp`;
		await writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
		await rm(this.#configPath, { force: true });
		await rename(tmp, this.#configPath);
		if (!await new Promise((resolve) => {
			const child$1 = spawn(binary, [
				"check",
				"-c",
				this.#configPath,
				"-D",
				this.#dataDir
			], { stdio: "ignore" });
			child$1.once("error", () => resolve(false));
			child$1.once("exit", (code) => resolve(code === 0));
		})) throw new Error("sing-box config check failed (run `sing-box check` on the generated config for details)");
		await this.stop();
		this.#child = spawn(binary, [
			"run",
			"-c",
			this.#configPath,
			"-D",
			this.#dataDir
		], { stdio: [
			"ignore",
			"ignore",
			"pipe"
		] });
		const child = this.#child;
		this.#running = true;
		this.#nodes = nodes;
		this.#portMap = portMap;
		child.stderr?.on("data", (chunk) => {
			const text = chunk.toString("utf8").trim();
			if (text.length > 0) this.#options.logger?.info(`[sing-box] ${text}`);
		});
		child.once("exit", () => {
			if (this.#child === child) this.#running = false;
		});
		child.once("error", () => {
			if (this.#child === child) this.#running = false;
		});
		const deadline = Date.now() + (this.#options.readyTimeoutMs ?? 1e4);
		const ports = [...portMap.values()];
		let ready = false;
		while (Date.now() < deadline && !ready) {
			if (!this.#running) throw new Error("sing-box exited immediately after start (see logs)");
			await new Promise((resolve) => setTimeout(resolve, 500));
			for (const port of ports) if (await canConnect(port)) {
				ready = true;
				break;
			}
		}
		if (!ready) this.#options.logger?.warn("opencode2dsh: sing-box ports not ready in time; some converted nodes may be unreachable");
		const exits = [];
		for (const node of nodes) {
			const port = portMap.get(nodeKeyOf(node));
			if (port === void 0) continue;
			exits.push({
				address: `127.0.0.1:${port}`,
				protocol: "socks5",
				node
			});
		}
		return exits;
	}
	/** Graceful stop: interrupt -> grace -> kill (taskkill /T on Windows). */
	async stop() {
		const child = this.#child;
		if (child === null || child.exitCode !== null) {
			this.#running = false;
			return;
		}
		this.#child = null;
		if (process.platform === "win32" && child.pid) await new Promise((resolve) => {
			const killer = spawn("taskkill", [
				"/T",
				"/PID",
				String(child.pid)
			], { stdio: "ignore" });
			killer.once("exit", () => resolve());
			killer.once("error", () => resolve());
		});
		else child.kill("SIGINT");
		const exited = new Promise((resolve) => child.once("exit", () => resolve()));
		const grace = new Promise((resolve) => setTimeout(() => resolve("timeout"), STOP_GRACE_MS));
		if (await Promise.race([exited.then(() => "exit"), grace]) === "timeout") {
			if (process.platform === "win32" && child.pid) await new Promise((resolve) => {
				const killer = spawn("taskkill", [
					"/T",
					"/F",
					"/PID",
					String(child.pid)
				], { stdio: "ignore" });
				killer.once("exit", () => resolve());
				killer.once("error", () => resolve());
			});
			else child.kill("SIGKILL");
			await exited;
		}
		this.#running = false;
	}
};

//#endregion
//#region src/pool/subscription-fetcher.ts
/** Empty/whitespace means "use the default", never "send no User-Agent". */
function normalizeUserAgent(userAgent) {
	const trimmed = (userAgent ?? "").trim();
	return trimmed === "" ? DEFAULT_SUBSCRIPTION_USER_AGENT : trimmed;
}
var SubscriptionFetcher = class {
	#deps;
	#urls = [];
	#state = {
		pendingConversion: [],
		convertedAdmitted: 0,
		lastFetch: 0,
		lastError: "",
		plaintextAdmitted: 0
	};
	#timer = null;
	#running = false;
	#stopped = false;
	#intervalMs;
	#timeoutMs;
	#userAgent;
	/** Live conversion core; see setSupervisor(). */
	#supervisor;
	#logger;
	constructor(deps, options = {}) {
		this.#deps = deps;
		this.#supervisor = deps.supervisor;
		this.#intervalMs = options.intervalMs ?? 30 * 6e4;
		this.#timeoutMs = options.timeoutMs ?? 3e4;
		this.#userAgent = normalizeUserAgent(options.userAgent);
		this.#logger = options.logger;
	}
	get state() {
		return {
			...this.#state,
			pendingConversion: [...this.#state.pendingConversion]
		};
	}
	/** Configured URL count (status bridge; the URLs themselves never ride out). */
	get urlCount() {
		return this.#urls.length;
	}
	/**
	* Update the subscription URL list (settings change) and, when the fetcher
	* is already running AND the list really changed, pull right away.
	*
	* Live-observed 2026-10-12: saving the settings card only re-seeded the
	* list, so a newly added airport URL stayed unfetched until the next
	* interval tick — with the shipped 30-minute default that looked exactly
	* like "the setting did not apply". Before `start()` (first assembly) the
	* immediate refresh is skipped on purpose: the caller starts the fetcher
	* right after, which fetches anyway.
	*/
	setUrls(urls) {
		const next = urls.filter((url) => url.trim().length > 0);
		const changed = next.length !== this.#urls.length || next.some((url, index) => url !== this.#urls[index]);
		this.#urls = next;
		if (changed && this.#timer !== null && !this.#stopped && next.length > 0) this.refresh();
	}
	/**
	* Live re-apply of the refresh interval (settings page, docs §5.1). A save
	* that does not change the interval must NOT re-arm the timer: every
	* settings commit calls this method, and restarting the countdown on each
	* one pushed the next fetch a full interval away — a save made the pool
	* less live, not more.
	*/
	setIntervalMs(ms) {
		const next = Math.max(6e4, ms);
		if (next === this.#intervalMs) return;
		this.#intervalMs = next;
		if (this.#timer !== null) {
			clearInterval(this.#timer);
			this.#timer = setInterval(() => void this.refresh(), this.#intervalMs);
			this.#timer.unref?.();
		}
	}
	/**
	* Live re-apply of the fetch User-Agent (settings page, docs §5.1). Takes
	* effect on the next refresh — the in-flight round keeps the UA it started
	* with. Empty falls back to the default rather than sending no UA at all.
	*/
	setUserAgent(userAgent) {
		this.#userAgent = normalizeUserAgent(userAgent);
	}
	/** The UA the next fetch will send (settings card echo / diagnostics). */
	get userAgent() {
		return this.#userAgent;
	}
	/**
	* Attach or replace the encrypted-node conversion core (settings page,
	* docs §5.1). `singbox.path` is editable while the pool runs, but the
	* supervisor used to be read once at construction — so filling the field
	* after the fetcher existed had NO effect until a restart, and the parked
	* nodes simply stayed parked with no error to explain why. Conversion runs
	* on the next refresh, so callers that want it immediately should follow up
	* with refreshNow().
	*/
	setSupervisor(supervisor) {
		this.#supervisor = supervisor;
	}
	/** Manual refresh trigger (settings page 立即刷新, docs §5.3 /probe scope: 'refill' parity). */
	async refreshNow() {
		return this.refresh();
	}
	start() {
		if (this.#timer !== null || this.#stopped) return;
		this.refresh();
		this.#timer = setInterval(() => void this.refresh(), this.#intervalMs);
		this.#timer.unref?.();
	}
	stop() {
		this.#stopped = true;
		if (this.#timer !== null) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
		this.#supervisor?.stop().catch(() => {});
	}
	/** One refresh round over every URL; never overlaps itself. */
	async refresh() {
		if (this.#running) return this.state;
		this.#running = true;
		try {
			const pending = [];
			const unroutable = [];
			const plaintext = [];
			let lastError = "";
			for (const url of this.#urls) try {
				const report = parseSubscription(await this.#fetch(url));
				for (const node of report.nodes) {
					if (!isDialableServer(node.server)) {
						unroutable.push(node);
						continue;
					}
					if (node.type === "http" || node.type === "socks5") plaintext.push({
						address: `${node.server}:${node.port}`,
						protocol: node.type
					});
					else pending.push(node);
				}
				this.#logger?.info(`opencode2dsh: subscription parsed ${report.nodes.length} node(s) (${report.detected}) from ${this.#redact(url)}`);
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
				this.#logger?.warn(`opencode2dsh: subscription fetch failed for ${this.#redact(url)}: ${lastError}`);
			}
			if (unroutable.length > 0) {
				const sample = unroutable.slice(0, 5).map((node) => `${node.type} ${node.server}:${node.port}`).join(", ");
				this.#logger?.warn(`opencode2dsh: subscription carried ${unroutable.length} node(s) with an address that cannot be dialled from this machine; skipped (${sample}${unroutable.length > 5 ? ", …" : ""})`);
			}
			this.#state = {
				pendingConversion: pending,
				convertedAdmitted: 0,
				lastFetch: Date.now(),
				lastError,
				plaintextAdmitted: 0
			};
			if (pending.length > 0 && this.#supervisor) try {
				const exits = await this.#supervisor.reload(pending);
				const tasks$1 = exits.filter((exit) => !this.#deps.pool.has(exit.address)).map((exit) => ({
					exitId: exit.address,
					kind: "subscription-smoke",
					run: async () => {
						const verdict = await admitTrusted(this.#deps, {
							address: exit.address,
							protocol: exit.protocol,
							source: "subscription"
						});
						if (verdict.admitted && verdict.node) {
							if (this.#deps.pool.add(verdict.node)) {
								if (verdict.unverified) this.#deps.pool.markUnverified(verdict.node.id);
								else this.#deps.pool.markOk(verdict.node.id);
								this.#state.convertedAdmitted += 1;
								const served = exit.node;
								this.#state.pendingConversion = this.#state.pendingConversion.filter((node) => node !== served);
							}
						}
					}
				}));
				if (tasks$1.length > 0) await this.#deps.prober.enqueueAll(tasks$1);
				this.#logger?.info(`opencode2dsh: sing-box converted ${exits.length} encrypted node(s); ${this.#state.convertedAdmitted} admitted`);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.#state.lastError = message;
				this.#logger?.warn(`opencode2dsh: sing-box conversion failed: ${message}`);
			}
			const tasks = plaintext.filter((candidate) => !this.#deps.pool.has(candidate.address)).map((candidate) => ({
				exitId: candidate.address,
				kind: "subscription-smoke",
				run: async () => {
					const verdict = await admitTrusted(this.#deps, {
						address: candidate.address,
						protocol: candidate.protocol,
						source: "subscription"
					});
					if (verdict.admitted && verdict.node) {
						if (this.#deps.pool.add(verdict.node)) {
							if (verdict.unverified) this.#deps.pool.markUnverified(verdict.node.id);
							else this.#deps.pool.markOk(verdict.node.id);
							this.#state.plaintextAdmitted += 1;
						}
					}
				}
			}));
			if (tasks.length > 0) await this.#deps.prober.enqueueAll(tasks);
			return this.state;
		} finally {
			this.#running = false;
		}
	}
	async #fetch(url) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
		try {
			const response = await (this.#deps.fetchImpl ?? fetch)(url, {
				signal: controller.signal,
				headers: {
					accept: "*/*",
					"user-agent": this.#userAgent
				}
			});
			if (!response.ok) throw new Error(`subscription HTTP ${response.status}`);
			return await response.text();
		} finally {
			clearTimeout(timer);
		}
	}
	/** Subscriptions embed account credentials; never log them in full. */
	#redact(url) {
		if (url.length <= 24) return url;
		return url.slice(0, 12) + "…" + url.slice(-6);
	}
};

//#endregion
//#region src/ip-pool.ts
/** Data dir shared with the catalog cache (config.ts convention). */
function dataDir() {
	return join(homedir(), ".opencode2dsh");
}
/**
* docs/ip-pool.md §4.6 probe timing. `PROBE_INTERVAL_MS` is the documented
* periodic-recheck cadence, `DEAD_RETRY_MS` the documented dead retry; the
* tick is far shorter than either because it is pure bookkeeping — it reads
* health and enqueues only what is actually due.
*/
const PROBE_TICK_MS = 6e4;
const PROBE_INTERVAL_MS = 10 * 6e4;
const DEAD_RETRY_MS = 2 * 6e4;
/** Parse one manual proxy string into an exit id + protocol, or null. */
function parseManualProxy(entry) {
	const trimmed = entry.trim();
	if (trimmed === "") return null;
	const schemeMatch = /^([a-z0-9+.-]+):\/\//i.exec(trimmed);
	const scheme = schemeMatch?.[1]?.toLowerCase();
	const rest = schemeMatch ? trimmed.slice(schemeMatch[0].length) : trimmed;
	if (!/^\[[^\]]+\]|[^:]+:\d{1,5}$/.test(rest)) return null;
	if (scheme !== void 0 && scheme !== "http" && scheme !== "socks5" && scheme !== "https" && scheme !== "socks4" && scheme !== "socks5h") return null;
	return {
		id: trimmed,
		protocol: scheme === "socks5" || scheme === "socks4" || scheme === "socks5h" ? "socks5" : "http"
	};
}
/**
* Which health mark one probe verdict earns. Extracted (and exported) so the
* mapping itself is testable without a network: a verified pass marks the
* exit ok, a 429 marks it limited, and the trusted-source fallback — which
* returns `admitted: true` without having reached the exit at all — must NOT
* claim health. Live 2026-10-13: markOk() on the fallback revived five dead
* subscription exits every probe round (state ok, grade S, exitIP unknown),
* so the picker ranked them first and fed them real traffic that died at the
* transport layer.
*/
function applyProbeVerdict(pool, id, verdict, model) {
	if (verdict.limited) pool.markLimited(id);
	else if (verdict.unverified) pool.markUnverified(id);
	else pool.markOk(id, model);
}
/** One manual/pinned row: unknown facts until the prober measures them. */
function manualNode(id, protocol) {
	return {
		id,
		protocol,
		source: "manual",
		pinned: false,
		exitIP: "",
		exitLocation: "",
		latencyMs: 0,
		quality: gradeOf(0),
		addedAt: Date.now()
	};
}
/**
* Make the pool's manual rows and its pin match `ipPool` exactly: add what the
* config names, drop what it no longer names, then pin/unpin.
*
* Idempotent, and scoped to `source === 'manual'` rows (free and subscription
* rows are never touched). Runs at assembly AND on every live commit.
*
* Live-observed gap this closes (2026-10-12): manual/pinned used to be read
* ONLY at assembly, so editing 固定主力 in the settings card wrote the config,
* triggered reconfigure() — and changed nothing. The stale pin kept winning
* pick() while the deleted row stayed in the table, so the only visible fix
* was a restart. docs §5.1 / IP-5 acceptance ("设置页改任何项保存即生效无需重启")
* was unmet for exactly these two fields.
*
* A pinned address that is not in the pool is admitted as a manual row (the
* user vouches for it, docs 3.1/4.5); an id that is already in the pool keeps
* its row and source and is merely pinned.
*/
function syncManualExits(pool, ipPool = {}) {
	const desired = /* @__PURE__ */ new Set();
	for (const entry of ipPool?.manual ?? []) {
		const parsed = parseManualProxy(entry);
		if (!parsed) continue;
		desired.add(parsed.id);
		if (!pool.has(parsed.id)) {
			pool.add(manualNode(parsed.id, parsed.protocol));
			pool.markOk(parsed.id);
		}
	}
	const requested = (ipPool?.pinnedExitId ?? "").trim();
	let pinned = "";
	if (requested !== "") {
		if (pool.has(requested)) pinned = requested;
		else {
			const parsed = parseManualProxy(requested);
			if (parsed) {
				pool.add(manualNode(parsed.id, parsed.protocol));
				pool.markOk(parsed.id);
				pinned = parsed.id;
			}
		}
		if (pinned !== "") desired.add(pinned);
	}
	for (const node of pool.list()) if (node.source === "manual" && !desired.has(node.id)) pool.remove(node.id);
	if (pinned === "") pool.unpin();
	else pool.pin(pinned);
}
/** Build the ExitPool from config (manual proxies + pinned). The pool starts
*  with unknown health; the periodic/probe layer (IP-2) fills it in. Pinned
*  nodes are admitted even without admission data — the user vouches for
*  them (docs/ip-pool.md 3.1/4.5). */
function buildPoolFromConfig(config) {
	const pool = new ExitPool();
	syncManualExits(pool, config.ipPool);
	return pool;
}
/**
* Assemble the routing stack. Returns null (with a logged reason) when the
* host has no undici or the pool ends up empty — enabled-but-empty must
* degrade to today's direct behavior, never a broken dispatcher (3.3).
*
* The undici seam is imported once here and threaded to every layer; empty
* pool does not stop the runtime from existing (reconfigure can add exits
* later), it only keeps the dispatcher uninstalled.
*/
async function startIpPool(config, logger, deps = {}) {
	const ipPool = config.ipPool ?? {};
	const pool = buildPoolFromConfig(config);
	let undici;
	try {
		undici = await import("undici");
	} catch (err) {
		logger.warn(`opencode2dsh: undici unavailable; exit routing disabled (${err instanceof Error ? err.message : String(err)})`);
		return null;
	}
	const installerDeps = {
		pool,
		undici,
		proxyHosts: ipPool.proxyHosts,
		proxyPathPrefixes: ipPool.proxyPathPrefixes,
		logger
	};
	const installer = deps.makeInstaller !== void 0 ? deps.makeInstaller(installerDeps) : new (await (import("./installer-D_lIsYgE.js"))).RoutingInstaller(installerDeps);
	const admissionDeps = {
		pool,
		undici,
		logger,
		blockedCountries: ipPool.free?.blockedCountries,
		smokeModel: (ipPool.probeModels ?? [])[0]
	};
	const probeModels = ipPool.probeModels ?? [];
	const prober = new Prober({
		pool,
		maxConcurrentProbes: ipPool.maxConcurrentProbes ?? 3
	});
	let refill = null;
	let subscriptions = null;
	let supervisor;
	const ensureSupervisor = () => {
		const singboxPath = config.ipPool?.singbox?.path;
		if (typeof singboxPath !== "string" || singboxPath.length === 0) return void 0;
		if (supervisor === void 0) supervisor = new SingBoxSupervisor({
			binPath: singboxPath,
			dataDir: join(dataDir(), "singbox"),
			logger
		});
		else supervisor.setBinPath(singboxPath);
		return supervisor;
	};
	const ensureSubscriptions = (urls) => {
		if (urls.length === 0) return null;
		if (subscriptions === null) subscriptions = new SubscriptionFetcher({
			...admissionDeps,
			prober,
			supervisor: ensureSupervisor()
		}, { logger });
		subscriptions.setUrls(urls);
		return subscriptions;
	};
	/** Apply the config to the live objects (initial start + reconfigure). */
	const applyConfig = () => {
		const current = config.ipPool ?? {};
		syncManualExits(pool, current);
		pool.setTargetSize(current.free?.targetSize ?? 20);
		admissionDeps.blockedCountries = current.free?.blockedCountries;
		admissionDeps.smokeModel = probeModels[0];
		prober.setMaxConcurrent(current.maxConcurrentProbes ?? 3);
		installer.setProxyHosts?.(current.proxyHosts);
		installer.setProxyPathPrefixes?.(current.proxyPathPrefixes);
		const wantRefill = (current.free?.enabled ?? true) && current.enabled !== false;
		if (wantRefill && refill === null) {
			refill = new RefillScheduler(pool, {
				...admissionDeps,
				prober
			});
			refill.start();
		} else if (!wantRefill && refill !== null) {
			refill.stop();
			refill = null;
		}
		const fetcher = ensureSubscriptions(current.subscriptions ?? []);
		if (fetcher !== null) {
			fetcher.setSupervisor(ensureSupervisor());
			fetcher.setIntervalMs(current.subscription?.refreshMs ?? 30 * 6e4);
			fetcher.setUserAgent(current.subscription?.userAgent);
			if (fetcher === subscriptions && !fetcherActive) {
				fetcher.start();
				fetcherActive = true;
			}
		}
	};
	let fetcherActive = false;
	/**
	* Engage routing as soon as the pool stops being empty.
	*
	* A pool that assembles EMPTY (subscription-only profile, or free enabled
	* but not yet refilled) skips the install() below and used to have no
	* retry hook except a settings save: the exits landed minutes later and
	* every request kept going direct while the card reported the pool as
	* enabled. This watches the TABLE, not a source, so subscription, free and
	* manual admissions all engage routing (live-observed 2026-10-12).
	*/
	const engageRouting = () => {
		if (config.ipPool?.enabled === false) return;
		if (installer.enabled || pool.snapshot().total === 0) return;
		installer.install();
		if (installer.enabled) logger.info("opencode2dsh: exits admitted — exit routing engaged (live)");
	};
	pool.onAdmitted(engageRouting);
	if (pool.snapshot().total > 0) installer.install();
	else logger.warn("opencode2dsh: ipPool enabled but the pool is empty; staying direct until exits land (subscription/free admissions engage routing automatically)");
	applyConfig();
	/**
	* One exit's probe pass, shared by every trigger (manual 批量探活 / 单出口 /
	* periodic due-probe) so the three can never drift apart.
	*/
	const probeOne = async (entry, models) => {
		const { admitCandidate: admitCandidate$1, admitTrusted: admitTrusted$1 } = await import("./admission-Ckvshp8I.js");
		for (const model of models) {
			admissionDeps.smokeModel = model;
			const verdict = entry.source === "free" ? await admitCandidate$1(admissionDeps, {
				address: entry.id,
				protocol: entry.protocol,
				source: "free"
			}) : await admitTrusted$1(admissionDeps, {
				address: entry.id,
				protocol: entry.protocol,
				source: entry.source === "manual" ? "manual" : "subscription"
			}, {
				pinned: entry.pinned,
				previous: {
					exitIP: entry.exitIP,
					exitLocation: entry.exitLocation,
					latencyMs: entry.latencyMs,
					quality: entry.quality
				}
			});
			if (verdict.admitted && verdict.node) {
				pool.add({
					...entry,
					...verdict.node,
					pinned: entry.pinned
				});
				applyProbeVerdict(pool, entry.id, verdict, model);
			} else {
				pool.markDeadStrike(entry.id);
				break;
			}
		}
	};
	const probeAll = async () => {
		const models = probeModels.length > 0 ? probeModels : ["big-pickle"];
		const tasks = pool.list().map((entry) => ({
			exitId: entry.id,
			kind: "probe-all",
			run: () => probeOne(entry, models)
		}));
		if (tasks.length === 0) return 0;
		prober.enqueueAll(tasks).catch(() => {});
		return tasks.length;
	};
	const probeExitTask = (exitId, entry) => ({
		exitId,
		kind: "probe-exit",
		run: () => probeOne(entry, probeModels.length > 0 ? [...probeModels] : ["big-pickle"])
	});
	const probeExit = async (exitId) => {
		const entry = pool.list().find((node) => node.id === exitId);
		if (!entry) return 0;
		await prober.enqueue(probeExitTask(exitId, entry));
		return 1;
	};
	/**
	* Periodic due-probe (docs §4.3 周期 + §4.6 deadRetryMs). Re-probes:
	* dead exits once deadRetryMs has elapsed, cooling exits whose window
	* expired, exits never probed, and anything past the periodic cadence.
	*
	* This is the ONLY way a dead exit can come back: `ExitPool.isUsable()`
	* returns false for `state === 'dead'`, so `pick()` never hands one a real
	* request and passive traffic can never call markOk() on it. Without this
	* loop a single false-positive transport strike retired an exit for the
	* life of the process — a live profile lost all 14 exits this way and the
	* pool drained to zero while still reporting itself enabled.
	*
	* Cheap by construction: it only reads health and enqueues what is due, so
	* the tick runs far more often than the 10-minute cadence in order to
	* honour the 2-minute dead-retry budget.
	*/
	const probeDue = async () => {
		const due = pool.dueForProbe(Date.now(), {
			intervalMs: PROBE_INTERVAL_MS,
			deadRetryMs: DEAD_RETRY_MS
		});
		if (due.length === 0) return 0;
		const byId = new Map(pool.list().map((entry) => [entry.id, entry]));
		const models = probeModels.length > 0 ? probeModels : ["big-pickle"];
		const tasks = due.flatMap((id) => {
			const entry = byId.get(id);
			return entry === void 0 ? [] : [{
				exitId: id,
				kind: "probe-due",
				run: () => probeOne(entry, models)
			}];
		});
		if (tasks.length === 0) return 0;
		prober.enqueueAll(tasks).catch(() => {});
		return tasks.length;
	};
	const probeTimer = setInterval(() => {
		probeDue().catch(() => {});
	}, PROBE_TICK_MS);
	probeTimer.unref?.();
	setRotateDelegate(createRotateDelegate(pool, { maxAttempts: config.ipPool?.maxRotateAttempts ?? 3 }));
	return {
		pool,
		installer,
		prober,
		get subscriptions() {
			return subscriptions;
		},
		get refill() {
			return refill;
		},
		async reconfigure(next) {
			const wasEnabled = config.ipPool?.enabled !== false;
			config.ipPool = next.ipPool;
			probeModels.length = 0;
			probeModels.push(...next.ipPool?.probeModels ?? []);
			const enable = next.ipPool?.enabled !== false;
			applyConfig();
			setRotateDelegate(createRotateDelegate(pool, { maxAttempts: next.ipPool?.maxRotateAttempts ?? 3 }));
			if (enable && !installer.enabled && pool.snapshot().total > 0) {
				installer.install();
				if (installer.enabled) logger.info("opencode2dsh: exit routing recovered — global dispatcher is free again (R1)");
			} else if (!enable && installer.enabled) installer.disable();
			if (wasEnabled !== enable) logger.info(`opencode2dsh: ip pool ${enable ? "enabled" : "disabled"} via settings (live)`);
		},
		probeAll,
		probeExit,
		async refillNow() {
			if (refill !== null) await refill.tick();
		},
		async refreshSubscriptions() {
			await subscriptions?.refreshNow();
		},
		async dispose() {
			clearInterval(probeTimer);
			setRotateDelegate(null);
			subscriptions?.stop();
			refill?.stop();
			installer.dispose();
		}
	};
}

//#endregion
export { applyProbeVerdict, buildPoolFromConfig, parseManualProxy, startIpPool, syncManualExits };