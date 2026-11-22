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

目前共 125 个方法：`health.*` / `config.get` / `session.*` / `chat.*`（含 `chat.handoff`）/ `persona.*` / `memory.*` / `blob.*` / `voice.*` / `asr.*` / `mood.*` / `reminder.*` / `automation.*` / `skill.*` / `plugin.*` / `cua.*` / `run.*` / `hooks.*` / `approval.*` / `presence.*` / `agent.*` / `dsh.*` / `learning.*`。下表只列早期骨架里最常用的几条，完整清单以 `health.status.methods` 为准。

| 方法 | 参数 | 结果要点 |
|---|---|---|
| `health.ping` | `{}` | `{pong, ts}` |
| `health.status` | `{}` | `{server{version,pid,startedAt,uptimeMs}, gateway{port,clients}, methods[]}` |
| `config.get` | `{}` | `{version, gateway, log, llm, chat, voice, asr, mood, reminders, automation, skills, plugins, cua, hooks, presence, dsh}`（只读、不含任何密钥） |
| `session.create` | `{title?}` | `SessionMeta` |
| `session.list` | `{}` | `{sessions: SessionMeta[]}`（最近更新倒序） |
| `session.get` | `{sessionId}` | `{session: {...meta, messages: [{role,content,ts}]}}` |
| `session.rename` | `{sessionId,title}` | `SessionMeta` |
| `session.delete` | `{sessionId}` | `{deleted:boolean}` |
| `chat.send` | `{sessionId?, text, speak?, attachments?}` | `{session, userMessage, assistantMessage, reply{text,model,usage}, tools?, speech?, handoff?, attachments?}`；无 sessionId 自动建会话；timeout 120s |

`SessionMeta = {id,title,createdAt,updatedAt,messageCount,contextStart?,lastPromptTokens?,handoffFiles?}`。

### 事件（目前有这些，data 形状见 chat/service.ts）

`session.updated`、`session.deleted`、`chat.user_message`、`chat.assistant_message`、`chat.failed`、`chat.tool`、`chat.handoff`、`persona.changed`、`memory.changed`、`memory.distilled`、`voice.speech`、`asr.download`、`asr.transcribed`、`asr.segment`、`asr.wake`、`mood.changed`、`reminder.created`、`reminder.due`、`reminder.snoozed`、`reminder.cancelled`、`reminder.skipped`、`automation.job.created`、`automation.job.updated`、`automation.job.deleted`、`automation.run.started`、`automation.run.succeeded`、`automation.run.failed`、`automation.run.cancelled`、`automation.skipped`、`plugin.changed`、`cua.permission`、`run.paused`、`run.resumed`、`approval.requested`、`approval.resolved`、`hooks.assessed`、`hooks.blocked`、`hooks.changed`、`presence.activity`、`agent.rollback`、`dsh.status`、`dsh.activity`、`dsh.event`、`dsh.approval`、`dsh.approval.resolved`、`learning.proposed`、`learning.approved`、`learning.rejected`、`learning.rolledback`。
对未知事件忽略即可（Lead 会持续加）。

### 错误码

`E_HANDSHAKE / E_UNAUTHORIZED / E_BAD_FRAME / E_UNKNOWN_METHOD / E_BAD_PARAMS / E_TIMEOUT / E_INTERNAL / E_NOT_FOUND / E_FORBIDDEN / E_UNAVAILABLE`。

## 6. git 纪律（和 Lead 各用一个工作目录）

从 2026-11-15 起，前端单独用 git worktree，不再和 Lead 抢同一个工作区：

