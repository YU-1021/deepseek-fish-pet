# 大肥鱼动作执行网关设计

## 背景与目标

当前 AI 助手的权限判断、窗口让位、用户输入让位和工具执行集中在 `main.js` 的 `assistant:run` IPC 中；`renderer/chat.js` 又根据 `assistant === 'full'` 自行决定是否自动执行。视觉提示词已经禁止猜坐标，视觉工具也会过滤裸坐标点击，但文本模型仍能直接产生 `click|x,y`，运行时无法证明这个坐标来自 OCR、模板匹配或 UI Automation。

本阶段增加一个主进程动作执行网关，使安全规则由代码强制执行，而不是只依赖提示词：

1. 所有助手工具统一经过权限决策、目标凭证校验、确认、执行和审计。
2. 裸坐标点击不能仅凭模型输出自动执行。
3. 删除、覆盖、运行文件以及可能产生外部副作用的网页操作始终需要用户确认。
4. 用户移动鼠标时自动化立即让位，并使旧目标凭证失效。
5. 保持现有工具实现、人格、记忆、语音、游戏助手和用户数据兼容。

## 非目标

- 本阶段不重写 `assistant.js` 中的具体工具实现。
- 不同时拆分窗口管理、记忆、语音或完整 Agent Loop。
- 不尝试用视觉模型判断付款、发布或登录页面的语义。
- 不引入 cordis、第三方权限框架或数据库。
- 不把审计日志展示成新的主界面；高级设置入口后续再做。

## 方案选择

### 方案 A：只增加一张权限分类表

改动最少，但无法证明点击坐标来源，`full` 权限仍可能把模型幻觉直接变成鼠标操作，因此不采用。

### 方案 B：主进程执行网关（采用）

保留现有工具，通过纯策略模块、一次性目标凭证、一次性批准令牌和独立审计器包住执行入口。它能在不重写工具实现的前提下建立可测试的安全边界。

### 方案 C：重写工具协议为完整能力令牌系统

安全上限最高，但会同时改变模型协议、视觉工具、渲染循环、游戏助手和全部测试，超出单阶段可控范围，因此暂缓。

## 架构

### `src/permission-policy.js`

纯 JavaScript 模块，不依赖 Electron、文件系统或全局状态。

接口：

```js
classifyAction({ tier, tool, arg, facts })
// -> { decision: 'allow' | 'confirm' | 'deny', reason, risk, requirements }
```

`facts` 由网关提供，只包含已经验证的事实，例如：

- `toolAllowed`：现有 `assistant.allowed()` 的结果。
- `destinationExists`：写入目标是否已存在。
- `hasTargetGrant`：坐标动作是否匹配有效目标凭证。
- `focusVerified`：键盘输入前台窗口是否仍为已确认目标。
- `userActive`：主人当前是否正在操作鼠标。

策略优先级从高到低：

1. 工具不存在或权限档不足：`deny`。
2. 删除类工具：`confirm`。
3. 任意路径写入且目标已存在：`confirm`。
4. 执行本地文件：`confirm`。
5. `web_click`、`web_type`：`confirm`。本阶段保守处理登录、发送、付款和发布，避免用脆弱的关键词猜测页面语义。
6. 点击、双击、右键和拖拽：有匹配的目标凭证才 `allow`，否则 `confirm`；用户拒绝时不得降级为猜坐标。
7. `type`、`key`：必须同时具备 full 权限和已验证前台焦点，否则 `deny`。
8. 只读、截图、定位、状态查询：在现有权限档允许时 `allow`。
9. 其他普通本地变更继续遵守现有 tier；`full` 不再覆盖上述强制确认规则。

### `src/action-authority.js`

状态模块，负责两类短期能力：

#### 目标凭证

OCR、模板匹配或 UIA 成功后，由主进程登记：

```js
issueTarget({ x, y, source, label, userEpoch, issuedAt })
matchAndConsume({ tool, arg, userEpoch, now })
```

规则：

- 只接受 `find_text`、`find_template`、`find_template_scroll`、`uia_find` 产生的目标。
- 凭证绑定精确截图坐标；点击允许最多 2 像素的整数取整误差。
- 拖拽必须分别验证起点和终点；没有两个凭证时必须确认。
- 凭证 120 秒过期，只能使用一次。
- `userEpoch` 变化表示主人接管过鼠标，全部旧凭证立即失效。
- 任意成功的屏幕变更动作后清空其他旧凭证，防止界面变化后复用坐标。

#### 批准令牌

渲染层显示确认条，只有用户点击“允许”后才调用 `assistant:approve`：

```js
issueApproval({ tool, arg, reason })
consumeApproval({ token, tool, arg, now })
```

令牌使用加密随机数，绑定规范化后的 `tool + arg`，两分钟过期且只能使用一次。令牌不写入日志。

### `src/action-audit.js`

写入 `%APPDATA%/dayu-pet/assistant-audit.v1.jsonl`，每行一个版本化事件：

