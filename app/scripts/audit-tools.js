/* 重构前后"工具清单"对账 —— 回答"工具有没有丢"
 *
 * 为什么这样查：光看现在的代码说明不了"有没有丢"，必须**和重构前那一版对比**。
 * 做法：
 *   ① 从 git 取重构开始前的那一版（02dd592）的 assistant.js，用**大括号配对**提取完整的 TOOL_TIER；
 *   ② 同样提取当前版本的 TOOL_TIER + 能力注册表的 TOOL_DEFS；
 *   ③ 再提取两版 main.js 里给模型看的"工具清单"字符串里的工具名；
 *   ④ 求差集：**旧有新没有 = 丢了**（这是用户真正问的）。
 * 跑法：node app/scripts/audit-tools.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const BASE = process.env.BASE_COMMIT || '02dd592';

function gitShow(commit, file) {
  try {
    return execFileSync('git', ['show', commit + ':' + file], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { return ''; }
}

/* 从源码里抠出 `const X = { ... };` 的完整块（按大括号配对，注释和字符串里的括号不计） */
function extractObject(src, decl) {
  const i = src.indexOf(decl);
  if (i < 0) return null;
  const start = src.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0, inStr = null, inLine = false, inBlock = false;
  for (let j = start; j < src.length; j++) {
    const c = src[j], n = src[j + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; j++; } continue; }
    if (inStr) {
      if (c === '\\') { j++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; j++; continue; }
    if (c === '/' && n === '*') { inBlock = true; j++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return null;
}

/* 从一个对象字面量里取键名：'name': / name: / "name": */
function keysOf(objText) {
  if (!objText) return [];
  const out = [];
  const re = /(?:^|[\s,{])(?:'([a-zA-Z_][\w]*)'|"([a-zA-Z_][\w]*)"|([a-zA-Z_][\w]*))\s*:/g;
  let m;
  while ((m = re.exec(objText))) out.push(m[1] || m[2] || m[3]);
  return Array.from(new Set(out));
}

/* 从 main.js 的提示词字符串里抓 ACTION 工具名（形如 `tool|x,y` 或 列表里的 `tool`） */
function toolNamesInPrompt(src) {
  const names = new Set();
  const re = /(?:ACTION:\s*|`|'|\s)([a-z][a-z0-9_]{2,})\|/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
}

const oldA = gitShow(BASE, 'app/src/assistant.js');
const newA = fs.readFileSync(path.join(REPO, 'app', 'src', 'assistant.js'), 'utf8');
const oldM = gitShow(BASE, 'app/main.js');
const newM = fs.readFileSync(path.join(REPO, 'app', 'main.js'), 'utf8');
const regSrc = fs.readFileSync(path.join(REPO, 'app', 'src', 'registry.js'), 'utf8');

const oldTier = keysOf(extractObject(oldA, 'const TOOL_TIER'));
const newTier = keysOf(extractObject(newA, 'const TOOL_TIER'));
/* 注册表里的工具名：从 TOOL_DEFS 的 name: '...' 抓 */
const regTools = Array.from(new Set((regSrc.match(/name:\s*'([a-z_0-9]+)'/g) || []).map((s) => s.replace(/.*'([a-z_0-9]+)'.*/, '$1'))));
const oldPrompt = toolNamesInPrompt(oldM);
const newPrompt = toolNamesInPrompt(newM);

const nowKnows = new Set([].concat(newTier, regTools));

function diff(a, b) { return Array.from(a).filter((x) => !b.has(x)).sort(); }

console.log('=== 重构前后工具对账 ===');
console.log('  对比基线: ' + BASE + '（重构开始前的那一版）');
console.log('');
console.log('  旧 TOOL_TIER      : ' + oldTier.length + ' 个');
console.log('  新 TOOL_TIER      : ' + newTier.length + ' 个');
console.log('  能力注册表 TOOL_DEFS: ' + regTools.length + ' 个');
console.log('  现在"认识"的工具合计 : ' + nowKnows.size + ' 个（老表 ∪ 注册表）');
console.log('');
const lostTier = diff(oldTier, nowKnows);
const lostPrompt = diff(oldPrompt, nowKnows).filter((x) => oldTier.indexOf(x) >= 0 || /^(click|rclick|dclick|move|drag|scroll|key|type|screen_|find_|make_|template_|web_|proj_|skill_|flow_|game_|focus_|windows_|read_|write_|list_|run_|use_)/.test(x));
console.log('★ 旧 TOOL_TIER 里有、现在不认识的: ' + (lostTier.length ? lostTier.join(', ') : '（无）'));
console.log('★ 旧提示词里出现过、现在不认识的: ' + (lostPrompt.length ? lostPrompt.join(', ') : '（无）'));
console.log('');
const added = diff(nowKnows, new Set(oldTier));
console.log('  （顺带）现在比旧表多出来的: ' + (added.length ? added.join(', ') : '（无）'));
console.log('');
console.log('  旧提示词里提到的工具名: ' + Array.from(oldPrompt).sort().join(', '));
console.log('  新提示词里提到的工具名: ' + Array.from(newPrompt).sort().join(', '));
const promptLost = diff(new Set(oldPrompt), newPrompt);
console.log('★ 提示词里"以前写过、现在没写"的: ' + (promptLost.length ? promptLost.join(', ') : '（无）'));

process.exit((lostTier.length || lostPrompt.length) ? 1 : 0);
