/* framediff.js 的单元测试 —— 纯 Node（不需要 electron、不需要屏幕）
 * 跑法：node app/scripts/test-framediff.js
 */
const F = require('../src/framediff');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

const W = 100, H = 60;
/* ⚠️ alpha 一律 255（真实 BGRA 就是这样）。第一版把 alpha 也填成 v，
   于是 paint() 把它改成 255 时单是 alpha 就差 225 —— §6 因此误判（我测试自己的 bug）。 */
function blank(v) {
  const b = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { const p = i * 4; b[p] = b[p+1] = b[p+2] = (v == null ? 30 : v); b[p+3] = 255; }
  return b;
}
function paint(buf, x, y, w, h, val) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
    const p = (j * W + i) * 4;
    buf[p] = val; buf[p + 1] = val; buf[p + 2] = val; buf[p + 3] = 255;
  }
  return buf;
}

console.log('=== framediff.js 单元测试（纯 Node）===');

/* §1 完全一样 → 没变 */
{
  const a = blank(30), b = blank(30);
  const r = F.diffBgra(a, b, W, H);
  ok(r.ok && r.changed === false && r.ratio === 0, '§1 两张全同 → 没变化', 'ratio=' + r.ratio);
  ok(r.box === null, '§1 没变化时不报区域');
  ok(/没有变化/.test(F.summarize(r, 1)), '§1 回执说"没有变化"');
}

/* §2 一大块变了 → 变了，而且报出变化区域 */
{
  const a = blank(30), b = blank(30);
  paint(b, 20, 10, 30, 20, 220);                   // 600 像素 / 6000 = 10%
  const r = F.diffBgra(a, b, W, H);
  ok(r.ok && r.changed === true, '§2 10% 的像素变了 → 判定"变了"', 'ratio=' + r.ratio);
  ok(r.box && r.box.x === 20 && r.box.y === 10 && r.box.w === 30 && r.box.h === 20,
    '§2 ★变化区域正好是那一块', JSON.stringify(r.box));
  const s = F.summarize(r, 1);
  ok(/界面变了/.test(s) && /20,10/.test(s.replace(/\s/g, '')), '§2 回执说清"变了"并给出区域', s.slice(0, 90));
}

/* §3 只有零星噪声 → 算"没变"（这正是**关键的**：她滚动后画面只有轻微抖动，不能误报"变了"） */
{
  const a = blank(30), b = blank(30);
  for (let i = 0; i < 6; i++) paint(b, i, i, 1, 1, 220);   // 6 / 6000 = 0.1% < 0.2%
  const r = F.diffBgra(a, b, W, H);
  ok(r.ok && r.changed === false, '§3 0.1% 的零星噪声 → 仍是"没变化"', 'ratio=' + r.ratio);
}

/* §4 刚好越过阈值的差一点点 → 会变"变了"（阈值可调，行为可预测） */
{
  const a = blank(30), b = blank(30);
  paint(b, 0, 0, 13, 1, 220);                       // 13/6000 = 0.217% > 0.2%
  ok(F.diffBgra(a, b, W, H).changed === true, '§4 0.217% → 判"变了"（刚好过阈值）');
  const r = F.diffBgra(a, b, W, H, { changedRatio: 0.01 });
  ok(r.changed === false, '§4 把阈值调到 1% → 同样的图判"没变"（阈值真的在起作用）');
}

/* §5 buffer 尺寸不对 → 报错而不是崩 */
{
  const r = F.diffBgra(Buffer.alloc(10), Buffer.alloc(10), W, H);
  ok(r.ok === false && /尺寸不对/.test(r.error), '§5 尺寸不对时给出可读错误', r.error);
}

/* §6 阈值以下的小变化不计入 changedPixels（不然"变了多少"会虚高） */
{
  const a = blank(30), b = blank(30);
  paint(b, 0, 0, 5, 1, 42);                         // 每通道差 12，合计 36 > 24 → 算变化
  const c = blank(30);
  paint(c, 0, 0, 5, 1, 34);                         // 每通道差 4，合计 16 < 24 → 不算
  const r1 = F.diffBgra(a, b, W, H);
  const r2 = F.diffBgra(a, c, W, H);
  ok(r1.changedPixels === 5, '§6 明确的变化算进去', 'changedPixels=' + r1.changedPixels);
  ok(r2.changedPixels === 0, '§6 阈值以下的微差不算（防虚高）', 'changedPixels=' + r2.changedPixels);
}

/* §7 区域还原（比对用的是缩小图，坐标要乘回去） */
{
  const box = { x: 10, y: 20, w: 30, h: 40 };
  const s = F.scaleBox(box, 4);
  ok(s.x === 40 && s.y === 80 && s.w === 120 && s.h === 160, '§7 区域按倍率还原正确', JSON.stringify(s));
  ok(F.scaleBox(null, 4) === null, '§7 没有区域时返回 null');
}

/* §8 summarize 在"变了"时提示"接着做下一步"，在"没变"时提示"换个做法别重复" */
{
  const a = blank(30), b = blank(30);
  paint(b, 0, 0, 50, 50, 220);
  const s1 = F.summarize(F.diffBgra(a, b, W, H), 2);
  ok(/生效了/.test(s1) && /接着做下一步/.test(s1), '§8 变了 → 提示继续');
  const s2 = F.summarize(F.diffBgra(a, blank(30), W, H), 2);
  ok(/没生效/.test(s2) && /不要再用同一个动作重复/.test(s2), '§8 没变 → 提示换做法（这是她最需要的一句）');
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
