//#region src/adapter/gate-tools.ts
/**
* The anonymous free lane's gate tools — the GENUINE OpenCode definitions,
* byte-exact from the official 2.1.4 client.
*
* PROVENANCE (2026-10-24): captured from the installed Desktop 2.1.4
* `opencode-cli` by pointing its provider baseURL at a loopback capture
* server (`docs/local/capture-214/probe.cjs`, isolated `XDG_*` tree,
* `OPENCODE_CONFIG_CONTENT` config) and driving one real
* `run --standalone --auto` turn. The server logged every header and the RAW
* request body; the two entries below are that body's `tools` payload
* verbatim, in the client's own order (of its 12 advertised tools — `edit`,
* `glob`, `grep`, `question`, `read`, `shell`, `skill`, `subagent`,
* `webfetch`, `websearch`, `write`, `execute` — `shell` and `read` are the
* two the gate names; the rest are ordinary extra tools the gate ignores).
*
* One capture subtlety worth keeping: `permission: 'deny'` in the probe
* config produced a request with NO `tools` key at all, because
* `Tool.snapshot(permissions)` drops every definition under a deny-all
* ruleset (`whollyDisabled`, packages/core/src/tool.ts). The captured
* definitions below therefore come from an open-permissions run.
*
* WHY VERBATIM: the gate validates tool CONTENT, not just names. Measured
* 2026-10-14 against `POST /inference/v1/chat/completions` (ablation matrix,
* every other field held at the captured client request): genuine pair -> 200;
* placeholder stubs -> 403; a description truncated to 120 chars -> 403; a
* description merely prefixed with `X` or suffixed " (copy)" -> 200;
* parameters gaining one property, losing `required`, or emptied -> 403; the
* genuine pair minus `bash` (or `bash` alone) -> 403. The check was: both
* names present, each description CONTAINING the genuine text (substring),
* each `parameters` EQUAL to the genuine schema.
*
* RE-MEASURED 2026-10-24 with the 2.1.4 pair under the 2.1.4 header set, one
* variable per request, through a pool exit where the gate answers BEFORE the
* quota layer (so the status still discriminates with the anonymous quota
* spent: 429 FreeUsageLimitError = gate PASSED, 403 FreeTierError = gate
* REJECTED):
*
*   - the captured 12-tool payload               -> 429 (passed)
*   - the captured `read` ALONE                  -> 429 (passed)
*   - the captured `shell` ALONE (no `read`)     -> 403 (rejected)
*   - the previous-generation `bash`+`read` pair -> 429 (passed)
*   - `ses_short` session id (calibration)       -> 403 (rejected)
*
* So the only STRUCTURAL requirement on 2026-10-24 is a non-empty `tools`
* array carrying an entry NAMED `read`; content validation is OFF again and
* the old pair still passes. Both generations are kept as insurance — the
* gate has flipped five times (09-16, 10-09, 10-13, 10-14, content-check off
* since 10-19) and on 10-14 the stubs really were the rejection signal.
*
* RE-MEASURED 2026-10-25 — the discriminator itself moved. The anonymous
* window reopened (the official `opencode-cli 2.1.4`, a Bun binary, answered
* a real 200 from this machine, direct AND through pool exit
* `127.0.0.1:30033`), yet a BYTE-IDENTICAL replay — the captured 16 headers,
* the captured 22 KB body, the official family path — answered 429
* FreeUsageLimitError from Node h1, Node h2, curl 8.7 h2, Python urllib and
* Go net/http, from every egress tried (direct v4/v6, the CLI's own ULA
* source address, all 7 pool exits). One variable at a time, all ruled out:
* header set, body, route, `accept-encoding: …zstd`, HTTP/1.1 vs h2, source
* IP. A second capture — this time over TLS to a local CA trusted via
* `NODE_EXTRA_CA_CERTS`, so the genuine client hits a real https origin —
* shows the live request still carries exactly those 16 headers, with no
* signature and no cookie, and upstream sets no cookie. What is left is the
* client's TLS/HTTP STACK fingerprint, which sits in front of the quota layer
* and no payload edit can change (probes under `docs/local/capture-214/`).
*
* Reading status codes from now on: 403 FreeTierError still = the SHAPE was
* rejected (a body with no `tools` still 403s on 2026-10-25); 429
* FreeUsageLimitError no longer = "gate passed, quota spent" — it is what ANY
* non-official stack gets while the official client is being served 200. The
* matrix above still tells you which SHAPES pass (it was read as 403-vs-429),
* but a run of 429s no longer tells you the request would have been SERVED.
*
* RE-CAPTURE when the gate moves again: rerun `probe.cjs` (loopback only,
* nothing leaves 127.0.0.1), take `shell` and `read` from the logged
* `body.tools`, and replace the two entries below.
*
* The 2.1.4 pair ships as ONE recipe with the 2.1.4 header set (four session
* spellings, no `x-opencode-request`, 2.1.4 UA) — mixing generations inside
* one request is the documented way this lane has broken (adapter/ids.ts
* `disguiseHeaders`).
*/
/** Wire names of the injected pair, in the client's own precedence. */
const FREE_LANE_GATE_TOOL_NAMES = ["shell", "read"];
/**
* The host tool each wire name is an ALIAS of. The official 2.x client calls
* it `shell`; DSH names the same capability `bash`, so the wire carries
* `shell` and the harness chunk stream renames it back on the way out
* (adapter/messages.ts `GATE_TOOL_ALIASES` -> adapter/events.ts
* `toolNameAlias`).
*/
const GATE_TOOL_HOST_NAMES = {
	shell: "bash",
	read: "read"
};
/** Superseded 1.x wire names: dropped from a payload so the wire never mixes
*  a 1.x tool name into the 2.x recipe (the host's `bash` rides back in
*  through the `shell` alias instead). */
const SUPERSEDED_GATE_TOOL_NAMES = ["bash"];
const GENUINE_GATE_TOOLS = {
	"shell": {
		"type": "function",
		"function": {
			"name": "shell",
			"description": "Execute a shell command and return its output. Commands run on macOS using zsh. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
			"parameters": {
				"type": "object",
				"properties": {
					"command": {
						"type": "string",
						"description": "Shell command string to execute"
					},
					"workdir": {
						"type": "string",
						"description": "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."
					},
					"timeout": {
						"type": "integer",
						"minimum": 0,
						"description": "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."
					},
					"background": {
						"type": "boolean",
						"description": "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."
					}
				},
				"required": ["command"],
				"additionalProperties": false
			},
			"strict": false
		}
	},
	"read": {
		"type": "function",
		"function": {
			"name": "read",
			"description": "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
			"parameters": {
				"type": "object",
				"properties": {
					"path": {
						"type": "string",
						"description": "File or directory to read"
					},
					"offset": {
						"type": "integer",
						"minimum": 0,
						"description": "The line or directory entry to start reading from (1-based)"
					},
					"limit": {
						"type": "integer",
						"minimum": 0,
						"description": "The maximum number of lines or directory entries to read (defaults to and capped at 2000)"
					}
				},
				"required": ["path"],
				"additionalProperties": false
			},
			"strict": false
		}
	}
};
/** A detached copy: callers splice these into a payload and may mutate them. */
function freeLaneGateTool(name) {
	return structuredClone(GENUINE_GATE_TOOLS[name]);
}
/**
* True when a tool entry already carries the genuine definition, i.e. the
* gate would accept it as-is: same name, a description that contains the
* genuine text, and byte-identical parameters. Used by the payload shaper to
* leave an already-correct entry untouched (so a host tool that happens to
* ship the genuine definition is not reordered or rewritten).
*/
function isGenuineGateTool(name, entry) {
	if (!Object.hasOwn(GENUINE_GATE_TOOLS, name)) return false;
	if (typeof entry !== "object" || entry === null) return false;
	const fn = entry.function;
	if (typeof fn !== "object" || fn === null) return false;
	const candidate = fn;
	const genuine = GENUINE_GATE_TOOLS[name].function;
	return candidate.name === genuine.name && typeof candidate.description === "string" && candidate.description.includes(genuine.description) && JSON.stringify(candidate.parameters) === JSON.stringify(genuine.parameters);
}
function freeLaneGateFlatTool(name) {
	const fn = GENUINE_GATE_TOOLS[name].function;
	return {
		type: "function",
		name: fn.name,
		description: fn.description,
		parameters: structuredClone(fn.parameters)
	};
}
/** Flat-shape twin of {@link isGenuineGateTool}. */
function isGenuineFlatGateTool(name, entry) {
	if (!Object.hasOwn(GENUINE_GATE_TOOLS, name)) return false;
	if (typeof entry !== "object" || entry === null) return false;
	const candidate = entry;
	const genuine = GENUINE_GATE_TOOLS[name].function;
	return candidate.type === "function" && candidate.name === genuine.name && typeof candidate.description === "string" && candidate.description.includes(genuine.description) && JSON.stringify(candidate.parameters) === JSON.stringify(genuine.parameters);
}
function declaredArguments(parameters) {
	if (typeof parameters !== "object" || parameters === null) return void 0;
	const record = parameters;
	const wrapped = typeof record.properties === "object" && record.properties !== null ? record.properties : void 0;
	const bare = wrapped === void 0 && typeof record.type !== "string" ? record : void 0;
	const properties = wrapped ?? bare;
	if (properties === void 0) return void 0;
	const requiredArray = record.required;
	const required = new Set(Array.isArray(requiredArray) ? requiredArray.filter((k) => typeof k === "string") : []);
	const keys = [];
	for (const [key, value] of Object.entries(properties)) {
		keys.push(key);
		if (typeof value === "object" && value !== null && value.required === true) required.add(key);
	}
	return {
		keys,
		required
	};
}
/**
* Argument-name normalization for pairing the wire's names with the host's.
* Lowercases, drops every separator, and drops a trailing `ms` so a host
* spelling like `timeoutMs` (DSH's bash) pairs with the wire's `timeout`.
*/
function normalizeArgumentKey(key) {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/ms$/, "");
}
/**
* Explicit wire->host argument renames the normalization above cannot pair.
* The 2.1.4 `read` schema renamed `filePath` to `path` (wire) while DSH's
* read still declares `file_path`: `path` and `file_path` normalize to
* different strings, so without this table the path would be DROPPED and the
* host's required argument left unsupplied. Candidate host keys are tried in
* order against what the host actually declares.
*/
const WIRE_ARGUMENT_ALIASES = { read: { path: [
	"file_path",
	"filePath",
	"filepath"
] } };
/** Host arguments the genuine schema cannot supply, synthesized from the wire ones. */
function synthesizeHostArgument(hostKey, wireArgs) {
	if (hostKey !== "description") return void 0;
	const command = wireArgs.command;
	if (typeof command !== "string" || command.trim().length === 0) return "Run command";
	const firstLine = command.trim().split("\n")[0].trim().replace(/\s+/g, " ");
	return firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 99)}…`;
}
function gateToolArgumentBridge(hostTools) {
	if (!Array.isArray(hostTools) || hostTools.length === 0) return void 0;
	const hostByName = /* @__PURE__ */ new Map();
	for (const tool of hostTools) {
		if (typeof tool?.name !== "string") continue;
		const declared = declaredArguments(tool.parameters);
		if (declared !== void 0) hostByName.set(tool.name, declared);
	}
	/** host name -> wire key -> host key (undefined: the host does not declare it) */
	const plans = /* @__PURE__ */ new Map();
	const synthesize = /* @__PURE__ */ new Map();
	for (const wireName of FREE_LANE_GATE_TOOL_NAMES) {
		const hostName = GATE_TOOL_HOST_NAMES[wireName];
		const host = hostByName.get(hostName);
		if (host === void 0) continue;
		const wireKeys = Object.keys(GENUINE_GATE_TOOLS[wireName].function.parameters.properties ?? {});
		const byNormalized = new Map(host.keys.map((key) => [normalizeArgumentKey(key), key]));
		const byName = new Map(host.keys.map((key) => [key, key]));
		const plan = /* @__PURE__ */ new Map();
		const covered = /* @__PURE__ */ new Set();
		for (const wireKey of wireKeys) {
			const alias = WIRE_ARGUMENT_ALIASES[wireName]?.[wireKey];
			const hostKey = byName.get(wireKey) ?? byNormalized.get(normalizeArgumentKey(wireKey)) ?? alias?.map((candidate) => byName.get(candidate)).find((candidate) => candidate !== void 0);
			plan.set(wireKey, hostKey);
			if (hostKey !== void 0) covered.add(hostKey);
		}
		plans.set(hostName, plan);
		synthesize.set(hostName, [...host.required].filter((key) => !covered.has(key)));
	}
	if (plans.size === 0) return void 0;
	return {
		names: new Set(plans.keys()),
		rewrite(name, args) {
			const plan = plans.get(name);
			if (plan === void 0) return void 0;
			const host = hostByName.get(name);
			const out = {};
			for (const [key, value] of Object.entries(args)) if (host.keys.includes(key)) out[key] = value;
			else {
				const wireTarget = plan.get(key);
				if (wireTarget !== void 0) out[wireTarget] = value;
				else if (!plan.has(key)) out[key] = value;
			}
			for (const hostKey of synthesize.get(name) ?? []) {
				if (out[hostKey] !== void 0) continue;
				const value = synthesizeHostArgument(hostKey, args);
				if (value !== void 0) out[hostKey] = value;
			}
			return JSON.stringify(out) === JSON.stringify(args) ? void 0 : out;
		}
	};
}

//#endregion
//#region src/pool/smoke-content.ts
/**
* The probe's user turn (live request 2026-10-14: "增加探测文案的配置，默认
* content 修改为「hello」，允许用户自定义多个 content，探索时随机选择").
*
* The smoke is a 1-token chat request that proves the anonymous lane answers
* through a candidate exit (docs/ip-pool.md §4.5 step 4). Its user turn is
* decoration — the gate is the request SHAPE (streaming + the free-lane tools)
* — so a pool of one-liners keeps the probe traffic from looking like one fixed
* synthetic pattern while every other property of the probe stays identical.
* One exit draws one entry per pass, so the variation is across exits.
*
* The default lives HERE rather than in the settings schema: the settings layer
* resolves it for the UI (`resolveProbeContents`) and the admission path keeps
* its own fallback for direct callers, so one constant has to be the truth for
* both. (Same split as `DEFAULT_PROBE_MODEL` ↔ `deps.smokeModel`.)
*/
const DEFAULT_SMOKE_CONTENT = "hello";
/** Trim, drop empties and dedupe a configured pool (order preserved). */
function normalizeSmokeContents(contents) {
	const pool = [];
	for (const entry of contents ?? []) {
		const value = typeof entry === "string" ? entry.trim() : "";
		if (value !== "" && !pool.includes(value)) pool.push(value);
	}
	return pool;
}
/**
* One EXIT PROBE's user turn: a random entry of the configured pool, or the
* default when nothing is configured. The draw belongs to the exit, not to the
* request (live correction 2026-10-14): callers that probe one exit across
* several models draw ONCE and reuse it for the whole pass (admission's
* `smokeContent`). `random` is a seam (tests, and any future deterministic
* caller); the index is clamped, so a seam returning 1 — or a negative, or
* NaN — can never read outside the pool.
*/
function pickSmokeContent(contents, random = Math.random) {
	const pool = normalizeSmokeContents(contents);
	if (pool.length === 0) return DEFAULT_SMOKE_CONTENT;
	const raw = random();
	return pool[Number.isFinite(raw) ? Math.min(pool.length - 1, Math.max(0, Math.floor(raw * pool.length))) : 0];
}

//#endregion
export { SUPERSEDED_GATE_TOOL_NAMES as a, gateToolArgumentBridge as c, FREE_LANE_GATE_TOOL_NAMES as i, isGenuineFlatGateTool as l, normalizeSmokeContents as n, freeLaneGateFlatTool as o, pickSmokeContent as r, freeLaneGateTool as s, DEFAULT_SMOKE_CONTENT as t, isGenuineGateTool as u };