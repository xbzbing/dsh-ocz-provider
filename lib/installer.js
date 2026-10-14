import { a as resolveProxyPathPrefixes, i as resolveProxyHosts, n as PoolRoutingDispatcher } from "./dispatcher.js";

//#region src/pool/installer.ts
var RoutingInstaller = class {
	#deps;
	#previous = null;
	#current = null;
	#enabled = false;
	#deferredReason = null;
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
	* The host list actually in force. Reads the running router when one is
	* installed (its own default already applied), otherwise resolves the
	* configured value — so the settings card can never display a default the
	* router is not using, the exact mismatch that hid the empty-list bug.
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
	* Decide whether installing is safe (docs/ip-pool.md R1 coexistence policy).
	* The global dispatcher slot is single-owner: if another dispatcher-level
	* plugin (dsh-llm-proxy etc.) already installed its own layer, installing
	* ours would short-circuit theirs silently. We defer instead — routing
	* stays off, the pool keeps assembling (exits/probes/settings all live),
	* and the reason surfaces on the settings card. Default Agent instances
	* (undici's own) are not treated as a foreign owner.
	*/
	#detectForeignDispatcher() {
		let current;
		try {
			current = this.#deps.undici.getGlobalDispatcher();
		} catch {
			return null;
		}
		if (current === null || current === void 0) return null;
		const name = current.constructor?.name ?? "";
		if (name === "" || name === "Object" || name === "Agent" || name === "Dispatcher") return null;
		if (current instanceof this.#deps.undici.Agent) return null;
		return `deferred: global dispatcher is owned by "${name}" — install dsh-llm-proxy or the IP pool in one profile only, not both (R1)`;
	}
	/** Install (or keep installed) the routing dispatcher. */
	install() {
		if (this.#enabled) return;
		const foreign = this.#detectForeignDispatcher();
		if (foreign !== null) {
			this.#deferredReason = foreign;
			this.#deps.logger?.warn(`oc2dsh: exit routing ${foreign}`);
			return;
		}
		this.#deferredReason = null;
		const router = new PoolRoutingDispatcher({
			pool: this.#deps.pool,
			undici: this.#deps.undici,
			proxyHosts: this.#deps.proxyHosts,
			proxyPathPrefixes: this.#deps.proxyPathPrefixes,
			logger: this.#deps.logger
		});
		let previous = null;
		try {
			previous = this.#deps.undici.getGlobalDispatcher();
		} catch {}
		this.#deps.undici.setGlobalDispatcher(router);
		if (previous !== null && previous !== void 0) this.#previous = previous;
		const old = this.#current;
		this.#current = router;
		this.#enabled = true;
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
		this.#enabled = false;
		const restoreFetch = this.#savedGlobalFetch !== null;
		if (restoreFetch) {
			globalThis.fetch = this.#savedGlobalFetch;
			this.#savedGlobalFetch = null;
		}
		let restored = false;
		const dying = this.#current;
		this.#current = null;
		if (dying !== null) dying.destroy().catch(() => {});
		if (this.#previous !== null) {
			try {
				this.#deps.undici.setGlobalDispatcher(this.#previous);
				restored = true;
			} catch {}
			this.#previous = null;
		}
		if (!restored && dying !== null) try {
			this.#deps.undici.setGlobalDispatcher(new this.#deps.undici.Agent());
			restored = true;
		} catch {}
		this.#deps.logger?.info(restored ? `oc2dsh: exit routing disabled; previous global dispatcher restored${restoreFetch ? " and globalThis.fetch restored" : ""}` : "oc2dsh: exit routing disabled; no previous dispatcher to restore");
	}
	/** Full teardown (plugin dispose): same as disable. */
	dispose() {
		this.disable();
	}
};

//#endregion
export { RoutingInstaller };