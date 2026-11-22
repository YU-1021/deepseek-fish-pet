# 插件与 DSH 委派（桌宠的「能力从哪来」）

这是 petd/pet-ui 重构时定下的能力模型，对应一句话：

> 桌宠想要什么功能，她自己可以自己做；但如果是编程类的，就要到 DSH 上让 DSH 做；做出来的东西一般变成 skill 或者插件，当然也可以做基础功能；游戏助手就做成插件类的，叫 Aknight.gmaer。

## 1. 四条路，按顺序选

| 顺序 | 场景 | 走哪条路 | 落盘在哪 | 谁来批准 |
|---|---|---|---|---|
| 1 | 只是「记住/提醒/查一下/按步骤做事」 | **记忆 + 技能**（SKILL.md） | `workspace/`、`skills/` | 写记忆要过审批门；技能要人批准或人自己写 |
| 2 | 要用电脑（点、看屏、打字） | **CUA 工具**（截图/窗口/键鼠） | 不落盘 | 权限门 + `cua.selfProtect` |
| 3 | 要写代码/改项目/跑命令 | **DSH 桥**：聊天工具 `ask_dsh` | DSH 自己的会话与 `dsh-workspace/` | DSH 的审批（桥默认 `reject`，可切 `ask`） |
| 4 | 要长期多一个能力 | **插件**（`plugins/<id>/`：prompt.md + skills/） | `home/plugins/` | 人手动拷入/启停；AI 只能提案 |

原则：**AI 自己不能给自己加新代码、也不能自己批准新能力**。想做新能力时，它只能：

1. 写学习提案（`learning.propose`，`kind=skill|prompt|params|preference`）——人批准后才进提示词或转成技能；
2. 或者把「要写代码」的活交给 DSH（`ask_dsh`），DSH 做完把结果带回来，产物再由人决定要不要固化成技能/插件。

## 2. 插件格式（声明式，不执行 JS）

```text
home/plugins/<id>/
  plugin.json     # 必填：name / version / description；可选：author
  prompt.md       # 可选：额外系统提示词（≤2000 字，拼在人格之后）
  skills/
    <skill-dir>/SKILL.md   # 每个子目录一个技能（frontmatter name/description/keywords/always + 正文）
```

- 插件 id 与技能目录名都必须是 **ASCII 安全名** `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`；中文标题写在 SKILL.md 的 `name:` 和正文里。
  - 例：`Aknight.gmaer` 的插件 id 是 `aknight-gmaer`（点号不允许），技能目录 `look-screen`，frontmatter `name: 看游戏界面`。
- 插件技能在技能清单里的键是 `pluginId/目录名`（如 `aknight-gmaer/look-screen`），只读：`skill.update/delete` 会返回 `E_FORBIDDEN`。
- 启停：`plugin.enable/disable`，状态存 `home/state/plugins.json`；停用后技能与提示词立即不可见（`extraRoots` 每次扫描现取）。
- 插件是「可整体拷进/拷出的只读资产」；不做在线插件商店，也不执行任意代码。

## 3. Aknight.gmaer（内置游戏助手模板）

仓库位置：`apps/petd/assets/plugins/aknight-gmaer/`；安装 = 整个目录拷到 `home/plugins/aknight-gmaer/`。

- `plugin.json`：`id=aknight-gmaer`、`name=Aknight.gmaer`、`0.1.0`。
- `prompt.md`：明日方舟陪玩的行为约定与红线——花理智/源石/合成玉前必须主人同意、不点充值、先看屏再动手、一步一动作、不确定就问。
- 5 个技能（目录名 ASCII，标题中文）：
  - `look-screen` 看游戏界面：只读屏，不点击；说明如何从截图判断当前在哪一屏。
  - `enter-stage` 进关卡：主界面→作战→选关→开始行动的步骤与确认点。
  - `deploy` 布阵与技能：放干员、朝向、开技能、撤退的节奏。
  - `afk-farm` 挂机刷图：理智消耗前确认、重复刷、异常（失败/网络）停下问人。
  - `operators` 干员资料：查 `game/operators.json`（463 个干员的职业/稀有度/技能/别名；由 `预习助手` 的 MAA 数据生成，已拷进工作区）。
- 与「预习助手」（`C:\deepseek\预习助手`）的关系：那套 MAA 截图/识别/点击是独立项目；游戏助手插件只负责「知道怎么陪玩 + 查干员」，真正的看屏/点击优先走 petd 的 CUA 工具。

## 4. DSH 委派（`ask_dsh`）

- 聊天工具 `ask_dsh {task, timeout_ms}`：把「写代码/改代码/查项目/跑命令」这类任务交给 DSH 的私有 SDK runtime，等这一回合结束拿最终文字。
- 会花 token，计入写配额（一轮最多 3 次）；`config.dsh.enabled=false` 时工具不出现。
- 实现：`apps/petd/src/dsh/*` + `src/gateway/methods/dsh.ts`；细节见 `docs/dsh-bridge.md`。
- 安全：桥的审批默认 `reject`；要问人时 `config.dsh.approvalPolicy='ask'`，前端弹审批气泡。

## 5. 边界（写进测试与文档的硬约定）

- AI 写盘只允许 `workspace/**` 与带 `.agent.*` 后缀的动态文件；代码/配置/密钥/正式技能永远拒绝（`kernel/agent-files.ts`）。
- 学习提案只能写候选目录；批准/回滚只有人能调（`learning.*`），且全程进 `state/agent-audit.jsonl`。
- CUA 自我保护：前台是 petd/pet-ui/终端，或输入里有密钥/配置关键词时，每次操作都要人确认，不缓存。
- 游戏红线：不花游戏资源、不点充值、失败就停、不确定就问人。
