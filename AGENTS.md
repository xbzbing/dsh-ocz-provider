# AGENTS.md

Agent-facing notes for this repository: what the project is, how to build and
test it, and the project-specific settings an agent must not guess at. Read
this before changing anything.

## What this is

`oc2dsh` — a DSH (DeepSeek Harness) cordis plugin that
registers a native dsh-llm adapter and streams from OpenCode Zen's anonymous
free lane (`Authorization: Bearer public`, no API key), impersonating the
official client's wire fingerprint. The repository root IS the installable
package (`dsh plugin add file:<repo>` or `github:xbzbing/dsh-ocz-provider`); `lib/`
is committed because neither install path runs a lifecycle script.

Upstream this fork ported fixes from: `jasonxu114514/opencode2api` (the
ported Go agent lives in git history; this tree is TypeScript only).

## Layout

```
src/adapter/    zen-adapter (dsh-llm adapter), catalog, messages (body shaping),
                gate-tools (the captured genuine tool definitions), events,
                routing (which API shape a model takes), ids
src/pool/       exit pool: admission (free-lane probing), dispatcher (routing),
                installer, onboarding, sing-box conversion, subscription fetch,
                transport (what one transport cut means), usage-store (the
                ~/.dsh/oc2dsh/usage.json ledger)
src/ip-pool-settings/  namespace (schema), bridge (loopback HTTP: guard, handlers,
                routes, views; gated by the host's `connection` service), apply
src/proxy-entry.ts  the manual proxy entry parser shared by server and card
src/relay/      the Bun upstream relay: supervisor (spawn/health/restart) and
                the egress seam between the adapter and the exit pool
relay/          oc2dsh-relay.mjs — the shipped bun script the supervisor runs
src/client/     browser half: IP pool settings card, exit-stats modal (+ its
                流量 tab), Zen request-headers editor, locales
src/config.ts   the whole settings schema (Config, exported for dsh-settings)
test/           node:test suite (runs the real TS sources, no build step)
lib/            committed build output (never edit; rebuild instead)
scripts/        build.mjs (canonical build), lib-manifest.mjs (freshness stamp),
                smoke-dsh-compat.mjs (loads the real installed host)
docs/           design.md (architecture + porting record), ip-pool.md (exit
                routing design), relay.md (Bun upstream relay contract)
```

## Commands

```sh
pnpm install          # toolchain (root package.json carries everything)
pnpm verify           # the gate: pnpm typecheck && pnpm test
pnpm build            # clean build: node half -> browser half -> manifest
pnpm build && pnpm pack   # tarball
node scripts/smoke-dsh-compat.mjs /path/to/@deepseek-ai/dsh   # real-host smoke
```

- `pnpm test` fails when `lib/` no longer matches `src/` (test/lib-fresh.test.ts
  re-runs `scripts/lib-manifest.mjs --check`). After changing `src/`, run
  `pnpm build` and commit `lib/` with the source change.
- Both halves build through `tsdown.config.ts` / `tsdown.client.config.ts` with
  fixed `chunkFileNames: '[name].js'` — chunk names are stable across rebuilds;
  do not reintroduce content hashing (it littered `lib/` with
  `admission-<hash>.js` on every rebuild).
- The CSS class map inside `lib/client.js` is emitted with sorted keys
  (`tsdown.client.config.ts` sorts lightningcss's `exports`, whose iteration
  order is random per call). Rebuilds are byte-identical for identical sources;
  if `lib/client.js` ever churns without a source change, that is a bug in the
  sort, not noise to revert.
- There is no CI here; the gate is `pnpm verify` plus, for wire-facing changes,
  a live probe against `https://opencode.ai/inference/v1`.
- Commit messages are English and short: a conventional single-line subject
  (≤72 chars, imperative), then **one sentence of context and 3-5 bullets**;
  the whole message stays **≤800 characters**. Describe only the final
  behaviour — never paste the user's prompt, the conversation, a file-by-file
  inventory, a test/gate recap, or an AI attribution. Chinese appears only as
  literal UI copy (`清空`, `流量`, `本机`, …) or a real code identifier.

