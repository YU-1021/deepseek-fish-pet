# DSH 双向桥（petd ⇄ DeepSeek Harness）

> 状态：已实现并实测（2026-11-22）。代码在 `apps/petd/src/dsh/`、`apps/petd/src/gateway/methods/dsh.ts`；
> 冒烟 `apps/petd/scripts/dsh-smoke.mjs`；配置段 `config.dsh`；前端规格见任务书 §8.16。

## 1. 目标

把桌宠和 DeepSeek Harness（DSH）接起来，两种方向：

| 方向 | 用途 | 是否花 token |
|---|---|---|
| DSH → 桌宠（只读观察） | 知道 DSH 现在是空闲 / 思考中 / 正在用工具，用来驱动桌宠的小动画或状态灯 | 否（只尾读本机会话文件） |
| 桌宠 → DSH（写方向） | 把一段任务交给 DSH 的私有会话，等它这一回合回答完拿结果 | 是（调模型） |

不做的事：不读桌面 GUI 正在使用的会话内容做展示（只做状态归纳）；不把 DSH 的 key 复制到 petd；
不默认自动把用户的话转给 DSH。

## 2. 为什么这样接

DSH 有几种通道，逐个排除后选了两条：

1. **桌面 GUI 的 HTTP 服务（127.0.0.1:19387）**：只服务浏览器/SPA，不是文档化的对外 API，不采用。
2. **ACP（`dsh --profile acp`）**：标准 ACP v1 stdio，可用，但审批/提问/事件都要再适配一层。
3. **SDK（`dsh --profile sdk`）**：stdio 上的 newline-delimited JSON-RPC 2.0，协议自带
   `session/prompt`、`session.event`、`session.status`、`approval/request`、`user-question/ask`，
   正好覆盖「问一句 + 等回答 + 要权限」三件事，最终选它。
4. **直接复用桌面进程的 SDK 服务**：desktop profile 不挂 SDK stdio；`session/resume` 只能恢复
   **没有被占用**的持久会话，无法附着到 GUI 正在用的会话。所以写方向自己起一个私有 runtime。

## 3. 读方向：只读观察（默认开启，不花 token）

- 位置：`$DSH_HOME/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`。
- 格式：多个 zstd 帧串联（magic `28 B5 2F FD`），每帧是一段 JSONL（一行一个事件）。
  Node 24 自带 `zlib.zstdDecompressSync`，不需要外部依赖。
- 做法：找 mtime 最新的会话文件 → 只读尾部（默认 4MB）→ 切帧解压 → 取最后最多 600 个事件 → 归纳快照：
  - `state`：`working`（正在调工具）、`thinking`（思考/收结果/回合开始）、`idle`（回合结束或无事件）
  - `turn` / `step`、当前 `tool`（工具名）、`lastText`（最后一段回答文字，截 300 字）
  - `active`：文件在 `dsh.activeMs`（默认 15 秒）内更新过
- 缓存：按「文件 + mtime + size」缓存解析结果；文件没变只刷新 `active`，不重复解压。
- 轮询：`dsh.observeIntervalMs`（默认 1500ms）；只在快照有变化时广播 `dsh.activity`。
- 开销：不 spawn 进程、不连网络、不调模型；实测读取 1 个 16MB 会话的尾部是毫秒级。
- 隐私：只读本机文件、不落盘、不上传；工作区名会从 `--C-deepseek--` 还原成 `C:\deepseek`。

真实事件是 envelope 形状：

```json
{"type":"assistant/message","seq":123,"time":1760000000000,
 "data":{"turn":3,"step":5,
         "message":{"role":"assistant","content":[
           {"type":"reasoning","text":"…"},
           {"type":"text","text":"收到"},
           {"type":"tool-call","id":"call_1","name":"edit","arguments":"{…}"}]}}}
```

即 `turn/step/message` 在 `data` 下；`assistant/message` 的 content 里文本块是 `{type:'text',text}`、
工具调用是 `{type:'tool-call',id,name,arguments(JSON 字符串)}`。解析统一走 `protocol.ts` 的
`viewDshEvent()`，同时兼容早期扁平形状。

