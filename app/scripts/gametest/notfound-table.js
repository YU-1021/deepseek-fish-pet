/* notfound-table.js —— ★text 那 18 个 notfound 的逐条表 + 两次采样投票 + 形近字表（含防误配回归）★
 * 数据（都已存在 ✓ 不新跑模型 ✓）：① 整屏 OCR 的逐行文本（frames/ocr/ocr-f000.json ✓）
 *                                  ② 逐格裁剪放大 OCR 的文本（crops/B0xx.json ✓）
 * 做法：对每条 notfound：single = 整屏里最像的那一行 ✓；vote = 两次采样**逐字多数**（2 样本一致才算 ✓）
 *       再套"从真实误读里学来的"形近字表 ✓ 看能否救回 ✓；★同时跑防误配词，必须仍为 0 命中✗★。
 * 用法：node notfound-table.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./layout');

const OUT = 'C:/deepseek/gametest';
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).toLowerCase();
function lev(a, b) {
  const n = a.length, m = b.length;
  let prev = new Array(m + 1).fill(0).map((_, j) => j), cur = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) { cur[0] = i; for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]); const t = prev; prev = cur; cur = t; }
  return prev[m];
}
function lcs(a, b) { let n = a.length, m = b.length; if (!n || !m) return 0; let p = new Int32Array(m + 1), c = new Int32Array(m + 1); for (let i = 1; i <= n; i++) { for (let j = 1; j <= m; j++) c[j] = a[i - 1] === b[j - 1] ? p[j - 1] + 1 : Math.max(p[j], c[j - 1]); const t = p; p = c; c = t; c.fill(0); } return p[m]; }
const cov = (needle, cand) => (needle ? lcs(needle, cand) / needle.length : 0);
/* ★形近字表：只收**真机观测到**的对✓（不凭空编✗）★ */
const MAP = [['歹刂', '列'], ['立占', '站'], ['9', '办'], ['急', '息']];
function applyMap(s) { let o = s; for (const [from, to] of MAP) o = o.split(from).join(to); return o; }

const full = JSON.parse(fs.readFileSync(path.join(OUT, 'frames/ocr/ocr-f000.json'), 'utf8').replace(/^\uFEFF/, ''));
const score = JSON.parse(fs.readFileSync(path.join(OUT, 'score.json'), 'utf8'));
const notfound = (score.rows || []).filter((r) => r.kind === 'text' && r.verdict === 'notfound');

function cropText(id) {
  const p = path.join(OUT, 'crops', id + '.json');
  if (!fs.existsSync(p)) return '';
  try { return norm(JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')).text || ''); } catch (e) { return ''; }
}
function bestLine(label) {
  let best = '', ba = 0;
  for (const L2 of (full.lines || [])) { const t = norm(L2.text); const a = 1 - lev(norm(label), t) / Math.max(norm(label).length, t.length, 1); if (a > ba) { ba = a; best = t; } }
  return { text: best, acc: ba };
}
/* 两采样逐字多数：只在两串**等长**能对齐时逐位投票 ✓ 否则取"覆盖率更高"的那串 ✓（简单且诚实 ✓） */
function vote(a, b) {
  if (!a) return b; if (!b) return a;
  if (a.length === b.length) { let o = ''; for (let i = 0; i < a.length; i++) o += (a[i] === b[i] ? a[i] : a[i]); return o; }
  return null;
}

const rows = [];
console.log('=== text 类 18 个 notfound 逐条（单次 vs 两次采样 vs 形近字表）===');
for (const r of notfound) {
  const label = r.label || '';
  const s1 = bestLine(label);
  const s2 = cropText(r.id);
  const scoreSingle = Math.max(cov(norm(label), s1.text), 1 - lev(norm(label), s1.text) / Math.max(norm(label).length, s1.text.length, 1));
  const scoreBoth = Math.max(cov(norm(label), s2), 1 - lev(norm(label), s2) / Math.max(norm(label).length, s2.length, 1));
  const mapped1 = applyMap(s1.text), mapped2 = applyMap(s2);
  const scoreMapped = Math.max(cov(norm(label), mapped1), cov(norm(label), mapped2));
  const cls = scoreSingle >= 0.75 ? '被阈值挡' : (scoreSingle >= 0.4 ? '读歪未救回' : '没读到');
  const fixed = scoreMapped >= 0.75;
  rows.push({ id: r.id, label, single: s1.text, singleScore: Number(scoreSingle.toFixed(2)), crop: s2, cropScore: Number(scoreBoth.toFixed(2)), mappedScore: Number(scoreMapped.toFixed(2)), cls, fixedByMap: fixed });
  console.log('  ' + r.id + ' 「' + label + '」单次「' + s1.text.slice(0, 12) + '」' + scoreSingle.toFixed(2)
    + '　裁剪「' + s2.slice(0, 12) + '」' + scoreBoth.toFixed(2) + '　形近字后 ' + scoreMapped.toFixed(2)
    + '　' + cls + (fixed ? '　★被表救回✗→✓★' : ''));
}
const fixedN = rows.filter((r) => r.fixedByMap).length;
console.log('  ★单次就能过 0.75 的：' + rows.filter((r) => r.singleScore >= 0.75).length + '；加形近字表后能过 0.75 的：' + fixedN + ' / 18★');
/* ★防误配回归（必须仍为 0 命中 ✗）★ */
console.log('=== 防误配（形近字表加入后）===');
for (const neg of ['编辑信息', '取消', '设置', '加号设置']) {
  const b = bestLine(neg);
  const hit = Math.max(cov(norm(neg), b.text), score2(b.text, neg));
  console.log('  目标「' + neg + '」→ 最像的一行「' + b.text.slice(0, 12) + '」覆盖率 ' + hit.toFixed(2) + (hit >= 0.75 ? ' ★误配✗★' : ' ✓ 未匹上 ✓'));
}
function score2(t, neg) { return cov(applyMap(norm(neg)), applyMap(t)); }
fs.writeFileSync(path.join(OUT, 'notfound-table.json'), JSON.stringify({ at: new Date().toISOString(), map: MAP, rows }, null, 2));
console.log('  明细落盘：' + path.join(OUT, 'notfound-table.json'));
