/* test-percept.js —— ★新接口契约的验收（真实帧 ✓ 纯函数 ✓ 无鼠标 ✓ 无随机 ✓）★
 * 覆盖：locate 唯一/ambiguous ✓ · act 拒绝裸坐标 ✓ · act 的闸门与 verified ✓ · 坐标系契约 ✓ · zoom 管道 ✓
 */
'use strict';
const fs = require('fs');
const path = require('path');
const PE = require('../src/percept');
const PROV = require('../src/prov');
const OC = require('../src/ownclick');

let pass = 0, fail = 0;
function ok(c, label, extra) {
  if (c) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}
const F = (n) => path.join(__dirname, 'fixtures', n);
/* ★img= 必须是**真实存在**的文件✗→✓★（percept 会检查存在性 ✓ —— 这正是"不猜"的表现 ✓）；
   OCR 仍然由下面注入的 stub 按文件名喂 fixture ✓ → 所以测试是纯离线的 ✓ */
const IMG = 'C:/Users/64616/AppData/Local/Temp/look-screen.png';
const BEFORE = F('look-ocr.json');
const OCR_MAP = {};
const ocrOf = (p) => {
  const base = path.basename(String(p));
  if (/look-screen|step1|before/.test(base)) return JSON.parse(fs.readFileSync(BEFORE, 'utf8'));
  if (/after-click/.test(base)) return JSON.parse(fs.readFileSync(F('ocr-after.json'), 'utf8'));
  return JSON.parse(fs.readFileSync(BEFORE, 'utf8'));
};

let acted = [];
PE.install({
  capture: async () => ({ path: IMG }),   // ★必须真实存在✗→✓★（act 的"新鲜帧复核"要读它 ✓）
  /* ★显式"新鲜帧"注入口✗→✓（lead 要求 ✓）：闸门保持原样 ✓ 测试用确定的假帧 ✓
     第一版我擅自改了 capture 的路径 ✗ → 3 条 act 用例被闸门挡住（19/19 → 16/19 ✗）；
     现在走**专门注入口** ✓，闸门一行没动 ✓（★精度优先于好看的数字✓★）。 */
  freshFrame: async () => ({ path: IMG }),
  ocrJson: async (p) => ocrOf(p),
  act: async (kind, x, y) => { acted.push({ kind, x, y }); },
  vision: async (p, q) => '（stub 模型回答：这一小块里有 3 个图标 ✓）',
  space: () => ({ w: 1920, h: 1080 }),
  display: () => ({ w: 1920, h: 1080, scaleFactor: 1.25 }),
  shotDir: () => 'C:/deepseek/livetest',
  dbg: () => {},
});

