import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "yaml";

//#region src/pool/rotate.ts
let delegate = null;
/** Install the runtime's rotate delegate (startIpPool). */
function setRotateDelegate(next) {
	delegate = next;
}
/** Ask the installed delegate; false when no pool is running. */
function shouldRotate(failure, model, session, attempt, deterministic = false) {
	return delegate?.decide(failure, model, session, attempt, deterministic) ?? false;
}
/** Map a pi-ai error message to the failure taxonomy (adapter-side parse). */
function classifyStreamFailure(errorMessage) {
	const text = errorMessage.toLowerCase();
	if (/\b429\b|rate.?limit|freeusagelimit/.test(text)) return "limited";
	if (/\b(?:401|403)\b/.test(text)) return "refused";
	if (/\b(?:network|connection|socket|fetch|terminated|premature close)\b|\beconn[a-z]+\b|timeout|timed out/.test(text)) return "transport";
	if (/\b5\d\d\b|internal server error|server error/.test(text)) return "transport";
	return null;
}
/** True when the error body names a deterministic region block (Zen's
*  RegionError): the exit's IP cannot serve this model — ban the pairing on
*  sight instead of collecting two samples (docs 4.2). */
function isRegionBlocked(errorMessage) {
	return /regionerror|not available in your country/i.test(errorMessage);
}
/**
* Build the runtime delegate over the live pool (ip-pool.ts assembly).
* Passive bookkeeping mirrors the dispatcher observer: the stream that died
* before content already recorded its verdict through the routing layer when
* it could see it — the sentinel covers the mute-connection case — so this
* delegate only breaks stickiness and checks whether a usable exit remains.
*/
function createRotateDelegate(pool, options = {}) {
	const maxAttempts = options.maxAttempts ?? 3;
	return { decide(failure, model, session, attempt, deterministic = false) {
		if (deterministic) {
			const failedExit = pool.exitOfSession(session);
			if (failedExit !== null) pool.markModelBanned(failedExit, model);
		}
		if (attempt > maxAttempts) return false;
		if (!pool.list().some((entry) => pool.isUsable(entry.id, model))) return false;
		pool.rerouteSession(session);
		return true;
	} };
}

