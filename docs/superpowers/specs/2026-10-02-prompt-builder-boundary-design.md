# Prompt Builder 边界提取设计

日期：2026-10-02

## 1. 背景与目标

大肥鱼桌宠的产品主线是长期陪伴、聊天和英语口语练习。电脑助手属于高级能力，必须保持默认关闭、安全可控，并且不能把桌宠改造成普通聊天软件。

当前 `app/main.js` 同时承担窗口管理、IPC、对话编排和两套系统提示词构建。`buildSystemPrompt()` 混合固定角色规则、输出协议、人格状态、记忆、生词、技能目录、项目说明和工具说明；`buildContinuePrompt()` 又维护一份重复的工具清单。这个结构使提示词缓存优化、权限策略重构和工具按需披露都难以独立测试。

本阶段只提取 `prompt-builder` 边界，保持现有提示词文本、顺序、权限语义和运行行为不变。它是后续重排稳定层、统一工具目录、重构 Agent 循环与权限策略的安全落脚点。

## 2. 成功标准

- `buildSystemPrompt(cfg)` 与 `buildContinuePrompt(cfg)` 不再定义在 `main.js`。
- 新模块可以用纯依赖注入构造，不要求测试启动完整 Electron 应用。
- 对同一组依赖和配置，新旧实现产生逐字符相同的提示词。
- `off/read/normal/web/full` 五个权限档继续展示与当前实现相同的提示词能力。
- 生词、记忆、人格语气、隐藏数值行为描述、技能目录、项目说明和用户覆盖规则继续按当前顺序出现。
- `main.js` 的现有导出保持兼容，已有诊断脚本不因模块移动失效。
- 不修改用户数据结构，不触发迁移，不新增运行时依赖。

## 3. 非目标

本阶段不做以下改变：

- 不重排提示词的稳定层与动态层。
- 不从能力注册表自动生成工具说明。
- 不改变任何工具权限、确认方式或自动执行行为。
- 不重构 `assistant.js`、视觉定位、键盘鼠标控制或多步任务循环。
- 不调整桌宠状态机、窗口管理、UI 层级或首次启动流程。
- 不删除旧功能、旧导出或用户的 `prompts/override.md`。

这些事项分别进入后续独立规格，避免把行为变化混入边界提取。

## 4. 方案

新增 `app/src/prompt-builder.js`，导出工厂：

```js
function createPromptBuilder(deps) {
  return {
    buildSystemPrompt(cfg),
    buildContinuePrompt(cfg),
  };
}
```

工厂只负责组装字符串，不直接获取 Electron 全局对象，也不直接 `require` 业务模块。`main.js` 在进程启动时注入现有能力：

- `loadPersona()`
- `loadMood()`
- `getTone(persona)`
- `getBehaviorSpec()`
- `buildMemoryContext()`
- `getPracticeWords(limit)`
- `getSkillCatalog()`
- `isToolAllowed(tier, tool)`
- `readPromptOverride()`
- `log(message)`

词汇等级映射作为模块内部稳定常量保存。用户覆盖文件的路径解析和读取仍由主进程适配器负责，使纯模块不知道 `%APPDATA%`、Electron `app` 或文件系统位置。

## 5. 组件职责

### `src/prompt-builder.js`

- 组装首轮系统提示词。
- 组装多步任务续跑提示词。
- 生成现有的人格、生词、技能、项目和工具段落。
- 对可选依赖的异常保持现有降级行为：语气、生词或覆盖文件读取失败时省略对应段落，而不是阻断对话。
- 记忆、隐藏状态和技能目录继续视为必需数据；它们异常时保持现有的错误暴露方式，不在本阶段偷偷改变故障语义。
- 不读取或写入任何持久化数据。

### `main.js`

- 保留业务模块和 Electron 能力的所有权。
- 创建 prompt builder 实例并注入适配器。
- 继续导出 `buildSystemPrompt`、`buildContinuePrompt`，保持测试脚本和外部调用兼容。
- 继续负责 `genReply()`、IPC 和窗口生命周期。