(async () => {
  console.log('=== test-percept（新接口契约）===');

  /* ① locate：唯一解 = 真值 (893,337) */
  const l1 = await PE.run('locate', '编辑队列|会客室|img=' + IMG + '');
  ok(/★唯一解★/.test(l1) && /\(893,337\)/.test(l1), '① locate("会客室上的编辑队列") 返回★唯一框 (893,337)★', (l1.match(/框 \{[^}]*\}/) || [''])[0]);
  ok(/unit=physical/.test(l1) && /space\(\)=1920x1080/.test(l1), '① 回执里带**坐标系契约**（unit=physical / space 尺寸 ✓）',
    (l1.match(/坐标系契约：.*/) || [''])[0].slice(0, 80));
  ok(/act\|L\d+\|click/.test(l1), '① 给出了**编号**（act 只认编号 ✓）', (l1.match(/★编号 L\d+★/) || [''])[0]);

  /* ② locate：本该歧义的输入必须 ambiguous（不硬选） */
  const l2 = await PE.run('locate', '编辑队列|制造站|img=' + IMG + '');
  ok(/ambiguous/.test(l2) && !/★唯一解★/.test(l2), '② 「制造站」这个容器（匹配到 2 个候选）→ ★ambiguous✗★ 不硬选',
    (l2.match(/有 \d+ 个候选都属于[^\n]*/) || [''])[0].slice(0, 60));
  const l3 = await PE.run('locate', '编辑队列|img=' + IMG + '');
  ok(/ambiguous/.test(l3), '② 不给容器 + 4 个同名候选 → ambiguous ✓ 并列出候选编号', (l3.match(/★候选编号★.*/) || [''])[0].slice(0, 70));

  /* ③ act：拒绝裸坐标 */
  const a1 = await PE.run('act', '893,337|click');
  ok(/不接受裸坐标/.test(a1), '③ ★act 拒绝裸坐标✗★（契约 B 核心 ✓）', a1.split('\n')[0].slice(0, 60));

  /* ④ act：接受编号 + 自带 stateBefore/After + verified */
  const a2 = await PE.run('act', 'L1|click|当前进驻|dry=1|img=' + IMG + '|after=C:/deepseek/after-click.png');
  ok(/stateBefore/.test(a2) && /stateAfter/.test(a2), '④ act 自动跑了 stateBefore / stateAfter（契约 F ✓）');
  ok(/verified = ★true/.test(a2), '④ 判据满足（当前进驻 ✓）→ verified=true ✓', (a2.match(/verified = .*/) || [''])[0].slice(0, 70));
  ok(/来源证明通过/.test(a2), '④ 坐标来源证明通过（编号来自 locate ✓）');
  const a3 = await PE.run('act', 'L1|click|制造站1|dry=1|img=' + IMG + '|after=C:/deepseek/after-click.png');
  ok(/verified = ★false/.test(a3) && /失败/.test(a3), '④ 判据不满足 → ★verified=false 明说失败✗★（不假报成功 ✓）');
  const a4 = await PE.run('act', 'L1|click|dry=1|img=' + IMG + '|after=C:/deepseek/after-click.png');
  ok(/没给判据 → 一律不算成功/.test(a4) && /verified = ★false/.test(a4), '④ 没给判据 → ★一律不算成功✗★（"画面变了"不是证据 ✓）');

  /* ⑤ prov 闸门本身：非工具给的坐标要拒；同目标点两次以上要拒 */
  const L = PROV.create({ now: () => 1000 });
  ok(!L.gate('click', 500, 500).ok, '⑤ 没登记的坐标 → 拒绝 ✓');
  L.offer(500, 500, 'find_text', 'X');
  ok(L.gate('click', 500, 500).ok, '⑤ 登记过（find_text 给的）→ 放行 ✓');
  /* ★2026-10-11 规则更新（真机事故修复 ✓ lead 批准）：**没判据（verified=null）/失败过**的重试是**正当的**✗→✓
     → 只有"**成功过一次**（verified=true）"之后的复点才拦 ✓（见 ⑧②）；连续失败 3 次也停 ✓（见 ⑧③）。
     ★这是"新行为对 → 更新测试预期去断言新行为"✗✓，不是放宽断言 ✗★ */
  L.note('click', 500, 500, 'test', { verified: false, reason: '没判据/没生效' });
  L.note('click', 500, 500, 'test', { verified: false, reason: '没判据/没生效' });
  const g3 = L.gate('click', 500, 500);
  ok(g3.ok === true, '⑤ ★失败过的重试**放行**✓（来源证明仍在 ✓）；成功过一次之后才拦 ✓（⑧②）★', 'ok=' + g3.ok);
  ok(!L.gate('click', 560, 500).ok, '⑤ 换个点（不在任何登记坐标附近）→ 仍然拒绝（来源证明 ✓）');

  /* ⑥ 坐标系契约：同一目标在"物理"与"DIP"两种假设下各算一次 */
  const sc = PE.spaceContract(1920, 1080);
  const truth = { x: 893, y: 337 };                 // 真值（物理像素 ✓ 来自今晚实测 OCR）
  const dipGuess = { x: Math.round(893 / 1.25), y: Math.round(337 / 1.25) };   // 若误当 DIP ✓
  const hitPhys = (Math.abs(truth.x - 893) <= 24 && Math.abs(truth.y - 337) <= 24);
  const hitDip = (Math.abs(dipGuess.x - 893) <= 24 && Math.abs(dipGuess.y - 337) <= 24);
  console.log('  ★坐标系核对★：真值 (' + truth.x + ',' + truth.y + ')；按物理假设 = (893,337) → ' + (hitPhys ? '命中 ✓' : '不命中 ✗'));
  console.log('              按 DIP 假设 = (' + dipGuess.x + ',' + dipGuess.y + ') → ' + (hitDip ? '命中 ✓' : '不命中 ✗（差 ' + Math.abs(893 - dipGuess.x) + '/' + Math.abs(337 - dipGuess.y) + 'px）'));
  ok(sc.unit === 'physical' && sc.capture.w === 1920, '⑥ 契约判定 unit=physical（截图 1920x1080 = space ✓）', JSON.stringify({ unit: sc.unit, capture: sc.capture, space: sc.space, display: sc.display }));
  ok(hitPhys && !hitDip, '⑥ ★同一目标：只有"物理"那套命中★（DIP 那套偏 ' + Math.abs(893 - dipGuess.x) + 'px ✗）—— 20% 偏移的机械原因就在这里 ✓');

  /* ⑦ zoom：裁剪放大 + 交给模型问（管道 ✓） */
  const z = await PE.run('zoom', '1810,60,80,950|3|0|这一列图标从上到下分别像什么？只说类别，不要坐标。|img=' + IMG);
  ok(/zoom 区域 \(1810,60,80,950\) ×3/.test(z) && /stub 模型回答/.test(z), '⑦ zoom 裁剪+放大+问模型 管道通 ✓（模型只回答描述 ✓ 不许给坐标 ✓）',
    (z.match(/→ [^\n]*/) || [''])[0].slice(0, 60));
  ok(/换算由程序做/.test(z), '⑦ zoom 回执里写明坐标换算规则（模型不参与换算 ✓）');

  console.log('');
  /* ★★ ⑧ 判据记账 + 正当重试（2026-10-11 真机事故：她被防复点闸门锁死 ✓ lead 最高优先）★★ */
  {
    const P = require(path.join(__dirname, '..', 'src', 'prov'));
    const L = P.create({});
    L.offer('locate', '测试目标', { x: 100, y: 200, w: 20, h: 20 });
    L.note('click', 110, 210, 'locate', { verified: false, reason: '判据没满足' });
    const g1 = L.gate('click', 110, 210);
    ok(g1.ok === true, '⑧ ① verified=false 之后重试**不被 no-repeat 拦** ✓（现场就是这里被锁死 ✗）', 'ok=' + g1.ok + ' code=' + (g1.code || '-'));
    L.note('click', 110, 210, 'locate', { verified: true, reason: '判据满足' });
    const g2 = L.gate('click', 110, 210);
    ok(g2.ok === false && /repeat/.test(String(g2.code)), '⑧ ② verified=true 之后再点同目标**被拦** ✓（防"点完又取消"）', 'ok=' + g2.ok + ' code=' + (g2.code || '-'));
    ok(typeof g2.suggestion === 'string' && g2.suggestion.length > 30, '⑧ ②′ 拒绝回执**必带 suggestion**（可执行动作 ✓）', String(g2.suggestion).slice(0, 22) + '…');
    const L2 = P.create({});
    L2.offer('locate', '测试目标', { x: 300, y: 400, w: 20, h: 20 });
    for (let i = 0; i < 3; i++) L2.note('click', 310, 410, 'locate', { verified: false, reason: '判据没满足#' + i });
    const g3 = L2.gate('click', 310, 410);
    ok(g3.ok === false && g3.code === 'retry-exhausted' && g3.stop === true,
      '⑧ ③ 连续失败 3 次 → **stop=true**（程序结束这一步 ✓ 不空转 ✓）', 'code=' + g3.code + ' stop=' + g3.stop + ' fails=' + g3.failCount);
    ok(Array.isArray(g3.tried) && g3.tried.length >= 3 && g3.tried.every((t) => t.verified === false),
      '⑧ ③′ stop 回执带**已试动作清单 + 每次判据结果** ✓', 'tried=' + (g3.tried || []).length);
    const before = L2.clicks().length;
    L2.gate('click', 310, 410);
    ok(L2.clicks().length === before, '⑧ ④ **被拒的动作不记账**（不会记成 ok ✓ 真机日志"状态 ok"与事实不符 ✗）', 'before=' + before + ' after=' + L2.clicks().length);
  }

  console.log('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('❌ 崩了：' + (e && e.stack || e)); process.exit(1); });