//#endregion
//#region src/pool/subscription.ts
const SUPPORTED_TYPES = new Set([
	"vmess",
	"vless",
	"trojan",
	"shadowsocks",
	"shadowsocksr",
	"hysteria",
	"hysteria2",
	"tuic",
	"anytls",
	"http",
	"socks5"
]);
/**
* The User-Agent the subscription fetch sends. Airports routinely gate on it:
* a UA their panel does not recognise comes back as an error page (or a 502
* from their edge) instead of a subscription body, and some panels pick the
* RETURNED FORMAT from it (a Clash-shaped UA yields `proxies:` YAML, a
* v2ray-shaped one yields base64 links).
*
* The value ages: it is a client version, and panels raise their floor over
* time. Measured history on the live airport — `clash-verge/1.6.0` → 502,
* `clash-verge/v2.0` → 200 for months, then (2026-10-13) `403 PLEASE UPGRADE
* CLIENT` while `clash-verge/v2.4.2`, `mihomo/1.19.8` and `clash.meta/1.19.8`
* all answered 200 with the Clash-shaped body. The default stays in the
* Clash-Verge family on purpose: the family is what selects the returned
* format, so switching families would silently change every other airport's
* body shape. `ipPool.subscription.userAgent` overrides it without a release.
*
* Lives here (the subscription layer's dependency-light module) so the
* settings schema default and the fetcher's runtime fallback share one
* literal and cannot drift; the fetcher re-exports it for its own callers.
*/
const DEFAULT_SUBSCRIPTION_USER_AGENT = "clash-verge/v2.4.2";
/** GoProxy looksLikeYAML: the structural markers of a Clash config. */
function looksLikeYaml(content) {
	if (/^proxies:\s*$/m.test(content) || /^Proxy:\s*$/m.test(content)) return true;
	if (content.includes("proxies:") && content.includes("- name:")) return true;
	return /^---\s*$/m.test(content) && content.includes("port:");
}
/** GoProxy looksLikeProxyLinks. */
function looksLikeProxyLinks(content) {
	return content.includes("vmess://") || content.includes("vless://") || content.includes("trojan://") || content.includes("ss://") || content.includes("ssr://") || content.includes("hysteria2://") || content.includes("hy2://") || content.includes("tuic://");
}
/** Base64 decode tolerant of the variants subscriptions actually use
*  (missing padding, URL-safe alphabet, embedded newlines). */
function tryBase64Decode(content) {
	const compact = content.replace(/\s+/g, "");
	if (compact.length < 8) return null;
	const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	try {
		const decoded = Buffer.from(padded, "base64").toString("utf8");
		if (Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_") !== compact.replace(/=+$/, "")) return null;
		if (decoded.includes("\0")) return null;
		return decoded;
	} catch {
		return null;
	}
}
/** One Clash YAML proxy entry -> ParsedNode (GoProxy parseClashProxy). */
function parseClashProxy(proxy) {
	if (typeof proxy !== "object" || proxy === null) return null;
	const type = typeof proxy.type === "string" ? proxy.type.toLowerCase() : "";
	const server = typeof proxy.server === "string" ? proxy.server : "";
	if (type === "" || server === "") return null;
	let port = 0;
	const rawPort = proxy.port;
	if (typeof rawPort === "number" && Number.isFinite(rawPort)) port = rawPort;
	else if (typeof rawPort === "string" && /^\d+$/.test(rawPort)) port = Number(rawPort);
	if (port < 1 || port > 65535) return null;
	const normalized = type === "ss" ? "shadowsocks" : type === "ssr" ? "shadowsocksr" : type;
	if (!SUPPORTED_TYPES.has(normalized)) return null;
	return {
		name: typeof proxy.name === "string" && proxy.name.length > 0 ? proxy.name : `${server}:${port}`,
		type: normalized,
		server,
		port,
		raw: proxy
	};
}
/** Clash YAML document -> nodes (new `proxies` + legacy `Proxy` layouts). */
function parseClashYaml(content) {
	let document;
	try {
		document = parseYamlDocument(content);
	} catch {
		return {
			nodes: [],
			skipped: 0
		};
	}
	if (typeof document !== "object" || document === null) return {
		nodes: [],
		skipped: 0
	};
	const config = document;
	const proxyLists = [config.proxies, config.Proxy].filter((value) => Array.isArray(value));
	const nodes = [];
	let skipped = 0;
	for (const list of proxyLists) for (const entry of list) {
		const node = parseClashProxy(entry);
		if (node) nodes.push(node);
		else skipped += 1;
	}
	return {
		nodes,
		skipped
	};
}
function parseYamlDocument(content) {
	return parse(content);
}
/** vmess:// V2rayN base64-JSON link (GoProxy parseVmessLink). */
function parseVmessLink(link) {
	const decoded = tryBase64Decode(link.slice(8));
	if (decoded === null) return null;
	let info;
	try {
		info = JSON.parse(decoded);
	} catch {
		return null;
	}
	const server = String(info.add ?? "");
	const port = Number(info.port ?? 0);
	if (server === "" || !Number.isFinite(port) || port < 1) return null;
	const name = typeof info.ps === "string" && info.ps.length > 0 ? info.ps : server;
	const raw = {
		type: "vmess",
		name,
		server,
		port,
		uuid: String(info.id ?? ""),
		alterId: Number(info.aid ?? 0) || 0,
		cipher: typeof info.scy === "string" ? info.scy : "auto"
	};
	if (String(info.tls) === "tls") {
		raw.tls = true;
		if (typeof info.sni === "string" && info.sni) raw.sni = info.sni;
	}
	const network = typeof info.net === "string" ? info.net : "tcp";
	raw.network = network;
	if (network === "ws") {
		const wsOpts = {};
		if (typeof info.path === "string" && info.path) wsOpts.path = info.path;
		if (typeof info.host === "string" && info.host) wsOpts.headers = { Host: info.host };
		raw["ws-opts"] = wsOpts;
	} else if (network === "grpc") {
		const grpcOpts = {};
		if (typeof info.path === "string" && info.path) grpcOpts["grpc-service-name"] = info.path;
		raw["grpc-opts"] = grpcOpts;
	}
	return {
		name,
		type: "vmess",
		server,
		port,
		raw
	};
}
/** Standard URI link (vless/trojan/hysteria2/tuic) — GoProxy parseStandardLink. */
function parseStandardLink(link, type) {
	let url;
	try {
		url = new URL(link);
	} catch {
		return null;
	}
	const server = url.hostname.replace(/^\[|\]$/g, "");
	let port = Number(url.port);
	if (!Number.isFinite(port) || port < 1) port = 443;
	const name = decodeURIComponent(url.hash.slice(1)) || server;
	const raw = {
		type,
		name,
		server,
		port
	};
	const username = url.username ? decodeURIComponent(url.username) : "";
	if (username !== "") {
		if (type === "trojan" || type === "hysteria2") raw.password = username;
		else if (type === "vless" || type === "tuic") {
			raw.uuid = username;
			if (url.password) raw.password = decodeURIComponent(url.password);
		}
	}
	for (const [key, value] of url.searchParams) raw[key] = value;
	return {
		name,
		type,
		server,
		port,
		raw
	};
}
/** ss:// link (GoProxy parseShadowsocksLink, both layout variants). */
function parseShadowsocksLink(link) {
	const hashIndex = link.indexOf("#");
	const name = hashIndex >= 0 ? decodeURIComponent(link.slice(hashIndex + 1)) : "";
	const body = hashIndex >= 0 ? link.slice(5, hashIndex) : link.slice(5);
	const at = body.lastIndexOf("@");
	if (at > 0) {
		const userinfo = tryBase64Decode(body.slice(0, at));
		const hostPart = body.slice(at + 1);
		const hostMatch = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(hostPart);
		if (userinfo === null || !hostMatch?.[1] || !hostMatch[2]) return null;
		const port$1 = Number(hostMatch[2]);
		if (port$1 < 1) return null;
		const server$1 = hostMatch[1].replace(/^\[|\]$/g, "");
		return {
			name: name || server$1,
			type: "shadowsocks",
			server: server$1,
			port: port$1,
			raw: {
				type: "shadowsocks",
				name: name || server$1,
				server: server$1,
				port: port$1,
				cipher: userinfo
			}
		};
	}
	const decoded = tryBase64Decode(body);
	if (decoded === null) return null;
	const match = /^(\S+?)@(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(decoded);
	if (!match?.[1] || !match[2] || !match[3]) return null;
	const port = Number(match[3]);
	const server = match[2].replace(/^\[|\]$/g, "");
	const colon = match[1].indexOf(":");
	const method = colon > 0 ? match[1].slice(0, colon) : match[1];
	const password = colon > 0 ? match[1].slice(colon + 1) : "";
	return {
		name: name || server,
		type: "shadowsocks",
		server,
		port,
		raw: {
			type: "shadowsocks",
			name: name || server,
			server,
			port,
			method,
			password
		}
	};
}
/** One protocol link line -> node (GoProxy parseProxyLink). */
function parseProxyLink(link) {
	const value = link.trim();
	if (value.startsWith("vmess://")) return parseVmessLink(value);
	if (value.startsWith("vless://")) return parseStandardLink(value, "vless");
	if (value.startsWith("trojan://")) return parseStandardLink(value, "trojan");
	if (value.startsWith("ss://")) return parseShadowsocksLink(value);
	if (value.startsWith("hysteria2://") || value.startsWith("hy2://")) return parseStandardLink(value, "hysteria2");
	if (value.startsWith("tuic://")) return parseStandardLink(value, "tuic");
	return null;
}
/** Protocol-link document -> nodes (skipping unparsable lines). */
function parseProxyLinks(content) {
	const nodes = [];
	let skipped = 0;
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const node = parseProxyLink(line);
		if (node) nodes.push(node);
		else skipped += 1;
	}
	return {
		nodes,
		skipped
	};
}
/** GoProxy parsePlain: bare host:port lines (direct http/socks5 nodes). */
function parsePlainAddresses(content) {
	const nodes = [];
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		let protocol = "http";
		let address = line;
		const scheme = /^([a-z0-9+.-]+):\/\//i.exec(line);
		if (scheme) {
			const name = scheme[1].toLowerCase();
			address = line.slice(scheme[0].length);
			if (name === "socks5" || name === "socks4" || name === "socks5h") protocol = "socks5";
			else if (name !== "http" && name !== "https") continue;
		}
		const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(address);
		if (!match) continue;
		const port = Number(match[2]);
		if (port < 1 || port > 65535) continue;
		const server = match[1].replace(/^\[|\]$/g, "");
		nodes.push({
			name: address,
			type: protocol,
			server,
			port,
			raw: {
				type: protocol,
				server,
				port
			}
		});
	}
	return nodes;
}
/**
* Parse a subscription body with format auto-detection (GoProxy
* parseAutoDetect, same probe order). Never throws: unknown formats report
* zero nodes with `detected` left as the closest guess.
*/
function parseSubscription(content) {
	const trimmed = content.trim();
	if (trimmed === "") return {
		nodes: [],
		detected: "plain",
		skipped: 0
	};
	if (looksLikeYaml(trimmed)) {
		const { nodes, skipped } = parseClashYaml(trimmed);
		if (nodes.length > 0) return {
			nodes,
			detected: "clash-yaml",
			skipped
		};
	}
	if (looksLikeProxyLinks(trimmed)) {
		const { nodes, skipped } = parseProxyLinks(trimmed);
		if (nodes.length > 0) return {
			nodes,
			detected: "proxy-links",
			skipped
		};
	}
	const decoded = tryBase64Decode(trimmed);
	if (decoded !== null) {
		if (looksLikeYaml(decoded)) {
			const { nodes, skipped } = parseClashYaml(decoded);
			if (nodes.length > 0) return {
				nodes,
				detected: "base64:clash-yaml",
				skipped
			};
		}
		if (looksLikeProxyLinks(decoded)) {
			const { nodes, skipped } = parseProxyLinks(decoded);
			if (nodes.length > 0) return {
				nodes,
				detected: "base64:proxy-links",
				skipped
			};
		}
		const plain$1 = parsePlainAddresses(decoded);
		if (plain$1.length > 0) return {
			nodes: plain$1,
			detected: "plain",
			skipped: 0
		};
	}
	const plain = parsePlainAddresses(trimmed);
	if (plain.length > 0) return {
		nodes: plain,
		detected: "plain",
		skipped: 0
	};
	return {
		nodes: [],
		detected: "plain",
		skipped: 0
	};
}

