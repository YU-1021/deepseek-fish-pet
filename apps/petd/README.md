# petd — 桌宠常驻网关（阶段 1 骨架）

这是重构后的新进程骨架：**只跑框架，不含业务功能**。功能按需求逐个接入方法注册表。

## 现在有什么

- `packages/protocol`：pet-ui ⇄ petd 的 WS 协议（TypeBox schema + 校验 + 错误码）
- `apps/petd`：常驻网关
  - 握手：token 鉴权、协议版本校验、首帧顺序约束
  - 请求：`domain.action` 方法注册表、参数 schema 校验、超时（AbortSignal）、幂等缓存
  - 事件：`event` 帧广播，`seq` 全局单调
  - 方法：`health.ping` / `health.status` / `config.get`
  - 落盘：`config.json`（默认自动创建）、`token.json`（0600）、`gateway.json`（运行中端口的地址文件，退出删除）、`petd.log`（JSONL + 轮转）
  - 退出：SIGINT/SIGTERM/ipc `{type:'shutdown'}` 优雅关闭

## 跑起来

```bat
pnpm install
pnpm -r build

:: 前台起（--echo 日志同时打到 stdout）
node apps/petd/dist/index.js --home %TEMP%\petd-dev --echo

:: 另开一个终端跑冒烟（起进程→握手→调方法→优雅退出）
node apps/petd/scripts/smoke.mjs
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
  if (f.type === 'hello') ws.send(JSON.stringify({ type: 'req', id: '1', method: 'health.ping' }));
  else console.log(f);
});
```

## 测试

```bat
cd packages/protocol && node --test "dist/**/*.test.js"   :: 10/10
cd apps/petd && node --test "dist/**/*.test.js"          :: 12/12（真 WS、真超时、真幂等）
cd apps/petd && node scripts/smoke.mjs                   :: 端到端冒烟
```

## 刻意没做（等需求逐个说）

会话/消息、记忆、人格、语音、感知、输入、游戏助手、WebUI、插件、cron、SQLite 状态……
阶段 1 的验收就是：进程能起、能连、能调方法、能优雅退出；其余按蓝图阶段 2 起逐个加。
