# 明日方舟 · 战斗作业(Copilot)速查

> 用途：桌宠负责**选关卡、按主人 box 挑干员**；真正的战斗执行交给 MAA 的作业执行器。
> 规范来源：MAA《战斗流程协议》https://docs.maa.plus/zh-cn/protocol/copilot-schema.html
> 作业站（社区作业）：PRTS plus https://prts.plus/
> 站位坐标查询：https://map.ark-nights.com/areas —— ★在设置里把「坐标展示」选成 **MAA**★，看到的才是 MAA 用的格子坐标。

## 一、最小可用结构

```json
{
  "stage_name": "暴君",
  "opers": [ { "name": "重岳", "skill": 3, "skill_usage": 2, "skill_times": 5 } ],
  "actions": [
    { "type": "部署", "name": "重岳", "location": [5, 5], "direction": "左" },
    { "type": "技能", "name": "重岳" },
    { "type": "二倍速" }
  ],
  "minimum_required": "v6.7.0"
}
```

只有三个字段是必选的：`stage_name`、`actions`、`minimum_required`。

## 二、字段速查

### stage_name（必选）
关卡名。中文名 / code / stageId / levelId 都行，**只要能唯一确定即可**。

### opers / groups（选干员）
- `opers` = **指定干员**：直接点名，`requirements` 写练度要求（自动编队时校验）。
- `groups` = **任选其一**：给一组候选（比如「任意正常群奶」= 夜莺 / 白面鸮），
  ★**干员无序、会优先选练度高的**★ —— **主人 box 不同就用这个字段适配**。

单个干员可填：

| 字段 | 说明 |
|---|---|
| `name` | 干员名（必填） |
| `role` | 职业，英文名，用于区分同名干员（可选） |
| `skill` | 技能序号 0~3（可选，默认 0） |
| `skill_usage` | 0 不自动用（靠 actions 指定）／1 好了就用／2 用 X 次（配 `skill_times`）／3 自动判断 |
| `skill_times` | 用几次（`skill_usage:2` 时用） |
| `requirements` | `elite` 精英化 / `level` 等级 / `skill_level` 技能等级 / `module` 模组编号（0=不用，1~5=χ/γ/α/Δ/β） |

### actions（必选，有序）
**前一个执行完才执行下一个。**

`type` 可选值：
`部署`(Deploy) · `技能`(Skill) · `撤退`(Retreat) · `二倍速`(SpeedUp) · `子弹时间`(BulletTime) ·
`技能用法`(SkillUsage) · `打印`(Output) · `摆完挂机`(SkillDaemon) · `移动镜头`(MoveCamera) ·
`重置全局计时器`(ResetStopwatch) · `点击`(Click) · `滑动`(Swipe) · `设置单位坐标`(SetUnitLocation)

中英文都行，但**作业站发布只认英文**。

常用的三个：

| type | 必填 | 说明 |
|---|---|---|
| `部署` | `name` + `location` + `direction` | 费用不够会一直等（除非 timeout） |
| `技能` | `name` 或 `location` | 技能没转好会一直等 |
| `撤退` | `name` 或 `location` | — |

`direction`：`左/右/上/下/无`（Left/Right/Up/Down/None）。
`location`：战场格子 `[x, y]`，**用 map.ark-nights.com 的 MAA 坐标**。

### 等待条件（五个是"且"的关系）
| 字段 | 含义 |
|---|---|
| `kills` | 击杀数达到才执行 |
| `costs` | 费用达到才执行（★仅两位数时识别准★，三位数可能错） |
| `cost_changes` | 从本 action 开始算的费用变化量（支持负数） |
| `cooling` | CD 中的干员数量（默认 -1 不识别） |
| `elapsed_time` | 全局计时（毫秒；**用前必须先有 `重置全局计时器`**） |

### 其它
`pre_delay` / `post_delay`：前置/后置延时（毫秒）。`timeout`：`技能` 动作的等待上限（0=只检查一次）。
`doc` / `doc_color`：界面上显示的说明文字（无实际作用，可当字幕）。
`minimum_required`：≥ `v6.7.0`。
`difficulty`：0 未设置 / 1 普通 / 2 突袭 / 3 都支持。

## 三、推荐的落地流程（桌宠视角）

