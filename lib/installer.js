import { a as resolveProxyHosts, o as resolveProxyPathPrefixes, r as PoolRoutingDispatcher, x as resolveLocalIpFamily } from "./dispatcher.js";

//#region src/pool/installer.ts
var RoutingInstaller = class {
	#deps;
	#previous = null;
	#current = null;
	#enabled = false;
	#deferredReason = null;
	/** Name of the composing dispatcher we joined below, or null when we own the slot. */
	#composedUnder = null;
	/** The composer we chained into, held for identity checks (never for dispatch). */
	#composer = null;
	/** A composer that did not adopt us, so a refusal is not retried on every admission. */
	#refusedBy = null;
	/** The built-in fetch saved aside while the module fetch is installed (R2). */
	#savedGlobalFetch = null;
	constructor(deps) {
		this.#deps = deps;
	}
	get enabled() {
		return this.#enabled;
	}
	/** The deferral reason exposed to the status bridge / settings card. */
	get deferredReason() {
		return this.#deferredReason;
	}
	/**
	* The composing dispatcher our layer sits BELOW (dsh-privacy-gateway's
	* MaskingDispatcher), or null when we own the global slot. Non-null means
	* masking and exit routing are both live on the same request: the composer
	* masks the body first, then hands it to this router.
	*/
	get composedUnder() {
		return this.#composedUnder;
	}
	/**
	* Whether the routing that is enabled is still the routing in force — the
	* public seam behind the pool's per-admission reconcile (ip-pool.ts
	* engageRouting). False means the slot was taken over, so install() has work
	* to do; true costs two identity comparisons and no I/O.
	*/
	routingInForce() {
		return this.#enabled && this.#stillRouted();
	}
	/**
	* The host list actually in force. Reads the running router when one is
	* installed (its own default already applied), otherwise resolves the
	* configured value — so the settings card can never display a default the
	* router is not using.
	*/
	get proxyHosts() {
		return this.#current?.proxyHosts ?? resolveProxyHosts(this.#deps.proxyHosts);
	}
	/** Live re-apply of the proxied-host list (forwards to the running router). */
	setProxyHosts(hosts) {
		this.#deps.proxyHosts = hosts;
		this.#current?.setProxyHosts(hosts);
	}
	/** The path scope actually in force (running router wins, exactly like hosts). */
	get proxyPathPrefixes() {
		return this.#current?.proxyPathPrefixes ?? resolveProxyPathPrefixes(this.#deps.proxyPathPrefixes);
	}
	/** Live re-apply of the path scope (forwards to the running router). */
	setProxyPathPrefixes(prefixes) {
		this.#deps.proxyPathPrefixes = prefixes;
		this.#current?.setProxyPathPrefixes(prefixes);
	}
	/**
	* 本地出口兜底 in force. Reported the same way as the host/path lists: the
	* running router's own value wins, so the card can never display a switch
	* position the router is not actually honouring.
	*/
	get localFallback() {
		return this.#current?.localFallback ?? this.#deps.localFallback === true;
	}
	/** Live re-apply of 本地出口兜底 (settings page, docs §3.3/§5.1). */
	setLocalFallback(value) {
		this.#deps.localFallback = value === true;
		this.#current?.setLocalFallback(value === true);
	}
	/**
	* 本机出口协议族 in force, reported exactly like 本地出口兜底: the running
	* router's own resolution wins, so the dropdown can never display a position
	* the sockets are not actually using.
	*/
	get localIpFamily() {
		return this.#current?.localIpFamily ?? resolveLocalIpFamily(this.#deps.localIpFamily);
	}
	/** Live re-apply of 本机出口协议族 (settings page, local-family.ts). */
	setLocalIpFamily(value) {
		const family = resolveLocalIpFamily(value);
		this.#deps.localIpFamily = family;
		this.#current?.setLocalIpFamily(family);
	}
	/**
	* Classify the global dispatcher slot (docs/ip-pool.md R1 coexistence
	* policy). The slot is single-owner by host convention, so taking it from a
	* dispatcher-level plugin short-circuits that plugin silently — but a
	* COMPOSING dispatcher hands us a documented way in (`chainTo`), and joining
	* it is strictly better than deferring: both layers then run, in the only
	* order that works (masking first, exit second).
	*/
	#classifyOccupant() {
		let current;
		try {
			current = this.#deps.undici.getGlobalDispatcher();
		} catch {
			return { kind: "free" };
		}
		if (current === null || current === void 0) return { kind: "free" };
		const foreign = current;
		const name = foreign.constructor?.name ?? "";
		if (name === "" || name === "Object" || name === "Agent" || name === "Dispatcher") return { kind: "free" };
		if (current instanceof this.#deps.undici.Agent) return { kind: "free" };
		if (typeof foreign.chainTo === "function") return {
			kind: "composable",
			dispatcher: current,
			name
		};
		return {
			kind: "foreign",
			name
		};
	}
	/** The routing layer itself, carrying the settings in force right now. */
	#buildRouter(downstream) {
		return new PoolRoutingDispatcher({
			pool: this.#deps.pool,
			undici: this.#deps.undici,
			proxyHosts: this.#deps.proxyHosts,
			proxyPathPrefixes: this.#deps.proxyPathPrefixes,
			localFallback: this.#deps.localFallback === true,
			localIpFamily: resolveLocalIpFamily(this.#deps.localIpFamily),
			listInterfaces: this.#deps.listInterfaces,
			onTransportCut: this.#deps.onTransportCut,
			logger: this.#deps.logger,
			...downstream === void 0 ? {} : { downstream }
		});
	}
	/**
	* Attach this router BELOW a composing dispatcher, leaving the slot to it.
	*
	* The composer hands each request to the newest layer chained after it, so
	* appending ours keeps it outermost — exactly the order masking needs. The
	* result is verified through the composer's own `downstream()` when it
	* exposes one: a composer that did not adopt us (or adopted us and still
	* routes elsewhere) is treated like any other foreign owner, so the status
	* can never claim routing the process is not doing.
	*/
	#joinDownstream(occupant) {
		if (this.#refusedBy === occupant.dispatcher) {
			this.#deferForeign(occupant.name, "did not adopt this layer as its downstream");
			return;
		}
		const probe = occupant.dispatcher;
		const below = typeof probe.downstream === "function" ? probe.downstream() : void 0;
		const borrowed = below !== null && typeof below === "object" && typeof below.dispatch === "function" ? below : void 0;
		const router = this.#buildRouter(borrowed);
		let adopted = true;
		try {
			if (typeof probe.chainTo !== "function") adopted = false;
			else {
				probe.chainTo(router);
				if (typeof probe.downstream === "function") adopted = probe.downstream() === router;
			}
		} catch {
			adopted = false;
		}
		if (!adopted) {
			this.#refusedBy = occupant.dispatcher;
			this.#deferForeign(occupant.name, "did not adopt this layer as its downstream");
			router.destroy().catch(() => {});
			return;
		}
		const old = this.#current;
		this.#current = router;
		this.#enabled = true;
		this.#composedUnder = occupant.name;
		this.#composer = occupant.dispatcher;
		this.#refusedBy = null;
		this.#deferredReason = null;
		this.#previous = null;
		if (old !== null) old.destroy().catch(() => {});
		this.#deps.logger?.info(`oc2dsh: exit routing joined below "${occupant.name}" (body masked first, then the exit is picked)`);
	}
	#deferForeign(name, why) {
		this.#deferredReason = why === void 0 ? `deferred: global dispatcher is owned by "${name}" — install dsh-llm-proxy or the IP pool in one profile only, not both (R1)` : `deferred: global dispatcher is owned by "${name}" and ${why} (R1)`;
		this.#deps.logger?.warn(`oc2dsh: exit routing ${this.#deferredReason}`);
	}
	/**
	* Whether the routing enabled on the books is still the routing in force:
	* we hold the slot (or a composer handed it to us when it disposed), or the
	* composer still routes to our layer. Anything else — another plugin replaced
	* us, or the composer chained a later layer on top — means requests already
	* bypass this router.
	*/
	#stillRouted() {
		const router = this.#current;
		if (router === null) return false;
		let current;
		try {
			current = this.#deps.undici.getGlobalDispatcher();
		} catch {
			return false;
		}
		if (current === router) {
			this.#composedUnder = null;
			this.#composer = null;
			return true;
		}
		const composer = this.#composer;
		if (composer === null || current !== composer) return false;
		const probe = composer;
		if (typeof probe.downstream !== "function") return true;
		try {
			return probe.downstream() === router;
		} catch {
			return false;
		}
	}
	/** Drop this layer without touching the slot; the caller re-classifies it. */
	#teardownLayer() {
		const dying = this.#current;
		this.#current = null;
		this.#enabled = false;
		this.#composedUnder = null;
		this.#composer = null;
		this.#previous = null;
		if (this.#savedGlobalFetch !== null) {
			globalThis.fetch = this.#savedGlobalFetch;
			this.#savedGlobalFetch = null;
		}
		if (dying !== null) dying.destroy().catch(() => {});
	}
	/** Whether the global slot still points at this layer (nobody wrapped us). */
	#ownsSlot(dispatcher) {
		try {
			return this.#deps.undici.getGlobalDispatcher() === dispatcher;
		} catch {
			return false;
		}
	}
	/** Install (or keep installed) the routing dispatcher. */
	install() {
		if (this.#enabled && this.#stillRouted()) return;
		if (this.#enabled) this.#teardownLayer();
		const occupant = this.#classifyOccupant();
		if (occupant.kind === "foreign") {
			this.#deferForeign(occupant.name);
			return;
		}
		this.#deferredReason = null;
		if (occupant.kind === "composable") {
			this.#joinDownstream(occupant);
			return;
		}
		const router = this.#buildRouter();
		let previous = null;
		try {
			previous = this.#deps.undici.getGlobalDispatcher();
		} catch {}
		this.#deps.undici.setGlobalDispatcher(router);
		if (previous !== null && previous !== void 0) this.#previous = previous;
		const old = this.#current;
		this.#current = router;
		this.#enabled = true;
		this.#composedUnder = null;
		this.#composer = null;
		if (old !== null) old.destroy().catch(() => {});
		const moduleFetch = this.#deps.undici.fetch;
		if (typeof moduleFetch === "function" && globalThis.fetch !== moduleFetch) {
			this.#savedGlobalFetch = globalThis.fetch;
			globalThis.fetch = moduleFetch;
			this.#deps.logger?.info("oc2dsh: globalThis.fetch -> undici module fetch (built-in fetch bypasses the pool dispatcher otherwise)");
		}
		this.#deps.logger?.info("oc2dsh: global dispatcher -> PoolRoutingDispatcher (exit routing enabled)");
	}
	/** Restore the pre-install dispatcher and close ours. */
	disable() {
		if (!this.#enabled) return;
		const dying = this.#current;
		const previous = this.#previous;
		const under = this.#composedUnder;
		const owns = dying !== null && this.#ownsSlot(dying);
		const restoreFetch = this.#savedGlobalFetch !== null;
		this.#teardownLayer();
		let restored = false;
		if (owns) {
			if (previous !== null) try {
				this.#deps.undici.setGlobalDispatcher(previous);
				restored = true;
			} catch {}
			if (!restored) try {
				this.#deps.undici.setGlobalDispatcher(new this.#deps.undici.Agent());
				restored = true;
			} catch {}
		}
		if (!owns) {
			this.#deps.logger?.info(`oc2dsh: exit routing disabled; global dispatcher left with "${under ?? "the layer above"}" (our layer closed, requests fall through)`);
			return;
		}
		this.#deps.logger?.info(restored ? `oc2dsh: exit routing disabled; previous global dispatcher restored${restoreFetch ? " and globalThis.fetch restored" : ""}` : "oc2dsh: exit routing disabled; no previous dispatcher to restore");
	}
	/** Full teardown (plugin dispose): same as disable. */
	dispose() {
		this.disable();
	}
};

//#endregion
export { RoutingInstaller };