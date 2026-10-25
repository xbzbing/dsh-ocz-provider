import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

//#region src/request-headers.ts
const HEADER_NAME = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/;
/** Headers the plugin owns: authentication, cookies, framing and body format. */
const MANAGED_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
	"host",
	"connection",
	"proxy-connection",
	"content-length",
	"transfer-encoding",
	"upgrade",
	"trailer",
	"te",
	"expect",
	"content-type",
	"content-encoding",
	"accept-encoding"
]);
const MAX_HEADERS = 32;
const MAX_BYTES = 8192;
/** One accepted entry, or undefined when the pair must be dropped. */
function accept(rawName, rawValue) {
	if (typeof rawName !== "string") return void 0;
	const name = rawName.toLowerCase();
	if (!HEADER_NAME.test(name) || MANAGED_HEADERS.has(name)) return void 0;
	if (typeof rawValue !== "string" || !HEADER_VALUE.test(rawValue)) return void 0;
	const value = rawValue.trim();
	if (value === "") return void 0;
	return [name, value];
}
/**
* Lenient boundary: every request, where a bad entry must never break the wire
* call. Invalid names, managed headers, blanks and oversize dictionaries are
* dropped instead of thrown, so a hand-edited profile patch cannot inject
* `authorization`/`cookie`/framing headers, and cannot fail a request either.
*/
function sanitizeRequestHeaders(input) {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
	const sanitized = /* @__PURE__ */ new Map();
	let size = 0;
	for (const [rawName, rawValue] of Object.entries(input)) {
		if (sanitized.size >= MAX_HEADERS) break;
		const pair = accept(rawName, rawValue);
		if (pair === void 0) continue;
		const [name, value] = pair;
		if (sanitized.has(name)) continue;
		const next = size + name.length + value.length + 4;
		if (next > MAX_BYTES) break;
		size = next;
		sanitized.set(name, value);
	}
	return Object.fromEntries(sanitized);
}

