/* test-ownclick.js —— ★用**真实候选数据**测几何归属（纯函数 ✓ 不依赖屏幕 ✓）★
 *
 * 数据来源：主人今晚那份真实 OCR JSON（1920x1080 物理像素 ✓）
 *   fixtures/look-ocr.json —— 结构 {ok,imgW,imgH,text,lines:[{text,words:[{t,x,y,w,h}]}]} ✓
 *
 * 要钉死的（对应 lead 的红线 7 与验收基准 ✓）：
 *   ① 四个「编辑队列」候选 → 必须配出 ★会客室 = (893,337)★ ✓
 *   ② ★聊天窗那处 (322,791) 必须被排除★ ✓
 *   ③ (893,605) 归属 ★制造站1★ ✓（＝主人看到她点错的那一格 ✓）
 *   ④ 归属不确定的情形必须报"不确定"✓ 不许硬选 ✗
 *   ⑤ 判据核对：缺关键词必须报失败 ✓；"屏幕变了"不能当成功 ✓
 *
 * ★教训（自己踩的 ✗）★：这个文件曾被 PowerShell 的 `-replace + Set-Content` 改过 → 中文全变乱码 ✗。
 *   ★以后改 JS 只用文件工具，绝不用 PowerShell 文本替换 ✗★（red line 3 的同源教训 ✓）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OC = require('../src/ownclick');

let pass = 0, fail = 0;
function ok(c, label, extra) {
  if (c) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

const ocr = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'look-ocr.json'), 'utf8'));
const buttons = OC.phrasesFromOcr(ocr, '编辑队列');
const rooms = OC.phrasesFromOcr(ocr, '会客室');
const stations = OC.phrasesFromOcr(ocr, '制造站');

console.log('=== test-ownclick（真实候选数据）===');
console.log('  候选「编辑队列」' + buttons.length + ' 个：' + buttons.map((b) => '(' + b.cx + ',' + b.cy + ')').join(' '));
console.log('  容器「会客室」' + rooms.length + ' 个：' + rooms.map((b) => '(' + b.cx + ',' + b.cy + ')').join(' '));
console.log('  容器「制造站」' + stations.length + ' 个：' + stations.map((b) => '(' + b.cx + ',' + b.cy + ')').join(' '));

/* ① 词组框与 lead 给的精确框一致 ✓ */
const centers = buttons.map((b) => b.cx + ',' + b.cy).join(' ');
ok(centers === '893,337 893,605 893,820 322,791', '① 四个候选框中心与 lead 给的完全一致', centers);
const r160 = rooms.find((r) => r.cy === 160);
ok(!!r160 && r160.x === 787 && r160.y === 144 && r160.w === 96 && r160.h === 31, '① 会客室标题框 = x787 y144 w96 h31（lead 给的 ✓）',
  r160 ? JSON.stringify({ x: r160.x, y: r160.y, w: r160.w, h: r160.h }) : '缺');

/* ② 归属：会客室 → (893,337) ✓；聊天窗那处被排除 ✓ */
const res = OC.pairOwners(buttons, rooms, {});
const owned = OC.ownedBy(res, '会客室');
ok(owned.length === 1, '② ★「会客室」唯一归属★（正好一个 ✓ 不硬选 ✓）', 'pairs=' + res.pairs.length + ' owned=' + owned.length);
ok(owned.length === 1 && owned[0].button.cx === 893 && owned[0].button.cy === 337,
  '② ★★会客室 → (893,337)★★（lead 的验收基准 ✓）', owned.length ? '(' + owned[0].button.cx + ',' + owned[0].button.cy + ')' : '-');
const exChat = res.excluded.find((e) => e.button.cx === 322);
ok(!!exChat, '② ★聊天窗那处 (322,791) 被排除★', exChat ? exChat.why.slice(0, 58) : '没排除 ✗');
/* ★这里只有 1 对是正确的✗→✓★：容器只有「会客室」✓，而 (893,605)/(893,820) 属于制造站那两张卡片 ✓
   → 它们**离会客室太远**（378px / 593px，上限 313px ✓）→ 必须被排除 ✓
   （★如果这里硬凑出 3 对，那才是 bug ✗ —— 正是"没有归属概念"的老毛病 ✓）。 */
ok(res.pairs.length === 1 && res.excluded.length === 3, '② 只配出 1 对（会客室）✓，另 3 个被排除（聊天窗 1 + 离得太远 2）✓',
  'pairs=' + res.pairs.length + ' excluded=' + res.excluded.length);
ok(res.pairs.every((p) => p.button.cx === 893 && OC.norm(p.title.lineText) === '会客室'), '② 唯一那一对确实是「会客室」的 ✓');
const stRes0 = OC.pairOwners(buttons, stations, {});
/* ★修完"按钮不可能属于它上方的卡片"之后，正确期望是 2 对 ✗→✓★：
   (893,605)→制造站1 ✓、(893,820)→制造站2 ✓；另 2 个排除 = (893,337)【在所有标题之上 ✗】+ (322,791)【不在列内 ✗】 */