//#endregion
//#region src/paths.ts
/**
* The plugin's on-disk state root — `~/.opencode-zen` unless overridden.
*
* Everything the plugin persists outside the host lives under here: the usage
* ledger (`usage.json`), the catalog status (`adapter-status.json`), the
* sing-box runtime dir, and the sidecar's config paths. `OPENCODE_ZEN_HOME`
* redirects the whole root, which is what a test that drives the REAL entry
* (`apply()`) needs: the production wiring installs the production ledger, so
* without a redirect a test run writes the user's own 流量统计 (live bug
* 2026-10-14: the watchdog scenarios stream a sample request through
* `apply()`, and every `pnpm test` added a row to the user's ledger — 36
* phantom "hi" requests by the time it was spotted).
*
* Mirrors `adapter/messages.ts`'s `DSH_HOME` handling: read the env lazily, so
* a caller that sets it after import (tests) still gets the redirect.
*/
function stateDir() {
	const configured = process.env.OPENCODE_ZEN_HOME?.trim();
	if (configured) return configured;
	return join(homedir(), ".opencode-zen");
}

//#endregion
export { createRotateDelegate as a, shouldRotate as c, classifyStreamFailure as i, DEFAULT_SUBSCRIPTION_USER_AGENT as n, isRegionBlocked as o, parseSubscription as r, setRotateDelegate as s, stateDir as t };