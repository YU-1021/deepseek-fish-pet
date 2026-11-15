# petd — 桌宠常驻网关（阶段 1 骨架 + 聊天 + 人格自编辑 + 工作区记忆 + 上下文交接）

这是重构后的新进程骨架：**只跑框架，功能按需求逐个接入注册表**。当前已有：协议、网关、聊天（会话/消息/人格/LLM）、人格自编辑（SOUL.md 按小节改 + 版本/锁/历史/回滚 + AI 自演化）、工作区记忆（文本文件 + Git 版本化，前缀装配进聊天），以及**聊天里模型自己调工具读写记忆**（Coo 那种体验）。

## 现在有什么

- `packages/protocol`：pet-ui ⇄ petd 的 WS 协议（TypeBox schema + 校验 + 错误码）
- `apps/petd`：常驻网关
  - 握手：token 鉴权、协议版本校验、首帧顺序约束
  - 请求：`domain.action` 方法注册表、参数 schema 校验、超时（AbortSignal）、幂等缓存
  - 事件：`event` 帧广播，`seq` 全局单调
  - 方法：
    - 健康/配置：`health.ping` / `health.status` / `config.get`
    - 会话：`session.create` / `session.list` / `session.get` / `session.rename` / `session.delete`
    - 聊天：`chat.send`（自动建会话、带人格与历史、持久化、广播 `chat.*` 事件；模型可在回复前调记忆工具，见下节）
    - 人格：`persona.get` / `persona.patch` / `persona.lock` / `persona.history` / `persona.rollback` / `persona.evolve`
    - 记忆：`memory.status` / `memory.tree` / `memory.list` / `memory.read` / `memory.write` / `memory.append` / `memory.delete` / `memory.move` / `memory.glob` / `memory.grep` / `memory.history` / `memory.diff`
  - 落盘：`config.json`、`secrets.json`（0600，只存密钥）、`SOUL.md`（人格主文件）、`persona-state.json`（版本/锁/历史）、`sessions/<id>.jsonl` + `sessions/index.json`、`workspace/`（工作区记忆，本身是 Git 仓库）、`token.json`（0600）、`gateway.json`（运行中端口，退出删除）、`petd.log`（JSONL + 轮转）
  - 退出：SIGINT/SIGTERM/ipc `{type:'shutdown'}` 优雅关闭

## 首次启动会做什么

1. `config.json` 不存在则按默认生成（gateway/log/llm/chat 四段）
2. 若 `%APPDATA%/dayu-pet/config.json` 存在：把 `apiBase`/`model` 补进配置、把 `apiKey` 迁进 `secrets.json`（只读旧目录，不打印密钥）
3. 若旧 `persona.json` 存在：播种 `SOUL.md`（没有则用内置默认人格），同时建 `persona-state.json`（v1 历史可回滚）
4. 建工作区 `workspace/`：播种 `PARTNER.md`（主人画像模板）、`MEMORY.md`（记忆索引）、`todo.md`（承诺与待办）和 `partner/ notes/ handoffs/ archive/ blobs/` 目录；建 Git 仓库，打 `checkpoint0` 与 `start-<版本>` tag
5. 没配 Key 也能起，但聊天会返回 `E_LLM_AUTH`，提示去写 `secrets.json` 或设 `PETD_LLM_API_KEY`

## 配置（config.json）

```json
{
  "llm": { "apiBase": "https://api.deepseek.com/v1", "model": "deepseek-flash", "timeoutMs": 90000, "temperature": 0.7, "maxTokens": 2048, "thinkingDisabled": true },
  "chat": {
    "systemPromptFile": "SOUL.md",
    "maxHistoryMessages": 40,
    "maxHistoryChars": 24000,
    "maxToolRounds": 6,
    "maxToolWrites": 3,
    "toolResultChars": 4000,
    "contextMaxTokens": 64000,
    "softRatio": 0.85,
    "keepRatio": 0.25,
    "handoffDir": "handoffs",
    "handoffNoteMaxChars": 12000
  }
}
```