## 4. 写方向：私有 SDK runtime（懒启动，花 token）

- 启动：`node spawn "<DeepSeek Harness 安装目录>\DeepSeek Harness.exe"
  --expose-internals "<...>\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
  --profile sdk`，环境变量 `ELECTRON_RUN_AS_NODE=1`，cwd 用 `config.dsh.cwd`（默认 `<home>/dsh-workspace`）。
  - 为什么用 Electron exe：桌面安装里的 `node_modules` 在 `app.asar` 内，普通 Node 看不见、也起不来；
    Electron 以 Node 模式运行时可读 asar，所以直接借它当运行时。
  - 所以 `runtime.ts` 对 `cli.js` 的存在性检查会跳过 `app.asar` 内部路径。
- 握手：`initialize {cwd, provider, model, reasoningEffort?, maxTokens?, approvalRequests?}` →
  `{serverInfo:{name,version}}`。凭证复用 DSH 已存的（managed credential store），**不需要**
  `DEEPSEEK_API_KEY`（那是 headless profile 才要的）。
- 协议：每行一个 JSON-RPC 2.0 帧；petd 自己实现 `DshRuntime`（pending map + 超时 + 退出清理）。
  - 请求：`session/prompt {sessionId, contentBlocks:[{type:'text',text}]}` → `{messageId}`（只是入队回执）
  - 事件：`session.event {sessionId, event}`、`session.status {sessionId, status}`
  - 服务端请求：`approval/request`（回 `{outcome:'allowed-once'|'rejected'|'cancelled'}`，注意要包在
    JSON-RPC 的 `result` 里）、`user-question/ask`（未实现时回 `-32601`）
  - `session/resume {sessionId}`：恢复没被占用的持久会话
- 等回答：`dsh.ask` 用 `BRIDGE_SESSION_ID='petd-bridge'` 发 prompt，收集 `assistant/message` 里的
  text，等到 `turn/end` 返回 `{text, sessionId, turn, durationMs}`；默认超时 3 分钟（可调）。
  会话是持久的，`turn` 会跨调用累加。
- **持久会话的坑**：对已存在的 `sessionId`，`session/prompt` 会返回
  `session "petd-bridge" already exists`。桥的处理是：匹配到 `already exists` 就先
  `session/resume` 再重试一次（`promptSession()`），所以重复调用不会失败。
- 审批：`dsh.approvalPolicy` 默认 `reject`——DSH 要危险权限时直接拒；改成 `ask` 则广播
  `dsh.approval {id,sessionId,toolName,reason,at}` 等前端 `dsh.approval.answer`，120 秒没人答按拒绝。
- 停止：先发 `shutdown`（2 秒），没退再等 3 秒，最后 kill；petd 退出时 `dsh.stop()` 会清干净。

## 5. 配置（`config.dsh`）

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 桥总开关；关掉后 `dsh.prompt/ask` 返回 `E_UNAVAILABLE`（中文提示） |
| `observe` | `true` | 是否自动开只读观察（不花 token；关掉还能手动 `dsh.observe`） |
| `exePath` | `""` | `DeepSeek Harness.exe`；留空自动找（LOCALAPPDATA → F:\DSH → Program Files） |
| `cliPath` | `""` | SDK runtime 的 `cli.js`；留空按 exe 目录推 `resources\app.asar\...\cli.js` |
| `cwd` | `""` | 私有 runtime 工作目录；留空 `<home>/dsh-workspace` |
| `provider` / `model` | `deepseek-official` / `deepseek-flash` | 模型参数 |
| `reasoningEffort` | `high` | 思考强度；空串表示不传 |
| `maxTokens` | `16000` | 单次回答上限 |
| `approvalPolicy` | `reject` | `reject` 直接拒 / `ask` 广播审批事件问人 |
| `askTimeoutMs` | `180000` | `dsh.ask` 等回答的默认上限（5s–10min） |
| `observeIntervalMs` | `1500` | 观察轮询间隔 |
| `activeMs` | `15000` | 文件多久内更新算「活跃」 |

