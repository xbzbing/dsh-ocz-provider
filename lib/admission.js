import { d as canonicalSessionID, g as opencodeUserAgent, h as mintedMessageID, m as disguiseHeaders, r as ZEN_BASE_URL, u as DEFAULT_PROJECT_ID } from "./catalog.js";
import { i as FREE_LANE_GATE_TOOL_NAMES, o as freeLaneGateTool, r as pickSmokeContent } from "./smoke-content.js";
import { c as LOCAL_EXIT_ID, r as exitProxyUri } from "./dispatcher.js";

//#region src/pool/pool.ts
/** Quality grade from admission latency (GoProxy thresholds). */
function gradeOf(latencyMs) {
	if (latencyMs <= 500) return "S";
	if (latencyMs <= 1e3) return "A";
	if (latencyMs <= 2e3) return "B";
	return "C";
}
/**
* Grade for an exit that was never measured. gradeOf(0) returns 'S' (a 0ms
* admission), so the trusted-admission fallback — which carries `latencyMs: 0`
* because the probe produced no facts — used to hand the BEST grade to the
* WORST exits, and the picker sorts by grade. An unmeasured exit ranks last
* until a probe actually measures it.
*/
const UNVERIFIED_QUALITY = "C";
/** Quality rank for worst-first eviction (lower grade = keep longer). */
const GRADE_RANK = {
	S: 0,
	A: 1,
	B: 2,
	C: 3
};
const banKey = (exitId, model) => `${exitId}\u0000${model}`;
var ExitPool = class {
	#nodes = /* @__PURE__ */ new Map();
	#health = /* @__PURE__ */ new Map();
	#bans = /* @__PURE__ */ new Map();
	#sessionExit = /* @__PURE__ */ new Map();
	/** Passive-signal counters per exit (docs/ip-pool.md §4.3 被动 + IP-6 stats). */
	#passive = /* @__PURE__ */ new Map();
	/** Live-request activity per exit: last dispatch stamp + in-flight count
	*  (exit-stats surface — "which exit is being used right now"). */
	#activity = /* @__PURE__ */ new Map();
	/** Pool-host requests that fell back to a direct connection (empty pool /
	*  missing proxy agent) — the honest 直连兜底 count for the stats modal. */
	#directRequests = 0;
	/** Fired once per newly added node — see onAdmitted(). */
	#admittedCallbacks = [];
	/** Fired when an exit transitions to dead — see onDead(). */
	#deadCallbacks = [];
	/**
	* Exits rejected by the upstream lane (a failed OpenCode smoke, or a 401/403
	* verdict) with no reserve left to promote: they stay in the pool as the last
	* resort but are ranked last by `pick()` and listed last by `list()` — the
	* pool keeps its size instead of draining to zero (live request 2026-10-13).
	*/
	#demoted = /* @__PURE__ */ new Set();
	#targetSize;
	#poolSize;
	#cooldownBase;
	#cooldownMax;
	#banConfirmations;
	#deadEvictions;
	#now;
	constructor(options = {}) {
		this.#targetSize = options.targetSize ?? 20;
		this.#poolSize = options.poolSize ?? 10;
		this.#cooldownBase = options.limitedCooldownBaseMs ?? 6e4;
		this.#cooldownMax = options.limitedCooldownMaxMs ?? 30 * 6e4;
		this.#banConfirmations = options.modelBanConfirmations ?? 2;
		this.#deadEvictions = options.deadEvictions ?? 2;
		this.#now = options.now ?? Date.now;
	}
	/** Live re-apply of the whole-pool capacity (settings page, §5.1). */
	setPoolSize(value) {
		this.#poolSize = Math.max(1, value);
	}
	/** The effective whole-pool capacity (diagnostics / status bridge). */
	get poolSize() {
		return this.#poolSize;
	}
	/** Is the pool at capacity? Callers admit only after this returns false. */
	isFull() {
		return this.#nodes.size >= this.#poolSize;
	}
	/** Is this exit demoted to the tail (rejected, no reserve to promote)? */
	demoted(id) {
		return this.#demoted.has(id);
	}
	/**
	* Move an exit to the tail of the pool's own order: keep it (it may still
	* serve another model, or recover) but let `pick()` rank it last and the exit
	* table list it last. `add()`'s Map insertion order IS the pool order, so a
	* delete + re-insert is the whole move — every side table (health, bans,
	* passive counters, activity) is keyed by id and survives untouched.
	*/
	demoteToTail(id) {
		if (!this.#moveToTail(id)) return false;
		this.#demoted.add(id);
		return true;
	}
	/** The reorder half of demoteToTail, without the last-resort flag: a dead
	*  exit sinks to the end of the table but recovers straight back into the
	*  ranked set once a probe verifies it (`markOk` clears `#demoted` only). */
	#moveToTail(id) {
		const node = this.#nodes.get(id);
		if (node === void 0) return false;
		this.#nodes.delete(id);
		this.#nodes.set(id, node);
		return true;
	}
	/** Is this exit currently `dead` (transport failure / failed probe)? */
	isDead(id) {
		return this.#health.get(id)?.state === "dead";
	}
	/**
	* Evict the worst exit to make room for a better candidate (whole pool, any
	* source, pinned never). Worst = lowest quality grade, then slowest, then
	* oldest — the same ordering `evictWorstFree()` uses, minus the source filter.
	* Returns the evicted id (null when nothing can be evicted), because the
	* caller has to close that exit's local listener too — see `Onboarder.trim()`.
	*/
	evictWorst() {
		let worst = null;
		for (const node of this.#nodes.values()) {
			if (node.pinned) continue;
			if (worst === null) {
				worst = node;
				continue;
			}
			const byGrade = GRADE_RANK[node.quality] - GRADE_RANK[worst.quality];
			const byLatency = node.latencyMs - worst.latencyMs;
			if (byGrade > 0 || byGrade === 0 && byLatency > 0 || byGrade === 0 && byLatency === 0 && node.addedAt < worst.addedAt) worst = node;
		}
		if (worst === null) return null;
		this.remove(worst.id);
		return worst.id;
	}
	/** Live re-apply of the free-pool target capacity (settings page, §5.1). */
	setTargetSize(value) {
		this.#targetSize = Math.max(1, value);
	}
	/** The effective target capacity (diagnostics / status bridge). */
	get targetSize() {
		return this.#targetSize;
	}
	/**
	* Register a callback fired after every node newly added to the pool.
	*
	* The runtime assembly uses it to engage routing the moment a pool that
	* assembled EMPTY stops being empty. The free-source refill loop had its own
	* hook for that (live-observed 2026-09-09 on a free-only pool), but the
	* subscription path had none — a subscription-only profile (free disabled)
	* assembled empty, filled up minutes later, and never installed the
	* dispatcher, so the pool reported "enabled" while every request kept going
	* direct (live-observed 2026-10-12). This hook is source-agnostic: free,
	* subscription and manual admissions all reach it through add().
	*/
	onAdmitted(callback) {
		this.#admittedCallbacks.push(callback);
	}
	/** A watcher's failure must never fail an admission. */
	#notifyAdmitted() {
		for (const callback of this.#admittedCallbacks) try {
			callback();
		} catch {}
	}
	/**
	* Register a callback fired when an exit TRANSITIONS to `dead` (once per
	* transition, not once per strike). The runtime uses it to rotate: the
	* subscription layer swaps the dead exit for the next-fastest reserve, or
	* parks it at the pool tail when no reserve is left (live request
	* 2026-10-14 — "其余 dead 自动轮换").
	*/
	onDead(callback) {
		this.#deadCallbacks.push(callback);
	}
	/** A watcher's failure must never fail the strike bookkeeping. */
	#notifyDead(id) {
		for (const callback of this.#deadCallbacks) try {
			callback(id);
		} catch {}
	}
	/**
	* Refresh one row's measured facts IN PLACE. Returns false when the row is
	* no longer in the table.
	*
	* A probe holds an `entry` snapshot taken before it ran, and the exit can
	* leave the table while the probe is in flight (a dead rotation, a refusal
	* replacement, an operator's 删除). `add()` is an upsert, so writing that
	* snapshot back RESURRECTS the removed row — and a resurrected row has no
	* local listener, while `isUsable()` still hands it out as the last resort.
	* Measured live 2026-10-14: 11 rows against a capacity of 10, the extra one
	* demoted, unverified and listenerless. Facts for a row that left the table
	* are dropped instead: the probe measured an exit the pool already gave up on.
	*
	* Only the admission-measured fields are writable here — identity, source and
	* the pin flag belong to whoever put the row in the table.
	*/
	refresh(id, facts) {
		const node = this.#nodes.get(id);
		if (node === void 0) return false;
		if (facts.protocol !== void 0) node.protocol = facts.protocol;
		if (facts.exitIP !== void 0) node.exitIP = facts.exitIP;
		if (facts.exitLocation !== void 0) node.exitLocation = facts.exitLocation;
		if (facts.latencyMs !== void 0) node.latencyMs = facts.latencyMs;
		if (facts.quality !== void 0) node.quality = facts.quality;
		return true;
	}
	/** Upsert a node (admission wrote its details); returns false on duplicate
	*  exit IP for a different address — two addresses sharing one exit IP are
	*  one quota bucket and must not both live in the pool (3.1). */
	add(node) {
		if (node.exitIP !== "" && this.#hasExitIP(node.exitIP, node.id)) return false;
		const isNew = !this.#nodes.has(node.id);
		this.#nodes.set(node.id, node);
		if (!this.#health.has(node.id)) this.#health.set(node.id, {
			state: "unknown",
			lastProbedAt: 0,
			consecutiveLimited: 0,
			cooldownUntil: 0,
			inflight: false,
			deadStrikes: 0,
			deadAt: 0
		});
		if (isNew) this.#notifyAdmitted();
		return true;
	}
	#hasExitIP(exitIP, exceptId) {
		for (const node of this.#nodes.values()) if (node.id !== exceptId && node.exitIP === exitIP) return true;
		return false;
	}
	has(id) {
		return this.#nodes.has(id);
	}
	get(id) {
		return this.#nodes.get(id);
	}
	/** Drop a node entirely (dead eviction for free nodes, cleanup otherwise). */
	remove(id) {
		this.#nodes.delete(id);
		this.#health.delete(id);
		this.#passive.delete(id);
		this.#activity.delete(id);
		this.#demoted.delete(id);
		for (const key of this.#bans.keys()) if (key.startsWith(`${id}\u0000`)) this.#bans.delete(key);
		for (const [session, exitId] of this.#sessionExit) if (exitId === id) this.#sessionExit.delete(session);
		this.#clearPinnedIf(id);
	}
	/** Disable without dropping (dead manual/subscription/goproxy nodes, 3.5). */
	markDead(id) {
		const health = this.#health.get(id);
		if (!health) return;
		const wasDead = health.state === "dead";
		health.state = "dead";
		health.inflight = false;
		if (!wasDead) {
			this.#moveToTail(id);
			this.#notifyDead(id);
		}
	}
	/**
	* A probe could not verify this exit (trusted-source admission fallback):
	* keep the node — a subscription line is paid and `admission.admitTrusted`
	* promises to revisit it — but drop its `ok` claim, so it leaves the
	* verified tier that `pick()` ranks first.
	*
	* 'unknown' is still *usable* (`#isAvailable` only hides 'dead'), which is
	* deliberate: a probe-side failure (Zen rejecting the smoke request, an
	* echo endpoint hiccup) must not empty a healthy pool. It only means an
	* exit that was never measured no longer outranks one that was.
	*/
	markUnverified(id) {
		const health = this.#health.get(id);
		if (!health) return;
		health.state = "unknown";
		health.inflight = false;
	}
	#clearPinnedIf(id) {
		if (this.pinnedId === id) this.pinnedId = "";
	}
	pinnedId = "";
	/** Pin a node (docs/ip-pool.md 3.6); unpinning any previous pinned node.
	*  The row-level `pinned` flag is kept in step here so a stale flag can
	*  never keep routing a row down the pinned admission path after a
	*  hot-reconfigure unpinned it (the flag is read by probeOne). */
	pin(id) {
		const target = this.#nodes.get(id);
		if (target === void 0) return false;
		this.pinnedId = id;
		for (const node of this.#nodes.values()) node.pinned = node === target;
		return true;
	}
	unpin() {
		this.pinnedId = "";
		for (const node of this.#nodes.values()) node.pinned = false;
	}
	/**
	* Pin every request to THIS machine: the 本机 row's 固定 button
	* (live request 2026-10-14). The sentinel is {@link LOCAL_EXIT_ID}, which
	* can never collide with a real exit id (those are `host:port` or
	* `scheme://host:port`), so `pick()` can tell "no exit at all" from "the
	* pinned exit is unusable" and return null instead of falling through to
	* the rotation pool. Traffic then egresses locally — the same path a pool
	* with no usable exit takes (3.3 never fails closed).
	*
	* No row carries the `pinned` flag here: there is no primary exit, and
	* leaving a stale flag behind would keep routing a row down the pinned
	* admission path after the switch (the same trap `pin()` documents).
	*/
	pinLocal() {
		this.pinnedId = LOCAL_EXIT_ID;
		for (const node of this.#nodes.values()) node.pinned = false;
	}
	/** Whether the pin is currently the local-egress sentinel (status view). */
	get pinnedLocal() {
		return this.pinnedId === LOCAL_EXIT_ID;
	}
	/** Try to take the exit's serial-probe slot; false when already taken. */
	takeProbeLock(id) {
		const health = this.#health.get(id);
		if (!health || health.inflight) return false;
		health.inflight = true;
		return true;
	}
	releaseProbeLock(id) {
		const health = this.#health.get(id);
		if (health) health.inflight = false;
	}
	markOk(id, model) {
		const health = this.#health.get(id);
		if (health) {
			health.state = "ok";
			health.lastProbedAt = this.#now();
			health.consecutiveLimited = 0;
			health.cooldownUntil = 0;
			health.deadStrikes = 0;
			health.deadAt = 0;
		}
		this.#demoted.delete(id);
		if (model !== void 0) this.#bans.set(banKey(id, model), {
			state: "ok",
			bannedAt: 0,
			consecutiveFailures: 0
		});
	}
	/** 429: exit-level cooldown with exponential backoff (3.2 / 4.6). */
	markLimited(id) {
		const health = this.#health.get(id);
		if (!health) return 0;
		health.consecutiveLimited += 1;
		health.state = "ok";
		const backoff = Math.min(this.#cooldownBase * 2 ** (health.consecutiveLimited - 1), this.#cooldownMax);
		health.cooldownUntil = this.#now() + backoff;
		return health.cooldownUntil;
	}
	/** Deterministic refusal (upstream RegionError: region blocks are a
	*  property of the exit, not transient noise) — ban the pairing at once. */
	markModelBanned(id, model) {
		this.#bans.set(banKey(id, model), {
			state: "banned",
			bannedAt: this.#now(),
			consecutiveFailures: this.#banConfirmations
		});
	}
	/** 401/403: model-level suspicion; banned after N consecutive (3.2). */
	markModelSignal(id, model) {
		const key = banKey(id, model);
		const current = this.#bans.get(key) ?? {
			state: "ok",
			bannedAt: 0,
			consecutiveFailures: 0
		};
		current.consecutiveFailures += 1;
		if (current.consecutiveFailures >= this.#banConfirmations && current.state !== "banned") {
			current.state = "banned";
			current.bannedAt = this.#now();
		} else if (current.state !== "banned") current.state = "suspect";
		this.#bans.set(key, current);
		return current.state;
	}
	/** Transport failure / 5xx / probe timeout: dead, with free-source eviction
	*  after repeated strikes (3.5). Returns true when the node was evicted. */
	markDeadStrike(id) {
		const node = this.#nodes.get(id);
		const health = this.#health.get(id);
		if (!node || !health) return false;
		const wasDead = health.state === "dead";
		health.state = "dead";
		health.inflight = false;
		health.deadStrikes += 1;
		health.deadAt = this.#now();
		if (!wasDead) {
			this.#moveToTail(id);
			this.#notifyDead(id);
		}
		if (node.source === "free" && health.deadStrikes >= this.#deadEvictions) {
			this.remove(id);
			return true;
		}
		return false;
	}
	/** Death from a mid-flight stream (no retry path): same strike accounting. */
	markStreamFailure(id, kind, model) {
		if (kind === "429") {
			this.markLimited(id);
			this.#countPassive(id, "limited");
		} else if (model !== void 0) {
			this.markModelSignal(id, model);
			this.#countPassive(id, "refused");
		}
	}
	/**
	* Passive signal from a REAL request outcome (docs/ip-pool.md §4.2 rule
	* table, §4.3 被动 row): one response header read at the routing layer,
	* applied to the two-tier health exactly like a probe would. Returns the
	* classification for diagnostics.
	*/
	recordPassive(id, statusCode, model, regionBlocked = false) {
		if (!this.#nodes.has(id)) return "ok";
		if (statusCode >= 200 && statusCode < 300) {
			this.markOk(id, model);
			this.#countPassive(id, "ok");
			return "ok";
		}
		if (statusCode === 429) {
			this.markLimited(id);
			this.#countPassive(id, "limited");
			return "limited";
		}
		if (statusCode === 401 || statusCode === 403) {
			if (regionBlocked) this.markModelBanned(id, model);
			else this.markModelSignal(id, model);
			this.#countPassive(id, "refused");
			return "refused";
		}
		this.#countPassive(id, "dead");
		return "dead";
	}
	/** Transport-level failure of a real request (connection died mid-flight). */
	recordPassiveTransport(id) {
		if (!this.#nodes.has(id)) return;
		this.markDeadStrike(id);
		this.#countPassive(id, "transport");
	}
	/** Drop the session's sticky exit when its exit degraded (§3.3). */
	rerouteSession(session) {
		this.#sessionExit.delete(session);
	}
	/**
	* Exits due for a periodic probe (docs §4.3 周期 + §4.6 deadRetryMs): dead
	* exits past their retry budget, cooling exits whose window expired, exits
	* never probed, and anything past the periodic cadence. Pure read — the
	* caller owns the clock, the timer and the enqueueing.
	*
	* This is the counterpart that keeps a dead strike survivable: `isUsable()`
	* hides dead exits from `pick()` entirely, so nothing passive can ever call
	* markOk() on one. Without a due list a single false-positive strike retired
	* an exit for the life of the process.
	*/
	dueForProbe(now, options) {
		const due = [];
		for (const [id, health] of this.#health) {
			if (health.inflight) continue;
			if (health.state === "dead") {
				if (health.deadAt !== 0 && now - health.deadAt < options.deadRetryMs) continue;
			} else if (health.cooldownUntil > now) continue;
			else if (health.lastProbedAt !== 0 && now - health.lastProbedAt < options.intervalMs) continue;
			due.push(id);
		}
		return due;
	}
	/** The session's current sticky exit, if any (adapter-side 403 bookkeeping:
	*  the dispatcher recorded the refusal against this exit). */
	exitOfSession(session) {
		return this.#sessionExit.get(session) ?? null;
	}
	#countPassive(id, kind) {
		const bucket = this.#passive.get(id) ?? {
			ok: 0,
			limited: 0,
			refused: 0,
			dead: 0,
			transport: 0
		};
		bucket[kind] += 1;
		this.#passive.set(id, bucket);
	}
	/** Passive-signal counters for one exit (status bridge, IP-6). */
	passiveStats(id) {
		return { ...this.#passive.get(id) ?? {
			ok: 0,
			limited: 0,
			refused: 0,
			dead: 0,
			transport: 0
		} };
	}
	/**
	* Book one dispatched request against this exit: stamps last-used with the
	* pool clock and increments in-flight until endRequest lands. Called by the
	* routing dispatcher at pick() — the moment "which exit is serving this"
	* becomes known (exit-stats surface).
	*/
	beginRequest(id) {
		const slot = this.#activity.get(id) ?? {
			lastUsedAt: 0,
			inFlight: 0
		};
		slot.lastUsedAt = this.#now();
		slot.inFlight += 1;
		this.#activity.set(id, slot);
	}
	/** Terminal callback for a begun request; floors at zero on a double end
	*  (the observer can end from both the response path and the sentinel). */
	endRequest(id) {
		const slot = this.#activity.get(id);
		if (slot !== void 0 && slot.inFlight > 0) slot.inFlight -= 1;
	}
	/** Activity row for one exit (status bridge); zeros when never dispatched. */
	activity(id) {
		const slot = this.#activity.get(id);
		return slot === void 0 ? {
			lastUsedAt: 0,
			inFlight: 0
		} : { ...slot };
	}
	/** Count one pool-host request that fell back to a direct connection. */
	recordDirectRequest() {
		this.#directRequests += 1;
	}
	/** Total direct-fallback requests since process start (status bridge). */
	get directRequests() {
		return this.#directRequests;
	}
	isUsable(id, model) {
		const health = this.#health.get(id);
		if (!health || health.state === "dead") return false;
		if (health.cooldownUntil > this.#now()) return false;
		return this.#bans.get(banKey(id, model))?.state !== "banned";
	}
	/**
	* Pick the exit for one upstream request. Pinned wins while usable (3.6);
	* the rotation pool then prefers session stickiness, health, fewer
	* cooldowns and lower latency with a same-tier shuffle. Pure; no IO.
	*
	* A pin to the local sentinel is answered BEFORE the rotation: "固定本机"
	* means every request egresses from this machine, so falling through to the
	* pool would silently ignore the operator's click. Null is the dispatcher's
	* documented direct path (3.3), not an error.
	*/
	pick(session, model) {
		if (this.pinnedId === LOCAL_EXIT_ID) return null;
		if (this.pinnedId !== "" && this.isUsable(this.pinnedId, model)) return this.pinnedId;
		const last = this.#sessionExit.get(session);
		if (last !== void 0 && this.isUsable(last, model)) return last;
		const usable = [...this.#nodes.keys()].filter((id) => this.isUsable(id, model));
		if (usable.length === 0) return null;
		const health = (id) => this.#health.get(id);
		const node = (id) => this.#nodes.get(id);
		usable.sort((left, right) => {
			const a = health(left);
			const b = health(right);
			const byDemoted = (this.#demoted.has(left) ? 1 : 0) - (this.#demoted.has(right) ? 1 : 0);
			if (byDemoted !== 0) return byDemoted;
			const stateRank = (h) => h.state === "ok" ? 0 : 1;
			const byState = stateRank(a) - stateRank(b);
			if (byState !== 0) return byState;
			const byLimited = a.consecutiveLimited - b.consecutiveLimited;
			if (byLimited !== 0) return byLimited;
			const byLatency = node(left).latencyMs - node(right).latencyMs;
			if (byLatency !== 0) return byLatency;
			return Math.random() < .5 ? -1 : 1;
		});
		const chosen = usable[0];
		if (chosen === void 0) return null;
		this.#sessionExit.set(session, chosen);
		return chosen;
	}
	/** Drop the session's sticky exit (cooldown/dead/ban broke it). */
	breakStickySession(session) {
		this.#sessionExit.delete(session);
	}
	/** Usable = not dead, not cooling, and not banned for every probe model —
	*  approximation: nodes banned for all their known models count as
	*  unusable; with no ban data they stay usable (they are only banned for
	*  specific models, which the caller's model already filters). */
	#isAvailable(id) {
		const health = this.#health.get(id);
		if (!health || health.state === "dead") return false;
		if (health.cooldownUntil > this.#now()) return false;
		const nodeModels = /* @__PURE__ */ new Set();
		let allBanned = true;
		let sawBan = false;
		for (const [key, ban] of this.#bans) {
			if (!key.startsWith(`${id}\u0000`)) continue;
			const model = key.slice(id.length + 1);
			nodeModels.add(model);
			if (ban.state !== "banned") allBanned = false;
			else sawBan = true;
		}
		if (sawBan && nodeModels.size > 0 && allBanned) return false;
		return true;
	}
	/** Count usable free-source nodes toward the refill thresholds. */
	availableFreeCount() {
		let count = 0;
		for (const node of this.#nodes.values()) if (node.source === "free" && this.#isAvailable(node.id)) count += 1;
		return count;
	}
	/** Determine the pool state over the free-source pool (3.5 thresholds). */
	state() {
		if (this.#targetSize <= 0) return "healthy";
		const ratio = this.availableFreeCount() / this.#targetSize;
		if (ratio < .1) return "emergency";
		if (ratio < .3) return "critical";
		if (ratio < .95) return "warning";
		return "healthy";
	}
	/** Admission quota for a refill round: how many free nodes to accept.
	*  Bounded by BOTH the free target and the whole-pool capacity, so a free
	*  refill can never push the pool past `poolSize` (settings §5.1). */
	admissionQuota() {
		const freeRoom = Math.max(0, this.#targetSize - this.availableFreeCount());
		const poolRoom = Math.max(0, this.#poolSize - this.#nodes.size);
		return Math.min(freeRoom, poolRoom);
	}
	/** Replace the worst free node (C grade / oldest) to make room (3.5). */
	evictWorstFree() {
		let worst = null;
		for (const node of this.#nodes.values()) {
			if (node.source !== "free") continue;
			if (!worst) {
				worst = node;
				continue;
			}
			const byGrade = GRADE_RANK[node.quality] - GRADE_RANK[worst.quality];
			if (byGrade > 0 || byGrade === 0 && node.addedAt < worst.addedAt) worst = node;
		}
		if (!worst) return false;
		this.remove(worst.id);
		return true;
	}
	/** Is the pool full for free-source admission? (pinned and non-free nodes
	*  never count against the target, 3.5/3.6.) */
	isFreeFull() {
		return this.freeCount() >= this.#targetSize;
	}
	freeCount() {
		let count = 0;
		for (const node of this.#nodes.values()) if (node.source === "free") count += 1;
		return count;
	}
	snapshot() {
		const bySource = {
			free: 0,
			manual: 0,
			subscription: 0,
			goproxy: 0
		};
		for (const node of this.#nodes.values()) bySource[node.source] += 1;
		return {
			state: this.state(),
			total: this.#nodes.size,
			bySource,
			availableFree: this.availableFreeCount(),
			pinned: this.pinnedId
		};
	}
	list() {
		const out = [];
		for (const [id, node] of this.#nodes) {
			const health = this.#health.get(id);
			const bans = [];
			for (const [key, ban] of this.#bans) if (key.startsWith(`${id}\u0000`)) bans.push({
				model: key.slice(id.length + 1),
				ban
			});
			out.push({
				...node,
				health,
				bans
			});
		}
		return out;
	}
};

//#endregion
//#region src/pool/admission.ts
/**
* Coarse screen (admission steps 1+2, docs/ip-pool.md 4.5 修订): one request
* through the candidate to the ip echo. This step touches only the wild
* candidate and a public IP service — never the anonymous lane — so callers
* may fan it out at high concurrency (admissionFanout; GoProxy uses 300 for
* the same reason). Steps 3-4 (which spend anonymous-lane quota) stay on the
* bounded Prober.
*/
async function coarseScreen(deps, candidate, options = {}) {
	const ipEcho = deps.ipEchoUrl ?? DEFAULT_IP_ECHO;
	const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const blocked = new Set(deps.blockedCountries ?? ["CN"]);
	const maxResponseMs = options.relaxed ? RELAXED_RESPONSE_MS : 3e3;
	let agent = null;
	try {
		agent = new deps.undici.ProxyAgent({ uri: exitProxyUri(candidate.address, candidate.protocol) });
	} catch (err) {
		return { rejected: `agent-build: ${err instanceof Error ? err.message : String(err)}` };
	}
	try {
		const started = Date.now();
		const echo = await withTimeout(deps.undici.request(ipEcho, { dispatcher: agent }), timeout, "probe");
		const latencyMs = Date.now() - started;
		if (echo.statusCode !== 200) return { rejected: `echo HTTP ${echo.statusCode}` };
		let body;
		try {
			body = JSON.parse(await echo.body.text());
		} catch {
			return { rejected: "echo body not JSON" };
		}
		if (body.status !== "success" || !body.query) return { rejected: "echo did not report an exit IP" };
		const country = body.countryCode?.toUpperCase() ?? "";
		if (blocked.has(country)) return { rejected: `geo-blocked ${country}` };
		if (latencyMs > maxResponseMs && !options.pinned) return { rejected: `latency ${latencyMs}ms > ${maxResponseMs}ms` };
		return {
			exitIP: body.query,
			exitLocation: `${body.countryCode} ${body.city}`.trim(),
			latencyMs
		};
	} catch (err) {
		return { rejected: err instanceof Error ? err.message : String(err) };
	} finally {
		agent.close().catch(() => {});
	}
}
/** Bounded fan-out helper for the coarse screen (wild candidates only).
*  onProgress reports (screensCompleted, survivorsSoFar) as the fan-out runs
*  (settings-page refill progress, docs §5.3). */
async function coarseScreenBatch(deps, candidates, options = {}) {
	const fanout = Math.max(1, options.fanout ?? 300);
	const results = /* @__PURE__ */ new Map();
	const queue = [...candidates];
	let done = 0;
	const worker = async () => {
		for (;;) {
			const candidate = queue.shift();
			if (candidate === void 0) return;
			const verdict = await coarseScreen(deps, candidate, options);
			done += 1;
			if ("exitIP" in verdict) results.set(candidate.address, verdict);
			options.onProgress?.(done, results.size);
		}
	};
	await Promise.all(Array.from({ length: Math.min(fanout, candidates.length) }, () => worker()));
	return results;
}
const DEFAULT_IP_ECHO = "http://ip-api.com/json/?fields=status,country,countryCode,city,query";
const DEFAULT_TIMEOUT_MS = 8e3;
/** critical-state relaxed latency gate (docs/ip-pool.md 4.6 maxResponseMs). */
const RELAXED_RESPONSE_MS = 6e3;
function withTimeout(promise, ms, label) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`${label} timed out after ${ms}ms`)), ms);
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}
async function admitCandidate(deps, candidate, options = {}) {
	const zenBase = deps.zenBaseUrl ?? ZEN_BASE_URL;
	const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const smokeModel = deps.smokeModel ?? "big-pickle";
	const smokeContent = deps.smokeContent ?? pickSmokeContent(deps.smokeContents, deps.random);
	const probeHeaders = () => disguiseHeaders({
		session: canonicalSessionID(`admission:${candidate.address}`),
		request: mintedMessageID(),
		project: DEFAULT_PROJECT_ID,
		parentSession: ""
	});
	let agent = null;
	try {
		agent = new deps.undici.ProxyAgent({ uri: exitProxyUri(candidate.address, candidate.protocol) });
	} catch (err) {
		return {
			admitted: false,
			reason: `agent-build: ${err instanceof Error ? err.message : String(err)}`
		};
	}
	const request = (url, init = {}) => withTimeout(deps.undici.request(url, {
		dispatcher: agent,
		...init
	}), timeout, init.method === "POST" ? "smoke" : "probe");
	try {
		let facts;
		if (options.echoFacts) facts = options.echoFacts;
		else {
			const verdict = await coarseScreen(deps, candidate, options);
			if ("rejected" in verdict) return {
				admitted: false,
				reason: verdict.rejected
			};
			facts = verdict;
		}
		const admittedNode = () => ({
			id: candidate.address,
			protocol: candidate.protocol,
			source: candidate.source,
			pinned: options.pinned ?? false,
			exitIP: facts.exitIP,
			exitLocation: facts.exitLocation,
			latencyMs: facts.latencyMs,
			quality: gradeOf(facts.latencyMs),
			addedAt: Date.now()
		});
		const models = await request(`${zenBase.replace(/\/+$/, "")}/v1/models`, { headers: {
			authorization: "Bearer public",
			"user-agent": opencodeUserAgent(),
			"x-opencode-client": "cli",
			accept: "application/json",
			...probeHeaders()
		} });
		if (models.statusCode !== 200) return {
			admitted: false,
			reason: `zen models HTTP ${models.statusCode}`
		};
		const smoke = await request(`${zenBase.replace(/\/+$/, "")}/v1/chat/completions`, {
			method: "POST",
			headers: {
				authorization: "Bearer public",
				"content-type": "application/json",
				...probeHeaders()
			},
			body: JSON.stringify({
				model: smokeModel,
				messages: [{
					role: "user",
					content: smokeContent
				}],
				max_tokens: 1,
				stream: true,
				stream_options: { include_usage: true },
				tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => freeLaneGateTool(name))
			})
		});
		if (smoke.statusCode !== 200) {
			if (smoke.statusCode === 429) return {
				admitted: true,
				limited: true,
				reason: `zen smoke HTTP 429`,
				node: admittedNode()
			};
			return {
				admitted: false,
				reason: `zen smoke HTTP ${smoke.statusCode}`
			};
		}
		return {
			admitted: true,
			node: admittedNode()
		};
	} catch (err) {
		return {
			admitted: false,
			reason: err instanceof Error ? err.message : String(err)
		};
	} finally {
		agent.close().catch(() => {});
	}
}
/** Admit a trusted-source candidate (manual/subscription/goproxy): smoke
*  only; failure warns instead of rejecting for pinned (docs 4.5). Existing
*  pool facts are PRESERVED on the failure fallback — a failed smoke wipes
*  neither a previously measured exitIP/latency nor the routing key. */
async function admitTrusted(deps, candidate, options = {}) {
	const result = await admitCandidate(deps, candidate, {
		pinned: options.pinned,
		echoFacts: options.echoFacts
	});
	if (result.admitted) return result;
	deps.logger?.warn(`opencode2dsh: trusted exit ${candidate.address} failed admission (${result.reason}); kept UNVERIFIED with ${options.previous?.exitIP ? "previous" : "unknown"} exit facts (not routing until a probe verifies it)`);
	const previous = options.previous;
	const kept = previous !== void 0 && previous.exitIP !== "" ? previous : void 0;
	return {
		admitted: true,
		unverified: true,
		reason: result.reason ?? "unverified",
		node: {
			id: candidate.address,
			protocol: candidate.protocol,
			source: candidate.source,
			pinned: options.pinned ?? false,
			exitIP: kept?.exitIP ?? "",
			exitLocation: kept?.exitLocation ?? "",
			latencyMs: kept?.latencyMs ?? 0,
			quality: kept === void 0 ? UNVERIFIED_QUALITY : kept.quality ?? gradeOf(kept.latencyMs),
			addedAt: Date.now()
		}
	};
}

//#endregion
export { ExitPool as a, coarseScreenBatch as i, admitTrusted as n, UNVERIFIED_QUALITY as o, coarseScreen as r, gradeOf as s, admitCandidate as t };