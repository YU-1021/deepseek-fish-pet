# petd — 桌宠常驻网关（阶段 1 骨架 + 聊天 + 人格自编辑 + 工作区记忆 + 上下文交接 + 附件 + 语音 + 语音识别 + 情绪与状态 + 提醒与日程 + 自动化）

这是重构后的新进程骨架：**只跑框架，功能按需求逐个接入注册表**。当前已有：协议、网关、聊天（会话/消息/人格/LLM）、人格自编辑（SOUL.md 按小节改 + 版本/锁/历史/回滚 + AI 自演化）、工作区记忆（文本文件 + Git 版本化，前缀装配进聊天），以及**聊天里模型自己调工具读写记忆**（Coo 那种体验）、附件句柄、语音合成（Edge 在线神经语音 + 本机 SAPI 离线兜底）、语音识别与唤醒词（本地 whisper.cpp + Silero VAD，离线可用）、**情绪与状态**（心情/好感/精力，带离线回落、聊天行为指导与模型评估），**提醒与日程**（一次性提醒、到点事件、稍后提醒；聊天里也能让模型自己设提醒），以及**自动化/自主任务**（cron 式定时任务：按间隔/每天/一次性/手动，让 petd 自己在专用会话里跑一轮聊天，带运行记录与事件；聊天里也能让模型自己排任务）。

## 现在有什么

- `packages/protocol`：pet-ui ⇄ petd 的 WS 协议（TypeBox schema + 校验 + 错误码）
- `apps/petd`：常驻网关
  - 握手：token 鉴权、协议版本校验、首帧顺序约束
  - 请求：`domain.action` 方法注册表、参数 schema 校验、超时（AbortSignal）、幂等缓存
  - 事件：`event` 帧广播，`seq` 全局单调
  - 方法：
    - 健康/配置：`health.ping` / `health.status` / `config.get`
    - 会话：`session.create` / `session.list` / `session.get` / `session.rename` / `session.delete`
    - 聊天：`chat.send`（自动建会话、带人格与历史、持久化、广播 `chat.*` 事件；模型可在回复前调记忆工具，见下节；可带 `attachments` 附件句柄）
    - 人格：`persona.get` / `persona.patch` / `persona.lock` / `persona.history` / `persona.rollback` / `persona.evolve`
    - 记忆：`memory.status` / `memory.tree` / `memory.list` / `memory.read` / `memory.write` / `memory.append` / `memory.delete` / `memory.move` / `memory.glob` / `memory.grep` / `memory.history` / `memory.diff`
    - 附件：`blob.put` / `blob.list` / `blob.info` / `blob.get` / `blob.preview` / `blob.delete`
    - 语音：`voice.status` / `voice.voices` / `voice.speak`（合成音频以 base64 返回，`chat.send` 可带 `speak`）
    - 语音识别：`asr.status` / `asr.models` / `asr.download` / `asr.transcribe` / `asr.listen.start` / `asr.listen.feed` / `asr.listen.stop`（本地 whisper.cpp + Silero VAD；流式监听→切句→识别→唤醒词→可选自动回聊天）
    - 情绪与状态：`mood.status` / `mood.history` / `mood.adjust` / `mood.poke` / `mood.evaluate`（心情/好感/精力 0–100，离线回落，聊天时给行为指导、聊完小步变化，可让模型评估一段对话）
    - 提醒与日程：`reminder.status` / `reminder.list` / `reminder.create` / `reminder.cancel` / `reminder.snooze`（一次性提醒；到点广播 `reminder.due`，错过太久的标 skipped；聊天里模型可用 `remind_in/remind_at/remind_list/remind_cancel` 自己设提醒）
    - 自动化：`automation.status` / `automation.list` / `automation.get` / `automation.create` / `automation.update` / `automation.delete` / `automation.pause` / `automation.resume` / `automation.run` / `automation.runs`（cron 式自主任务；运行 = 在专用会话里跑一轮聊天并记下输出/用量；聊天里模型可用 `schedule_task/list_tasks/cancel_task` 自己排任务）
  - 落盘：`config.json`、`secrets.json`（0600，只存密钥）、`SOUL.md`（人格主文件）、`persona-state.json`（版本/锁/历史）、`sessions/<id>.jsonl` + `sessions/index.json`、`workspace/`（工作区记忆，本身是 Git 仓库；`workspace/blobs/` 存附件、Git 忽略）、`voice-cache/`（TTS 音频按内容 hash 缓存，可随时删）、`asr/`（whisper 模型与 VAD 模型、临时 WAV；模型很大，可放别处用 `asr.modelDir` 指过去）、`state/mood.json`（情绪状态与最近 100 条变化历史）、`state/reminders.json`（提醒列表与已响记录）、`state/automations.json`（自主任务与运行记录）、`token.json`（0600）、`gateway.json`（运行中端口，退出删除）、`petd.log`（JSONL + 轮转）
  - 退出：SIGINT/SIGTERM/ipc `{type:'shutdown'}` 优雅关闭

