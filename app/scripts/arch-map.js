/* 生成桌宠自己的架构地图（重构的底图）
 *
 * 为什么要它：用户要求按 DSH 的水平重构，而 DSH 是"一个关注点一个包"。
 * 要动手拆，先得有一张准确的现状图：每个模块多大、谁依赖谁、哪些是热点、
 * 今天手搓的那些"策略"现在分别埋在哪个文件的哪一段。
 *
 * 输出：docs/architecture-map.md（人看的）+ 控制台摘要
 * 跑法：node app/scripts/arch-map.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');            // app/
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, '..', 'docs', 'architecture-map.md');

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

const files = [];
walk(SRC, files);
if (fs.existsSync(ROOT)) { /* 顶层还有 main.js / preload 等 */ }
for (const extra of ['main.js', 'preload.js']) {
  const p = path.join(ROOT, extra);
  if (fs.existsSync(p)) files.push(p);
}

const mods = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n').length;
  const reqs = [];
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const dep = m[1];
    if (dep.startsWith('.')) reqs.push(dep);
  }
  /* 导出的名字 */
  let exp = [];
  const me = src.match(/module\.exports\s*=\s*\{([\s\S]{0,1200}?)\}/);
  if (me) {
    exp = me[1].split(',').map((s) => s.split(':')[0].trim()).filter((s) => /^[\w$]+$/.test(s));
  }
  mods.push({
    rel: path.relative(path.join(ROOT, '..'), f).replace(/\\/g, '/'),
    lines, bytes: fs.statSync(f).size, reqs: [...new Set(reqs)], exports: exp,
    src,
  });
}

/* 反向依赖（谁被谁用） */
const byPath = new Map(mods.map((m) => [m.rel, m]));
function resolveReq(fromRel, dep) {
  const dir = path.dirname(fromRel);
  let p = path.join(dir, dep).replace(/\\/g, '/');
  if (!p.endsWith('.js')) p += '.js';
  return p;
}
for (const m of mods) {
  m.usedBy = [];
  m.deps = [];
}
for (const m of mods) {
  for (const d of m.reqs) {
    const t = resolveReq(m.rel, d);
    const target = byPath.get(t) || byPath.get(t.replace('/src/', '/src/'));
    if (target) { m.deps.push(target.rel); target.usedBy.push(m.rel); }
  }
}