1. **确定关卡** —— 主人说刷哪关，或按需求挑。
2. **找一份该关的现成作业**（PRTS plus）—— ★不要从零编时间轴★，那是社区积累出来的。
3. **按主人 box 适配** —— 把作业里的干员换成 `groups`（任选其一，优先高练度），
   或保留 `opers` 并确认 `requirements` 主人满足。
4. **校验** —— 关卡名唯一、`location` 是合法格子、坐标来源是 map.ark-nights 的 MAA 模式、
   每个 action 的 `name` 能在 `opers`/`groups` 里对上。
5. **交给 MAA 执行**，把结果显示给主人（通关 / 卡在哪一步 / 失败原因）。

## 四、坑（写之前先看）

- JSON **不支持注释**，示例里的注释只是讲解。
- 作业站发布只认**英文** type/direction，本地跑中英文都行。
- `location` 是**格子坐标**不是像素；像素矩形（`rect`/`begin`/`end`）才是 720p 基准。
- `elapsed_time` 没有先执行过 `重置全局计时器` 会**卡住**。
- `costs` / `cost_changes` 三位数费用可能识别错，时间轴要求严就别用。
- 同名干员要填 `role` 区分。

---

## 五、怎么把作业交给 MAA 跑(maa-cli)

来源：MAA《CLI 使用指南 · 使用》https://docs.maa.plus/zh-cn/manual/cli/usage.html
（用 winget 装的用户，命令名是 `maa-cli` 而不是 `maa`）

### 准备（一次性）
```bash
maa install      # 安装 MaaCore 及资源
maa update       # 更新
maa init         # 交互式配置（连接方式等）
maa version      # 查 maa-cli 与 MaaCore 版本
```

### 直接跑一份作业（★这就是"执行关卡脚本"的入口★）
```bash
maa copilot <maa_uri>...      # 多个按顺序执行
```
`<maa_uri>` 可以是两种：
- **作业站 ID**：`maa://1234`
- **本地文件路径**：`./1234.json`   ← ★桌宠自己生成的作业走这条★

### 其余常用预定义任务
| 命令 | 作用 |
|---|---|
| `maa startup [client]` | 启动游戏并进入主界面（client 留空则不启动） |
| `maa closedown [client]` | 关闭游戏客户端（默认 Official） |
| `maa fight [stage]` | 战斗任务，`stage` 例如 `1-7`（留空＝上次/当前关卡） |
| `maa sscopilot <uri>` | 保全派驻作业 |
| `maa paradoxcopilot <uri>...` | 悖论模拟作业 |
| `maa roguelike <theme>` | 集成战略（Phantom/Mizuki/Sami/Sarkaz/JieGarden） |
| `maa run <task>` | 跑自定义任务（组合多个任务＋条件判断，配置见 config 文档） |

组合示例（官服：开游戏 → 用 3 个理智药刷 BB-7 → 关游戏）：
```bash
maa startup Official && maa fight BB-7 -m 3 && maa closedown
```

### 怎么拿到结果（给她/给程序读）
- 任务结束会输出**总结**：`fight` 给"关卡名 / 次数 / 消耗理智药 / 掉落统计"；`infrast` 给各设施进驻干员；`recruit` 给 tag 与星级。
- `--no-summary` 可关掉总结。
- 日志默认写 **stderr**，级别 `Error/Warn/Info/Debug/Trace`（默认 Warn）：
  `MAA_LOG=debug`、`-v` 加详细、`-q` 减详细、`--log-file[=路径]` 写文件。
  日志默认目录用 `maa dir log` 查。
- 其它子命令：`maa list`（列出可用任务）、`maa dir <dir>`（查目录）、`maa convert`（JSON/YAML/TOML 互转）、`maa activity`（当前活动）、`maa cleanup`。
- 具体参数看 `maa help <command>` 或 `maa <task> --help`。

### 桌宠的调用流程（推荐）
1. 产出/适配好 `作业.json`（见上面§一~§四）
2. `maa copilot ./作业.json`
3. 读它的**总结**（或指定 `--log-file` 读日志）判断成败
4. 把结果如实报给主人；失败就说明卡在哪一步

### 前置条件（缺一不可）
- MaaCore 已装（`maa install`）且版本满足作业里的 `minimum_required`
- **连接方式要能对上官方 PC 客户端**（MAA 已合并 PC 端支持：AttachWindow + Win32 截图/输入）
- 作业里的 `stage_name` 能唯一确定关卡
- 主人的 box 满足作业的 `requirements`（或用 `groups` 适配）
