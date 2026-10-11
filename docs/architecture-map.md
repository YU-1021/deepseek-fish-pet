# 桌宠架构地图（重构底图）

> 自动生成：`node app/scripts/arch-map.js`。用途：按 DSH 的"一个关注点一个模块/一份策略"重构前，先看清现状。

## 一、模块清单（按行数降序，>500 行标 🔥）

| 模块 | 行数 | 大小 | 被谁依赖 | 依赖谁 | 主要导出 |
|---|---:|---:|---|---|---|
| 🔥 `app/main.js` | 1803 | 105KB | — | `clock.js` `config.js` `llm.js` `mood.js` `assistant.js` `web.js` `dsh.js` `vocab.js` `tts.js` `asr.js` `chatlog.js` `screenstream.js` `gameagent.js` `skills.js` `style.js` `projects.js` `stats.js` `persona.js` `personatags.js` `petactions.js` `speak.js` `testlog.js` `userinput.js` `input.js` `bus.js` `store.js` `focuswin.js` `intercom.js` | petWinForTest, markPetHiddenForTest, setPetHideStickyForTest |
| 🔥 `app/src/assistant.js` | 975 | 60KB | `gameagent.js` `main.js` | `web.js` `screenstream.js` `input.js` `vision.js` `config.js` `skills.js` `style.js` `projects.js` `personatags.js` `userinput.js` `mood.js` `gameagent.js` `focuswin.js` `matcher.js` | run, allowed, TOOL_TIER, RANK, __captureForTest, __captureFallbackForTest |
| `app/src/stats.js` | 405 | 18KB | `index.js` `main.js` | `store.js` `bus.js` `personatags.js` `mood.js` `config.js` | META, KEYS, HIDDEN, NEUTRAL, DAILY_CAP, load |
| `app/src/asr.js` | 362 | 17KB | `main.js` | — | status, downloadModel, transcribe, transcribeDetailed, groupTokens, trimSilence |
| `app/src/personatags.js` | 332 | 14KB | `assistant.js` `petactions.js` `stats.js` `main.js` | — | TIERS, MAX_TAGS, tableFile, builtinFile, ensure, loadTable |
| `app/src/llm.js` | 301 | 15KB | `vision.js` `main.js` | — | net, request, stream, parseReply, DEFAULT_TIMEOUT_MS |
| `app/src/gameagent.js` | 299 | 14KB | `assistant.js` `main.js` | `screenstream.js` `vision.js` `assistant.js` `config.js` `userinput.js` `input.js` | init, start, stop, status |
| `app/src/memory/jobs.js` | 294 | 14KB | `index.js` | `tokens.js` | summarize, diary, extractFacts, parseFacts, extractExperiences, parseExperiences |
| `app/src/memory/index.js` | 272 | 11KB | — | `bus.js` `tokens.js` `store.js` `session.js` `medium.js` `long.js` `permanent.js` `skillmem.js` `context.js` `jobs.js` `stats.js` `mood.js` | init, onAppStart, onTurn, onAssistant, onSessionEnd, finishEnding |
| `app/src/petactions.js` | 270 | 11KB | `main.js` | `personatags.js` | tableFile, builtinFile, posesDir, ensure, loadTable, resolve |
| `app/src/tts.js` | 266 | 12KB | `main.js` | — | synthesize, VOICES, STYLES, DEFAULT_VOICE, DEFAULT_STYLE, resolveStyle |
| `app/src/projects.js` | 259 | 12KB | `assistant.js` `main.js` | — | rootDir, safePath, ls, readFile, writeOne, writeMany |
| `app/src/speak.js` | 241 | 10KB | `main.js` | — | BANDS, bandOf, scoreWords, thresholds, applyPosBias, POS_BONUS |
| `app/src/matcher.js` | 212 | 11KB | `assistant.js` | — | saveTemplate, findTemplate, findTemplateScaled, listTemplates, delTemplate, toBgra |
| `app/src/testlog.js` | 194 | 9KB | `main.js` | — | log, instrument, instrumentAll, analyze, tail, clear |
| `app/src/skills.js` | 174 | 6KB | `assistant.js` `main.js` | — | list, catalog, read, memoryFacts, openFolder, userDir |
| `app/src/focuswin.js` | 159 | 8KB | `assistant.js` `main.js` | — | focusWindow, clearAllTop, listWindows |
| `app/src/style.js` | 158 | 8KB | `assistant.js` `main.js` | `store.js` | load, save, derive, ensure, spec, moodHint |
| `app/src/config.js` | 157 | 9KB | `assistant.js` `gameagent.js` `input.js` `screenstream.js` `stats.js` `userinput.js` `main.js` | — | load, save, DEFAULTS, MEMORY_DEFAULTS, PRON_DEFAULTS, file |
| `app/src/userinput.js` | 147 | 6KB | `assistant.js` `gameagent.js` `input.js` `main.js` | `input.js` `config.js` | DEFAULTS, setParams, params, notePetMove, notePetMoveModel, fromModel |
| `app/src/input.js` | 145 | 9KB | `assistant.js` `gameagent.js` `screenstream.js` `userinput.js` `main.js` | `userinput.js` `config.js` | click, rclick, dclick, move, drag, scroll |
| `app/src/memory/permanent.js` | 143 | 6KB | `context.js` `index.js` | `store.js` `bus.js` | load, save, merge, promote, decay, topFacts |
| `app/src/screenstream.js` | 139 | 6KB | `assistant.js` `gameagent.js` `main.js` | `config.js` `input.js` | grabFrame, watch, warm |
| `app/src/memory/context.js` | 114 | 6KB | `index.js` | `tokens.js` `permanent.js` `long.js` `medium.js` | build, pickHistory |
| `app/src/memory/skillmem.js` | 112 | 4KB | `index.js` | `store.js` `bus.js` | load, save, merge, decay, ready, drop |
| `app/preload.js` | 112 | 6KB | — | — | — |
| `app/src/persona.js` | 88 | 3KB | `main.js` | — | FIELDS, USER_ONLY, ALL_FIELDS, LABELS, file, builtinFile |
| `app/src/store.js` | 84 | 4KB | `chatlog.js` `index.js` `long.js` `medium.js` `permanent.js` `session.js` `skillmem.js` `stats.js` `style.js` `main.js` | `bus.js` | read, write, exists, fileOf, dir |
| `app/src/intercom.js` | 73 | 4KB | `main.js` | — | install, filePath |
| `app/src/web.js` | 73 | 3KB | `assistant.js` `main.js` | — | run, close |
| `app/src/vocab.js` | 72 | 3KB | `main.js` | — | load, save, add, del, review, toPractice |
| `app/src/clock.js` | 70 | 3KB | `main.js` | — | now, day, offset, set, clear, file |
| `app/src/memory/session.js` | 69 | 2KB | `index.js` | `store.js` `bus.js` | restore, push, all, clear, info, saveNow |
| `app/src/vision.js` | 68 | 4KB | `assistant.js` `gameagent.js` | `llm.js` | describe |
| `app/src/dsh.js` | 67 | 2KB | `main.js` | — | state |
| `app/src/chatlog.js` | 59 | 2KB | `main.js` | `store.js` | all, add, clear, NS |
| `app/src/mood.js` | 47 | 2KB | `assistant.js` `index.js` `stats.js` `main.js` | — | load, save, adjust, startupDecay |
| `app/src/memory/medium.js` | 37 | 1KB | `context.js` `index.js` | `store.js` `bus.js` | list, save, add, has, prune, olderThan |
| `app/src/memory/long.js` | 36 | 1KB | `context.js` `index.js` | `store.js` `bus.js` | list, save, add, pruneDays, removeAt, NS |
| `app/src/tokens.js` | 26 | 1KB | `context.js` `index.js` `jobs.js` | — | est, estMessages, clip |
| `app/src/bus.js` | 16 | 1KB | `index.js` `long.js` `medium.js` `permanent.js` `session.js` `skillmem.js` `stats.js` `store.js` `main.js` | — | — |

