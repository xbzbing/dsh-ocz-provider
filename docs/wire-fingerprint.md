# 免费车道的指纹门禁：实测记录

最后一次更新：2026-11-16。这是 `AGENTS.md`「The free-lane gate」一节的证据档：
改线路代码之前先在这里找到对应的一手测量，不要凭推断改。`src/adapter/messages.ts`
（`ensureFreeLaneShape`）、`src/adapter/ids.ts`、`src/adapter/gate-tools.ts` 只承载
「请求必须满足什么」；这里回答「为什么是这样」。

探针脚本在 `docs/local/`（gitignore）：`capture-214/`、`replay-dump.mjs`、
`mutate-probe.mjs`、`verify-real-body.mts`、`realbody-230-probe.mts` 等。

The anonymous lane fingerprints the client; the gate is **fingerprint
coherence**, not an allow-list. This file is the record of the probe
evidence; `src/adapter/messages.ts` (`ensureFreeLaneShape`), `src/adapter/ids.ts`
and `src/adapter/gate-tools.ts` carry only the contract a request must satisfy.
Headlines:

## 配方（origin / body / 会话 id / UA）

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
  `2.3.0` (the desktop app bundles its CLI at
  `/Applications/OpenCode.app/Contents/Resources/opencode-cli` since 2.2.x;
  2.3.0 landed 2026-11-13). The gate does not pin the version string (2.0.29 /
  the 1.19.0 app branch / the built-in all pass, probed 2026-10-23/24), and
  the 2.2.0 CLI binary keeps the recipe stable (strings 2026-10-28: same
  header set with no `x-opencode-request`, the same `shell`+`read` pair —
  `read` byte-identical, `shell` assembled from the same fragments — and the
  `<env>` block), so only the UA version moves and the 2.1.4 capture stays
  the shipped recipe. The 2.2.0 UA answered a live 200 on 2026-10-29 (see the
  wire-parity bullet below). 2.2.0 -> 2.2.5 (tags `v2.2.0..v2.2.5` plus both
  binaries' strings, 2026-10-31) moves nothing else on the wire: the header
  literal in `model-request.ts` is identical, `identifier.ts`,
  `session-id.ts`, `project.ts`, `affinity.ts` and `system-prompt.ts` have no
  diff, the `<env>`/`Today's date` templates and the `shell`/`read` texts
  match, the chat body key order is unchanged (custom/freeform tools exist
  now, but neither gate tool declares `freeform`), `traceparent` gained a
  `padStart(32)` that is a no-op on a 32-hex trace id, and both binaries
  embed the same Bun v1.4.4 (38afee6c8), so the connection stack holds. Live
  the same day through the relay on prefer6, one variable (the UA) alternated
  2.2.5 / 2.2.0 / 2.2.5 / 2.2.0 on `mimo-v2.6-flash-free`: all four 200, and
  the bumped built-in answered 200 twice more after the rebuild;
- 2.2.5 -> 2.2.7 (tags `v2.2.5..v2.2.7`, the 2.2.7 app binary's strings, and a
  live A/B, 2026-11-12) also moves nothing but that version segment. The tag
  range is 5164 files, so the wire files were diffed by name: `model-request.ts`
  changed only in plumbing — `http: { headers }` became a top-level `headers`,
  the header LITERALS (names, casing, order: `x-opencode-session-id`,
  `x-opencode-parent-session-id`, `x-session-affinity`, `X-Session-Id`,
  `x-parent-session-id`, `User-Agent`, `x-opencode-project`,
  `x-opencode-session`, `x-opencode-client`) are byte-identical and
  `x-opencode-request` is still absent; `session-id.ts`, `identifier.ts`,
  `affinity.ts`, `schema/project.ts` and `session/system-prompt.ts` have no
  diff at all; `core/project.ts` only gained an injectable clock and a
  forkable `activate`, the id RESOLUTION is untouched. The body builder
  (`packages/ai/src/protocols/openai-chat.ts`) keeps every key in place —
  `model, messages, tools, tool_choice, stream, stream_options{include_usage},
  max_completion_tokens, temperature, top_p, frequency_penalty,
  presence_penalty, seed, stop` — and only sources the values differently
  (`request.generation?.X` became flat `request.X`; model metadata moved from
  `compatibility` to `capabilities`, internal). The gate pair `shell`/`read`
  keeps its `Input` schema and description byte-identical (the changes there
  are runtime: `read` gained `skill://` URIs and better not-found text,
  `shell` gained background timeout annotations), the `<env>` block
  (`instructions/builtins.ts`) has no diff, the binary still embeds Bun
  v1.4.4, the zen base-URL set is the same 7 entries, and the free-model list
  is the same 60 ids. Six NEW header names appear in the binary
  (`x-opencode-capabilities`, `-directory`, `-event-watches`, `-org-id`,
  `-ticket`, `-claude-agent-kind`/`-fork-source`) and NONE of them is on the
  model path — they belong to the app↔server media route, the artifact
  handler, the new Console event-watch plugin, usage-limits/voice, and the
  claude-agent provider. Live: on two exits whose quota was still open,
  the same smoke body through one private relay answered 200 for 2.2.5 and
  200 for the 2.2.7 built-in, twice (4/4); the other 11 exits tested answered
  `429` WITH `retry-after` (~10.5-11.4 h), i.e. their egress quota was spent
  and they said nothing about the shape (`docs/local/ua-227-hunt.mts`);
- 2.2.7 -> 2.3.0 (tags `v2.2.7..v2.3.0`, the 2.3.0 app binary and a live
  A/B, 2026-11-16) also leaves the model path untouched. The range is 2110
  files, so the wire files were diffed by name: `model-request.ts` changed only
  in plumbing (messages became `SessionRequestMessage` and lose their `metadata`
  before the provider; tool entries gained `freeform`, a key that serialises
  only when the routed model declares a freeform type, which neither gate tool
  does), the header LITERALS are unchanged and `x-opencode-request` is still
  absent; `session-id.ts`, `identifier.ts`, `affinity.ts`, `schema/project.ts`
  and `session/system-prompt.ts` have no diff; the body builder
  `openai-chat.ts` is untouched; and the zen provider's only change is the
  Console config route reading a new RESPONSE header
  (`x-opencode-instructions-skills`), which is not on the request path. The gate
  pair `shell`/`read` keeps its `Input` schema and default description
  byte-identical (`shell`'s new wording sits behind `autoBackground`, `read` was
  restructured internally), the `<env>` block has no diff, the binary still
  embeds Bun v1.4.4, and the free-model list is the same 60 ids. Live: same
  body, same private relay, same exit, only the UA alternated 2.3.0 / 2.2.7 /
  2.3.0 / 2.2.7 — 200 each (`docs/local/ua-230-scan.mts`, `PROBE_UA=2.3.0`);
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

## 拒绝形状与状态码

- `tool_choice: 'none'` is rejected.
- TOOL NAMES can be refused, and the refusal wears the quota error (2026-10-31):
  a body whose `tools` carries `subagent_fork` is answered `429
  FreeUsageLimitError` on every exit, on this machine's egress and on every
  free model, while the same body with that one name changed answers 200 —
  measured by alternating the two bodies on one exit, 4/4, so it is not the
  budget. The NAME alone decides: schema, description, tool count and body
  size are each ruled out (152 synthetic tools / 35 KB and 40 real schemas /
  131 KB both pass), and duplicate tool names are a different refusal (400).
  `src/adapter/messages.ts` `WIRE_TOOL_RENAMES` therefore ships the host's
  `subagent_fork` as `fork_conversation` and `TOOL_NAME_ALIASES` hands the
  model's call back under the host's name, exactly like `shell` -> `bash`.
  The same table takes 0.2.2's second delegation tool, `subagent_oar`, to
  `oar_agent` on the same reasoning — same family, a spelling no client build
  sends — though that one is preventive: it is not yet measured as refused.
  The same table moves every host name with an honest counterpart onto the
  client's own vocabulary (`ask_user_question` -> `question`, `web_fetch` ->
  `webfetch`, `workflow` -> `execute`), because a name the client never sends
  is one more thing a refusal can key on; names without one keep theirs
  (`web_search` has none — the client's `search` discovers tool signatures).
  MCP tools already match the client's `mcp__<server>__<tool>` form.
  A second refusal shape sits behind that one and it is a PAIR rule: the lane
  tolerates ONE name from a list it keeps and answers 429 as soon as TWO ride
  the same body. `read_image` and `working_directory` each answer 200 alone and
  429 together, with body bytes and tool count held constant — which is why a
  name-by-name bisect found nothing reproducible (34 tools refused, each 17-half
  passed) and why the "35 tools pass / 37 fail" split never made sense. Size is
  a DIFFERENT refusal: a 40 KB padding tool draws `400 server_error`, while 69
  names with every description emptied (7.4 KB) still draw 429, so neither a
  cap nor a count describes it. Both names therefore ship under neutral
  spellings (`image_read`, `cwd`); the full host tool set then answers 200, and
  that same run rules out a third member hiding behind them (68 tools keeping
  one of the two still pass, so at most ONE member remains in the set — a
  seventh tool added later must not be one).
  The host tool set moves under this rule, so re-check the mapped names whenever
  dsh is upgraded. 0.2.2 (alpha.2 -> rc.2, read from `docs/tool-catalog.md` in
  the dsh checkout, generated by booting every tool plugin) took the unique
  name count 70 -> 75: added `apply_patch`, `schedule_edit`, `schedule_view`,
  `office_convert`, `office_recalculate`, `office_render`,
  `user_terminal_list`, `user_terminal_read`; removed `schedule_delete`,
  `schedule_update` (renamed to `schedule_edit`/`schedule_view`) and
  `spawn_teammate`; `team_task_*` and `wait_agent` only MOVED packages
  (experimental-tool-agent-team split into tool-agent-team + tool-subagent-
  control). Every name this module maps still exists in rc.2, so no table edit
  was needed — but the runtime set depends on the preset: rc.2's Web `standard`
  ships `applyPatch: false` (so `apply_patch` is absent), and `office_*` only
  declares after the Office skill loads, so this host's visible set changed
  only by the schedule family and `spawn_teammate`. `apply_patch` is the
  obvious preventive candidate (`patch` is the client's own spelling), but it
  is not measured, so it is not mapped.
  Tool TEXT is not gated (arbitrary descriptions pass), so the same module only
  neutralises the handful of strings that name this host — `$DSH_*`/`harness`,
  `DSH_HOME/skills`, the `dsh-ui` fence and the `[dsh-ui reply]` wording —
  because a wire capture of the full 69-tool set then carries no tell.
  TOOL DESCRIPTIONS are part of the fingerprint, not just names and shapes: a
  tool the client also ships by name must carry the client's own wording, and
  the host's wording under that name is refused with the quota error. Name,
  parameter shape and description are three separate tells — measure which one
  the body actually trips before editing wire code, and re-check after every dsh
  or client upgrade.
  The refusal wears the quota shape, `retry-after` included, so a 429 cannot
  tell "refused" from "spent" — and the header does not either: it reported
  15-18 h while the same IP answered 200 again within 10-16 minutes
  (2026-11-16). Bisect one variable per request on an egress whose state you
  know; a refusal costs nothing, while every 200 spends that egress's quota. The
  one reliable control is the official client's OWN captured body sent on the
  same exit seconds apart — if that answers 200, the 429 under test is a
  refusal, not a budget.
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

## 三种半个门禁（payload / 连接栈 / 会话 id）

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

## 出口额度：不是门禁，但长得一样

Free quota is per EGRESS ADDRESS, which is not a gate at all. Same bytes, same
relay, same minute (2026-10-25): pool exit -> 200, this machine's own egress ->
429 with `retry-after: 55248` (~15 h 20 m). A session that spends its egress
IP's quota therefore looks exactly like a fingerprint rejection, which is how one
15-minute outage cost three separate investigations. A refusal carries
`retry-after` too, so the header cannot separate the two; the relay's own
annotation is what narrows it — `relay/oc2dsh-relay.mjs` appends the egress
(本机出口 or 出口 <url>) and the reset window to the 429 message the host
displays, because the relay is the only hop that sees both the status and the
exit it chose. That annotation names the family it actually dialled, so a 429
reading `本机出口 IPv4` means IPv4 is the family that answered it, and the relay
has already retried IPv6 before you see it: a 429 that still says `本机出口`
reached every family this machine has.

## 工具描述：客户端同名工具必须带客户端原文（2026-11-16）

最晚被发现、也最容易被当成额度问题的一层。

**现场**：某宿主会话持续 `429`，20 个出口、`direct` / `http` / `socks5` /
`prefer6` 全 429，每条都带 `retry-after`；同一分钟、同一台机器上官方客户端 200。
把官方客户端当对照跑一遍，才排除「IP 被限」和「额度耗尽」。

**抓包**：临时给 `relay/oc2dsh-relay.mjs` 加 dump 分支（`~/.dsh/oc2dsh/DUMP_WIRE`
开关，落盘 `~/.dsh/oc2dsh/wire/`），同一会话里拿到两份真实请求：

| | 200 的那次 | 429 的那次 |
| --- | --- | --- |
| 消息 | 2 条 / ~1 KB | 7 条 / ~94 KB |
| 工具 | 2 个（闸门对） | 79 个 / ~82 KB |
| 整包 | 3.7 KB | 158 KB |
| `max_completion_tokens` | 64 | 32000 |

**二分**（`docs/local/replay-dump.mjs` 重放同一份真实 body）：2 个工具 + 94 KB 消息
-> 200，所以消息量、包体、token 上限无罪；`TOOLSLICE` 切片 -> 只剩两个名字：
`file_edit`（宿主 `edit` 的线上拼写）与 `skill`。

**单变量突刺**（`docs/local/mutate-probe.mjs`，每次动一个字段）：

| 变体 | 结果 |
| --- | --- |
| 宿主自己的 description | 429 |
| 改名 `zzz_edit` | 429 |
| 参数换成客户端形状 `path/oldString/newString/replaceAll` | 429 |
| 去掉审批字段 `sandbox_permissions`/`justification` | 429 |
| description 换成 `x` | 200 |
| description 换成 `Edit a file` | 200 |
| 宿主原句只改一个字符 | 429 |
| description 换成客户端自己的原文 | **200** |

名字不是判据（改名照样 429），参数形状也不是（换成客户端的照样 429），
**描述文本才是**。79 工具全量 + 两条客户端描述（`replay-dump.mjs clientdesc2`）
-> 200；同一份真实 body 走生产 `ensureFreeLaneShape`（`docs/local/verify-real-body.mts`）
-> 同出口连发两次 200（真实 SSE）。

**修法**：`src/adapter/messages.ts` 的 `CLIENT_TOOL_DESCRIPTIONS` —— 客户端也有的名字
一律用客户端 `packages/core/src/tool/plugin/*.ts` 里的原文；名字（`file_edit`）、参数
形状、审批字段都不动。只收实测需要的那两条（`file_edit`、`skill`），其余同名工具
（`read` / `write` / `glob` / `grep` / `subagent` / `webfetch` / `shell` / `todowrite` /
`question`）没有测到拒绝，所以没有搬。

**边界未解释**：把宿主原句里的 `UTF-8 ` 整段删掉 -> 200，只改一个字符 -> 429；
完全不相关的短句 -> 200；客户端原文（甚至是客户端某个**参数**的描述句）-> 200。这不符合
精确字符串比较，也不符合试过的任何相似度阈值，可能是措辞/语义分类器，**未验证**。所以
代码里只落「共享名字照抄客户端原文」这一条被验证过的规则，不把猜测写成契约。

**注意**：`edit` 的宿主描述是 59 字符（`Edit an existing UTF-8 text file by replacing
literal text.`），客户端 `file_edit` 是 950 字符；`skill` 两边分别是 139 / 130 字符但
措辞完全不同。以后 0.2.2 的 `apply_patch`（客户端叫 `patch`）是下一个预防候选，未实测，
未映射。
