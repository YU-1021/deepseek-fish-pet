# petd — 桌宠常驻网关（阶段 1 骨架 + 聊天 + 人格自编辑）

这是重构后的新进程骨架：**只跑框架，功能按需求逐个接入注册表**。当前已有：协议、网关、聊天（会话/消息/人格/LLM）、人格自编辑（SOUL.md 按小节改 + 版本/锁/历史/回滚 + AI 自演化）。

## 现在有什么

- `packages/protocol`：pet-ui ⇄ petd 的 WS 协议（TypeBox schema + 校验 + 错误码）
- `apps/petd`：常驻网关
  - 握手：token 鉴权、协议版本校验、首帧顺序约束
  - 请求：`domain.action` 方法注册表、参数 schema 校验、超时（AbortSignal）、幂等缓存
  - 事件：`event` 帧广播，`seq` 全局单调
  - 方法：
    - 健康/配置：`health.ping` / `health.status` / `config.get`
    - 会话：`session.create` / `session.list` / `session.get` / `session.rename` / `session.delete`
    - 聊天：`chat.send`（自动建会话、带人格与历史、持久化、广播 `chat.*` 事件）
    - 人格：`persona.get` / `persona.patch` / `persona.lock` / `persona.history` / `persona.rollback` / `persona.evolve`
  - 落盘：`config.json`、`secrets.json`（0600，只存密钥）、`SOUL.md`（人格主文件）、`persona-state.json`（版本/锁/历史）、`sessions/<id>.jsonl` + `sessions/index.json`、`token.json`（0600）、`gateway.json`（运行中端口，退出删除）、`petd.log`（JSONL + 轮转）
  - 退出：SIGINT/SIGTERM/ipc `{type:'shutdown'}` 优雅关闭

## 首次启动会做什么

1. `config.json` 不存在则按默认生成（gateway/log/llm/chat 四段）
2. 若 `%APPDATA%/dayu-pet/config.json` 存在：把 `apiBase`/`model` 补进配置、把 `apiKey` 迁进 `secrets.json`（只读旧目录，不打印密钥）
3. 若旧 `persona.json` 存在：播种 `SOUL.md`（没有则用内置默认人格），同时建 `persona-state.json`（v1 历史可回滚）
4. 没配 Key 也能起，但聊天会返回 `E_LLM_AUTH`，提示去写 `secrets.json` 或设 `PETD_LLM_API_KEY`

## 配置（config.json）

```json
{
  "llm": { "apiBase": "https://api.deepseek.com/v1", "model": "deepseek-flash", "timeoutMs": 90000, "temperature": 0.7, "maxTokens": 2048, "thinkingDisabled": true },
  "chat": { "systemPromptFile": "SOUL.md", "maxHistoryMessages": 40, "maxHistoryChars": 24000 }
}
```

- `thinkingDisabled`：V4.1-Flash 默认开思考会拖慢首字且按输出价计费，默认显式关掉。
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
cd apps/petd && node --test "dist/**/*.test.js"          :: 58/58（网关/聊天/人格 store+evolve+方法）
cd apps/petd && node scripts/smoke.mjs                   :: 网关端到端冒烟
cd apps/petd && node scripts/chat-smoke.mjs --home D:\x  :: 聊天端到端（真 LLM，保留 home 便于检查 SOUL.md/sessions）
cd apps/petd && node scripts/persona-smoke.mjs --home D:\x :: 人格端到端（真 LLM 一次 evolve，保留 home 便于检查 SOUL.md/persona-state.json）
```

聊天冒烟覆盖：迁移与播种、握手、`chat.send` 真实回复、会话 JSONL 落盘、`chat.*` 事件、第二轮带历史、`session.get/rename/list/delete`、优雅退出。

人格冒烟覆盖：SOUL/state 播种（v1 可回滚）、`persona.get`、用户 patch + 事件、`expectedVersion` 冲突、上锁/世界观拒锁、历史、真 LLM `persona.evolve`（会改）+ `persona.changed(agent)`、回滚到 v2、解锁、优雅退出。

## 刻意没做（等需求逐个说）

记忆、语音/ASR/TTS、口语/发音评测（用户明确不做）、感知、输入、游戏助手、WebUI、插件、cron、SQLite 状态、审批门（危险动作确认）……
