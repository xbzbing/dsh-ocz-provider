# AGENTS.md

Agent-facing notes for this repository: what the project is, how to build and
test it, and the project-specific settings an agent must not guess at. Read this
before changing anything. The measurements behind every wire rule are in
`docs/wire-fingerprint.md`.

## What this is

`oc2dsh` — a DSH (DeepSeek Harness) cordis plugin that registers a native
dsh-llm adapter and streams from OpenCode Zen's anonymous free lane
(`Authorization: Bearer public`, no API key), impersonating the official
client's wire fingerprint. The repository root IS the installable package.
`lib/` is gitignored and produced by `pnpm build`: no install path runs a
lifecycle script (pnpm runs none for a `file:` directory dep and blocks
git-hosted builds behind `allowBuilds`), so a build is an explicit step taken
before `dsh plugin add file:<repo>` — and a `github:` install ships no artifact
at all, which is why it is not supported.

Upstream this fork ported fixes from: `jasonxu114514/opencode2api` (the ported
Go agent lives in git history; this tree is TypeScript only).

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
                出口/流量/工具 tabs), Zen request-headers editor, locales
src/config.ts   the whole settings schema (Config, exported for dsh-settings)
test/           node:test suite (runs the real TS sources, no build step)
lib/            build output (gitignored; `pnpm build` before installing)
scripts/        build.mjs (canonical build), lib-manifest.mjs (freshness stamp),
                smoke-dsh-compat.mjs (loads the real installed host)
