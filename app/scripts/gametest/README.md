# gametest —— 离线/在线测试台（去 Electron 依赖后的约定）

> ★本文件是给 lead 看的接口约定★：帧怎么给、OCR 放哪、clicks.jsonl 怎么按批次读。
> ★跑分不需要我起 Electron✗★（`--no-sandbox` 已由 lead 验证可起窗 ✓）。

## 1. 帧 + OCR 的输入约定（`score.js --frames=<目录> --ocrDir=<目录>`）

| 项 | 约定 |
|---|---|
| 帧图 | `<frames>/fNNN.png`（`f000.png`、`f001.png`… 三位数字从 000 起 ✓），**必须 1920x1080**、物理像素 ✓ |
| OCR JSON | `<ocrDir>/ocr-fNNN.json`（与帧**同名**、前缀 `ocr-` ✓ 一一对应 ✓）；不给 `--ocrDir` 时脚本会自己试着调 OCR ✓（本机会话里 Node→PowerShell 不可靠 ✗，建议给 ✓） |
| JSON 结构 | `{ok, imgW, imgH, text, lines:[{text, words:[{t,x,y,w,h}]}]}` —— ★字段名是 `t`✗不是 text；坐标在 x/y/w/h 上、不在 boundingRect 里 ✓；单位=截图像素（本机=物理 ✓）★ |
| 真值 | `layout.js`（**唯一来源** ✓ 由 `score.js` 直接 `require` ✓ 不手抄 ✓）；帧必须是 `render.html` 渲染出来的（`render.js` 由同一份 layout.js 生成 ✓） |
| 编码 | JSON 用 **UTF-8 无 BOM**（`[IO.File]::WriteAllText(..., UTF8Encoding($false))` ✓；带 BOM 也能读 ✓ 脚本会 strip ✓） |
| 其它参数 | `--tolPx=6`（命中容差 ✓）、`--perClass=N`（每类抽多少个 ✓ 982 默认全跑 ✓） |
| 输出 | `C:\deepseek\gametest\score.json`（分类通过率 + 中心误差 + 逐行 verdict ✓：`ok`/`wrong`/`notfound`/`ambiguous` ✓） |

批量 OCR 的命令（一次搞定一个目录）：
`foreach ($f in Get-ChildItem <frames> -Filter *.png) { powershell -File app\scripts\gametest\shoot-ocr.ps1 -Png $f.FullName -Out "<ocrDir>\ocr-$($f.BaseName).json" }`

## 2. 真点击测试（`window.js` + `clicks.jsonl`）

启动（★由 lead/主人执行 ✓ 我不起 ✗★；`--no-sandbox` 是关键 ✓）：
```
Start-Process electron.exe -ArgumentList "--no-sandbox","<repo>\app\scripts\gametest\window.js","--user-data-dir=C:\deepseek\gametest\ud-live"
```
· 一启动即就绪 ✓（无边框 1920x1080 置顶 ✓）；★ESC 立即关窗✗★ ✓；独立 `--user-data-dir` ✓（不抢她的单实例锁 ✓）。
· 窗口布局 = `layout.js` ✓（102 个元素 ✓：文字 42 / 纯图形 30 / 同名重复 12 / 小按钮 12 / 贴边 6 ✓ + 2 个无按钮区 ✓）。

### `clicks.jsonl`（窗口自己写 = 真值 ✓）
| 字段 | 说明 |
|---|---|
| `batch` | ★批次号★ = 该次启动的时间戳（毫秒 ✓）。**同一批的所有行 batch 相同** ✓ 便于按批读 ✓ |
| `kind` | `'batch-start'`（启动时写入的第一行 ✓ 带 layout 计数与屏幕尺寸 ✓）或 `'click'` ✓ |
| `t` | 点击时刻（ms 时间戳 ✓） |
| `id` | ★被点到的元素 id★（如 `B012` ✓）= 真值 ✓；点空白处则本行不产生（页面只对 `.btn` 记录 ✓） |
| `label` / `class` | 该元素的文字/分类 ✓（便于直接判"点到谁" ✓） |
| `x`,`y` | 窗口内坐标（= 物理坐标 ✓ 因为窗口在 (0,0) 且 1920x1080 ✓） |
| `sx`,`sy` | 屏幕坐标 ✓ |

· **清空/分批**：每次启动 **会清空** `clicks.jsonl` 并写一行 `batch-start` ✓ → ★一批 = 一次启动 = 一个 batch 号★ ✓；要保留上一批请先拷贝该文件 ✓。
· 真值判据（lead 侧）：拿 locate 给出的目标 id 与 `clicks.jsonl` 里同 `batch` 的最后一条 `id` 比对 ✓ —— ★正好落在目标上才算过✗★ ✓；报"成功"但没有对应行 = **假成功**✗ ✓（必须为 0 ✓）。
· 布局真值快照：启动时同时写 `C:\deepseek\gametest\layout-snapshot.json` ✓（与窗口画面同源 ✓ 便于复核 ✓）。