//#endregion
//#region src/adapter/ids.ts
function randomID(prefix, size) {
	return `${prefix}_${randomBytes(size).toString("hex")}`;
}
/**
* The conversation signal: JSON of the first user message's content. Using the
* first user turn keeps a multi-turn conversation stable as its history grows
* while separating conversations with different beginnings (ids.go:59-76).
*/
function conversationSeed(messages) {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const encoded = JSON.stringify(message.content ?? null);
		if (encoded !== "null" && encoded.length > 0) return encoded;
	}
	return "";
}
/**
* A readable label for one conversation: its first user turn, flattened and
* truncated. The usage ledger's top-session list is unusable without one —
* `ses_9f2c…` says nothing about which conversation burned the tokens (live
* request 2026-10-14). Text blocks are concatenated; images and tool results
* contribute nothing.
*/
function conversationLabel(messages, limit = 64) {
	const seed = conversationSeed(messages);
	if (seed === "") return "";
	let text = "";
	try {
		const parsed = JSON.parse(seed);
		if (typeof parsed === "string") text = parsed;
		else if (Array.isArray(parsed)) {
			for (const block of parsed) if (block?.type === "text" && typeof block.text === "string") text += ` ${block.text}`;
		}
	} catch {
		text = seed;
	}
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat === "") return "";
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
/**
* The project id sent upstream. `ProjectID` in the client is a PLAIN string —
* `"global"` for a directory that is not a git worktree, otherwise a 40-hex
* sha1 (live-observed `global` and `c956d9742c6f72c5f22ab1c75bd9b47ad294161c`).
* It has no prefix: the client's id prefix table lists job/event/session/
* message/permission/question/part/pty/tool/workspace and NOT project. The
* `prj_<24hex>` this adapter used to mint is now a rejection signal —
* live-probed 2026-10-14 against `/inference/v1` with an otherwise-passing
* request: `prj_*` -> 403 FreeTierError, `global` / a 40-hex id / the header
* omitted -> 200. The adapter has no worktree, so it sends what the client
* sends for a non-git directory.
*
* The 40-hex derivation, pinned 2026-10-22 by static extraction of the 2.1.3
* `opencode-cli` and confirmed by recomputing the observed value: for a git
* repo it prefers `sha1("git-remote:" + host + "/" + path)` of the normalized
* `origin` URL (`git@github.com:xbzbing/dsh-git-panel.git` ->
* `github.com/xbzbing/dsh-git-panel` -> `c956d974…`), falling back to the
* repo's oldest root commit; a non-git directory hashes
* `sha1("directory:" + absPath)`; `"global"` is now only the no-VCS fallback.
* The adapter keeps `global` — a legitimate client value in the gate's
* accepted set — rather than fabricating a directory hash for a path the
* upstream has never seen. Decision re-affirmed 2026-10-24: the workspace
* dimension stays as-is (no login, no project hash), and the 2.1.4 probe
* confirmed `global` still passes the gate alongside a 40-hex id and even
* with the project header omitted entirely.
*/
const DEFAULT_PROJECT_ID = "global";
/**
* Derive the correlation ids for one upstream request. In adapter mode there
* are no inbound opencode headers, so the seed is the conversation itself.
*
* `request` (a `msg_*` id) is still minted but NO LONGER SENT: the 2.x
* client's wire carries no `x-opencode-request` header (byte-capture
* 2026-10-24). It stays in the record because the pool's admission probe
* reuses the same shape-checked minter and because `req_*` remains a
* documented rejection signal if the header ever has to come back.
* `x-opencode-project` must be the prefix-less project id above.
*/
function deriveRequestIDs(messages) {
	let signal = conversationSeed(messages);
	if (signal === "" || signal === "{}") signal = randomID("fallback", 16);
	return {
		session: canonicalSessionID(signal),
		request: mintedMessageID(),
		project: DEFAULT_PROJECT_ID,
		parentSession: ""
	};
}
/**
* OpenCode's canonical session shape: "ses_" + 12 lowercase hex timestamp
* characters + 14 Base62 characters. Since 2026-09-16 the Zen free tier
* rejects any other session shape with 403 FreeTierError ("free tier can
* only be used from within OpenCode") — the plain User-Agent gate stopped
* being sufficient (upstream fix: jasonxu114514/opencode2api 8185202).
* Live-probed 2026-09-18: the gate has a second, body-shape half (streaming
* + bash/read tools, adapter/messages.ts); both must pass.
*
* Since 2026-10-13 the tier additionally DECODES the 12 hex characters as an
* inverted millisecond timestamp, ~(unix_ms*0x1000+counter) in its low 48
* bits (upstream fixes: jasonxu114514/opencode2api PR #69, then PR #70; the
* same defect in decolua/9router is issue #4780). Two rules, both re-probed
* live 2026-10-15 against /inference/v1 with the full gate body and this
* adapter's header set, one variable at a time:
*
*   1. the word must be INVERTED — a digest-shaped or ascending prefix 403s;
*   2. the 12-bit counter must land in 0-63. After the inversion the low 12
*      bits read 0xFFF-counter, so anything below 0xFC0 403s: counters 0, 1,
*      32 and 63 -> 200, counters 64 and 128 -> 403. The timestamp half is
*      not checked at all — a prefix decoding to ts36=1 (epoch+1ms) -> 200.
*
* So a clock-derived counter dies after 64 mints in a long-lived process
* (exactly what PR #70 replaced), and this adapter mints often: one session
* per new conversation AND one per pool exit address (pool/admission.ts), so
* a single refill round could burn the window and 403 every session minted
* afterwards. The prefix is therefore DERIVED FROM THE DIGEST with counter 1
* — always inside the window, stateless, and one conversation keeps one id
* even across restarts (PR #70's encoding; the in-memory cache it replaces
* could not do that).
*/
const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
/**
* How far the decoded timestamp of an inbound session id may sit from now and
* still be treated as the client's own. Measured 2026-10-25 (Bun egress, one
* variable per request): a minted prefix decoding to now / now-1h / now-1d /
* now-7d / now-30d -> 200; a prefix decoding to a FUTURE time (+30d) -> 429;
* and every prefix whose timestamp is effectively random (raw random bytes, or
* this adapter's own digest-derived prefix) -> 429. So the window is
* "recent past", and the future side is the one that must stay tight.
*/
const SESSION_TS_MAX_AGE_MS = 720 * 60 * 60 * 1e3;
/** Allowed clock skew into the future (a client a few seconds ahead still passes). */
const SESSION_TS_MAX_SKEW_MS = 3600 * 1e3;
/** The 36-bit timestamp field the inverted word carries (2^36 ms ≈ 2.2 years). */
const SESSION_TS_MASK = (1n << 36n) - 1n;
/** The 12-bit counter the mint appends (1-based: counter 0 was rejected, 2026-10-25). */
const SESSION_COUNTER_MAX = 4095;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function base62Fixed(value, width) {
	const base = 62n;
	let n = value;
	const out = new Array(width);
	for (let i = width - 1; i >= 0; i--) {
		out[i] = BASE62_ALPHABET.charAt(Number(n % base));
		n /= base;
	}
	return out.join("");
}
/** The low 6 bytes of a 48-bit id word, lowercase hex (the client's carry width). */
function hex48(value) {
	let hex = "";
	for (let bit = 40; bit >= 0; bit -= 8) hex += Number(value >> BigInt(bit) & 255n).toString(16).padStart(2, "0");
	return hex;
}
/**
* The 12 hex characters of a descending session id for one timestamp+counter:
* `~(unix_ms * 0x1000 + counter)` in the low 48 bits, so newer ids sort first.
*
* The value is CLOCK-BASED on purpose (see {@link canonicalSessionID}): the
* lane decodes this field and refuses a timestamp it cannot believe, so a
* digest-derived "timestamp" — which is what this adapter used to mint — is a
* rejection signal even though its counter sits in the old accepted window.
*/
function descendingTimePrefix(ms, counter) {
	return hex48(~(BigInt(ms) << 12n | BigInt(counter & SESSION_COUNTER_MAX)) & (1n << 48n) - 1n);
}
/** The 36-bit timestamp an inverted prefix decodes to, or null when it is not inverted. */
function decodedSessionTime(field) {
	if (!/^[0-9a-f]{12}$/.test(field)) return null;
	const word = ~BigInt("0x" + field) & (1n << 48n) - 1n;
	return Number(word >> 12n & SESSION_TS_MASK);
}
/**
* Is this a session id the client itself could have minted just now — the right
* shape, an inverted (descending) word, and a timestamp inside the window the
* lane enforces? Such an id is passed through so its upstream affinity (and the
* prompt cache keyed on it) survives; anything else is re-minted.
*/
function isFreshSessionID(id) {
	if (!CANONICAL_SESSION_PATTERN.test(id)) return false;
	const ms = decodedSessionTime(id.slice(4, 16));
	if (ms === null) return false;
	const delta = signedDelta(Number(BigInt(Date.now()) & SESSION_TS_MASK), ms);
	return delta >= -SESSION_TS_MAX_AGE_MS && delta <= SESSION_TS_MAX_SKEW_MS;
}
/** `to - from` on a 2^36 clock, normalized to the shorter arc. */
function signedDelta(from, to) {
	const span = 2 ** 36;
	const half = span / 2;
	let delta = (to - from) % span;
	if (delta > half) delta -= span;
	if (delta < -half) delta += span;
	return delta;
}
/** Clock state for the ascending message-id prefix (kept apart from sessions). */
let messageCounter = 0;
/**
* A `msg_*` request id, shaped exactly like the client's
* `Session.Message.ID.create()`: `"msg_" + ascending()`, where the ascending
* scheme is the same `unix_ms * 0x1000 + counter` low-48-bit encoding as the
* session prefix WITHOUT the inversion, plus a random Base62 tail. The gate
* only ever sees it as the `x-opencode-request` header, so the tail carries no
* affinity: one fresh id per request is what the client does (`input.user.id`
* is that request's own user turn). Unlike the session word, this one is not
* decoded by the gate at all — live-probed 2026-10-15: counters 64 and 4095,
* ts36=1, an inverted word and a junk tail all return 200 — so the process
* counter behind it can never walk out of a window.
*/
function mintedMessageID() {
	messageCounter = messageCounter + 1 & 4095;
	return `msg_${hex48(BigInt(Date.now()) * 4096n + BigInt(messageCounter))}${base62Fixed(BigInt("0x" + randomBytes(10).toString("hex")), 14)}`;
}
/**
* The session id sent upstream.
*
* RE-MEASURED 2026-10-25 — the prefix rule changed a third time, and this one
* is not a window on the counter. With the request otherwise byte-identical
* (Bun egress, the `<env>`-shaped body, the official 16 headers), only the
* session id varied:
*
*   `ses_e9345d865ffe…` (the 2.1.4 capture, minted 10-24)  -> 200
*   minted now / now-1h / -1d / -7d / -30d                  -> 200
*   minted now+30d, or now-90d (which wraps into the future) -> 429
*   this adapter's digest-derived prefix                     -> 429
*   raw random 12-hex prefixes                               -> 429
*   all-zero prefix (decodes to 2^36-1)                      -> 200 (sentinel)
*   counters 1, 32, 63, 64, 128, 4095 on a fresh timestamp    -> 200; counter 0 -> 429
*
* So the lane DECODES the timestamp and refuses one it cannot believe, while
* the counter window that PR #69/#70 chased (0-63, counters 64+ 403) is gone.
* The digest-derived prefix those releases introduced — this adapter shipped
* it — therefore rejects every request with 429 FreeUsageLimitError, which is
* indistinguishable from a spent quota: that is why the fix looked like a
* connection-stack problem long after the relay was passing 200s.
*
* The mint is consequently CLOCK-BASED again: `~(unix_ms * 0x1000 + counter)`,
* counter 1-based and per-process monotonic (0 was rejected, wide values
* passed, so the counter is only a sort tiebreak now). The 14-char Base62 tail
* stays DIGEST-DERIVED, so one conversation still keeps one id and its
* prompt-cache affinity — the prefix carries no identity, only freshness.
*
* Stability: an id is cached per signal for the life of the process (the lane
* only accepts a fresh timestamp, so a conversation restarted days later must
* mint a new id — the same thing the official client does per session). An
* inbound id that is already canonical AND fresh passes through untouched.
*/
const sessionCache = /* @__PURE__ */ new Map();
/** Cap on the per-process cache: conversation ids are small, but unbounded is unbounded. */
const SESSION_CACHE_LIMIT = 512;
let sessionCounter = 0;
function canonicalSessionID(signal) {
	const cached = sessionCache.get(signal);
	if (cached !== void 0) return cached;
	const id = isFreshSessionID(signal) ? signal : mintSessionID(signal);
	if (sessionCache.size >= SESSION_CACHE_LIMIT) {
		const oldest = sessionCache.keys().next();
		if (oldest.done !== true) sessionCache.delete(oldest.value);
	}
	sessionCache.set(signal, id);
	return id;
}
/** The digest tail plus a freshly minted prefix (never a random "timestamp"). */
function mintSessionID(signal) {
	const randomPart = CANONICAL_SESSION_PATTERN.test(signal) ? signal.slice(16) : base62Fixed(BigInt("0x" + createHash("sha256").update("ses\0" + signal).digest().subarray(6, 16).toString("hex")), 14);
	sessionCounter = sessionCounter % SESSION_COUNTER_MAX + 1;
	return `ses_${descendingTimePrefix(Date.now(), sessionCounter)}${randomPart}`;
}
/**
* The User-Agent override from plugin config (`userAgent`). Empty = the
* built-in value below. Module state on purpose: the three senders (the chat
* adapter, the model catalog and the pool's admission probes) all call
* {@link opencodeUserAgent} at request time, so one setting moves every wire
* request without threading it through four signatures.
*/
let userAgentOverride = "";
let readRequestHeaders;
/** Read the Loader's stable reference on each request, never cache a snapshot. */
function setRequestHeadersReader(reader) {
	readRequestHeaders = reader;
	return () => {
		if (readRequestHeaders === reader) readRequestHeaders = void 0;
	};
}
/**
* The built-in Zen User-Agent: the shape the current (2.x) client sends,
* `opencode/<channel>/<version>/<client>`.
*
* Static extraction of OpenCode Desktop 2.0.32 put the builder at
* `opencode/${channel}/${version}/${name}`, where `name` is the SAME value the
* client puts in its `x-opencode-client` header (`opencode/latest/2.0.32/desktop`
* was captured live on its wire the same night). Re-extracted 2026-10-22 from
* Desktop 2.1.3 and its bundled `opencode-cli` (Bun binary, JS in cleartext):
* the builder and its wiring are unchanged — version const "2.1.3", channel
* "latest", default name "cli", and the Electron shell still spawns the CLI
* with `OPENCODE_CLIENT=desktop`, so a real Desktop now sends
* `opencode/latest/2.1.3/desktop` (its local server log confirms
* `cli starting version=2.1.3 channel=latest`). The gate does not pin the UA
* string, but it does read fingerprint coherence, so the string is derived from
* the effective client flag rather than frozen with one segment: the Desktop
* toggle moves both spellings together.
*
* Live-probed 2026-10-17 against /inference/v1 through a non-CN egress, the v1
* recipe held constant (bash+read gate tools, `x-opencode-request: msg_*`,
* project `global`, no `x-session-affinity`): `opencode/latest/2.0.32/desktop`
* with client `desktop` -> 200 and `opencode/latest/2.0.32/cli` with client
* `cli` -> 200, both live SSE streams. Moving this string alone is therefore
* NOT a generation mix; the previous built-in was the 1.18.x CLI string
* `opencode/1.18.31 (<platform> <arch>; node<ver>)`.
*
* Re-probed 2026-10-23 against /inference/v1 through a Tokyo egress (local
* HTTP proxy), one variable at a time — same session id (digest-stable), same
* body, same bash+read tools: `opencode/latest/2.0.32/cli` -> 200,
* `opencode/latest/2.1.3/cli` -> 200 and `opencode/latest/2.1.3/desktop` ->
* 200, all live SSE on mimo-v2.6-flash-free. The version bump therefore rides
* the same proven-safe UA-only dimension.
*
* The CURRENT value tracks the installed client byte-for-byte: the 2.1.4
* CLI's own loopback capture (2026-10-24, `docs/local/capture-214/`) sent
* `user-agent: opencode/latest/2.1.4/cli` with `x-opencode-client: cli`.
*/
const ZEN_UA_CHANNEL = "latest";
const ZEN_UA_VERSION = "2.1.4";
/** `x-opencode-client` value the client uses when no mode toggle is set. */
const DEFAULT_ZEN_CLIENT = "cli";
/** The built-in User-Agent for one `x-opencode-client` value. */
function zenUserAgent(client = DEFAULT_ZEN_CLIENT) {
	return `opencode/${ZEN_UA_CHANNEL}/${ZEN_UA_VERSION}/${client}`;
}
/**
* Case-insensitive header merge: a later set wins, and a differently-cased
* spelling of the same name collapses instead of riding out twice (HTTP names
* are case-insensitive). Live overrides already arrive lowercased from
* `sanitizeRequestHeaders`; this gives caller-supplied base sets the same
* behaviour, which is what keeps the derived User-Agent coherent with the
* `x-opencode-client` the request actually carries.
*/
function mergeHeaders(...sets) {
	const merged = {};
	for (const set of sets) for (const [name, value] of Object.entries(set)) {
		const key = name.toLowerCase();
		for (const existing of Object.keys(merged)) if (existing.toLowerCase() === key) delete merged[existing];
		merged[key] = value;
	}
	return merged;
}
/** Common merge for chat, catalog and admission; caller-owned transport headers stay intact. */
function zenRequestHeaders(base = {}) {
	const merged = mergeHeaders({ "x-opencode-client": DEFAULT_ZEN_CLIENT }, base, sanitizeRequestHeaders(readRequestHeaders?.() ?? {}));
	return {
		"user-agent": userAgentOverride || zenUserAgent(merged["x-opencode-client"] ?? DEFAULT_ZEN_CLIENT),
		...merged
	};
}
/**
* Set the configured User-Agent. Empty or whitespace restores the built-in
* value, so a cleared field in a profile patch cannot put a blank header on
* the wire.
*/
function setUserAgentOverride(value) {
	userAgentOverride = (value ?? "").trim();
}
/**
* The User-Agent every Zen request carries: the built-in 2.x shape above
* (`opencode/latest/2.1.4/<client>`) unless the `userAgent` config field or a
* live settings override names another string.
*
* The anonymous lane reads a whole FINGERPRINT — this header plus the
* session/project/request id shapes and the tool definitions — so the two ways
* to change it are: move THIS string alone, or move the recipe whole. Live
* 2026-10-15 against /inference/v1 with this adapter's fingerprint held
* constant and one variable at a time, each of these answered 200: the
* built-in value, the installed app's OpenAI/Codex branch string
* (`opencode/1.19.0 (darwin 27.0.0; arm64)`, extracted from `app.asar`)
* and upstream's 2.x shape (`opencode/latest/2.0.29/cli`). The
* gate does not pin the UA string. What still 403s is mixing GENERATIONS
* inside one request — 2.x tool names under this header set, or upstream's
* header set carrying our `x-opencode-request` ({@link disguiseHeaders}).
*/
function opencodeUserAgent() {
	return zenRequestHeaders()["user-agent"];
}
/**
* The full disguise header set sent with every upstream request
* (design.md 2.4; gateway.go newUpstreamRequest), now the official 2.1.4
* client's own set — byte-captured 2026-10-24 by driving the installed
* `opencode-cli 2.1.4` against a loopback server (16 headers logged, nothing
* left 127.0.0.1). The client sends exactly:
*
*   authorization: Bearer public      content-type: application/json
*   user-agent: opencode/latest/2.1.4/cli      accept: `*` + `/` star
*   b3: <trace>-<span>-1-<parent>     traceparent: 00-<trace>-<span>-01
*   x-opencode-client: cli
*   x-opencode-project: <40-hex | global>
*   x-opencode-session / x-opencode-session-id /
*   x-session-affinity / x-session-id   (all four = the same ses_* id)
*
* and NO `x-opencode-request` — the header is absent repo-wide in 2.1.3 and
* 2.1.4 (static extraction) and absent from this capture. This set therefore
* carries the four session spellings and drops `x-opencode-request`, which is
* the reverse of the 1.x generation's rule below.
*
* HISTORY (each point live-probed against `/inference/v1`):
*   - 2026-10-14, 1.x generation: the client sent only `x-opencode-session` +
*     `x-opencode-session-id` + `x-opencode-request` for its `opencode`
*     provider, and adding `x-session-affinity`/`X-Session-Id` -> 403: the
*     affinity pair marked a FOREIGN client under that fingerprint;
*   - 2026-10-15: that was fingerprint COHERENCE, not an allow-list —
*     replaying upstream's 2.x recipe (all four spellings, 40-hex project,
*     2.x tool names) also answered 200, while mixing the generations 403'd
*     every time;
*   - 2026-10-24, 2.x generation (this set, one variable per request through
*     a pool exit where the gate answers before the quota layer: 429 =
*     gate PASSED, 403 = gate REJECTED): the whole 2.1.4 recipe -> 429;
*     minus the affinity pair -> 429; plus `x-opencode-request` -> 429;
*     UA `2.1.3` -> 429; project 40-hex -> 429; project header omitted ->
*     429; `ses_short` session id -> 403 (calibration). On that day the only
*     live rejection signals were a malformed session id and a `tools` array
*     without a `read` entry (adapter/gate-tools.ts) — but the RECIPE is
*     still shipped whole, because that is what has stayed green while the
*     gate flipped five times;
*   - 2026-10-25: the window reopened and the DISCRIMINATOR moved with it.
*     The official `opencode-cli 2.1.4` (Bun) answered a real 200 from this
*     machine — direct AND through pool exit `127.0.0.1:30033` — while a
*     byte-identical replay (these 16 captured headers, the captured body,
*     the official family path) answered 429 FreeUsageLimitError from Node
*     h1, Node h2, curl 8.7 h2, Python urllib and Go net/http, on every
*     egress tried (direct v4/v6, the CLI's own ULA source address, 7 pool
*     exits). Header set, body, route, `accept-encoding`, HTTP version and
*     source IP are each ruled out one variable at a time, and a local-CA TLS
*     capture shows the live https request carries no extra header or cookie.
*     So 403 still reads as SHAPE REJECTED, but 429 no longer reads as
*     QUOTA SPENT: a CONNECTION-STACK gate (the client's TLS/HTTP
*     fingerprint) now sits in front of the quota layer, and no payload edit
*     reaches it (matrix in adapter/gate-tools.ts; probes under
*     `docs/local/capture-214/`). RESOLVED the same day — the gate has a
*     second payload half nobody had seen: the system prompt must carry a
*     non-empty `<env>` block (adapter/env-block.ts), and the request must
*     leave through Bun's stack (src/relay/). Either half missing still reads
*     as a 429, which is why "quota spent" was the wrong diagnosis for a week.
*     These headers are unchanged by that fix: the relay re-originates the
*     CONNECTION, not the request.
*
* The OTel pair (`b3`/`traceparent`) is deliberately NOT fabricated: the
* client mints it per request from its tracer, the gate ignores it (this set
* passed without it on 2026-10-24), and a hand-rolled trace id would be one
* more shape to keep coherent for no measured benefit.
*/
function disguiseHeaders(ids) {
	return zenRequestHeaders({
		"x-opencode-session": ids.session,
		"x-opencode-session-id": ids.session,
		"x-session-affinity": ids.session,
		"x-session-id": ids.session,
		"x-opencode-project": ids.project
	});
}