### 测试与诊断脚本

- `scripts/test-prompt-builder.js` 使用固定依赖夹具直接测试新模块。
- `scripts/probe-prompt.js` 通过正式模块接口获取提示词，不再依赖函数位于 `main.js`。
- `scripts/measure-tokens.js` 删除从源码字符串截取函数并用 `new Function` 执行的逻辑，改用同一工厂和显式依赖。

## 6. 数据流

首轮对话：

```text
chat:send
  -> config.load()
  -> promptBuilder.buildSystemPrompt(cfg)
  -> 注入的人设/状态/记忆/生词/技能/权限适配器
  -> llm.stream() 或 llm.request()
```

多步续跑：

```text
chat:continue
  -> config.load()
  -> promptBuilder.buildContinuePrompt(cfg)
  -> memory.pickHistory()
  -> llm.stream() 或 llm.request()
```

本阶段不改变消息角色、历史裁剪、工具结果回灌或渲染进程任务循环。

## 7. 兼容与错误处理

- 所有既有默认文案、标签、换行和章节顺序都视为兼容合同。
- 语气、生词和覆盖文件沿用当前的 fail-soft 行为；对应段落构建失败不能导致聊天整体失败。
- 记忆、隐藏状态和技能目录异常继续向调用方抛出，留待后续可靠性阶段单独设计降级策略。
- 必需依赖在创建工厂时校验。缺失时抛出带依赖名称的错误，使启动和测试能直接定位配置问题。
- `readPromptOverride()` 返回空字符串表示没有覆盖；读取失败由适配器记录并返回空字符串。
- 不缓存动态段落，避免心情、记忆、生词或人格更新后提示词仍使用旧值。

## 8. 测试策略

遵循测试先行：先添加导入新模块的失败测试，确认因模块不存在而失败，再实现最小工厂。

确定性合同测试覆盖：

- 固定角色设定、口头禅、隐藏设定与输出协议存在。
- 人格语气、关系状态、隐藏行为、记忆、生词按当前顺序出现。
- `off` 不包含电脑操作、技能和项目段。
- `read/normal/web/full` 的能力段与当前行为一致。
- 技能目录为空时不生成技能段。
- 无练习词时不生成生词段。
- 用户覆盖规则仍位于提示词最后。
- 续跑提示词保持短人设、工具段和输出格式。
- 可选依赖抛错时只省略对应段落。

回归验证至少运行：

- `node scripts/test-prompt-builder.js`
- `node scripts/test-parsereply.js`
- Electron 运行 `scripts/test-context.js`
- Electron 运行 `scripts/test-vocab.js`
- Electron 运行 `scripts/probe-prompt.js`
- Electron 运行 `scripts/measure-tokens.js`，确认五档提示词均可构建且 token 统计无异常。

## 9. 后续架构接口

AI 助手重构另立规格，顺序建议为：

1. `permission-policy`：从工具能力档中分离风险级别、二次确认和结构化审计。
2. `agent-loop`：把 `renderer/chat.js` 的递归任务循环移到主进程，以显式 turn/step 和停止原因驱动。
3. `vision-grounding`：视觉模型只产出目标描述或候选区域，由 OCR、模板匹配、画面差分等确定性能力验证后才能生成可执行目标。
4. `input-controller`：统一鼠标键盘动作、主人接管检测、执行前聚焦检查、执行后画面验证和失败回滚策略。
5. `prompt-builder` 再演进为稳定角色层、输出协议层、动态状态层、按需技能层和当前权限层，并从能力注册表生成可见工具说明。

本阶段的依赖注入接口保证上述模块可以替换权限判断和工具目录来源，而无需再次把提示词逻辑搬回 `main.js`。

## 10. 文件范围

新增：

- `app/src/prompt-builder.js`
- `app/scripts/test-prompt-builder.js`

修改：

- `app/main.js`
- `app/scripts/probe-prompt.js`
- `app/scripts/measure-tokens.js`
- `模块说明.md`（只更新模块边界和规模说明）

不修改渲染层、用户数据文件、权限配置和工具执行实现。
