/* calib-region.js —— ★标定 region 外扩余量 M：拿 3 条"读对却被区域丢掉"的真实案例量距离★
 * 案例：B019「商店」（读到「信用商店」1.00）、B020「招募」（「公开招募」1.00）、B026「设置」（「设置」1.00）
 * 量法：读出命中的**那个 OCR 词框**，看它的中心离按钮框有多远 ✓ → M 取实测最大值再留余量 ✓（有依据 ✓ 不是拍脑袋）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OC = require('../../src/ownclick');
const L = require('./layout');

const full = JSON.parse(fs.readFileSync('C:/deepseek/gametest/frames/ocr/ocr-f000.json', 'utf8').replace(/^\uFEFF/, ''));
const cases = ['B019', 'B020', 'B026'];
for (const id of cases) {
  const b = L.buttons.find((x) => x.id === id);
  if (!b) { console.log(id + ' 不在 layout 里'); continue; }
  const boxes = OC.phrasesFromOcr(full, b.label);
  const fz = OC.fuzzyFromOcr(full, b.label, {});
  const best = boxes[0] || (fz && fz.best) || null;
  const r = { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
  if (!best) { console.log(id + ' 「' + b.label + '」整屏里没有可用的框 ✗'); continue; }
  const dx = best.cx < r.x0 ? r.x0 - best.cx : (best.cx > r.x1 ? best.cx - r.x1 : 0);
  const dy = best.cy < r.y0 ? r.y0 - best.cy : (best.cy > r.y1 ? best.cy - r.y1 : 0);
  console.log(id + ' 「' + b.label + '」按钮 ' + JSON.stringify(r) + '　命中框中心 (' + best.cx + ',' + best.cy + ')'
    + '　★越界 dx=' + dx + ' dy=' + dy + ' 距离=' + Math.round(Math.hypot(dx, dy)) + 'px★　读到「' + (best.read || best.lineText) + '」');
}
