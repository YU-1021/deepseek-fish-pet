/* probe-ownclick.js —— ★点击两道保险的真机验证（用真实抓帧 + 她的 OCR 引擎输出 ✓）★
 *
 * 素材（主人今晚那份）：
 *   点前：C:\Users\64616\AppData\Local\Temp\look-screen.png（1920x1080）
 *   点后：C:\deepseek\after-click.png（会客室队列面板已打开）
 *   OCR：scripts/ocr.ps1 -Path <png> -Json → 本探针读 C:\deepseek\ocr-before.json / ocr-after.json ✓
 *        （★为什么不让探针自己调 OCR ✗★：Node 抓子进程 stdout 在这台机器上被沙箱挡（管道 EPERM ✓），
 *          所以 JSON 先用 PowerShell 生成好 ✓ —— 和主人给我的方式一样 ✓）
 *
 * ★★ 本探针**一次都不点**（dry=1 ✓）★★ —— 主人正用这台机器验证会客室任务 ✓，
 *   ★我绝不能去动他的鼠标✗★（red line 6 的精神 ✓）。流程与真点**完全相同** ✓，只少"发出点击"那一步 ✓。
 *
 * 跑法：node app\scripts\probe-ownclick.js
 */
'use strict';
const fs = require('fs');
const OC = require('../src/ownclick');

let pass = 0, fail = 0;
function ok(c, label, extra) {
  if (c) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

const BEFORE = 'C:/Users/64616/AppData/Local/Temp/look-screen.png';
const AFTER = 'C:/deepseek/after-click.png';
const OCR = { [BEFORE]: 'C:/deepseek/ocr-before.json', [AFTER]: 'C:/deepseek/ocr-after.json' };

/* 注入依赖：OCR 从已生成好的 JSON 读 ✓；click 故意设成"一被调用就报错"✓ 好证明 dry 真的没点 ✓ */
let clicked = 0;
OC.install({
  capture: async () => { throw new Error('本探针不用现场抓帧 ✓（都用给的图 ✓）'); },
  ocrJson: async (p) => {
    const f = OCR[p] || OCR[p.replace(/\\/g, '/')];
    if (!f) throw new Error('没有这张图的 OCR 结果：' + p);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  },
  click: async () => { clicked++; throw new Error('★探针里不许真的点✗★'); },
  space: () => ({ w: 1920, h: 1080 }),
});

(async () => {
  console.log('=== probe-ownclick（真实帧 + 真 OCR 输出，全程 dry 不点鼠标）===');
  for (const f of [BEFORE, AFTER, 'C:/deepseek/ocr-before.json', 'C:/deepseek/ocr-after.json']) {
    if (!fs.existsSync(f)) { console.log('  ❌ 缺素材：' + f); process.exit(1); }
  }

  /* ① 点前确认归属（正确目标：会客室 → (893,337)） */
  const r1 = await OC.run('find_owned', '编辑队列|会客室|img=' + BEFORE);
  console.log(r1.split('\n').map((l) => '  ' + l).join('\n'));
  ok(/归属确定/.test(r1) && /893,337/.test(r1), '① ★点前归属确定：会客室 → (893,337)★');
  ok(/不属于|不在标题列|322/.test(r1), '① 聊天窗那处被列出来（排除理由 ✓）');

  /* ② 带判据的点击（dry）：判据 = **当前进驻**（★只在成功后出现✓★：真机 OCR 实测 before=0 / after=1 ✓）
         ★注意：不能用「会客室」✗ —— 它点前就有（房间列表里 ✓）→ 新闸门会（正确地）拒绝 ✓★ */
  const r2 = await OC.run('click_checked', '编辑队列|会客室|当前进驻|dry=1|img=' + BEFORE + '|after=' + AFTER);
  console.log(r2.split('\n').map((l) => '  ' + l).join('\n'));
  ok(/判定成功/.test(r2), '② ★判据满足 → 报成功 ✓★');
  ok(/893,337/.test(r2), '② 点击坐标 = 893,337（会客室的按钮 ✓）');
  ok(/像素差/.test(r2), '② before/after 像素差有记录 ✓（但只当旁证 ✓）');
  ok(clicked === 0, '② ★dry=1 时一次都没真的点★', 'clicked=' + clicked);

  /* ③ ★新闸门（2026-10-11）：判据里出现"点前就有"的词 → ★直接拒绝点击✗★★
         用的正是她今晚那次的判据「制造站1」✓（点前就有 ✓ 真实存在 ✓）→ 必须被拒 ✓ */
  const r3a = await OC.run('click_checked', '编辑队列|制造站1|制造站1,当前进驻|dry=1|img=' + BEFORE + '|after=' + AFTER);
  console.log(r3a.split('\n').map((l) => '  ' + l).join('\n'));
  ok(/判据不合格/.test(r3a) && /一个都没点/.test(r3a), '③ ★判据"制造站1"点前就有 → 拒绝点击 ✓（新闸门 ✓）★');
  ok(JSON.stringify(r3a).indexOf('当前进驻') >= 0, '③ 并且给出建议判据（当前进驻/房间2/12 ✓）');

  /* ③b 点错要报失败：用**合格**判据（当前进驻 ✓ 点前没有 ✓），但"点后"这一帧其实是**点前那张** ✓
         → 判据不满足 → ★必须报失败✗★（而屏幕在这两帧之间其实也会"变" ✓ —— 这正是"变了≠点对了" ✓） */
  const r3 = await OC.run('click_checked', '编辑队列|制造站1|当前进驻|dry=1|img=' + BEFORE + '|after=' + BEFORE);
  console.log(r3.split('\n').map((l) => '  ' + l).join('\n'));
  ok(/893,605/.test(r3), '③ ★归属正确指出"制造站1 的按钮在 (893,605)"★（＝她点错的那一格 ✓）');
  ok(/判定失败/.test(r3), '③ ★判据不满足 → 如实报失败 ✓★（没有拿"屏幕变了"当成功 ✓）');
  ok(/不要在附近反复试|不要在这附近反复试/.test(r3), '③ 明确写出"不要在这附近反复试" ✓');

  /* ④ 归属不确定时必须拒绝点击（容器名不存在 ✓；判据用**合格**的「当前进驻」✓ 好让归属那一关真的被执行到 ✓） */
  const r4 = await OC.run('click_checked', '编辑队列|不存在的房间|当前进驻|dry=1|img=' + BEFORE + '|after=' + AFTER);
  ok(/点前检查没过/.test(r4) && /一个都没点/.test(r4), '④ ★归属不确定时一个都不点 ✓（宁可不动手也不点错 ✓）★');
  console.log('  ' + r4.split('\n').slice(0, 3).join('\n  '));

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail) + '　（真实点击次数：0 ✓ —— 主人的鼠标没被碰过 ✓）');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('❌ 探针崩了：' + (e && e.stack || e)); process.exit(1); });
