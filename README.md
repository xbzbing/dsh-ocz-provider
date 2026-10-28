<div align="center">

# oc2dsh

**在 DSH（DeepSeek Harness）里原生使用 OpenCode Zen 的免费匿名模型。**

无需 API Key。无需注册。无需额外进程。

</div>

---

oc2dsh 会向 DSH 注册一个原生的 `LlmAdapter`，直接流式对接
[OpenCode Zen](https://opencode.ai/zen) 的**匿名免费通道**——也就是
OpenCode 官方 CLI 无需登录即可使用的那批免费模型，它们会以 **OpenCode-Zen-Free**
这个常规 provider 出现在你的 DSH 模型选择器里。

插件发出的请求与 OpenCode CLI 的流量完全同形（相同的 User-Agent、相同的
关联请求头），模型目录通过三级回退链保持新鲜。不用登录任何账号，也不用
自己部署任何东西。

## 特性

- **零凭据、零配置**——匿名通道不需要任何 Key；装好、重启、开聊
- **原生 adapter，无 sidecar**——一个 npm 包，没有子进程、没有二进制、没有本地端口
- **CLI 同形伪装**——请求携带 OpenCode CLI 的 User-Agent 和整套会话/请求/项目关联头，按会话派生
- **思考等级可选**——带推理的免费模型在 DSH 模型选择器里出现思考等级选项（模型声明档位的按声明展示，其余提供 Off/Minimal/Low/Medium/High）；Off 向上游发送 `reasoning_effort: "none"` 真正停思考，不选则保持上游默认
- **按声明支持图片输入**——只要 [models.dev](https://models.dev) 的模型条目在 `modalities.input` 里列了 `image`，图片附件就会被放行；只声明 `text` 的模型仍然拒绝；元数据缺省时退回已验证的视觉家族
- **上下文长度可逐模型校正**——models.dev 有时只声明 200K，而 Zen 接口实际支持 1M；在配置页按 `模型 ID = token 数` 覆盖，保存后下一次请求即生效，无需重启
- **实时目录 + 三级回退**——上游实时列表 ∩ 元数据判定免费，断网时依次回退到磁盘缓存与已验证的静态名单
- **自愈能力**——启动期快速重试、周期刷新，并落盘健康快照便于排查
- **规范的错误呈现**——上游故障（限流、鉴权、超时、传输）以分类的 finish 原因送达 DSH，重试策略始终由 DSH 掌控

## 安装

仓库根目录本身就是可安装的包，因此两条 Git 路径都能直接装：不用发版、不用先构建、也不用往 profile 的 `pnpm-workspace.yaml` 加 `allowBuilds`（根包不含任何生命周期脚本，而 pnpm 拦 git 源安装拦的正是这类脚本）。

**从 GitHub 安装**：

```sh
dsh plugin --profile web add github:xbzbing/dsh-ocz-provider
```

**从本地检出安装**：

```sh
git clone https://github.com/xbzbing/dsh-ocz-provider.git
dsh plugin --profile web add file:/path/to/dsh-ocz-provider
```

**从 tarball 安装**（可选）：

```sh
pnpm build && pnpm pack
dsh plugin --profile web add ./dsh-opencode2free-provider-<version>.tgz
```

注意不要用 `dsh plugin add @opencode2dsh/dsh-plugin` 装上游发到 npm 的包：它不含本 fork 的这些修复。本 fork 的包名 `dsh-opencode2free-provider` 没有发布到 npm，两条 Git 安装路径才是本 fork 的。

**验证**：重启 `dsh web`，打开模型选择器，在 **OpenCode-Zen-Free** 分组里选模型即可。

### 从源码开发

`lib/` 是**故意提交进仓库的**——两条 Git 安装路径都不跑构建，产物必须已经在检出里。改了 `src/` 下任何文件后执行：

```sh
pnpm build && git add lib
```

`pnpm test` 会在 `lib/` 与 `src/` 不一致时报错，所以忘重建的产物合不进去。

需要 DSH（DeepSeek Harness）0.1.7 及以上、带 web profile（IP 池设置页依赖 0.1.7 的插件页契约）；Node.js ≥ 20（DSH 能跑就满足）；出站 HTTPS 需可达 `opencode.ai` 与 `models.dev`。

## 配置

默认配置开箱即用。需要覆盖时，编辑 profile 的 `cordis.patch.yml`：

```yaml
- id: oc2dsh
  name: 'oc2dsh'
  config:
    refreshSeconds: 300  # 目录刷新周期（秒）
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `refreshSeconds` | `300` | 实时目录刷新间隔；定价元数据每 24 小时刷新。 |
| `firstEventMs` / `bodyIdleMs` / `responsesBodyIdleMs` | `30000` / `120000` / `300000` | 插件 0.3.7 起支持：流存活超时，单位毫秒，取 `1` 到 `600000` 的整数。分别控制首事件等待、流中静默，以及 Responses 模型（`muse-spark-*`）的静默下限。冷启动慢时可调大 `firstEventMs`。不设置则使用默认值；修改后重启 DSH。 |
| `userAgent` | 内置值 `opencode/latest/2.2.0/<client>`（`<client>` 跟随 `x-opencode-client`，开启 Desktop 模式即为 `desktop`） | 旧 profile UA 配置，供正式对话、目录刷新和准入探测使用；留空使用内置值。页面的 `requestHeaders` 中若有 `User-Agent`，优先使用页面值。修改此旧字段需重启或重新加载插件。 |
| `requestHeaders` | `{}` | 在插件配置页的「Zen 请求头」区域编辑，每行一个 `Header-Name: value`。保存后对下一次正式对话、模型目录和准入探测生效，不依赖 IP 池开关。名称不区分大小写；鉴权、Cookie、HTTP 传输及正文格式头由插件管理。 |
| `modelContextWindows` | `{}` | 逐模型覆盖上下文长度（`模型 ID` → token 数），在插件配置页的「模型上下文」区域编辑，每行 `模型 ID = 1048576`。用于 models.dev 只声明 200K、而接口实际支持 1M 的模型；保存后对下一次请求生效，无需重启。范围 1024–16777216；留空使用 models.dev 声明值（内置仍覆盖 `mimo-v2.6-flash-free` = 1048576）。 |

在 **设置 → 插件 → OpenCode Zen 插件配置** 的「Zen 请求头」里，可以填写：

```http
User-Agent: opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/node.js/24
x-opencode-client: desktop
```

这是本机 OpenCode 桌面版 1.19.0 原始后端隔离实测的 Zen 请求头；之前提取到的 `opencode/1.19.0 (darwin 27.0.0; arm64)` 属于 OpenAI/Codex 插件分支。页面会显示当前生效的 Zen User-Agent。清空编辑区并保存会恢复继承配置，默认仍沿用插件原有 UA，不自动切换指纹。请求头最多 32 个、总长最多 8192 字节，拒绝重复名称、空值及非法控制字符。只配置普通请求头，不在此存放凭据。

校验发生在两个边界，而不是 schema 里：编辑区（`parseRequestHeaders`，严格，非法草稿直接拒绝保存）和每次请求（`sanitizeRequestHeaders`，宽松，静默丢弃非法或被插件托管的头）。`Config` 中的节点必须保持「无回调」——不能使用 `.transform()`：dsh-settings 会用 `Config.toJSON()` 重建配置表单并二次序列化，transform 的回调在这一步丢失，浏览器反序列化后校验会抛 `callback is not a function`，配置卡片将永远停在加载态（2026-10-15 实测：加入 Zen 请求头字段后整页不可见）。

「模型上下文」区域解决的是元数据与实际能力不一致：models.dev 的 `limit.context` 有时只写 200K，而 Zen 接口对同一模型实际支持 1M（`mimo-v2.6-flash-free` 就属于这种情况，插件已内置覆盖）。这里按「模型 ID = token 数」逐行覆盖，例如：

```text
mimo-v2.6-flash-free = 1048576
big-pickle = 1048576
```

保存后 `resolveModel` 在下一次请求读取新的窗口，无需重启。覆盖只改上下文窗口，不改最大输出；范围 1024–16777216，最多 128 个模型，空行忽略，`=` 和 `:` 都可作分隔符。不要设得比模型的最大输出 token 更小，否则宿主的压缩预算会腾不出空间。校验同样在两个边界（`parseModelContextWindows` 严格 / `sanitizeModelContextWindows` 宽松）。

## 工作原理

```
DSH 会话
   │  harness chunk（block-start / text-delta / usage / finish …）
   ▼
ZenAdapter（注册的 LlmAdapter）
   │  pi-ai openai-completions 流式
   ▼
https://opencode.ai/inference/v1   ← Authorization: Bearer public
   携带与 CLI 同形的请求头：
     user-agent: opencode/…
     x-opencode-client, x-opencode-session, x-opencode-session-id,
     x-opencode-request, x-opencode-project
```

- **会话关联**——session id 为规范的 `ses_*`，两半都取自会话摘要：稳定的 Base62
  尾段 + 计数器恒为 1 的降序时间前缀（免费层只接受 0–63 的计数器，且不校验时间戳
  ——因此前缀不取自时钟，长驻进程永远不会走出这个窗口），兼顾上游 prompt-cache
  亲和、不可逆推与跨重启稳定；每请求附一个全新的 `msg_*` 消息 id，project id 用
  客户端同款无前缀 `global`，与 CLI 行为一致。
- **目录回退链**——S1：实时 `GET /v1/models`；S2：models.dev 定价元数据判定
  "免费"；S3：编译期验证的静态名单。上游故障时由磁盘缓存（约 7 天有效期）兜底。
- **韧性**——adapter 在启动时立即注册；若首次目录拉取撞上网络尚未就绪
  （VPN/TUN 重连、DNS 等），会以短周期重试（约 1 分钟内），随后转入常规刷新。

## 健康状态与排查

插件在每轮刷新后写入健康快照：

```
~/.dsh/oc2dsh/adapter-status.json
```

```json
{
  "status": "ready",
  "total": 64,
  "exposed": 9,
  "lastError": "",
  "writtenAt": "2026-08-29T07:01:54.915Z"
}
```

| 现象 | 可能原因与处理 |
| --- | --- |
| 启动页报 `Failed to load plugins … list slot "plugins.item" requires options.id`，或 IP 池条目没有配置页 | DSH 早于 0.1.7 的插件页契约。升级 DSH 到 0.1.7（推荐最新）；页面挂载门控是 `configForms.whileServed`，0.1.6 及更早上整页不出现，模型路由不受影响。 |
| 安装插件后 DSH 0.1.7/0.2 无法启动，报 `pending … settingsScope` | 更新插件到 0.3.5；DSH 0.2 的 IP 池设置在插件页的 oc2dsh 条目里。 |
| 只有 3 个模型 | 启动时网络未就绪，重试会在约 1 分钟内补齐；看 `adapter-status.json` 里的 `lastError`。 |
| `lastError: "fetch failed"` 持续出现 | 出站 HTTPS 到 `opencode.ai` 被拦截；检查代理/VPN 规则。 |
| 对话中报限流错误（`429 … Endpoint is unavailable`） | 匿名通道按 IP 限额，免费模型竞争大。[#51](https://github.com/FishBottle7/opencode2dsh/issues/51) 修复后，插件的 provider 重试策略会静默扛过 429 突发（10 次重试、5s/8s/10s/15s/20s/30s 阶梯间隔，之后封顶 30s，每步最坏约 208s），不再直接抛给用户；仍被打满时可降低思考强度、换一个竞争较小的 `-free` 模型，或在插件设置页开启 IP 池（多出口轮换）。 |
| 思考耗尽输出预算，没有正文 | 插件 0.3.6 会在模型支持 Off 时关闭思考重试一次。已有任何正文或工具调用则不会重试。重试保持原输出上限，仍可能失败，两次请求的用量合并统计。不支持 Off 的模型（如 Muse）需要手动调整设置或更换模型。 |
| Muse 报 `REGION_BLOCKED` / "This model is not available in your country" | Zen 不向当前网络地区提供该模型。插件 0.3.5 保留上游解释；旧版会把这个 403 误报为 API 密钥无效。匿名通道不需要个人密钥，可使用当前地区可用的模型。 |
| 连接 `127.0.0.1:*` 报错 | 旧版（≤ 0.2.0）sidecar 模式在 llm-pi-ai 里留下的 `oc2dsh` 路由遮蔽了 adapter；在宿主设置的 llm-pi-ai 提供方列表里删除该条目即可。 |
| 安装时报 `ERR_PNPM_IGNORED_BUILDS` | `pi-ai` 的传递依赖（`@google/genai`、`protobufjs`）带构建脚本，运行时并不需要。在插件市场里按提示选择允许/拒绝，或在 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds:` 下把这两项设为 `false`。 |

## 安全性

- 不涉及任何机密：匿名通道的 Key 就是字面量 `public`；插件不存储任何东西，也没有任何遥测。
- 安装产物仅限 `lib/`；不执行任何依赖的构建脚本。
- 所有请求均从你的机器直连 `opencode.ai` / `models.dev`。

## 开发

```sh
git clone https://github.com/xbzbing/dsh-ocz-provider.git
cd dsh-ocz-provider
pnpm install                         # 构建工具链
pnpm typecheck && pnpm test          # 全量门禁
pnpm build                           # 干净构建两个半 + 写新鲜度清单
git add lib                          # 产物是提交进仓库的，不是忽略的
```

`pnpm build` 是唯一受支持的构建入口：它先清空 `lib/`，再依次构建 node 半、浏览器半，最后写 `lib/.build-manifest.json`——`pnpm test` 会拿它与 `src/` 比对。两半共用 `tsdown.config.ts` / `tsdown.client.config.ts` 一对配置，chunk 文件名固定，反复重建不会留下 `admission-<hash>.js` 这类垃圾文件。

架构说明与移植记录见 `docs/`；面向 agent 的项目说明（构建命令、项目相关设置、上游闸门）见 `AGENTS.md`。

打包：在仓库根目录执行 `pnpm build && pnpm pack`（根目录才是那个包；根目录**故意不放** `prepack`，因为生命周期脚本正是让 git 源安装被迫要求 `allowBuilds` 的原因）。

## 致谢

- [**opencode2api**](https://github.com/jasonxu114514/opencode2api)，作者
  [@jasonxu114514](https://github.com/jasonxu114514)——本项目最早的匿名通道实现
  就是其单租户 Go agent 的移植版（代码留在 git 历史），目录回退链与请求伪装
  细节同样源自它。
  本项目能成立，全靠它踩过的路。上游的免费通道修复（#69/#70/#83）也曾移植到
  本项目。
- [**FishBottle7/opencode2dsh**](https://github.com/FishBottle7/opencode2dsh)：
  本仓库的上游仓库，因为个人的一些功能喜好导致了仓库的硬分叉：包名、插件
  id、设置命名空间与数据目录都已错开，本仓库的所有改动可以自由合并入上游。
- [OpenCode](https://opencode.ai)——运营免费匿名 Zen 通道。
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)——adapter 模式使用的线上协议层。
- [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 与
  [dsh-market](https://github.com/dsh-market/dsh-market) 社区。

## 许可证

[MIT](./LICENSE) © FishBottle7
