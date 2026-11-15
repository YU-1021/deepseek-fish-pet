# pet-ui AI 任务书（前端 / UI 方向）

> 这份文件是给「另一个 AI」读的交接书。它只做 `apps/pet-ui`（新前端），不碰 petd 后端。
> 用户把这份文件丢给那个 AI，说「按这个文件干活」即可；第 11 节有可直接粘贴的开场提示词。

---

## 0. 一句话现状

后端 `petd` 已经能跑：常驻 Node 进程 + WebSocket 网关 + 握手鉴权 + 方法注册 + 事件广播。现在已有
`health.ping / health.status / config.get / session.create/list/get/rename/delete / chat.send`
九个方法；聊天能真连 DeepSeek 并落盘。**缺的是前端**：窗口、设置页、聊天面板、宠物窗、托盘。

你的任务 = 用 React + Vite 把 UI 做出来，通过 WebSocket 调 petd 的方法；不要写业务后端。

---

## 1. 你的边界（重要，先看这条）

- 只写 `F:\DSH\大肥鱼\桌宠\apps\pet-ui/**`。
- **不要改** `apps/petd/**`（Lead 正在同一个仓库里做人格系统）、`packages/protocol/**`（协议冻结）、
  根 `package.json` / `pnpm-workspace.yaml`（workspace 已含 `apps/*`，新建包自动生效）。
- 需要新增前端依赖：只改 `apps/pet-ui/package.json`；执行 `pnpm install` 会顺带改根 `pnpm-lock.yaml`，这是允许的。
- 需要新协议方法（比如 `ui.*`、`pet.*`）：先写进 `docs/pet-ui-待接方法.md`（你建），不要自己改后端。
- 需要协议里没有的事件：同上；先用轮询/`session.get` 顶着。
- 不要动旧应用 `app/`（Electron 33 旧壳，双跑中，阶段 5 才淘汰）。

## 2. 先读什么

1. 本文件。
2. `C:\deepseek\桌宠项目\docs\petd-架构蓝图.md` 的「三、通信协议」「六、pet-ui 技术选型」。
3. `F:\DSH\大肥鱼\桌宠\apps\petd\README.md`（后端怎么跑、方法清单）。
4. `F:\DSH\大肥鱼\桌宠\packages\protocol\src\frame.ts`（帧的 TypeBox schema，可直接 import 复用类型）。

## 3. 技术栈（已拍板，不要换）

- React 19 + TypeScript 5.9 + Vite 7（renderer），Electron 44（main，`electron` 装成 devDependency）。
- 样式：Tailwind CSS 4 + CSS 变量；组件用 Radix UI primitives（只装用到的）+ 自研，**不用 MUI/AntD**。
- 状态：Zustand（UI 状态）+ `useSyncExternalStore`（订阅 petd 事件）。业务数据一律以 petd 为准，不在前端复制。
- 测试：Vitest + Testing Library；Electron e2e 用 Playwright（可选，M1 不阻塞）。
- 包名：`@petd/pet-ui`，`"type": "module"`，脚本至少 `dev` / `build` / `typecheck` / `test`。

分层红线：
- 设置窗/聊天面板/托盘菜单 = 常规 React 组件。
- 宠物窗（透明/置顶/点击穿透）= React 只挂气泡/菜单/HUD；身体动画走命令式 canvas/WebGL 或 CSS transform + rAF，**每帧不要 setState**。
- renderer 不直接碰 fs/子进程/键鼠；所有系统能力都经 petd WS。

## 4. 怎么把 petd 跑起来

```powershell
cd F:\DSH\大肥鱼\桌宠
pnpm install
pnpm -r build           # 编译 protocol + petd
node apps/petd/dist/index.js --home "$env:TEMP\petd-ui-dev" --echo
# 看到一行 READY 即成功；进程保持运行，Ctrl+C 退出
```

启动后 home 目录（`%TEMP%\petd-ui-dev`）里会生成：

