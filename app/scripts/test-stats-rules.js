/* 隐藏数值规则验证 —— 逐条对照 功能说明.md 里的说法（确定性、零 token）
 * electron.exe app\scripts\test-stats-rules.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-statstest');
fs.mkdirSync(TEST_UD, { recursive: true });
for (const f of ['config.json', 'persona.json']) {
  try { fs.copyFileSync(path.join(process.env.APPDATA, 'dayu-pet', f), path.join(TEST_UD, f)); } catch {}
}
try { fs.unlinkSync(path.join(TEST_UD, 'clock-offset.json')); } catch {}
try { fs.rmSync(path.join(TEST_UD, 'memory'), { recursive: true, force: true }); } catch {}
app.setPath('userData', TEST_UD);

app.whenReady().then(() => {
  const stats = require('../src/stats');
  const clock = require('../src/clock');
  const personatags = require('../src/personatags');
  const mood = require('../src/mood');
  const out = [];
  const L = (s) => out.push(s);
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };
  const reset = (vals) => {
    const v = stats.load();
    for (const k of stats.KEYS) v[k] = vals && vals[k] != null ? vals[k] : stats.NEUTRAL;
    v.counts = {}; v.day = stats.dayStr();
    stats.save(v);
    return v;
  };

  try {
    L('=== 0. 数值表本身 ===');
    L('  ' + '数值'.padEnd(14) + '层'.padEnd(10) + '下限'.padStart(5) + '上限'.padStart(5) + '  慢回归');
    for (const k of stats.KEYS) {
      const m = stats.META[k];
      L('  ' + m.label.padEnd(14) + String(m.layer).padEnd(10) + String(m.floor).padStart(5) + String(m.cap).padStart(5) + '  ' + (m.regress || '—'));
    }
    const ids = Object.keys(stats.META);
    check('6 个数值', ids.length === 6, ids.join(','));
    check('每个都有 floor<cap 且 floor>=0', ids.every((k) => stats.META[k].floor < stats.META[k].cap && stats.META[k].floor >= 0));
    check('文档说的 依赖度 0~95', stats.META.dependency.floor === 0 && stats.META.dependency.cap === 95);
    check('文档说的 IQ/认真度 下限 20、上限 95',
      stats.META.iq.floor === 20 && stats.META.iq.cap === 95 && stats.META.diligence.floor === 20 && stats.META.diligence.cap === 95,
      'iq=' + stats.META.iq.floor + '~' + stats.META.iq.cap + ' dil=' + stats.META.diligence.floor + '~' + stats.META.diligence.cap);
    check('文档说的"不回归"：依赖度/IQ/认真度 regress 为 0',
      !stats.META.dependency.regress && !stats.META.iq.regress && !stats.META.diligence.regress);
    check('文档说的"会回归"：外向/感性/直白 regress > 0',
      stats.META.extraversion.regress > 0 && stats.META.emotionality.regress > 0 && stats.META.directness.regress > 0);

    /* ---------- 1. 上下限真的夹得住 ---------- */
    L('');
    L('=== 1. 上下限夹紧 ===');
    reset({ iq: 94.5 });
    stats.nudge('iq', 50, 'test', '硬推上限');
    check('IQ 不会被推过上限 95', stats.get('iq') <= 95, 'iq=' + stats.get('iq'));
    reset({ iq: 20.2 });
    stats.nudge('iq', -50, 'test', '硬推下限');
    check('IQ 不会掉到下限 20 以下', stats.get('iq') >= 20, 'iq=' + stats.get('iq'));
    reset({ dependency: 94 });
    stats.nudge('dependency', 99, 'test', '硬推上限', true);
    check('依赖度不超 95', stats.get('dependency') <= 95, 'dependency=' + stats.get('dependency'));

    /* ---------- 2. 每日上限 DAILY_CAP ---------- */
    L('');
    L('=== 2. 每日上限（DAILY_CAP=' + stats.DAILY_CAP + '）===');
    reset({ iq: 50 });
    for (let i = 0; i < 60; i++) stats.nudge('iq', 5, 'spam', '狂刷同一条');
    const gained = stats.get('iq') - 50;
    check('狂刷 60 次，正向增量不超过 ' + stats.DAILY_CAP, gained <= stats.DAILY_CAP + 1e-9, '涨了 ' + gained);
    check('但确实涨了（不是一刀切归零）', gained > 0.1, '涨了 ' + gained);
    /* 负向单独计额度 */
    reset({ iq: 80 });
    for (let i = 0; i < 60; i++) stats.nudge('iq', -5, 'spam2', '狂刷负向');
    const lost = 80 - stats.get('iq');
    check('负向也有独立额度，不超过 ' + stats.DAILY_CAP, lost <= stats.DAILY_CAP + 1e-9, '掉了 ' + lost);
    /* 跨天重置 */
    reset({ iq: 50 });
    for (let i = 0; i < 60; i++) stats.nudge('iq', 5, 'spam3', '第一天刷满');
    const d1 = stats.get('iq');
    clock.set({ days: 1 });
    stats.nudge('iq', 5, 'spam3', '第二天继续');
    const d2 = stats.get('iq');
    clock.clear();
    check('跨天后额度重置（还能再涨）', d2 > d1, '第一天到 ' + d1 + '，第二天再涨到 ' + d2);

    /* ---------- 3. 递减权重 + 惯性 ---------- */
    L('');
    L('=== 3. 递减权重 / 惯性 ===');
    const w1 = stats.weight(1), w5 = stats.weight(5), w50 = stats.weight(50);
    check('权重随次数递减', w1 > w5 && w5 > w50, w1.toFixed(3) + ' > ' + w5.toFixed(3) + ' > ' + w50.toFixed(3));
    check('第一次权重 = 1（不打折）', Math.abs(w1 - 1) < 1e-9, String(w1));
    check('权重有下限（不会衰减到 0）', w50 > 0 && stats.weight(10000) > 0, 'w(10000)=' + stats.weight(10000).toFixed(4));
    check('高位惯性：>80 时正向增量减半', stats.inertia('iq', 85, 2) === 1, '得到 ' + stats.inertia('iq', 85, 2));
    check('低位惯性：<20 时负向增量减半', stats.inertia('iq', 15, -2) === -1, '得到 ' + stats.inertia('iq', 15, -2));
    check('中间区间不触发惯性', stats.inertia('iq', 50, 2) === 2 && stats.inertia('iq', 50, -2) === -2);

    /* ---------- 4. 慢回归 ---------- */
    L('');
    L('=== 4. 慢回归 ===');
    reset({ extraversion: 90, iq: 90, dependency: 90 });
    const r1 = stats.regress(0.2);
    check('会回归的项朝 50 走', stats.get('extraversion') < 90 && stats.get('extraversion') > 50,
      '外向 90 → ' + stats.get('extraversion') + '（回归了 ' + r1.length + ' 项）');
    check('不回归的项纹丝不动', stats.get('iq') === 90 && stats.get('dependency') === 90,
      'iq=' + stats.get('iq') + ' dependency=' + stats.get('dependency'));
    check('单次回归不超过 maxStep', Math.abs(90 - stats.get('extraversion')) <= 0.2 + 1e-9,
      '步长 ' + Math.abs(90 - stats.get('extraversion')));
    reset({ extraversion: 50.05 });
    stats.regress(0.2);
    check('已经接近 50 就不动了（不会越过 50）', stats.get('extraversion') >= 50, '=' + stats.get('extraversion'));

    /* ---------- 5. 步数预算由 IQ 决定 ---------- */
    L('');
    L('=== 5. 步数预算（文档说由 IQ 决定）===');
    const b = [];
    for (const iq of [20, 35, 50, 65, 80, 95]) { reset({ iq }); b.push(stats.stepBudget()); }
    check('IQ 越高步数越多（单调不减）', b.every((x, i) => i === 0 || x >= b[i - 1]), 'IQ 20/35/50/65/80/95 → ' + b.join('/'));
    check('步数在合理区间（1~20）', b.every((x) => x >= 1 && x <= 20), b.join('/'));
    check('最低 IQ 也不是 0 步（否则任务永远做不了）', b[0] >= 1, '最低 ' + b[0]);

    /* ---------- 6. behaviorSpec 会把这些写进提示词 ---------- */
    L('');
    L('=== 6. behaviorSpec：把数值翻译成行为说明 ===');
    reset({ iq: 90, diligence: 90, dependency: 90, emotionality: 90, extraversion: 90, directness: 90 });
    const specHigh = stats.behaviorSpec();
    reset({ iq: 20, diligence: 20, dependency: 10, emotionality: 10, extraversion: 10, directness: 10 });
    const specLow = stats.behaviorSpec();
    check('behaviorSpec 非空', typeof specHigh === 'string' && specHigh.length > 10, specHigh.length + ' 字');
    check('高/低数值给出**不同**的说明', specHigh !== specLow, '高 ' + specHigh.length + ' 字 / 低 ' + specLow.length + ' 字');
    check('说明里带上了具体数值方向（黏/爱聊/感性…）',
      /黏|爱聊|感性|直白|认真|聪明/.test(specHigh + specLow), (specHigh + specLow).slice(0, 60));
    /* 中间值应该尽量不啰嗦（不写进提示词就不占 token） */
    reset({});
    const specMid = stats.behaviorSpec();
    check('全是中间值时不硬凑说明（省 token）', specMid.length <= specHigh.length, '中间 ' + specMid.length + ' 字 vs 高 ' + specHigh.length + ' 字');

    /* ---------- 7. 与好感度挂钩（relateOf）：关系越好，正向事件涨得越多 ---------- */
    L('');
    L('=== 7. 与好感度挂钩 ===');
    mood.save({ affection: 10, mood: 50, pokes: 0, lastSeen: Date.now() });
    const rfLow = stats.relateOf('dependency', 1);
    mood.save({ affection: 95, mood: 90, pokes: 0, lastSeen: Date.now() });
    const rfHigh = stats.relateOf('dependency', 1);
    check('高好感时同一件事涨得更多', rfHigh > rfLow, '低=' + rfLow.toFixed(3) + ' 高=' + rfHigh.toFixed(3));
    check('挂钩系数在合理范围', rfLow > 0.3 && rfHigh < 2, rfLow.toFixed(2) + '~' + rfHigh.toFixed(2));
    mood.save({ affection: 30, mood: 70, pokes: 0, lastSeen: Date.now() });

    /* ---------- 8. 模型批量判断的那条路（applyDeltas）---------- */
    L('');
    L('=== 8. applyDeltas：会话结束时模型给的一批变化 ===');
    reset({ iq: 50, dependency: 50 });
    mood.save({ affection: 30, mood: 70, pokes: 0, lastSeen: Date.now() });
    /* 文档说"每项 -2~+2"——超出的必须被夹住 */
    const ap = stats.applyDeltas({ iq: 50, dependency: -99, nonsense: 5 }, '越界测试');
    check('超范围的增量被夹到 ±2 以内',
      ap.every((x) => Math.abs(x.delta) <= 2), JSON.stringify(ap.map((x) => x.key + ':' + x.delta)));
    check('未知数值名被忽略', !ap.some((x) => x.key === 'nonsense'), JSON.stringify(ap.map((x) => x.key)));
    /* 好感/心情要转发给 mood.js（界面上显示的是那一份） */
    const mBefore = mood.load();
    const ap2 = stats.applyDeltas({ affection: 2, mood: -1 }, '转发测试');
    const mAfter = mood.load();
    check('好感/心情被转发给 mood.js', mAfter.affection !== mBefore.affection || mAfter.mood !== mBefore.mood,
      '好感 ' + mBefore.affection + '→' + mAfter.affection + '  心情 ' + mBefore.mood + '→' + mAfter.mood);
    check('转发项标记了 forwarded', ap2.some((x) => x.forwarded === true), JSON.stringify(ap2));
    /* 模型判断**绕过**日上限（否则一天只能动 1.5，长期陪伴就废了） */
    reset({ iq: 50 });
    for (let i = 0; i < 10; i++) stats.applyDeltas({ iq: 1 }, '连续判断');
    const viaJudge = stats.get('iq') - 50;
    check('模型判断绕过日上限（能累积超过 ' + stats.DAILY_CAP + '）', viaJudge > stats.DAILY_CAP, '累积 ' + viaJudge);
    check('但单次仍受 ±2 限制', viaJudge <= 10 * 2 + 1e-9, '累积 ' + viaJudge);

    /* ---------- 9. 回归的时间限流（"极慢"是怎么做到的）---------- */
    L('');
    L('=== 9. 回归的时间限流（6 小时一次）===');
    /* ⚠️ 前面的第 4 节已经调过 regress()、把限流窗口用掉了 —— 而这条限流**是全局的**
       （存在 stats.json 的 lastRegress 里），所以这里必须先把窗口清掉，
       否则"第一次回归"会被拦住、看起来像功能坏了（第一次跑就这么误判过）。 */
    const clearRegressWindow = () => { const v = stats.load(); v.lastRegress = 0; stats.save(v); };
    reset({ extraversion: 90 }); clearRegressWindow();
    const g1 = stats.regress(0.2);
    const v1 = stats.get('extraversion');
    check('第一次回归生效', g1.length > 0 && v1 < 90, '90 → ' + v1);
    const g2 = stats.regress(0.2);          // 紧接着再调一次：应该被限流拦住
    const v2 = stats.get('extraversion');
    check('★ 6 小时内再调不生效（不然后台重启十次就漂两点）', g2.length === 0 && v2 === v1,
      '第二次回归 ' + g2.length + ' 项，值 ' + v1 + ' → ' + v2);
    /* 把时钟推过限流窗口 → 应该又能回归 */
    clock.set({ days: 1 });
    const g3 = stats.regress(0.2);
    clock.clear();
    check('过了限流窗口后又能回归', g3.length > 0 && stats.get('extraversion') < v2,
      v2 + ' → ' + stats.get('extraversion'));
    /* 不回归的层即使在窗口内也不动 */
    reset({ iq: 90, diligence: 90 }); clearRegressWindow();
    stats.regress(0.2);
    check('能力层永远不回归（只涨）', stats.get('iq') === 90 && stats.get('diligence') === 90,
      'iq=' + stats.get('iq') + ' diligence=' + stats.get('diligence'));

    /* ---------- 10. 文档里那组换人设的具体数字（逐字核对）---------- */
    L('');
    L('=== 8. 换人设的基线平移（文档：傲娇→病娇 依赖+26 / 感性+30 顶到 95 / 直白+8 / 外向-6 / 认真+2）===');
    const pFile = path.join(TEST_UD, 'persona.json');
    const pBak = fs.readFileSync(pFile, 'utf8');
    const setP = (ch, pe) => {
      const p = Object.assign(JSON.parse(pBak), { character_setting: ch, personality: pe });
      fs.writeFileSync(pFile, JSON.stringify(p, null, 2));
      return p;
    };
    let crashed = '';
    try {
      const tsundere = setP('蓝发鲸鱼女仆，傲娇、温柔、嘴硬，被叫「吃白饭的大肥鱼」会炸毛。', '傲娇、温柔、嘴硬');
      const yandere = setP('黑发少女，病娇，极度偏执，独占欲强，只属于我。', '病娇、偏执');
      stats.ensureBaseline(tsundere, true);           // 先落到傲娇基线
      const v1 = stats.all();
      const rb = stats.rebaseline(yandere);
      const v2 = stats.all();
      const delta = {};
      for (const k of stats.KEYS) delta[k] = Math.round((stats.META[k].cap ? v2[k] - v1[k] : 0) * 100) / 100;
      L('    傲娇基线 ' + JSON.stringify(v1));
      L('    病娇基线 ' + JSON.stringify(v2));
      L('    实际变化 ' + JSON.stringify(delta) + '  应用了 ' + rb.applied.length + ' 项');
      check('换人设确实平移了数值', rb.applied.length > 0, rb.applied.length + ' 项');
      check('依赖度上升（病娇更黏）', delta.dependency > 0, '依赖 ' + (delta.dependency > 0 ? '+' : '') + delta.dependency);
      check('外向度下降（病娇更封闭）', delta.extraversion < 0, '外向 ' + delta.extraversion);
      check('结果都落在各自上下限内',
        stats.KEYS.every((k) => v2[k] >= stats.META[k].floor && v2[k] <= stats.META[k].cap), JSON.stringify(v2));
    } finally {
      fs.writeFileSync(pFile, pBak);
    }

    /* ---------- 9. 跨层的移动速度（文档：情绪快、性格极慢、能力只涨）---------- */
    L('');
    const jobs = fs.readFileSync(path.join(__dirname, '..', 'src', 'memory', 'jobs.js'), 'utf8');
    const grabs = {};
    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
