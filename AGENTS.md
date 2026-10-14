# AGENTS.md

Agent-facing notes for this repository: what the project is, how to build and
test it, and the project-specific settings an agent must not guess at. Read
this before changing anything.

## What this is

`oc2dsh` — a DSH (DeepSeek Harness) cordis plugin that
registers a native dsh-llm adapter and streams from OpenCode Zen's anonymous
free lane (`Authorization: Bearer public`, no API key), impersonating the
official client's wire fingerprint. The repository root IS the installable
package (`dsh plugin add file:<repo>` or `github:xbzbing/opencode2dsh`); `lib/`
is committed because neither install path runs a lifecycle script.

Upstream this fork ported fixes from: `jasonxu114514/opencode2api` (its Go
agent survives in `legacy/agent` as a semantic reference, not distributed).

## Layout

```
src/adapter/    zen-adapter (dsh-llm adapter), catalog, messages (body shaping),
                gate-tools (the captured genuine tool definitions), events, ids
src/pool/       exit pool: admission (free-lane probing), dispatcher (routing),
                installer, onboarding, sing-box conversion, subscription fetch,
                usage-store (the ~/.dsh/oc2dsh/usage.json ledger)
src/ip-pool-settings/  namespace (schema), bridge (loopback HTTP), apply (wiring)
src/client/     browser half: IP pool settings card, exit-stats modal, locales
src/config.ts   the whole settings schema (Config, exported for dsh-settings)
test/           node:test suite (runs the real TS sources, no build step)
lib/            committed build output (never edit; rebuild instead)
legacy/agent/   the Go sidecar (semantic reference only)
scripts/        build.mjs (canonical build), lib-manifest.mjs (freshness stamp),
                smoke-dsh-compat.mjs (loads the real installed host)
docs/           design.md (architecture + porting record), ip-pool.md (exit
                routing design)
```

## Commands

```sh
pnpm install          # toolchain (root package.json carries everything)
pnpm verify           # the gate: pnpm typecheck && pnpm test  (400/400 today)
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
- Known benign noise: a rebuild may reorder the 101-entry CSS class map inside
  `lib/client.js` (same keys, same values, different key order). Revert it
  (`git checkout -- lib/client.js`) instead of committing the reorder.
- There is no CI here; the gate is `pnpm verify` plus, for wire-facing changes,
  a live probe against `https://opencode.ai/inference/v1`.
- Conventional single-line commit subject + evidence-rich English body that
  quotes the user's request verbatim (Chinese quotes stay verbatim).

## Project-specific settings (do not guess these)

| Setting | Value | Where |
| --- | --- | --- |
| Package name (installable unit) | `oc2dsh` | package.json |
| Cordis patch row | `id: oc2dsh`, `name: oc2dsh` | cordis.patch.yml |
| Loader entry id / settings namespace | `oc2dsh` | src/index.ts `name`, src/ip-pool-settings/namespace.ts `IP_POOL_NAMESPACE`, src/client/index.ts `SETTINGS_NAMESPACE` |
| Provider route id (llm-pi-ai, request header) | `oc2dsh` | src/adapter/zen-adapter.ts `PROVIDER_ID` |
| Provider display name (model picker group) | `OpenCode-Zen` | src/adapter/zen-adapter.ts `PROVIDER_NAME` — label only, deliberately separate from the id |
| Loopback bridge prefix | `/api/oc2dsh/ip-pool` | src/ip-pool-settings/bridge.ts `IP_POOL_BRIDGE_PREFIX` (mirrored in src/client/IpPoolCard.tsx) |
| On-disk state root | `~/.dsh/oc2dsh` (env `OC2DSH_HOME` redirects) | src/paths.ts `stateDir()` |
| Credential env var (sidecar only) | `OC2DSH_TOKEN` | src/config.ts |
| Settings form field | `ipPool` (one volatile node; every write path is `['ipPool', <field>]`) | src/config.ts, src/client/IpPoolCard.tsx `IP_POOL_FIELD` |
| Upstream base URL | `https://opencode.ai/inference` (+ `/v1` per call) | src/adapter/catalog.ts `ZEN_BASE_URL` |
| Editable settings namespace (host side) | served from the Loader entry id — renaming the row id changes where settings live and orphans stored config | cordis.patch.yml |

Renaming any of the identifiers above is a cross-cutting change: the row id
keys the settings namespace, the client bundle's module id, the slot keys and
stored profile config — moving one without the others silently orphans the
operator's saved `ipPool` settings and the usage ledger path.

## The upstream free-lane gate (why wire code looks the way it does)

The anonymous lane fingerprints the client; the gate is **fingerprint
coherence**, not an allow-list. The full picture, each point live-probed, lives
in `src/adapter/messages.ts` (`ensureFreeLaneShape` header comment) and
`src/adapter/ids.ts`. Headlines:

- endpoint `/inference/v1`; body must be streaming with genuine `bash` + `read`
  tool definitions (`src/adapter/gate-tools.ts`, captured verbatim —
  `parameters` byte-equal, `description` matched as a substring);
- session id: canonical `ses_*` whose inverted 48-bit word carries a counter
  inside 0-63 (the ONLY accepted window; the timestamp half is unchecked) —
  the prefix is derived from the digest with counter 1, never clock-minted
  (a process-global counter 403s everything minted after the 64th);
- no `x-session-affinity`/`X-Session-Id` in this fingerprint;
  `x-opencode-request` is a `msg_*` id (optional but never `req_*`);
- `x-opencode-project` is prefix-less (`global`);
- `tool_choice: 'none'` is rejected.

Changing any single header/tool/ID shape in isolation is how this lane has
broken three times; re-probe the live endpoint one variable at a time before
and after any such change, and record the results in the code comments.

## Install / upgrade on this machine

```sh
dsh plugin --profile web add file:/Users/ankh/workspace/private/opencode2dsh
```

An install does NOT affect a running dsh web; restart the host to load new
`lib/` code. Do not `npm publish` or bump versions without explicit consent.