- `thinkingDisabled`：V4.1-Flash 默认开思考会拖慢首字且按输出价计费，默认显式关掉。
- `chat.maxToolRounds`：一轮聊天里最多允许几轮「模型调工具 → 结果回灌」（0 = 关闭记忆工具）。
- `chat.maxToolWrites`：一轮聊天里最多几次写操作（写/追加/编辑/删除/移动都算），防止它一时上头把记忆写乱。
- `chat.toolResultChars`：单个工具结果回给模型的字符上限，超了截断并提示分段读。
- `chat.contextMaxTokens`：上下文预算的粗估（按字符/3 估 token，不是模型真实计数），0 = 关闭自动交接。
- `chat.softRatio`：估算用量超过 `contextMaxTokens × softRatio` 时触发自动交接。
- `chat.keepRatio`：交接时保留最近这段 ≈ `contextMaxTokens × keepRatio`，其余压成笔记。
- `chat.handoffDir`：笔记写进工作区的哪个目录（默认 `handoffs`，跟着 Git 一起提交）。
- `chat.handoffNoteMaxChars`：单篇笔记的字符上限（默认 12000）。
- 人格：直接改 `SOUL.md`，下一轮聊天即生效（无需重启）。

## 人格自编辑（SOUL.md 按小节改）

人格的唯一事实源是 `SOUL.md`，旁边 `persona-state.json` 只存元数据：

- **按小节编辑**：`## 性格`、`## 说话方式`、`## 口头禅`、`## 隐藏设定`、`## 身份` 等；未知标题归 `custom:<标题>`，不会丢。
- **谁能改**：`persona.patch` 默认用户（可改任何小节、忽略锁）；`persona.evolve` 是 AI（只能改 `identity/character/catchphrase/hidden/speaking` 且未上锁）。`## 世界观` 永远只有用户能改。
- **锁**：`persona.lock {key, locked}` 只对 AI 生效——上锁后 AI 不能改，用户仍可改。
- **版本与回滚**：每次写版本 +1；`persona.history` 看历史，`persona.rollback {version}` 用该版本完整快照恢复（版本继续往上加）。
- **手改检测**：直接用编辑器改 `SOUL.md`，下次读取检测到 hash 变化 → 自动升版本并记一条 `user` 历史。
- **AI 自演化**：`persona.evolve {sessionId?}` 取最近会话（不传 sessionId 就取最近更新的会话）最后 20 条当「经历」，让模型只输出 `{changed,reason,sections}` JSON；只改未上锁的 AI 小节，单次最多 2 节，失败/拒改就 `changed=false`。改动广播 `persona.changed {version, actor, applied, reason}`。
- **乐观并发**：`persona.patch` 可带 `expectedVersion`，版本不符返回 `E_CONFLICT`（成功后 `persona.changed` 的 version 即新版本）。

## 工作区记忆（Coo 形状）

记忆不是数据库，是 `workspace/` 里的一堆文本文件 + 一个 Git 仓库（参考 Coo/Cormini 的做法，来源与许可见 `docs/记忆移植来源.md`）：

- **播种**：`PARTNER.md`（关于主人，短而精炼，**每轮全文进系统提示词**）、`MEMORY.md`（记忆使用索引）、`todo.md`（承诺/待办，带日期）、`partner/`（按主题/日期的细节笔记）、`notes/`、`handoffs/`（交接笔记）、`archive/`（旧内容归档）、`blobs/`（附件，Git 忽略）。
- **每轮提示词** = 人格（SOUL.md 全文）+ `## 关于主人`（PARTNER.md，超 4000 字截断并留提示）+ `## 记忆维护约定` + `## 工作区文件`（文件清单；`handoffs/ blobs/ archive/` 只给份数，普通目录超过 10 个文件也折叠成「dir/ （N 份）」，太多时退化成只列顶层）。
- **读写**：`memory.read/write/append/delete/move/glob/grep`；路径只能是工作区相对路径（拒绝 `..`、点开头、绝对路径、大小写/短名/链接逃逸）。
- **写即提交**：每次写/追加/删/移动成功都自动 Git commit（作者 `petd`，消息如 `petd wrote partner/作息.md`），用串行队列避免 Git index 冲突。
- **版本**：`memory.status` 看 Git 状态与 tags；`memory.history` 看提交；`memory.diff` 看某次提交改了啥。启动时打 `start-<版本>` tag，首次建仓是 `checkpoint0`。
- **常驻保护**：`PARTNER.md` 不允许删除或整份移动（直接改内容即可），否则前缀会少东西。

## 聊天里自动读写记忆（工具循环）

聊天不只是「把前缀塞给模型」：模型可以在回答前自己动手翻/写记忆，这才是 Coo 的体验。

