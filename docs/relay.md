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
- **就绪握手**：stdout 打印 `OC2DSH_RELAY_READY <port>`（按行缓冲解析，跨 chunk 的行也认）；
  随后 15 s 窗口内（`readyTimeoutMs`）必须应答 `GET /_/<token>/__oc2dsh/health`。
  健康探测走 `node:http` 而非 `fetch`——出口池开启时会替换 `globalThis.fetch`，
  用 fetch 可能被路由或被 mock 应答；5 s 无应答即中止。启动期 stdout 只留前 400 字符做失败摘要。
- **崩溃重启**：退避 `min(30_000, 500 * 2^(restarts-1))`（500 ms 起倍增，30 s 封顶）；
  连续 60 s 健康归还 5 次预算（语义见 AGENTS.md relay 行）。
- **启动失败也计入预算**：就绪前退出、超时、健康探测失败都算一次 strike，并给 `warm()`
  设下一次可尝试时间（同一退避）；每次 `prepareCall` 都 `warm()`，没有这个间隔就会每次请求
  重拉一个 bun。预算耗尽后 `warm()` 每 5 min 才再试一次（崩溃循环受限，但瞬时故障能自愈）；
  找不到 bun / 脚本时每 60 s 才再找一次（不刷屏）。
- **停止**：`stop()` 之后 `start()` / `warm()` 一律返回 null、不再 spawn；正在启动的子进程在
  就绪后发现已停止会被立刻杀掉——否则固定端口下会留下孤儿进程占住端口。
- **子进程环境是白名单**：`PATH`、`HOME`、`TMPDIR`、locale（`LANG`/`LC_*`）、Windows 必需的
  `SystemRoot`/`ComSpec`/`USERPROFILE`/`APPDATA` 等、CA 变量（`SSL_CERT_*`、`NODE_EXTRA_CA_CERTS`），
  加上 supervisor 显式设置的 `OC2DSH_RELAY_*`。**不传任何代理变量**：Bun 的 fetch 会读
  `HTTP(S)_PROXY`/`NO_PROXY`，继承它们会让 `direct` 悄悄走环境代理。
- **父进程死亡**：`OC2DSH_RELAY_WATCH_STDIN=1` 时 stdin EOF 即退出。默认关闭，
  因为手启进程或 stdin 接 `/dev/null` 会立刻看到 EOF 而秒退。

## 2. 环境变量与端点

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `OC2DSH_RELAY_PORT` | `0` | 监听端口，`0` = 随机，实际端口由 READY 行上报 |
| `OC2DSH_RELAY_UPSTREAM` | `https://opencode.ai` | 转发目标原点 |
| `OC2DSH_RELAY_HOST` | `127.0.0.1` | 监听地址（只绑回环；supervisor 显式设置） |
| `OC2DSH_RELAY_TOKEN` | 空 | 每次 spawn 由 supervisor 新铸的 192 bit 随机串；设置后每个请求路径必须以 `/_/<token>` 开头 |
| `OC2DSH_RELAY_WATCH_STDIN` | 关 | stdin EOF 作为父进程死亡信号 |
| `OC2DSH_RELAY_TRACE` | 关 | 把子进程日志镜像到 stderr |

端点：`GET <prefix>/__oc2dsh/health` → `{"ok":true,"upstream":…,"pid":…}`，不触上游。

### 2.1 准入（谁能用这个中继）

只绑回环不够：本机任何进程、以及 DNS rebinding 的网页都能连 `127.0.0.1`，进而花掉
用户按出口计的免费额度、借 `x-oc2dsh-egress` 走任意出口（502 的错误文本还能当端口扫描器）。所以：

- **Host**：只收 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`（`<port>` 是本监听端口），
  其余回 `421`。这挡住 rebinding（浏览器发的 Host 是攻击者域名）。
- **令牌**：设置了 `OC2DSH_RELAY_TOKEN` 时，路径必须是 `/_/<token>` 或 `/_/<token>/…`，否则 `403`；
  前缀在读路径之前剥掉，所以上游请求行与令牌无关（线上字节不变）。健康检查同样要令牌。
  比较用 `timingSafeEqual`；令牌不进日志、不进 `status()`（`baseUrl` 只报 `http://127.0.0.1:<port>`，
  因为它会被写进 `adapter-status.json`）。
- supervisor 的 `baseUrl` / `baseUrlFor()` 已包含前缀，适配器与准入探测拼路径时自动带上，无需改动。
- 手工启动（不设令牌）用于调试：不要求前缀，但 Host 校验照旧。

## 3. 转发语义

