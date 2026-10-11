/* loop.js 的单元测试 —— 纯 Node（同一份代码既能在渲染进程当 <script> 用，也能在这里 require）
 * 跑法：node app/scripts/test-loop.js
 */
const L = require('../renderer/loop');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

const LOOKS = ['screen_look', 'screen_shot', 'find_template'];

console.log('=== loop.js 单元测试（纯 Node）===');

/* §1 停止原因是显式的联合类型（不是"循环结束"这种糊话） */
{
  ok(Array.isArray(L.REASONS) && L.REASONS.length === 7, '§1 七个停止原因都登记在册', L.REASONS.join('/'));
  ok(L.REASONS.indexOf('completed') >= 0 && L.REASONS.indexOf('step-budget') >= 0 && L.REASONS.indexOf('look-streak') >= 0,
    '§1 含 completed / step-budget / look-streak');
}

/* §2 正常走若干步 + 正常收尾 */
{
  const c = L.create({ stepBudget: 5, lookStreakMax: 3, lookOnlyTools: LOOKS });
  c.start();
  const r1 = c.beforeStep({ tool: 'click' });
  const r2 = c.beforeStep({ tool: 'key' });
  ok(r1.kind === 'continue' && r2.kind === 'continue', '§2 实际动作照常放行');
  ok(r2.steps === 2, '§2 步数递增', 'steps=' + r2.steps);
  const f = c.finish('completed');
  ok(f.kind === 'stop' && f.reason === 'completed', '§2 正常收尾 → reason=completed');
  ok(c.stats().reason === 'completed', '§2 原因被记下来（stats 里能查到）');
}

/* §3 ★ 只看不动的自转：到第 lookStreakMax+1 次必须停 */
{
  const c = L.create({ stepBudget: 100, lookStreakMax: 3, lookOnlyTools: LOOKS });
  c.start();
  const seq = [];
  for (let i = 0; i < 6; i++) seq.push(c.beforeStep({ tool: 'screen_look' }).kind);
  ok(seq.slice(0, 3).every((k) => k === 'continue'), '§3 前 3 次看屏幕允许（3 = lookStreakMax）', seq.join(','));
  ok(seq[3] === 'stop', '§3 **第 4 次就停**（不是等步数上限）', seq.join(','));
  const s = c.stats();
  ok(s.reason === 'look-streak' && s.lookStreak === 4, '§3 原因是 look-streak 且记下了次数', 'reason=' + s.reason + ' lookStreak=' + s.lookStreak);
}

/* §4 中间插一次实际动作 → 自转计数清零（这是"看→点→看→点"的正常节奏，不该被误杀） */
{
  const c = L.create({ stepBudget: 100, lookStreakMax: 3, lookOnlyTools: LOOKS });
  c.start();
  for (let i = 0; i < 3; i++) c.beforeStep({ tool: 'screen_look' });
  const r = c.beforeStep({ tool: 'click' });      // 实际动作
  ok(r.kind === 'continue' && r.lookStreak === 0, '§4 实际动作把自转计数清零', 'lookStreak=' + r.lookStreak);
  const r2 = c.beforeStep({ tool: 'screen_look' });
  ok(r2.kind === 'continue', '§4 于是又能继续看（没被前面的计数拖累）');
}

/* §5 步数预算用尽 */
{
  const c = L.create({ stepBudget: 3, lookStreakMax: 99, lookOnlyTools: LOOKS });
  c.start();
  const k = [];
  for (let i = 0; i < 5; i++) k.push(c.beforeStep({ tool: 'click' }).kind);
  ok(k.slice(0, 3).every((x) => x === 'continue') && k[3] === 'stop', '§5 第 3 步之后停（budget=3）', k.join(','));
  ok(c.stats().reason === 'step-budget', '§5 原因是 step-budget');
}

/* §6 自转优先于预算：预算还剩很多，但一直在看 → 报的是 look-streak（解释更贴切） */
{
  const c = L.create({ stepBudget: 50, lookStreakMax: 2, lookOnlyTools: LOOKS });
  c.start();
  c.beforeStep({ tool: 'screen_look' });
  c.beforeStep({ tool: 'screen_look' });
  const r = c.beforeStep({ tool: 'screen_look' });
  ok(r.reason === 'look-streak', '§6 预算充足时自转仍然先停，且原因报 look-streak', 'reason=' + r.reason);
}

