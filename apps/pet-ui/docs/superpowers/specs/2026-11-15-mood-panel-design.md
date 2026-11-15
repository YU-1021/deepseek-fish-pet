# M7 情绪与状态面板设计

## 意图

让用户看见桌宠当前的心情、好感和精力，并通过戳一戳与对话评估自然互动。状态来自 petd，UI 不复制计算规则；普通体验默认不暴露精确数值。

## 目标与边界

- 设置页展示状态档位、最近变化、评估按钮和只读 mood 配置。
- 宠物窗显示状态表情、三枚状态环；戳宠物调用 `mood.poke` 并播放 200–400ms 轻反馈。
- 连接后读取 `mood.status`，监听 `mood.changed`；重连时重新读取，不轮询。
- 仅调试开关显示数值；开关保存在 pet-ui 本地。
- 不在 UI 侧推算聊天后的情绪；不把低数值表现成警告或惩罚。
- 不改 petd、protocol、根配置；真联调最多调用一次 `chat.send` 和一次 `mood.evaluate`。

## 方案

1. **只做设置页状态面板**：简单，但宠物窗无法即时表现心情。
2. **设置页面板 + 宠物窗圆环和表情（选用）**：状态信息和轻量表现各在合适位置；两个 renderer 各自按连接状态获取快照，事件订阅保持局部。
3. **托盘子菜单 + 设置页 + 宠物窗**：入口更多，但需增加 main/preload IPC 与跨窗口控制，当前规格没有要求托盘调整状态。

选择方案 2。设置页负责详情和控制，宠物窗只负责非数字化的轻反馈。

## 协议和交互

- 使用 `mood.status {}`、`mood.history {limit: 8}`、`mood.poke {}`、`mood.evaluate {sessionId?}` 与 `mood.changed`。
- `state.tiers` 的中文原样展示。心情档位映射表情/轻语气，好感档位映射称呼，精力低时用安静提示；数值环按 0–100 填充。
- `config.get.mood` 的 `enabled/chatInjection/chatNudge/moodDecayPerHour/energyRecoverPerHour` 只读展示。
- `E_INTERNAL` 评估错误显示「这次没想明白，等会儿再试」；`E_UNAVAILABLE` 复用全局中文错误提示。

## 验收

- mock 覆盖五个 mood 方法与 `mood.changed`，组件测试验证档位、隐藏数字、poke 反馈、评估 loading/error/结果提示及关闭状态。
- 构建与测试通过；独立 home 真连 petd，最多一轮聊天和一次评估；截图及联调记录写入 README。