**合计 41 个模块、8930 行**（不含 node_modules）。

热点（>500 行）：`app/main.js`(1803)、`app/src/assistant.js`(975) —— 这些是重构首要目标。

## 二、"策略"现在埋在哪（重构时要抽成独立模块的东西）

| 关注点 | 出现在哪些模块 | 命中次数 |
|---|---|---:|
| 无进展检测 | `app/src/assistant.js`(14) `app/src/gameagent.js`(1) `app/src/intercom.js`(1) | 16 |
| 工具回执剪裁 | `app/src/config.js`(1) `app/main.js`(3) | 4 |
| 大输出溢出到文件 | `app/src/assistant.js`(7) | 7 |
| 操作后 settle 等待 | `app/src/asr.js`(9) `app/src/assistant.js`(16) `app/src/screenstream.js`(1) `app/src/tts.js`(7) | 33 |
| 让位给用户（主人一动就停） | `app/src/assistant.js`(3) `app/src/gameagent.js`(2) `app/src/userinput.js`(7) `app/main.js`(6) | 18 |
| 立绘窗看门狗 | `app/main.js`(8) | 8 |
| 工具超时 | `app/src/asr.js`(1) `app/src/assistant.js`(3) `app/src/focuswin.js`(3) `app/src/input.js`(1) `app/src/llm.js`(4) `app/src/matcher.js`(1) `app/src/projects.js`(4) `app/src/tts.js`(2) `app/src/userinput.js`(2) `app/src/vision.js`(2) `app/src/web.js`(3) `app/main.js`(1) | 27 |
| 读后写 / 观察策略 | `app/src/assistant.js`(1) `app/src/projects.js`(14) `app/src/skills.js`(8) | 23 |
| 会话持久化 | `app/src/memory/context.js`(2) `app/src/memory/index.js`(9) `app/main.js`(12) | 23 |
| 上下文压缩（去失败叙述） | `app/src/memory/index.js`(1) `app/src/memory/jobs.js`(2) `app/src/testlog.js`(2) | 5 |
| 提示词可覆盖 | `app/src/vocab.js`(1) `app/main.js`(11) | 12 |
| 权限档 | `app/src/assistant.js`(12) `app/src/gameagent.js`(3) `app/src/llm.js`(1) `app/main.js`(4) | 20 |
| 模板匹配 / OCR 定位 | `app/src/assistant.js`(12) `app/src/matcher.js`(9) `app/main.js`(4) | 25 |
| 连续看屏幕（watch） | `app/src/assistant.js`(4) `app/main.js`(3) | 7 |
| agent 主循环 | `app/src/config.js`(3) `app/src/stats.js`(6) `app/main.js`(4) `app/preload.js`(1) | 14 |