- `gateway.json`：`{ port, pid, version, protocol, startedAt }` —— 用 port 连 WS
- `token.json`：`{ token, createdAt }` —— 握手用
- `config.json`、`secrets.json`（含真实 API Key，**不要在 UI 里显示/打印**）、`SOUL.md`、`sessions/`
- `petd.log`

端口是随机分配的（config 里 `gateway.port=0`），**必须读 gateway.json 拿 port**，不要写死。

## 5. 协议（照抄即可，schema 在 packages/protocol）

连接：`ws://127.0.0.1:<port>`，**第一帧必须是 connect**：

```json
{"type":"connect","protocol":1,"token":"<token.json 里的 token>",
 "client":{"name":"pet-ui","version":"0.1.0","pid":1234}}
```

服务端回 hello：

```json
{"type":"hello","server":{"name":"petd","version":"0.1.0","protocol":1,"pid":1234},"sessionId":"s-..."}
```

之后发请求（id 由你生成，同一连接内唯一）：

```json
{"type":"req","id":"1","method":"health.ping","params":{}}
```

服务端回：

```json
{"type":"res","id":"1","ok":true,"data":{"pong":true,"ts":1760000000000}}
```

失败：`{"type":"res","id":"1","ok":false,"error":{"code":"E_BAD_PARAMS","message":"..."}}`

事件（服务端主动推，`seq` 单调递增，可用于检测丢帧）：

```json
{"type":"event","event":"chat.assistant_message","seq":7,"ts":1760000000000,
 "data":{"sessionId":"s-...","message":{"role":"assistant","content":"...","ts":"..."},
         "usage":{"promptTokens":278,"completionTokens":20},"model":"deepseek-flash"}}
```

### 已上线方法（`health.status` 会返回实时清单，UI 请动态读，别硬编码）

| 方法 | 参数 | 结果要点 |
|---|---|---|
| `health.ping` | `{}` | `{pong, ts}` |
| `health.status` | `{}` | `{server{version,pid,startedAt,uptimeMs}, gateway{port,clients}, methods[]}` |
| `config.get` | `{}` | `{version, gateway{host,port}, log{level,maxBytes}}`（不含密钥） |
| `session.create` | `{title?}` | `SessionMeta` |
| `session.list` | `{}` | `{sessions: SessionMeta[]}`（最近更新倒序） |
| `session.get` | `{sessionId}` | `{session: {...meta, messages: [{role,content,ts}]}}` |
| `session.rename` | `{sessionId,title}` | `SessionMeta` |
| `session.delete` | `{sessionId}` | `{deleted:boolean}` |
| `chat.send` | `{sessionId?, text}` | `{session, userMessage, assistantMessage, reply{text,model,usage}}`；无 sessionId 自动建会话；timeout 120s |

`SessionMeta = {id,title,createdAt,updatedAt,messageCount}`。

### 事件（目前有这些，data 形状见 chat/service.ts）

`session.updated`、`session.deleted`、`chat.user_message`、`chat.assistant_message`、`chat.failed`。
后续 Lead 会加 `persona.*`、`config.changed` 等；UI 对未知事件忽略即可。

### 错误码

`E_HANDSHAKE / E_UNAUTHORIZED / E_BAD_FRAME / E_UNKNOWN_METHOD / E_BAD_PARAMS / E_TIMEOUT / E_INTERNAL / E_NOT_FOUND / E_FORBIDDEN / E_UNAVAILABLE`。

## 6. git 纪律（和 Lead 共用一个仓库）

- 从当前 `refactor/petd`（HEAD 6647e10）切分支：`git switch -c feature/pet-ui`。
- 只提交你自己目录的改动：`git add apps/pet-ui`（lockfile 允许一起提交）。
- 小步提交，消息用中文，例如 `feat(pet-ui): M1 壳+连接状态`。
- 不要 merge/rebase 到 `refactor/petd`，不要 force push；做完告诉用户「分支 feature/pet-ui 可以看」。
- 不提交 `node_modules/`、`dist/`、构建产物、大截图；截图放 `apps/pet-ui/docs/evidence/`（<2MB/张）。