- **声明给模型的工具**（9 个，Cormini 形状）：`list_files` / `read_file` / `glob_files` / `grep_files` / `write_file` / `append_file` / `edit_file` / `delete_file` / `move_file`；不含附件 blob 工具。
- **一轮 chat.send 的流程**：模型可先返回 `tool_calls` → petd 执行 → 结果以 `role:tool` 回灌 → 模型继续，直到给出纯文本回复或轮数用完（`maxToolRounds`）。
- **约束**：单轮写次数上限 `maxToolWrites`；工具结果超 `toolResultChars` 截断；工具报错不抛给前端，而是以「错误（E_xxx）：…」文本回给模型自己纠正；`PARTNER.md` 禁删/禁整份移动。
- **不污染会话**：工具调用过程不写进 `sessions/*.jsonl`，只落最终 user/assistant 两条；但会广播 `chat.tool` 事件（含 `sessionId/round/name/ok/args/preview`），`chat.send` 结果里也带 `tools[]`，UI 可以显示「它刚翻了记忆」。
- **失败语义**：模型只调工具不给文本、且轮数用完 → `E_LLM_EMPTY`（提示再说一次），并广播 `chat.failed`。
- **提示词配合**：`## 记忆维护约定` 明确告诉模型可以直接调这些工具、不确定先读文件、一主题一文件、先 glob/grep 再新建等。

## 上下文交接笔记

对话不可能无限长。Coo 的做法是「超预算就把旧对话压成笔记存进工作区，再清空重来」，petd 借了这个形状（机械版，不带 LLM 摘要）：

- **触发**：每轮 `chat.send` 先粗估「system 提示词 + 当前有效历史 + 本轮输入」的 token（字符/3），超过 `chat.contextMaxTokens × chat.softRatio` 就自动交接；至少 6 条有效消息才触发。
- **保留多少**：最近约 `contextMaxTokens × keepRatio` 的消息原样留着，更早的压进笔记；至少压 2 条、至少留 2 条。
- **笔记内容**：`handoffs/<UTC 时间戳>.md`——`# 交接笔记` 抬头、会话标题与时间范围、每条消息的角色/时间/正文（单条上限 600 字，预算不够逐级递减，丢掉的计数折叠）；纯机械摘录，注明细节请用 `read_file` / `grep_files` 核对。
- **不丢消息**：`sessions/*.jsonl` 一条不少；会话元数据只记 `contextStart`（从第几条开始算「当前上下文」）、`handoffFiles`（最近 3 篇）、`lastPromptTokens`（观测用）。
- **之后每轮**：只带 `messages[contextStart..]` + 最近一篇笔记（拼在系统提示词后面），模型仍能读到摘要，也能随时去读全文。
- **收益守卫**：如果压完反而更长（很短的对话 + 笔记头开销），自动交接会跳过并记 warn，避免瞎折腾。
- **手动**：`chat.handoff {sessionId}` 立刻交接一次（`force`，一定写笔记），返回 `{file,compressed,kept,tokensBefore,tokensAfter}`；自动交接成功也会广播 `chat.handoff` 事件，`chat.send` 结果里带 `handoff`。
- **注意**：这是估算不是精算，真实 token 以模型返回的 `usage` 为准（`session.lastPromptTokens` 记的就是它）；`chat.contextMaxTokens` 设 0 可完全关掉自动交接。

## 跑起来

```bat
pnpm install
pnpm -r build

:: 前台起（--echo 日志同时打到 stdout）
node apps/petd/dist/index.js --home %TEMP%\petd-dev --echo

:: 冒烟：网关（起进程→握手→调方法→优雅退出）
node apps/petd/scripts/smoke.mjs

:: 冒烟：聊天（会真调一次模型，花一点 token）
node apps/petd/scripts/chat-smoke.mjs

:: 冒烟：人格自编辑（真调一次 evolve，花一点 token）
node apps/petd/scripts/persona-smoke.mjs

:: 冒烟：工作区记忆（不花 token；真工作区 + 真 Git）
node apps/petd/scripts/memory-smoke.mjs

:: 冒烟：聊天自动读写记忆（真调两次模型：先记再问）
node apps/petd/scripts/chat-memory-smoke.mjs

:: 冒烟：上下文交接（真调六次模型；会看到 handoffs/ 笔记和 Git 提交）
node apps/petd/scripts/chat-handoff-smoke.mjs
```

READY 行示例：

