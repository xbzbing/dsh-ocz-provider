# Changelog

## Unreleased

### Added

- The repository installs from Git: `dsh plugin --profile web add github:xbzbing/opencode2dsh`, or `... add file:<checkout>` for a local clone. No publish step, no build step, and no `allowBuilds` entry. The root package was a private shell whose only dependency was `"@opencode2dsh/dsh-plugin": "^0.3.1"`, so pnpm resolved the upstream package from the registry — and the loader imports the patch ROW's `name`, not the bundle, so it loaded that registry copy while the local build sat unused; a fresh clone was worse, because `lib/` is gitignored and neither install path builds anything. The root is now the installable unit: it carries the plugin's `main` / `exports` / `dsh.client` plus its four runtime dependencies (no nested `file:`, which a git-hosted package cannot resolve — pnpm looks for it relative to the INSTALLING project), and it is named `@opencode2dsh/dsh-plugin` so the existing row already points at it. That name is what makes the three dangerous paths safe: an install now REPLACES an npm-sourced dependency instead of adding a sibling bundle (a sibling would insert `id: opencode2dsh` twice and break settings saves), and the loader's import resolves to this package rather than a second copy. Verified end-to-end in a throwaway profile: exactly one `id: opencode2dsh` row, no skipped bundles, and the installed module imports with `apply` / `Config` / the client export all present.
- Per-exit traffic statistics: the plugin now knows **which exit carried each request**, how many requests each exit served, and how many tokens went through it. The accounting rides two existing seams instead of a new pipe: the routing dispatcher stamps its `pick()` decision into the adapter's ALS routing context (`exitId`, or a `direct` marker when pool-host traffic falls back), and the adapter — the one layer that reads the response's `usage` — records each usage chunk against that stamp as the stream passes through (`attributeUsage()` wraps every attempt's output, so a rotate restart attributes each attempt to the exit that actually carried it). The pool additionally tracks last-used stamps and in-flight counts per exit plus a direct-fallback counter; all of it surfaces on `/status` as `requests` / `lastUsedAt` / `inFlight` / `tokens` per exit and a `direct` bucket. Counters are process-lifetime (restart resets them, by design). Covered by `test/exit-stats.test.ts` (8 tests: activity bookkeeping, context stamping, request lifecycle incl. the silence sentinel, token accumulation, pass-through identity, and an adapter end-to-end run), a bridge projection test, and a bundle check that the tracker singleton is defined exactly once across chunks.
- The exit-stats modal now has a **本机 row** — model traffic that left from this machine instead of a pool exit. Two local buckets feed it: `direct` (pool-host traffic that should have used an exit but could not) and the new `local` (hosts outside `proxyHosts`, plus every request while routing is off), merged into one row with requests, tokens and its own last-used stamp. The adapter is the accounting point, because it is the only layer that sees every model call: `attributeUsage()` now records an unstamped response against `LOCAL_EXIT_ID` instead of dropping it, so the row stays truthful whether the pool is off, misconfigured or healthy — and a pool that silently routes everything locally can no longer look healthy behind a modal full of zeros (the exact failure below). Previously only the `direct` fallback was visible, and only as a summary chip.
- A bottom-left **出口 statistics button** in the sidebar footer (the `sidebar.footer.action` seat above Settings, the same slot `kenz1117/dsh-ui-usage-billing` uses for its cost trigger): a headline number of usable exits with a request/token subline, click-to-open modal. The modal lists every pool exit **sorted by request count** with exit IP, location, state dot, requests, tokens, latency, in-flight badge and last-used time, plus summary chips (usable n/total, requests, tokens, in-flight, direct fallbacks) and an honest empty state for a pool that is off or still fetching. It polls the plugin's own loopback `/status` bridge (2s open / 10s closed), mounts only while this entry's settings are served, and adds `@deepseek-ai/dsh-client-ui-sidebar` as a type-only dependency (`0.1.7-rc.2`, matching its siblings).

### Changed

- `packages/plugin/lib/` is committed instead of gitignored, and the root package carries **no lifecycle script**. Measured before settling on that: pnpm runs no lifecycle script at all for a `file:` directory dependency (so `prepare` can never rescue it), the copy follows `files` with an explicit entry winning over `.gitignore`, and a git-hosted package declaring `prepare` OR `prepack` is refused outright with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` — the `allowBuilds` key it prints contains the commit sha, which would cost one profile edit per commit. Custom scripts such as `build` are not blocked, so the toolchain stays reachable without triggering the gate. Because committing artifacts means someone will eventually edit `src/` without rebuilding, every build now stamps `lib/.build-manifest.json` and `test/lib-fresh.test.ts` fails when it no longer matches `src/` — a stale build cannot be merged. `pnpm build` is the single build entry: it empties `lib/` first (the inner build runs `--no-clean` so the two halves can share the directory), then the node half, then the browser half, then the manifest.
- `packages/plugin` is no longer an installable unit: its `dsh.bundle` declaration and `cordis.patch.yml` are gone, so the duplicate-row-id failure mode is unreachable rather than merely discouraged. Packing a tarball moved to the repository root (`pnpm build && pnpm pack`).

### Fixed

- An unreachable exit can no longer sit in the table as a healthy, grade-S candidate (live 2026-10-13). The exit list showed five rows whose "exit IP" was a local SOCKS5 endpoint (`127.0.0.1:30005`, `:30035`, `:30036`, `:30048`, `:30049`); all five were genuinely broken — one trojan node pointed at the placeholder address `10.255.255.255` (DNS returns the literal, TCP times out), both nodes behind `166.0.16.46` timed out on 443 and 2499, one hysteria2 port on `104.168.6.134:2499` refused while the same host's 443 node worked, and one anytls edge accepted TCP in 235ms but never completed a session. Three defects stacked: `admitTrusted` returns `admitted: true` for every trusted candidate so a paid line is never evicted over one probe failure (docs §4.5), but it returned that for a probe that had reached **nothing**, with `quality: gradeOf(0)` = `S`, and all three call sites read it as "healthy" and called `markOk()` — so each probe round revived them, they stayed in the verified tier that `pick()` ranks first, and they absorbed real requests that died in transport (passive `transport` 4/4/3/3/3, `ok` 0, in one process-lifetime window). The fallback now reports `unverified: true`, grades an unmeasured exit `C` (`UNVERIFIED_QUALITY`) while preserving a real previous measurement, and callers mark it through the new `ExitPool.markUnverified()`: node kept for the next probe, `ok` claim dropped, so it is still usable when nothing verified is left but never outranks a verified exit. Placeholder addresses are dropped one layer earlier too — `isDialableServer()` rejects private/loopback/link-local/CGNAT/multicast literals in both the subscription loop and `SingBoxSupervisor.reload()` with a warning naming what it skipped, so such a node never burns a sing-box port or a rotation slot. The modal stops printing the local endpoint as if it were an exit IP: an unverified row reads `— 127.0.0.1:30005` with a muted endpoint and a 未验证 state, and `availableTotal` no longer counts those exits as available.**
- **An empty `proxyHosts` list no longer disables routing while the pool reports itself healthy** (live 2026-10-13). The settings schema defaults that field to `[]`, and `PoolRoutingDispatcher`'s constructor guarded it with `options.proxyHosts ?? DEFAULT_PROXY_HOSTS` — `??` does not catch an empty array, so the router's host set was **empty** and every request took the uncounted direct branch: model traffic egressed from this machine, `/status` kept displaying `opencode.ai` (the bridge substituted its own display fallback, which is what hid the mismatch), and the exit table stayed at zero requests with 12 healthy exits in the pool. Measured live on the running host process before the fix: the router's `proxyHosts` read `[]`, a `fetch` to `opencode.ai` returned 200 with our counters unmoved, and no socket to any sing-box exit port existed; re-applying `['opencode.ai']` to the live router immediately routed the following requests through six different exits. Empty now resolves to the default everywhere through one `resolveProxyHosts()` helper (constructor, live re-apply, installer getter), blank entries are dropped before matching, and the settings card reads the **router's** effective list rather than a display default, so the two can no longer diverge silently.
- 固定主力 and the manual-proxy list now hot-apply; editing either no longer needs a restart (live 2026-10-12). `manual` / `pinnedExitId` used to be read exactly once, at pool assembly (`buildPoolFromConfig`), so a settings save wrote the config and ran `reconfigure()` without rebuilding the manual rows or re-pinning: the stale pin kept winning `pick()` and the deleted row stayed in the table, which is why the card only ever appeared to work after a restart — docs §5.1 and the IP-5 acceptance line ("设置页改任何项保存即生效无需重启") had been an empty promise for these two fields. Both now run through one `syncManualExits()` shared by assembly and every live commit: it diffs the manual rows the config names (add/remove), re-pins or unpins, touches only `source === 'manual'` rows, and pins an already-admitted exit (a subscription id, say) without re-labelling its source. `ExitPool.pin()/unpin()` keep each row's `pinned` flag in step with the slot, so an unpinned row cannot keep riding the trusted admission path `probeOne` reads.
- An empty pool at assembly no longer means routing never engages: the first admitted exit installs the dispatcher, whatever its source (live 2026-10-12). Only the free refill loop registered an `onAdmitted` hook, so a profile with free disabled and a subscription configured assembled empty, skipped `install()`, filled up minutes later — and nothing called `install()` again: `/status` reported `enabled: false` while 12 healthy subscription exits sat in the table and every request kept going direct (measured live). `ExitPool` gained a pool-level `onAdmitted` (fired when `add()` inserts a NEW node, never on an upsert, with watcher failures swallowed so they cannot fail an admission), and the runtime registers one hook at assembly that installs whenever the pool is non-empty, the dispatcher is not installed, and `enabled` is still on. Free, subscription and manual admissions all ride that one hook.
- A changed subscription URL list is pulled immediately, and saving settings no longer postpones the next refresh (live 2026-10-12). `setUrls()` only re-seeded the list, so a newly added airport stayed unfetched until the next timer tick — 30 minutes of "the setting did not apply" with the shipped default; and `setIntervalMs()` rebuilt the timer unconditionally on every commit, pushing the next pull a full interval away from each save (a save made the pool less live, not more). `setUrls()` now calls `refresh()` when the list really changed and the fetcher is already running (before `start()` the caller owns the first pull, so assembly still fetches exactly once), and `setIntervalMs()` only re-arms when the interval value actually changes.
- With the free source off, the pool-state badge follows the whole pool instead of sitting on "emergency" forever (live 2026-10-12). `state` was always the free-source four-state machine (`availableFree / targetSize`), so disabling free pinned it at 0/20 → `emergency`: a live profile carrying 12 healthy subscription exits showed an emergency badge, leaving the operator no way to tell the pool was fine. The bridge view now carries `stateBasis` (`free` | `pool`): with free on, the documented free-source machine is untouched; with free off, the same thresholds apply to the whole pool's `availableTotal / total`, and an empty population reads `warning` — exits that have not landed yet are not a drained pool.
- A dead exit is no longer permanent (live 2026-10-12). `markDeadStrike()` retires an exit on a SINGLE transport strike, `isUsable()` then hides it from `pick()` forever — and nothing ever re-tested it, because the documented periodic probe (§4.3) and `deadRetryMs` (§4.6) were referenced **nowhere** in the source. A live profile lost all 14 exits this way (false-positive strikes from real chat traffic) and the pool silently drained to zero while still reporting itself enabled; `curl` through those same exits answered both `api.ipify.org` and Zen `/zen/v1/models` in 1.3–2.0s throughout. `ExitPool` now stamps `deadAt` on each strike and exposes `dueForProbe()` — dead exits past their retry budget, expired cooldowns, never-probed exits, and anything past the 10-minute cadence — and `startIpPool` runs a 60-second tick that enqueues exactly those (verified live: a manual round revived all 14). The dispatcher's header window also moves 10s → 30s so it stays looser than the ADAPTER's own first-event budget rather than retiring exits for turns the adapter would happily have waited out, and every dead strike is now logged with its reason (silence before request start / silence before headers / transport error) — the three were previously indistinguishable after the fact.

- TLS-mandatory proxy protocols now get TLS even when their Clash entry carries no TLS field (live 2026-10-12). A real airport's subscription wrote 4 `hysteria2` nodes with no `sni`/`tls`/`client-fingerprint`/`reality-opts`, so `applyTLS()` bailed out and the generated outbound carried no `tls` block at all — `sing-box check` then rejected the ENTIRE config with `initialize outbound[32]: TLS required`, so that round converted zero exits and all 49 nodes stayed parked behind 4 bad ones. Measured against sing-box 1.14.3: `hysteria2`, `tuic` and `anytls` all answer `TLS required` without a `tls` block, while `trojan` does not — so exactly those three are forced now (`anytls` already was). Verified end-to-end by regenerating the config for the same 49-node subscription and running `sing-box check` against it (exit 0).
- The subscription card's 「立即刷新」 button now re-pulls subscriptions (live 2026-10-12). It sent `scope: 'refill'`, which runs the FREE-SOURCE refill round, and the bridge had no subscription scope at all — so `IpPoolRuntime.refreshSubscriptions()` was implemented but had **zero callers**, and a subscription could only ever refresh on its own 30-minute timer. The bridge now accepts `scope: 'subscription'` (returning `{refreshed: true}`) and the button sends it. Symptom this caused: filling `singbox.path` and clicking refresh appeared to do nothing, because the round that would have converted the parked nodes was never started.
- Setting `singbox.path` while the pool is running now takes effect without a restart (live 2026-10-12). `SubscriptionFetcher` captured `deps.supervisor` once at construction, and the fetcher is created at boot then reused across commits, so a path filled in later was never attached: every encrypted node stayed parked as pending-conversion forever with no error to explain it (`~/.opencode2dsh/singbox/` was never even created). The fetcher gained `setSupervisor()`, and `applyConfig()` attaches or replaces the core on every commit — matching the docs §5.1 promise that every knob applies live. Conversion still runs on the next refresh round, so pair it with 立即刷新.

- Subscription URLs saved on the settings page now actually reach the runtime (live 2026-10-12). The card reported "saved" and the Host really did persist the URL, but the pool still assembled with zero subscription URLs — `/status` showed `subscriptions: null` (no fetcher was ever created), the source counter stayed at 0, and re-opening the page showed the field empty again. One cause, two symptoms: the resolved value has been through the schema, and `Schema.array()` hands an absent array an implicit `[]` even without `.default()`, so the legacy flat `subscriptions` key is *always* present and non-nullish — `raw.subscriptions ?? raw.subscription?.urls` therefore resolved to that empty array and discarded the canonical nested URLs. `resolveIpPoolSettings()` now prefers nested `subscription.urls` whenever it carries content and falls back to the legacy key only when it does not; the settings card's `servedSection()` applied the same shadowing rule when rendering, which is why a just-saved URL rendered as an empty list. Both regression tests feed the value through `IpPoolConfigSchema` first — a raw hand-written section has no flat key at all and cannot reproduce the bug, which is why the existing suite missed it.
- Subscription pulls no longer send the hard-coded `clash-verge/1.6.0` User-Agent, which an airport can reject outright: one real airport answers `502 Bad Gateway` for `1.6.0` while serving normally for `clash-verge/v2.0`. The UA is now the settings field `ipPool.subscription.userAgent` (settings-page input, applied live on save — no restart), defaulting to `clash-verge/v2.0`; a blank value falls back to that default rather than sending no UA. Airports commonly allow-list the UA and some choose the returned format from it (Clash-shaped → `proxies:` YAML, v2ray-shaped → base64 links), so the value is now tunable without waiting for a plugin release. `SubscriptionFetcher` gained `setUserAgent()`, and the default lives in exactly one place — `DEFAULT_SUBSCRIPTION_USER_AGENT` in `src/pool/subscription.ts` — so the schema default, the runtime fallback and the client-side mirror cannot drift.

## 0.3.11 (2026-10-11)

### Fixed

- Anonymous free-lane chats survive the session-header gate that went live ~2026-10-09 (#56). Ablation probes against the live lane (2026-10-11) pin the gate to a canonical `ses_*` id in a session header (`x-opencode-session` / `x-session-affinity` / `X-Session-Id`, any one) — not the endpoint or the credential: `/zen/v1` + `Bearer public` + the canonical session the adapter already sends still answers 200, while `/inference/openai` 401s the Bearer. The one path that actually broke was the IP-pool admission smoke probe, which built its own request without the disguise headers; it now sends the full set. Also from the issue's live matrix: a `FREE_LANE_BLOCKLIST` denies the five models the lane can never serve (`exo-free` 410, `jev-1.13-free` SystemOne-only 400, `ling-3.0-flash-fin-free` 400, `muse-spark-1.*-contributor-free` 403 RegionError) ahead of any metadata or S3 vouch, in `list()` and `decision()` alike; and a `LOCAL_MODEL_OVERRIDES` table corrects models.dev's `mimo-v2.6-flash-free` context window (200000 → 1048576, per the MiMo card and the official CLI config). A `GATE_TOOL_ALIASES` seam (with `toolNameAlias` on `toStreamChunks`) stays ready for a future gate spelling that forces a wire alias such as `shell`.
- Cold boots no longer reject an explicit reasoning effort with `UNSUPPORTED_REASONING_EFFORT` when models.dev is slower than `warm()`'s window (#55). `refreshMetadata()` is now stale-while-revalidate: a fresh disk cache (< 7 days) loads as the capability baseline BEFORE the online fetch, so `reasoningCapability()`/`limits()`/`modalities()` answer immediately on a slow-but-healthy network (23s observed); the online answer still replaces the baseline when it lands, and the failure fallback is unchanged.

## 0.3.10 (2026-10-09)

### Fixed

- Tool results from DSH >= 0.2 hosts now land in the `toolResult` slot instead of being re-emitted as phantom `user` messages (#50). dsh-llm 0.2.0-rc.2's `createToolResultMessage` puts the call id on the message (`role: 'tool'`, `toolCallId`, `source.callId`) with plain content blocks and no `tool-result` wrapper, but `toPiContext()` only looked for wrapper blocks — so every tool result arrived as a new user message while no `toolResult` was ever sent, making models report "the tool returned nothing" (`No result provided`) and mistake tool output for user input. A message with no `tool-result` content blocks but a message-level call id now emits exactly one `toolResult` (never a user message); the wrapper-block path keeps precedence so DSH 0.1.x hosts — whose `isError` lives on the block — behave byte-identically. Reproduced and fixed-verified against the real dsh 0.2.0-rc.2 CLI with a control group (stock 0.3.9 reproduces the issue verbatim; the patched build returns the real stdout in the tool slot with no new user message).
- Free-lane 429 bursts are now ridden out silently instead of surfacing mid-conversation (#51). The adapter's `providerRetryPolicy` hook was returning `undefined`, deferring to the host default (5 retries over ~15s), which transient Zen quota windows (~60s, as measured by the IP pool's cooldown bookkeeping) outlasted — a live probe of the reporter's exact combo (`step-5-preview-free`, high effort) saw 5/8 requests immediately 429'd. The returned policy now runs 8 retries with 1s→20s backoff (~91s silent absorption per step, retries still executed — and cancellable — by the host, with the default retryable-code set so deterministic AUTH/REGION_BLOCKED failures are never retried). Live A/B on the same lane: unretryed baseline 5/8 ok, tuned policy 6/6 + 8/8 with bursts absorbed invisibly, stock-policy control stalled one request for 154s where the tuned spacing kept the worst request at 5.2s; real DSH 0.2.0-rc.2 headless e2e (3 sequential tool calls, high effort) completed cleanly.

## 0.3.9 (2026-10-08)

### Fixed

- Exit routing now restores the host's global dispatcher on disable and plugin unload. `install()` read the replaced dispatcher off `setGlobalDispatcher()`'s return value, which is `void` on undici 8.x, so the previous dispatcher was never saved and `disable()` left the `PoolRoutingDispatcher` installed process-wide: every later `fetch` — including unrelated providers' requests — kept routing through the plugin, failing with `routing dispatcher closed` after teardown, and only a process restart cleared it. The outgoing dispatcher is now captured with `getGlobalDispatcher()` before the swap, ours is destroyed before the previous one is reinstalled, a fresh undici `Agent` takes over when nothing was saved, and the "restored" log line only appears when a restore actually happened. The installer test fixture no longer models a `setGlobalDispatcher` that returns the replaced dispatcher (the fiction that hid this bug from the suite).

## 0.3.8 (2026-10-08)

### Fixed

- Manual `ipPool.manual` entries keep the scheme the settings card requires. Admission prefixed its own scheme onto an address that already carried one, so `http://host:port` built `http://http://host:port`, undici's `ProxyAgent` threw `InvalidArgumentError`, and the trusted-source fallback admitted the node with empty facts — the pool read healthy while exit IP, latency, quality and the geo/latency gates never ran for manual exits. Both admission call sites now reuse `exitProxyUri`, the guard the routing path already had, so the two paths cannot drift apart again.
- The model picker no longer sticks to the bootstrap list after a plugin (re)load. Registration-time `listModels()` answered from the 7-id static fallback whenever the client's first read beat the first Zen fetch, and the host caches that snapshot for its whole generation (delisted `mimo-v2.5-free` shown, live ids such as `exo-free` missing). `listModels()` is now async — the host contract already awaits it — and waits for the live catalog, bounded to 4 s so a dead network still answers promptly with the static list; concurrent warmups share `start()`'s in-flight first fetch.

## 0.3.7 (2026-10-04)

### Added

- The stream-liveness watchdogs are configurable. `firstEventMs`, `bodyIdleMs`, and `responsesBodyIdleMs` widen how long a turn waits for the first stream event and how much mid-response silence it tolerates, so a slow cold start no longer has to fail as `first stream event timeout` with no recourse. Unset, the shipped 30 s / 120 s / 300 s windows still apply.
- Add `mimo-v2.6-flash-free` to the static free-model fallback and IP-pool probe choices.

### Fixed

- Image input follows the model's declared modalities instead of a hardcoded
  family. models.dev publishes `modalities.input` per model, but it was never
  read, so every model outside `/^mimo-v2\.6/i` was advertised as text-only
  and DSH refused the attachment with `Model "…" does not support image input.`
  A model that declares `image` is now accepted, one that declares only `text`
  is still refused, and models.dev being pending, absent or silent leaves the
  verified family exactly as it was.

## 0.3.6 (2026-10-01)

### Fixed

- Retry a reasoning-only output-limit response once with thinking Off on models that expose Off. Keep streamed reasoning, sum both requests' usage, and assign fresh block indices. Responses that emitted text or any tool call, upstream failures, cancelled requests, and models without Off are not replayed.

## 0.3.5 (2026-09-30)

### Fixed

- Restore startup on DSH 0.1.7 and 0.2: the client no longer gates on the removed `settingsScope`; the host requires only `llm`. The server entry returns a valid Cordis effect.
- IP-pool configuration uses the served entry form on 0.1.7 and the installed plugin row on 0.2. Saves respect read-only forms, clear overrides when restoring inherited values, preserve older subscription URLs, and apply live. Late pool startup is disposed correctly on unload.
- Muse Spark 1.3 uses Responses for requests and history. Reasoning choices use the nested payload; default requests omit unsupported `none`/`off`. Responses free-lane gate tools use the flat function format and supported `auto` choice.
- Zen's regional 403 rejection is reported as `REGION_BLOCKED`, preserving the upstream explanation instead of making DSH display "API key is invalid". Model availability still depends on upstream regional policy.
- Add the missing `imageRequestPricing` method used by `/compact`.
- Read each model's context and output limits from models.dev, using the declared output budget instead of an extra 32768 ceiling. Invalid or missing limits retain the fallback.
- Windows agent shutdown handles `taskkill` failures and observes exit before starting shutdown. Tests use portable subscription fixtures.

### Added

- Image input for the verified MiMo v2.6 family. User/tool-result attachments are loaded from the harness store; offloaded images stay offloaded, missing files produce placeholders, and text-only models keep their existing capabilities.

## 0.3.3 (2026-09-18)

### Added

- **带推理的免费模型现在可以选择思考等级。** 在 DSH 的模型选择器中，推理模型
  （big-pickle、mimo-v2.5-free、nemotron 系、muse-spark 系等）会出现思考等级
  选项：模型元数据声明了档位的按声明展示（如 muse-spark 的 Minimal–Xhigh），
  其余推理模型提供 Off/Minimal/Low/Medium/High。选 Off 会向上游发送
  `reasoning_effort: "none"`——实测这是唯一能真正让"常思考"模型停止思考的传法
  （只省略该字段时上游保持默认继续思考）；选具体档位原样透传；不选则请求与
  旧版完全一致。非推理模型不出现该选项。

## 0.3.2 (2026-09-18)

### Fixed

- **免费模型全线恢复：修复 2026-09-17 起所有免费源报 `403 FreeTierError`
  （"free tier can only be used from within OpenCode"）的问题。** 经逐项探针
  实测，上游匿名免费通道现在有两道校验，缺一即拒：其一，会话头必须匹配
  OpenCode 官方客户端的会话格式（原先任意 `ses_` 开头的串即可）；其二，请求体
  必须是"智能体形态"——流式且 `tools` 里同时包含名为 `bash` 与 `read` 的
  function 工具（描述与参数不查；纯聊天请求没有工具，故此前全部被拒）。
  插件现在把会话标识确定性映射成官方格式（同一对话仍映射到同一会话，会话
  亲和不受影响），并在发往上游的请求体缺失这两个工具时注入最小桩工具（纯
  聊天附带 `tool_choice: "none"`，模型不会真的调用它们）；免费源准入冒烟
  探测同步改为流式并携带桩工具。

## 0.3.1 (2026-09-11)

### Fixed

- **旧版 DSH 上插件加载失败的问题（用户反馈 `list slot "settings.plugin.item" requires options.id`）。**
  `settings.plugin.item` 槽位在 DSH 0.1.0-rc.7 起由 list（按 `id` 注册）改为 keyed
  （按 `key` 注册）；0.3.0 的设置页卡片按新版 keyed 形态注册，在旧版 DSH
  （≤ 0.1.0-rc.6）上会让整个插件加载失败、启动页报错。现在卡片注册前会探测宿主
  声明的槽位类型，按对应形态注册，两边都能用；即便宿主行为异常，注册失败也只
  跳过设置卡片（控制台警告提示升级 DSH），模型路由不再被拖垮。

## 0.3.0 (2026-09-09)

The release where the IP pool actually works.

### Fixed

- **模型流量现在真正经过 IP 池。** 此前 Node 内置 fetch 与插件所用 undici
  是两个隔离实例，池开启后模型请求仍然直连、路由从未生效。现在开启
  IP 池后模型流量会真实走池中出口。
- **卡死回合不会再挂住整个会话。** 请求遇到出口无响应时会在超时后
  自动换出口重试或如实报错，不再无限等待。
- **慢响应的正常请求不再被误判为坏出口。** 响应哨兵改为双窗口：
  连接阶段 2 秒严格判定死出口，隧道建立后等待响应头放宽到 10 秒，
  避免误杀慢首包的健康流。
- **上游 5xx 不再连带惩罚出口。** 模型自身报错（如权限不足的模型对
  所有人返回 500）不会再把出口标记为失效导致全部流量静默直连。
- **免费源准入恢复正常。** 上游现在要求会话伪装头，探测请求已同步
  补齐；此前免费源候选全部被误拒。
- **池首次攒到出口后自动启用路由**，无需再手动改一次设置来触发。

### Added

- **免费代理源从 26 个扩展到 48 个**，全部逐个实测可用后接入，每轮
  候选量约提升 75%。

## 0.2.7 (2026-09-05)

IP 池发布（IP-0 … IP-7）：出口池与两级健康度、粘性会话路由调度器、
订阅源（含 sing-box 加密节点转换）、设置页热更新、真实流量的被动健康
统计、全量粗筛、适配器层轮换重试、响应静默哨兵、探测模型下拉选择。

## 0.2.6

免费模型目录修复：元数据弃用优先于免费名回退；marketplace 条目指向
可安装的仓库根。