/* §7 一旦终止，后续 beforeStep 一律不再放行（幂等，防止外部漏判又走一步） */
{
  const c = L.create({ stepBudget: 1, lookStreakMax: 9, lookOnlyTools: LOOKS });
  c.start();
  c.beforeStep({ tool: 'click' });               // 用掉唯一一步
  const stop1 = c.beforeStep({ tool: 'click' });
  const stop2 = c.beforeStep({ tool: 'click' });
  ok(stop1.kind === 'stop' && stop1.reason === 'step-budget', '§7 超预算即停');
  ok(stop2.kind === 'stop' && stop2.alreadyStopped === true, '§7 已终止后再问 → 仍然停（且标明 alreadyStopped）');
}

/* §8 每种原因都给得出一句人话（用户要知道"为什么停"） */
{
  const c = L.create({ stepBudget: 2, lookStreakMax: 1, lookOnlyTools: LOOKS });
  c.start();
  for (const r of L.REASONS) {
    const m = c.messageFor(r, { lastTool: 'screen_look', lookStreak: 3, error: '网络不通' });
    const needMsg = r !== 'completed';
    ok(needMsg ? (typeof m === 'string' && m.length > 8) : m === '', '§8 ' + r + ' 有对应文案', m.slice(0, 46));
  }
  const c2 = L.create({ stepBudget: 9, lookStreakMax: 9, lookOnlyTools: LOOKS });
  c2.start();
  const rr = c2.finish('error', { error: '模型继续失败：超时' });
  ok(rr.reason === 'error' && rr.message.indexOf('超时') >= 0, '§8 error 文案里带上真实错误', rr.message.slice(0, 50));
}

/* §9 中止 / 失败 / 无结果 / 无后续 */
{
  const c = L.create({ stepBudget: 9, lookStreakMax: 9, lookOnlyTools: LOOKS });
  c.start();
  ok(c.abort('主人喊停').reason === 'aborted', '§9 abort → aborted');
  const c2 = L.create({ stepBudget: 9, lookStreakMax: 9, lookOnlyTools: LOOKS });
  c2.start();
  ok(c2.fail(new Error('炸了')).reason === 'error', '§9 fail(err) → error');
  const c3 = L.create({ stepBudget: 9, lookStreakMax: 9, lookOnlyTools: LOOKS });
  c3.start();
  const f1 = c3.finish('no-result');
  ok(f1.reason === 'no-result' && f1.message.indexOf('没有返回结果') >= 0, '§9 no-result 有解释', f1.message.slice(0, 40));
  const c4 = L.create({ stepBudget: 9, lookStreakMax: 9, lookOnlyTools: LOOKS });
  c4.start();
  ok(c4.finish('no-next').reason === 'no-next', '§9 no-next 正常登记');
}

/* §10 没有 start() 就直接问 → 自动开始（防止外部忘记初始化） */
{
  const c = L.create({ stepBudget: 5, lookStreakMax: 5, lookOnlyTools: LOOKS });
  const r = c.beforeStep({ tool: 'click' });
  ok(r.kind === 'continue' && c.stats().started === true, '§10 未 start 也能用（自动开始）');
}

/* §11 预算可以被改（IQ 变化 / 用户调上限）—— 重新 start 时生效 */
{
  const c = L.create({ stepBudget: 2, lookStreakMax: 9, lookOnlyTools: LOOKS });
  c.start();
  c.beforeStep({ tool: 'click' });
  c.beforeStep({ tool: 'click' });
  ok(c.beforeStep({ tool: 'click' }).reason === 'step-budget', '§11 先把 2 步用完');
  const c2 = L.create({ stepBudget: 20, lookStreakMax: 9, lookOnlyTools: LOOKS });
  c2.start();
  const r = c2.beforeStep({ tool: 'click' });
  ok(r.kind === 'continue', '§11 新任务用新预算（每次任务都重新 create/start）');
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