/* 今天手搓的"策略"现在埋在哪 —— 用关键词定位，供重构时抽取 */
const POLICIES = [
  ['无进展检测', /noProgressWarning|actionLog|原地打转/],
  ['工具回执剪裁', /READ_CAPS|toolResultChars/],
  ['大输出溢出到文件', /-timeline\.txt|shotsDir\(\)|writeFileSync\(tpath/],
  ['操作后 settle 等待', /actionSettleMs|settle/],
  ['让位给用户（主人一动就停）', /waitUntilFree|isUserActive|markPetHidden/],
  ['立绘窗看门狗', /startPetVisibilityWatchdog|petHideSticky/],
  ['工具超时', /timeout|setTimeout\(.*kill/],
  ['读后写 / 观察策略', /safePath|越界|observation/],
  ['会话持久化', /session\.push|pickHistory|onSessionEnd/],
  ['上下文压缩（去失败叙述）', /summarize|handoff|compact=/],
  ['提示词可覆盖', /override\.md|buildSystemPrompt/],
  ['权限档', /TOOL_TIER|RANK|allowed/],
  ['模板匹配 / OCR 定位', /findTemplate|findTextInOcr|make_template/],
  ['连续看屏幕（watch）', /watch_screen|watchStreak|lookStreak/],
  ['agent 主循环', /runTask|chat:continue|stepBudget/],
];

let md = '# 桌宠架构地图（重构底图）\n\n';
md += '> 自动生成：`node app/scripts/arch-map.js`。用途：按 DSH 的"一个关注点一个模块/一份策略"重构前，先看清现状。\n\n';
md += '## 一、模块清单（按行数降序，>500 行标 🔥）\n\n';
md += '| 模块 | 行数 | 大小 | 被谁依赖 | 依赖谁 | 主要导出 |\n|---|---:|---:|---|---|---|\n';
for (const m of [...mods].sort((a, b) => b.lines - a.lines)) {
  const hot = m.lines > 500 ? '🔥 ' : '';
  md += `| ${hot}\`${m.rel}\` | ${m.lines} | ${Math.round(m.bytes / 1024)}KB | ${m.usedBy.length ? m.usedBy.map((x) => '`' + path.basename(x) + '`').join(' ') : '—'} | ${m.deps.length ? m.deps.map((x) => '`' + path.basename(x) + '`').join(' ') : '—'} | ${m.exports.slice(0, 6).join(', ') || '—'} |\n`;
}

const total = mods.reduce((n, m) => n + m.lines, 0);
md += `\n**合计 ${mods.length} 个模块、${total} 行**（不含 node_modules）。\n`;
const hot = mods.filter((m) => m.lines > 500).sort((a, b) => b.lines - a.lines);
md += `\n热点（>500 行）：${hot.length ? hot.map((m) => '`' + m.rel + '`(' + m.lines + ')').join('、') : '无'} —— 这些是重构首要目标。\n`;

md += '\n## 二、"策略"现在埋在哪（重构时要抽成独立模块的东西）\n\n';
md += '| 关注点 | 出现在哪些模块 | 命中次数 |\n|---|---|---:|\n';
for (const [name, re] of POLICIES) {
  const hits = [];
  let n = 0;
  for (const m of mods) {
    const c = (m.src.match(new RegExp(re.source, 'g')) || []).length;
    if (c) { hits.push('`' + m.rel + '`(' + c + ')'); n += c; }
  }
  md += `| ${name} | ${hits.join(' ') || '—'} | ${n} |\n`;
}

md += '\n## 三、耦合最重的模块（被依赖最多 → 改它影响面最大）\n\n';
md += '| 模块 | 被依赖次数 | 依赖者 |\n|---|---:|---|\n';
for (const m of [...mods].sort((a, b) => b.usedBy.length - a.usedBy.length).slice(0, 12)) {
  md += `| \`${m.rel}\` | ${m.usedBy.length} | ${m.usedBy.map((x) => '`' + path.basename(x) + '`').join(' ') || '—'} |\n`;
}

md += '\n## 四、按 DSH 的分层看，我们现在缺哪些层\n\n';
md += '| DSH 的层 | 桌宠现状 | 缺口 |\n|---|---|---|\n';
md += '| agent-loop（独立的主循环包） | 主循环写在 `renderer/chat.js` 的 `runTask` 里，和 UI 混在一起 | ✗ 需要抽出来 |\n';
md += '| repeat-tool-reminder（重复动作策略） | 手搓在 `src/assistant.js` 的 `noProgressWarning` | ⚠️ 有策略但混在工具分发里 |\n';
md += '| compaction-tool-result-pruner | 手搓成 `main.js` 的 `READ_CAPS` 常量 | ⚠️ 是常量不是策略 |\n';
md += '| spill / output-retention | 手搓（watch_screen 时间线写文件） | ⚠️ 只在一处 |\n';
md += '| tool-call-timeout-policy | 各调用点各写 timeout | ✗ 没有统一策略 |\n';
md += '| fs-observation-policy | 无 | ✗ |\n';
md += '| session-format 版本与迁移 | 无版本号 | ✗ |\n';
md += '| permission-presets | 有 `TOOL_TIER` + `RANK` | ✓ 已接近 |\n';
md += '| skill（按需加载说明书） | 有 `src/skills.js` | ✓ 已接近 |\n';
md += '| goal（长期目标 + 自动续跑） | 无 | ✗ |\n';
md += '| subagent / workflow | 无 | ✗（DSH 靠它做并行与编排） |\n';

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md, 'utf8');

console.log('模块数 ' + mods.length + '，总行数 ' + total);
console.log('热点(>500行): ' + (hot.map((m) => m.rel + '(' + m.lines + ')').join(', ') || '无'));
console.log('耦合最重: ' + [...mods].sort((a, b) => b.usedBy.length - a.usedBy.length).slice(0, 5).map((m) => path.basename(m.rel) + '(' + m.usedBy.length + ')').join(', '));
console.log('已写: ' + OUT);