## 7. 环境坑（Windows + 这台机器，必须知道）

1. **`ELECTRON_RUN_AS_NODE=1` 在当前终端环境里可能已设置**，直接启动 `electron.exe` 会变成 node 模式并退出。
   运行 Electron 前：`Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`。
2. `electron.exe` 是 GUI 子系统程序，PowerShell 直接 `&` **不等待、管道/重定向拿不到输出**。
   要抓日志：用 Node `spawn(..., {stdio:['ignore','pipe','pipe']})` 等 `close`，或让 Electron 把日志写文件。
3. PowerShell 是 **5.1**，不支持 `?:` 三元运算符；写脚本用 `if/else`。
4. 带中文的 JSON/源码不要用 PowerShell `Get-Content -Raw | Set-Content` 改写（PS5.1 按 ANSI 解码会乱码）；用编辑器/Node 写。
5. Node 24.21 / npm 11 / pnpm 12（经 corepack 可用）；Electron 44 首次安装会下载 ~100MB，慢就等。

## 8. 交付里程碑

**M1（先交这个）**
- `apps/pet-ui` workspace 包能 `pnpm --filter @petd/pet-ui build`。
- Electron main 开一个窗口（先普通窗口），renderer 里连上 petd：显示连接状态 / petd 版本 / 方法数（`health.status`）。
- 断线自动重连（1s/2s/5s 退避）；错误可见不崩。

**M2**
- 聊天面板：会话列表（`session.list`）、选会话（`session.get`）、发消息（`chat.send`）、实时追加
  `chat.user_message` / `chat.assistant_message` 事件、发送中状态、错误提示（含 `E_LLM_*` 的中文）。
- 设置页：读 `config.get`（只读展示即可，别做 key 编辑）。

**M3**
- 宠物窗：透明、置顶、可拖拽、点击穿透切换；气泡/右键菜单；双击开聊天面板。
- 托盘图标（显示/隐藏/退出）。
- 宠物窗动画允许先用一个占位立绘（PNG/WebM），美术资产不在你的范围。

**证据**：每个里程碑给 1–2 张截图 + 一条 `pnpm --filter @petd/pet-ui build` 输出，贴在 `apps/pet-ui/README.md`。

## 9. 测试策略（省 token）

- 单测/组件测试用 **mock WS server**：自己写 `apps/pet-ui/scripts/mock-gateway.mjs`，按第 5 节帧格式回答
  `health.*`/`session.*`/`chat.send`（假回复即可）。UI 单测全部打它，**不要**每次跑真 petd。
- 真 petd 集成测试：M1 手动跑一次连通即可；`chat.send` 真调模型**最多 1 次**（花用户 token）。
- 不要为了测试去点真实屏幕/开游戏窗口。

## 10. 和 Lead 的接口约定

- 协议只读：Lead 加方法时只会在 `apps/petd/**` 与 `packages/protocol/**` 动，不会改你的目录。
- 你如果发现协议缺东西，先按第 1 节写 `docs/pet-ui-待接方法.md`，用户会转给 Lead。
- 同一时间只改自己的目录；`pnpm-lock.yaml` 冲突时：保留双方，重跑 `pnpm install` 后提交。
- 有疑问写进 `docs/pet-ui-待确认.md`，不要自己猜后端语义。

## 11. 可直接粘贴给 AI 的开场提示词

> 你的任务：在 `F:\DSH\大肥鱼\桌宠\apps\pet-ui` 做一个新的 Electron + React 前端（pet-ui）。
> 先完整读 `F:\DSH\大肥鱼\桌宠\docs\pet-ui-AI-任务书.md`，严格按里面的边界、技术栈、协议、git 纪律、环境坑执行。
> 只改 `apps/pet-ui/**`；先交 M1（壳 + 连 petd + 连接状态），截图和 build 证据贴 README；完成后不要合并分支，告诉用户分支名即可。
> 后端 petd 已在 `refactor/petd` 分支可用，启动与连接方式见任务书第 4、5 节。