## 三、耦合最重的模块（被依赖最多 → 改它影响面最大）

| 模块 | 被依赖次数 | 依赖者 |
|---|---:|---|
| `app/src/store.js` | 10 | `chatlog.js` `index.js` `long.js` `medium.js` `permanent.js` `session.js` `skillmem.js` `stats.js` `style.js` `main.js` |
| `app/src/bus.js` | 9 | `index.js` `long.js` `medium.js` `permanent.js` `session.js` `skillmem.js` `stats.js` `store.js` `main.js` |
| `app/src/config.js` | 7 | `assistant.js` `gameagent.js` `input.js` `screenstream.js` `stats.js` `userinput.js` `main.js` |
| `app/src/input.js` | 5 | `assistant.js` `gameagent.js` `screenstream.js` `userinput.js` `main.js` |
| `app/src/mood.js` | 4 | `assistant.js` `index.js` `stats.js` `main.js` |
| `app/src/personatags.js` | 4 | `assistant.js` `petactions.js` `stats.js` `main.js` |
| `app/src/userinput.js` | 4 | `assistant.js` `gameagent.js` `input.js` `main.js` |
| `app/src/screenstream.js` | 3 | `assistant.js` `gameagent.js` `main.js` |
| `app/src/tokens.js` | 3 | `context.js` `index.js` `jobs.js` |
| `app/src/assistant.js` | 2 | `gameagent.js` `main.js` |
| `app/src/focuswin.js` | 2 | `assistant.js` `main.js` |
| `app/src/gameagent.js` | 2 | `assistant.js` `main.js` |

## 四、按 DSH 的分层看，我们现在缺哪些层

| DSH 的层 | 桌宠现状 | 缺口 |
|---|---|---|
| agent-loop（独立的主循环包） | 主循环写在 `renderer/chat.js` 的 `runTask` 里，和 UI 混在一起 | ✗ 需要抽出来 |
| repeat-tool-reminder（重复动作策略） | 手搓在 `src/assistant.js` 的 `noProgressWarning` | ⚠️ 有策略但混在工具分发里 |
| compaction-tool-result-pruner | 手搓成 `main.js` 的 `READ_CAPS` 常量 | ⚠️ 是常量不是策略 |
| spill / output-retention | 手搓（watch_screen 时间线写文件） | ⚠️ 只在一处 |
| tool-call-timeout-policy | 各调用点各写 timeout | ✗ 没有统一策略 |
| fs-observation-policy | 无 | ✗ |
| session-format 版本与迁移 | 无版本号 | ✗ |
| permission-presets | 有 `TOOL_TIER` + `RANK` | ✓ 已接近 |
| skill（按需加载说明书） | 有 `src/skills.js` | ✓ 已接近 |
| goal（长期目标 + 自动续跑） | 无 | ✗ |
| subagent / workflow | 无 | ✗（DSH 靠它做并行与编排） |