- **你的工作目录**：`F:\DSH\大肥鱼\桌宠-ui`，分支已建好 `feat/pet-ui`（HEAD 75539a5）。进这个目录干活，不要在主目录 `桌宠\` 里切换分支或提交。
- 主目录 `F:\DSH\大肥鱼\桌宠` 归 Lead（`refactor/petd`），他在那边改 petd/协议；你只读那边的 `docs/` 和 `apps/petd` 源码。
- 已存在 `apps/petd` 的新方法/事件请以主目录 `refactor/petd` 的最新代码为准（只读 `apps/petd/src/gateway/methods/*.ts` 即可）。
- 只提交你自己目录的改动：`git add apps/pet-ui`（`pnpm-lock.yaml` 允许一起提交）。
- 小步提交，消息用中文，例如 `feat(pet-ui): M1 壳+连接状态`。
- 不要 merge/rebase 到 `refactor/petd`，不要 force push；做完告诉用户「分支 feat/pet-ui 可以看」。
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

## 8.2 M2b：人格页规格（petd 后端已就绪）

目标：能看到/改桌宠的人格，并区分「内核（人写的）」和「AI 改过的外圈」。

**数据来源**
- `persona.get` → `{version, locked, sections, history, coreFile, agentFile, hasAgentOverrides}`；`sections` 每项 `{key, title, content, source}`，`source` 为 `'core'`（`SOUL.md`）或 `'agent'`（`SOUL.agent.md` 覆盖）。
- `persona.sections`（只读目录）、`persona.status`（版本/锁/历史）。
- 写：`persona.patch {key, content, expectedVersion?}` → 用户编辑写回内核 `SOUL.md`，并清掉同小节的 AI 覆盖；带 `expectedVersion` 版本不符返回 `E_CONFLICT`。
- 锁：`persona.lock {key, locked}` 只限制 AI；用户始终能改。后台 AI 自演化可手动点 `persona.evolve`。
- 历史/回滚：`persona.history`、`persona.rollback {version}`（回滚会清空外圈覆盖）。
- 事件：`persona.changed {version, actor, applied, reason}`。

**关键交互**
1. **来源标记**：每节标题旁标 `source`（`agent` 显示「AI 改过」小徽标）；顶部显示 `hasAgentOverrides` 与两个文件名（`coreFile`/`agentFile`）。
2. **保存冲突**：保存时把当前 `version` 作为 `expectedVersion`；`E_CONFLICT`（`details.currentVersion`）→ 提示「人格被另一端改过」，给「载入最新 / 覆盖」两选项，不静默覆盖。
3. **内核小节**：`source=core` 的小节用户可以直接编辑（后端写 `SOUL.md`）；`## 世界观` 只允许用户改，AI 永远不能碰（UI 不用特殊处理，后端已保证）。
4. **AI 外圈**：给「让 AI 复盘并微调」一个按钮（`persona.evolve`），展示 `reason` 与改了哪几节；失败/未改要有明确提示。
5. **刷新**：订阅 `persona.changed` 自动重载；本地有未保存修改时先提示冲突。

**验收**：能读/改人格小节、来源徽标正确、冲突有双按钮、历史可回滚、`persona.evolve` 后能看到 AI 改过的小节。截图贴 README。

## 8.5 M4：Memory 面板规格（petd 后端已就绪）

目标：让用户能看到、编辑、回滚桌宠的工作区记忆（`workspace/`，就是它的长期记忆），并管附件。

**布局建议**：左栏目录树；中栏编辑器/Markdown 预览；右栏「历史 / 附件」两个 tab。整个面板放在设置窗里作为一页（Memory）。

**数据来源（全部已在 petd 上线，方法清单以 `health.status` 为准）**
- 树与列表：`memory.tree`（整棵文本树）或 `memory.list {dir}`（逐层展开，更适合树控件）。
- 工作区位置：`memory.status` → `{dir, workspace, fileCount, git}`；`workspace` 是工作区绝对路径（附件真实文件在 `<workspace>/blobs/`）。
- 读：`memory.read {path}` → `{path, content, revision}`；`revision` 是当前内容的版本号。
- 写：`memory.write {path, content, baseRevision, expectedContentHash?, force?}`、追加 `memory.append`（参数同上）。`expectedContentHash` 是当前基线正文的完整 SHA-256（小写 hex，64 位）；两者不一致且非 `force` → `E_CONFLICT`，不写文件也不产生提交；`force: true` 表示用户明确选择覆盖。返回 `{path, bytes, revision, commit}`。
- 删/移：`memory.delete {path}`、`memory.move {from, to}`。
- 搜索：`memory.glob {pattern}`、`memory.grep {match, regex?, path?}`（做全工作区搜索框很好用）。
- 历史：`memory.history {path?, limit?}` → `{commits: [{hash, fullHash, author, email, date, message}]}`；`memory.diff {hash, path?}` → `{diff}`（纯文本 patch，直接等宽展示）。
- 恢复：`memory.restore {path, hash, expectedContentHash?, force?}` → 把该提交里的文件内容写回工作区并生成**一次新提交**（不改写历史）；历史里没有该文件 → `E_NOT_FOUND`；`PARTNER.md` 允许恢复正文。
- 蒸馏记忆：工作区 `memory/` 下是程序维护的三层长期记忆——`memory/facts.md`（永久事实表格：事实/权重/标签/出现/最近）、`memory/diary/<日期>.md`（一天一篇日记）、`memory/medium/<日期>-<会话>.md`（会话摘要，可带 `date/session/turns` frontmatter）、`memory/experiences.md`（经验候选）。`memory.inject`（read，无参数）返回 `{enabled, text, used:{facts,diary,medium}, dropped:{facts,diary,medium}}`：`text` 就是下一轮聊天会注入的正文，适合做「它现在记得什么」的预览；目录树里它们和普通文件一样可读写（表格行可直接编辑）。`memory.distill {sessionId?, reason?}`（write）会花一次模型调用，把某个会话整理成摘要/日记/事实/经验；`chat.handoff` 之后会自动跑（可关），成功后广播 `memory.distilled`。合并后够格的经验（权重/出现次数达 `config.memory.distill.promoteWeight/promoteHits`）会自动提名成 learning 候选（出现在 `learning.list` 的 pending 列表、广播 `learning.proposed`），主人要在学习闭环 UI 里批准才算数。
- 附件：`blob.list`、`blob.put {dataBase64, name?, mime?}`（≤8MB，返回句柄 `blob:<文件名>`）、`blob.info {ref}`、`blob.get {ref}` → `{meta, dataBase64}`、`blob.delete {ref}`。

**关键交互（别漏）**
1. **保存冲突**：保存时把读到的 `revision` 作为 `baseRevision`（或把当前正文 SHA-256 作为 `expectedContentHash`）传回。后端内容变了会报 `E_CONFLICT`，`error.details.currentRevision` / `currentContentHash` 是最新版本；UI 提示「文件已被桌宠/另一端改过」，给「载入最新（丢弃我的修改）/ 覆盖（`force: true` 再写一次）」两个选择，**不要静默覆盖**。
2. **实时刷新**：订阅 `memory.changed` 事件（data 为 `{operation: 'write'|'append'|'delete'|'move'|'restore', path?, from?, to?, commit}`，顶层帧带 `ts`）；树自动刷新；如果当前打开的文件被外部改动且本地有未保存修改 → 提示冲突，别直接重载丢掉用户输入。
3. **常驻文件**：`PARTNER.md` 是每轮进系统提示词的「主人画像」，删/移会被后端拒绝（`E_FORBIDDEN`）——UI 上删除/移动按钮置灰并标个「常驻」徽标，编辑本身是允许的。
4. **附件预览**：`blob.get` 返回 base64，图片直接 `<img>`；文本类可以渲染成文本（用 `meta.mime` 判断，注意 1MB 预览上限，超了提示下载）。上传用 `blob.put`，然后把句柄传给聊天（`chat.send` 的 `attachments`）。
   - **缩略图**：`blob.preview {ref}` 会返回 `meta.kind`（`image/text/audio/video/binary`）、图片的 `meta.image {width,height}`（服务端只读文件头嗅探，不解码整图）和文本开头的 `text` 摘录（可带 `maxChars`，`truncated` 表示截断）。
   - **列表缩略图不要每次走 WS 传整份 base64**：pet-ui 主进程和 petd 在同一台机器上，`memory.status` 会给 `workspace` 绝对路径，附件真实路径 = `<workspace>/blobs/<meta.name>`；主进程可直接用 Electron `nativeImage.createThumbnailFromPath(absPath, {width:256,height:256})`（或 `createFromPath` + `resize`）生成缩略图，缓存键用 `meta.sha256`（内容寻址，不会变）。渲染层只拿小图 dataURL。
   - 音频/视频（`kind` 为 `audio/video`）可以直接用 file:// 打开系统播放器或 `<audio>`/`<video>` 标签，注意 CSP 设置。
5. **一键回到某版本**：历史页选中某次提交 → 展示 diff → 提供「恢复此版本内容」（调 `memory.restore {path, hash}`；后端会写回内容并生成一次新提交，历史只增不减）。
6. **蒸馏记忆预览**（可选但推荐）：在 Memory 面板加一个「它记得什么」小节，调 `memory.inject` 展示注入正文与 `used/dropped` 计数（超预算被丢掉的条数），旁边解释 `config.memory.inject` 的预算与三层顺序；只读展示，不要在这里提供「让 AI 自己改记忆」的入口。可以加一个「整理一下这段对话」按钮调 `memory.distill`（会花 token，要二次确认），完成后刷新 `memory/` 目录树。

**验收**：能浏览/编辑/新建/删除记忆文件；冲突提示与双按钮；`memory.changed` 触发树刷新；历史列表 + diff + 恢复；附件列表/预览/上传/删除；能看蒸馏记忆预览（`memory.inject`）。截图贴 README。

## 8.6 M5：语音/朗读 UI 规格（petd 后端已就绪）

目标：让聊天回复能出声，设置里能选音色/开关。

**数据来源（已上线；方法清单以 `health.status` 为准）**
- `voice.status` → `{enabled, engine, voice, cacheDir, cacheFiles, cacheBytes}`
- `voice.voices` → `{voices: [{id, label, lang, engine}]}`（Edge 内置音色表 + 本机 SAPI 音色）
- `voice.speak {text, voice?, rate?, pitch?}` → `{id, file, mime, bytes, durationMs, cached, engine, voice, rate, pitch, text, audioBase64, elapsedMs}`（`audioBase64` 是 MP3/WAV 原始字节的 base64）
- `chat.send {text, speak: true}` → 结果多一个 `speech`（形状同上，可为 null）；不传 `speak` 时按 `config.voice.autoSpeak` 决定。
- 事件 `voice.speech {id, file, mime, bytes, durationMs, cached, engine, voice, text}`：合成成功广播，可驱动口型/动画。

**关键交互（别漏）**
1. **播放**：`audioBase64` → data URL（`data:${mime};base64,...`）→ `new Audio(...)`。Electron 有自动播放策略：用户手势之前 `play()` 可能被拒；先 `audio.play().catch(...)`，失败就提示「点一下再播」，或在首次点击时解锁同一个 `Audio` 实例复用。
2. **停止**：自己维护当前 `Audio`，换句/点停止时 `audio.pause(); audio.currentTime = 0`。
3. **口型/动画**：用 `durationMs` 驱动（别等 `ended` 事件才动，会迟）；音频实际结束后再停。
4. **聊天里每条 assistant 消息**：旁边加「朗读/停止」小按钮（对已落盘的消息用 `voice.speak {text}` 现合成，不依赖 chat.send 的 speech）；带 `speak:true` 发出的消息自动播。
5. **设置页**：开关、引擎选择（edge/sapi）、音色下拉（`voice.voices` 按 engine 分组）、语速/音调滑条（0.5–2）、`autoSpeak` 开关；`config.get` 里有 `voice` 段当前值。
6. **错误**：`E_UNAVAILABLE`（语音关闭/两个引擎都失败）→ 气泡提示一次，别反复弹；`E_BAD_PARAMS`（文本为空/超长）→ 提示用户，不自作主张截断。
7. **不要把音频 base64 存进聊天历史或状态库**，随用随取。

**验收**：聊天能出声、能停；设置能选音色并持久（下次启动仍用）；断网/Edge 失败自动回退 SAPI 时 UI 有小提示。

## 8.7 M6：语音识别/唤醒词 UI 规格（petd 后端已就绪）

目标：用户能对着麦克风说话，petd 在本地识别；可看见「在听/听到什么/唤醒词命中」，并可选让识别结果自动发进聊天。

**数据来源（已上线；方法清单以 `health.status` 为准）**
- `asr.status` → `{enabled, engine:'whisper.cpp', model, language, binary:{found,path}, models, wakeEnabled, wakeWords, listening, autoChat}`
- `asr.models` → `{models:[{name,ready,current,sizeBytes?}], active:'tiny'|'base'|'small'}`
- `asr.download {model}` → 下载模型（进度走事件）；模型大（base≈148MB），给进度条与「取消不保证」提示
- `asr.transcribe {audioBase64, language?, model?}` → `{text, language, durationMs, tookMs, wake}`（一次性识别；audio 是 16k 单声道 PCM16 WAV 的 base64）
- `asr.listen.start {}` → `{streamId, sampleRate:16000, vad:{energyThreshold,minSpeechMs,silenceMs,maxSegmentMs,preRollMs}, model, wakeWords}`
- `asr.listen.feed {streamId, pcmBase64}` → `{accepted:number, segments:[…]}`（PCM16LE 原始字节的 base64；建议 100–300ms 一片）
- `asr.listen.stop {streamId}` → `{segments:[…]}`（flush 尾巴）
- 事件：`asr.download {model, got, total, url}`、`asr.transcribed {text, language, durationMs, tookMs}`、`asr.segment {streamId, text, durationMs, tookMs, wake}`、`asr.wake {streamId, text, wakeWord}`

**关键交互（别漏）**
1. **采集**：`navigator.mediaDevices.getUserMedia({audio:{channelCount:1, sampleRate:16000, echoCancellation:true, noiseSuppression:true}})`，用 **AudioWorklet**（不要 ScriptProcessor）拿 Float32 帧；转成 Int16LE：`Math.max(-1, Math.min(1, x)) * 0x7fff`；每累积 ~160–320ms 就 base64 一次发 `asr.listen.feed`。只在 `asr.listen.start` 成功后开始 feed；`stop` / 组件卸载 / 断线时必须停止麦克风（`track.stop()`）并清 streamId。
2. **权限与解锁**：麦克风必须由用户手势触发（点「开始听」）；权限被拒/无设备要明确提示，不要静默失败。
3. **状态显示**：顶部小指示器「🎤 在听 / 已识别 N 句」；`asr.segment` 到达时把句子追加到实时字幕区；`asr.wake` 到达时给一次明显提示（高亮/轻提示音由你决定）。
4. **唤醒词管理**：设置页展示 `wakeWords`（只读展示也行，编辑需要 Lead 加 `config.patch`；先显示即可），`autoChat` 开关同理先只读展示当前值。
5. **模型管理**：展示 `asr.models` 三档（ready/current/大小），可点下载；下载中显示 `asr.download` 进度；模型目录/引擎路径错误时展示 `asr.status.binary.path` 帮助用户排查。
6. **一次性识别**：可作为「按钮说话」备用入口：录音 → 编码 WAV → `asr.transcribe` → 显示结果（wake 非空时标出命中词）。
7. **错误**：`E_UNAVAILABLE`（ASR 关闭/模型缺失）→ 提示去设置页开启或下载；`E_NOT_FOUND`（监听流过期/被回收）→ 重新 start；`E_BAD_PARAMS`（PCM 为空/格式不对）→ 检查采样率与声道。
8. **隐私文案**：明确告诉用户「音频只在本机处理、不落盘、不上传；识别文本才会进入事件与会话」。
9. **性能**：识别是本地 CPU 推理（base 模型约 0.5–2s/句），UI 不要每片都等返回——用事件驱动；feed 请求可以并发少量（≤2）以免积压。

**验收**：点「开始听」→ 说话 → 字幕出现句子；说「你好大肥鱼」→ 唤醒提示；停止后麦克风指示灯熄灭（系统麦克风占用消失）；模型页能看到 ready/下载进度；ASR 关闭时给出清晰错误提示。截图贴 README。

## 8.8 M7：情绪/状态 UI 规格（petd 后端已就绪）

petd 已有 3 个可见数值（0–100）：心情 `mood`、好感 `affection`、精力 `energy`，以及被戳次数 `pokes`；另有档位名（如 心情不错 / 比较亲近 / 很正常）。对应方法与事件：`mood.status` / `mood.history` / `mood.adjust` / `mood.poke` / `mood.evaluate`，事件 `mood.changed`。

1. **展示位置**：托盘菜单或设置页的「状态」面板；宠物窗可加一个小指示（表情/立绘表情切换 + 三枚小圆环）。默认**不显示精确数字**（体验更自然），设置里提供「显示数值」开关给调试用。
2. **档位映射**：心情 5 档 → 表情/立绘/气泡底色或语气小图标；好感 4 档 → 称呼文案（还生疏→很黏你）；精力 4 档 → 活跃度（很累时打盹动画/降低动作频率）。档位名直接用 `mood.status.state.tiers` 里的中文，不要自己再翻译。
3. **戳一戳**：宠物窗的 `pointerdown`/双击/摸摸动作 → 调 `mood.poke`（后端 心情+1、好感+0.5、pokes+1），拿到返回快照后播一个 200–400ms 的小反馈（跳一下/冒爱心），不要每次戳都弹窗。
4. **实时刷新**：订阅 `mood.changed`（`data.state` 是完整快照 + `applied[]` 是具体变化），事件驱动更新；断线重连后重拉一次 `mood.status`，不要定时轮询。
5. **评估按钮（可选）**：「让它想想刚才聊得怎么样」→ `mood.evaluate {sessionId?}`（后端真调一次模型，timeout 90s），按钮要显示「正在想…」并禁用重复点击；返回的 `applied` 可以逐条做小提示（如「心情 +1」「好感 +2」）。
6. **聊天联动**：`config.mood.chatNudge=true` 时聊天后后端自动微调，UI **不要自己再算**；只在收到 `mood.changed(source=chat)` 时做一个轻微的表情变化，别打断聊天。
7. **设置页**：`mood.enabled` / `chatInjection` / `chatNudge` 只读展示（改配置目前由后端文件控制，UI 不做写入），`config.get` 里有这些字段。
8. **氛围**：数值低时不要做惩罚性 UI（例如灰掉/警告）；只体现「有点累、想安静」这类文案与动作变化；数值只是表现层，不承诺游戏性。
9. **错误**：`E_INTERNAL`（评估模型失败/输出不可解析）→ 提示「这次没想明白，等会儿再试」；`mood.enabled=false` 时隐藏入口或置灰。

**验收**：戳一下 → 数值/表情有反馈；聊 2–3 句 → 心情上升、好感上升、精力略降的小动画；切换页签/重启后回显一致；关闭 `mood.enabled` 后入口消失；评估按钮有 loading 与结果提示。截图贴 README。

## 8.9 M8：提醒/日程 UI 规格（petd 后端已就绪）

petd 已上线一次性提醒：`reminder.status` / `reminder.list` / `reminder.create` / `reminder.cancel` / `reminder.snooze`，事件 `reminder.created` / `reminder.due` / `reminder.snoozed` / `reminder.cancelled` / `reminder.skipped`（都带 `item`，`due` 里还有 `firedLateMs`）。聊天里的模型也能自己调 `remind_in` / `remind_at` / `remind_list` / `remind_cancel` 设提醒。

1. **入口**：设置页「提醒」tab 或托盘菜单「提醒/日程」；列表显示待响项（`text`、`at`、`inMinutes`、`snoozes`），按时间升序；`reminder.status.nextAt` 可用于「下一条：xx 分钟后」这一行。
2. **新建**：一个输入框 + 三种时间选择（N 分钟后 / 今天 HH:MM / 选日期时间）；提交 `reminder.create`，成功后本地插入并显示 toast「已设提醒：喝水（20:30）」。`text` 超过 300 字前端先截断提示。
3. **到点**：订阅 `reminder.due` → 弹 toast / 系统通知 / 让桌宠说话或朗读（若 `voice.enabled`，可调 `voice.speak` 念这条；注意不要和聊天朗读抢音频）；toast 上给「稍后 5 分钟」「稍后 10 分钟」「知道了」按钮（稍后调 `reminder.snooze`）。
4. **取消/稍后**：列表项 hover 出「稍后」「取消」；`reminder.cancel` 后从待响列表移除并 toast 确认。
5. **重启与补报**：后端重启后会重新布防，错过 ≤ `catchUpHours` 的会在启动后补发 `reminder.due`；UI 若在同一时刻收到多条，合并成一个「你有 N 条提醒」面板，别连弹 N 个 toast。skipped 的只记日志、不打扰用户。
6. **错误**：`E_UNAVAILABLE`（`reminder.enabled=false` 或待响太多）→ 提示「提醒功能已关闭 / 待响提醒太多，先取消几条」；`E_BAD_PARAMS`（时间格式/已过去/文本空）→ 就地标红输入框。
7. **配置只读**：设置页展示 `config.get.reminders`（enabled/maxPending/catchUpHours/keepFiredDays），改配置由后端文件控制。

**验收**：建一条 1 分钟后的提醒 → 到点弹 toast 且桌宠说一句 → 点「稍后 5 分钟」后列表时间 +5 分钟 → 重启 petd 后列表仍在 → 关闭 `reminders.enabled` 后新建按钮置灰。截图贴 README。

## 8.10 M9：自动化/自主任务 UI 规格（petd 后端已就绪）

petd 已上线 cron 式自主任务：每个任务是「一段 prompt + 一种计划（interval / daily / once / manual）」，到点由 petd 在专用会话里跑一轮聊天并把结果记为 run。方法：`automation.status` / `automation.list` / `automation.get` / `automation.create` / `automation.update` / `automation.delete` / `automation.pause` / `automation.resume` / `automation.run` / `automation.runs`。事件：`automation.job.created/updated/deleted`、`automation.run.started/succeeded/failed/cancelled`、`automation.skipped`。**默认 `automation.enabled=false`**，打开会真花 token——UI 必须把「让它自己干活=花你的 API 额度」写清楚，并在关闭时把新建/运行按钮置灰。

1. **入口**：设置页「自主任务」tab（托盘菜单给个二级入口即可，别做成主界面）。列表列任务（name、scheduleText、enabled、runCount、lastStatus、nextAt），按 nextAt 升序，空态给「还没有任务，让它每天帮你做点什么？」示例。
2. **新建/编辑**：`name?`（≤40 字）+ `prompt`（≤2000 字，多行）+ 四选一计划（每 N 分钟 / 每天 HH:MM / 某个时间点 / 只手动）。提交 `automation.create`，成功后插入列表并 toast「已创建：每天 08:00 总结待办」。`update` 用于改名字/prompt/计划。
3. **运行**：行内「立即运行」→ `automation.run {id}`（同步等结果，最长 4 分钟，timeout 240s；期间按钮 loading 且禁用重复点击，别让用户以为卡死——给「它正在干活…」状态）。返回 `{run, output, usage}`，UI 展示 output 文本与 token 用量。
4. **运行记录**：`automation.runs {id, limit?}` 展示最近运行（状态、开始时间、output/error、usage）；failed 显示 error 摘要；cancelled（超时/进程退出）单独样式。别默认展开长 output，点开看。
5. **实时刷新**：订阅 `automation.*` 事件更新列表与运行记录（`run.succeeded` 时若当前正在看该任务的记录就追加）；断线重连后重拉 `automation.status/list`。到点自动跑时给一个不打断的角标提示（如底部轻提示「自主任务已运行：…」）。
6. **暂停/删除**：`pause`/`resume` 行内切换（显示「已于下个计划生效」）；删除二次确认，提示「会一起删除运行记录（不影响会话）」。
7. **配置只读**：设置页展示 `config.get.automation`（enabled/tickSeconds/catchUpMinutes/maxJobs/maxRunsKept/runTimeoutMs），改配置由后端文件控制。
8. **错误**：`E_UNAVAILABLE`（自动化关闭）→ 提示并引导「在主目录 config.json 打开 automation.enabled」；`E_BAD_PARAMS`（计划格式/过去时间/prompt 空）→ 就地标红；`E_NOT_FOUND`（任务被删/并发）→ 刷新列表并 toast。

**验收**：建一个 manual 任务 → 「立即运行」拿到真模型输出与用量 → 改 interval 60 分钟看到 nextAt → 暂停后不跑 → 重启 petd 后任务与运行记录都在 → 关闭 `automation.enabled` 后新建/运行置灰。截图贴 README。

## 8.11 M10：技能/插件 UI 规格（petd 后端已就绪）

petd 已上线「技能（SKILL.md）+ 声明式插件」：技能是一段可复用做法，插件是技能/额外提示词的打包；**都不执行任意代码**。方法：`skill.list` / `skill.get` / `skill.create` / `skill.update` / `skill.delete`、`plugin.list` / `plugin.get` / `plugin.enable` / `plugin.disable`。事件：`plugin.changed`。配置：`config.get.skills {enabled,dir,promptMaxChars}`、`config.get.plugins {enabled,dir}`。

1. **入口**：设置页「技能」tab，两段：「我的技能」（`skill.list` 里 source=workspace）和「插件」（`plugin.list`，显示 name/version/description/author/skillCount/enabled）。
2. **技能列表**：每行显示 key、description、keywords、`always` 徽标、来源（工作区/插件前缀）。插件技能标「随插件提供·只读」，不显示编辑/删除按钮（后端也会拒绝）。
3. **查看/编辑**：点开调 `skill.get {key}` 展示正文（Markdown 渲染即可）；工作区技能可编辑 description/body/keywords/always（`skill.update {name,...}`）；新建走 `skill.create {name,description?,body,keywords?,always?}`，name 只允许字母数字 `-` `_`，重名 `E_CONFLICT`。
4. **删除**：`skill.delete {name}` 二次确认，提示「会删掉整个技能目录，聊天里它就不再出现」。
5. **插件启停**：`plugin.enable/disable {id}`，行内开关 + toast；停用后它的技能从技能列表消失（提示「重启或刷新后生效」不准确——petd 是即时的，刷新列表即可），订阅 `plugin.changed` 刷新。
6. **插件详情**：`plugin.get {id}` 展示版本/描述/技能数/是否有 prompt.md；**不要**做「安装插件」的在线商店（当前只支持本地目录，放进去重启即生效）。
7. **提示**：技能/插件都会进系统提示词（清单 + always 正文，受 `skills.promptMaxChars` 限制），UI 可给一行说明「技能越多，提示词越长，必要时在聊天里让它用 list_skills/load_skill 按需查」。
8. **错误**：`E_UNAVAILABLE`（skill/plugin 总开关关闭）→ 提示去 config.json 打开；`E_FORBIDDEN`（改插件技能）→ 灰置并提示「插件技能只读」；`E_CONFLICT`（重名）→ 就地提示换名；`E_NOT_FOUND` → 刷新列表。
9. **命名规则提示**：技能身份 = 目录名，必须是 ASCII（`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`），中文标题写在 frontmatter/正文；插件 id 同理（点号不允许）。新建技能的输入框直接按这个正则校验，并给示例「目录名 `look-screen`，标题 `看游戏界面`」。
10. **内置游戏助手**：`apps/petd/assets/plugins/aknight-gmaer/` 是现成插件（`Aknight.gmaer`，5 个技能 + prompt）。UI 不需要做安装器；如果做「插件」列表的空状态，可以提示「把插件目录拷到 `<home>/plugins/` 后刷新」。技能键示例：`aknight-gmaer/look-screen`。

**验收**：建一个 always 技能 → 聊天里模型语气/行为有变化（或它主动 load_skill）→ 停用演示插件后技能列表里不再出现其技能 → 重启 petd 后工作区技能仍在、插件停用状态保留。截图贴 README。

## 8.12 M11：感知与输入（CUA）UI 规格（petd 后端已就绪）

petd 已上线照 Coo 形状写的电脑感知/操作：**默认关闭**（`config.cua.enabled=false`），开启后聊天里的模型才有 13 个 `cua_*` 工具。方法：`cua.status` / `cua.screenshot` / `cua.zoom` / `cua.windows` / `cua.focus` / `cua.click` / `cua.move` / `cua.drag` / `cua.mouse_down` / `cua.mouse_up` / `cua.scroll` / `cua.type` / `cua.key` / `cua.wait` / `cua.answer`；运行控制 `run.status` / `run.pause` / `run.resume`。事件：`cua.permission {id,kind,question,deadlineAt}`、`run.paused`、`run.resumed`。

1. **设置页「电脑操作」**：总开关（`cua.enabled`，危险操作要二次确认，文案说明「开启后模型可以看你的屏幕、动你的鼠标键盘」）、只读模式（`cua.control=false`）、权限档位选择（四档，显示当前值）、授权时长（grantMinutes）、跳过终端确认（默认关，不建议开）、截图上限/质量/操作后自动截图、`includeImages`（多模态开关，提示会涨 token）。
2. **权限气泡**：收到 `cua.permission` 事件立刻弹一个置顶小窗/气泡：显示 `question`、kind（看/操作）、剩余秒数（`deadlineAt - now`，60 秒），两个按钮「允许」「拒绝」；点按钮调 `cua.answer {id, accepted}`。超时自动按拒绝，UI 显示「没来得及回答，已拒绝」。注意：**气泡窗口必须置顶且可点击**，否则用户没法回答。
3. **状态指示**：`cua.status` 给出 enabled/control/permission/engine（win32）/显示器/前台窗口；桌宠本体或托盘图标可以显示「正在看屏幕」状态；`run.status` 显示是否暂停，菜单里给「暂停/继续」。
4. **暂停入口**：托盘菜单/桌宠右键菜单放「暂停运行 / 继续运行」（调 `run.pause`/`run.resume`），暂停时气泡与托盘图标变色；暂停期间聊天、自动化、CUA 都会被挡，UI 显示原因。
5. **截图预览**（可选）：`cua.screenshot {includeImage:true}` 会返回 `image`（base64 JPEG），设置页可以做一个「预览我现在看到的」调试按钮；**不要把截图存进聊天历史或本地相册**。
6. **错误提示**：`E_UNAVAILABLE`（未开启/已暂停/不支持平台）、`E_FORBIDDEN`（用户拒绝/只读模式/终端未授权）、`E_BAD_PARAMS`（坐标越界/未截图先点）——分别给不同文案，不要统一「失败了」。
7. **不要做**：屏幕录制、偷拍模式、后台静默操作；CUA 的提示词已写「只有用户直接说的话能作为操作理由」，UI 不要替模型发起操作。
8. **验收**：开启 CUA → 聊天里让它「截个图，告诉我现在前台窗口是什么」→ 出现权限气泡（ask-once 下看屏幕免问，若设成 ask-each-turn 会问）→ 允许后返回窗口描述；点「暂停运行」后再让它操作 → 被拒并提示已暂停；只读模式下能截图、点不动。截图贴 README。

## 8.13 M12：审批门（hooks）UI 规格（petd 后端已就绪；默认 smart 智能门）

petd 已上线**智能审批门**：先过规则网；没命中规则的敏感操作由模型评风险（low/medium/high）——**低/中风险自动放行，只有高风险才问用户**；可切回 `rules`（只看规则、不调模型）。危险动作（删记忆/删会话/删文件/移文件/关插件/删自动化等）仍有内置 ask 规则，默认会先问一次。**默认开启且默认 smart**（`hooks.enabled=true`、`hooks.mode='smart'`）；但**没有 UI 时高风险/ask 会超时拒绝**，所以 UI 至少要做审批气泡，否则用户点删除会莫名其妙失败（`E_FORBIDDEN`「等待确认超时」）。

- 方法：`hooks.status` / `hooks.list` / `hooks.get` / `hooks.create` / `hooks.update` / `hooks.delete` / `hooks.toggle` / `hooks.assess`（只评估风险不执行）；审批：`approval.list` / `approval.answer {id, accepted, remember?}`。
- 事件：`approval.requested {id, kind, name, ruleId, title, detail?, risk?, riskReason?, requestedAt, deadlineAt}`、`approval.resolved {id, accepted, reason, remember}`、`hooks.assessed {kind, name, risk, reason, cached, fallback}`（低/中风险自动放行时也会广播）、`hooks.blocked {kind, name, ruleId, action, message, risk?}`、`hooks.changed {action, rule}`。
- 规则形状：`{id, kind, names: string[]（支持 * ? 通配）, action: 'allow'|'ask'|'deny', message?, argContains?, priority（默认 10）, enabled}`；按 priority 升序取第一条命中。内置 9 条 ask 规则 priority=100（用户规则 priority 默认 10，可覆盖内置）。
- smart 评审范围：聊天工具里的写/改/删/移/附件保存/排任务/取消任务/CUA 键鼠类，以及网关里 `scope:'write'` 的方法；读类操作直接放行。结论按操作+参数缓存；模型失败按 `hooks.risk.fallback`（默认 high）处理。

1. **审批气泡（必做）**：收到 `approval.requested` 立刻弹一个置顶、可点击的小窗/气泡：标题用 `title`，正文 `detail`（若有）；**若带 `risk='high'` 显示醒目的「高风险」徽标，并显示 `riskReason` 一行原因**；显示来源 `kind + name` 和剩余秒数（`deadlineAt - now`）；按钮「允许」「拒绝」+ 复选框「本次运行都允许（该规则）」（`remember: true`）。点击调 `approval.answer`；超时后 UI 显示「没来得及回答，已自动拒绝」。
2. **待答列表**：`approval.list` 返回所有待答审批（重启/重连后补齐），设置页或状态区列出来，逐条允许/拒绝；收到 `approval.resolved` 后移除。
3. **规则管理（设置页「危险动作确认」）**：`hooks.list` 展示规则（内置规则标「内置」，可 toggle 但不可删）；支持新建/编辑/删除用户规则（kind、names 通配、action、message、argContains、priority）；`hooks.changed` 时刷新。提示用户：smart 模式下这些规则**优先于模型评审**。
4. **状态与开关**：`hooks.status` 显示 enabled/mode/riskEnabled/approvalEnabled/approvalTimeoutMs/ruleCount/pendingCount/sessionAllowedCount；设置页可改 `hooks.enabled`、`hooks.mode`（smart/rules 二选一）、`hooks.approvalEnabled`、`hooks.approvalTimeoutMs`（`config.get` 里都有，另有 `hooks.risk.*`）。关掉 `approvalEnabled` 等于「一律拒绝」（不是放行），文案要写清楚；切到 rules 模式后不再产生模型评审开销。
5. **风险评审可视化**：订阅 `hooks.assessed`，在操作记录/聊天工具卡片上显示小徽标（低/中风险自动放行时用轻提示，不要弹窗打扰）；`hooks.assess {kind, name, args?}` 可用于「执行前预览风险」，但**不要替用户决定**。
6. **与 CUA 权限气泡复用**：审批门和 CUA 权限是两套事件、两套回答方法（`approval.answer` vs `cua.answer`），可共用同一个气泡组件，用来源标签区分。
7. **不要做**：不要把「记住本次」做成全局永久放行（remember 只在当前连接/进程内）；不要自动允许任何 ask/高风险；不要无提示地驳回；不要把 smart 评审做成同步阻塞 UI 的请求（它已经在后端异步完成，UI 只需要展示）。
8. **验收**：在 UI 里删一条工作区记忆文件 → 弹审批（带 risk 徽标/原因）→ 点「拒绝」→ 看到「你拒绝了这次操作」；再删一次点「允许+记住」→ 成功且同一规则不再弹；把 `hooks.approvalTimeoutMs` 设小 → 不回答时自动拒绝并有提示；用 `hooks.create` 建 deny 规则（如 `cua_type` + argContains `rm -rf /`）→ 被拒并广播 `hooks.blocked`；对一条普通写操作观察 `hooks.assessed`（低/中风险自动放行，不弹窗）。

## 8.14 M13：静默活动（presence）UI 规格（petd 后端已就绪）

桌宠大部分时间是**安静**的：不主动聊天、不自动朗读、不弹消息；后端每隔一段时间（默认 45 分钟）在合适时机（非深夜、用户闲置、今天没活动太多次）挑一个小动作，只广播 `presence.activity` 事件。UI 的职责是**把它演出来，但不要打扰**。

- 方法：`presence.status`（返回 enabled/quiet/intervalMinutes/idleMinutes/maxPerDay/nightQuiet/countToday/lastAt/nextAt）、`presence.list {limit?}`（新→旧活动记录）、`presence.run_once`（手动来一次，设置页调试用）。
- 事件：`presence.activity {id, kind: 'groom'|'stretch'|'window'|'nap'|'tidy'|'idle', label: 中文（整理羽毛/伸懒腰/看窗外/打盹/归置东西/发呆）, at, quiet: true}`。
- `config.get` 的 `presence` 段：enabled/quiet/intervalMinutes/idleMinutes/maxPerDay/nightQuiet。

1. **只做小动画（必做）**：收到 `presence.activity` 时，根据 `kind` 播一段轻量动作/表情（或换一张立绘帧），**不弹气泡、不发声、不放到聊天记录**；`quiet=true` 时尤其只允许动画。
2. **状态与设置**：设置页「静默活动」分组展示 `presence.status`：开关、间隔、闲置门槛、每日上限、夜间时段；`presence.run_once` 做成「现在来一个」调试按钮。
3. **不打断当前交互**：用户正在聊天/拖拽立绘时不演动作（可以推迟到下一次事件）；夜间安静时段由后端保证不发事件，UI 不需要自己判断。
4. **与情绪/时间联动（可选）**：如果同时订阅了 `mood.changed`，可以据此挑语气/动作幅度；但不要为了动画去轮询后端。
5. **不要做**：不要在静默活动时让模型说话/调 `chat.send`；不要每秒轮询 `presence.status`；不要把活动记录塞进聊天历史。
6. **验收**：开界面等一次 `presence.activity`（或点「现在来一个」）→ 立绘只播小动作、无气泡无声音、聊天记录不变；把 `presence.intervalMinutes` 调小观察频率；把 `presence.enabled` 关掉后不再有事件。

## 8.15 M14：自我迭代审计 UI 规格（petd 后端已就绪）

AI 会自我演化（`persona.evolve` 改 `SOUL.agent.md` 外圈），但每次改动都留痕、可按条回滚。UI 的职责是**让人看得见 AI 改了什么、能一键撤销**，而不是让 AI 改代码/配置。

- 方法：`agent.scope`（`{scope, memoryZone, zones[], auditFile}`——AI 能写哪些文件的后缀约定与目录）、`agent.audit.list {path?, actor?, limit?}`（`{entries: AuditMeta[], total}`，新→旧，**不含正文**）、`agent.audit.get {id}`（`{entry: {…, before, after, diff}}` 前后正文 + 逐行 diff）、`agent.rollback {id, force?, reason?}`（`{path, restored: 'content'|'deleted', entry}`；文件在那之后被改过 → `E_CONFLICT` 且 `details.currentHash/expectedHash`，需 `force`）。
- `AuditMeta = {id, ts, actor: 'user'|'agent'|'system', action: 'write'|'delete'|'rollback', path, zone: 'agent-file'|'memory', reason, before: {hash,bytes}|null, after: {hash,bytes}|null, diffChars, sessionId?}`。
- 事件：`agent.rollback {id, targetId, path, restored}`（回滚成功后广播，UI 刷新列表与人格页）。
- 和人格页（§8.2）联动：`persona.get` 的 `source: 'agent'` 小节旁放「改动记录」，点进某条审计看 diff；回滚某条后重拉 `persona.get`。

1. **审计页（必做）**：设置页新增「AI 改动记录」分组——默认按时间倒序列出 `agent.audit.list`（路径/谁改的/动作/时间），可按文件与 actor 过滤、分页（limit≤200）；点一条打开抽屉/详情，展示 `before/after` 正文和 diff（加/删行高亮，过长的正文给折叠）。
2. **回滚按钮（必做，危险动作）**：详情里「撤销这次改动」调 `agent.rollback {id}`；回滚前二次确认（写清楚会恢复成哪个版本）；收到 `E_CONFLICT` 时提示「这个文件之后又被改过」并给「仍然覆盖（force）」二次确认。
3. **写盘范围说明（必做）**：用 `agent.scope` 的结果在「AI 能改什么」说明里展示：记忆区、`.agent.md`/`.agent.json` 后缀、允许目录；明确写「代码、配置、密钥 AI 改不了」。
4. **不硬编码清单**：方法清单以 `health.status.methods` 为准；`AuditMeta` 新增字段时忽略未知字段即可。
5. **不要做**：不要给 AI 暴露「调用 agent.rollback」的聊天入口（这是人的撤销动作，后端也没有对应聊天工具）；不要自动回滚；不要把审计正文缓存进前端持久化存储（正文只在 `agent.audit.get` 里按需取）。
6. **验收**：让 AI 演化一次人格（或手动写 `SOUL.agent.md` 后让用户改同名小节）→ 审计页出现一条记录 → 查看 diff → 点撤销 → 外圈恢复成改动前、收到 `agent.rollback` 事件、人格页 `source` 徽标相应变化；再把文件手改一次后撤销 → 出现 `E_CONFLICT` 确认框。

## 8.16 M15：DSH 双向桥 UI 规格（petd 后端已就绪）

桌宠和 DeepSeek Harness（DSH）已经能用：读方向是只读观察你桌面 GUI 的会话（空闲/思考中/正在用工具，不花 token）；写方向是起一个私有 SDK runtime，把任务交给 DSH 并等它回答（花 token）。UI 的职责是让这两件事**看得见、可控**，不要把 DSH 的会话内容全量搬过来。

- 方法：`dsh.status`（`{enabled, observe, started, runtime{running,pid,provider,model,cwd,serverInfo,startedAt}, observer{...}, paths{exePath,cliPath,cwd,sessionsDir}, counters{prompts,asks,errors}, lastError, lastPromptAt, pendingApprovals}`）、`dsh.observe`（立刻扫一次，返回观察快照 `{workspace, sessionId, file, state: 'idle'|'thinking'|'working', active, turn, step, tool, lastText, lastEventType, agoMs}`）、`dsh.start` / `dsh.stop`（手动起停私有 runtime）、`dsh.prompt {text, sessionId?}`（只入队，返回 `{sessionId, messageId}`）、`dsh.ask {text, timeoutMs?}`（等这一回合结束，返回 `{text, sessionId, turn, durationMs}`）、`dsh.approval.answer {id, outcome: 'allowed-once'|'rejected'|'cancelled'}`。
- 事件：`dsh.status {status}`、`dsh.activity {snapshot}`（有变化才发，最多每 1.5 秒一次）、`dsh.event {sessionId, type, at, turn?, step?, tool?, text?}`（私有会话的事件摘要，text≤500）、`dsh.approval {id, sessionId, toolName, reason, at}`（仅 `dsh.approvalPolicy='ask'`）、`dsh.approval.resolved {id, accepted}`。
- 配置：`config.get.dsh {enabled, observe, exePath, cliPath, cwd, provider, model, reasoningEffort, maxTokens, approvalPolicy, askTimeoutMs, observeIntervalMs, activeMs}`；**不要**做密钥编辑（DSH 用自己的凭证）。

1. **状态小组件（必做，轻量）**：宠物面板/设置页放一行「DSH」状态——`enabled`、观察中、私有 runtime 是否在跑、`state`（空闲/思考中/working + 工具名）。优先用 `dsh.activity` 事件更新，断线重连后拉一次 `dsh.observe`；不要高频轮询。
2. **只读观察（必做）**：展示当前观察到的 workspace 与会话 id，并写明「只读、不花 token、不上传」；`state='working'` 时小字显示工具名（如「正在用 edit」）。
3. **把任务交给 DSH（可选，花 token）**：输入框 + 「交给 DSH」按钮（`dsh.ask`，显示 loading 与超时；`E_UNAVAILABLE` 给中文提示与「去配置 exePath」引导）；回答区展示 `text` 与 `turn/durationMs`；**不要**自动连续追问。
4. **审批气泡复用（若 approvalPolicy='ask'）**：`dsh.approval` 与 CUA 权限/审批门共用同一个置顶气泡组件，来源标签写「DSH」；显示 `toolName` 与 `reason`，按钮「允许一次」「拒绝」，调 `dsh.approval.answer`；120 秒没人答后端按拒绝，UI 显示「没来得及回答，已拒绝」。
5. **不硬编码**：方法清单以 `health.status.methods` 为准；事件 data 形状以后端代码为准（只会加字段，未知字段忽略）。
6. **不要做**：不要把 DSH 会话日志/全文读进前端；不要在 UI 里存 DSH 的 key/凭证；不要默认打开「自动交给 DSH」（默认只观察）。
7. **验收**：桌面 DSH 正在干活时桌宠 UI 显示 working/工具名（读方向）；`dsh.status` 显示私有 runtime 未起；点「交给 DSH」真拿到回答（花一点 token）；`approvalPolicy='ask'` 触发一次审批 → 气泡出现、允许后继续、拒绝则结束；关掉 `dsh.enabled` → 界面显示已关闭且 `dsh.ask` 报中文错误。
8. **聊天里的 `ask_dsh` 工具**：桌宠聊天里模型自己也可以调 `ask_dsh {task, timeout_ms}`（写代码/改代码/查项目/跑命令，计入写配额、一轮最多 3 次）。UI 侧：在工具活动折叠区显示「交给 DSH：<task 摘要> → <耗时/结果摘要>」即可，不需要单独入口；桥关闭时工具不出现。

## 8.17 M16：学习闭环 UI 规格（petd 后端已就绪）

AI 想学什么，只能写成**候选提案**；主人批准/灰度后才进提示词或转成正式技能，而且每一步都有审计、可回滚。UI 的职责是把这条「提案 → 审批 → 灰度 → 回滚」的链条摆出来，让主人能一眼看懂、一键控制。

- 方法：`learning.status`（`{enabled, requireApproval, grayPercent, grayDays, maxPending, counts{pending,approved,gray,rejected,rolledback}, pending[], activeGray[], dirs{proposals,staging,learning,state}, stateFile}`）、`learning.list {kind?, status?}`（新→旧，带 `{id, kind, name, status, reason, createdAt, approvedAt?, gray?}`）、`learning.get {id}`（带 `body` 正文与 diff）、`learning.propose`（AI 用，UI 一般不直接调）、`learning.approve {id, gray?, force?}`、`learning.reject {id, reason?}`、`learning.rollback {id}`。
- 事件：`learning.proposed {item}`、`learning.approved {item, gray}`、`learning.rejected {item, reason}`、`learning.rolledback {item}`。
- 配置：`config.get.learning {enabled, requireApproval, grayPercent, grayDays, maxPending, promptMaxChars}`。
- 状态色：`pending` 待审（黄）、`gray` 灰度中（蓝）、`approved` 已生效（绿）、`rejected` 已拒绝（灰）、`rolledback` 已回滚（灰）。

1. **提案列表（必做）**：设置页「它想学的东西」——按状态分组的列表（待审/灰度中/已生效/已拒绝/已回滚），每条显示 `kind` 徽标（技能/提示词/参数/偏好）、`name`、`reason`、时间；待审条目给「批准」「拒绝」两个按钮；批准时默认 `gray:true`，旁边可切「直接全量」。
2. **详情与 diff（必做）**：点条目看正文（技能看候选全文，偏好/提示词看 JSON 里的 `content`）；若提案带 `diff` 就展示 diff；`learning.get` 的正文只在详情页按需加载，不要进列表缓存。
3. **灰度提示**：`gray` 条目显示「灰度中：约 N% 的回合会参考它」，并显示 `gray.startedAt`/`rollbackAfterDays`；到 `grayDays` 后提示「可以转正了」（后端暂无自动转正方法，先只提示）。
4. **回滚**：`approved`/`gray` 条目给「撤销」按钮（`learning.rollback`）；撤销后状态变 `rolledback`、产物删除、审计留痕；技能撤销会从 `skills/<name>/SKILL.md` 删除，UI 说明「技能文件会被删除」。
5. **不要做**：不要给 AI 暴露「批准/拒绝/回滚」的聊天入口（这几步只能人做）；不要自动批准；不要把提案正文写进前端持久化存储；不要把 `learning/` 产物当成配置文件编辑（它归 AI 写、人只审批）。
6. **不硬编码**：方法清单以 `health.status.methods` 为准；事件 data 形状以后端代码为准（只会加字段，未知字段忽略）。
7. **验收**：让聊天里模型调一次 `propose_learning`（或直接调 `learning.propose`）→ 列表出现待审条目 → 批准（灰度）→ 状态变 `gray` 且 `learning.status.activeGray` 有它 → 撤销 → 状态 `rolledback` 且产物删除；技能提案批准后能在技能页看到转正后的技能；`learning.proposed`/`learning.approved`/`learning.rolledback` 事件都能驱动界面刷新；被拒绝的提案仍能查看，但不生效。

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

> 你的任务：在 `F:\DSH\大肥鱼\桌宠-ui\apps\pet-ui`（独立 git worktree，分支 `feat/pet-ui`）做一个新的 Electron + React 前端（pet-ui）。
> 先完整读 `F:\DSH\大肥鱼\桌宠-ui\docs\pet-ui-AI-任务书.md`，严格按里面的边界、技术栈、协议、git 纪律、环境坑执行。
> 只改 `桌宠-ui` 里的 `apps/pet-ui/**`；先交 M1（壳 + 连 petd + 连接状态），截图和 build 证据贴 README；完成后不要合并分支，告诉用户分支名即可。
> 后端 petd 在另一个目录 `F:\DSH\大肥鱼\桌宠\`（分支 `refactor/petd`，只读参考），启动与连接方式见任务书第 4、5 节。