## Comments

Comments describe the code's FINAL behaviour and the invariant that would
break without it — one or two lines, no timeline, no bug-hunt retelling, no
`live 2026-10-xx` dates. Decisions (why a width, a gate rule, a retry budget
is what it is) belong in `docs/design.md`, `docs/ip-pool.md` or this file, not
in a comment; a comment may point at the doc in one clause, never carry the
argument itself.

## Project-specific settings (do not guess these)

| Setting | Value | Where |
| --- | --- | --- |
| Package name (installable unit) | `dsh-opencode2free-provider` | package.json |
| Cordis patch row | `id: oc2dsh`, `name: dsh-opencode2free-provider` (the row name must equal the package name — the loader imports it) | cordis.patch.yml |
| Loader entry id / settings namespace | `oc2dsh` | src/index.ts `name`, src/ip-pool-settings/namespace.ts `IP_POOL_NAMESPACE`, src/client/index.ts `SETTINGS_NAMESPACE` |
| Provider route id (llm-pi-ai, request header) | `oc2dsh` | src/adapter/zen-adapter.ts `PROVIDER_ID` |
| Provider display name (model picker group) | `OpenCode-Zen-Free` | src/adapter/zen-adapter.ts `PROVIDER_NAME` — label only, deliberately separate from the id |
| Loopback bridge prefix | `/api/oc2dsh/ip-pool` | src/ip-pool-settings/routes.ts `IP_POOL_BRIDGE_PREFIX` (re-exported by bridge.ts, mirrored in src/client/types.ts `BRIDGE_PREFIX`) |
| On-disk state root | `~/.dsh/oc2dsh` (env `OC2DSH_HOME` redirects) | src/paths.ts `stateDir()` |
| Settings form field | `ipPool` (one volatile node; every write path is `['ipPool', <field>]`) | src/config.ts, src/client/settings-writes.ts |
| Zen request headers (live settings) | `requestHeaders` — separate volatile dictionary edited on the plugin page; case-insensitive overrides for chat + catalog + admission, applied at request time. Empty inherits `userAgent`/built-in defaults; authentication, Cookie, transport/body format headers, the client-identity flag `x-opencode-client` and every `x-oc2dsh-*` control header are managed by the plugin | src/request-headers.ts, src/config.ts, src/adapter/ids.ts `zenRequestHeaders` |
| Per-model context windows (live settings) | `modelContextWindows` — separate volatile dictionary (`model id` → tokens) edited on the plugin page; the catalog reads it on EVERY `limits()` call, so a save applies to the next `resolveModel` without a restart. Precedence: live setting > built-in `LOCAL_MODEL_OVERRIDES` (mimo 1M) > models.dev `limit.context`. Values are sanitized per read, never in the schema | src/model-context.ts, src/config.ts, src/adapter/catalog.ts `limits()`, src/index.ts |
| Zen-lane User-Agent (legacy config, ordinary field) | `userAgent` — empty = the built-in current-client shape `opencode/latest/2.2.0/cli`; the client flag is pinned to `cli` and no setting moves it (the header is plugin-managed). Read at request time by all three senders, so one setting moves chat + catalog + admission | src/config.ts, src/adapter/ids.ts `setUserAgentOverride` / `zenUserAgent` / `opencodeUserAgent` |
| 本机出口协议族 (live setting) | `ipPool.localIpFamily` — `auto` (default) / `ipv4` / `ipv6`, edited on the pool card. It decides which family the LOCAL egress dials with when the pool does not carry the request (固定本机 pin, 本地出口兜底); `auto` = prefer IPv6 where this machine has a routable address and keep the IPv4 fallback. Relay traffic gets the same choice as an `x-oc2dsh-egress: direct;family=4|6|prefer6` directive (`relayDirectFamily`), so it holds whichever stack sends (live 2026-10-30 through the relay: no directive -> this host's IPv4, 429 with a 14 h retry-after; `prefer6` -> 200). Exit traffic is untouched. The free lane refuses this host's IPv4 and accepts its IPv6 on identical bytes (live 2026-10-18) | src/pool/local-family.ts, src/pool/dispatcher.ts `#localEgress`, src/pool/installer.ts, src/ip-pool.ts relay seam |
| Upstream base URL | `https://opencode.ai/inference` (chats + `/openai/v1`, catalog/admission model list + `/v1`), with `https://opencode.ai/zen` as the second rung of the ladder — chat, catalog and admission all walk it (401/403/404/5xx switch origins, 429/transport/RegionError keep to the IP pool) | src/adapter/catalog.ts `ZEN_BASE_URL`, src/adapter/lane.ts `laneOrigins` |
| Upstream relay (ordinary config) | `relay` — `enabled` (default true), `bunPath` (empty = search PATH, `OC2DSH_BUN`, `~/.bun/bin`, Homebrew prefixes, nvm's node bin dirs), `port` (0 = ephemeral; the relay reports its port on stdout as `OC2DSH_RELAY_READY <port>`), `upstream` (default `https://opencode.ai`). Started lazily by `listModels`/`prepareCall`/the catalog refresh, never at `apply()`; a host without bun keeps working and answers 429. Loopback only and authenticated: every request path carries `/_/<token>` (a random token per spawn, passed as `OC2DSH_RELAY_TOKEN` and folded into `baseUrl`, stripped before forwarding), the Host must be the relay's own loopback authority (421 otherwise), its CONNECT bridges only reach the upstream host, and the child gets an allowlisted env with no proxy variables. Startup failures and crashes share one restart budget with backoff, and the 5-restart budget is GIVEN BACK after 60 s of continuous uptime — it bounds a crash loop, not a process lifetime (live 2026-10-25: five isolated kills left a healthy host one crash away from a silent direct/429 downgrade). Debug: `OC2DSH_RELAY_TRACE=1` mirrors the child's log to stderr; the component contract (env vars, readiness handshake, timeouts, egress seam) is `docs/relay.md` | src/relay/supervisor.ts, relay/oc2dsh-relay.mjs, src/config.ts |
| Editable settings namespace (host side) | served from the Loader entry id — renaming the row id changes where settings live and orphans stored config | cordis.patch.yml |
| Config schema nodes must stay plain | NEVER put `.transform()` (or any callback-bearing node) in `Config`. dsh-settings rebuilds the served form from `Config.toJSON()` (`plainSchema`) and serializes it a SECOND time for the browser; a transform's `callback` survives the first `toJSON()` but is dropped on that rebuild, so the browser rehydrates a callback-less node, `ConfigFormController.decode()` throws `callback is not a function`, and the whole configuration card stays loading forever — invisible (live 2026-10-15, introduced with the Zen 请求头 field). Validate at the editor and request boundaries instead | src/config.ts, test/request-headers.test.ts, test/model-context.test.ts, scripts/smoke-dsh-compat.mjs |

Renaming any of the identifiers above is a cross-cutting change: the row id
keys the settings namespace, the client bundle's module id, the slot keys and
stored profile config — moving one without the others silently orphans the
operator's saved `ipPool` settings and the usage ledger path.

The row `name` is not a free rename knob: it has to equal the package name,
because the loader imports it. A user-layer patch can only edit a row whose
`name` matches — on a mismatch the loader logs `patch: name mismatch for
"oc2dsh" (expected …, got …), skipping`, the row keeps the wrong name, and the
next restart fails with `ERR_MODULE_NOT_FOUND`, which surfaces as the plugin
simply not starting (live 2026-10-15, after the dsh 0.2.1-alpha.3 upgrade).

## The upstream free-lane gate (why wire code looks the way it does)

The anonymous lane fingerprints the client; the gate is **fingerprint
coherence**, not an allow-list. This section is the record of the probe
evidence; `src/adapter/messages.ts` (`ensureFreeLaneShape`), `src/adapter/ids.ts`
and `src/adapter/gate-tools.ts` carry only the contract a request must satisfy.
Headlines:

- one recipe, two origins: `/inference` (primary) and `/zen` (fallback) both
  accept this fingerprint, walked as a ladder on an origin-shaped failure
  (`src/adapter/lane.ts`; the console origin was re-probed live 2026-10-19).
  Chats go to the client's FAMILY path `/inference/openai/v1` (models.dev
  `api` field; `src/adapter/lane.ts` `chatApiPath`). `/zen` has no family
  route (`/zen/openai/v1/chat/completions` 404, live 2026-10-29), so the
  fallback rung stays `/zen/v1`; the family `/models` 404s too, so the catalog
  and the admission model list stay on flat `/inference/v1`;
- body must be streaming with a NON-EMPTY `tools` array carrying an entry
  NAMED `read`. The injected pair is the genuine 2.1.4 `shell` + `read`
  (`src/adapter/gate-tools.ts`, byte-captured from the installed CLI —
  `parameters` byte-equal, `description` matched as a substring, and the host's
  superseded `bash` entry is dropped so the wire never mixes generations).
  Re-probed 2026-10-24: content validation is OFF again (`read` alone passes,
  `shell` alone 403s, the old `bash`+`read` pair still passes) — the genuine
  pair stays as insurance, the gate has flipped five times;
- session id: canonical `ses_*` whose inverted 48-bit word DECODES to a fresh
  `unix_ms` plus a counter. RE-MEASURED 2026-10-25: the counter window that
  PR #69/#70 chased is gone (1/32/63/64/128/4095 all pass, only 0 fails) and
  the TIMESTAMP is checked instead — a digest-derived prefix is a random
  timestamp and 429s every request (see the third half below). The mint is
  clock-based with a 1-based per-process counter;
- all FOUR session spellings ride the same id (`x-opencode-session`,
  `x-opencode-session-id`, `x-session-affinity`, `x-session-id`) and
  `x-opencode-request` is ABSENT — both facts byte-captured 2026-10-24; the
  affinity pair was a foreign-client signal only under the 1.x header set;
- `x-opencode-project` is the client's own id for this host's working
  directory (`src/adapter/project.ts`, a port of the 2.2.0 `Project.resolve`):
  nearest `.git` -> `sha1("git-remote:" + host/path of origin)` ?? the
  `<common dir>/opencode` file ?? the first root commit ?? `global`; nearest
  `.hg` -> its file ?? root changeset ?? `global`; neither ->
  `sha1("directory:" + abs path)`. The `<env>` block reads the SAME resolution
  (`Workspace root folder`, `Is directory a git repo`), so header and prompt
  name one place. `prj_*` is refused; `global` and any 40-hex also pass;
- the UA version segment tracks the INSTALLED client and the shipped value is
  `2.2.0` (the desktop CLI landed 2.2.0 on 2026-10-27). The gate does not pin
  the version string (2.0.29 / the 1.19.0 app branch / the built-in all pass,
  probed 2026-10-23/24), and the 2.2.0 CLI binary keeps the recipe stable
  (strings 2026-10-28: same header set with no `x-opencode-request`, the same
  `shell`+`read` pair — `read` byte-identical, `shell` assembled from the same
  fragments — and the `<env>` block), so only the UA version moves and the
  2.1.4 capture stays the shipped recipe. The 2.2.0 UA answered a live 200
  on 2026-10-29 (see the wire-parity bullet below);
- WIRE PARITY with the 2.2.0 client (TLS capture 2026-10-29,
  `docs/local/capture-214/tls/`): the adapter -> relay path now emits the
  client's 16 headers with the same names, casing and order, the same
  request line, and the same body key order
  (`model, messages, tools, stream, stream_options, max_completion_tokens`).
  What it took: the relay drops what the Node stack adds (`x-stainless-*`,
  `accept-language`, `sec-fetch-mode`, the SDK's `accept`) and lets Bun add
  `Accept: */*` (docs/relay.md §3); `b3`/`traceparent` are minted in the
  client's format (one trace per conversation, a fresh span and parent per
  request); pi-ai's compat is pinned (`supportsStore: false`,
  `supportsDeveloperRole: false`) because behind the loopback relay its
  opencode.ai detection no longer fires and it added `store` and the
  `developer` role; pi-ai 1.x additionally reads only a NORMALIZED transcript
  (`normalizeContext`, `@earendil-works/pi-ai/utils/transcript`), and a raw
  `Context` silently loses `systemPrompt` and the tools folded with it — the
  adapter therefore normalizes at that boundary and `test/zen-adapter.test.ts`
  pins it, because the gate only reads the appended `<env>` block and would
  happily accept a body whose real prompt had vanished; the leading system
  messages ride the system role (they used to be sent as a user turn); the
  `<env>` block is appended as the
  client's two instructions (`Today's date: …`, then `Here is some useful
  information about the environment you are running in:` + the block), with
  the temp line `realpath(os.tmpdir())/opencode`. The gate does NOT read the
  extra Node headers (both sets answered 200 the same day); parity is kept so
  no single header can become the next refusal. Live through
  `http://127.0.0.1:1087`: plain chat and a tool call both 200 on
  `/inference/openai/v1/chat/completions`. Re-check with a loopback capture
  (drive `ZenAdapter` -> relay -> a local server, diff against
  `tls-headers.log`) whenever pi-ai, the OpenAI SDK or Bun moves;
