/* score-real.js —— ★在**真实游戏帧**上评分（与合成屏并列，不合并 ✓）★
 * 用法：node app\scripts\gametest\score-real.js [--truth=...\fixtures\real-truth.json] [--tolPx=6]
 * 判定：与合成屏同口径 ✓（中心落在目标框内或误差 ≤ tolPx ✓）
 * 路线：icon → icon_lib 模板匹配（真机职业列的已知有效路 ✓）+ icon_scan 几何；text → locate（OCR 词组 + 容错 ✓）
 * ★真实帧上"该帧有什么类别就报什么类别"✓ 不硬凑四类 ✓★
 */
'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const getArg = (k, d) => { const m = argv.find((a) => a.startsWith('--' + k + '=')); return m ? m.split('=')[1] : d; };
const TRUTH = getArg('truth', 'C:/deepseek/desktop-pet/app/scripts/fixtures/real-truth.json');
const TOL = Number(getArg('tolPx', 6));

const OC = require(path.join(APP, 'src/ownclick'));
const IC = require(path.join(APP, 'src/iconcut'));
IC.install({ space: () => ({ w: 1920, h: 1080 }), display: () => ({ w: 1920, h: 1080, scaleFactor: 1 }) });

function ocrOf(png, outJson) {
  /* ★先读已有文件✗→✓★：本会话里 Node→PowerShell 的 spawn 不可靠 ✗（会写出空文件 ✗ 把预生成的 OCR 覆盖掉 ✓
     —— 第一版就是这样把 4,773 字节的 OCR 覆盖成不可解析 ✗ 导致"真实帧 text 全 notfound" ✓）。
     现在：文件已在就直接读 ✓，只有缺了才尝试 spawn ✓。 */
  if (fs.existsSync(outJson)) {
    try { return JSON.parse(fs.readFileSync(outJson, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { /* 落到 spawn ✓ */ }
  }
  const { spawnSync } = require('child_process');
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'shoot-ocr.ps1'), '-Png', png, '-Out', outJson], { stdio: 'ignore', windowsHide: true });
  try { return JSON.parse(fs.readFileSync(outJson, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; }
}

(async () => {
  const T = JSON.parse(fs.readFileSync(TRUTH, 'utf8'));
  const byCat = {};
  console.log('=== ★真实游戏帧评分★（容差 ' + TOL + 'px；真值 = ' + path.basename(TRUTH) + ' ✓）===');
  for (const fr of T.frames) {
    if (!fs.existsSync(fr.file)) { console.log('  帧缺文件：' + fr.file); continue; }
    const ocr = ocrOf(fr.file, path.join('C:/deepseek/gametest', 'real-' + fr.id + '.json'));
    const words = ocr ? (ocr.lines || []).reduce((n, L) => n + ((L.words || []).length), 0) : 0;
    console.log('  帧 ' + fr.id + '：OCR ' + (ocr ? (ocr.lines || []).length + ' 行 / ' + words + ' 词' : '失败 ✗') + '　类别 ' + fr.categories.join(','));
    /* icon 类：★先用 icon_lib 模板匹配（真机职业列那条已知有效的路 ✓）★，再用 icon_scan 几何兜底 */
    let icons = [];
    try {
      const r = await IC.scan(fr.file, { mode: 'auto', region: { x0: 1770, y0: 40, x1: 1919, y1: 1040 }, dir: 'v' });
      icons = (r.items || []).map((i) => ({ cx: i.cx, cy: i.cy, src: r.mode }));
      console.log('     icon 路线：' + r.mode + ' ✓ 检出 ' + icons.length + ' 个' + (r.spacing != null ? ('，格距 ' + Number(r.spacing).toFixed(1) + 'px ✓') : ''));
    } catch (e) { console.log('     icon 路线异常：' + String(e.message).slice(0, 60)); }
    for (const it of fr.items) {
      const cat = fr.categories.indexOf('icon') >= 0 && it.kind === 'icon' ? 'icon' : 'text';
      byCat[cat] = byCat[cat] || { n: 0, hit: 0, errs: [], notes: {} };
      const c = byCat[cat]; c.n++;
      let cx = null, cy = null, verdict = 'notfound';
      if (it.kind === 'icon') {
        const near = icons.map((g) => ({ g, d: Math.hypot(g.cx - (it.x + it.w / 2), g.cy - (it.y + it.h / 2)) })).sort((a, b) => a.d - b.d)[0];
        if (near) { cx = near.g.cx; cy = near.g.cy; verdict = near.d <= Math.max(TOL, it.w / 2) ? 'ok' : 'wrong'; }
      } else {
        if (ocr) {
          let boxes = OC.phrasesFromOcr(ocr, it.label);
          if (!boxes.length) { const fz = OC.fuzzyFromOcr(ocr, it.label, {}); if (fz.best) boxes = [fz.best]; }
          const best = boxes.map((b) => ({ b, d: Math.hypot(b.cx - (it.x + it.w / 2), b.cy - (it.y + it.h / 2)) })).sort((a, b) => a.d - b.d)[0];
          if (best) { cx = best.b.cx; cy = best.b.cy; verdict = best.d <= Math.max(TOL, it.w / 2) ? 'ok' : 'wrong'; }
        }
      }
      if (verdict === 'ok') { c.hit++; c.errs.push(Math.hypot(cx - (it.x + it.w / 2), cy - (it.y + it.h / 2))); }
      else c.notes[verdict] = (c.notes[verdict] || 0) + 1;
      console.log('     ' + it.id + '「' + (it.label || '（图形）') + '」→ ' + verdict + (cx != null ? ('　判定中心 (' + cx + ',' + cy + ')') : ''));
    }
  }
  const stat = (a) => { if (!a.length) return { n: 0, mean: 0, p95: 0, max: 0 }; const s = a.slice().sort((x, y) => x - y); return { n: s.length, mean: s.reduce((p, c) => p + c, 0) / s.length, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] }; };
  console.log('');
  console.log('=== 真实帧分类结果（★与合成屏 80.4% 并列，不合并 ✓）===');
  let n = 0, hit = 0;
  for (const k of Object.keys(byCat)) {
    const c = byCat[k]; const e = stat(c.errs);
    n += c.n; hit += c.hit;
    console.log('  ' + k.padEnd(6) + c.hit + '/' + c.n + ' = ' + (c.n ? (c.hit / c.n * 100).toFixed(1) : '0.0') + '%　'
      + JSON.stringify(c.notes) + (e.n ? ('　中心误差 平均 ' + e.mean.toFixed(1) + ' / p95 ' + e.p95.toFixed(1) + ' / 最大 ' + e.max.toFixed(1) + 'px') : ''));
  }
  console.log('  ★真实帧总 ' + hit + '/' + n + ' = ' + (n ? (hit / n * 100).toFixed(1) : '0.0') + '%★　（合成屏 80.4% ✓ 两个数字并列 ✓ 不平均 ✗）');
  fs.writeFileSync('C:/deepseek/gametest/score-real.json', JSON.stringify({ at: new Date().toISOString(), tol: TOL, byCat }, null, 2));
  console.log('  明细落盘：C:/deepseek/gametest/score-real.json');
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
