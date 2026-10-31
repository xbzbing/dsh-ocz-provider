import "./catalog.js";
import { i as parseSubscription, l as setRotateDelegate, n as stateDir, o as createRotateDelegate, r as DEFAULT_SUBSCRIPTION_USER_AGENT, t as detectProxyProtocol } from "./protocol.js";
import { h as directEgressDirective, r as pickSmokeContent, y as setRelayEgressSeams } from "./smoke-content.js";
import { _ as settleTransport, b as relayDirectFamily, g as settleStatus, h as mayEgressLocally, i as exitProxyUri, l as LOCAL_EXIT_ID, n as NO_EXIT_MESSAGE, v as parseManualProxy, x as resolveLocalIpFamily } from "./dispatcher.js";
import { a as ExitPool, i as coarseScreen, o as UNVERIFIED_QUALITY, s as gradeOf, t as admitBySpeed } from "./admission.js";
import { join } from "node:path";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";

//#region src/pool/transport.ts
/** A row the pool never measured: its `protocol` is the operator's typing. */
function unmeasured(node) {
	return node.source === "manual" || node.exitIP === "";
}
var TransportVerdicts = class {
	#deps;
	/** When each row last spent its one free diagnosis this outage. */
	#pardonedAt = /* @__PURE__ */ new Map();
	/** Rows with a diagnosis in flight — a second cut must not queue another. */
	#inflight = /* @__PURE__ */ new Set();
	constructor(deps) {
		this.#deps = deps;
	}
	/** Rows holding a spent pardon (diagnostics/tests). */
	get pardoned() {
		return [...this.#pardonedAt.keys()];
	}
	/** Rows whose diagnosis has not answered yet (diagnostics/tests). */
	get pending() {
		return [...this.#inflight];
	}
	/**
	* Judge one transport cut. Synchronous on purpose: the caller is a request
	* teardown that must not wait for a socket probe, so anything that needs the
	* network answers through the callbacks above and the row's fate lands a few
	* milliseconds later.
	*/
	cut(exitId) {
		const pool = this.#deps.pool;
		for (const id of this.#pardonedAt.keys()) if (!pool.has(id)) this.#pardonedAt.delete(id);
		const node = pool.get(exitId);
		if (node === void 0) return "ignored";
		if (!unmeasured(node)) {
			pool.recordPassiveTransport(exitId);
			return "struck";
		}
		if (this.#inflight.has(exitId)) {
			pool.recordTransportSignal(exitId);
			return "deferred";
		}
		/**
		* One free diagnosis per OUTAGE, and an outage ends when something proves
		* the row alive — not when a timer expires.
		*
		* A time window looked equivalent and was not: a row that drops a request
		* every couple of minutes was pardoned again on every cut, so a listener
		* that answers while its tunnel is gone stayed "usable" forever and kept
		* absorbing the pinned traffic (measured live: 8 cuts, 0 successes, and the
		* row still pickable). Keying the pardon on the proof instead means the
		* second cut without a success in between is a strike, however far apart
		* the two were — while any success, including a passing probe, re-arms it.
		*/
		const pardon = this.#pardonedAt.get(exitId);
		if (pardon !== void 0 && pardon >= pool.provenAt(exitId)) {
			this.#pardonedAt.delete(exitId);
			pool.recordPassiveTransport(exitId);
			return "struck";
		}
		this.#pardonedAt.set(exitId, this.#now());
		this.#inflight.add(exitId);
		pool.recordTransportSignal(exitId);
		this.#diagnose(exitId, node.protocol);
		return "deferred";
	}
	async #diagnose(exitId, label) {
		try {
			const found = await this.#deps.detect(exitId);
			if (!this.#deps.pool.has(exitId)) {
				this.#pardonedAt.delete(exitId);
				return;
			}
			if (found === null) {
				this.#deps.pool.recordPassiveTransport(exitId);
				this.#warn(`oc2dsh: 出口 ${exitId} 连不上（端口没有监听，或监听的不是代理）；已判 dead`);
				return;
			}
			if (found !== label) {
				if (!this.#deps.pool.refresh(exitId, { protocol: found })) return;
				this.#deps.pool.revive(exitId);
				this.#pardonedAt.delete(exitId);
				this.#warn(`oc2dsh: 出口 ${exitId} 标的是 ${label}，实测是 ${found}（已纠正并复活；下一次请求就走对了）`);
				return;
			}
			this.#deps.pool.markUnverified(exitId);
			this.#warn(`oc2dsh: 出口 ${exitId} 连得上，这一次请求没拿到响应（先不判 dead；再失败一次就判）`);
		} catch {} finally {
			this.#inflight.delete(exitId);
		}
	}
	#now() {
		return this.#deps.now?.() ?? Date.now();
	}
	#warn(message$1) {
		this.#deps.logger?.warn(message$1);
	}
};

//#endregion
//#region src/pool/prober.ts
var Prober = class {
	#pool;
	#maxConcurrent;
	#queue = [];
	#inFlight = 0;
	/** Candidates outside the pool with a task running (no pool lock to hold). */
	#busy = /* @__PURE__ */ new Set();
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
		return new Promise((resolve$1) => {
			this.#queue.push({
				task,
				resolve: resolve$1
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
		while (!this.idle) await new Promise((resolve$1) => {
			this.#drained = resolve$1;
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
			let locked = false;
			const index = this.#queue.findIndex((slot$1) => {
				const claim = this.#claim(slot$1.task.exitId);
				if (claim === null) return false;
				locked = claim;
				return true;
			});
			if (index < 0) break;
			const [slot] = this.#queue.splice(index, 1);
			if (!slot) break;
			this.#inFlight += 1;
			this.#runSlot(slot, locked);
		}
		if (this.idle) {
			const waiter = this.#drained;
			this.#drained = null;
			waiter?.();
		}
	}
	/**
	* Claim the exit for one task: the pool's per-exit lock for a row in the
	* table (true), the scheduler's own busy set for a candidate outside it
	* (false), or null when a task of that exit is already running.
	*/
	#claim(exitId) {
		if (this.#busy.has(exitId)) return null;
		if (this.#pool.get(exitId) !== void 0) return this.#pool.takeProbeLock(exitId) ? true : null;
		this.#busy.add(exitId);
		return false;
	}
	async #runSlot(slot, locked) {
		try {
			await slot.task.run();
		} catch {} finally {
			if (locked) this.#pool.releaseProbeLock(slot.task.exitId);
			else this.#busy.delete(slot.task.exitId);
			slot.resolve();
			this.#finishSlot();
		}
	}
};

//#endregion
//#region src/pool/onboard.ts
function message(err) {
	return err instanceof Error ? err.message : String(err);
}
var Onboarder = class {
	#deps;
	/** Candidate per address from the last run (drives replace()). */
	#candidates = /* @__PURE__ */ new Map();
	/** Slots currently selected (online), the live `keep` set for a rebuild. */
	#selected = /* @__PURE__ */ new Set();
	/** Screened but not selected, fastest first. */
	#reserve = [];
	/** Node identity per listener address from the last run (ConvertedExit.key). */
	#keys = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.#deps = deps;
	}
	/** Reserves still waiting (diagnostics). */
	get reserveSize() {
		return this.#reserve.length;
	}
	/** Every listener address the last run produced (selected and reserve). */
	get addresses() {
		return [...this.#candidates.keys()];
	}
	/** Which node each address served in the last run (handed to the next onboarder). */
	get identities() {
		return new Map(this.#keys);
	}
	/**
	* One onboarding round over a freshly converted candidate list.
	*
	* Called from the subscription refresh, after the full conversion produced
	* every candidate's own local port. `inherited` / `inheritedKeys` carry the
	* addresses and node identities a previous onboarder produced, so a refresh
	* that builds a new onboarder still prunes retired ports and notices a port
	* that now serves another node.
	*/
	async run(exits, inherited = [], inheritedKeys = /* @__PURE__ */ new Map()) {
		const { pool, prober, admission, logger } = this.#deps;
		const previous = new Set([...this.#candidates.keys(), ...inherited]);
		const current = new Set(exits.map((exit) => exit.address));
		const previousKeys = new Map([...inheritedKeys, ...this.#keys]);
		this.#candidates = /* @__PURE__ */ new Map();
		this.#selected = /* @__PURE__ */ new Set();
		this.#reserve = [];
		this.#keys = /* @__PURE__ */ new Map();
		this.#pruneVanished(previous, current);
		this.#dropReassigned(exits, previousKeys);
		const result = {
			candidates: exits.length,
			screened: 0,
			online: 0,
			admitted: 0,
			promoted: 0,
			demoted: 0,
			reserve: 0
		};
		if (exits.length === 0) return result;
		const screenDeps = {
			undici: admission.undici,
			ipEchoUrl: admission.ipEchoUrl,
			blockedCountries: admission.blockedCountries,
			logger: admission.logger
		};
		const tasks = exits.map((exit) => ({
			exitId: exit.address,
			kind: "onboard-screen",
			run: async () => {
				const verdict = await coarseScreen(screenDeps, {
					address: exit.address,
					protocol: exit.protocol
				});
				this.#candidates.set(exit.address, {
					slot: exit.slot,
					address: exit.address,
					protocol: exit.protocol,
					node: exit.node,
					facts: "exitIP" in verdict ? verdict : null,
					screenRejection: "rejected" in verdict ? verdict.rejected : ""
				});
			}
		}));
		await prober.enqueueAll(tasks);
		const measured = [...this.#candidates.values()].filter((candidate) => candidate.facts !== null).sort((left, right) => left.facts.latencyMs - right.facts.latencyMs || left.address.localeCompare(right.address));
		result.screened = measured.length;
		if (measured.length < exits.length) {
			const sample = [...this.#candidates.values()].filter((candidate) => candidate.facts === null).slice(0, 3).map((candidate) => `${candidate.address} (${candidate.screenRejection})`).join(", ");
			logger?.info(`oc2dsh: onboarding screened ${measured.length}/${exits.length} candidate(s); ${exits.length - measured.length} did not answer the speed pass${sample === "" ? "" : ` (${sample}…)`}`);
		}
		/**
		* Nothing answered the speed pass at all — a blocked echo endpoint (the
		* documented dedicated-line case) or a transient outage, not dead nodes.
		* Draining a paid subscription to zero over a MEASUREMENT failure is
		* never acceptable, so fall back to unranked candidates in subscription
		* order: they are parked unverified at the tail (docs §4.5), never
		* dropped, and real traffic is what will ever prove them — this flow
		* probes nothing.
		*/
		let ranked = measured;
		if (ranked.length === 0 && exits.length > 0) {
			logger?.warn("oc2dsh: onboarding speed pass measured nothing; keeping candidates unranked in subscription order (parked at the tail, unverified — no probe runs for subscriptions)");
			ranked = [...this.#candidates.values()].sort((left, right) => left.slot - right.slot);
		}
		const wanted = pool.poolSize;
		const online = ranked.filter((candidate) => pool.has(candidate.address));
		for (const candidate of online) this.#refreshFacts(candidate);
		const fresh = ranked.filter((candidate) => !pool.has(candidate.address));
		const room = Math.max(0, wanted - online.length);
		const selected = [];
		const duplicates = [];
		const reserve = [];
		const claimed = /* @__PURE__ */ new Set();
		for (const candidate of fresh) {
			const exitIP = candidate.facts?.exitIP ?? "";
			if (exitIP !== "" && (claimed.has(exitIP) || pool.exitIPHolder(exitIP) !== void 0)) duplicates.push(candidate);
			else if (selected.length < room) {
				selected.push(candidate);
				if (exitIP !== "") claimed.add(exitIP);
			} else reserve.push(candidate);
		}
		this.#reserve = [...reserve, ...duplicates];
		this.#selected = new Set([...online, ...selected].map((candidate) => candidate.slot));
		result.online = online.length;
		result.reserve = this.#reserve.length;
		if (this.#selected.size < exits.length) try {
			await this.#deps.select([...this.#selected]);
		} catch (err) {
			logger?.warn(`oc2dsh: sing-box rebuild for the pool selection failed (${message(err)}); keeping the full conversion running`);
		}
		for (const candidate of selected) {
			if (candidate.facts === null) {
				if (!pool.has(candidate.address) && pool.isFull()) pool.evictWorst();
				this.#keepDemoted(candidate);
				result.demoted += 1;
				continue;
			}
			if (this.#admit(candidate)) result.admitted += 1;
		}
		result.reserve = this.#reserve.length;
		return result;
	}
	/**
	* A port that now serves a DIFFERENT node is a new exit: the row's health,
	* stickiness and counters belong to the node that left, so it leaves with it.
	* Identities come from the conversion (ConvertedExit.key); exits without one
	* are not judged.
	*/
	#dropReassigned(exits, previousKeys) {
		const { pool, logger } = this.#deps;
		const dropped = [];
		for (const exit of exits) {
			if (exit.key === void 0) continue;
			const before = previousKeys.get(exit.address);
			if (before !== void 0 && before !== exit.key && pool.has(exit.address)) {
				pool.remove(exit.address);
				dropped.push(exit.address);
			}
			this.#keys.set(exit.address, exit.key);
		}
		if (dropped.length > 0) logger?.info(`oc2dsh: ${dropped.length} listener(s) now serve a different node; their rows start over (${dropped.join(", ")})`);
	}
	/** Write this round's speed facts onto a row that stayed online. */
	#refreshFacts(candidate) {
		const facts = candidate.facts;
		if (facts === null) return;
		const holder = this.#deps.pool.exitIPHolder(facts.exitIP);
		this.#deps.pool.refresh(candidate.address, {
			...holder === void 0 || holder === candidate.address ? { exitIP: facts.exitIP } : {},
			exitLocation: facts.exitLocation,
			latencyMs: facts.latencyMs,
			quality: gradeOf(facts.latencyMs)
		});
	}
	/**
	* Drop pool rows whose local listener this conversion no longer serves.
	*
	* Every address this onboarder creates is a sing-box inbound port, and a
	* subscription refresh that drops nodes retires their ports while the pool
	* keeps the old addresses. Dialling a
	* retired port fails at CONNECT ("Connection error."), which the pool reads
	* as an exit-shaped failure: it rotates, strikes the exit dead, re-admits it
	* as an unverified trusted line, and does it all again (docs §3.2).
	*
	* Only addresses THIS onboarder produced are considered, so a manual proxy a
	* human added by hand is never touched. remove() also clears a pin that
	* pointed at the vanished row, which is what turns "pinned to a corpse" into
	* a pool that picks a live exit again.
	*/
	#pruneVanished(previous, current) {
		const { pool, logger } = this.#deps;
		const dropped = [];
		for (const address of previous) {
			if (current.has(address) || !pool.has(address)) continue;
			pool.remove(address);
			dropped.push(address);
		}
		if (dropped.length > 0) logger?.info(`oc2dsh: dropped ${dropped.length} exit(s) whose listener the new conversion no longer serves (${dropped.join(", ")})`);
	}
	/**
	* Converge a live pool to a LOWERED capacity: drop the worst unpinned exits
	* down to `pool.poolSize` and rebuild the config with only the survivors, so
	* their listeners close with them. Without this, lowering `poolSize` from the
	* settings card only binds the NEXT onboarding — the pool keeps serving its
	* old size and keeps the extra ports open (docs §4.7 容量下调要收敛).
	*
	* Returns how many exits were dropped. No-op for a pool at or under capacity,
	* and for a pool this onboarder does not own (no candidate list ⇒ nothing to
	* rebuild).
	*/
	async trim() {
		const { pool, logger } = this.#deps;
		if (this.#candidates.size === 0) return 0;
		const dropped = [];
		while (pool.list().length > pool.poolSize) {
			const evicted = pool.evictWorst();
			if (evicted === null) break;
			dropped.push(evicted);
		}
		if (dropped.length === 0) return 0;
		const addressBySlot = new Map([...this.#candidates.values()].map((candidate) => [candidate.slot, candidate.address]));
		const survivors = /* @__PURE__ */ new Set();
		for (const slot of this.#selected) {
			const address = addressBySlot.get(slot);
			if (address === void 0 || pool.has(address)) survivors.add(slot);
		}
		this.#selected = survivors;
		try {
			await this.#deps.select([...this.#selected]);
		} catch (err) {
			logger?.warn(`oc2dsh: sing-box rebuild after trimming to poolSize failed (${message(err)}); the dropped exits' ports stay open until the next round`);
		}
		logger?.info(`oc2dsh: pool trimmed to ${pool.poolSize} (dropped ${dropped.length}: ${dropped.join(", ")})`);
		return dropped.length;
	}
	/**
	* A pool exit must give up its slot (a passive 401/403 or transport death
	* the runtime observed, a dead rotation, or the operator's 轮换 button): swap
	* in the next reserve from its cached speed facts — no probe — or demote it
	* to the tail when there is none. Returns true when a replacement landed.
	*/
	async replace(address) {
		const candidate = this.#candidates.get(address);
		if (candidate === void 0) {
			this.#deps.pool.demoteToTail(address);
			return false;
		}
		/**
		* Nothing to give up: the exit already left BOTH the table and the current
		* selection, so this call is a late duplicate (a rotation removed it while
		* the swap request was still in flight). Promoting here would ADD a slot
		* rather than swap one — `selected − (slot that is no longer there) + next`
		* is one bigger than the selection, i.e. one extra local listener, the same
		* capacity lie from the other direction.
		*
		* A row that left the table mid-round but whose slot is still selected is
		* not a duplicate: that case must still be swapped.
		*/
		if (!this.#deps.pool.has(address) && !this.#selected.has(candidate.slot)) return false;
		const result = {
			candidates: 0,
			screened: 0,
			online: 0,
			admitted: 0,
			promoted: 0,
			demoted: 0,
			reserve: this.#reserve.length
		};
		await this.#promoteAfterRefusal(candidate, result);
		return result.admitted > 0;
	}
	/**
	* Swap a refused exit for the next reserve — from the reserve's CACHED speed
	* facts, never with a probe (docs §4.5: the subscription flow asks OpenCode
	* nothing; a reserve was already speed-tested at onboarding, and OpenCode's
	* opinion of an exit IP comes from real traffic).
	*
	* A promotion therefore always lands on the first candidate — only the
	* sing-box rebuild can fail it. When the reserve is exhausted the refused
	* exit is kept and moved to the tail (the pool holds its size, it just stops
	* spending traffic on that exit first).
	*/
	async #promoteAfterRefusal(refused, result) {
		const index = this.#reserve.findIndex((candidate) => {
			const holder = this.#deps.pool.exitIPHolder(candidate.facts?.exitIP ?? "");
			return holder === void 0 || holder === refused.address || holder === candidate.address;
		});
		const next = index < 0 ? void 0 : this.#reserve.splice(index, 1)[0];
		if (next === void 0) {
			this.#keepDemoted(refused);
			result.demoted += 1;
			this.#deps.logger?.warn(`oc2dsh: exit ${refused.address} refused upstream and no reserve is left; kept at the pool tail`);
			return;
		}
		const nextSelection = new Set(this.#selected);
		nextSelection.delete(refused.slot);
		nextSelection.add(next.slot);
		try {
			await this.#deps.select([...nextSelection]);
		} catch (err) {
			this.#reserve.splice(index, 0, next);
			this.#keepDemoted(refused);
			result.demoted += 1;
			this.#deps.logger?.warn(`oc2dsh: sing-box rebuild failed while promoting ${next.address} (${message(err)}); ${refused.address} stays at the tail`);
			return;
		}
		this.#selected = nextSelection;
		this.#deps.pool.remove(refused.address);
		result.promoted += 1;
		if (next.facts === null) {
			if (!this.#deps.pool.has(next.address) && this.#deps.pool.isFull()) this.#deps.pool.evictWorst();
			this.#keepDemoted(next);
			return;
		}
		if (this.#admit(next)) result.admitted += 1;
	}
	/**
	* Admit one speed-measured candidate: the row carries the speed test's
	* latency/grade (the ONLY measurement the subscription flow takes, docs
	* §4.5), and `markOk` claims exactly what the speed pass proved: this tunnel
	* carries HTTP with a known exit IP. What OpenCode thinks of that IP is left
	* entirely to passive verdicts from real traffic (recordPassive /
	* recordPassiveTransport), the standing liveness model (docs §4.3). Called
	* only for rows NOT yet in the table (the `fresh` slice), so it never clears
	* an existing row's bench or bans.
	*
	* Returns false when the pool refused the row (its exit IP is another row's
	* quota bucket): the slot leaves the selection, and its listener closes with
	* the next rebuild.
	*/
	#admit(candidate) {
		const { pool } = this.#deps;
		if (!pool.has(candidate.address) && pool.isFull()) pool.evictWorst();
		const facts = candidate.facts;
		if (!pool.add({
			id: candidate.address,
			protocol: candidate.protocol,
			source: "subscription",
			pinned: false,
			exitIP: facts?.exitIP ?? "",
			exitLocation: facts?.exitLocation ?? "",
			latencyMs: facts?.latencyMs ?? 0,
			quality: facts === null ? UNVERIFIED_QUALITY : gradeOf(facts.latencyMs),
			addedAt: Date.now()
		})) {
			this.#selected.delete(candidate.slot);
			this.#deps.logger?.warn(`oc2dsh: exit ${candidate.address} egresses from ${facts?.exitIP ?? "?"}, which another row already uses; not admitted`);
			return false;
		}
		pool.markOk(candidate.address);
		return true;
	}
	/** Keep a refused exit as the last resort: in the pool, but at the tail. */
	#keepDemoted(candidate) {
		const { pool } = this.#deps;
		if (!pool.has(candidate.address)) {
			const facts = candidate.facts;
			pool.add({
				id: candidate.address,
				protocol: "socks5",
				source: "subscription",
				pinned: false,
				exitIP: facts?.exitIP ?? "",
				exitLocation: facts?.exitLocation ?? "",
				latencyMs: facts?.latencyMs ?? 0,
				quality: facts === null ? UNVERIFIED_QUALITY : gradeOf(facts.latencyMs),
				addedAt: Date.now()
			});
		}
		pool.markUnverified(candidate.address);
		pool.demoteToTail(candidate.address);
	}
};

//#endregion
//#region src/pool/singbox-outbound.ts
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
			const headers = stringHeaders(ws.headers);
			if (headers !== null) transport.headers = headers;
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
/** sing-box wants `string -> string` headers; anything else in a raw map fails `sing-box check`. */
function stringHeaders(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const out = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry;
	else if (typeof entry === "number" && Number.isFinite(entry)) out[key] = String(entry);
	return Object.keys(out).length > 0 ? out : null;
}
/** Credentials each outbound type cannot start without. */
const REQUIRED_FIELDS = {
	vmess: ["uuid"],
	vless: ["uuid"],
	tuic: ["uuid"],
	trojan: ["password"],
	hysteria2: ["password"],
	anytls: ["password"],
	shadowsocks: ["method", "password"]
};
/**
* One ParsedNode -> one sing-box outbound (GoProxy buildOutbound), or null for
* an unsupported type or a node `sing-box check` would reject (bad port, empty
* server, missing credentials). One such node would otherwise fail the check
* for the whole config.
*/
function buildOutbound(node, tag) {
	if (typeof node.server !== "string" || node.server.trim() === "") return null;
	if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) return null;
	const out = mapOutbound(node, tag);
	if (out === null) return null;
	for (const field of REQUIRED_FIELDS[String(out.type)] ?? []) if (typeof out[field] !== "string" || out[field] === "") return null;
	return out;
}
/**
* The node's identity: its outbound config without the tag. Two refreshes that
* carry the same key carry the same exit; '' = no outbound at all.
*/
function nodeKey(node) {
	const out = buildOutbound(node, "");
	return out === null ? "" : JSON.stringify(out);
}
function mapOutbound(node, tag) {
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
			out.method = getStr(raw, "method") || getStr(raw, "cipher");
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

//#endregion
//#region src/pool/singbox.ts
/**
* Can this node's server address ever be dialled from THIS machine?
*
* A public subscription handing out a private / loopback / link-local /
* multicast literal is carrying a placeholder, not a node: converting it
* anyway hands it a local SOCKS5 port and a trusted-admission row that can
* only ever fail. Dropping it at conversion is the only place the pool never
* sees it.
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
/**
* The full sing-box config for a node list (GoProxy generateConfig).
*
* `keep` restricts the emitted inbounds to those candidate indexes (the
* onboarding's selection). `assigned` carries the supervisor's per-node ports
* (see `SingBoxSupervisor`); without it a node's port is its position in the
* CANDIDATE list, never its position in the emitted subset — so shrinking
* the config to the fastest N, or promoting a reserve later, leaves every node
* that stays selected on the same local port. That stability is what lets the
* pool keep its exit ids (and their health, counters and session stickiness)
* across a rebuild; a positional subset would renumber every survivor and
* silently repoint the pool at different nodes.
*/
function generateConfig(nodes, basePort = 3e4, keep, assigned) {
	const ports = [];
	const inbounds = [];
	const outbounds = [];
	const rules = [];
	const keepSet = keep === void 0 ? null : new Set(keep);
	nodes.forEach((node, index) => {
		if (keepSet !== null && !keepSet.has(index)) {
			ports.push(0);
			return;
		}
		const tag = `node-${index}`;
		const outbound = buildOutbound(node, `out-${tag}`);
		if (outbound === null) {
			ports.push(0);
			return;
		}
		const port = assigned !== void 0 ? assigned[index] ?? 0 : basePort + 1 + index;
		if (port <= 0) {
			ports.push(0);
			return;
		}
		ports.push(port);
		inbounds.push({
			type: "socks",
			tag: `in-${tag}`,
			listen: "127.0.0.1",
			listen_port: port
		});
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
		ports
	};
}
const STOP_GRACE_MS = 5e3;
function canConnect(port, timeoutMs = 1e3) {
	return new Promise((resolve$1) => {
		const socket = createConnection({
			host: "127.0.0.1",
			port
		});
		const finish = (ok) => {
			socket.destroy();
			resolve$1(ok);
		};
		socket.setTimeout(timeoutMs, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}
/**
* One sing-box child at a time. `reload()` and `stop()` run under one mutex, so
* two refreshes can never leave an orphaned child holding the same ports, and a
* reload requested before a `stop()` never spawns after it.
*
* Ports follow node IDENTITY (`nodeKey`), not list position: a node keeps its
* port across refreshes and reorders, new nodes take the lowest free port, and
* a port whose node vanished can be reused by a new node — the onboarding sees
* the key change and treats the address as a new exit (docs/ip-pool.md §4.7).
*/
var SingBoxSupervisor = class {
	#options;
	#child = null;
	#running = false;
	#configPath;
	#dataDir;
	/** Port per node of the last reload(), index-aligned (`0` = no inbound). */
	#ports = [];
	#nodes = [];
	/** Port per node identity, carried across reloads. */
	#portByKey = /* @__PURE__ */ new Map();
	/** Serializes reload/stop. */
	#lock = Promise.resolve();
	/** Bumped by every stop(); a reload requested before it never spawns. */
	#stopEpoch = 0;
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
	/** The ports the last reload() handed out, index-aligned with its node list
	*  (`0` = that node produced no inbound). Diagnostics only. */
	get ports() {
		return [...this.#ports];
	}
	#exclusive(job) {
		const run = this.#lock.then(job, job);
		this.#lock = run.then(() => void 0, () => void 0);
		return run;
	}
	/** The binary location: absolute path as-is; bare name must exist on PATH
	*  (verified through `sing-box version` — LookPath equivalent). */
	async #resolveBinary() {
		const bin = this.#options.binPath;
		if (bin.includes("/") || bin.includes("\\") || bin.includes(":")) {
			if (existsSync(bin)) return bin;
			throw new Error(`sing-box not found at ${bin}`);
		}
		if (!await new Promise((resolve$1) => {
			const child = spawn(bin, ["version"], { stdio: "ignore" });
			child.once("error", () => resolve$1(false));
			child.once("exit", (code) => resolve$1(code === 0));
		})) throw new Error(`sing-box not found on PATH ("${bin}"); install it or set singbox.path`);
		return bin;
	}
	/** Per-node ports for this node list: identities keep theirs, new ones take the lowest free. */
	#assignPorts(nodes) {
		const base = this.#options.basePort ?? 3e4;
		const seen = /* @__PURE__ */ new Map();
		const keys = nodes.map((node) => {
			const key = nodeKey(node);
			if (key === "") return "";
			const occurrence = seen.get(key) ?? 0;
			seen.set(key, occurrence + 1);
			return `${occurrence}:${key}`;
		});
		const ports = keys.map(() => 0);
		const used = /* @__PURE__ */ new Set();
		const next = /* @__PURE__ */ new Map();
		keys.forEach((key, index) => {
			const previous = key === "" ? void 0 : this.#portByKey.get(key);
			if (previous === void 0 || used.has(previous)) return;
			ports[index] = previous;
			used.add(previous);
			next.set(key, previous);
		});
		let free = base + 1;
		keys.forEach((key, index) => {
			if (key === "" || ports[index] !== 0) return;
			while (used.has(free)) free += 1;
			ports[index] = free;
			used.add(free);
			next.set(key, free);
		});
		this.#portByKey = next;
		return ports;
	}
	/**
	* Full reload: regenerate the config for the node list and (re)start.
	*
	* `keep` (candidate indexes) emits only those nodes' inbounds — the
	* onboarding's "keep the fastest N" and its later reserve promotions — while
	* every kept node stays on its own port. Absent = every node.
	*/
	reload(input, keep) {
		const epoch = this.#stopEpoch;
		return this.#exclusive(() => this.#reload(input, keep, epoch));
	}
	async #reload(input, keep, epoch) {
		if (epoch !== this.#stopEpoch) throw new Error("sing-box was stopped; reload abandoned");
		const nodes = [];
		const unroutable = [];
		for (const node of input) (isDialableServer(node.server) ? nodes : unroutable).push(node);
		if (unroutable.length > 0) {
			const sample = unroutable.slice(0, 5).map((node) => `${node.type} ${node.server}:${node.port}`).join(", ");
			this.#options.logger?.warn(`oc2dsh: sing-box conversion skipped ${unroutable.length} node(s) whose server address cannot be dialled from this machine (${sample}${unroutable.length > 5 ? ", …" : ""})`);
		}
		const emit = keep === void 0 ? nodes.length : keep.length;
		if (nodes.length === 0 || emit === 0) {
			await this.#stopChild();
			this.#nodes = [];
			this.#ports = [];
			return [];
		}
		const binary = await this.#resolveBinary();
		const assigned = this.#assignPorts(nodes);
		const invalid = assigned.filter((port) => port === 0).length;
		if (invalid > 0 && keep === void 0) this.#options.logger?.warn(`oc2dsh: sing-box conversion skipped ${invalid} node(s) with an unsupported type or an invalid config (bad port, missing credentials)`);
		const { config, ports } = generateConfig(nodes, this.#options.basePort ?? 3e4, keep, assigned);
		await mkdir(this.#dataDir, { recursive: true });
		const tmp = `${this.#configPath}.tmp`;
		await writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
		await rm(this.#configPath, { force: true });
		await rename(tmp, this.#configPath);
		if (!await new Promise((resolve$1) => {
			const child$1 = spawn(binary, [
				"check",
				"-c",
				this.#configPath,
				"-D",
				this.#dataDir
			], { stdio: "ignore" });
			child$1.once("error", () => resolve$1(false));
			child$1.once("exit", (code) => resolve$1(code === 0));
		})) throw new Error("sing-box config check failed (run `sing-box check` on the generated config for details)");
		await this.#stopChild();
		if (epoch !== this.#stopEpoch) throw new Error("sing-box was stopped; reload abandoned");
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
		this.#ports = ports;
		child.stderr?.on("data", (chunk) => {
			const text = chunk.toString("utf8").trim();
			if (text.length > 0) this.#options.logger?.info(`[sing-box] ${text}`);
		});
		child.once("exit", (code, signal) => {
			if (this.#child !== child) return;
			this.#running = false;
			this.#options.logger?.warn(`oc2dsh: sing-box exited unexpectedly (${signal !== null ? `signal ${signal}` : `code ${code}`}); converted exits are unreachable until the next refresh`);
		});
		child.once("error", (err) => {
			if (this.#child !== child) return;
			this.#running = false;
			this.#options.logger?.warn(`oc2dsh: sing-box failed: ${err.message}`);
		});
		const deadline = Date.now() + (this.#options.readyTimeoutMs ?? 1e4);
		const listening = ports.filter((port) => port > 0);
		let ready = false;
		while (Date.now() < deadline && !ready) {
			if (!this.#running) throw new Error("sing-box exited immediately after start (see logs)");
			await new Promise((resolve$1) => setTimeout(resolve$1, 500));
			for (const port of listening) if (await canConnect(port)) {
				ready = true;
				break;
			}
		}
		if (!ready) this.#options.logger?.warn("oc2dsh: sing-box ports not ready in time; some converted nodes may be unreachable");
		const exits = [];
		nodes.forEach((node, index) => {
			const port = ports[index] ?? 0;
			if (port <= 0) return;
			exits.push({
				address: `127.0.0.1:${port}`,
				protocol: "socks5",
				node,
				slot: index,
				key: nodeKey(node)
			});
		});
		return exits;
	}
	/**
	* Stop the child: interrupt -> grace -> kill (taskkill /T on Windows). Any
	* reload requested before this call is abandoned instead of spawning later.
	*/
	stop() {
		this.#stopEpoch += 1;
		return this.#exclusive(() => this.#stopChild());
	}
	async #stopChild() {
		const child = this.#child;
		this.#child = null;
		this.#running = false;
		if (child === null || exited(child)) return;
		const gone = new Promise((resolve$1) => {
			if (exited(child)) resolve$1();
			else child.once("exit", () => resolve$1());
		});
		if (process.platform === "win32" && child.pid) await taskkill([
			"/T",
			"/PID",
			String(child.pid)
		]);
		else child.kill("SIGINT");
		if (await settles(gone, STOP_GRACE_MS)) return;
		if (process.platform === "win32" && child.pid) await taskkill([
			"/T",
			"/F",
			"/PID",
			String(child.pid)
		]);
		else child.kill("SIGKILL");
		if (!await settles(gone, STOP_GRACE_MS)) this.#options.logger?.warn(`oc2dsh: sing-box (pid ${child.pid ?? "?"}) did not exit after SIGKILL; giving up on it`);
	}
};
/** True once the child is gone, by exit code OR by signal. */
function exited(child) {
	return child.exitCode !== null || child.signalCode !== null;
}
/** Did `promise` settle within `ms`? */
async function settles(promise, ms) {
	let timer;
	const timeout = new Promise((resolve$1) => {
		timer = setTimeout(() => resolve$1(false), ms);
	});
	try {
		return await Promise.race([promise.then(() => true), timeout]);
	} finally {
		clearTimeout(timer);
	}
}
function taskkill(args) {
	return new Promise((resolve$1) => {
		const killer = spawn("taskkill", args, { stdio: "ignore" });
		killer.once("exit", () => resolve$1());
		killer.once("error", () => resolve$1());
	});
}

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
	/** Last onboarding round's controller — holds the speed facts and the
	*  reserve, so a later refusal can be replaced (see replaceExit()). */
	#onboarder = null;
	/** One replacement at a time: each one rebuilds the sing-box config, and a
	*  burst of dead exits must not stack rebuilds. */
	#replacing = false;
	/** Swaps that arrived while the lock was held, keyed so a row queued twice
	*  swaps once; drained the moment the lock frees (see replaceExit). */
	#deferred = /* @__PURE__ */ new Set();
	#draining = false;
	/** Plaintext rows this fetcher put in the pool (pruned when the subscription drops them). */
	#plaintext = /* @__PURE__ */ new Set();
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
	* is already running AND the list really changed, pull right away — a newly
	* added airport URL must not sit unfetched until the next interval tick.
	* Before `start()` (first assembly) the immediate refresh is skipped on
	* purpose: the caller starts the fetcher right after, which fetches anyway.
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
	* settings commit calls this method, and re-arming on each one would push
	* the next fetch a full interval further out.
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
	* docs §5.1). `singbox.path` is editable while the pool runs, so this is
	* re-applied on every commit — otherwise the parked nodes simply stay
	* parked with no error to explain why. Conversion runs on the next
	* refresh, so callers that want it immediately should follow up with
	* refreshNow().
	*/
	setSupervisor(supervisor) {
		this.#supervisor = supervisor;
	}
	/** Manual refresh trigger (settings page 立即刷新, docs §5.3 /probe scope 'subscription'). */
	async refreshNow() {
		return this.refresh();
	}
	/**
	* Converge a live pool to a lowered `poolSize` (settings card, live): the
	* onboarding drops the worst exits and closes their listeners. Returns how
	* many were dropped; 0 when nothing is over capacity or no round has run yet.
	*/
	async enforceCapacity() {
		if (this.#onboarder === null || this.#replacing) return 0;
		this.#replacing = true;
		try {
			return await this.#onboarder.trim();
		} catch (err) {
			this.#logger?.warn(`oc2dsh: trimming the pool to poolSize failed: ${err instanceof Error ? err.message : String(err)}`);
			return 0;
		} finally {
			this.#replacing = false;
			await this.#drainDeferred();
		}
	}
	/**
	* Whether a replacement/trim is holding the rebuild mutex. The bridge reads
	* this to answer an operator's 删除 with "busy, try again" instead of sinking
	* the row — an automatic swap never surfaces it, it queues (replaceExit).
	*/
	get busy() {
		return this.#replacing;
	}
	/**
	* An exit in the pool must give up its slot after onboarding (a passive
	* 401/403 or transport death the runtime observed, a dead rotation, or the
	* operator's 轮换 button). Swap in the next-fastest reserve — admitted from
	* its cached speed facts, never with a probe (docs §4.5); with the
	* reserve exhausted the exit is kept and moved to the pool tail, so the pool
	* holds its size.
	*
	* `defer` is for the automatic callers (dead rotation, probe verdict): while
	* the mutex is held they queue the row instead of dropping the swap, and the
	* queued rows run the moment the lock frees. Without it — the operator's own
	* 轮换 — a busy mutex still answers false immediately, which is the
	* "busy, try again" the bridge reports.
	*
	* Returns true when a replacement was admitted. False also covers "no
	* onboarder yet" (no subscription round has run in this process).
	*/
	async replaceExit(exitId, options = {}) {
		if (this.#onboarder === null) return false;
		if (this.#replacing) {
			if (options.defer === true) this.#deferred.add(exitId);
			return false;
		}
		this.#replacing = true;
		try {
			return await this.#onboarder.replace(exitId);
		} catch (err) {
			this.#logger?.warn(`oc2dsh: replacing refused exit ${exitId} failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		} finally {
			this.#replacing = false;
			await this.#drainDeferred();
		}
	}
	/**
	* Run the swaps queued while the mutex was held. They take the same lock one
	* at a time, so a drain cannot stack sing-box rebuilds, and a row queued
	* again while the drain runs is picked up by the same loop.
	*/
	async #drainDeferred() {
		if (this.#draining || this.#replacing || this.#deferred.size === 0) return;
		this.#draining = true;
		try {
			while (this.#deferred.size > 0) {
				const exitId = this.#deferred.values().next().value;
				if (exitId === void 0) break;
				this.#deferred.delete(exitId);
				this.#logger?.info(`oc2dsh: rebuild lock freed; running the deferred swap of ${exitId}`);
				this.#replacing = true;
				try {
					await this.#onboarder?.replace(exitId);
				} catch (err) {
					this.#logger?.warn(`oc2dsh: deferred replacement of ${exitId} failed: ${err instanceof Error ? err.message : String(err)}`);
				} finally {
					this.#replacing = false;
				}
			}
		} finally {
			this.#draining = false;
		}
	}
	start() {
		if (this.#timer !== null || this.#stopped) return;
		this.refresh();
		this.#timer = setInterval(() => void this.refresh(), this.#intervalMs);
		this.#timer.unref?.();
	}
	stop() {
		this.#stopped = true;
		this.#deferred.clear();
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
			let failedFetches = 0;
			for (const url of this.#urls) try {
				const report = parseSubscription(await this.#fetch(url));
				for (const node of report.nodes) {
					if (!isDialableServer(node.server)) {
						unroutable.push(node);
						continue;
					}
					if (node.type === "http" || node.type === "socks5") plaintext.push({
						address: `${node.server.includes(":") ? `[${node.server}]` : node.server}:${node.port}`,
						protocol: node.type
					});
					else pending.push(node);
				}
				this.#logger?.info(`oc2dsh: subscription parsed ${report.nodes.length} node(s) (${report.detected}) from ${this.#redact(url)}`);
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
				failedFetches += 1;
				this.#logger?.warn(`oc2dsh: subscription fetch failed for ${this.#redact(url)}: ${lastError}`);
			}
			if (unroutable.length > 0) {
				const sample = unroutable.slice(0, 5).map((node) => `${node.type} ${node.server}:${node.port}`).join(", ");
				this.#logger?.warn(`oc2dsh: subscription carried ${unroutable.length} node(s) with an address that cannot be dialled from this machine; skipped (${sample}${unroutable.length > 5 ? ", …" : ""})`);
			}
			this.#state = {
				pendingConversion: pending,
				convertedAdmitted: 0,
				lastFetch: Date.now(),
				lastError,
				plaintextAdmitted: 0
			};
			if (pending.length > 0 && this.#supervisor && !this.#stopped) {
				const supervisor = this.#supervisor;
				try {
					const exits = await supervisor.reload(pending);
					if (this.#stopped) return this.state;
					const inherited = this.#onboarder?.addresses ?? [];
					const inheritedKeys = this.#onboarder?.identities ?? /* @__PURE__ */ new Map();
					const onboarder = new Onboarder({
						pool: this.#deps.pool,
						prober: this.#deps.prober,
						admission: this.#deps,
						select: (slots) => this.#stopped ? Promise.reject(/* @__PURE__ */ new Error("subscription layer stopped")) : supervisor.reload(pending, slots),
						logger: this.#logger
					});
					this.#onboarder = onboarder;
					const outcome = await onboarder.run(exits, inherited, inheritedKeys);
					this.#state.convertedAdmitted = outcome.admitted;
					this.#state.pendingConversion = [];
					this.#logger?.info(`oc2dsh: sing-box converted ${exits.length} encrypted node(s); onboarding kept ${outcome.online + outcome.admitted} of ${outcome.screened} screened (${outcome.admitted} admitted, ${outcome.promoted} promoted, ${outcome.demoted} demoted, ${outcome.reserve} reserve)`);
				} catch (err) {
					const text = err instanceof Error ? err.message : String(err);
					this.#state.lastError = text;
					this.#logger?.warn(`oc2dsh: sing-box conversion failed: ${text}`);
				}
			}
			if (this.#stopped) return this.state;
			if (failedFetches === 0) this.#prunePlaintext(new Set(plaintext.map((candidate) => candidate.address)));
			const tasks = plaintext.filter((candidate) => !this.#deps.pool.has(candidate.address)).map((candidate) => ({
				exitId: candidate.address,
				kind: "subscription-speed",
				run: async () => {
					const verdict = await admitBySpeed(this.#deps, {
						address: candidate.address,
						protocol: candidate.protocol,
						source: "subscription"
					});
					if (this.#stopped || !verdict.admitted || !verdict.node) return;
					if (this.#admitPlaintext(verdict.node, verdict.unverified === true)) this.#state.plaintextAdmitted += 1;
				}
			}));
			if (tasks.length > 0) await this.#deps.prober.enqueueAll(tasks);
			return this.state;
		} finally {
			this.#running = false;
		}
	}
	/**
	* One speed-tested plaintext node into the pool, under `poolSize`: a full pool
	* makes room only by evicting a row that ranks below it (pinned and manual
	* rows never leave). False when it did not get in.
	*/
	#admitPlaintext(node, unverified) {
		const pool = this.#deps.pool;
		if (!pool.has(node.id) && pool.isFull() && (unverified || pool.evictWorst(node) === null)) return false;
		if (!pool.add(node)) return false;
		if (unverified) pool.markUnverified(node.id);
		else pool.markOk(node.id);
		this.#plaintext.add(node.id);
		return true;
	}
	/** Drop plaintext rows this fetcher admitted that the subscription no longer lists. */
	#prunePlaintext(listed) {
		const dropped = [];
		for (const address of this.#plaintext) {
			if (listed.has(address)) continue;
			this.#plaintext.delete(address);
			if (this.#deps.pool.get(address)?.source !== "subscription") continue;
			this.#deps.pool.remove(address);
			dropped.push(address);
		}
		if (dropped.length > 0) this.#logger?.info(`oc2dsh: dropped ${dropped.length} plaintext exit(s) the subscription no longer lists (${dropped.join(", ")})`);
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
	return stateDir();
}
/**
* Which health mark one probe verdict earns: a verified pass marks the exit
* ok, a 429 marks it limited, and the trusted-source fallback — `admitted: true`
* without having reached the exit — must NOT claim health (markUnverified,
* docs/ip-pool.md §3.2). Exported so the mapping is testable without a network.
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
* Idempotent, and scoped to `source === 'manual'` rows (subscription rows are
* never touched). Runs at assembly AND on every live commit, so a
* 手填/固定主力 edit takes effect without a restart (docs §5.1).
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
	/**
	* `local` is the 本机 sentinel (the stats modal's 固定 button on the local
	* row): every request egresses from this machine. It is not an address, so
	* it must be answered before the manual-row path — parseManualProxy would
	* reject it and the pin would silently read as "nothing pinned".
	*/
	const pinnedLocal = requested === LOCAL_EXIT_ID;
	let pinned = "";
	if (requested !== "" && !pinnedLocal) {
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
	if (pinnedLocal) pool.pinLocal();
	else if (pinned === "") pool.unpin();
	else pool.pin(pinned);
}
/** Build the ExitPool from config (manual proxies + pinned). Manual rows are
*  vouched in as ok — the user asserts them (docs/ip-pool.md 3.1/4.5); every
*  other source's rows arrive later, filled in by real-request verdicts and
*  the card's probe actions. */
function buildPoolFromConfig(config) {
	const pool = new ExitPool();
	syncManualExits(pool, config.ipPool);
	return pool;
}
/**
* Assemble the routing stack. Returns null (with a logged reason) only when
* the host has no undici.
*
* The undici seam is imported once here and threaded to every layer. An empty
* pool does not stop the runtime from existing: the dispatcher is installed
* anyway, and 本地出口兜底 decides whether that empty pool means "fail" (the
* default) or "egress locally" (docs §3.3).
*/
async function startIpPool(config, logger, deps = {}) {
	const ipPool = config.ipPool ?? {};
	const pool = buildPoolFromConfig(config);
	let undici;
	if (deps.undici !== void 0) undici = deps.undici;
	else try {
		undici = await import("undici");
	} catch (err) {
		logger.warn(`oc2dsh: undici unavailable; exit routing disabled (${err instanceof Error ? err.message : String(err)})`);
		return null;
	}
	/**
	* The one judge of a transport cut, shared by both routing seams below (the
	* dispatcher's observer and the relay's settle callback). `cut` is
	* synchronous and answers later through the pool, so a teardown never waits
	* on a socket probe; see pool/transport.ts for what the four verdicts mean.
	*/
	const transportVerdicts = new TransportVerdicts({
		pool,
		detect: deps.detectProtocol ?? detectProxyProtocol,
		logger
	});
	const installerDeps = {
		pool,
		undici,
		proxyHosts: ipPool.proxyHosts,
		proxyPathPrefixes: ipPool.proxyPathPrefixes,
		localFallback: ipPool.localFallback === true,
		localIpFamily: resolveLocalIpFamily(ipPool.localIpFamily),
		onTransportCut: (exitId) => {
			transportVerdicts.cut(exitId);
		},
		logger
	};
	const installer = deps.makeInstaller !== void 0 ? deps.makeInstaller(installerDeps) : new (await (import("./installer.js"))).RoutingInstaller(installerDeps);
	const admissionDeps = {
		pool,
		undici,
		logger,
		smokeModel: (ipPool.probeModels ?? [])[0],
		smokeContents: ipPool.probeContents ?? [],
		...deps.relayBaseUrl !== void 0 ? { relayBaseUrl: deps.relayBaseUrl } : {}
	};
	const probeModels = ipPool.probeModels ?? [];
	/** The probe-model list in force: the configured set, or the S3 default. */
	const probeModelsOrDefault = () => probeModels.length > 0 ? probeModels : ["big-pickle"];
	const probeContents = ipPool.probeContents ?? [];
	const prober = new Prober({
		pool,
		maxConcurrentProbes: ipPool.maxConcurrentProbes ?? 3
	});
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
	/**
	* Tear the subscription layer down (no URLs left, or the pool switched off):
	* no more fetches, sing-box stopped, and the rows it fed leave the table,
	* because nothing serves their listeners any more. Enabling again (or adding
	* a URL) builds a fresh fetcher.
	*/
	const stopSubscriptions = () => {
		if (subscriptions === null) return;
		subscriptions.stop();
		subscriptions = null;
		fetcherActive = false;
		for (const node of pool.list()) if (node.source === "subscription") pool.remove(node.id);
	};
	const ensureSubscriptions = (urls) => {
		if (urls.length === 0 || config.ipPool?.enabled === false) {
			stopSubscriptions();
			return null;
		}
		if (subscriptions === null) subscriptions = new SubscriptionFetcher({
			...admissionDeps,
			prober,
			supervisor: ensureSupervisor()
		}, { logger });
		subscriptions.setUrls(urls);
		return subscriptions;
	};
	/** What relay traffic carries when this machine egresses (本机出口协议族). */
	let localDecision = null;
	/** Apply the config to the live objects (initial start + reconfigure). */
	const applyConfig = () => {
		const current = config.ipPool ?? {};
		syncManualExits(pool, current);
		pool.setPoolSize(current.poolSize ?? 10);
		admissionDeps.smokeModel = probeModels[0];
		admissionDeps.smokeContents = probeContents;
		prober.setMaxConcurrent(current.maxConcurrentProbes ?? 3);
		installer.setProxyHosts?.(current.proxyHosts);
		installer.setProxyPathPrefixes?.(current.proxyPathPrefixes);
		installer.setLocalFallback?.(current.localFallback === true);
		installer.setLocalIpFamily?.(resolveLocalIpFamily(current.localIpFamily));
		const relayFamily = relayDirectFamily(resolveLocalIpFamily(current.localIpFamily));
		localDecision = relayFamily === null ? null : { directive: directEgressDirective(relayFamily) };
		const fetcher = ensureSubscriptions(current.subscriptions ?? []);
		if (fetcher !== null) {
			fetcher.setSupervisor(ensureSupervisor());
			fetcher.setIntervalMs(current.subscription?.refreshMs ?? 30 * 6e4);
			fetcher.setUserAgent(current.subscription?.userAgent);
			if (fetcher === subscriptions && !fetcherActive) {
				fetcher.start();
				fetcherActive = true;
			}
			if (pool.snapshot().total > pool.poolSize) fetcher.enforceCapacity().catch(() => {});
		}
	};
	let fetcherActive = false;
	/**
	* Engage routing while the pool is enabled.
	*
	* The dispatcher is installed even with an EMPTY pool: 本地出口兜底 decides
	* what an empty pool means (fail closed by default, direct when the
	* operator switched the fallback on), and an uninstalled dispatcher would
	* always mean "direct" — this machine's IP on the wire during exactly the
	* window the pool has nothing to offer. Each admission re-attempts install,
	* so a foreign dispatcher's unload (R1 deferral) is picked up without a
	* restart.
	*/
	const engageRouting = () => {
		if (config.ipPool?.enabled === false) return;
		if (installer.enabled && installer.routingInForce?.() !== false) return;
		const wasEnabled = installer.enabled;
		installer.install();
		if (!wasEnabled && installer.enabled) logger.info("oc2dsh: exit routing engaged (live)");
	};
	pool.onAdmitted(engageRouting);
	/**
	* A dead exit must not just sit in the table: the subscription layer swaps
	* it for the next-fastest reserve and, when the reserve is exhausted, parks
	* it at the pool tail — the pool holds its size either way (docs §4.7).
	* A rebuild holding the lock queues the swap instead of dropping it, so the
	* row is still exchanged once the lock frees.
	* Only subscription exits rotate: manual/pinned rows are explicit user
	* config.
	*/
	pool.onDead((id) => {
		if (config.ipPool?.enabled === false) return;
		if (pool.get(id)?.source !== "subscription") return;
		subscriptions?.replaceExit(id, { defer: true }).catch(() => {});
	});
	installer.install();
	if (pool.snapshot().total === 0) logger.warn(ipPool.localFallback === true ? "oc2dsh: ipPool enabled but the pool is empty; staying direct until exits land (本地出口兜底 on)" : "oc2dsh: ipPool enabled but the pool is empty; requests fail until an exit is admitted (本地出口兜底 off)");
	applyConfig();
	/**
	* One exit's probe pass, shared by every trigger (manual 批量探活 / 单出口 /
	* the enable-flip kick below) so the paths can never drift apart.
	*/
	const probeOne = async (entry, models) => {
		const { admitTrusted } = await import("./admission2.js");
		const deps$1 = {
			...admissionDeps,
			smokeContent: pickSmokeContent(probeContents)
		};
		for (const model of models) {
			deps$1.smokeModel = model;
			const verdict = await admitTrusted(deps$1, {
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
				if (!pool.refresh(entry.id, {
					protocol: verdict.node.protocol,
					exitIP: verdict.node.exitIP,
					exitLocation: verdict.node.exitLocation,
					latencyMs: verdict.node.latencyMs,
					quality: verdict.node.quality
				})) break;
				applyProbeVerdict(pool, entry.id, verdict, model);
				if (verdict.unverified === true && entry.source === "subscription") subscriptions?.replaceExit(entry.id, { defer: true }).catch(() => {});
			} else {
				pool.markDeadStrike(entry.id);
				break;
			}
		}
	};
	const probeAll = async () => {
		const models = probeModelsOrDefault();
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
		run: () => probeOne(entry, [...probeModelsOrDefault()])
	});
	const probeExit = async (exitId) => {
		const entry = pool.list().find((node) => node.id === exitId);
		if (!entry) return 0;
		await prober.enqueue(probeExitTask(exitId, entry));
		return 1;
	};
	setRotateDelegate(createRotateDelegate(pool, { maxAttempts: config.ipPool?.maxRotateAttempts ?? 3 }));
	/**
	* A pin the rotation had to skip, said out loud — once per outage.
	*
	* Falling through is CORRECT (a pin is a preference: `pinnedStrict` is the
	* card's promise about rotating on failure, and this is that failure), so
	* this only adds the missing visibility: one line per outage, carrying the
	* row's own reason, so the log answers "why is my pin not being used".
	*/
	const pinSkips = /* @__PURE__ */ new Set();
	pool.onPinnedSkip((pinned, used) => {
		if (pinSkips.has(pinned)) return;
		const row = pool.list().find((entry) => entry.id === pinned);
		if (row === void 0) return;
		const health = row.health;
		const waitMs = Math.max(0, health.cooldownUntil - Date.now());
		const why = health.state === "dead" ? "已判 dead" : waitMs > 0 ? `冷却中（还有 ${Math.ceil(waitMs / 1e3)}s）` : health.note === "abusive" ? `被上游按 IP 拒绝（${health.note}）` : "当前不可用";
		pinSkips.add(pinned);
		logger.warn(`oc2dsh: 固定出口 ${pinned} ${why}；本次请求改走 ${used}（修好或重新固定后自动回到它）`);
	});
	/**
	* Relay-traffic egress seams (src/relay/egress.ts).
	*
	* While the Bun relay carries chat requests no dispatch reaches the routing
	* dispatcher — the request is addressed at loopback and the relay opens the
	* upstream connection — so these two callbacks keep the pool's two jobs,
	* instead of everything silently egressing locally:
	*
	*   pick  -> the same pool.pick(session, model) the dispatcher calls, so
	*            pinning, stickiness and two-tier health still decide; the
	*            answer travels to the relay in a header it strips before the
	*            upstream sees anything.
	*   settle-> the verdict table the dispatcher's observer applies to a real
	*            status code: a bad status degrades the exit and breaks the
	*            session binding, a transport cut goes to pool/transport.ts,
	*            which can tell a mislabelled listener from a dead line.
	*
	* An empty pool keeps its documented meaning: 本地出口兜底 decides between a
	* direct egress and a refusal, and a refusal is returned as `fail` so the
	* adapter can surface it (the dispatcher's #failClosed parity) rather than
	* quietly putting this machine's address on the wire.
	*/
	setRelayEgressSeams({
		pick: ({ model, session }) => {
			if (config.ipPool?.enabled === false) return null;
			const exitId = pool.pick(session, model);
			const exit = exitId === null ? void 0 : pool.get(exitId);
			if (exitId === null || exit === void 0) return mayEgressLocally(pool, config.ipPool?.localFallback === true) ? localDecision : { fail: NO_EXIT_MESSAGE };
			pinSkips.delete(exitId);
			pool.beginRequest(exitId);
			return {
				exitId,
				model,
				session,
				url: exitProxyUri(exit.id, exit.protocol)
			};
		},
		settle: (pick, outcome) => {
			try {
				if (outcome.transport === true) settleTransport(pool, pick, (exitId) => {
					transportVerdicts.cut(exitId);
				});
				else if (outcome.status !== void 0) settleStatus(pool, pick, outcome.status);
			} finally {
				pool.endRequest(pick.exitId);
			}
		}
	});
	return {
		pool,
		installer,
		prober,
		singboxState: () => supervisor === void 0 ? null : { running: supervisor.running },
		get subscriptions() {
			return subscriptions;
		},
		async reconfigure(next) {
			const wasEnabled = config.ipPool?.enabled !== false;
			config.ipPool = next.ipPool;
			probeModels.length = 0;
			probeModels.push(...next.ipPool?.probeModels ?? []);
			probeContents.length = 0;
			probeContents.push(...next.ipPool?.probeContents ?? []);
			const enable = next.ipPool?.enabled !== false;
			applyConfig();
			setRotateDelegate(createRotateDelegate(pool, { maxAttempts: next.ipPool?.maxRotateAttempts ?? 3 }));
			if (enable) {
				const recovered = !installer.enabled;
				installer.install();
				if (recovered && installer.enabled) logger.info("oc2dsh: exit routing recovered — the dispatcher slot is usable again (R1)");
			} else if (installer.enabled) installer.disable();
			if (wasEnabled !== enable) {
				logger.info(`oc2dsh: ip pool ${enable ? "enabled" : "disabled"} via settings (live)`);
				if (enable) probeAll().catch(() => {});
			}
		},
		probeAll,
		probeExit,
		async refreshSubscriptions() {
			await subscriptions?.refreshNow();
		},
		async dispose() {
			setRotateDelegate(null);
			setRelayEgressSeams(null);
			subscriptions?.stop();
			installer.dispose();
		}
	};
}

//#endregion
export { applyProbeVerdict, buildPoolFromConfig, parseManualProxy, startIpPool, syncManualExits };