## 3. 我不做什么
· ★不起任何 Electron✗★（抓帧/真点击都由 lead 侧执行 ✓）；不改产品代码 ✓；不放宽任何闸门 ✓。
· 跑分脚本：`score.js`（离线帧 ✓）/ `lattice-small.js`（格距+相位实验 ✓ 现明确报"量不出"✓）/ `notfound-table.js`（text 未命中逐条 ✓）/ `verify-round.js`（防误配 + icon 单格根因 ✓）/ `zoomocr.js`（裁剪放大对比 ✓）。

## 4. ★已归档的可引用基线（2026-10-11）★

| 项目 | 数字 | 口径 / 备注 |
|---|---|---|
| 合成屏 icon 类 | ★≤2px 27/30 = 90.0%★ | **最严口径下的最好成绩** ✓；3 格不通过的原因是**碎片配对错**（72x72 被切成 11 块、挑了 19x10 碎片 ✓）★不是精度问题✗★ |
| 合成屏 icon 类 | ≤6px 93.3%（56/60，2 帧） | score.js 默认口径 ✓ |
| 合成屏总分 | 80.4%（164/204） | text 78.6% / dup 100% / icon 93.3% / small+edge 50.0% ✓ |
| 真机职业列 | 仅定性：格距/模板路给干净 9 格（113.8px）、连通域路碎成 26 块 | ★精度数字待补✗★（真值互证差 2.1px 未过 + 原帧被遮挡 75.5% ✓） |
| step1.png | 遮挡自检通过（平均亮度 144.4 / 近黑 3.7%） | 可作为第二张真实帧 ✓（标注未做 ✗） |

★两条已定的"不许接默认"结论（附数字 ✓）★：
· 形态学闭运算治碎片化：最坏误差 22.8→5.4px ✓ 但通过率下降（icon 93.3→90.0、small+edge 50→33.3、总 80.4→76.5）→ **可选（close=2），默认 0** ✗。
· 格距+相位（模式 C）：实测 0%（我量出的格距/相位对不上真实网格）→ **不接默认** ✗，且量不出时**明确报"量不出"** ✓（有断言覆盖 ✓）。
· 梯度加权亚像素精配准（±3px）：27 个 0.0px 被挪到 0.4px、平均 4.69→5.03px → **无收益且略负，不接默认** ✗。★它只修"初始估计已在 ±3px 内"的误差✗；20+px 的误差是**配对错**，别拿精配准去治 ✓★。
· 3 采样 LCS 逐字投票：38/42 → **31/42** ✗（两个空采样会把一个正确单读"弃权"掉 ✓）→ **不接默认** ✗。

## 5. ★三方并列（2026-10-11 完整化；不许合并、不许平均）★

| 来源 | 结果 | 可信度与限制 |
|---|---|---|
| ① 合成屏（Chrome 渲染 render.html，2 帧 × 102 = 204 次） | 总分 **80.4%**（text 78.6% / dup 100% / icon 93.3% / small+edge 50.0%）；★icon 类 ≤2px = 90.0%（27/30）★ | ★可信 ✓★ 可复现（同脚本同帧逐字复现）✓。★限制：它测的是"小字/同名重复/贴边"等**合成难题**✓，不代表真机能力 ✗ |
| ② step1 真机帧（基地房间列表） | ≤6px 3/3、≤2px 3/3，中心误差 0.00px（n=3） | ★不作能力结论✗★：text 真值是 **OCR 框回填=循环真值** ✗；n=3 极小 ✓；遮挡自检通过（亮度 144.4/近黑 3.7%）✓ |
| ③ 真机职业列（class-column-clean.png，n=**9** ✓ 真值已冻结） | 格距/模板路 ≤6px **1/9=11.1%**、≤2px **1/9**，中心误差 39.84/56.08/56.08px；blob 路 ≤6px **0/9**、≤2px 0/9，误差 43.17/47.76/47.76px | ★第一个 n=9 可引用数字 ✓★（真值闸门通过：spacing 0.0px 差、9 格 certain、右边界未裁 ✓）。★但这是"**当前实现**"的数字✗，不是"格距法能力"结论✗★：实测 modeLattice 发出的格心间距**不规则 73~127px**（自报 115.9 vs 实际中位 116.0，最大偏差 **43px > 0.5px** ✗）→ 已加断言（spacingOk/trustworthy=false ✓）。★要修的是"只发出 inLattice 的格、丢掉 estimated/伪格"✗★ |

★遮挡自检已改**联合判据**✗→✓（①近黑>60% **且** ②该带 OCR 词数<3 **且** ③检出格数<9 三条同时满足才判遮挡 ✓）—— 单看近黑会把**深色界面**误判成遮挡 ✗（干净真机列 40.7/74.6% 就出现过这个假阳性 ✓），现在只作提示、不单独否帧 ✓。
