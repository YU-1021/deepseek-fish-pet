# DSH → Windows 桌宠 重构蓝图

## 0 材料
已解包至 `C:\deepseek\ref\dsh-src`，共 289 个包。**除 `cordis`（含 `src/*.ts` 真源码）外，全部包只发布编译后的 `lib/index.js`，无 `.ts`、无 `.d.ts`**；未压缩、注释与 `#region <原始路径>` 保留，可精读（部分包把依赖内联）。下文「DSH 代码」指该编译产物，「建议」为我的推断。

## A 分层
| 层 | DSH（实际代码） | 桌宠应重构为 |
|---|---|---|
| 底座 | cordis：`Context` 代理 + `Service`（`cordis/src/service.ts:42` `ctx.reflect.provide`）+ 事件/waterfall | `bus.js` → capability registry（三档钩子） |
| 真相 | dsh-session：header + 递增 seq 事件日志，`surface` = 当前模型可见序列 | append-only `session.jsonl` |
| 循环 | dsh-agent-loop：turn/step 驱动 | 新增 `loop.js` |
| 能力 | tools / skills / subagent / goal 各自注册 Service | `tools.js` 注册表 |
| 策略 | 小插件挂 `tools/*`、`agent/*` 钩子 | `plugins/`：dedup、spill、timeout、prune |
| 壳 | Electron / web | 现有 `main.js` + IPC |

## B 插件化：不抄容器，抄纪律
**不值得抄 cordis**：成本在 DI 反射代理、`isolate()`/`intercept()`（`cordis/src/context.ts:121,139`）与 HMR，只为多产品/多租户成立。桌宠 `src/bus.js`（15 行 EventEmitter，已约定 `session:turn` 等事件）就是轻量版地基。

轻量版（建议，约 120 行）：① `register(kind,name,def)` 两层（全局 + 会话），近者覆盖（照 `ScopedLayers` 语义）；② 返回 `dispose()`，会话结束统一回收；③ 三档钩子 `on()` / `waterfall(name,val,next)` / `guard(fn)` 单调否决（照 `dsh-tools/lib/types/index.js:522,1144`）；④ 不要反射、容器、HMR。

## C 必须抄的 8 条（按性价比）
1. **turn/step + 日志为唯一真相**。DSH：`dsh-agent-loop/lib/index.js` —— `:951` `while(true)`，每步 `step/start`…`step/end`；`:1151,:1017` 停止原因是 union `completed|max-tokens|blocked|aborted|error`；`:711` 注释称 "Every request is derived from the session log"。桌宠：`main.js:1307` 的 `for (let i=0;i<8&&budget>0;i++)` 硬编码 8 步 → `loop.runTurn()/runStep()` 返回 `{kind}`，上限进配置。
2. **回执结构化，禁止把失败叙述灌回对话**。DSH：`dsh-tool-fs/lib/index.js:261` `defineTool({name,parameters,output:{schema,render},execute})`；`dsh-tools/lib/types/index.js:1189` 先按 `output.schema` 校验 value 再 `render` 出 content。桌宠：`main.js:1318/1322/1333` 把 `'[系统] 写入失败…请修正后重试'` push 成 user 消息 → 改 `{ok,value,content,error:{code}}`，只 content 进会话。
3. **重复调用：工具名+规范化参数连续计数，只提醒不阻止**。DSH：`dsh-repeat-tool-reminder/lib/index.js` —— `:1557` key=`[exec.name, canonicalize(args)]`，`:1481` 做深度 key 排序；`:1448` 阈值 `[3,5,8]`，首次温和、其后详细；`:1577` 挂 `tools/post-execute` 且仅**前置 `additionalContexts`**；`:1592` 真用户消息到达即重置；`:1541` 未登记工具「透明」——不计数也不清零。桌宠：`assistant.js:233-256` 的 `NO_PROGRESS_TOOLS` 白名单 + `slice(0,160)` 指纹 + 40 条滑窗换成此算法，白名单改 include/exclude 通配。
4. **大输出 spill 到文件，回执留头尾 + 精确省略量**。DSH：`dsh-spill-policy/lib/index.js` —— `:237` 在 `tools/post-execute`(prepend) 中超 `maxInlineTokens` 就 `ctx.spillStore.saveText(...)`；`:214` `retainContent` 留头尾；`lib/types/notice.js:26` 尾部加 `(Omitted N bytes. Full formatted result stored at: <locator>...)`；`:233` saveText 失败则保留原内容仅 warn。桌宠：`assistant.js:473/534` 的「只显示前 6000 字」→ 写 `userData/spill/<callId>.txt`，回执 = 头 4KB + `[...]` + 尾 1KB + 省略字节数 + 路径。可用 `dsh-output-retention/lib/index.js:139` 的 `TextRetainer`。
5. **剪枝靠追加替代事件，绝不改写历史**。DSH：`dsh-compaction-tool-result-pruner/lib/index.js` —— `:137` 遍历 `session.surface.nodes`，先追加 `compaction/prune`（记 shadowedSeqs 与 token 数），再以 `surfaceOp:{op:'replace',startSeq,endSeq}` + `sourceEventSeqs` 追加替代事件；`:10` 默认 8192/4096/1024。**压缩是"缝"而非引擎**：`dsh-compaction/lib/types/index.js:44` `CompactionEngine extends Service` 只声明"把一段 surface 换成摘要节点"，触发策略/保留策略/摘要实现分属不同包。桌宠：`memory.tokens.clip()` 的就地覆盖 → 改 `surface.js` 投影，剪枝留痕、原日志可回放；先只做"确定性剪枝 + spill"，摘要压缩不进第一版。
6. **超时：工具自带 `timeoutMs`，只通知不抢跑；超长转后台任务**。DSH：`dsh-tool-call-timeout-policy/lib/index.js` —— `:123` 读 `ctx.tools.get(exec.name,exec.agent)?.timeoutMs`；`dsh-timeout/lib/index.js:57` `deadline()` 用 `AbortSignal.any` 融合信号；`:125` **替换 `exec.signal` 后委派**，仅自身定时器赢了才换成结构化 `TOOL_TIMEOUT`，工具 promise 不被抛弃；`dsh-tool-pwsh/lib/index.js:187` pwsh 超时转后台 job。桌宠：按工具声明超时（截图 10s / pwsh 30s / LLM 60s），弃用全局 `Promise.race`。
7. **「改前必读」用事件 + CAS 版本**。DSH：`dsh-fs-observation-policy/lib/index.js` —— `:64` `editIntent` 对未观测目标抛 `FS_NOT_OBSERVED`；`:51` 写意图只有 `createIfAbsent`/`replaceIfVersion`；`:22` 状态是 `WeakMap<session,Map<targetKey,{kind,version}>>`，由 `fs/*-intent` 事件驱动。桌宠：改前查 observed 表，用 mtime+size 当 version，冲突返回明确 code 而非静默覆盖。
8. **格式迁移：相邻迁移链 + 每版本一 codec + 按代换文件名**。DSH：`dsh-session-format/lib/index.js` —— `:96` 迁移必须相邻（`toVersion===fromVersion+1`）；`:124` 编译 0..current 全链，缺边抛错；`:134` 存储版本更新则拒绝并提示升级；`:464` 文件名 `session(.vN).jsonl`；崩尾修复见 `dsh-session-persistence-jsonl/lib/index.js:2894` `truncateTornTail`。桌宠：记忆 JSON 加 `version` 与 `migrations=[v0→v1,…]` 顺序执行，更高版本拒绝加载该文件。