//#endregion
//#region src/adapter/lane.ts
/**
* The free lane's ORIGINS — one recipe, two doors.
*
* OpenCode serves the anonymous free lane from two origins that accept the
* SAME fingerprint (headers, ids, tools):
*
*   https://opencode.ai/inference   the 2.x client's origin, primary
*   https://opencode.ai/zen         the 1.x console origin, live again
*
* Measured 2026-10-19 13:32-13:45 +08:00, single variable per request, the
* captured adapter bytes replayed: `/zen/v1/chat/completions` answered 200 SSE
* to the SAME body, headers and UA that `/inference/v1` answered 200 to, with
* no redirect (`redirect: 'manual'` also 200), on two models (mimo-v2.6-flash-free,
* big-pickle), and `/zen/v1/models` kept listing all 85 models. That
* contradicted this repository's 2026-10-14 note that `/zen/v1` refuses every
* shape — the lane had simply moved back into service, which is why the
* ladder below exists rather than a hard-coded single base.
*
* The ladder is NOT a second recipe: the request bytes never change, only the
* origin they are sent to, so it cannot trip the gate's generation-coherence
* check (ids.ts `disguiseHeaders`). A failover costs one round trip and is
* only spent on an origin-level answer — a gate refusal (401/403) or a 5xx
* from the edge — never on a 429 (an exit/IP-shaped limit: rotating the exit
* is the right cure) or on a transport error (egress-shaped).
*
* Failover also covers the SENDERS BESIDE THE CHAT: the catalog listing
* (`/v1/models`) and the pool's admission smoke both speak to the same lane,
* so they walk the same ladder — an exit that only reaches one of the two
* origins must not be marked dead by the other (pool/admission.ts).
*/
/** The 2.x client's origin (catalog.ts `ZEN_BASE_URL`), tried first. */
const ZEN_PRIMARY_BASE_URL = "https://opencode.ai/inference";
/** The console origin, live again since 2026-10-19; the ladder's second rung. */
const ZEN_FALLBACK_BASE_URL = "https://opencode.ai/zen";
/** The known lane origins, primary first — the ladder's default contents. */
const ZEN_LANE_ORIGINS = [ZEN_PRIMARY_BASE_URL, ZEN_FALLBACK_BASE_URL];
function normalizeOrigin(origin) {
	return origin.trim().replace(/\/+$/, "");
}
/**
* The ordered origins one lane request walks.
*
* `primary` is whatever the caller resolved (the `zenBaseUrl` seam, default
* `https://opencode.ai/inference`). The fallback rung is added ONLY when the
* primary is itself a known lane origin: a base a test or an operator points
* somewhere else must be used alone, or an injected fixture would suddenly
* reach the live console behind its back. Passing `fallback` explicitly
* overrides that rule, which is how the tests drive a two-rung ladder without
* touching the network.
*/
function laneOrigins(primary, fallback) {
	const first = normalizeOrigin(primary);
	if (first === "") return [];
	const explicit = fallback === void 0 ? void 0 : normalizeOrigin(fallback);
	if (explicit !== void 0) return explicit === "" || explicit === first ? [first] : [first, explicit];
	if (!ZEN_LANE_ORIGINS.includes(first)) return [first];
	return [first, ...ZEN_LANE_ORIGINS.filter((origin) => origin !== first)];
}
/**
* True when a failure names the ORIGIN rather than the exit: the gate refusing
* the request outright (401/403, the `FreeTierError` body), the edge itself
* failing (5xx), or the door not serving the route at all (404 — upstream
* measured `/inference` without a models route on 2026-10-14). Any of those
* means "ask the other door"; a 429, a timeout or a socket error is
* exit-shaped and stays with the pool's rotation.
*
* The patterns mirror pool/rotate.ts `classifyStreamFailure` (`refused` and the
* 5xx half of `transport`) so the two layers agree on what a refusal is.
*/
function isOriginFailure(errorMessage) {
	const text = errorMessage.toLowerCase();
	if (/regionerror|not available in your country/.test(text)) return false;
	if (/\b(?:401|403|404)\b/.test(text)) return true;
	if (/free tiererror|free tier can only be used from within opencode/.test(text)) return true;
	return /\b5\d\d\b|internal server error|server error|bad gateway|service unavailable/.test(text);
}

