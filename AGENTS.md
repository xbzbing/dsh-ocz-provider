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

Upstream this fork ported fixes from: `jasonxu114514/opencode2api` (its Go
agent survives under `legacy/` as a semantic reference, not distributed).

## Layout

```
src/adapter/    zen-adapter (dsh-llm adapter), catalog, messages (body shaping),
                gate-tools (the captured genuine tool definitions), events,
                routing (which API shape a model takes), ids
src/pool/       exit pool: admission (free-lane probing), dispatcher (routing),
                installer, onboarding, sing-box conversion, subscription fetch,
                usage-store (the ~/.dsh/oc2dsh/usage.json ledger)
src/ip-pool-settings/  namespace (schema), bridge (loopback HTTP), apply (wiring)
src/client/     browser half: IP pool settings card, exit-stats modal (+ its
                流量 tab), Zen request-headers editor, locales
src/config.ts   the whole settings schema (Config, exported for dsh-settings)
test/           node:test suite (runs the real TS sources, no build step)
lib/            committed build output (never edit; rebuild instead)
legacy/         the ported Go agent (`cmd/agent` + `internal/`, module
                opencode2dsh/agent; semantic reference only, not distributed —
                see package.json `files`)
scripts/        build.mjs (canonical build), lib-manifest.mjs (freshness stamp),
                smoke-dsh-compat.mjs (loads the real installed host)
docs/           design.md (architecture + porting record), ip-pool.md (exit
                routing design)
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

## Project-specific settings (do not guess these)

| Setting | Value | Where |
| --- | --- | --- |
| Package name (installable unit) | `dsh-opencode2free-provider` | package.json |
| Cordis patch row | `id: oc2dsh`, `name: dsh-opencode2free-provider` (the row name must equal the package name — the loader imports it) | cordis.patch.yml |
| Loader entry id / settings namespace | `oc2dsh` | src/index.ts `name`, src/ip-pool-settings/namespace.ts `IP_POOL_NAMESPACE`, src/client/index.ts `SETTINGS_NAMESPACE` |
| Provider route id (llm-pi-ai, request header) | `oc2dsh` | src/adapter/zen-adapter.ts `PROVIDER_ID` |
| Provider display name (model picker group) | `OpenCode-Zen-Free` | src/adapter/zen-adapter.ts `PROVIDER_NAME` — label only, deliberately separate from the id |
| Loopback bridge prefix | `/api/oc2dsh/ip-pool` | src/ip-pool-settings/bridge.ts `IP_POOL_BRIDGE_PREFIX` (mirrored in src/client/IpPoolCard.tsx) |
| On-disk state root | `~/.dsh/oc2dsh` (env `OC2DSH_HOME` redirects) | src/paths.ts `stateDir()` |
| Credential env var (sidecar only) | `OC2DSH_TOKEN` | src/config.ts |
| Settings form field | `ipPool` (one volatile node; every write path is `['ipPool', <field>]`) | src/config.ts, src/client/IpPoolCard.tsx `IP_POOL_FIELD` |
| Zen request headers (live settings) | `requestHeaders` — separate volatile dictionary edited on the plugin page; case-insensitive overrides for chat + catalog + admission, applied at request time. Empty inherits `userAgent`/built-in defaults; authentication, Cookie and transport/body format headers are managed by the plugin | src/request-headers.ts, src/config.ts, src/adapter/ids.ts `zenRequestHeaders` |
| Per-model context windows (live settings) | `modelContextWindows` — separate volatile dictionary (`model id` → tokens) edited on the plugin page; the catalog reads it on EVERY `limits()` call, so a save applies to the next `resolveModel` without a restart. Precedence: live setting > built-in `LOCAL_MODEL_OVERRIDES` (mimo 1M) > models.dev `limit.context`. Values are sanitized per read, never in the schema | src/model-context.ts, src/config.ts, src/adapter/catalog.ts `limits()`, src/index.ts |
| Zen-lane User-Agent (legacy config, ordinary field) | `userAgent` — empty = the built-in current-client shape `opencode/latest/2.1.4/<client>`, whose last segment mirrors the effective `x-opencode-client` (so Desktop mode sends `/desktop`); it is read at request time by all three senders, so one setting moves chat + catalog + admission | src/config.ts, src/adapter/ids.ts `setUserAgentOverride` / `zenUserAgent` / `opencodeUserAgent` |
| 本机出口协议族 (live setting) | `ipPool.localIpFamily` — `auto` (default) / `ipv4` / `ipv6`, edited on the pool card. It decides which family the LOCAL egress dials with when the pool does not carry the request (固定本机 pin, 本地出口兜底); `auto` = prefer IPv6 where this machine has a routable address and keep Node's happy-eyeballs fallback. Exit traffic is untouched. The free lane refuses this host's IPv4 and accepts its IPv6 on identical bytes (live 2026-10-18) | src/pool/local-family.ts, src/pool/dispatcher.ts `#localEgress`, src/pool/installer.ts |
| Upstream base URL | `https://opencode.ai/inference` (+ `/v1` per call), with `https://opencode.ai/zen` as the second rung of the ladder — chat, catalog and admission all walk it (401/403/404/5xx switch origins, 429/transport/RegionError keep to the IP pool) | src/adapter/catalog.ts `ZEN_BASE_URL`, src/adapter/lane.ts `laneOrigins` |
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
coherence**, not an allow-list. The full picture, each point live-probed, lives
in `src/adapter/messages.ts` (`ensureFreeLaneShape` header comment) and
`src/adapter/ids.ts`. Headlines:

- one recipe, two origins: `/inference` (primary) and `/zen` (fallback) both
  accept this fingerprint, walked as a ladder on an origin-shaped failure
  (`src/adapter/lane.ts`; the console origin was re-probed live 2026-10-19).
  The official 2.1.4 client routes chats to the FAMILY path
  `/inference/openai/v1` (models.dev `api` field, byte-capture 2026-10-24);
  that path and the flat `/inference/v1` answer identically, but the family
  `/models` 404s, so the flat route stays the one origin for chat + catalog +
  admission;
- body must be streaming with a NON-EMPTY `tools` array carrying an entry
  NAMED `read`. The injected pair is the genuine 2.1.4 `shell` + `read`
  (`src/adapter/gate-tools.ts`, byte-captured from the installed CLI —
  `parameters` byte-equal, `description` matched as a substring, and the host's
  superseded `bash` entry is dropped so the wire never mixes generations).
  Re-probed 2026-10-24: content validation is OFF again (`read` alone passes,
  `shell` alone 403s, the old `bash`+`read` pair still passes) — the genuine
  pair stays as insurance, the gate has flipped five times;
- session id: canonical `ses_*` whose inverted 48-bit word carries a counter
  inside 0-63 (the ONLY accepted window; the timestamp half is unchecked) —
  the prefix is derived from the digest with counter 1, never clock-minted
  (a process-global counter 403s everything minted after the 64th);
- all FOUR session spellings ride the same id (`x-opencode-session`,
  `x-opencode-session-id`, `x-session-affinity`, `x-session-id`) and
  `x-opencode-request` is ABSENT — both facts byte-captured 2026-10-24; the
  affinity pair was a foreign-client signal only under the 1.x header set;
- `x-opencode-project` is prefix-less (`global` — the workspace dimension is
  deliberately NOT simulated: no login, no 40-hex directory hash);
- `tool_choice: 'none'` is rejected.

Changing any single header/tool/ID shape in isolation is how this lane has
broken three times; re-probe the live endpoint one variable at a time before
and after any such change, and record the results in the code comments.

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
