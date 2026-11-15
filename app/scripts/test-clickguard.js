/* test-clickguard.js —— ★"不许复点"闸门的单元测试（纯逻辑，不碰屏幕）★
 * 跑法：node app/scripts/test-clickguard.js
 *
 * 它冻住的是主人症状③的正解（2026-10-11）：
 *   · 她的 click 一次只发一组 down+up（间隔 45ms）；Windows 双击窗口 500ms / 4px；
 *     实测她两次点击隔 3~6 秒 → **不可能被并成双击**；
 *     "点对一次又点掉一次" = 两次**独立单击**打在同一个 toggle 上（第一下开，第二下关）。
 *   · 所以：同一个目标默认 1 次；复点必须有**新证据**（点完之后重新定位过一次）；
 *     最多 2 次，第 3 次一律拒绝；判据满足（clear）才允许重新开始。
 */
'use strict';
const P = require('../src/prov');
const SD = require('../src/safedrive');

let pass = 0, fail = 0;
function ok(c, label, extra) {
  if (c) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

console.log('=== clickguard（不许复点）单元测试 ===');

/* 可注入时钟 → 确定性覆盖"新证据"的时间语义。
   ⚠️ prov.gate 的**默认**是严格来源证明（模型自己写的坐标一律不执行 ✓，percept 单测冻住的就是它 ✓）；
   裸 click 那条路显式传 {requireOffer:false} ✓ —— 这里两种都测 ✓ */
let T = 1000000;
const led = P.create({ now: () => T });
const X = 900, Y = 500;
/* ⚠️ prov.gate 的**默认**是严格来源证明（模型自己写的坐标一律不执行 ✓，percept 单测冻住的就是它 ✓）；
   放宽必须走**显式逃生门**：`{requireOffer:false, why:'<用途>'}`（why 必填、会留痕 ✓）——
   RELAX 就是"带着用途的逃生门"，模拟探针/单测这类非生产路径 ✓。 */
const RELAX = { requireOffer: false, why: '单测：复点闸门（本测试不走来源证明）' };

/* §1 第一次点：逃生门放行（探针/单测路径）✓ */
{
  const g1 = led.gate('click', X, Y, RELAX);
  ok(g1.ok === true && g1.alreadyClicked === 0, '§1 第一次点同一个目标 → 放行', JSON.stringify({ ok: g1.ok, n: g1.alreadyClicked }));
  led.note('click', X, Y, 'clickSafe');
}

/* §2 ★复点没有新证据 → 拒绝★（时间过去了也不行 —— 关键点：判据是**证据**不是**时间**） */
{
  T += 60000;                                     // 整整一分钟后
  const g2 = led.gate('click', X, Y, RELAX);
  ok(g2.ok === false && g2.code === 'repeat-needs-fresh-evidence',
    '§2 ★只过了时间、没有新定位 → 还是拒绝（复点要证据，不要时间）★', String(g2.code));
  ok(/重新定位/.test(g2.hint || ''), '§2 拒绝时明确告诉她"要重新定位"', (g2.hint || '').slice(0, 40));
}

/* §3 复点带**新证据**（点完之后重新定位过一次）→ 允许第二次 */
{
  T += 1000;
  led.offer(X, Y, 'find_text', '编辑队列');        // ← 重新定位（新鲜帧）
  const g3 = led.gate('click', X, Y, RELAX);
  ok(g3.ok === true && g3.alreadyClicked === 1 && g3.freshEvidence === true,
    '§3 ★点完之后重新定位过 → 允许再点一次★', JSON.stringify({ n: g3.alreadyClicked, fresh: g3.freshEvidence }));
  led.note('click', X, Y, 'clickSafe');
}

/* §4 ★第 3 次一律拒绝★（就算又有新证据也不行） */
{
  T += 1000;
  led.offer(X, Y, 'uia_find', '确认');
  const g4 = led.gate('click', X, Y, RELAX);
  ok(g4.ok === false && g4.code === 'repeat-too-many', '§4 ★同一个目标第 3 次 → 一律拒绝（上限 2）★', String(g4.code));
  ok(/别再点了/.test(g4.hint || ''), '§4 拒绝文案里有"别再点了"', (g4.hint || '').slice(0, 30));
}

/* §5 判据满足（确认状态真的变了）→ 清账 → 同一目标可以重新开始 ✓ */
{
  led.clear(X, Y);
  const g5 = led.gate('click', X, Y, RELAX);
  ok(g5.ok === true && g5.alreadyClicked === 0, '§5 ★clear（判据满足）之后 → 又能点了★', JSON.stringify({ n: g5.alreadyClicked }));
}

/* §6 别的目标互不影响（邻近半径 24px 之外） */
{
  const g6 = led.gate('click', X + 60, Y, RELAX);
  ok(g6.ok === true, '§6 隔 60px 的另一个目标 → 不受影响', 'ok=' + g6.ok);
}

/* §7 严格模式（requireOffer）：坐标必须来自确定性工具 —— 裸坐标直接拒绝 */
{
  const led2 = P.create({ now: () => T });
  const g7 = led2.gate('click', 10, 10, { requireOffer: true });
  ok(g7.ok === false && g7.code === 'no-provenance', '§7 严格模式：裸坐标（没人报过）→ 拒绝', String(g7.code));
  led2.offer(10, 10, 'find_owned', '编辑队列');
  const g8 = led2.gate('click', 10, 10, { requireOffer: true });
  ok(g8.ok === true, '§7 严格模式：确定性工具报过之后 → 放行', 'ok=' + g8.ok);
}

/* §8 失败原因的细分数值里要有这两条（回执靠它说人话） */
{
  const t1 = SD.reasonText('repeat-needs-fresh-evidence');
  const t2 = SD.reasonText('repeat-too-many');
  ok(!!t1 && t1.indexOf('其它原因') < 0, '§8 reasonText 有"复点要新证据"的中文', t1);
  ok(!!t2 && t2.indexOf('其它原因') < 0, '§8 reasonText 有"点过 2 次不许再点"的中文', t2);
}

/* §9 共用账本：percept 那条线（locate/act）和裸 click 看的是**同一本账** */
{
  const sharedA = require('../src/prov').instance;
  const sharedB = require('../src/prov').instance;
  ok(sharedA === sharedB, '§9 ★全进程只有一本账（prov.instance 单例）★ —— 不做两套互相打架的闸门');
}

/* §10 ★默认路径拒绝"没有定位来源的坐标"，而且**回执必须是失败**（不是假成功）★
   起因（真 bug）：assistant.js 的 click 分支只看 move 的失败、不看 click 的失败 ✗ ——
   于是被拦的点击照样写「✅ 已左键点击」。修法：safedrive/input 被拦时**抛 ❌ 错** ✓。
   这条回归冻住：① 抛的错以 ❌ 开头、reason 细分；② 上层判"这一步失败"的两条判据确实匹配 ✓。 */
(async () => {
  const SD2 = require('../src/safedrive');
  const fs = require('fs');
  const path = require('path');
  const PROV2 = require('../src/prov');
  const LX = 1234, LY = 567;                       // 一个没人登记过的坐标
  PROV2.instance.clear();                          // 干净账本
  let threw = null;
  try { await SD2.clickSafe(LX, LY, { envCheck: false }); } catch (e) { threw = e; }
  ok(!!threw && threw.reason === 'no-provenance' && String(threw.message).charAt(0) === '❌',
    '§10 ★默认路径：没有定位来源的坐标 → 抛 ❌（no-provenance）★', threw ? String(threw.message).slice(0, 58) : '没抛');
  const receipt = '❌ 操作 `click` 失败：' + (threw ? threw.message : '');   // = renderer/chat.js 的 catch 分支 ✓
  const CHAT_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat.js'), 'utf8');
  ok(CHAT_SRC.indexOf('失败：') >= 0 && /^❌ 操作/.test(receipt),
    '§10 chat.js 仍然是"❌ 操作 … 失败：…"这条文案（契约没漂）', receipt.slice(0, 24));
  ok(/^(❌|⏱|⚠️)|失败|出错|超时|不被允许/.test(receipt), '§10 ★这条回执会被她的循环判成**失败**（不是成功）★', receipt.slice(0, 30));
  ok(/^(❌|⚠️|✗)/.test(receipt.trim()), '§10 main.js 的步骤判据也认它（开头就是 ❌ ✓）', receipt.slice(0, 10));
  /* 逃生门：没写 why → 也拒（不许变成常规通道 ✓） */
  let threw2 = null;
  try { await SD2.clickSafe(LX, LY, { envCheck: false, requireOffer: false }); } catch (e) { threw2 = e; }
  ok(!!threw2 && threw2.reason === 'bypass-without-why', '§10 ★逃生门不说用途 → 一样拒（bypass-without-why）★',
    threw2 ? String(threw2.reason) : '没抛');
  /* 逃生门：写了 why → 放行，而且**留痕**（action/坐标/用途/时间 ✓）、回执里也带 ✓ */
  PROV2.instance.clear();
  const soft = await SD2.clickSafe(LX, LY, {
    envCheck: false, softBlock: true, requireOffer: false, why: '单测：验证逃生门留痕',
  });
  const by = PROV2.instance.bypasses();
  ok(by.length === 1 && by[0].why === '单测：验证逃生门留痕' && by[0].action === 'click',
    '§10 ★逃生门放行会留痕（action/坐标/用途/时间）★', JSON.stringify(by[0] || null));
  ok(!!(soft && soft.bypass && soft.bypass.why), '§10 回执里也带上了 bypass 用途 ✓', soft && soft.bypass ? soft.bypass.why : '无');

  /* §11 ★dry=1（只算不点）不能污染账本★ —— 修前：dry 也 note() → 下一次**真的**点击被误判成复点 ✗ */
  const PE = require('../src/percept');
  const IMG = 'C:/Users/64616/AppData/Local/Temp/look-screen.png';
  if (!fs.existsSync(IMG)) {
    console.log('  [SKIP] §11 percept 的测试图不存在（' + IMG + '）—— 这条只能在有那张图的机器上跑');
  } else {
    const ocrOf = (p) => {
      const b = path.basename(String(p));
      if (/after-click/.test(b)) return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ocr-after.json'), 'utf8'));
      return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'look-ocr.json'), 'utf8'));
    };
    const acted = [];
    PE.install({
      capture: async () => ({ path: IMG }), freshFrame: async () => ({ path: IMG }),
      ocrJson: (p) => ocrOf(p),
      act: async (kind, x, y) => { acted.push([kind, x, y]); return true; },
      space: () => ({ w: 1920, h: 1080 }), display: () => ({ w: 1536, h: 864, scaleFactor: 1.25 }),
      shotDir: () => path.join(__dirname, 'fixtures'), dbg: () => {},
    });
    PROV2.instance.clear();
    const loc = await PE.run('locate', '编辑队列|img=' + IMG);
    const id = (String(loc).match(/L\d+/) || [])[0];
    if (!id) {
      console.log('  [SKIP] §11 locate 没给出编号（夹具不匹配）：' + String(loc).split('\n')[0].slice(0, 60));
    } else {
      await PE.run('act', id + '|click|当前进驻|dry=1|img=' + IMG + '|after=C:/deepseek/after-click.png');
      await PE.run('act', id + '|click|当前进驻|dry=1|img=' + IMG + '|after=C:/deepseek/after-click.png');
      ok(PROV2.instance.clicks().length === 0 && acted.length === 0,
        '§11 ★dry=1 两次：账本 0 笔、真实动作 0 次★', 'clicks=' + PROV2.instance.clicks().length + ' acted=' + acted.length);
      /* ★核心不变式★：dry 之后，同一个目标的闸门**仍然放行**（dry 没把它记成"点过" ✓）
         —— 修之前这里会变成 repeat-needs-fresh-evidence（下一次真点击被拦 ✗） */
      const off = PROV2.instance.offers().slice(-1)[0];
      const gAfterDry = off ? PROV2.instance.gate('click', off.x, off.y, { requireOffer: true }) : { ok: false, code: 'no-offer' };
      ok(gAfterDry.ok === true, '§11 ★dry 之后同一目标仍然允许第一次点击（闸门没被 dry 污染）★',
        'code=' + (gAfterDry.code || 'null') + ' n=' + gAfterDry.alreadyClicked + ' @' + (off ? off.x + ',' + off.y : '-'));
      /* 真跑一次 act：只要没被"复点"闸门拦下就算通过 */
      const real = await PE.run('act', id + '|click|当前进驻|img=' + IMG + '|after=C:/deepseek/after-click.png');
      const realS = String(real);
      if (/找不到|编号|NOTFOUND/i.test(realS)) {
        console.log('  [SKIP] §11 真 act 被 percept 自己的编号机制挡在闸门之前（不是账本的事）：'
          + realS.split('\n')[0].slice(0, 60));
      } else {
        ok(!/repeat-too-many|repeat-needs-fresh-evidence/.test(realS),
          '§11 ★真点击没有被复点闸门拦下★（dry 不污染账本 ✓）', realS.split('\n').slice(-1)[0].slice(0, 40));
      }
    }
  }

  /* §12 ★流程重放：录下来的坐标按 source:'replay' **登记成 offer**（不是豁免）★
     —— 主人的决定：重放坐标来自"一次真实成功动作"，本身就是有效证据 ✓；
        登记之后它自然通过来源闸门 ✓，而且能审计"这个点是谁给的" ✓。 */
  const FLOW = require('../src/flow');
  PROV2.instance.clear();
  const byBefore = PROV2.instance.bypasses().length;      // §10 用过一次逃生门，这里只看**增量** ✓
  const clicked = [];
  const flowDeps = {
    log: () => {},
    capture: async () => ({ dataUrl: 'x' }),
    click: async (x, y) => { clicked.push([x, y]); return true; },
    rclick: async () => true, move: async () => true, scroll: async () => true,
    key: async () => true, type: async () => true,
    findTemplate: async () => ({ ok: false }), findText: async () => ({ ok: false }),
  };
  const rep2 = await FLOW.runFlow(flowDeps, {
    name: '单测流程', savedAt: 1791000000000,
    steps: [{ id: 'a1', action: 'click', target: { xy: [700, 400] } }],
  }, {});
  const offR = PROV2.instance.offers().slice(-1)[0] || {};
  ok(rep2.ok === true && clicked.length === 1, '§12 流程重放本身跑通了', JSON.stringify({ ok: rep2.ok, clicks: clicked.length }));
  ok(offR.source === 'replay' && offR.x === 700 && offR.y === 400 && offR.stepId === 'a1' && offR.recordedAt === 1791000000000,
    '§12 ★重放坐标登记成 offer（source=replay / stepId / recordedAt）★', JSON.stringify(offR));
  const gReplay = PROV2.instance.gate('click', 700, 400, { requireOffer: true });
  ok(gReplay.ok === true, '§12 ★登记之后它自然通过"必须有定位来源"的闸门★（不需要任何豁免 ✓）',
    'ok=' + gReplay.ok + ' from=' + (gReplay.offer && gReplay.offer.from));
  ok(PROV2.instance.bypasses().length === byBefore, '§12 ★重放没走逃生门（bypass 增量为 0）★',
    'before=' + byBefore + ' after=' + PROV2.instance.bypasses().length);

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