ok(stRes0.pairs.length === 2 && stRes0.excluded.length === 2, '② 换成「制造站」当容器时：2 对（制造站1/制造站2）✓ + 2 排除（在上方 / 在别的窗口）✓',
  'pairs=' + stRes0.pairs.length + ' excluded=' + stRes0.excluded.length);
ok(res.column.offColumn.length === 1 && res.column.offColumn[0].cx === 321,
  '② ★列聚类生效★：聊天窗那个同名「会客室」(321,565) 被认出"不在这一列" ✓',
  'offColumn=' + JSON.stringify(res.column.offColumn.map((t) => t.cx + ',' + t.cy)));

/* ③ 制造站1 = (893,605) ✓（她点错的那一格） */
const stRes = OC.pairOwners(buttons, stations, {});
const s1 = stRes.pairs.filter((p) => OC.norm(p.title.lineText) === '制造站1');
ok(s1.length === 1 && s1[0].button.cy === 605, '③ ★(893,605) 归属「制造站1」★（= 主人看到她点错那格 ✓）',
  s1.length ? '(' + s1[0].button.cx + ',' + s1[0].button.cy + ')' : 'pairs=' + stRes.pairs.length);
const ownedS = OC.ownedBy(stRes, '制造站1');
ok(ownedS.length === 1 && ownedS[0].button.cy === 605, '③ 用「制造站1」当容器关键词 → 唯一命中 (893,605) ✓');

/* ④ 不确定的情形（都必须报不确定 ✓ 不许硬选 ✗） */
const amb = OC.ownedBy(stRes, '制造站');
ok(amb.length === 2, '④ ★容器关键词有歧义（"制造站"匹配 2 个房间）→ 不是唯一 → 报不确定 ✓★', '命中 ' + amb.length + ' 个');
const noTitle = OC.pairOwners(buttons, [], {});
ok(noTitle.verdict === 'uncertain' && noTitle.pairs.length === 0, '④ 没有容器候选 → 不确定、一个都不配 ✓', noTitle.verdict);
const farAway = OC.pairOwners([{ text: '编辑队列', lineText: '编辑队列', cx: 893, cy: 3000, x: 846, y: 2990, w: 94, h: 22 }], rooms, {});
ok(farAway.verdict === 'uncertain' && farAway.pairs.length === 0, '④ 候选离上方标题太远（y=3000）→ 不确定 ✓', farAway.excluded.length ? farAway.excluded[0].why.slice(0, 46) : '-');
const tie = OC.pairOwners([{ text: '编辑队列', lineText: '编辑队列', cx: 893, cy: 400, x: 846, y: 390, w: 94, h: 22 }],
  [{ text: '会客室', lineText: '会客室', cx: 835, cy: 390, x: 787, y: 376, w: 96, h: 31 }, { text: '制造站1', lineText: '制造站1', cx: 837, cy: 395, x: 788, y: 380, w: 97, h: 32 }], {});
ok(tie.verdict === 'uncertain' && tie.pairs.length === 0, '④ 两个标题一样近（差 5px）→ 不确定 ✓', tie.excluded.length ? tie.excluded[0].why.slice(0, 46) : '-');
/* 容器包含（规则 B ✓）：给卡片矩形时按包含关系配 ✓ */
const cardRes = OC.pairOwners(buttons, rooms, { cards: [{ x: 780, y: 140, w: 170, h: 230, text: '会客室' }, { x: 780, y: 400, w: 170, h: 240, text: '制造站1' }] });
ok(cardRes.method === 'container' && OC.ownedBy(cardRes, '会客室').length === 1, '④ 规则 B（给卡片矩形）也给出会客室归属 ✓', 'method=' + cardRes.method);

/* ⑤ 判据核对 + 像素差只当参考 ✓ */
const okV = OC.verifyCriteria('会客室 房间2/12 当前进驻 预设队列（2/3） 队列1', ['会客室', '预设队列']);
ok(okV.ok, '⑤ 判据全中 → 成功 ✓');
const badV = OC.verifyCriteria('制造站1 房间1/12 当前进驻 预设队列 队列1', ['会客室', '预设队列']);
ok(!badV.ok && badV.missing.join(',') === '会客室', '⑤ ★点错房间（画面里缺会客室）→ 判失败 ✓★', JSON.stringify(badV.missing));
const emptyV = OC.verifyCriteria('随便什么', []);
ok(!emptyV.ok && emptyV.empty, '⑤ 没有判据 → 一律不算成功 ✓（"屏幕变了"不能当证据 ✗）');
const d1 = OC.diffStats([0, 0, 0, 0], [10, 0, 200, 0]);
ok(d1.changedRatio === 0.25 && d1.mean > 0, '⑤ 像素差统计可用（变化像素 25% ✓）', JSON.stringify({ mean: +d1.mean.toFixed(1), r: d1.changedRatio }));
const d2 = OC.diffStats([1, 2, 3], [1, 2, 3]);
ok(d2.changedRatio === 0, '⑤ 完全相同的两帧 → 变化 0 ✓');

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
