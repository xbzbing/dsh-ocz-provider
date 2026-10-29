import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "yaml";
import net from "node:net";

//#region src/pool/rotate.ts
let delegate = null;
/** Install the runtime's rotate delegate (startIpPool). */
function setRotateDelegate(next) {
	delegate = next;
}
/** Ask the installed delegate; false when no pool is running. */
function shouldRotate(failure, model, session, attempt, deterministic = false, abusive = false) {
	return delegate?.decide(failure, model, session, attempt, deterministic, abusive) ?? false;
}
/**
* True when the refusal blames the exit's ADDRESS rather than the request:
* OpenCode's network-reputation answer —
* "OpenCode's free models aren't available from your current network because
* we've detected abusive traffic from this IP address. … If you're on a VPN or
* proxy, turn it off and try again". Distinct from the other 403 the lane
* sends ("…can only be used from within OpenCode"), which is about the request
* shape and is identical from every address: this one is a property of the
* exit and outlives any rotation, so the pool benches the exit instead of
* treating it like a moment-to-moment refusal (docs/ip-pool.md §3.2).
*/
function isIpReputationRefusal(errorMessage) {
	return /abusive traffic|this ip address/i.test(errorMessage);
}
/** Map a pi-ai error message to the failure taxonomy (adapter-side parse). */
function classifyStreamFailure(errorMessage) {
	const text = errorMessage.toLowerCase();
	if (/\b429\b|rate.?limit|freeusagelimit/.test(text)) return "limited";
	if (/\b(?:401|403)\b/.test(text)) return "refused";
	if (/stream ended (?:before|without)\b/.test(text)) return "transport";
	if (/\bwebsocket\b|other side closed|http2 request did not get a response/.test(text)) return "transport";
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
	return { decide(failure, model, session, attempt, deterministic = false, abusive = false) {
		const failedExit = pool.exitOfSession(session);
		if (abusive && failedExit !== null) pool.markAbusive(failedExit);
		if (deterministic && failedExit !== null) pool.markModelBanned(failedExit, model);
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
* time (docs/ip-pool.md §4.6 records which versions answered what). The
* default stays in the Clash-Verge family on purpose: the family is what
* selects the returned format, so switching families would silently change
* every other airport's body shape. `ipPool.subscription.userAgent` overrides
* it without a release.
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
		document = parse(content);
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
* The plugin's on-disk state root — `~/.dsh/oc2dsh` unless `OC2DSH_HOME`
* redirects it. It lives INSIDE the host's own `~/.dsh` root so one tree holds
* everything this install persists and a profile backup/removal takes the
* plugin's state with it: the usage ledger (`usage.json`), the catalog status
* (`adapter-status.json`), the models.dev catalog cache and the sing-box
* runtime dir. Read the env LAZILY, so a caller that sets it after import (a
* test driving the real `apply()`) still gets the redirect instead of writing
* the user's own ledger.
*
* Mirrors `adapter/messages.ts`'s `DSH_HOME` handling.
*/
function stateDir() {
	const configured = process.env.OC2DSH_HOME?.trim();
	if (configured) return configured;
	return join(homedir(), ".dsh", "oc2dsh");
}

//#endregion
//#region src/pool/protocol.ts
/** host:port out of `host:port`, `http://host:port` or `socks5://host:port`. */
function proxyEndpoint(address) {
	const trimmed = address.trim().replace(/^[a-z0-9]+:\/\//i, "");
	const slash = trimmed.indexOf("/");
	const authority = slash === -1 ? trimmed : trimmed.slice(0, slash);
	const lastColon = authority.lastIndexOf(":");
	if (lastColon <= 0) return null;
	const host = authority.slice(0, lastColon).replace(/^\[|\]$/g, "");
	const port = Number(authority.slice(lastColon + 1));
	if (host === "" || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
	return {
		host,
		port
	};
}
/** One connect-and-read probe: true when the reply satisfies `want`, false on
*  timeout, socket error or close-before-answer. */
function probeBytes(endpoint, payload, want, timeoutMs) {
	return new Promise((resolve$1) => {
		let settled = false;
		const socket = net.connect({
			host: endpoint.host,
			port: endpoint.port
		});
		const finish = (value) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve$1(value);
		};
		socket.setTimeout(timeoutMs, () => finish(false));
		socket.once("error", () => finish(false));
		socket.once("close", () => finish(false));
		socket.once("connect", () => {
			socket.write(payload);
		});
		socket.on("data", (chunk) => finish(want(chunk)));
	});
}
/** SOCKS5 servers answer the method negotiation with `05 <method>`. */
function probeSocks(endpoint, timeoutMs) {
	return probeBytes(endpoint, Buffer.from([
		5,
		1,
		0
	]), (first) => first.length >= 2 && first[0] === 5, timeoutMs);
}
/**
* HTTP proxies answer the CONNECT verb with a status line. The target is
* documentation-reserved (RFC 5737) and never dialled by a well-behaved proxy
* for a detection probe; a 407/403/502 reply is just as good a signature as
* 200, because only an HTTP proxy can emit it at all.
*/
function probeHttp(endpoint, timeoutMs) {
	return probeBytes(endpoint, Buffer.from("CONNECT 203.0.113.1:443 HTTP/1.1\r\nHost: 203.0.113.1:443\r\n\r\n", "latin1"), (first) => first.length >= 5 && first.subarray(0, 5).toString("latin1") === "HTTP/", timeoutMs);
}
/**
* Detect the protocol of one listener, or null when nothing usable answers.
*
* null is a first-class answer: the caller must NOT guess in that case (an
* unreachable listener is a pin to refuse, not a row to relabel).
*/
async function detectProxyProtocol(address, options = {}) {
	const endpoint = proxyEndpoint(address);
	if (endpoint === null) return null;
	const timeoutMs = options.timeoutMs ?? 1200;
	if (await probeSocks(endpoint, timeoutMs)) return "socks5";
	if (await probeHttp(endpoint, timeoutMs)) return "http";
	return null;
}

//#endregion
export { classifyStreamFailure as a, isRegionBlocked as c, parseSubscription as i, setRotateDelegate as l, stateDir as n, createRotateDelegate as o, DEFAULT_SUBSCRIPTION_USER_AGENT as r, isIpReputationRefusal as s, detectProxyProtocol as t, shouldRotate as u };