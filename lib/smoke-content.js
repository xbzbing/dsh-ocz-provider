import { C as clientTempDirectory, w as hostProject } from "./catalog.js";

//#region src/adapter/gate-tools.ts
/**
* The anonymous free lane's gate tools — the GENUINE OpenCode 2.1.4
* definitions, byte-exact from the official client (captured by pointing the
* installed `opencode-cli` at a loopback capture server,
* `docs/local/capture-214/probe.cjs`; a `permission: 'deny'` probe config
* yields NO `tools` key at all, so the definitions come from an
* open-permissions run). Of the client's 12 advertised tools (`edit`, `glob`,
* `grep`, `question`, `read`, `shell`, `skill`, `subagent`, `webfetch`,
* `websearch`, `write`, `execute`), `shell` and `read` are the two the gate
* names; the rest are ordinary extra tools the gate ignores.
*
* WHY VERBATIM: the gate validates tool CONTENT, not just names — the accepted
* shape is both names present, each description CONTAINING the genuine text
* (substring) and each `parameters` EQUAL to the genuine schema — so a stub, a
* truncated description or one edited property is a rejection risk.
* `isGenuineGateTool` applies exactly that check.
*
* The STRUCTURAL requirement on the wire today is a non-empty `tools` array
* carrying an entry NAMED `read`: `read` alone passes, `shell` without `read`
* is refused, and the previous-generation `bash`+`read` pair still passes.
* Content validation has been switched on and off upstream, so both
* generations ship as insurance.
*
* Reading status codes: 403 FreeTierError = the SHAPE was rejected (a body
* with no `tools` still gets it); 429 FreeUsageLimitError is NOT "quota
* spent" — it is what any non-official stack gets while the official client
* is served 200. The gate has THREE halves, and each missing one reads as
* that same 429:
*   (a) PAYLOAD — the system prompt must carry a non-empty `<env>` block
*       (adapter/env-block.ts);
*   (b) STACK — the request must leave through Bun; a Node fetch is refused on
*       the same body (src/relay/);
*   (c) SESSION-ID FRESHNESS — the `ses_*` 12-hex prefix decodes as
*       `~(unix_ms*0x1000+counter)` and must name a recent moment
*       (adapter/ids.ts mints it clock-based).
*
* RE-CAPTURE when the gate moves: rerun `probe.cjs` (loopback only, nothing
* leaves 127.0.0.1), take `shell` and `read` from the logged `body.tools`,
* and replace the two entries below.
*
* The 2.1.4 pair ships as ONE recipe with the 2.1.4 header set (four session
* spellings, no `x-opencode-request`, 2.1.4 UA): mixing generations inside one
* request is how this lane breaks (adapter/ids.ts `disguiseHeaders`).
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
//#region src/adapter/env-block.ts
/**
* The `<env>` system-prompt block every accepted request must carry — one of
* the free lane's three gate halves: a body whose system content has no
* environment block is answered 429 FreeUsageLimitError, the same status a
* spent quota uses. The official client renders it as two instructions near
* the tail of its system prompt:
*
*     Today's date: Thu Oct 29 2026
*
*     Here is some useful information about the environment you are running in:
*     <env>
*       Working directory: /Users/…/workspace
*       Workspace root folder: /Users/…/dsh-ocz-provider
*       Is directory a git repo: yes
*       Platform: darwin
*       Prefer /private/var/…/T/opencode over generic system temporary directories …
*     </env>
*
* The gate checks PRESENCE, not fidelity (probe matrix under
* `docs/local/capture-214/`): an empty block, the same lines without the
* tags, a junk-padded prompt, or a system prompt truncated before the block
* are refused (429); one real line passes, a block-only prompt passes, a
* fabricated path passes. So this module reproduces the client's text with
* this host's real values instead of shipping the captured ones: a
* hard-coded `Working directory` would be a lie the model may act on.
*/
/** Opening tag of the block (the gate's literal marker). */
const ENV_OPEN = "<env>";
/** Closing tag of the block. */
const ENV_CLOSE = "</env>";
/** The client's lead line for the block (its `core/environment` instruction). */
const ENV_LEAD = "Here is some useful information about the environment you are running in:";
/**
* Every fact, read from this process (never throws). The directory and its
* project are the same ones `x-opencode-project` is derived from (ids.ts), so
* the header and the prompt name one place.
*/
function hostEnvFacts() {
	const project = hostProject();
	return {
		workingDirectory: project.directory,
		workspaceRoot: project.root,
		isGitRepo: project.vcs === "git",
		platform: process.platform,
		preferTempDir: clientTempDirectory(),
		date: (/* @__PURE__ */ new Date()).toDateString()
	};
}
/** One rendered block, official layout, `<env>` … `</env>` inclusive. */
function renderEnvBlock(facts = hostEnvFacts()) {
	const lines = [ENV_OPEN];
	if (facts.workingDirectory !== void 0 && facts.workingDirectory !== "") lines.push(`  Working directory: ${facts.workingDirectory}`);
	if (facts.workspaceRoot !== void 0 && facts.workspaceRoot !== "") lines.push(`  Workspace root folder: ${facts.workspaceRoot}`);
	if (facts.isGitRepo !== void 0) lines.push(`  Is directory a git repo: ${facts.isGitRepo ? "yes" : "no"}`);
	if (facts.platform !== void 0 && facts.platform !== "") lines.push(`  Platform: ${facts.platform}`);
	if (facts.preferTempDir !== void 0) lines.push(`  Prefer ${facts.preferTempDir} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`);
	lines.push(ENV_CLOSE);
	return lines.join("\n");
}
/**
* The client's rendering of the block as instructions: the `core/date` line,
* a blank line, then the lead line and the block. This is what gets appended
* to a system prompt.
*/
function renderEnvSection(facts = hostEnvFacts()) {
	const env = `${ENV_LEAD}\n${renderEnvBlock(facts)}`;
	return facts.date !== void 0 && facts.date !== "" ? `Today's date: ${facts.date}\n\n${env}` : env;
}
/**
* Does this text carry an `<env>` block with at least one non-blank line?
*
* A bare `<env></env>` / `<env>\n</env>` is NOT enough: the empty block is one
* of the rejected shapes above, so "contains the tags" would let the exact
* body the gate refuses through. Content outside the block is irrelevant —
* the gate reads the block, and a request may have any other system text.
*/
function hasEnvBlock(text) {
	if (typeof text !== "string" || text === "") return false;
	const open = text.indexOf(ENV_OPEN);
	if (open === -1) return false;
	const close = text.indexOf(ENV_CLOSE, open + 5);
	if (close === -1) return false;
	return text.slice(open + 5, close).split("\n").some((line) => line.trim() !== "");
}
/**
* Append the block to a system text, unless one is already there.
*
* Returns the SAME string reference when nothing had to change, so callers can
* detect "already shaped" without comparing strings.
*/
function withEnvBlock(text, facts = hostEnvFacts()) {
	if (hasEnvBlock(text)) return text;
	const section = renderEnvSection(facts);
	if (text === "") return section;
	return `${text.replace(/\s+$/, "")}\n\n${section}`;
}