```json
{"type":"ready","pid":1234,"port":57403,"home":"C:\\...\\petd-dev","version":"0.1.0","protocol":1}
```

## 连一下试试（Node）

```js
const { WebSocket } = require('ws'); // 或任意 WS 客户端
const fs = require('fs');
const gw = JSON.parse(fs.readFileSync(home + '/gateway.json', 'utf8'));
const token = JSON.parse(fs.readFileSync(home + '/token.json', 'utf8')).token;
const ws = new WebSocket(`ws://127.0.0.1:${gw.port}`);
ws.on('open', () => ws.send(JSON.stringify({ type: 'connect', token, client: { name: 'demo', version: '1' } })));
ws.on('message', (m) => {
  const f = JSON.parse(m);
  if (f.type === 'hello') ws.send(JSON.stringify({ type: 'req', id: '1', method: 'chat.send', params: { text: '你好' } }));
  else console.log(f); // 期间还会收到 chat.user_message / chat.assistant_message 事件
});
```

## 测试

```bat
cd packages/protocol && node --test "dist/**/*.test.js"   :: 10/10
cd apps/petd && node --test "dist/**/*.test.js"          :: 104/104（网关/聊天/工具循环/交接/人格/记忆）
cd apps/petd && node scripts/smoke.mjs                   :: 网关端到端冒烟
cd apps/petd && node scripts/chat-smoke.mjs --home D:\x  :: 聊天端到端（真 LLM，保留 home 便于检查 SOUL.md/sessions）
cd apps/petd && node scripts/persona-smoke.mjs --home D:\x :: 人格端到端（真 LLM 一次 evolve，保留 home 便于检查 SOUL.md/persona-state.json）
cd apps/petd && node scripts/memory-smoke.mjs --home D:\x   :: 记忆端到端（真 Git，44 项；保留 home 可翻 workspace/.git）
cd apps/petd && node scripts/chat-memory-smoke.mjs --home D:\x :: 聊天记忆端到端（真 LLM 两次：让它记一件事→工作区出现文件；再问→先读记忆再答）
cd apps/petd && node scripts/chat-handoff-smoke.mjs --home D:\x :: 交接端到端（真 LLM 六次；第 4 轮触发自动交接→笔记/Git/contextStart；再手动交接一次）
```

聊天冒烟覆盖：迁移与播种、握手、`chat.send` 真实回复、会话 JSONL 落盘、`chat.*` 事件、第二轮带历史、`session.get/rename/list/delete`、优雅退出。

人格冒烟覆盖：SOUL/state 播种（v1 可回滚）、`persona.get`、用户 patch + 事件、`expectedVersion` 冲突、上锁/世界观拒锁、历史、真 LLM `persona.evolve`（会改）+ `persona.changed(agent)`、回滚到 v2、解锁、优雅退出。

记忆冒烟覆盖（44 项）：工作区播种与目录、Git 仓库/`checkpoint0`/`start-<版本>` tag、`memory.status/tree/list`、write→落盘→Git 提交、append、read、glob、grep（路径+行号）、history、diff、move/delete、常驻文件禁删、路径逃逸拒绝、参数校验拒绝、重启后工作区与 Git HEAD 仍在、两次优雅退出。

聊天记忆冒烟覆盖（21 项，真 LLM）：模型第一轮读旧文件→用 `write_file` 写新文件（工作区真的多出 `partner/*.md`，Git 有 `petd wrote …` 提交）→`chat.tool` 事件→工具过程不落库；第二轮先 `read_file` 再回答，答案里带出记忆要点；两轮后会话 4 条；优雅退出。

交接冒烟覆盖（26 项，真 LLM）：自动交接（4 轮后 compressed 4/kept 2、token 估算变小、`chat.handoff` 事件、`handoffs/*.md` 以 `# 交接笔记` 开头、Git 有 `petd wrote handoffs/…` 提交、会话 JSONL 8 条不丢、`contextStart`/`handoffFiles`/`lastPromptTokens` 落元数据）→ 下一轮历史从 `contextStart` 起且 system 带笔记；手动 `chat.handoff`（compressed 2/kept 2、第二篇笔记）；优雅退出。

## 刻意没做（等需求逐个说）

语音/ASR/TTS、口语/发音评测（用户明确不做）、感知、输入、游戏助手、WebUI、插件、cron、SQLite 状态、审批门（危险动作确认）、附件 blob 存储/向量检索、记忆工具的流式输出……