```json
{
  "version": 1,
  "id": "...",
  "time": 0,
  "phase": "decision|approved|started|finished|failed|denied",
  "tool": "click",
  "tier": "full",
  "risk": "screen-input",
  "decision": "allow",
  "reason": "verified-target",
  "targetSource": "uia_find",
  "durationMs": 12,
  "ok": true
}
```

约束：

- 不记录 API Key、密码、令牌、完整输入文本或文件正文。
- `type`、`web_type`、写文件内容只记录长度和不可逆摘要。
- 路径保留规范化路径，参数最多记录安全摘要。
- 单文件达到 10 MiB 后轮转为 `.1`；审计失败不能放宽权限，也不能令应用崩溃。

### `src/action-executor.js`

主进程网关，依赖注入现有 `assistant.run`、权限判断、用户输入监测、窗口让位和审计器：

```js
createActionExecutor(deps)
executor.inspect(action, context)
executor.approve(action, context)
executor.execute(action, context)
executor.recordTarget(toolResult, context)
```

`main.js` 只负责把 Electron 窗口操作适配给网关。工具执行的顺序固定为：

1. 规范化并校验动作结构。
2. 读取权限和运行时事实。
3. 执行纯策略决策并写 `decision` 审计。
4. `deny` 立即返回明确原因。
5. `confirm` 要求匹配的一次性批准令牌。
6. 等待主人停止操作；若等待超时则拒绝执行，而不是抢夺输入。
7. 执行窗口让位和现有 `assistant.run`。
8. 登记定位工具返回的目标凭证。
9. 写成功或失败审计，并把原有工具结果格式返回给渲染层。

## IPC 与渲染流程

新增受控 IPC：

- `assistant:inspect(action)`：返回 `{ decision, reason, risk }`，不执行。
- `assistant:approve(action)`：用户点击确认按钮后签发一次性批准令牌。
- `assistant:run({ action, approvalToken })`：统一执行入口。

`preload.js` 仅暴露对应方法，不暴露 Node API。

`renderer/chat.js` 的 `renderAction` 改为先调用 `assistantInspect`：

- `allow`：自动进入现有任务循环。
- `confirm`：显示明确的工具、目标和原因；用户点击允许后取得令牌并执行。
- `deny`：显示拒绝原因并把结果交回 Agent Loop，模型可以换安全路径。

因此 `assistant === 'full'` 只表示允许使用屏幕和输入能力，不再代表跳过所有确认。

## 定位工具结果

`assistant.js` 中四类定位工具在保留现有 `text` 文案的同时增加结构化字段：

```js
{
  text: "...",
  target: { x, y, source: "find_text", label: "设置" }
}
```

主进程保存 `target`，但只把必要的非敏感字段返回渲染层。旧调用者仍可继续使用 `text`，实现向后兼容。

## 用户接管

`userinput.js` 增加单调递增的 `userEpoch`：每次检测到非桌宠产生的鼠标移动时递增。网关在目标凭证签发和使用时比较 epoch。

动作等待超过 30 秒仍检测到主人活跃时返回明确的“主人正在操作，已取消本次自动化”，不继续执行。这个结果进入 Agent Loop 和审计日志。

## 数据与迁移

- 不修改现有配置文件结构，不需要迁移用户配置。
- 新审计文件使用文件名和行内 `version: 1` 双重版本标识。
- 审计文件缺失时自动创建；坏行按单行跳过，不影响其余记录。
- 原有 `testlog.jsonl` 保留，用于性能和模块诊断；新的审计文件只记录安全相关动作生命周期。

## 测试策略

### 纯 Node 测试

1. 权限矩阵：off/read/normal/web/full 对每类工具的 allow/confirm/deny。
2. 强制确认：删除、覆盖、运行文件、网页点击和网页输入在 full 下仍为 confirm。
3. 目标凭证：精确匹配、误差边界、坐标不匹配、过期、重复使用和 userEpoch 变化。
4. 批准令牌：动作绑定、过期、一次性消费和错误令牌。
5. 审计打码：密码、API Key、输入正文和批准令牌不得落盘。
6. 执行器：deny 不调用工具；confirm 无令牌不调用；allow 只调用一次；等待超时不执行。

### Electron 集成测试

1. `contextIsolation: true`、`nodeIntegration: false` 不变。
2. locator → click 的一次性凭证闭环。
3. 未验证裸坐标在 full 权限下仍显示确认，不自动点击。
4. 用户移动鼠标后旧凭证失效。
5. 用户批准后动作只执行一次，重放同一令牌失败。

### 回归测试

继续运行提示词、回复解析、Agent Loop、生词闭环、键鼠安全和真实输入目标测试。游戏助手暂时继续使用自己的安全循环；接入统一网关作为后续独立阶段。

## 兼容与发布

- 第一提交只加入纯策略、凭证和审计模块及其测试，不接生产入口。
- 第二提交接入主进程 IPC 和 preload。
- 第三提交修改渲染确认流程和定位工具结构化返回。
- 每个提交均保持现有测试通过，可单独回滚。
- 本阶段继续追加到 `refactor/assistant-core` 分支和 PR #3，不合并 `main`。

