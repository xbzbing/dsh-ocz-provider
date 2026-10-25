# oc2dsh 上游中继（Bun relay）— 组件契约

## 0. 定位

适配器不直接连上游：请求交给本机 `127.0.0.1` 上的 Bun 进程转发，由它发起出站连接。
「为什么必须是 Bun」是上游免费车道的连接栈门禁，证据与结论在 AGENTS.md
《The upstream free-lane gate》——本文只记组件契约（进程、环境变量、超时、转发语义）。

## 1. 进程与就绪

- **拉起**：`src/relay/supervisor.ts` 启动 `relay/oc2dsh-relay.mjs`（bun 进程，随包分发）。
- **懒启动**：`listModels` / `prepareCall` / 目录刷新调 `warm()`；插件 `apply()` 不启动。
  进程内找不到 bun 时 supervisor 解析为 null，适配器直接出网（结果是 429）。
- **bun 查找顺序**：`config.bunPath` → `OC2DSH_BUN` → `PATH` → bun 安装器目录 →
  Homebrew 两个前缀 → `~/.nvm/versions/node/<ver>/bin`（版本目录倒序）。
- **就绪握手**：stdout 打印 `OC2DSH_RELAY_READY <port>`；随后 15 s 窗口内
  （`readyTimeoutMs`）必须应答 `GET /__oc2dsh/health`。
  健康探测走 `node:http` 而非 `fetch`——出口池开启时会替换 `globalThis.fetch`，
  用 fetch 可能被路由或被 mock 应答；5 s 无应答即中止。
- **崩溃重启**：退避 `min(30_000, 500 * 2^(restarts-1))`（500 ms 起倍增，30 s 封顶）；
  连续 60 s 健康归还 5 次预算（语义见 AGENTS.md relay 行）。
- **父进程死亡**：`OC2DSH_RELAY_WATCH_STDIN=1` 时 stdin EOF 即退出。默认关闭，
  因为手启进程或 stdin 接 `/dev/null` 会立刻看到 EOF 而秒退。

## 2. 环境变量与端点

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `OC2DSH_RELAY_PORT` | `0` | 监听端口，`0` = 随机，实际端口由 READY 行上报 |
| `OC2DSH_RELAY_UPSTREAM` | `https://opencode.ai` | 转发目标原点 |
| `OC2DSH_RELAY_HOST` | `127.0.0.1` | 监听地址（只绑回环） |
| `OC2DSH_RELAY_WATCH_STDIN` | 关 | stdin EOF 作为父进程死亡信号 |
| `OC2DSH_RELAY_TRACE` | 关 | 把子进程日志镜像到 stderr |

端点：`GET /__oc2dsh/health` → `{"ok":true,"upstream":…,"pid":…}`，不触上游。
中继只绑回环，且不承载任何机密（车道凭据是字面量 `public`）。

## 3. 转发语义

- `<METHOD> <pathname><search>` 原样转发，响应流原样回传；逐跳头（RFC 7230 §6.1）不转发。
- **出站**由 `x-oc2dsh-egress` 指定，转发前剥除（上游绝不能看到它）：
  缺省 / `direct` → 本机出口；`http://h:p` → Bun `fetch` 的 `proxy`；
  `socks5://h:p` → 本地 CONNECT→SOCKS5 桥再 `proxy`。
  桥的存在是因为 Bun 的 `proxy` 只收 http(s)（socks5 报 `UnsupportedProxyProtocol`），
  而出口池是 SOCKS5 形状；桥只搬字节，TLS 会话与门禁看到的指纹仍是 Bun 的。
- **协议纠错**：一次 connect 失败按另一种 scheme 重试一次，并按 `host:port`
  记住修正（日志 `PROTO-FIX`）；SOCKS5 握手 3 s 超时回 `502`（不静默断连），
  换协议重试上限 8 s。
- `idleTimeout: 255`（Bun 的上限）：更小会把健康的长 SSE 应答拦腰截断。
- **429 注记**：429 是「按出口地址计的配额」，中继是唯一同时看到状态码与所选出站的一跳，
  因此在 `error.message` 上追加出口与重置窗口，其余字段不动（响应仍是合法 JSON）。

## 4. 出口裁决回传（`src/relay/egress.ts`）

- `statusOfFailure()` 用与 `PoolRoutingDispatcher.#observe` 同一张表
  （2xx / 429 = 出口正常，5xx / 传输错误 = 出口故障——pi-ai 只在 `errorMessage`
  文本里给出状态码），出口健康与用量归属在中继化之后仍然成立。
- **fail-closed**：池子无法承载请求且「本地出口兜底」关闭时，向调用方报 fail，
  而不是静默改走本机（与 `pool/dispatcher.ts` `#failClosed` 一致——该开关管的是中继流量）。

## 5. 没有 bun 的机器

supervisor 解析不到 bun → 适配器直接出网 → 车道回 429（连接栈门禁）；
`relay.enabled: false` 刻意复现同一路径。

## 6. 与准入探测的接线

准入冒烟是一次真实 chat 调用，面对适配器**同一道连接栈门禁**：

- 中继在线 → 冒烟经中继发出，带候选出口自己的 egress，裁决才是这个出口的真实结论；
- 中继缺席 → 冒烟直连 → 429（门禁，不是配额）→ 裁决表读成「该出口配额已耗尽」→ **冷却一个健康出口**。

模型列表那一步刻意保持直连：它不受门禁，走中继反而会拿一个能用的中继把坏出口藏起来。