- `tool_choice: 'none'` is rejected.
- status codes, re-read 2026-10-25: `403 FreeTierError` still means the SHAPE
  was rejected (a body without `tools` still 403s that day), but `429
  FreeUsageLimitError` no longer means "gate passed, anonymous quota spent".
  With the window open — the official `opencode-cli 2.1.4` (a Bun binary)
  answers a real 200 from this machine, direct AND through pool exit
  `127.0.0.1:30033` — a BYTE-IDENTICAL replay (the captured 16 headers, the
  captured body, the official family path) answers 429 from Node h1, Node h2,
  curl 8.7 h2, Python urllib and Go net/http, on every egress tried (direct
  v4/v6, the client's own ULA source address, all 7 pool exits). Header set,
  body, route, `accept-encoding`, HTTP version and source IP are each ruled
  out one variable at a time, and a local-CA TLS capture of the genuine
  client shows no extra live-only header or cookie: a CONNECTION-STACK gate
  (the client's TLS/HTTP fingerprint) now sits in front of the quota layer,
  and no payload edit reaches it. Probe scripts and raw results live under
  `docs/local/capture-214/` (gitignored); this machine's own ledger agrees —
  every plugin request since 10-24 books 0 tokens while the official client
  books 200s.
- the gate has THREE halves, ALL now shipped (resolved 2026-10-25):
  1. **payload** — the system prompt must carry a non-empty `<env>` block (the
     official 2.1.4 prompt is 8368 chars, the block starting at index 7731).
     Bun stack held constant, one variable per request: empty `<env>` -> 429,
     the same lines without the tags -> 429, the official prefix truncated at
     6000/7200/8000 chars (before the block) -> 429, `<env>` plus ONE real line
     -> 200, block-only system prompt -> 200. `src/adapter/env-block.ts` appends
     the official-shaped block (real cwd/workspace/platform, never the captured
     text), wired through `ensureFreeLaneShape` /
     `ensureResponsesFreeLaneShape` in `src/adapter/messages.ts`;
  2. **connection stack** — the request must leave through Bun. The official
     client is a Bun binary; `src/relay/supervisor.ts` spawns
     `relay/oc2dsh-relay.mjs` (a bun process, shipped in the package `files`)
     and the adapter addresses its requests at that loopback base URL, so the
     relay's `fetch` opens the upstream connection. Pool exits ride the same
     hop: the adapter picks with the pool's own `pick(session, model)` and sends
     the exit in `x-oc2dsh-egress` (`http://` = Bun proxy, `socks5://` = the
     relay's own CONNECT->SOCKS5 bridge), which the relay strips before
     forwarding. Verdicts come back through `src/relay/egress.ts` so exit
     health and usage attribution survive the move.
  3. **session-id freshness** — the canonical `ses_*` prefix must DECODE to a
     recent timestamp. The lane reads `~(unix_ms*0x1000+counter)` out of the
     12-hex field and refuses one it cannot believe: with Bun egress and an
     otherwise accepted body, prefixes decoding to now / -1h / -1d / -7d / -30d
     answer 200, a future one (+30d) and every effectively-random one answer
     429, and counters 1/32/63/64/128/4095 all pass while counter 0 fails. The
     digest-derived prefix the PR #69/#70 port introduced is exactly a random
     timestamp, so it 429'd EVERY request — this is the half that survived both
     the `<env>` fix and the relay and made the whole thing look like a quota
     problem again (found 2026-10-25 by bisecting session ids last).
     `src/adapter/ids.ts` therefore mints a CLOCK-based prefix again (counter
     1-based, per-process monotonic) and caches one id per conversation, so
     freshness and per-conversation affinity both hold; a stale inbound id is
     re-minted with its tail kept.
  Missing any one still reads as `429 FreeUsageLimitError`, all three measured
  one variable at a time on the same body: Bun + fresh id -> 200; Node + fresh
  id -> 429 (stack); Bun + stale id -> 429 (freshness); Bun + fresh id without
  the `<env>` block -> 429 (payload). Probe scripts and raw results live under
  `docs/local/capture-214/` (gitignored); the relay ships in `relay/`.
- and a FOURTH cause that is not a gate at all: the free quota is per EGRESS
  ADDRESS. Same bytes, same relay, same minute (2026-10-25): pool exit -> 200,
  this machine's own egress -> 429 with `retry-after: 55248` (~15 h 20 m). A
  session that spends its egress IP's quota therefore looks exactly like a
  fingerprint rejection, which is how one 15-minute outage cost three separate
  investigations. Read the `retry-after` before touching any wire code: absent
  = one of the three halves, present = that egress's quota is spent and a
  different exit fixes it. `relay/oc2dsh-relay.mjs` appends the egress
  (本机出口 or 出口 <url>) and the reset window to the 429 message the host
  displays, because the relay is the only hop that sees both the status and the
  exit it chose.

## Egress row hygiene (protocol mismatch)

A row's `protocol` is typed by the operator (manual rows) or inferred by the
subscription converter, and nothing used to check it against the listener. Live
2026-10-25: manual row `127.0.0.1:30035` said `http` while sing-box served
SOCKS5 on that port, so the relay sent HTTP CONNECT into a SOCKS server, the
server dropped the socket, and EVERY request failed in 6 ms with
`502 relay_error ECONNRESET` — the same port answers 200 through `socks5://`.

Four behaviours cover it, all live-measured:

- `src/pool/protocol.ts` decides what a listener actually speaks (a SOCKS5
  greeting, then an origin-form `GET /` a proxy answers without dialling, then
  an HTTP CONNECT to an RFC 5737 address — nothing is dialled).
  `null` means undecided and is never guessed from.
- pinning (`POST /api/oc2dsh/ip-pool/exit`, action `pin`) probes first: a row
  speaking the other protocol is relabelled and pinned (`corrected` in the
  reply), a port with nothing behind it is REFUSED (`exit-unreachable`) instead
  of silencing the lane for a whole session. Rows with measured facts skip the
  probe.
- a transport cut goes to `src/pool/transport.ts`, never straight to a strike.
  A row with NO measured facts gets one free diagnosis per OUTAGE: nothing
  answering -> struck dead; the other scheme -> relabelled AND revived; the
  right scheme -> the row stays pickable in the 'unknown' tier and the next cut
  is the strike. An outage ends when something proves the row alive
  (`provenAt` = a 2xx or a passing probe), NOT when a timer runs out — a 30 s
  window pardoned a row that failed every couple of minutes, which is how a
  listener with a dead tunnel stayed in service (measured: 8 cuts, 0 successes,
  pinned row still picked). A row with measured facts still strikes immediately
  — its label came from real traffic, so the cut IS the verdict.
- `revive()` is why a corrected label actually restores service: a dead mark
  outlives its cause otherwise, because `pick()` skips dead rows and the only
  other proofs (a real 2xx, the card's 探测) are unavailable to a row nothing
  routes to. Pinning a dead row revives it through the same door.

A pin that is set but unusable still falls through to the rotation (that is
what 主力+备胎 promises), and the fall-through is now LOUD: the pool's
`onPinnedSkip` warns once per outage, and `/status` carries `pinnedSkip`
(`'dead'` / `'cooling'`) so the card can say the requests are using another
exit. Live 2026-10-25: the badge said 固定主力 while the row was dead and the
session was riding other exits, which read as "the pin is working".

The relay also retries one failed proxied connect on the other scheme and
remembers the correction per host:port (`PROTO-FIX` in its log), which rescues
the request that hit the mismatch instead of only the next one. Its SOCKS
bridge has a 3 s handshake timeout and answers `502` instead of dropping the
socket — a silent peer used to hang a request with no status line — and the
rescue retry is bounded at 8 s for the same reason. `test/relay-script.test.ts`
runs the real script against real listeners (skipped without `bun`);
`test/protocol.test.ts` covers the detector, `test/transport.test.ts` the
verdicts.

A machine without `bun` still works: the supervisor resolves null, the adapter
sends directly, and the lane answers 429 — the exact pre-fix behaviour, not a
new failure mode. `relay.enabled: false` reproduces it deliberately.

Changing any single header/tool/ID shape in isolation is how this lane has
broken three times; re-probe the live endpoint one variable at a time before
and after any such change, and record the results HERE (or in `docs/`) — code
comments carry only the contract the request must satisfy.

## Install / upgrade on this machine

```sh
dsh plugin --profile web add file:/Users/ankh/workspace/private/dsh-plugins/dsh-ocz-provider
```

(Profile `web` carries this checkout as `"dsh-opencode2free-provider":
"file:…/dsh-plugins/dsh-ocz-provider"` in `~/.dsh/profiles/web/package.json`.)

An install does NOT affect a running dsh web; restart the host to load new
`lib/` code. Do not `npm publish` or bump versions without explicit consent.

**A restart alone never refreshes new source.** pnpm treats the `file:`
dependency as a COPY, not a link (`nodeLinker: hoisted`; `file:` packs and
copies, `link:` would symlink), so
`~/.dsh/profiles/web/node_modules/dsh-opencode2free-provider/lib/` keeps the
`lib/` that existed when the add last ran. After changing `src/` (and running
`pnpm build`), re-run the add command above — it re-copies `lib/`, `locale/`,
`assets/` and `cordis.patch.yml` in a couple of seconds — and only then restart
the host. Live 2026-10-18: a new settings switch stayed invisible through a
restart for exactly this reason; the profile copy still held the previous
build (`grep localFallback …/lib/client.js` returned 0 while the checkout's
`lib/client.js` carried it). Check the profile copy's `lib/` timestamp — or
grep it for a string only the new build has — before blaming the host.

## Diagnosing a pool that looks off

The card's 启用 IP 池 switch is the SETTING (`ipPool.enabled`); the stats
modal's 未启用 is the LIVE state (`installer.enabled`). They diverge whenever
the routing layer never took the global dispatcher, and until the status file
carried `pool`, the only trace was a `logger.warn` in the host's in-process
buffer — i.e. invisible. `~/.dsh/oc2dsh/adapter-status.json` answers it now:

- `pool.ready` false → the pool never assembled: `applyIpPoolSettings()` threw
  and `pool.wiringError` carries the message (index.ts catches it so the
  provider route survives, which is exactly why it used to vanish).
- `pool.ready` true with `pool.enabled` false → the routing layer yielded
  (R1): `pool.deferredReason` names the foreign dispatcher.
- `pool.singbox` null means no binary configured, `{ running: false }` a
  configured child that died — the subscription nodes can serve while routing
  is off, and vice versa, so one flag never answers the other.

The stats modal renders those three separately, so the local-only exit table
(exit rows are filtered when the pool is off) no longer reads as "the pool is
switched off".
