/* verify-round.js —— ① 页面上**不存在**的字符串当反例（防误配 ✓）② icon 22.8px 那一格的根因判定 ✓ */
'use strict';
const fs = require('fs');
const path = require('path');
const OC = require('../../src/ownclick');
const L = require('./layout');

/* ★读**我自己那批帧**的整屏 OCR（myframes/ocr/ ✓）—— 第一版指向 frames/ocr/ ✗ 那里已被 lead 的帧覆盖 → ENOENT ✗ */
const full = JSON.parse(fs.readFileSync('C:/deepseek/gametest/myframes/ocr/ocr-f000.json', 'utf8').replace(/^\uFEFF/, ''));
const norm = OC.normTxt;
console.log('=== ① 防误配：用**页面上不存在**的字符串当反例（阈值 0.75 不变 ✓）===');
for (const neg of ['取消订单', '设置面板', '确认取消', '编辑信息', '加号设置', '进驻上限值', '贸易站点']) {
  const fz = OC.fuzzyFromOcr(full, neg, {});
  const exact = OC.phrasesFromOcr(full, neg).length;
  console.log('  「' + neg + '」精确 ' + exact + ' 个　容错命中 ' + fz.all.length + ' 个'
    + (fz.best ? ('　最佳「' + fz.best.read + '」分数 ' + fz.best.score) : '　（无 ✓ 未匹上 ✓）')
    + (fz.all.length === 0 ? ' ✓' : ' ★要回退形近字表✗★'));
}

console.log('');
console.log('=== ② icon 最大误差 22.8px：单格根因判定 ===');
const score = JSON.parse(fs.readFileSync('C:/deepseek/gametest/score.json', 'utf8'));
const worst = (score.rows || []).filter((r) => r.kind === 'icon' && r.verdict === 'ok')
  .map((r) => ({ r, d: Math.hypot(r.cx - r.truth.x, r.cy - r.truth.y) }))
  .sort((a, b) => b.d - a.d).slice(0, 3);
const IC = require('../../src/iconcut');
(async () => {
  IC.install({ space: () => ({ w: 1920, h: 1080 }), display: () => ({ w: 1920, h: 1080, scaleFactor: 1 }) });
  const Jimp = require('jimp').Jimp;
  const png = 'C:/deepseek/gametest/frames/f000.png';
  const img = await Jimp.fromBuffer(fs.readFileSync(png));
  for (const w of worst) {
    const t = L.buttons.find((b) => b.id === w.r.id) || null;
    console.log('  ' + w.r.id + '（icon）真值中心 (' + w.r.truth.x + ',' + w.r.truth.y + ') 判定中心 (' + w.r.cx + ',' + w.r.cy
      + ')　误差 ' + w.d.toFixed(1) + 'px');
    if (t) {
      /* 在真值框附近量出实际连通块（判定 漏切 / 误合并 / 质心被拉走 ✓） */
      const reg = { x0: Math.max(0, t.x - 60), y0: Math.max(0, t.y - 60), x1: Math.min(1919, t.x + t.w + 60), y1: Math.min(1079, t.y + t.h + 60) };
      const r = await IC.scan(png, { mode: 'b', region: reg });
      const items = (r.items || []).map((it) => ({ it, d: Math.hypot(it.cx - w.r.truth.x, it.cy - w.r.truth.y) })).sort((a, b) => a.d - b.d);
      console.log('     真值框 ' + t.w + 'x' + t.h + '　附近连通块 ' + items.length + ' 个 → '
        + items.slice(0, 3).map((x) => '(' + x.it.cx + ',' + x.it.cy + ') ' + x.it.w + 'x' + x.it.h + ' d=' + x.d.toFixed(1)).join('　'));
      const near = items[0];
      if (!near) console.log('     → ★漏切✗★：附近一个块都没检出 ✓');
      else {
        const bigW = near.it.w > t.w * 1.8 || near.it.h > t.h * 1.8;
        console.log('     → 判定：' + (bigW ? '★误合并✗★（块 ' + near.it.w + 'x' + near.it.h + ' 远大于图标 ' + t.w + 'x' + t.h + ' → 几个图标被并成一个 ✓）'
          : (near.d > 4 ? '★质心被邻近元素拉走✗★（块尺寸正常但中心偏 ' + near.d.toFixed(1) + 'px ✓）' : '★漏切/配对错✗★（最近块都差 ' + near.d.toFixed(1) + 'px ✓）')));
      }
      /* 单格存图（留证据 ✓） */
      const c = img.clone().crop({ x: Math.max(0, t.x - 40), y: Math.max(0, t.y - 40), w: Math.min(img.width - Math.max(0, t.x - 40), t.w + 80), h: Math.min(img.height - Math.max(0, t.y - 40), t.h + 80) });
      fs.writeFileSync('C:/deepseek/gametest/icon-worst-' + t.id + '.png', await c.getBuffer('image/png'));
      console.log('     单格存图：C:/deepseek/gametest/icon-worst-' + t.id + '.png ✓');
    }
  }
})();