//#endregion
//#region src/relay/egress.ts
/**
* The egress seam between the adapter and the exit pool, for relay traffic:
* the relay opens the upstream connection, so the pool's dispatcher never sees
* the request. The adapter asks pick() which exit carries one request (the same
* pick(session, model) direct dispatch uses), hands it to the relay in
* {@link EGRESS_HEADER} (stripped before the upstream sees anything), then
* reports settle() so the chosen exit is the graded one. Module state installed
* by the runtime assembly (ip-pool.ts) and cleared on dispose: a plugin without
* a pool never reaches either half.
*/
/** Per-request egress directive, understood by `relay/oc2dsh-relay.mjs`. */
const EGRESS_HEADER = "x-oc2dsh-egress";
let seams = {};
/** Install the runtime's egress seams (startIpPool); null clears them on dispose. */
function setRelayEgressSeams(next) {
	seams = next ?? {};
}
/** True when a pool is wired to relay traffic (adapter fast-path). */
function hasRelayEgress() {
	return seams.pick !== void 0;
}
/** Ask the pool which exit should carry one request. */
function pickRelayEgress(context) {
	return seams.pick?.(context) ?? null;
}
/** Report one relayed request's outcome to the pool that chose the exit. */
function settleRelayEgress(pick, outcome) {
	if (pick === null) return;
	seams.settle?.(pick, outcome);
}
/**
* The status a pi-ai error message names, when it names one: pi-ai folds
* provider failures into `errorMessage` text ("429 status code (no body)"), so
* the adapter's pre-content path reads the number back out of the string to
* grade the relay's exit — 2xx/429 = exit fine, 5xx/transport = exit at fault,
* the same verdict table `PoolRoutingDispatcher.#observe` applies.
*/
function statusOfFailure(message) {
	const match = /\b([1-5]\d{2})\b/.exec(message);
	return match === null ? void 0 : Number(match[1]);
}

//#endregion
//#region src/pool/smoke-content.ts
/**
* The probe's user turn: a small pool of one-liners, default `hello`.
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
* request (docs/ip-pool.md §4.2): callers that probe one exit across
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
export { gateToolArgumentBridge as _, hasRelayEgress as a, settleRelayEgress as c, renderEnvSection as d, withEnvBlock as f, freeLaneGateTool as g, freeLaneGateFlatTool as h, EGRESS_HEADER as i, statusOfFailure as l, SUPERSEDED_GATE_TOOL_NAMES as m, normalizeSmokeContents as n, pickRelayEgress as o, FREE_LANE_GATE_TOOL_NAMES as p, pickSmokeContent as r, setRelayEgressSeams as s, DEFAULT_SMOKE_CONTENT as t, hasEnvBlock as u, isGenuineFlatGateTool as v, isGenuineGateTool as y };