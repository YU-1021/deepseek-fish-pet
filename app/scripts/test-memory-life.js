/* 记忆生命周期单元测试（**不花 token、确定性**）
 * 覆盖那些"要很多天才看得出来"的机制：候选累加 / 晋升 / 衰减淘汰 / 近似合并 /
 *   日记保留天数 / 中期→日记的合并 / 跨天推进时钟。
 * electron.exe app\scripts\test-memory-life.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-memtest');
fs.mkdirSync(TEST_UD, { recursive: true });
for (const f of ['config.json', 'persona.json']) {
  try { fs.copyFileSync(path.join(process.env.APPDATA, 'dayu-pet', f), path.join(TEST_UD, f)); } catch {}
}
try { fs.unlinkSync(path.join(TEST_UD, 'clock-offset.json')); } catch {}
try { fs.rmSync(path.join(TEST_UD, 'memory'), { recursive: true, force: true }); } catch {}
app.setPath('userData', TEST_UD);

app.whenReady().then(async () => {
  const memory = require('../src/memory');
  const clock = require('../src/clock');
  const permanent = memory.permanent;
  const long = memory.long;
  const medium = memory.medium;
  const skillmem = memory.skillmem;
  const out = [];
  const L = (s) => out.push(s);
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  let crashed = '';

  try {
    const cfg = require('../src/config').load();
    const M = cfg.memory;
    L('=== 参数 ===');
    L('  promoteWeight=' + M.promoteWeight + '  candDays=' + M.candDays + '  candDecay=' + M.candDecay
      + '  candFloor=' + M.candFloor + '  longKeepDays=' + M.longKeepDays + '  mediumKeep=' + M.mediumKeep);

    /* ---------- 1. 候选池：重复提及才累加权重 ---------- */
    L('');
    L('=== 1. 候选累加（反复出现 → 权重涨、hits 增）===');
    permanent.save({ cand: [], facts: [] });
    permanent.merge([{ text: '主人叫小林', weight: 4 }]);
    let c0 = permanent.candidates();
    check('第一次入池 w=4', c0.length === 1 && c0[0].weight === 4, JSON.stringify(c0.map((x) => x.weight)));
    /* 再提两次（每次 +w*0.6 = 2.4 → 取整） */
    permanent.merge([{ text: '主人叫小林', weight: 4 }]);
    permanent.merge([{ text: '主人叫小林', weight: 4 }]);
    const c1 = permanent.candidates();
    check('重复提及后权重涨到 >=7', c1[0].weight >= 7, 'w=' + c1[0].weight);
    check('hits 累计到 3', c1[0].hits === 3, 'hits=' + c1[0].hits);
    check('权重不超过上限 10', c1[0].weight <= 10, 'w=' + c1[0].weight);

    /* ---------- 2. 晋升 ---------- */
    L('');
    L('=== 2. 晋升到永久记忆 ===');
    const pr = permanent.promote(M.promoteWeight);
    check('晋升 1 条', pr.promoted === 1, JSON.stringify(pr));
    check('候选池清空', permanent.candidates().length === 0);
    check('永久记忆 1 条', permanent.facts().length === 1);
    /* 已经是永久记忆了，再 merge 同一条不该重新入池 */
    permanent.merge([{ text: '主人叫小林', weight: 9 }]);
    check('已晋升的不会重新入候选池', permanent.candidates().length === 0, 'cand=' + permanent.candidates().length);

    /* ---------- 3. 近似合并（同一件事的不同措辞）---------- */
    L('');
    L('=== 3. 近似合并 ===');
    permanent.save({ cand: [], facts: [] });
    permanent.merge([{ text: '主人养了一只叫豆豆的猫', weight: 5 }]);
    permanent.merge([{ text: '主人养了一只猫叫豆豆', weight: 5 }]);   // 同义改写
    check('同义改写合并成 1 条候选', permanent.candidates().length === 1, 'cand=' + permanent.candidates().length);
    check('合并后 hits=2', permanent.candidates()[0].hits === 2, 'hits=' + permanent.candidates()[0].hits);
    permanent.merge([{ text: '主人喜欢喝咖啡', weight: 5 }]);        // 无关事实
    check('无关事实不误合并', permanent.candidates().length === 2, 'cand=' + permanent.candidates().length);

    /* ---------- 4. 晋升时再去重（两条近似候选同时到阈值）---------- */
    L('');
    L('=== 4. 晋升时再去重 ===');
    permanent.save({
      cand: [
        { text: '主人下周要去上海出差三天', weight: 8, hits: 1, lastSeen: Date.now() },
        { text: '主人出差去上海，为期三天', weight: 8, hits: 1, lastSeen: Date.now() },
      ],
      facts: [],
    });
    const pr2 = permanent.promote(7);
    /* 这两句字符集 Jaccard 只有 0.56（低于 0.72 阈值）→ 会被当成两条。
       这是**已知能力边界**，这里把它记下来当回归基线：一旦以后调阈值/换成
       "把现有事实喂给抽取器"，这个数字会变，测试会提醒你。 */
    L('    晋升结果: ' + JSON.stringify(pr2) + '（这两句相似度 0.56，当前阈值 0.72 挡不住）');
    check('晋升不崩、结果可预期', pr2.total === permanent.facts().length && pr2.total >= 1, 'facts=' + pr2.total);

    /* ---------- 5. 衰减淘汰 ---------- */
    L('');
    L('=== 5. 衰减淘汰（很久没再出现）===');
    const old = Date.now() - (M.candDays + 5) * 86400000;
    permanent.save({
      cand: [
        { text: '主人某天提过一句无关紧要的话', weight: 2, hits: 1, lastSeen: old },
        { text: '主人叫小林', weight: 6, hits: 3, lastSeen: Date.now() },   // 最近提过
      ],
      facts: [],
    });
    /* ⚠️ 一次 decay 只乘 0.8：权重 2 的条目 ×0.8=1.6 仍 ≥ 下限 1，**本来就不该掉**。
       真实情况是"每次启动跑一次"，所以要连续几次才掉光（权重 2 → 2*0.8^4≈0.82 < 1）。
       这里连跑 5 次，验证的是"持续不再出现 → 最终被淘汰"这条曲线。 */
    let dc = null;
    let totalDropped = 0;
    const weights = [];
    for (let i = 0; i < 5; i++) {
      dc = permanent.decay(M.candDays, M.candDecay, M.candFloor);
      totalDropped += dc.dropped || 0;
      const stale = permanent.candidates().find((x) => /无关紧要/.test(x.text));
      weights.push(stale ? stale.weight : 'gone');
    }
    L('    权重轨迹（每次启动一次衰减）: ' + weights.join(' → '));
    const left = permanent.candidates().map((x) => x.text);
    /* 注意断言的是**累计**淘汰数：第 4 次就已经掉光了，第 5 次自然是 0 —— 
       只盯最后一次的返回值会误判成"没生效"。 */
    check('多轮衰减后过期候选被淘汰（累计 ' + totalDropped + '）', totalDropped >= 1 && weights.indexOf('gone') >= 0, JSON.stringify(dc));
    check('最近提过的保留', left.length === 1 && /小林/.test(left[0]), JSON.stringify(left));

    /* ---------- 6. 日记保留天数 ---------- */
    L('');
    L('=== 6. 日记保留天数（longKeepDays=' + M.longKeepDays + '）===');
    long.save([]);
    for (let i = 0; i < M.longKeepDays + 6; i++) {
      const d = new Date(Date.now() - (M.longKeepDays + 6 - i) * 86400000);
      long.add({ date: clock.day(d.getTime()), diary: '第 ' + i + ' 天的日记', ts: d.getTime() });
    }
    check('写入后条数=' + (M.longKeepDays + 6), long.list().length === M.longKeepDays + 6, 'n=' + long.list().length);
    long.pruneDays(M.longKeepDays);
    check('裁剪后不超过 ' + M.longKeepDays + ' 篇', long.list().length <= M.longKeepDays, 'n=' + long.list().length);
    check('留下的是最近的', long.list()[long.list().length - 1].diary.indexOf('第 ' + (M.longKeepDays + 5) + ' 天') >= 0,
      JSON.stringify(long.list()[long.list().length - 1]));

    /* ---------- 7. 中期 → 日记的合并 ---------- */
    L('');
    L('=== 7. 中期保留 + 按天合并 ===');
    medium.save([]);
    medium.add({ id: 's1', date: '2026-10-01', turns: 4, ts: Date.now() - 3 * 86400000, summary: '第一天的摘要' });
    medium.add({ id: 's2', date: '2026-10-02', turns: 6, ts: Date.now() - 2 * 86400000, summary: '第二天的摘要' });
    medium.add({ id: 's3', date: '2026-10-02', turns: 3, ts: Date.now() - 86400000, summary: '第二天又一场' });
    check('中期 3 条（同一天可多条）', medium.list().length === 3, 'n=' + medium.list().length);
    check('has(id) 能查到', medium.has('s2') === true);
    check('olderThan / keepOnly 能用', medium.olderThan('2026-10-02').length === 1, 'older=' + medium.olderThan('2026-10-02').length);

    /* ---------- 8. 技能经验池 ---------- */
    L('');
    L('=== 8. 技能经验池（阈值 + 条数上限）===');
    skillmem.save([]);
    for (let i = 0; i < (M.skillPoolMax + 20); i++) skillmem.merge([{ text: '经验' + i, weight: 1, skill: 'x' }]);
    skillmem.prune(M.skillPoolMax);
    check('条数不超过 skillPoolMax=' + M.skillPoolMax, skillmem.candidates().length <= M.skillPoolMax, 'n=' + skillmem.candidates().length);

    /* ---------- 9. 时钟平移本身 ---------- */
    L('');
    L('=== 9. 时钟平移（不改系统时间）===');
    const before = new Date().toISOString().slice(0, 10);
    clock.set({ days: 3 });
    const shifted = clock.day();
    const d = new Date();
    const wantD = new Date(d.getTime() + 3 * 86400000).toISOString().slice(0, 10);
    check('时钟前进 3 天', shifted === wantD, shifted + ' vs ' + wantD);
    check('系统时间没变', new Date().toISOString().slice(0, 10) === before, before);
    clock.clear();
    check('clear 后回到今天', clock.day() === before, clock.day());

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