- `<METHOD> <pathname><search>` 原样转发，响应流原样回传；逐跳头（RFC 7230 §6.1）不转发。
- **请求头对齐官方客户端**：Node 一侧自己加的头不转发——OpenAI SDK 的 `x-stainless-*`、
  undici fetch 的 `accept-language` / `sec-fetch-mode`、SDK 显式的 `accept`。`Accept`
  与 `Accept-Encoding` 交给 Bun 自己补（`*/*`、`gzip, deflate, br, zstd`），和官方客户端
  的 Bun fetch 一样。Bun 按 Fetch 规范排序写出、常见头名规范化大小写，所以只要集合相同，
  上游看到的头名、大小写和顺序就与 2.2.0 客户端的 TLS 抓包逐项相同
  （`test/relay-script.test.ts` 钉住这 16 个头的顺序）。Bun 会自动解压响应体，所以回程
  去掉 `content-encoding` / `content-length` / `transfer-encoding`。
- **出站**由 `x-oc2dsh-egress` 指定，转发前剥除（上游绝不能看到它）：
  缺省 / `direct` → 本机出口（今天的行为）；`http://h:p` → Bun `fetch` 的 `proxy`；
  `socks5://h:p` → 本地 CONNECT→SOCKS5 桥再 `proxy`；
  `direct;family=4` / `direct;family=6` / `direct;family=prefer6` → 本地 CONNECT 桥用指定协议族直拨
  （`src/relay/egress.ts` `directEgressDirective()` 生成这三个值）。`4`/`6` 只用该族；`prefer6` 解析全部
  地址，AAAA 在前，连接失败再落到 A——与 `pool/local-family.ts` 的 `auto` 同一语义。
  前面还有地址可试时单个地址 3 s 连接上限（黑洞 IPv6 不能拖住 IPv4 兜底），最后一个 10 s。
  桥的存在是因为 Bun 的 `proxy` 只收 http(s)（socks5 报 `UnsupportedProxyProtocol`）、也没有协议族开关；
  桥只搬字节，TLS 会话、SNI 与门禁看到的指纹仍是 Bun 的。
- **桥只通上游**：CONNECT 目标必须等于 `OC2DSH_RELAY_UPSTREAM` 的 host:port（https 默认 443），
  其余 `403`——否则每个桥都是一个开放代理，任何本机进程都能借池子出口去任意地方。
  CONNECT 头上限 8 KB（超出 `431`）、10 s 读不完即断；隧道任一侧 close/error 两侧一起销毁
  （客户端取消不会留下半开的上游连接）。SOCKS5 应答按完整长度缓冲解析（可跨多次读），
  未知 ATYP 直接判失败。
- **桥的回收**：监听失败的条目立即删除（不缓存被拒的 promise）；没有打开隧道且 5 min 未用的桥被关闭，
  总数超过 32 时按 LRU 关闭空闲的。
- **协议纠错**：一次 connect 失败按另一种 scheme 重试一次，并按 `host:port`
  记住修正（日志 `PROTO-FIX`）；SOCKS5 握手 3 s 超时回 `502`（不静默断连），
  换协议重试上限 8 s。
- `idleTimeout: 255`（Bun 的上限）：更小会把健康的长 SSE 应答拦腰截断。
- **取消**：调用方的 `request.signal` 传进上游 `fetch`（换协议重试再叠 8 s 超时），客户端断开
  在拿到响应头之前也会取消上游请求；调用方已离开时不再做换协议重试。
- **429 注记**：429 是「按出口地址计的配额」，中继是唯一同时看到状态码与所选出站的一跳，
  因此在 `error.message` 上追加出口与重置窗口，其余字段不动（响应仍是合法 JSON）。
  响应头沿用转发路径同一份清洗后的上游头（`retry-after`、`x-opencode-log-id` 等都保留），
  只去掉与改写后正文不符的 `content-length`/`content-encoding`/`transfer-encoding`。

## 4. 出口裁决回传（`src/relay/egress.ts`）

- `statusOfFailure()` 用与 `PoolRoutingDispatcher.#observe` 同一张表
  （2xx / 429 = 出口正常，5xx / 传输错误 = 出口故障——pi-ai 只在 `errorMessage`
  文本里给出状态码），出口健康与用量归属在中继化之后仍然成立。
- **中继自己的 502 不是上游状态**：`{"type":"relay_error"}` 只在中继的上游 fetch 抛错、
  根本没有状态码时出现（端口没监听、连接被拒、握手超时）。`isRelayTransportFailure()`
  识别它，适配器按**传输中断**结算（交给 `pool/transport.ts`，能把死端口一次判 dead），
  而不是按 5xx 进 dead 桶（被动 5xx 从不判死，死端口会一直被选中）；`lane.ts`
  `isOriginFailure()` 也不再为它换 origin——连接没到达任何一扇门。
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

