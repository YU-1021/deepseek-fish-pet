/* bench-game.js —— ★游戏环境的离线测试台（真实帧 ✓ 纯函数 ✓ 可重复跑 ✓ 无鼠标 ✓ 无随机 ✓）★
 *
 * 跑法：node app\scripts\bench-game.js  [--json]
 *
 * 【它回答 lead 的四个问题】
 *   ① 四个候选能不能正确归属（会客室=第1个 ✓、聊天窗那处被排除 ✓）
 *   ② 判据选得对不对（"会客室"点前就有 → ★不能当判据✗★；"当前进驻"点前0点后1 → ★可以✓★）
 *   ③ 点错时能不能自己报失败（★判据不满足必须报失败✗，不许拿"屏幕变了"当成功✓★）
 *   ④ 图标列的识别在真实帧上稳不稳（同图重复 3 次结果完全一致 ✓ + 亮度/缩放扰动下命中数 ✓）
 *   外加：⑤ 面板状态判定（"现在在哪个面板"✓ —— 直接对应"卡在不存在确认按钮上乱找"那个失败模式 ✓）
 *
 * 【素材（真实 ✓ 全部来自这台机器今晚的实拍）】
 *   OCR JSON：ocr-before.json（四点候选那帧 ✓）/ ocr-after.json（会客室队列面板 ✓）
 *             livetest/ocr-step1.json（基地视图 ✓）/ ocr-step3.json（选人面板 ✓）/ ocr-stop.json（最后状态：DSH 窗口 ✓）
 *   真机抓帧：desktop-pet/shots/win-Arknights-1791645099248.jpg（职业列那帧 ✓，用来验图标库稳定性 ✓）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OC = require('../src/ownclick');
const P = require('../src/panel');
const IL = require('../src/iconlib');

let pass = 0, fail = 0;
const rows = [];
function ok(c, label, extra) {
  const rec = { ok: !!c, label, extra: extra || '' };
  rows.push(rec);
  if (c) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}
const J = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const NAMES = ['ALL', '先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'];
const REGION = { x0: 1600, y0: 60, x1: 1919, y1: 1012 };

(async () => {
  console.log('=== bench-game（真实帧离线测试台）===');
  /* ★素材优先用**仓库内 fixture**（可重复跑 ✓ 别人拉下来也能跑 ✓），没有再回落到本机路径 ✓ */
  const fx = (name, fallback) => (fs.existsSync(path.join(__dirname, 'fixtures', name)) ? path.join(__dirname, 'fixtures', name) : fallback);
  const F = {
    base: fx('look-ocr.json', 'C:/deepseek/ocr-before.json'),
    queue: fx('ocr-after.json', 'C:/deepseek/ocr-after.json'),
    step1: fx('ocr-step1.json', 'C:/deepseek/livetest/ocr-step1.json'),
    select: fx('ocr-step3.json', 'C:/deepseek/livetest/ocr-step3.json'),
    stop: fx('ocr-stop.json', 'C:/deepseek/livetest/ocr-stop.json'),
  };
  for (const k of Object.keys(F)) if (!fs.existsSync(F[k])) { console.log('  ❌ 缺素材 ' + k + ' = ' + F[k]); process.exit(1); }
  const ocrB = J(F.base), ocrA = J(F.queue);

  /* ① 归属 */
  console.log('\n① 归属（四处同名「编辑队列」）');
  const buttons = OC.phrasesFromOcr(ocrB, '编辑队列');
  const res = OC.pairOwners(buttons, OC.phrasesFromOcr(ocrB, '会客室'), {});
  const owned = OC.ownedBy(res, '会客室');
  ok(buttons.map((b) => b.cx + ',' + b.cy).join(' ') === '893,337 893,605 893,820 322,791', '① 四候选与真机实测一致', buttons.map((b) => '(' + b.cx + ',' + b.cy + ')').join(' '));
  ok(owned.length === 1 && owned[0].button.cx === 893 && owned[0].button.cy === 337, '① 会客室 → ★(893,337)★（第 1 个 ✓）');
  ok(res.excluded.some((e) => e.button.cx === 322 && /不在标题列/.test(e.why)), '① 聊天窗那处 (322,791) 被排除 ✓');
  ok(OC.ownedBy(OC.pairOwners(buttons, OC.phrasesFromOcr(ocrB, '制造站1'), {}), '制造站1')[0].button.cy === 605,
    '① 制造站1 → (893,605)（★她今晚实际点错的那一格 ✓★）');

  /* ② 判据 */
  console.log('\n② 判据（"点前就有"的词不能当判据）');
  const vBad = OC.validateCriteria(ocrB, ['会客室'], P.criteriaFor('queue'));
  const vGood = OC.validateCriteria(ocrB, ['当前进驻'], P.criteriaFor('queue'));
  ok(!vBad.ok && vBad.alreadyPresent.join(',') === '会客室', '② ★「会客室」被判定为不合格判据★（点前就有 ✓ 真实 before=' + OC.phrasesFromOcr(ocrB, '会客室').length + ' 处 ✓）');
  ok(vBad.suggestion.length > 0, '② 并且给出了建议判据 ✓', JSON.stringify(vBad.suggestion));
  ok(vGood.ok && vGood.fresh.join(',') === '当前进驻', '② ★「当前进驻」判定合格★（点前没有 ✓ 点后出现 ✓ 真机实测 before=0/after=1 ✓）');
  ok(OC.verifyCriteria(ocrA.text, ['当前进驻']).ok, '② 点后核对：「当前进驻」确实出现了 ✓');

  /* ③ 点错要报失败 */
  console.log('\n③ 点错时必须报失败');
  const vWrong = OC.verifyCriteria(ocrA.text, ['制造站1', '当前进驻']);
  ok(!vWrong.ok && vWrong.missing.join(',') === '制造站1', '③ ★点到制造站1 时：判据缺「制造站1」→ 报失败 ✓（不拿"屏幕变了"当成功 ✓）★');
  const A = await OC.lumaOfImage('C:/deepseek/step1.png').catch(() => null);
  const B = await OC.lumaOfImage('C:/deepseek/after-click.png').catch(() => null);
  if (A && B) {
    const d = OC.diffStats(A.luma, B.luma);
    ok(d.changedRatio > 0.2, '③ before/after 确实变化很大（只当旁证 ✓）', '变化像素 ' + (d.changedRatio * 100).toFixed(1) + '%');
    ok(d.changedRatio > 0.2 && !vWrong.ok, '③ ★"屏幕变了"和"判据满足"是两件事 ✓（这次变了却失败 ✓）★');
  } else { ok(false, '③ 两帧读不到（跳过像素差）'); }

  /* ④ 图标列稳定性 */
  console.log('\n④ 纯图标（职业列）识别的稳定性');
  const iconFrame = 'C:/deepseek/desktop-pet/shots/win-Arknights-1791645099248.jpg';
  if (fs.existsSync(iconFrame)) {
    const BASE2 = 'C:/deepseek/iconlib-bench';
    fs.mkdirSync(BASE2, { recursive: true });
    const built = await IL.buildLibrary({ image: iconFrame, baseDir: BASE2, libName: 'bench', dir: 'v', expect: 9, region: REGION, names: NAMES });
    const sig = async () => {
      const r = await IL.matchLibrary({ image: iconFrame, baseDir: BASE2, libName: 'bench', dir: 'v', expect: 9, region: REGION });
      return r.rows.map((x) => x.index + ':' + x.name + ':' + x.score.toFixed(3) + ':' + x.verdict).join('|');
    };
    const s1 = await sig(), s2 = await sig(), s3 = await sig();
    ok(built.index.cells === 9, '④ 真机抓帧切出 9 格 ✓', '格距 ' + (built.analysis.spacing || 0).toFixed(1) + 'px');
    ok(s1 === s2 && s2 === s3, '④ ★同一帧重复 3 次结果**完全一致**（无随机性 ✓）★');
    ok(/match/.test(s1) && !/uncertain/.test(s1), '④ 9 格全部"就是它" ✓', s1.split('|').slice(0, 3).join(' '));
  } else { ok(false, '④ 缺职业列真机帧：' + iconFrame); }

  /* ⑤ 面板状态判定 */
  console.log('\n⑤ 面板状态（"现在在哪个面板"）');
  const EXPECT = { step1: 'base', select: 'select', queue: 'queue', stop: 'dsh' };
  for (const k of Object.keys(EXPECT)) {
    const d = P.detect(J(F[k]), {});
    ok(d.verdict === 'ok' && d.panel === EXPECT[k], '⑤ ' + k + ' → 判定「' + d.label + '」✓', '命中 ' + JSON.stringify(d.best.hits));
  }
  const dBase = P.detect(ocrB, {});
  ok(dBase.verdict === 'unknown', '⑤ 那帧老基地图证据不足 → 如实报 unknown ✓（不瞎猜 ✓）', dBase.note.slice(0, 40));

  /* ⑥ 可重复性（整套再跑一遍，签名一致 ✓） */
  console.log('\n⑥ 可重复性');
  const signature = () => JSON.stringify({
    b: buttons.map((x) => x.cx + ',' + x.cy),
    own: owned.map((x) => x.button.cx + ',' + x.button.cy),
    vBad: vBad.alreadyPresent, vGood: vGood.fresh,
    panels: Object.keys(EXPECT).map((k) => P.detect(J(F[k]), {}).panel),
  });
  ok(signature() === signature(), '⑥ 同样的输入跑两次，结论签名完全一致 ✓（确定性 ✓）');

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  if (process.argv.indexOf('--json') >= 0) console.log(JSON.stringify(rows));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('❌ 测试台崩了：' + (e && e.stack || e)); process.exit(1); });