//#endregion
//#region src/model-context.ts
/** A window above 16,777,216 tokens is not a real model — reject typos. */
const MAX_CONTEXT_WINDOW = 16777216;
/**
* Floor for an override. Smaller windows make the host's compaction budget
* (`contextWindow - reservedCompletionTokens`) collapse, so they are refused
* instead of producing a session that cannot compact.
*/
const MIN_CONTEXT_WINDOW = 1024;
/** A context override is a hand-written list; more than this is a mistake. */
const MAX_MODEL_CONTEXT_WINDOWS = 128;
/** Model ids are opaque; match everything a Zen id can contain except the
*  separators and whitespace, so a stray space cannot create a phantom id. */
const MODEL_ID = /^[^\s=:]+$/;
const MODEL_ID_MAX = 200;
function validModelId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= MODEL_ID_MAX && MODEL_ID.test(value);
}
function validWindow(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_CONTEXT_WINDOW && value <= MAX_CONTEXT_WINDOW;
}
/**
* Lenient boundary: the catalog and any config read where a bad entry must
* never break a request. Invalid ids, non-integers, out-of-range windows,
* duplicates after trimming and oversize dictionaries are dropped, so a
* hand-edited profile patch cannot arm a broken window either.
*/
function sanitizeModelContextWindows(input) {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
	const sanitized = /* @__PURE__ */ new Map();
	for (const [rawId, rawWindow] of Object.entries(input)) {
		if (sanitized.size >= MAX_MODEL_CONTEXT_WINDOWS) break;
		const id = rawId.trim();
		if (!validModelId(id) || !validWindow(rawWindow) || sanitized.has(id)) continue;
		sanitized.set(id, rawWindow);
	}
	return Object.fromEntries(sanitized);
}