docs/           design.md (architecture + porting record), ip-pool.md (exit
                routing design), relay.md (Bun upstream relay contract),
                wire-fingerprint.md (the gate's probe record)
```

## Commands

```sh
pnpm install          # toolchain (root package.json carries everything)
pnpm verify           # the gate: pnpm build && pnpm typecheck && pnpm test
pnpm build            # clean build: node half -> browser half -> manifest
pnpm build && pnpm pack   # tarball
node scripts/smoke-dsh-compat.mjs /path/to/@deepseek-ai/dsh   # real-host smoke
```

- `lib/` is not in git. `pnpm verify` builds first, so the gate always runs
  against current sources; `pnpm test` alone skips the artifact tests
  (test/client-build.test.ts, test/lib-fresh.test.ts) when there is no build,
  while an existing but stale `lib/` still fails `lib-fresh` (it re-runs
  `scripts/lib-manifest.mjs --check`, which compares `src/`, both bundle configs,
  `package.json` and `pnpm-lock.yaml` against the stamp written at build time).
- Both halves build through `tsdown.config.ts` / `tsdown.client.config.ts` with
  fixed `chunkFileNames: '[name].js'` — chunk names are stable across rebuilds;
  do not reintroduce content hashing.
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
is what it is) belong in `docs/design.md`, `docs/ip-pool.md`,
`docs/wire-fingerprint.md` or this file, not in a comment; a comment may point
at the doc in one clause, never carry the argument itself.

## Project-specific settings (do not guess these)

| Setting | Value | Where |
| --- | --- | --- |
| Package name (installable unit) | `dsh-opencode2free-provider` | package.json |
| Cordis patch row | `id: oc2dsh`, `name: dsh-opencode2free-provider` (the row name must equal the package name — the loader imports it) | cordis.patch.yml |
| Loader entry id / settings namespace | `oc2dsh` | src/index.ts `name`, src/ip-pool-settings/namespace.ts `IP_POOL_NAMESPACE`, src/client/index.ts `SETTINGS_NAMESPACE` |
| Provider route id (llm-pi-ai, request header) | `oc2dsh` | src/adapter/zen-adapter.ts `PROVIDER_ID` |
| Provider display name (model picker group) | `OpenCode-Zen-Free` | src/adapter/zen-adapter.ts `PROVIDER_NAME` — label only, deliberately separate from the id |
| Loopback bridge prefix | `/api/oc2dsh/ip-pool` | src/ip-pool-settings/routes.ts `IP_POOL_BRIDGE_PREFIX` (re-exported by bridge.ts, mirrored in src/client/types.ts `BRIDGE_PREFIX`) |
| On-disk state root | `~/.dsh/oc2dsh` (env `OC2DSH_HOME` redirects) — `usage.json` (traffic ledger), `pool-health.json` (cooldowns/bans/facts), `adapter-status.json`, `tool-catalog.json`, `singbox/` (config + `ports.json` + `onboarding.json`) | src/paths.ts `stateDir()` |
| Plugin log file | `~/.dsh/oc2dsh/logs/oc2dsh.log` — every `info`/`warn`/`error` the plugin logs, mirrored off the host logger (batched, 2 MiB × 3 rotations). The host keeps plugin lines in an in-process buffer (stderr only when started from a terminal), so this file is the only artifact that survives a restart; read it FIRST when a pool change has to be explained after the fact | src/log-file.ts, src/index.ts |
| Reload handoff (routing layer, pool health, sing-box child) | An unrelated plugin's install/uninstall recomposes the profile and HMR re-applies us **in the same process**, so every dispose used to cost a routing gap (`requests fall through`) plus a cold pool. `src/pool/slot-lease.ts` offers the installed dispatcher layer on dispose and the next generation only swaps its pool in (`installer.retarget`, 60 s grace closes it when nobody claims); `src/pool/pool-health.ts` persists cooldowns / bans / passive counters / measured facts to `<stateDir>/pool-health.json` with per-fact TTLs (a proven `ok` is a 10-minute hint, an expired claim falls back to `unknown` while its facts stay = 已测速·未验证); `src/pool/singbox-lease.ts` hands the live child over and the next supervisor adopts it only when the fingerprint-free node set (`screeningKey`) and the port table match. Tests: `test/slot-lease.test.ts`, `test/pool-health.test.ts`, `test/singbox-lease.test.ts` (the last runs a real fake-binary supervisor pair) | src/pool/slot-lease.ts, src/pool/pool-health.ts, src/pool/singbox-lease.ts, src/pool/installer.ts `retarget`, src/ip-pool.ts |
| Node identity → local port map | `~/.dsh/oc2dsh/singbox/ports.json` (atomic write, 2000-entry cap), deliberately outliving the supervisor so a restart does not renumber every node from 30001 and repoint every pool row at the wrong node. Beside it `singbox/onboarding.json` keeps each node's last speed-pass verdict with its own measurement time, so a rebuild inside the 20-minute TTL reuses them; only verdicts about the exit are stored (a timeout is re-probed, a round that measured nothing writes nothing) | src/pool/singbox.ts `#loadPorts`/`#persistPorts`, src/pool/onboard-cache.ts (rationale: docs/ip-pool.md §4.7) |
| Known-tools catalogue | `~/.dsh/oc2dsh/tool-catalog.json` — the BASELINE tool set (recorded while the lane answered), the CURRENT set (latest observation + host registry), and the operator's per-tool `wire`/`description` overrides. It is the answer to "dsh was upgraded, did any tool name or description move", which the settings card cannot show. State, not settings: one description runs to ~1 KB and the settings form re-serializes its whole document twice per read. Merge order for a tool's wire shape: override > `WIRE_TOOL_RENAMES`/`CLIENT_TOOL_DESCRIPTIONS` > as-is. Editing a wire name retires the old spelling into the reply alias table, so a call already on the wire still resolves | src/tool-catalog.ts, src/adapter/messages.ts `ToolShapeResolver`, src/adapter/zen-adapter.ts `#observeTools`, src/ip-pool-settings/handlers.ts `tools()`, src/client/ToolCatalogPanel.tsx |
| Settings form field | `ipPool` (one volatile node; every write path is `['ipPool', <field>]`) | src/config.ts, src/client/settings-writes.ts |
| Zen request headers (live settings) | `requestHeaders` — separate volatile dictionary edited on the plugin page; case-insensitive overrides for chat + catalog + admission, applied at request time. Empty inherits `userAgent`/built-in defaults; authentication, Cookie, transport/body format headers, the client-identity flag `x-opencode-client` and every `x-oc2dsh-*` control header are managed by the plugin | src/request-headers.ts, src/config.ts, src/adapter/ids.ts `zenRequestHeaders` |
| Per-model context windows (live settings) | `modelContextWindows` — separate volatile dictionary (`model id` → tokens) edited on the plugin page; the catalog reads it on EVERY `limits()` call, so a save applies to the next `resolveModel` without a restart. Precedence: live setting > built-in `LOCAL_MODEL_OVERRIDES` (mimo 1M) > models.dev `limit.context`. Values are sanitized per read, never in the schema | src/model-context.ts, src/config.ts, src/adapter/catalog.ts `limits()`, src/index.ts |
| Zen-lane User-Agent (legacy config, ordinary field) | `userAgent` — empty = the built-in current-client shape `opencode/latest/2.3.0/cli`; the client flag is pinned to `cli` and no setting moves it (the header is plugin-managed). Read at request time by all three senders, so one setting moves chat + catalog + admission | src/config.ts, src/adapter/ids.ts `setUserAgentOverride` / `zenUserAgent` / `opencodeUserAgent` |
| 本机出口协议族 (live setting) | `ipPool.localIpFamily` — `auto` (default) / `ipv4` / `ipv6`, edited on the pool card. It decides which family the LOCAL egress dials with when the pool does not carry the request (固定本机 pin, 本地出口兜底); `auto` = prefer IPv6 where this machine has a routable address and keep the IPv4 fallback, and relay traffic gets the same choice as an `x-oc2dsh-egress: direct;family=4|6|prefer6` directive. Exit traffic is untouched. The polarity of that refusal FLIPS (both directions measured), so a hard pin on either family is a one-way ticket; relay traffic therefore retries one direct attempt on the other family and remembers the answer for 30 min (`FAMILY-FIX` / `FAMILY-MEMO` in its log), which is why `auto` survives a flip | src/pool/local-family.ts, src/pool/dispatcher.ts `#localEgress`, src/pool/installer.ts, src/ip-pool.ts relay seam, relay/family-fallback.mjs |
| Upstream base URL | `https://opencode.ai/inference` (chats + `/openai/v1`, catalog/admission model list + `/v1`), with `https://opencode.ai/zen` as the second rung of the ladder — chat, catalog and admission all walk it (401/403/404/5xx switch origins, 429/transport/RegionError keep to the IP pool) | src/adapter/catalog.ts `ZEN_BASE_URL`, src/adapter/lane.ts `laneOrigins` |
| Upstream relay (ordinary config) | `relay` — `enabled` (default true), `bunPath` (empty = search PATH, `OC2DSH_BUN`, `~/.bun/bin`, Homebrew prefixes, nvm's node bin dirs), `port` (0 = ephemeral; the relay reports its port on stdout as `OC2DSH_RELAY_READY <port>`), `upstream` (default `https://opencode.ai`). Started lazily by `listModels`/`prepareCall`/the catalog refresh, never at `apply()`; a host without bun keeps working and answers 429. Loopback only and authenticated: every request path carries `/_/<token>` (random per spawn, `OC2DSH_RELAY_TOKEN`, folded into `baseUrl`, stripped before forwarding), the Host must be the relay's own loopback authority (421 otherwise), its CONNECT bridges only reach the upstream host, and the child gets an allowlisted env with no proxy variables. Crashes share one restart budget with backoff, and the budget is GIVEN BACK after 60 s of uptime — it bounds a crash loop, not a process lifetime. Debug: `OC2DSH_RELAY_TRACE=1` mirrors the child's log; the component contract is `docs/relay.md`. A plugin reload does not kill it: the outgoing supervisor hands the live child to a process-level lease (60 s grace) and the next generation adopts it after a health probe; an uninstall leaves it unclaimed and the lease ends it. Both children leave a `{pid, marker}` record that the next start sweeps, signalling a leftover only while its command line still carries our own marker so a recycled pid never kills a stranger | src/relay/supervisor.ts, relay/oc2dsh-relay.mjs, src/config.ts, src/relay/lease.ts, src/child-record.ts |
| Editable settings namespace (host side) | served from the Loader entry id — renaming the row id changes where settings live and orphans stored config | cordis.patch.yml |
| Config schema nodes must stay plain | NEVER put `.transform()` (or any callback-bearing node) in `Config`. dsh-settings rebuilds the served form from `Config.toJSON()` (`plainSchema`) and serializes it a SECOND time for the browser; a transform's `callback` survives the first `toJSON()` but is dropped on that rebuild, so the browser rehydrates a callback-less node, `ConfigFormController.decode()` throws `callback is not a function`, and the whole configuration card stays loading forever — invisible. Validate at the editor and request boundaries instead | src/config.ts, test/request-headers.test.ts, test/model-context.test.ts, scripts/smoke-dsh-compat.mjs |

Renaming any of the identifiers above is a cross-cutting change: the row id
keys the settings namespace, the client bundle's module id, the slot keys and
stored profile config — moving one without the others silently orphans the
operator's saved `ipPool` settings and the usage ledger path.

The row `name` is not a free rename knob: it has to equal the package name,
because the loader imports it. A user-layer patch can only edit a row whose
`name` matches — on a mismatch the loader logs `patch: name mismatch for
"oc2dsh" (expected …, got …), skipping`, the row keeps the wrong name, and the
next restart fails with `ERR_MODULE_NOT_FOUND`, which surfaces as the plugin
simply not starting.

## The free-lane gate (what a request must satisfy)

The lane fingerprints the client: it compares the request against the official
OpenCode build and answers EVERY refusal with `429 FreeUsageLimitError`, so the
status code never says which rule broke. The gate is fingerprint coherence, not
an allow-list, and it moves — assume it can move again.

- payload: streaming, a non-empty `tools` array carrying the genuine 2.1.4
  `shell` + `read` pair (`src/adapter/gate-tools.ts`), and a non-empty `<env>`
  block in the system prompt (`src/adapter/env-block.ts`). `tool_choice: 'none'`
  is refused.
- connection stack: the request leaves through Bun (`relay/oc2dsh-relay.mjs`),
  with the client's own header names, casing and order.
- ids: canonical `ses_*` whose encoded word DECODES to a fresh `unix_ms`, the
  id on all four session spellings, no `x-opencode-request`, and
  `x-opencode-project` resolved from the workspace (`src/adapter/project.ts`).
- tool entries: NAME, PARAMETER SHAPE and DESCRIPTION are three independent
  tells. A name the client never sends ships under the client's own spelling or
  a neutral one (`WIRE_TOOL_RENAMES`); a name the client also ships carries the
  client's own description text (`CLIENT_TOOL_DESCRIPTIONS`).
- UA: the version segment tracks the INSTALLED client, not a pinned string.
- one cause that is not a gate at all: the quota is per EGRESS ADDRESS, so a
  spent exit reads exactly like a refusal.

A dsh upgrade can move this list, so the plugin keeps a known-tools catalogue
(the 工具 tab) that diffs today's set against a recorded baseline and lets the
operator override one tool's wire name or description. Recording freezes what the
catalogue knows now, and an OBSERVED entry outranks the host registry
(`ctx.tools`) for the same name: the registry is the early warning, because a
preset narrows it before a step sees it.

Probing rules: one variable per request, on an egress whose state you know; a
refusal costs nothing while a 200 spends that egress's own quota; `retry-after`
is neither a recovery predictor nor a way to tell the two apart. The one
reliable control is the official client's own captured body on the same exit
seconds apart. Re-probe after every dsh, client, pi-ai or Bun upgrade, and never
commit a wire fix before a live 200. Evidence: `docs/wire-fingerprint.md`.

## Egress row hygiene (protocol mismatch)

A row's `protocol` is typed by the operator (manual rows) or inferred by the
subscription converter, and nothing used to check it against the listener: a row
saying `http` on a SOCKS5 port made the relay send HTTP CONNECT into a SOCKS
server and every request fail in 6 ms.

- `src/pool/protocol.ts` decides what a listener actually speaks (SOCKS5
  greeting, then an origin-form `GET /`, then an HTTP CONNECT to an RFC 5737
  address — nothing is dialled, and `null` is never guessed from).
- pinning probes first (`POST /api/oc2dsh/ip-pool/exit`, action `pin`): a row
  speaking the other protocol is relabelled and pinned (`corrected` in the
  reply), a port with nothing behind it is REFUSED (`exit-unreachable`) instead
  of silencing the lane for a whole session.
- a transport cut goes to `src/pool/transport.ts`, never straight to a strike. A
  row with NO measured facts gets one free diagnosis per OUTAGE (dead mark, or
  relabel + revive); a row with measured facts strikes immediately. An outage
  ends when something PROVES the row alive (`provenAt` = a 2xx or a passing
  probe), not when a timer runs out — a window pardoned a row that failed every
  couple of minutes.
- `revive()` is why a corrected label restores service at all: `pick()` skips
  dead rows and nothing else routes to a dead row. Pinning a dead row revives it
  through the same door.

A pin that is unusable still falls through to the rotation (that is what
主力+备胎 promises), and the fall-through is LOUD: `onPinnedSkip` warns once per
outage and `/status` carries `pinnedSkip` (`'dead'` / `'cooling'`). The relay
also retries one failed proxied connect on the other scheme and remembers the
correction per host:port (`PROTO-FIX`), its SOCKS bridge has a 3 s handshake
timeout and answers `502` instead of dropping the socket, and that rescue retry
is bounded at 8 s. `test/relay-script.test.ts` runs the real script against real
listeners (skipped without `bun`); `test/protocol.test.ts` and
`test/transport.test.ts` cover the detectors and the verdicts.

A machine without `bun` still works: the supervisor resolves null, the adapter
sends directly, and the lane answers 429 — the exact pre-fix behaviour, not a
new failure mode. `relay.enabled: false` reproduces it deliberately.

Changing any single header/tool/ID shape in isolation is how this lane has
broken three times; re-probe the live endpoint one variable at a time before and
after any such change, and record the results in `docs/wire-fingerprint.md`.

## Install / upgrade on this machine

```sh
cd /Users/ankh/workspace/private/dsh-plugins/dsh-ocz-provider && pnpm build
dsh plugin --profile web add file:/Users/ankh/workspace/private/dsh-plugins/dsh-ocz-provider
```

The build is not optional: `lib/` is gitignored, and the add copies whatever is
on disk — a checkout that was never built installs a package whose `main` does
not exist, which surfaces at load as `ERR_MODULE_NOT_FOUND`.

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
the host. Check the profile copy's `lib/` timestamp, or grep it for a string
only the new build has, before blaming the host.

## Diagnosing a pool that looks off

The card's 启用 IP 池 switch is the SETTING (`ipPool.enabled`); the stats
modal's 未启用 is the LIVE state (`installer.enabled`). They diverge whenever the
routing layer never took the global dispatcher, and until the status file
carried `pool`, the only trace was a `logger.warn` in the host's in-process
buffer — i.e. invisible. `~/.dsh/oc2dsh/adapter-status.json` answers it now:

- `pool.ready` false → the pool never assembled: `applyIpPoolSettings()` threw
  and `pool.wiringError` carries the message (index.ts catches it so the
  provider route survives, which is exactly why it used to vanish).
- `pool.ready` true with `pool.enabled` false → the routing layer yielded (R1):
  `pool.deferredReason` names the foreign dispatcher. That is now the
  REPLACE-style case only (dsh-http-proxy, dsh-llm-proxy), or a composer that
  refused to adopt us.
- `pool.ready` true with `pool.enabled` true and `pool.composedUnder` set → the
  layer JOINED below a composing dispatcher (dsh-privacy-gateway's
  MaskingDispatcher, which ranks layers by role: `route` above `proxy`).
  Healthy, not a deferral: masking runs on the plaintext body first, then this
  router picks the exit. A composer is strictly optional.
- `pool.singbox` null means no binary configured, `{ running: false }` a
  configured child that died — the subscription nodes can serve while routing
  is off, and vice versa, so one flag never answers the other.

The stats modal renders those four separately, so the local-only exit table
(exit rows are filtered when the pool is off) no longer reads as "the pool is
switched off".

A row's state label is one rule, not two: `src/client/exit-state.ts`
(`exitRowState`) classifies a row once and both tables name it. A row with no
health claim splits on whether this machine measured the exit — 「已测速·未验证」
(`exitIP` non-empty: a port that now serves another node, or a failed lane
probe) versus 「未验证」 (nothing ever reached it). `onboard.ts #refreshFacts`
restores the speed-level claim (`pool.markMeasured`, only `unknown` → `ok`) for
a row that entered the round with no facts and was measured — without it every
port renumber left most rows ranked behind every `ok` row, so they got traffic
only when nothing better was left and never earned the 2xx that would have
climbed them back. The row's third action icon is 探活 (`/probe`, `scope:
'exit'`): the subscription flow never probes the lane on its own, so that button
is the only way to settle such a row without real traffic.
