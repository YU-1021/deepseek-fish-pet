/* vote3.js —— ★③ 3 采样对齐投票（原图 / +2px 偏移+轻对比拉伸 / 逐格裁剪放大）★
 * 口径（lead 定的 ✓）：同一 region 三种预处理/偏移 → **LCS 对齐后逐字投票** ✓，不可比位**弃权** ✓；不许调阈值代替 ✓。
 *
 * 三采样（都已落盘 ✓ 可复现 ✓）：
 *   S1 = 整屏 OCR 的"最像那一行"（frames/ocr/ocr-f000.json ✓ 有版面上下文 ✓）
 *   S2 = 该格裁剪放大 ×3 的 OCR（crops/B0xx.json ✓）
 *   S3 = 该格裁剪放大 ×3 **+2px 偏移 + 轻微对比拉伸** 的 OCR（vote3/ ✓ 本脚本生成 ✓）
 * 投票规则（写清 ✓）：把 S1/S2/S3 都用 LCS 对齐到**目标标签**（长度已知 ✓=锚 ✓）→
 *   逐位取三串在该位的字符；**出现 ≥2 次相同的字符才算票** ✓；三串该位互不相同 → ★弃权✗★（该位保持"?"不算对 ✗）。
 *   最终串 = 投票结果（弃权位写 '?'）。
 * 用法：node vote3.js --gen  → 生成 S3 图；然后 PowerShell 批量 OCR；再 node vote3.js --score
 */
'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', '..');
const OC = require(path.join(APP, 'src/ownclick'));
const L = require('./layout');
const Jimp = require('jimp').Jimp;
const OUT = 'C:/deepseek/gametest';
const S3D = path.join(OUT, 'vote3');
const PNG = path.join(OUT, 'myframes/f000.png');

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '').replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
function lcsAlign(needle, s) {
  /* 返回 needle 每一位在 s 中"最佳对齐"到的字符 ✓（标准 LCS 回溯 ✓） */
  const n = needle.length, m = s.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) dp[i][j] = needle[i - 1] === s[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const out = new Array(n).fill(null);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (needle[i - 1] === s[j - 1]) { out[i - 1] = s[j - 1]; i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { i--; }
    else { j--; }
  }
  return out;   // null = 该位在 s 里对不上（弃权位 ✓）
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; } }