## 首次启动会做什么

1. `config.json` 不存在则按默认生成（gateway/log/llm/chat/voice/asr/mood/reminders/automation 九段）
2. 若 `%APPDATA%/dayu-pet/config.json` 存在：把 `apiBase`/`model` 补进配置、把 `apiKey` 迁进 `secrets.json`（只读旧目录，不打印密钥）
3. 若旧 `persona.json` 存在：播种 `SOUL.md`（没有则用内置默认人格），同时建 `persona-state.json`（v1 历史可回滚）
4. 建工作区 `workspace/`：播种 `PARTNER.md`（主人画像模板）、`MEMORY.md`（记忆索引）、`todo.md`（承诺与待办）和 `partner/ notes/ handoffs/ archive/ blobs/` 目录；建 Git 仓库，打 `checkpoint0` 与 `start-<版本>` tag
5. ASR：找 `whisper-cli`（环境变量 `PETD_WHISPER_DIR` → `asr.binaryDir` → `apps/petd/vendor/whisper` → 仓库 `app/vendor/whisper`）和模型（`asr.modelDir` → `home/asr` → 旧版 `%APPDATA%/dayu-pet/asr`）；缺模型时 `asr.download` 会从 hf-mirror 拉（模型很大，建议提前下）
6. 情绪状态：`home/state/mood.json` 不存在时播种默认值（心情 70 / 好感 30 / 精力 80）
7. 提醒：`home/state/reminders.json` 不存在时创建空文件，并把待响提醒重新布防（重启不丢）
8. 自动化：`home/state/automations.json` 不存在时创建空文件；`config.automation.enabled=false`（默认）时定时器不跑，避免偷偷花 token
9. 没配 Key 也能起，但聊天会返回 `E_LLM_AUTH`，提示去写 `secrets.json` 或设 `PETD_LLM_API_KEY`

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
    "handoffNoteMaxChars": 12000,
    "handoffUseLlm": true,
    "handoffSummaryTokens": 600
  },
  "voice": {
    "enabled": true,
    "engine": "edge",
    "voice": "zh-CN-XiaoxiaoNeural",
    "rate": 1,
    "pitch": 1,
    "maxChars": 1200,
    "autoSpeak": false,
    "fallbackToSapi": true
  },
  "asr": {
    "enabled": true,
    "binaryDir": "",
    "modelDir": "",
    "model": "base",
    "language": "zh",
    "useVad": true,
    "vadThreshold": 0.5,
    "prompt": "你好大肥鱼。大肥鱼。小鱼。",
    "wakeEnabled": true,
    "wakeWords": ["你好大肥鱼", "大肥鱼", "你好大飞鱼"],
    "autoChat": false,
    "sampleRate": 16000,
    "energyThreshold": 0.012,
    "minSpeechMs": 300,
    "silenceMs": 600,
    "maxSegmentMs": 15000
  },
  "mood": {
    "enabled": true,
    "chatInjection": true,
    "chatNudge": true,
    "moodDecayPerHour": 2,
    "energyRecoverPerHour": 8
  },
  "reminders": {
    "enabled": true,
    "maxPending": 50,
    "catchUpHours": 24,
    "keepFiredDays": 7
  },
  "automation": {
    "enabled": false,
    "tickSeconds": 30,
    "catchUpMinutes": 15,
    "maxJobs": 10,
    "maxRunsKept": 100,
    "runTimeoutMs": 180000
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
- `chat.handoffUseLlm`：交接笔记是否让模型整理成摘要（默认 true；失败/太短自动回退机械摘录）。
- `chat.handoffSummaryTokens`：摘要那一次模型调用的输出上限（默认 600，100–4000）。
- `voice.enabled`：语音总开关；关掉后 `voice.speak` 返回 `E_UNAVAILABLE`、`chat.send` 不朗读。
- `voice.engine`：`edge`（微软 Edge 在线神经语音，音质好、需要网络）或 `sapi`（本机 Windows SAPI 离线，音色少但断网可用）；默认 `edge`。
- `voice.voice`：音色 id，默认 `zh-CN-XiaoxiaoNeural`；`voice.voices` 能列出所有可选项（Edge 内置表 + 本机 SAPI 音色）。
- `voice.rate` / `voice.pitch`：语速/音调倍率（0.5–2，1 为原速）。
- `voice.maxChars`：单次朗读文本上限（超了拒绝，先截断再请求）。
- `voice.autoSpeak`：聊天回复是否默认朗读（`chat.send` 里的 `speak` 参数优先级更高）。
- `voice.fallbackToSapi`：Edge 失败时是否自动用本机 SAPI 兜底（默认 true；两边都失败才报错）。
- `asr.enabled`：语音识别总开关；关掉后 `asr.*` 返回 `E_UNAVAILABLE`。
- `asr.binaryDir` / `asr.modelDir`：whisper-cli 与模型目录（留空则按内置顺序找，见「首次启动」）。
- `asr.model`：`tiny` / `base` / `small`（多语言模型，中文可用；越大越准越慢，默认 `base`）。
- `asr.language`：识别语言，默认 `zh`；中文结果会自动转简体（OpenCC tw→cn）。
- `asr.useVad` / `asr.vadThreshold`：是否用 Silero VAD 配合语音端点检测、阈值（0–1）。
- `asr.prompt`：识别提示词（把唤醒词和常见称呼塞进去，命中率更高）。
- `asr.wakeEnabled` / `asr.wakeWords`：唤醒词开关与列表（含近似匹配，容忍一两个字听错）。
- `asr.autoChat`：唤醒词命中后是否自动把整句发进聊天（`chat.send`）；默认 false，只广播 `asr.wake`。
- `asr.sampleRate` / `energyThreshold` / `minSpeechMs` / `silenceMs` / `maxSegmentMs`：流式监听的采样率与能量 VAD 参数（喂 PCM 用）。
- `mood.enabled`：情绪系统总开关（关掉后不回落、不注入、不微调，`mood.*` 仍可读但 `enabled=false`）。
- `mood.chatInjection`：是否把当前情绪的行为指导拼进聊天 system 提示词（只给档位描述，不把数值告诉模型）。
- `mood.chatNudge`：一轮聊天成功后是否自动小幅调整（心情 +0.6 / 好感 +0.4 / 精力 -0.2，并广播 `mood.changed`）。
- `mood.moodDecayPerHour`：离线时心情每小时自然回落多少（默认 2，单次最多回落 30）。
- `mood.energyRecoverPerHour`：离线时精力每小时恢复多少（默认 8，恢复不超过 100）。
- `reminders.enabled`：提醒系统总开关（关掉后 `reminder.create/cancel/snooze` 返回 `E_UNAVAILABLE`，列表仍可读）。
- `reminders.maxPending`：最多同时挂多少条待响提醒（默认 50，防手滑刷屏）。
- `reminders.catchUpHours`：错过多少小时内的提醒还会补报；更老的标记为 skipped 不补。
- `reminders.keepFiredDays`：已响/已取消的记录保留多少天（之后自动清理）。
- `automation.enabled`：自动化总开关（**默认 false**：自主任务会真花 token，不想花钱/不想让它自己动就别开）。
- `automation.tickSeconds`：调度器多久检查一次任务是否到点（5–600，默认 30）。
- `automation.catchUpMinutes`：错过多久内的任务还会补跑；超过就跳过（发 `automation.skipped`、不花 token）。
- `automation.maxJobs`：最多同时存在多少个任务（1–100，默认 10）。
- `automation.maxRunsKept`：运行记录保留最近多少条（1–1000，默认 100）。
- `automation.runTimeoutMs`：单个任务跑一轮的超时（默认 180000 = 3 分钟，超时中止并记 failed）。
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

对话不可能无限长。Coo 的做法是「超预算就把旧对话压成笔记存进工作区，再清空重来」，petd 借了这个形状，并做了两个版本：

- **LLM 摘要版（默认）**：交接时先让模型当一次「记忆整理员」，把更早的对话整理成给未来自己看的笔记（保留主人画像/关系/偏好/承诺待办/日期事实，允许省略寒暄重复，按主题分小节）；失败、超时或内容太短时自动回退机械版，不会让交接本身失败。
- **机械摘录版（兜底）**：不调模型，逐条摘录角色/时间/正文（单条上限 600 字，预算不够逐级递减，丢掉的计数折叠）。
- **触发**：每轮 `chat.send` 先粗估「system 提示词 + 当前有效历史 + 本轮输入」的 token（字符/3），超过 `chat.contextMaxTokens × chat.softRatio` 就自动交接；至少 6 条有效消息才触发。
- **保留多少**：最近约 `contextMaxTokens × keepRatio` 的消息原样留着，更早的压进笔记；至少压 2 条、至少留 2 条。
- **笔记文件**：`handoffs/<UTC 时间戳>.md`——两种模式都用同一个 `# 交接笔记` 抬头；摘要版多一段 `## 摘要`，并注明「由我自己整理的摘要，可能漏细节，用 read_file / grep_files 核对」。
- **不丢消息**：`sessions/*.jsonl` 一条不少；会话元数据只记 `contextStart`（从第几条开始算「当前上下文」）、`handoffFiles`（最近 3 篇）、`lastPromptTokens`（观测用）。
- **之后每轮**：只带 `messages[contextStart..]` + 最近一篇笔记（拼在系统提示词后面），模型仍能读到摘要，也能随时去读全文。
- **收益守卫**：如果压完反而更长（很短的对话 + 笔记头开销），自动交接会跳过并记 warn，避免瞎折腾。
- **手动**：`chat.handoff {sessionId}` 立刻交接一次（`force`，一定写笔记），返回 `{file,compressed,kept,tokensBefore,tokensAfter,mode}`（`mode` = `llm` / `mechanical`）；自动交接成功也会广播 `chat.handoff` 事件，`chat.send` 结果里带 `handoff`。
- **注意**：这是估算不是精算，真实 token 以模型返回的 `usage` 为准（`session.lastPromptTokens` 记的就是它）；`chat.contextMaxTokens` 设 0 可完全关掉自动交接，`chat.handoffUseLlm=false` 可只用机械版（省一次模型调用）。

## 附件 blob（图片/文件）

聊天里的图片、文件不往会话里塞 base64，而是存进工作区的 `blobs/`，给模型一个句柄（Cormini 的形状）：

- **存**：`blob.put {dataBase64, name?, mime?}` → 返回 `{handle, name, path, mime, size, sha256, createdAt}`；单文件上限 8MB，文件名是内容寻址的 `<sha256 前 16 位>-<安全化的原名>.<扩展名>`，同样内容只存一份。
- **句柄**：统一写作 `blob:<文件名>`（也接受 `blobs/<文件名>`）；会话、事件、`chat.send` 参数里都用它引用附件，不暴露绝对路径。
- **读/查/删**：`blob.list`（按修改时间新到旧）、`blob.info`、`blob.get`（base64 原始字节）、`blob.delete`（物理删除）。
- **预览**：`blob.preview {ref, maxChars?}` 返回 `meta.kind`（`image/audio/video/text/binary`）、图片 `meta.image {width,height}`（只读文件头嗅探、不解码整图）和文本开头摘录（`truncated` 标记是否截断）。列表里的缩略图建议由 pet-ui 主进程直接读 `<workspace>/blobs/<name>` 用 Electron `nativeImage` 缩放（不用每次走 WS 传整份 base64），缓存键用内容寻址的 `sha256`。
- **聊天带附件**：`chat.send {text, attachments: [句柄…]}`（最多 10 个）——petd 先校验附件存在，再把「句柄 + 文件名 + mime + size」拼成一段提示附在本轮用户消息后面；**会话 JSONL 只存原始文本**，下一轮不会重复带附件块。`chat.send` 结果里回 `attachments[]` 供 UI 显示。
- **模型能用附件**：记忆工具里多了 `list_blobs` / `read_blob` / `save_blob`——文本附件能读出内容；图片/音频等二进制只能拿到元数据（当前没有视觉/音频解析能力，会如实说看不到）。`save_blob` 计入写配额。
- **Git**：`blobs/` 在 `.gitignore` 里，不进版本历史（老工作区若已跟踪过 `blobs/`，启动时会自动取消跟踪并提交一条记录）；附件文件本身仍在磁盘上，靠内容 hash 名保证不重名。


## 语音（TTS）

聊天回复可以让 petd 直接合成语音（`voice.*`），音频以 base64 随结果返回，UI 拿到 data URL 就能播，不需要额外的音频通道：

- **引擎**：默认 `edge`（微软 Edge 朗读的新端点 `api.msedgeservices.com` + Sec-MS-GEC v2 签名，2026-10 后旧端点会 403，这里已按新协议实现）；断网或端点失败时若 `fallbackToSapi=true` 自动切本机 SAPI（离线、音色少）。`voice.voices` 返回可用音色（Edge 内置表 9 个 + 本机 SAPI 音色）。
- **`voice.speak {text, voice?, rate?, pitch?}`** → `{id, file, mime, bytes, durationMs, cached, engine, voice, rate, pitch, text, audioBase64, elapsedMs}`：先做文本清理（去 `[..]`/`【..】` 脚本标记、压空白），按句切到 180 字以内分段合成，缓存按 `sha256(engine|voice|rate|pitch|text)` 存 `voice-cache/`，同一句第二次直接命中（`cached=true`）。
- **聊天联动**：`chat.send {text, speak: true}` → 结果里多一个 `speech`（同 `voice.speak` 的形状，可为 null）；不传 `speak` 时看 `voice.autoSpeak`。语音合成失败只记 warn，不影响聊天回复；朗读文本取最终 assistant 回复（不含工具过程）。
- **事件**：合成成功广播 `voice.speech {id,file,mime,bytes,durationMs,cached,engine,voice,text}`；UI 可用 `durationMs` 做口型/动画时长。
- **离线可用**：`voice.engine=sapi` 时完全不联网（本机 `System.Speech`），适合断网或不想走在线语音的场景。

## 语音识别与唤醒词（ASR）

说一句「你好大肥鱼，今天天气不错」，petd 在本地把话听成文字；命中唤醒词还会广播事件（可选自动发进聊天）。全程离线：whisper.cpp + Silero VAD，不走任何云 API。

- **引擎**：本机 whisper.cpp（复用仓库里 `app/vendor/whisper/whisper-cli.exe` 与 DLL），模型是 **多语言** ggml（`tiny`/`base`/`small`，默认 `base`）；模型文件放 `asr/` 下，用 `asr.models` 看就绪状态。本机没装 Windows 语音识别器也能用（不走 SAPI ASR）。实现形状参考了旧桌宠 `app/src/asr.js`（同项目 MIT），但改成了常驻服务 + 事件驱动 + 唤醒词近似匹配。
- **一次性识别**：`asr.transcribe {audioBase64}`（16k 单声道 PCM16 WAV 的 base64）→ `{text, language, durationMs, tookMs, wake}`；`tookMs` 是识别耗时，`wake` 是命中的唤醒词（没命中为 null）。
- **流式监听**（麦克风持续输入）：
  1. `asr.listen.start {}` → `{streamId, sampleRate, vad:{energyThreshold,minSpeechMs,silenceMs,maxSegmentMs,preRollMs}, model, wakeWords}`；
  2. 把 16k PCM16 分片（base64）不断 `asr.listen.feed {streamId, pcmBase64}`，petd 用能量 VAD 切句（带 300ms 预卷、句尾留 200ms，超长自动切）；
  3. 每切出一句就识别并广播 `asr.segment {streamId, text, durationMs, tookMs, wake}`；命中唤醒词再广播 `asr.wake {streamId, text, wakeWord}`；
  4. `asr.listen.stop {streamId}` 收尾（flush 尾巴），返回 `{segments}`；空闲 60s 自动回收，最多 4 路并发。
- **唤醒词匹配**：先做文本归一化（去空白/标点、小写），再用 LCS 相似度（阈值 0.66）容忍「大肥鱼→大飞鱼」这类单字听错；`asr.prompt` 里塞唤醒词也能明显提高识别命中率。
- **自动进聊天**：`asr.autoChat=true` 时，命中唤醒词的整句会以最近会话发 `chat.send`（按 `voice.autoSpeak` 决定要不要读出来），失败只 warn 不影响识别。
- **模型下载**：`asr.download {model}` 从 hf-mirror（备用 HuggingFace）拉模型，进度事件 `asr.download {model, got, total, url}`；模型很大（base ≈148MB），第一次慢慢等，之后按 `asr.models` 的 ready 判断就绪。
- **隐私**：音频不落盘（只在 `asr/tmp/` 短暂写 WAV，识别完删除）、不上传；识别文本才进事件与会话。
- **确认方式**：`node apps/petd/scripts/asr-smoke.mjs` 会本机合成一段中文语音、真跑 whisper 识别与流式监听，43 项断言全绿。

## 情绪与状态（mood）

桌宠有 3 个可见数值（0–100，一位小数）：**心情 mood**、**对主人的好感 affection**、**精力 energy**，外加被戳次数。它们会影响聊天时的人格表现，但**不把数字直接告诉模型**——提示词里只有按档位写的行为指导。

- **档位**：心情 很低落 / 有点闷 / 平静 / 心情不错 / 很开心；好感 还生疏 / 逐渐熟悉 / 比较亲近 / 很黏你；精力 很累 / 有点乏 / 正常 / 很有精神。
- **离线回落**：启动时按离线时长回落心情（`moodDecayPerHour`，单次最多 -30）、恢复精力（`energyRecoverPerHour`）；每次读取都会先应用一次，变化记进历史（`source=system`）。
- **聊天注入**：`config.mood.chatInjection=true` 时，`chat.send` 的 system 提示词末尾会多一段「你现在的状态」（语气/主动性的行为指导，不报数值）。
- **聊天微调**：`config.mood.chatNudge=true` 时，一轮聊天成功后小步调整（心情 +0.6、好感 +0.4、精力 -0.2），并广播 `mood.changed`。
- **方法**：`mood.status`（快照 + 档位）、`mood.history`（变化历史，最近的在前）、`mood.adjust`（手动增减，带 reason）、`mood.poke`（被戳：心情 +1、好感 +0.5）、`mood.evaluate`（让模型看最近 12 条对话，输出 -2~+2 的评估并应用；真调一次模型）。
- **事件**：任何变化都广播 `mood.changed {state, applied, source, reason}`，UI 可以据此刷新心情指示/表情/桌面立绘。
- **落盘**：`home/state/mood.json`（当前值 + 最近 100 条变化历史），坏档或老格式会自动兜底。
- **确认方式**：`node apps/petd/scripts/mood-smoke.mjs`（真 LLM 两次：一轮聊天 + 一次情绪评估；31 项断言）。

## 提醒与日程（reminders）

一次性提醒（不重复）：给「N 分钟后 / HH:MM / 绝对时间」三者之一，落盘成绝对时间戳；到点只广播 `reminder.due`，由 UI 或聊天决定怎么提醒（弹 toast、桌宠说话、朗读都行）。

- **方法**：`reminder.status`（待响数 / 下一条时间 / 是否已布防）、`reminder.list`（待响列表，按时间、带 `inMinutes`）、`reminder.create`（`text` + `inMinutes`/`atClock`/`at` 三选一）、`reminder.cancel`、`reminder.snooze`（默认 5 分钟，1–1440）。
- **事件**：`reminder.created` / `reminder.due` / `reminder.snoozed` / `reminder.cancelled` / `reminder.skipped`，都带 `item`；`due` 里还有 `firedLateMs`（补报延迟）。
- **聊天联动**：模型在聊天里拿到 `remind_in` / `remind_at` / `remind_list` / `remind_cancel` 四个工具，可以直接答应「十分钟后提醒我喝水」并真的设上；设提醒不计记忆写配额。
- **补报规则**：重启后到点的提醒会补报；但错过超过 `catchUpHours`（默认 24 小时）的标 skipped 不再补，避免一次炸出十几条。
- **落盘**：`home/state/reminders.json`（待响 + 已响历史），坏条目自动跳过、不整档报废。
- **确认方式**：`node apps/petd/scripts/reminder-smoke.mjs`（不需要模型：3 秒提醒真的响、稍后/取消、重启保留；32 项断言）。

## 自动化/自主任务（automation）

cron 式的「自己干活」：每个任务是一段 prompt + 一种计划，到点就让 petd 在**专用会话**里跑一轮完整聊天（能调记忆/提醒等工具），把回复与用量记为一次运行（run）。这是从 OpenClaw 借来的「agent 挂机」形状，但只跑在本机、只花你的 API 额度。

- **计划（四选一）**：`interval {everyMinutes}`、`daily {atClock}`、`once {at}`、`manual`（只手动跑）。错过超过 `automation.catchUpMinutes` 的不补跑（避免一开机连环烧钱）。
- **方法**：`automation.status`（开关/任务数/下次时间）、`automation.list` / `automation.get`、`automation.create`（`name?` + `prompt` + `schedule`）、`automation.update`、`automation.delete`、`automation.pause` / `automation.resume`、`automation.run`（立即手动跑一次，结果同步返回，最长 4 分钟）、`automation.runs`（运行记录，带 output/error/usage）。
- **事件**：`automation.job.created/updated/deleted`、`automation.run.started/succeeded/failed/cancelled`、`automation.skipped`（错过太久被跳过）。
- **单飞**：同一时刻只跑一个任务，不会并发烧 token；运行超时用 AbortSignal 中止并记 failed。
- **聊天联动**：模型拿到 `schedule_task`（排任务）/ `list_tasks` / `cancel_task`，可以直接答应「每天早上 8 点给我总结一下待办」并真的排上；排任务也算一次写操作（计入 `chat.maxToolWrites`）。
- **落盘**：`home/state/automations.json`（任务定义 + 最近 N 条运行记录）——重启后任务还在、重新布防。
- **安全默认**：`automation.enabled` 默认 false，定时器根本不启动；打开后也只在你配置的计划上跑，不自主加任务。
- **确认方式**：`node apps/petd/scripts/automation-smoke.mjs`（真 LLM 手动跑一次；38 项断言）。

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

:: 冒烟：上下文交接（真调若干次模型（含两次记忆整理摘要）；会看到 handoffs/ 笔记和 Git 提交）
node apps/petd/scripts/chat-handoff-smoke.mjs

:: 冒烟：附件 blob（真调一次模型；会看到 blobs/ 文件与句柄）
node apps/petd/scripts/blob-smoke.mjs

:: 冒烟：语音（本机 SAPI 离线；真调一次模型验证 chat.send 朗读）
node apps/petd/scripts/voice-smoke.mjs

:: 冒烟：语音识别/唤醒词（本机 SAPI 合成 16k 语音 + whisper.cpp 真识别，不花 token）
node apps/petd/scripts/asr-smoke.mjs

:: 冒烟：情绪与状态（真调两次模型：一轮聊天 + 一次情绪评估）
node apps/petd/scripts/mood-smoke.mjs

:: 冒烟：提醒与日程（不花 token；3 秒提醒真的响、稍后/取消、重启保留）
node apps/petd/scripts/reminder-smoke.mjs

:: 冒烟：自动化/自主任务（真调一次模型；手动排一个任务并立刻跑）
node apps/petd/scripts/automation-smoke.mjs
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
cd apps/petd && node --test "dist/**/*.test.js"          :: 200/200（网关/聊天/工具循环/交接/人格/记忆/附件/语音/ASR/情绪/提醒/自动化）
cd apps/petd && node scripts/smoke.mjs                   :: 网关端到端冒烟
cd apps/petd && node scripts/chat-smoke.mjs --home D:\x  :: 聊天端到端（真 LLM，保留 home 便于检查 SOUL.md/sessions）
cd apps/petd && node scripts/persona-smoke.mjs --home D:\x :: 人格端到端（真 LLM 一次 evolve，保留 home 便于检查 SOUL.md/persona-state.json）
cd apps/petd && node scripts/memory-smoke.mjs --home D:\x   :: 记忆端到端（真 Git，44 项；保留 home 可翻 workspace/.git）
cd apps/petd && node scripts/chat-memory-smoke.mjs --home D:\x :: 聊天记忆端到端（真 LLM 两次：让它记一件事→工作区出现文件；再问→先读记忆再答）
cd apps/petd && node scripts/chat-handoff-smoke.mjs --home D:\x :: 交接端到端（真 LLM 若干次（含摘要）；第 4 轮触发自动交接→笔记/Git/contextStart；再手动交接一次）
cd apps/petd && node scripts/blob-smoke.mjs --home D:\x        :: 附件端到端（真 LLM 一次；blob.* 闭环/去重/Git 忽略 blobs//chat.send 带附件句柄）
cd apps/petd && node scripts/voice-smoke.mjs --home D:\x       :: 语音端到端（本机 SAPI 离线；真 LLM 一次；合成/缓存/事件/聊天朗读）
cd apps/petd && node scripts/asr-smoke.mjs --home D:\x         :: ASR 端到端（本机 SAPI 合成 16k WAV + whisper.cpp 真识别；43 项；不花 token）
cd apps/petd && node scripts/mood-smoke.mjs --home D:\x        :: 情绪端到端（真 LLM 两次：一轮聊天 + 一次评估；status/adjust/poke/history/聊天微调/重启保留；31 项）
cd apps/petd && node scripts/reminder-smoke.mjs --home D:\x    :: 提醒端到端（不花 token；3 秒提醒真的响、到点事件/稍后/取消/重启保留；32 项）
cd apps/petd && node scripts/automation-smoke.mjs --home D:\x  :: 自动化端到端（真 LLM 一次；手动任务跑通/运行记录/暂停恢复/重启保留；38 项）
```

聊天冒烟覆盖：迁移与播种、握手、`chat.send` 真实回复、会话 JSONL 落盘、`chat.*` 事件、第二轮带历史、`session.get/rename/list/delete`、优雅退出。

人格冒烟覆盖：SOUL/state 播种（v1 可回滚）、`persona.get`、用户 patch + 事件、`expectedVersion` 冲突、上锁/世界观拒锁、历史、真 LLM `persona.evolve`（会改）+ `persona.changed(agent)`、回滚到 v2、解锁、优雅退出。

记忆冒烟覆盖（44 项）：工作区播种与目录、Git 仓库/`checkpoint0`/`start-<版本>` tag、`memory.status/tree/list`、write→落盘→Git 提交、append、read、glob、grep（路径+行号）、history、diff、move/delete、常驻文件禁删、路径逃逸拒绝、参数校验拒绝、重启后工作区与 Git HEAD 仍在、两次优雅退出。

聊天记忆冒烟覆盖（21 项，真 LLM）：模型第一轮读旧文件→用 `write_file` 写新文件（工作区真的多出 `partner/*.md`，Git 有 `petd wrote …` 提交）→`chat.tool` 事件→工具过程不落库；第二轮先 `read_file` 再回答，答案里带出记忆要点；两轮后会话 4 条；优雅退出。

交接冒烟覆盖（29 项，真 LLM）：自动交接（4 轮后 compressed 4/kept 2、token 估算变小、`chat.handoff` 事件带 `mode=llm`、`handoffs/*.md` 以 `# 交接笔记` 开头且含 `## 摘要`、Git 有 `petd wrote handoffs/…` 提交、会话 JSONL 8 条不丢、`contextStart`/`handoffFiles`/`lastPromptTokens` 落元数据）→ 下一轮历史从 `contextStart` 起且 system 带笔记；手动 `chat.handoff`（compressed 2/kept 2、第二篇笔记）；优雅退出。

附件冒烟覆盖（25 项，真 LLM 一次）：`blob.put` 句柄格式/mime/size、同内容去重、`blob.list/info`（含 `blobs/<文件名>` 写法）、`blob.get` 原字节一致、文件真的在 `workspace/blobs/`、`.gitignore` 忽略且 Git 历史里没有 `blobs/` 路径、带附件 `chat.send`（真模型回复「看不到画面但确认是 PNG」、`attachments[]` 返回、会话正文与落盘都不含附件提示）、`blob.delete` 后列表为空且磁盘文件删除、优雅退出。

语音冒烟覆盖（26 项，本机 SAPI 离线 + 真 LLM 一次）：`voice.status` 开关/引擎/音色/缓存统计、`voice.voices` 含本机 SAPI 音色、`voice.speak` 出 WAV/字节数合理/时长>0/base64 是 RIFF、缓存命中且 id 一致、`voice.speech` 事件广播、`chat.send {speak:true}` 返回 `speech` 且会话里只有文字、JSONL 不存音频、优雅退出。

ASR 冒烟覆盖（43 项，本机 SAPI 合成 + whisper.cpp 真识别，不花 token）：`asr.status`（引擎/binary/模型就绪）、`asr.models` 三档、SAPI 合成 16k 中文 WAV、`asr.transcribe` 识别出「你好大肥鱼,今天天气不错,陪我聊两句吧。」（自动转简体）且唤醒词命中、`asr.listen.start`→16 片 300ms PCM feed + 静音→能量 VAD 切 1 句、`asr.segment` 事件、`asr.listen.stop`、流式识别文本一致、优雅退出。

情绪冒烟覆盖（31 项，真 LLM 两次）：默认值 70/30/80 与档位、`config.get` 的 mood 段、`mood.adjust`（记历史 + `mood.changed`）、`mood.poke`（pokes+1、心情 +1、好感 +0.5）、`mood.history`、一轮聊天后的微调（心情升/好感升/精力降 + `mood.changed(source=chat)`）、`mood.evaluate` 真模型评估（`source=llm` 事件）、`state/mood.json` 落盘、重启后数值与被戳次数保留、两次优雅退出。

提醒冒烟覆盖（32 项，不花 token）：`config.get` 的 reminders 段、`reminder.status` 初始无待响、`reminder.create`（3 秒后 / 60 分钟后 / HH:MM 三种）、`reminder.list` 排序与 inMinutes、到点真的广播 `reminder.due` 且携带 item、响过的移出待响列表、`reminder.snooze` 改到 10 分钟后且 `snoozes=1`、`reminder.cancel` + 从列表消失、`reminder.created/snoozed/cancelled` 事件、`state/reminders.json` 落盘（fired/pending 状态正确）、重启后待响提醒还在且重新布防、两次优雅退出。

自动化冒烟覆盖（38 项，真 LLM 手动跑一次）：`config.get` 的 automation 段、`automation.status` 初始为空、`automation.create` 手动任务、`automation.job.created` 事件、真模型手动跑成功（output/usage/sessionId 回写、`run.started/succeeded` 事件）、`automation.runs` 运行记录、interval 任务排期（约 60 分钟）、`pause/resume` 与 `job.updated`、`state/automations.json` 落盘、重启后任务与运行记录保留且重新布防、`delete`、两次优雅退出。

## 刻意没做（等需求逐个说）

口语/发音评测（用户明确不做）、说话人识别、感知、输入、游戏助手、WebUI、插件、多 agent 实例、SQLite 状态、审批门（危险动作确认）、向量检索、图片/音频内容解析（附件只存和给句柄，不做视觉识别）、记忆工具的流式输出……
