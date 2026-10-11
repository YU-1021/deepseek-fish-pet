/* anchor.js 单元测试（全纯逻辑）
 * 跑法：node app/scripts/test-anchor.js */
const AN = require('../src/anchor');
let pass = 0, fail = 0;
function ok(c, l, e) { if (c) { pass++; console.log('  ✅ ' + l + (e ? '   ' + e : '')); } else { fail++; console.log('  ❌ ' + l + (e ? '   ' + e : '')); } }

console.log('=== anchor.js 单元测试 ===');
const words = [
  { t: '公', x: 100, y: 200, w: 14, h: 16 },
  { t: '招', x: 114, y: 200, w: 14, h: 16 },
  { t: '计', x: 128, y: 200, w: 14, h: 16 },
  { t: '算', x: 142, y: 200, w: 14, h: 16 },
  { t: '最低 6★', x: 400, y: 500, w: 60, h: 16 },
  { t: '4 位候选', x: 520, y: 500, w: 70, h: 16 },
  { t: '最低 6★', x: 400, y: 760, w: 60, h: 16 },
  { t: '2 位候选', x: 520, y: 760, w: 70, h: 16 },
];

/* §1 找锚点：字符串 / 正则 / 优先级 */
{
  const a = AN.findAnchor(words, ['位候选']);
  ok(a.ok && a.text === '4 位候选', '§1 按子串找到第一个"位候选"', a.ok ? a.text : a.reason);
  const b = AN.findAnchor(words, ['位候选'], { order: 'bottom' });
  ok(b.ok && b.text === '2 位候选', '§1 order=bottom 时取最靠下的', b.text);
  const c = AN.findAnchor(words, [/^最低/]);
  ok(c.ok && c.text.indexOf('最低') >= 0, '§1 支持正则');
  const d = AN.findAnchor(words, ['不存在的词', '位候选']);
  ok(d.ok && d.matchedBy === '位候选', '§1 第一个 pattern 没命中就试下一个');
  const e = AN.findAnchor(words, ['完全不存在的词']);
  ok(e.ok === false && e.reason === 'anchor-not-found', '§1 找不到时明确报 anchor-not-found');
  ok(e.tried && e.tried.length === 1, '§1 报出试过哪些 pattern');
}

/* §2 ★roiBelow：这是"按锚点定位 ROI"的核心，替代了那个会裁错的百分比方案★ */
{
  const a = AN.findAnchor(words, ['位候选']);
  const r = AN.roiBelow(a, { gap: 20, width: 900, height: 300, padLeft: 0 });
  ok(r.y === 500 + 16 + 20, '§2 ROI 的 y = 锚点底边 + gap', 'y=' + r.y);
  ok(r.w === 900 && r.h === 300, '§2 宽高按参数');
  ok(r.x === Math.round(a.rect.x), '§2 x 默认对齐锚点左边', 'x=' + r.x);
  ok(AN.roiBelow(null) === null, '§2 没锚点 → null（不猜）');
}

/* §3 roiAround：核对"这个元素是什么"时用 */
{
  const a = AN.findAnchor(words, ['位候选']);
  const r = AN.roiAround(a, { padX: 30, padY: 10, extraBottom: 40 });
  ok(r.x === Math.round(a.rect.x) - 30, '§3 左边扩 padX');
  ok(r.h === Math.round(a.rect.h) + 20 + 40, '§3 高度含 extraBottom（卡片名在下方时要留出空间）');
}

/* §4 clampRoi：夹进屏幕 / 安全区 */
{
  const r = AN.clampRoi({ x: -50, y: -20, w: 3000, h: 2000 }, { x: 0, y: 0, w: 1920, h: 1080 });
  ok(r.x === 0 && r.y === 0 && r.w === 1920 && r.h === 1080, '§4 越界被夹到边界', JSON.stringify(r));
  const r2 = AN.clampRoi({ x: 1900, y: 1070, w: 100, h: 100 }, { x: 0, y: 0, w: 1920, h: 1080 });
  ok(r2.w >= 20 && r2.h >= 20, '§4 贴边时仍保证最小 20x20', JSON.stringify(r2));
  ok(AN.clampRoi(null) === null, '§4 null 进 null 出');
}

/* §5 pickBest：多个锚点里挑 */
{
  /* ⚠️ 正则要按【归一化后】的文本写：findAnchor 会先去掉空白，所以写 '4 位候选' 是匹配不到的（我第一版就错在这） */
  const list = [AN.findAnchor(words, [/^4位候选/]), AN.findAnchor(words, [/^2位候选/])];
  ok(AN.pickBest(list).text === '4 位候选', '§5 默认取最靠上的');
  ok(AN.pickBest(list, { order: 'bottom' }).text === '2 位候选', '§5 order=bottom 取最靠下的');
  ok(AN.pickBest(list, { index: 1 }).text === '2 位候选', '§5 可按序号取');
  ok(AN.pickBest([]) === null, '§5 空列表 → null');
  ok(AN.pickBest(list, { index: 99 }).text === '2 位候选', '§5 序号越界时夹到最后一个（不崩）');
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