//#endregion
//#region src/adapter/catalog.ts
/**
* Port of agent/internal/catalog (opencode2api models.go + model_metadata.go,
* trimmed to the single anonymous Zen lane) plus the S3 static fallback:
*
*   S1  GET {zen}/v1/models            live catalog (in-sale ids, free or paid)
*   S2  GET https://models.dev/api.json  pricing metadata -> free decision
*   S3  compile-time verified ids       last-resort bootstrap list
*
* /v1/models-equivalent exposure = S1 ∩ S2-allowed (or S3 while S1 is pending).
*/
/**
* The anonymous lane's PRIMARY base URL (every caller appends `/v1`).
*
* It was `https://opencode.ai/zen` until 2026-10-14, when OpenCode moved the
* whole lane — free models included — to `https://opencode.ai/inference/v1`.
* Four independent sources agree: the client's runtime catalog
* (`https://models.opencode.ai/api.json`, read at every boot, whose `opencode`
* provider entry now carries `api: https://opencode.ai/inference/v1`),
* models.dev's `opencode` entry (the same URL), the Console model table at
* `https://opencode.ai/v2/docs/console/models/` (every free id is listed with
* an `/inference/v1/...` endpoint), and the client's own request, captured
* 2026-10-14 from OpenCode Desktop 1.19.0 (a `POST` to
* `/inference/v1/chat/completions` that answered 200).
*
* Live-probed the same day, `/zen/v1` answered 403 FreeTierError to a request
* that passed on `/inference/v1`, so the plugin treated the old lane as closed
* for five days. Re-probed 2026-10-19 (single variable per request, captured
* adapter bytes replayed, two models, both egress families): `/zen/v1` serves
* the SAME recipe again — 200 SSE, no redirect, and its `/v1/models` lists the
* same 85 ids. Both origins are therefore live doors of one lane, which is why
* the base is now the head of a ladder (adapter/lane.ts `laneOrigins`) rather
* than a single hard-coded host. `/zen/v1/models` answering while chat refused
* is also what hid the 2026-10-14 move: the catalog stayed green (and
* `adapter-status.json` reported `ready`) while every chat request failed.
*
* 2026-10-24 (2.1.4 capture + live probe): the CURRENT models.opencode.ai
* feed declares `api: https://opencode.ai/inference/openai/v1` for the
* `opencode` provider — the FAMILY path with an `/openai` segment — and the
* installed 2.1.4 CLI really posts there. Both were probed on the same exit,
* one variable at a time: the family chat path answers exactly like the flat
* one (the same 429 on both in 2026-10-24, read that day as gate-passed with
* the quota spent; re-read 2026-10-25 — a 429 can also be the connection-stack
* gate, adapter/gate-tools.ts), but
* `/inference/openai/v1/models` 404s while `/inference/v1/models` answers 200.
* Since the catalog, the settings card's `/status` and the pool's admission
* probe all share this base, the flat spelling stays: it is the one path that
* serves chat AND catalog, and the gate does not read the route.
*/
const ZEN_BASE_URL = "https://opencode.ai/inference";
/**
* Free-lane blocklist (issue #56 live matrix, 2026-10-10): models the live
* chat lane can never serve. The Zen catalog still lists them, so S1 alone
* exposes dead ids — one exclusion reason per model:
*   exo-free                             410 ModelDeprecated (upstream delisted)
*   jev-1.13-free                        400 ModelProtocolUnsupported (SystemOne-only)
*   ling-3.0-flash-fin-free              400 "Model is unavailable" (upstream-side)
*   muse-spark-1.*-contributor-free      403 RegionError, chat and responses alike
* Remove an entry only after a live probe of the chat lane answers 200/429.
*/
const FREE_LANE_BLOCKLIST = new Set([
	"exo-free",
	"jev-1.13-free",
	"ling-3.0-flash-fin-free",
	"muse-spark-1.2-contributor-free",
	"muse-spark-1.3-contributor-free"
]);
/** Verified against the anonymous lane with a real chat (agent/internal/catalog/static_models.go). */
const staticFreeModels = [
	"big-pickle",
	"mimo-v2.5-free",
	"mimo-v2.6-flash-free",
	"ling-3.0-flash-fin-free",
	"nemotron-3.5-lightning-free",
	"nemotron-3-ultra-free",
	"muse-spark-1.2-contributor-free"
];
function isFreeModel(model) {
	return model.toLowerCase().includes("free");
}
/** Decide (model_metadata.go Decide, ported with the deprecation fix).
*
* The upstream short-circuits on isFreeModel before consulting metadata, so a
* delisted-but-still-cataloged id like deepseek-v4-flash-free stays exposed
* forever. Here the order is: a ready metadata verdict (including deprecated)
* always wins; the name fallback only fires when metadata cannot speak
* (pending or model missing) — its original documented intent (design.md 4.2).
*/
function decide(model, prices, ready) {
	const nameFree = isFreeModel(model);
	const fallback = (source) => {
		if (nameFree) return {
			allowed: true,
			source: "name_free",
			known: false
		};
		return {
			allowed: false,
			source,
			known: false
		};
	};
	if (!ready || prices.size === 0) return fallback("metadata_pending");
	const price = prices.get(model);
	if (!price) return fallback("metadata_model_missing");
	if (price.deprecated) return {
		allowed: false,
		source: "metadata_deprecated",
		known: true
	};
	if (price.input === 0 && price.output === 0) return {
		allowed: true,
		source: nameFree ? "name_and_metadata_free" : "metadata_free",
		known: true
	};
	if (price.input === void 0 || price.output === void 0) return {
		allowed: false,
		source: "metadata_cost_unknown",
		known: false
	};
	return {
		allowed: false,
		source: "metadata_paid",
		known: true
	};
}
/**
* models.dev fields the plugin knowingly overrides (issue #56 metadata note):
* the feed declares `mimo-v2.6-flash-free` with `limit.context: 200000`, while
* the MiMo V2.6 Flash model card and the official OpenCode CLI config use
* 1048576. Checked BEFORE the metadata in `limits()`/`reasoningCapability()`/
* `modalities()` — a fixed feed deletes its entry here.
*
* This is the BUILT-IN default. The operator-facing knob is the live
* `modelContextWindows` setting (src/model-context.ts), read by `limits()` and
* taking precedence over these entries for every model the Zen lane serves.
*/
const LOCAL_MODEL_OVERRIDES = { "mimo-v2.6-flash-free": { contextWindow: 1048576 } };
/** Shallow per-field override: declared fields win, the rest pass through. */
function applyLocalOverride(model, price) {
	const override = LOCAL_MODEL_OVERRIDES[model];
	if (override === void 0) return price;
	return {
		...price,
		...override
	};
}
/**
* decodeModelsDev (model_metadata.go:253-335): use the OpenCode provider
* section of models.dev, preferring the exact `opencode`/`oc2dsh` key.
*/
function decodeModelsDev(data) {
	const result = /* @__PURE__ */ new Map();
	if (!data || typeof data !== "object") return result;
	const providers = data;
	const keys = Object.keys(providers);
	const rank = (key) => {
		const lower = key.toLowerCase();
		if (lower === "opencode" || lower === "oc2dsh" || lower === "opencode_zen") return 0;
		if (lower.includes("opencode")) return 1;
		return 2;
	};
	keys.sort((left, right) => {
		const leftRank = rank(left);
		const rightRank = rank(right);
		if (leftRank !== rightRank) return leftRank - rightRank;
		return left.localeCompare(right);
	});
	for (const key of keys) {
		if (rank(key) > 1) continue;
		const provider = providers[key];
		if (!provider || typeof provider !== "object") continue;
		if (rank(key) === 1) {
			if (!`${provider.id ?? ""} ${provider.name ?? ""}`.toLowerCase().trim().includes("opencode")) continue;
		}
		const models = provider.models;
		if (!models || typeof models !== "object") continue;
		for (const [modelKey, raw] of Object.entries(models)) {
			if (!raw || typeof raw !== "object") continue;
			const modelId = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : modelKey;
			const cost = raw.cost ?? {};
			const limit = raw.limit ?? {};
			const modalities = raw.modalities ?? {};
			const num = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
			const contextWindow = num(limit.context);
			const maxOutput = num(limit.output);
			const inputModalities = decodeModalities(modalities.input);
			result.set(modelId, {
				input: num(cost.input),
				output: num(cost.output),
				deprecated: metadataDeprecated(raw),
				reasoning: raw.reasoning === true,
				...decodeEffortValues(raw.reasoning_options),
				...contextWindow !== void 0 ? { contextWindow } : {},
				...maxOutput !== void 0 ? { maxOutput } : {},
				...inputModalities !== void 0 ? { modalities: inputModalities } : {}
			});
		}
		if (result.size > 0) return result;
	}
	return result;
}
function metadataDeprecated(model) {
	if (model.deprecated === true) return true;
	const status = String(model.status ?? model.lifecycle ?? "").toLowerCase();
	if (status === "deprecated" || status === "retired" || status === "disabled") return true;
	return model.deprecated_at != null || model.retirement_date != null;
}
/**
* models.dev `reasoning_options` (live shape 2026-09-18): an array of
* `{type: "effort", values: [...]} | {type: "toggle"} | {type: "budget_tokens", ...}`
* entries, absent when the model never thinks. Only the `effort` entries carry
* selectable levels; `toggle`/`budget_tokens` map to "reasoning, no declared
* ladder" and are reported as an empty array. Omitted entirely when the field
* is absent so cached pre-reasoning metadata stays structurally valid.
*/
function decodeEffortValues(raw) {
	if (!Array.isArray(raw)) return {};
	const values = [];
	for (const option of raw) {
		if (typeof option !== "object" || option === null) continue;
		const entry = option;
		if (entry.type !== "effort" || !Array.isArray(entry.values)) continue;
		for (const value of entry.values) if (typeof value === "string" && value.length > 0 && !values.includes(value)) values.push(value);
	}
	return values.length > 0 ? { effortValues: values } : { effortValues: [] };
}
/**
* models.dev `modalities.input` (live shape 2026-09-28): an array of lowercase
* kind strings such as ["text","image","video","pdf","audio"]. Only a non-empty
* array of non-empty strings is kept, so a malformed or absent field speaks for
* nothing and the adapter keeps its own vision pattern (isVisionModel).
*/
function decodeModalities(input) {
	if (!Array.isArray(input)) return void 0;
	const kinds = [];
	for (const kind of input) if (typeof kind === "string" && kind.length > 0 && !kinds.includes(kind)) kinds.push(kind);
	return kinds.length > 0 ? kinds : void 0;
}
const METADATA_REFRESH_MS = 1440 * 60 * 1e3;
const FETCH_TIMEOUT_MS = 3e4;
/**
* Live model directory with the S1/S2/S3 fallback chain and the timer-driven
* refresh loop. All state is in-memory; only the models.dev cache persists.
*
* Decision chain (design.md 4.1/4.2, with the deprecation-first fix):
*   1. ready metadata verdict — deprecated/paid deny, free cost allows; a
*      "free" name never overrides a negative metadata verdict
*   2. metadata cannot speak (pending/missing) — name fallback, or the
*      compile-time verified S3 list for known-good ids
*/
var ModelCatalog = class {
	#zen = /* @__PURE__ */ new Set();
	#updatedAt = 0;
	#prices = /* @__PURE__ */ new Map();
	#pricesReady = false;
	#lastError = "";
	#refreshSeconds;
	#cachePath;
	#zenBaseUrl;
	#metadataUrl;
	#fetch;
	#now;
	#timer = null;
	#stopped = false;
	#onRefresh;
	#startupRetryMs;
	/** Live context-window overrides; undefined = the built-in/metadata only. */
	#contextWindows;
	/** In-flight refresh round (deduped so warm() shares start()'s first fetch). */
	#refreshing = null;
	constructor(options = {}) {
		this.#refreshSeconds = options.refreshSeconds ?? 300;
		this.#cachePath = options.cachePath;
		this.#zenBaseUrl = options.zenBaseUrl ?? ZEN_BASE_URL;
		this.#metadataUrl = options.metadataUrl ?? "https://models.dev/api.json";
		this.#fetch = options.fetchImpl ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#onRefresh = options.onRefresh;
		this.#startupRetryMs = options.startupRetryMs ?? 15e3;
		this.#contextWindows = options.contextWindows;
	}
	/**
	* Start the refresh loop: immediate S1+S2, fast retries while the live
	* catalog is still empty (the first fetch often races the machine's network
	* coming up — VPN/TUN reconnect, DNS), then the normal cadence (S2 24h).
	*/
	async start() {
		await this.refreshOnce();
		let attempts = 0;
		while (this.#zen.size === 0 && attempts < 4 && !this.#stopped) {
			attempts += 1;
			await new Promise((resolve) => setTimeout(resolve, this.#startupRetryMs));
			if (this.#stopped) return;
			await this.refreshOnce();
		}
		if (this.#stopped) return;
		this.#timer = setInterval(() => {
			this.refreshOnce();
		}, this.#refreshSeconds * 1e3);
		this.#timer.unref?.();
	}
	stop() {
		this.#stopped = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}
	/** One refresh round, deduped while in flight: a concurrent caller (warm()
	*  racing start()'s first round, or the interval timer) joins the running
	*  round instead of firing a parallel fetch of the same endpoints. */
	refreshOnce() {
		if (this.#refreshing === null) this.#refreshing = this.#refreshRound().finally(() => {
			this.#refreshing = null;
		});
		return this.#refreshing;
	}
	async #refreshRound() {
		await Promise.allSettled([this.refreshZen(), this.refreshMetadata()]);
		if (this.#onRefresh) try {
			this.#onRefresh(this.snapshot(), this.#lastError);
		} catch {}
	}
	async refreshZen() {
		try {
			const ids = await fetchZenModels(this.#zenBaseUrl, this.#fetch, opencodeUserAgent());
			this.#zen = new Set(ids);
			this.#updatedAt = this.#now();
			this.#lastError = "";
		} catch (err) {
			this.#lastError = err instanceof Error ? err.message : String(err);
		}
	}
	/**
	* Adopt a fresh disk cache as the prices baseline. False when there is no
	* cache path, the prices are already ready, or the file is missing/empty —
	* the caller then keeps whatever state it had.
	*/
	async #adoptCachedPrices() {
		if (!this.#cachePath || this.#pricesReady) return false;
		const cached = await loadMetadataCache(this.#cachePath, this.#now).catch(() => null);
		if (cached === null || cached.size === 0) return false;
		this.#prices = cached;
		this.#pricesReady = true;
		return true;
	}
	async refreshMetadata() {
		await this.#adoptCachedPrices();
		try {
			const response = await withTimeout(this.#fetch(this.#metadataUrl, { headers: { accept: "application/json" } }));
			if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
			const prices = decodeModelsDev(await response.json());
			if (prices.size === 0) throw new Error("models.dev contains no OpenCode model metadata");
			this.#prices = prices;
			this.#pricesReady = true;
			if (this.#cachePath) await saveMetadataCache(this.#cachePath, prices, this.#now());
		} catch (err) {
			if (await this.#adoptCachedPrices()) return;
			this.#lastError = err instanceof Error ? err.message : String(err);
		}
	}
	/**
	* Resolve once the first live fetch has settled, so a model-list read is
	* never answered from the bootstrap list (issue #45: the host caches the
	* snapshot its picker took at adapter registration, and the re-read
	* triggers are topology/settings events a warming catalog never fires —
	* so the 7-id staticFreeModels roster could stick for the whole host
	* generation). Bounded: a dead network still answers promptly with the
	* static list. Joins start()'s in-flight round when one exists (no
	* duplicate fetch), or triggers a round of its own when none does.
	*/
	async warm(ms = 4e3) {
		if (this.#zen.size > 0 || this.#stopped) return;
		const timeout = new Promise((resolve) => {
			setTimeout(resolve, ms).unref?.();
		});
		await Promise.race([this.refreshOnce().catch(() => {}), timeout]);
	}
	decision(model) {
		if (FREE_LANE_BLOCKLIST.has(model)) return {
			allowed: false,
			source: "local_blocklist",
			known: true
		};
		const metadata = decide(model, this.#prices, this.#pricesReady);
		if (!metadata.allowed && metadata.source === "metadata_deprecated" && staticFreeModels.includes(model)) return {
			allowed: true,
			source: "static_verified",
			known: false
		};
		if (!metadata.allowed && !metadata.known && staticFreeModels.includes(model)) return {
			allowed: true,
			source: "static_verified",
			known: false
		};
		return metadata;
	}
	/** ids exposed to DSH: S1 ∩ allowed, or S3 while the live catalog is pending. */
	list() {
		if (this.#zen.size === 0) return staticFreeModels.filter((model) => !FREE_LANE_BLOCKLIST.has(model));
		const out = [];
		for (const model of this.#zen) if (this.decision(model).allowed) out.push(model);
		return out.sort();
	}
	/**
	* models.dev declared limits for one model: `contextWindow` (limit.context)
	* and `maxOutput` (limit.output). undefined when the metadata cannot speak
	* for the model (pending, or id absent) and no live override is set — the
	* caller then keeps its own defaults.
	*
	* The context window has a three-level precedence: the live
	* `modelContextWindows` setting (works even while metadata is pending),
	* then the built-in LOCAL_MODEL_OVERRIDES (metadata-dependent, as before),
	* then models.dev. `maxOutput` is not overridable and always comes from
	* the metadata/built-ins.
	*/
	limits(model) {
		const live = this.#liveContextWindow(model);
		const price = applyLocalOverride(model, this.#prices.get(model));
		const contextWindow = live ?? price?.contextWindow;
		const maxOutput = price?.maxOutput;
		if (contextWindow === void 0 && maxOutput === void 0) return void 0;
		return {
			...contextWindow !== void 0 ? { contextWindow } : {},
			...maxOutput !== void 0 ? { maxOutput } : {}
		};
	}
	/**
	* The live setting for one id, sanitized on every read: a hand-edited
	* profile patch can neither inject an out-of-range window nor break the
	* lookup, and an edit takes effect on the next resolveModel call.
	*/
	#liveContextWindow(model) {
		if (this.#contextWindows === void 0) return void 0;
		try {
			return sanitizeModelContextWindows(this.#contextWindows())[model];
		} catch {
			return;
		}
	}
	/**
	* models.dev `modalities.input` for one model: the input kinds it accepts
	* (["text","image","video",…]). undefined when the metadata cannot speak for
	* the model (pending, or id absent) or declares no modalities — the caller
	* then keeps its own vision pattern (isVisionModel).
	*/
	modalities(model) {
		const modalities = applyLocalOverride(model, this.#prices.get(model))?.modalities;
		return modalities === void 0 ? void 0 : [...modalities];
	}
	/**
	* models.dev reasoning capability for one model: `reasoning` flags the
	* always-think models, `effortValues` the declared selectable levels
	* (empty array = reasons but declares no ladder). undefined when the
	* metadata cannot speak for the model (pending, or id absent).
	*/
	reasoningCapability(model) {
		const price = applyLocalOverride(model, this.#prices.get(model));
		if (!price) return void 0;
		return {
			reasoning: price.reasoning === true,
			effortValues: price.effortValues ?? []
		};
	}
	/** healthz models block (design.md 6.1). */
	snapshot() {
		const age = this.#updatedAt === 0 ? Infinity : this.#now() - this.#updatedAt;
		const stale = this.#updatedAt !== 0 && age > 600 * 1e3;
		return {
			status: this.#updatedAt === 0 ? "pending" : stale ? "stale" : "ready",
			total: this.#zen.size,
			exposed: this.list().length,
			...this.#updatedAt !== 0 ? { lastRefresh: new Date(this.#updatedAt).toISOString() } : {}
		};
	}
	get lastError() {
		return this.#lastError;
	}
};
async function withTimeout(promise, timeoutMs = FETCH_TIMEOUT_MS) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await promise;
	} finally {
		clearTimeout(timer);
	}
}
/** S1: fetchModels (models.go:587-618) with the CLI disguise headers. */
async function fetchZenModels(zenBaseUrl, fetchImpl, userAgent, fallbackBaseUrl) {
	const origins = laneOrigins(zenBaseUrl, fallbackBaseUrl);
	let lastError;
	for (const origin of origins) try {
		return await fetchModelsAt(origin, fetchImpl, userAgent);
	} catch (err) {
		lastError = err instanceof Error ? err : new Error(String(err));
		if (!isOriginFailure(lastError.message)) break;
	}
	throw lastError ?? /* @__PURE__ */ new Error("no lane origin configured");
}
async function fetchModelsAt(zenBaseUrl, fetchImpl, userAgent) {
	const response = await withTimeout(fetchImpl(`${zenBaseUrl.replace(/\/+$/, "")}/v1/models`, { headers: zenRequestHeaders({
		authorization: "Bearer public",
		"user-agent": userAgent,
		accept: "application/json"
	}) }));
	if (!response.ok) throw new Error(`models endpoint returned HTTP ${response.status}`);
	const payload = await response.json();
	const models = [];
	for (const item of payload.data ?? []) if (typeof item?.id === "string" && item.id.length > 0) models.push(item.id);
	if (models.length === 0) throw new Error("models endpoint returned an empty list");
	return models;
}
async function saveMetadataCache(path, prices, now) {
	const cache = {
		updatedAt: now,
		prices: [...prices]
	};
	const tmp = `${path}.${process.pid}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(tmp, JSON.stringify(cache), "utf8");
	await rm(path, { force: true });
	await rename(tmp, path);
}
async function loadMetadataCache(path, now = Date.now) {
	const raw = JSON.parse(await readFile(path, "utf8"));
	if (now() - raw.updatedAt > 7 * METADATA_REFRESH_MS) throw new Error("models.dev cache too old");
	return new Map(raw.prices);
}
/** Default cache location next to the agent data dir (config.ts convention). */
function defaultCachePath(dataDir) {
	return join(dataDir, "agent-config.json.models.dev.json");
}

//#endregion
export { zenRequestHeaders as S, disguiseHeaders as _, decodeModelsDev as a, setRequestHeadersReader as b, isFreeModel as c, isOriginFailure as d, laneOrigins as f, deriveRequestIDs as g, conversationLabel as h, decide as i, staticFreeModels as l, canonicalSessionID as m, ModelCatalog as n, defaultCachePath as o, DEFAULT_PROJECT_ID as p, ZEN_BASE_URL as r, fetchZenModels as s, FREE_LANE_BLOCKLIST as t, MIN_CONTEXT_WINDOW as u, mintedMessageID as v, setUserAgentOverride as x, opencodeUserAgent as y };