## D 可以放弃的
- cordis 的 DI 反射 / `isolate` / `intercept` / HMR（`context.ts:121,139`）：无多租户需求。
- typert `Remote()` RPC 装饰器（`dsh-repeat-tool-reminder/lib/index.js:95`）：为跨进程 Client 面而生，桌宠 IPC 已够。
- JSONL 的 Zstd 分帧、跨进程写锁、Windows durable publish（`dsh-session-persistence-jsonl/lib/index.js:442,535`）：`writeFile+rename` 足够。
- `dsh-compaction-basic`（49KB 的 LLM 摘要 + thresholdRatio/retainRatio）：先做确定性剪枝 + spill，摘要最后再谈。
- 图片卸载那一套（`dsh-compaction-image-offload/lib/index.js:141` 在 `agent/request-error` 收到 `IMAGE_OFFLOAD_REQUIRED` 时追加 `image/offload` 选中最早图片再 `{kind:'retry'}`，投影时标 `offloaded:true`，见 `lib/types/project-message.js:55`）：思路值得留作"降级重试"范式，桌宠图片少，第一版不必实现。
- 子 agent 深度配额、agent preset 注册表、PTC `sdkSection`（`dsh-tools/lib/types/index.js:279`）：单角色无需 per-scope 工具可见性；图片 token 计价器同理，按字节预算即可。

## E 迁移路径
- **P0 只加不删**：新增 `loop.js`，`bus.js` 升三档钩子，`main.js:1307` 改调 `loop.runTurn()`。验：现有任务跑通，日志出现 turn/step。
- **P1 会话日志**：对话存储改 append-only JSONL（header + seq），读时投影，加 version 与 v0→v1 迁移。验：kill 进程后重启能恢复；旧数据经迁移读入。
- **P2 工具层**：`tools.js` 注册表 + `defineTool` 风格（parameters / output.schema / render），先迁 3 个工具。验：非法参数返回 schema 违规而非崩溃。
- **P3 策略插件**：C3 + C4 + C5。验：喂重复调用序列，第 3、5 次各注一条提醒；10MB 输出只剩头尾 + 路径。
- **P4 超时与作业**：C6。验：注入 hang 工具，30s 收到 `TOOL_TIMEOUT` 回执且界面不卡。
- **P5 目标续跑（可选）**：抄 `dsh-goal-round-driver/lib/index.js` 的 `:11` `<goal_round>` 提示、`:125` `maxGoalRounds` 超限 block、`:277` revision 围栏；阻塞需连续 3 轮同一条件。