## 6. 方法与事件

方法（7 个，`health.status.methods` 可动态读）：

- `dsh.status`（read）：桥/观察器/runtime/路径/计数/待审批
- `dsh.observe`（read）：立刻扫一次并返回快照
- `dsh.start` / `dsh.stop`（write，非幂等）：手动起停私有 runtime
- `dsh.prompt`（write，120s）：只入队，返回 `{sessionId, messageId}`
- `dsh.ask`（write，10min45s）：等回答，返回 `{text, sessionId, turn, durationMs}`
- `dsh.approval.answer`（write）：`{id, outcome}` → `{resolved}`

事件：

- `dsh.status {status}`：runtime 状态变化
- `dsh.activity {snapshot}`：观察快照变化（不花 token）
- `dsh.event {sessionId, type, at, turn?, step?, tool?, text?}`：私有会话事件摘要（text≤500）
- `dsh.approval {id, sessionId, toolName, reason, at}` / `dsh.approval.resolved {id, accepted}`

## 7. 实测数据（2026-11-22）

- 单测：`node --test "dist/**/*.test.js"` **360/360**；其中 DSH 相关 27 项
  （协议解码 6 / runtime 6 / observer 7 / 方法 6 / bridge 8，含真实 envelope 与 already-exists 重试）。
- 冒烟 `node scripts/dsh-smoke.mjs`：**22/22**、5.9s（真起 petd、自动定位 exe/cli、真观察桌面会话、
  真 spawn 私有 runtime 握手 `provider=deepseek-official`、停止退出），不花 token。
- `--live`：**24/24**、6.4s，真模型回答「收到」（turn=3，会话持久化回合累加）。
- 握手耗时 1.5–2.5s；观察一次 <10ms（缓存命中时不到 1ms）。

## 8. 限制与后续

- 写方向是**独立私有会话**，不附着桌面 GUI 正开着的对话；想接着聊 GUI 的会话得等它空闲后
  `session/resume`（协议限制，非本桥能绕）。
- SDK 协议没有 cancel/close 方法：要中断只能关 runtime（`dsh.stop`），未完成请求按超时处理。
- 协议没有版本协商：DSH 升级后字段变化需回归 `dsh-smoke.mjs --live`。
- 私有 runtime 同一时间一个会话（`petd-bridge`）；要并行多任务需要多起 runtime 或改用 session 列表。
- 回答 text 单段截 500 字进事件；完整文本只在 `dsh.ask` 返回值里。
- `user-question/ask` 未实现（DSH 问用户时桥回 -32601），后续可照审批模式加。

## 9. 排查

| 现象 | 原因 / 处理 |
|---|---|
| `DSH 桥已关闭（config.dsh.enabled=false）` | 打开 `config.dsh.enabled` 或调 `dsh.start` 前检查 |
| `DSH SDK runtime 握手失败` | exe/cli 路径不对；看 `dsh.status.paths` 与 petd 日志 |
| `session "petd-bridge" already exists` | 旧版本遗留；当前版本会自动 resume 重试 |
| `dsh.ask` 超时 | 私有 runtime 没起来 / 模型慢 / `maxTokens` 太大；看 `dsh.status.lastError` |
| 观察不到状态 | 桌面 DSH 会话不是 v4、或会话目录不在默认 `$DSH_HOME/sessions`；看 `dsh.status.observer` |
| 事件里没有 turn/step | DSH 改了 envelope 形状；更新 `viewDshEvent()` 并跑单测 |

调试脚本（临时，可删）：`C:\deepseek\_tmp-dsh-probe.js`（裸 SDK 握手）、`_tmp-dsh-live.mjs` /
`_tmp-dsh-live2.mjs`（真桥打印事件）、`_tmp-decode.mjs`（解码会话日志）。
