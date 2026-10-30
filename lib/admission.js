import { _ as currentProjectID, b as mintedMessageID, f as chatApiPath, h as canonicalSessionID, m as laneOrigins, r as ZEN_BASE_URL, x as opencodeUserAgent, y as disguiseHeaders } from "./catalog.js";
import { a as renderEnvSection, m as EGRESS_HEADER, r as pickSmokeContent, s as FREE_LANE_GATE_TOOL_NAMES, u as freeLaneGateTool } from "./smoke-content.js";
import { i as exitProxyUri, l as LOCAL_EXIT_ID } from "./dispatcher.js";

//#region src/pool/pool.ts
/**
* How long an exit is benched after OpenCode's IP-reputation refusal
* (…abusive traffic from this IP address…). The flag lives upstream and is
* measured in hours (docs/ip-pool.md §3.2), so a minutes-long cooldown would
* just re-burn the same refusal on the next rotation. The card's 探测 action
* still probes it on demand, and a probe that passes clears the note (markOk).
*/
const ABUSIVE_COOLDOWN_MS = 10800 * 1e3;
/** Quality grade from admission latency (GoProxy thresholds). */
function gradeOf(latencyMs) {
	if (latencyMs <= 500) return "S";
	if (latencyMs <= 1e3) return "A";
	if (latencyMs <= 2e3) return "B";
	return "C";
}
/**
* Grade for an exit that was never measured. gradeOf(0) returns 'S' (a 0ms
* admission), which would hand the BEST grade to an exit carrying NO facts,
* and the picker sorts by grade. An unmeasured exit ranks last until a probe
* actually measures it.
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
/** Does `node` rank below `other` for eviction (grade, then latency, then age)? */
function ranksBelow(node, other) {
	const byGrade = GRADE_RANK[node.quality] - GRADE_RANK[other.quality];
	if (byGrade !== 0) return byGrade > 0;
	const byLatency = node.latencyMs - other.latencyMs;
	if (byLatency !== 0) return byLatency > 0;
	return node.addedAt < other.addedAt;
}
/** Sticky session bindings kept at most; the least recently bound go first. */
const SESSION_BINDING_CAP = 2e3;
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
	/** Fired when a set pin is skipped by the rotation — see onPinnedSkip(). */
	#pinSkipCallbacks = [];
	/**
	* Exits rejected by the upstream lane (a failed OpenCode smoke, or a 401/403
	* verdict) with no reserve left to promote: they stay in the pool as the last
	* resort but are ranked last by `pick()` and listed last by `list()` — the
	* pool keeps its size instead of draining to zero (docs/ip-pool.md §4.7).
	*/
	#demoted = /* @__PURE__ */ new Set();
	#poolSize;
	#cooldownBase;
	#cooldownMax;
	#banConfirmations;
	#now;
	constructor(options = {}) {
		this.#poolSize = options.poolSize ?? 10;
		this.#cooldownBase = options.limitedCooldownBaseMs ?? 6e4;
		this.#cooldownMax = options.limitedCooldownMaxMs ?? 30 * 6e4;
		this.#banConfirmations = options.modelBanConfirmations ?? 2;
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
	* Evict the worst exit to make room for a better candidate. Pinned and manual
	* rows are explicit user config and are never evicted. Worst = lowest quality
	* grade, then slowest, then oldest. With `than`, the worst row leaves only
	* when it ranks below that candidate.
	* Returns the evicted id (null when nothing can be evicted), because the
	* caller has to close that exit's local listener too — see `Onboarder.trim()`.
	*/
	evictWorst(than) {
		let worst = null;
		for (const node of this.#nodes.values()) {
			if (node.pinned || node.source === "manual") continue;
			if (worst === null || ranksBelow(node, worst)) worst = node;
		}
		if (worst === null) return null;
		if (than !== void 0 && !ranksBelow(worst, {
			...than,
			addedAt: Number.NEGATIVE_INFINITY
		})) return null;
		this.remove(worst.id);
		return worst.id;
	}
	/**
	* Register a callback fired after every node newly added to the pool.
	*
	* The runtime assembly uses it to engage routing the moment a pool that
	* assembled EMPTY stops being empty. Without a source-agnostic hook here, a
	* profile that fills up after boot keeps the dispatcher uninstalled and
	* reports "enabled" while every request still goes direct; subscription and
	* manual admissions both reach this hook through add().
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
	* parks it at the pool tail when no reserve is left (docs/ip-pool.md §4.7).
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
	* local listener, while `isUsable()` still hands it out as the last resort
	* (docs/ip-pool.md §4.7). Facts for a row that left the table are dropped
	* instead: the probe measured an exit the pool already gave up on.
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
			deadAt: 0,
			note: "",
			noteAt: 0
		});
		if (isNew) this.#notifyAdmitted();
		return true;
	}
	#hasExitIP(exitIP, exceptId) {
		for (const node of this.#nodes.values()) if (node.id !== exceptId && node.exitIP === exitIP) return true;
		return false;
	}
	/** The row already egressing from this exit IP (one quota bucket, §3.1), if any. */
	exitIPHolder(exitIP) {
		if (exitIP === "") return void 0;
		for (const node of this.#nodes.values()) if (node.exitIP === exitIP) return node.id;
	}
	has(id) {
		return this.#nodes.has(id);
	}
	get(id) {
		return this.#nodes.get(id);
	}
	/** Drop a node entirely. */
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
	/**
	* A probe could not verify this exit (trusted-source admission fallback):
	* keep the node — a subscription line is paid and `admission.admitTrusted`
	* promises to revisit it — but drop its `ok` claim, so it leaves the
	* verified tier that `pick()` ranks first.
	*
	* 'unknown' is still *usable* (`isUsable()` only hides 'dead'), which is
	* deliberate: a probe-side failure (Zen rejecting the smoke request, an
	* echo endpoint hiccup) must not empty a healthy pool. It only means an
	* exit that was never measured no longer outranks one that was.
	*
	* NOT a revival: an exit already struck dead stays dead until a probe
	* proves it alive (`markOk`). Otherwise a trusted line whose local port no
	* longer exists is re-admitted every round and absorbs every rotation
	* (docs/ip-pool.md §3.2).
	*/
	markUnverified(id) {
		const health = this.#health.get(id);
		if (!health) return;
		if (health.state !== "dead") health.state = "unknown";
	}
	/**
	* Put one struck-dead row back into service, WITHOUT claiming it is healthy.
	*
	* A `dead` mark is permanent until something proves the row alive, and
	* `pick()` skips dead rows — so a row nothing routes to earns no real 2xx,
	* and a corrected cause (a mislabelled protocol) would otherwise leave the
	* sentence behind (AGENTS.md, egress row hygiene).
	*
	* The revived row lands in 'unknown', not 'ok': a corrected label is evidence
	* about the LISTENER, not about the lane, so it re-enters the rotation below
	* the measured tier — and a pinned row is picked again immediately, which is
	* the point. `deadStrikes` resets with it: the grace is per outage.
	*
	* Returns false when the row is no longer in the table (a rotation may have
	* taken it while the diagnosis ran).
	*/
	revive(id) {
		const health = this.#health.get(id);
		if (health === void 0) return false;
		if (health.state === "dead") {
			health.state = "unknown";
			health.deadStrikes = 0;
			health.deadAt = 0;
		}
		return true;
	}
	/**
	* OpenCode refused this exit's IP on reputation grounds (…abusive traffic
	* from this IP address…): bench it for the long haul and record why.
	* Rotating back onto the same address inside the flag's lifetime can only
	* burn requests, and a pin on it turns into an endless failure loop — the
	* cooldown makes `isUsable()` false, so pick() skips it whatever the pin says.
	*/
	markAbusive(id, windowMs = ABUSIVE_COOLDOWN_MS) {
		const health = this.#health.get(id);
		if (!health) return 0;
		health.cooldownUntil = Math.max(health.cooldownUntil, this.#now() + windowMs);
		health.note = "abusive";
		health.noteAt = this.#now();
		return health.cooldownUntil;
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
	* Pin every request to THIS machine: the 本机 row's 固定 button. The sentinel
	* is {@link LOCAL_EXIT_ID}, which can never collide with a real exit id (those
	* are `host:port` or `scheme://host:port`), so `pick()` can tell "no exit at
	* all" from "the pinned exit is unusable" and return null instead of falling
	* through to the rotation pool. Traffic then egresses locally through the
	* dispatcher's local-egress branch, regardless of the 本地出口兜底 switch
	* (docs/ip-pool.md §3.3).
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
			health.note = "";
			health.noteAt = 0;
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
	/** Transport failure / 5xx / probe timeout: the exit is struck dead. */
	markDeadStrike(id) {
		const health = this.#health.get(id);
		if (!this.#nodes.has(id) || !health) return;
		const wasDead = health.state === "dead";
		health.state = "dead";
		health.deadStrikes += 1;
		health.deadAt = this.#now();
		if (!wasDead) {
			this.#moveToTail(id);
			this.#notifyDead(id);
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
	/**
	* Count a transport-level failure WITHOUT deciding the row's fate.
	*
	* Cuts reach this table through pool/transport.ts, which may still be
	* finding out what one means: a listener whose scheme is mislabelled
	* answers nothing at all, and that is not a dead line.
	* The counters are diagnostics — `passive.transport` has to say how often an
	* exit dropped a request either way — so counting is separable from
	* striking.
	*/
	recordTransportSignal(id) {
		if (!this.#nodes.has(id)) return;
		this.#countPassive(id, "transport");
	}
	/** Drop the session's sticky exit when its exit degraded (§3.3). */
	rerouteSession(session) {
		this.#sessionExit.delete(session);
	}
	/**
	* The session's current sticky exit, if any (adapter-side 403 bookkeeping:
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
	* When this exit was last PROVEN alive against the real lane — a 2xx through
	* it or a probe that passed (both land in `markOk`); 0 = never.
	*
	* `pool/transport.ts` keys its one free diagnosis per outage on this, so a
	* cut can tell "nothing has worked since the last cut" (a dying line) from
	* "an isolated hiccup on a line that has carried traffic since".
	*/
	provenAt(id) {
		return this.#health.get(id)?.lastProbedAt ?? 0;
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
	*
	* A pin that IS set but unusable falls through to the rotation — and says so
	* through the pin-skip callback. The fall-through is correct: a pin is a
	* preference (see `pinnedStrict`), so the callback is what keeps an unusable
	* pin visible to the operator (AGENTS.md, egress row hygiene).
	*/
	pick(session, model) {
		if (this.pinnedId === LOCAL_EXIT_ID) return null;
		const pinned = this.pinnedId;
		if (pinned !== "" && this.isUsable(pinned, model)) {
			this.#bindSession(session, pinned);
			return pinned;
		}
		const chosen = this.#rotate(session, model);
		if (chosen !== null && pinned !== "") this.#notifyPinSkip(pinned, chosen);
		return chosen;
	}
	/** Sticky-else-sorted selection over the usable rows (pick's second half). */
	#rotate(session, model) {
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
		this.#bindSession(session, chosen);
		return chosen;
	}
	/** Bind a session to its exit; the map stays bounded, least recent first out. */
	#bindSession(session, exitId) {
		this.#sessionExit.delete(session);
		this.#sessionExit.set(session, exitId);
		while (this.#sessionExit.size > SESSION_BINDING_CAP) {
			const oldest = this.#sessionExit.keys().next().value;
			if (oldest === void 0) break;
			this.#sessionExit.delete(oldest);
		}
	}
	/**
	* Register a callback fired when a set pin could not be used and another exit
	* carried the request. Fired on EVERY such pick; the runtime decides how
	* often to speak (it warns once per outage).
	*/
	onPinnedSkip(callback) {
		this.#pinSkipCallbacks.push(callback);
	}
	/** A watcher's failure must never fail a pick. */
	#notifyPinSkip(pinned, used) {
		for (const callback of this.#pinSkipCallbacks) try {
			callback(pinned, used);
		} catch {}
	}
	snapshot() {
		const bySource = {
			manual: 0,
			subscription: 0,
			goproxy: 0
		};
		for (const node of this.#nodes.values()) bySource[node.source] += 1;
		return {
			total: this.#nodes.size,
			bySource,
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
				ban: { ...ban }
			});
			out.push({
				...node,
				health: { ...health },
				bans
			});
		}
		return out;
	}
};

//#endregion
//#region src/pool/admission.ts
/**
* Coarse screen (admission steps 1+2, docs/ip-pool.md 4.5): one request
* through the candidate to the ip echo. It touches only the candidate and a
* public IP service, never the anonymous lane.
*/
async function coarseScreen(deps, candidate, options = {}) {
	const ipEcho = deps.ipEchoUrl ?? DEFAULT_IP_ECHO;
	const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const blocked = new Set(deps.blockedCountries ?? ["CN"]);
	const maxResponseMs = 3e3;
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
		releaseProbeAgent(agent);
	}
}
const DEFAULT_IP_ECHO = "http://ip-api.com/json/?fields=status,country,countryCode,city,query";
const DEFAULT_TIMEOUT_MS = 8e3;
/**
* Tear down a probe's ProxyAgent and every socket it opened. A probe only
* reads status codes, so it never drains a body, and a proxy may never
* answer: the graceful `close()` waits on both and holds the socket open for
* the life of the host. `destroy()` drops them as soon as the verdict is in.
*/
function releaseProbeAgent(agent) {
	agent.destroy().catch(() => {});
}
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
	const origins = laneOrigins(zenBase, deps.fallbackBaseUrl);
	const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const smokeModel = deps.smokeModel ?? "big-pickle";
	const smokeContent = deps.smokeContent ?? pickSmokeContent(deps.smokeContents, deps.random);
	const probeHeaders = () => disguiseHeaders({
		session: canonicalSessionID(`admission:${candidate.address}`),
		request: mintedMessageID(),
		project: currentProjectID(),
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
	/** `via: null` = undici's default dispatcher (no proxy). */
	const request = (url, init = {}, via = agent) => withTimeout(deps.undici.request(url, {
		...via !== null ? { dispatcher: via } : {},
		...init
	}), timeout, init.method === "POST" ? "smoke" : "probe");
	/** Built only when a relay smoke runs; destroyed with the probe agent. */
	let relayAgent;
	/**
	* Ask each origin in ladder order and keep the best answer: 200 wins
	* outright, a 429 (quota consumed — the exit itself is fine, see the smoke
	* comment below) beats any hard failure, and otherwise the FIRST door's
	* status is the one reported, because that is the door the adapter prefers.
	*/
	const probeLane = async (path, init) => {
		let verdict = 0;
		for (const origin of origins) {
			const { statusCode } = await request(`${origin}${path}`, init);
			if (statusCode === 200) return 200;
			if (verdict === 0 || statusCode === 429 && verdict !== 429) verdict = statusCode;
		}
		return verdict;
	};
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
		const modelsStatus = await probeLane("/v1/models", { headers: {
			authorization: "Bearer public",
			"user-agent": opencodeUserAgent(),
			"x-opencode-client": "cli",
			accept: "application/json",
			...probeHeaders()
		} });
		if (modelsStatus !== 200) return {
			admitted: false,
			reason: `zen models HTTP ${modelsStatus}`
		};
		const relayBase = deps.relayBaseUrl?.() ?? null;
		const relayChatPath = () => {
			const primary = origins[0] ?? zenBase;
			let prefix = "";
			try {
				prefix = new URL(primary).pathname.replace(/\/+$/, "");
			} catch {
				prefix = "";
			}
			return `${prefix}${chatApiPath(primary)}/chat/completions`;
		};
		const smokeBody = JSON.stringify({
			model: smokeModel,
			messages: [{
				role: "system",
				content: renderEnvSection()
			}, {
				role: "user",
				content: smokeContent
			}],
			tools: FREE_LANE_GATE_TOOL_NAMES.map((name) => freeLaneGateTool(name)),
			stream: true,
			stream_options: { include_usage: true },
			max_completion_tokens: 1
		});
		const smokeEgress = exitProxyUri(candidate.address, candidate.protocol);
		if (relayBase !== null && deps.undici.Agent !== void 0) relayAgent = new deps.undici.Agent();
		const smokeStatus = relayBase !== null ? await request(`${relayBase.replace(/\/+$/, "")}${relayChatPath()}`, {
			method: "POST",
			headers: {
				authorization: "Bearer public",
				"content-type": "application/json",
				[EGRESS_HEADER]: smokeEgress,
				...probeHeaders()
			},
			body: smokeBody
		}, relayAgent ?? null).then((response) => response.statusCode) : await probeLane("/v1/chat/completions", {
			method: "POST",
			headers: {
				authorization: "Bearer public",
				"content-type": "application/json",
				...probeHeaders()
			},
			body: smokeBody
		});
		if (smokeStatus !== 200) {
			if (smokeStatus === 429) return {
				admitted: true,
				limited: true,
				reason: `zen smoke HTTP 429`,
				node: admittedNode()
			};
			return {
				admitted: false,
				reason: `zen smoke HTTP ${smokeStatus}`
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
		releaseProbeAgent(agent);
		if (relayAgent !== void 0) releaseProbeAgent(relayAgent);
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
/**
* Speed-test-only admission for PAID sources (subscription refresh): runs
* coarseScreen — connectivity, exit IP, geo, latency — and NOTHING else: no
* Zen models list, no anonymous-lane smoke, no request of any kind to OpenCode
* (docs/ip-pool.md §4.5). The measured latency IS the value the pool row
* displays; whether OpenCode will accept this exit IP is left entirely to
* passive verdicts from real traffic (pool.recordPassive), the standing
* liveness model (docs §4.3).
*
* Failure never rejects a paid line (docs §4.5): the node is kept UNVERIFIED
* with unknown facts — same trusted-source contract as admitTrusted's
* fallback, minus the OpenCode probe that subscriptions never run.
*/
async function admitBySpeed(deps, candidate, options = {}) {
	const verdict = await coarseScreen(deps, candidate, { pinned: options.pinned });
	if ("exitIP" in verdict) return {
		admitted: true,
		node: {
			id: candidate.address,
			protocol: candidate.protocol,
			source: candidate.source,
			pinned: options.pinned ?? false,
			exitIP: verdict.exitIP,
			exitLocation: verdict.exitLocation,
			latencyMs: verdict.latencyMs,
			quality: gradeOf(verdict.latencyMs),
			addedAt: Date.now()
		}
	};
	deps.logger?.warn(`opencode2dsh: speed test failed for paid exit ${candidate.address} (${verdict.rejected}); kept UNVERIFIED with unknown exit facts (no OpenCode probe runs for subscriptions)`);
	return {
		admitted: true,
		unverified: true,
		reason: verdict.rejected,
		node: {
			id: candidate.address,
			protocol: candidate.protocol,
			source: candidate.source,
			pinned: options.pinned ?? false,
			exitIP: "",
			exitLocation: "",
			latencyMs: 0,
			quality: UNVERIFIED_QUALITY,
			addedAt: Date.now()
		}
	};
}

//#endregion
export { ExitPool as a, coarseScreen as i, admitCandidate as n, UNVERIFIED_QUALITY as o, admitTrusted as r, gradeOf as s, admitBySpeed as t };