(async () => {
  const targets = L.buttons.filter((b) => b.kind === 'text' && b.label);
  if (process.argv[2] === '--gen') {
    fs.mkdirSync(S3D, { recursive: true });
    const img = await Jimp.fromBuffer(fs.readFileSync(PNG));
    let n = 0;
    for (const b of targets) {
      const x = Math.max(0, b.x - 2), y = Math.max(0, b.y - 2);       // ★+2px 偏移✓（与 crop 的 -4 边距不同 ✓）
      const w = Math.min(img.width - x, b.w + 4), h = Math.min(img.height - y, b.h + 4);
      if (w < 4 || h < 4) continue;
      const c = img.clone().crop({ x, y, w, h }).resize({ w: Math.round(w * 3), h: Math.round(h * 3) });
      c.contrast(0.15);                                               // ★轻度对比拉伸✓
      fs.writeFileSync(path.join(S3D, b.id + '.png'), await c.getBuffer('image/png'));
      n++;
    }
    console.log('S3（+2px 偏移 + 对比拉伸 ×1.15，放大 ×3）已生成 ' + n + ' 格 → ' + S3D);
    process.exit(0);
  }

  if (process.argv[2] !== '--score') { console.log('用法：node vote3.js --gen | --score'); process.exit(0); }
  /* ★S1 用**我自己那批帧**的整屏 OCR✓（myframes/ocr/ ✓）—— 第一版指向 frames/ocr/ ✗ 那里已被 lead 的帧覆盖 ✓ 会读到 null ✗ */
  const full = readJson(path.join(OUT, 'myframes/ocr/ocr-f000.json')) || readJson(path.join(OUT, 'frames/ocr/ocr-f000.json'));
  if (!full) { console.log('❌ 找不到整屏 OCR（myframes/ocr/ocr-f000.json）'); process.exit(1); }
  const rows = [];
  for (const b of targets) {
    const label = norm(b.label);
    /* S1：整屏里最像的那一行 ✓ */
    let s1 = '', ba = 0;
    for (const L2 of (full.lines || [])) { const t = norm(L2.text); const a = 1 - (label.length ? 0 : 0); if (t.length) { const al = lcsAlign(label, t).filter(Boolean).length / label.length; if (al > ba) { ba = al; s1 = t; } } }
    const s2 = norm((readJson(path.join(OUT, 'crops', b.id + '.json')) || {}).text || '');
    const s3 = norm((readJson(path.join(S3D, b.id + '.json')) || {}).text || '');
    const a1 = lcsAlign(label, s1), a2 = lcsAlign(label, s2), a3 = lcsAlign(label, s3);
    const aligned = [a1, a2, a3];
    const sources = [s1, s2, s3];
    const nonEmpty = sources.filter((s) => s.length > 0).length;   // ★有几个采样真的读到了✓★
    let voted = '', abstain = 0;
    for (let i = 0; i < label.length; i++) {
      const votes = aligned.map((a) => a[i]).filter(Boolean);
      if (nonEmpty <= 1) {
        /* ★修"空样本造成弃权"的逻辑错误（lead 批准 ✓）：只有 1 个采样读到时无从投票 → 直接用它的该位 ✓
           （第一版在这里按"≥2 票"弃权 ✗ → 把唯一一个正确读数丢掉 ✗：B019/B020/B024/B026/B027 都是这样 ✓）
           ★这不是放宽标准✗✓：阈值 0.75 一个字没动 ✓，只是不再把"没读到"当成反对票 ✓。 */
        if (votes.length === 1) voted += votes[0]; else { voted += '?'; abstain++; }
        continue;
      }
      const cnt = {};
      votes.forEach((v) => { cnt[v] = (cnt[v] || 0) + 1; });
      const best = Object.keys(cnt).sort((x, y) => cnt[y] - cnt[x])[0];
      if (best && cnt[best] >= 2) voted += best; else { voted += '?'; abstain++; }
    }
    const cov = (s) => (label.length ? lcsAlign(label, s).filter(Boolean).length / label.length : 0);
    rows.push({ id: b.id, label: b.label, s1, s2, s3, single: cov(s1), crop: cov(s2), s3: cov(s3), voted, votedCov: cov(voted.replace(/\?/g, '')), abstain });
  }
  const before = rows.filter((r) => Math.max(r.single, r.crop) >= 0.75).length;
  const after = rows.filter((r) => r.votedCov >= 0.75).length;
  console.log('=== ③ 3 采样 LCS 对齐逐字投票（弃权位不算对 ✓ 阈值 0.75 不变 ✓）===');
  for (const r of rows) console.log('  ' + r.id + '「' + r.label + '」单次 ' + r.single.toFixed(2) + ' 裁剪 ' + r.crop.toFixed(2) + ' S3 ' + r.s3.toFixed(2)
    + ' → 投票「' + r.voted + '」' + r.votedCov.toFixed(2) + '（弃权 ' + r.abstain + ' 位）' + (r.votedCov >= 0.75 ? ' ✓过' : ' ✗不过'));
  console.log('  ★可过 0.75 的：单次/裁剪择优 ' + before + ' / ' + rows.length + '　→ 三采样投票 ' + after + ' / ' + rows.length + '★');
  fs.writeFileSync(path.join(OUT, 'vote3.json'), JSON.stringify({ at: new Date().toISOString(), rows, before, after }, null, 2));
  console.log('  明细落盘：' + path.join(OUT, 'vote3.json'));
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
