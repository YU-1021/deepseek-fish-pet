/* repeat.js 的单元测试 —— 纯 Node
 * 跑法：node app/scripts/test-repeat.js
 */
const R = require('../src/repeat');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

console.log('=== repeat.js 单元测试（纯 Node）===');

/* §1 深度排序的规范化：参数书写顺序不同 → 同一个键 */
{
  const a = R.canonicalize({ x: 1, y: 2, nested: { b: 1, a: 2 } });
  const b = R.canonicalize({ y: 2, x: 1, nested: { a: 2, b: 1 } });
  ok(a === b, '§1 深层键顺序不同 → 规范化结果相同', a);
  ok(R.canonicalize([1, 2]) === '[1,2]', '§1 数组保持顺序（数组顺序是有意义的）');
  ok(R.canonicalize({ a: undefined }) === R.canonicalize({}), '§1 undefined 与缺失键一致');
  ok(R.canonicalize('x') === '"x"', '§1 字符串正常');
  ok(R.canonicalize(null) === 'null', '§1 null 正常');
  ok(R.canonicalize(0) === '0' && R.canonicalize(false) === 'false', '§1 假值不被当成空');
}

/* §2 阈值 [3,5,8]：只在这些次数上给提醒，而且首次温和、其后详细 */
{
  const c = R.create();
  const r1 = c.note('click', { x: 100, y: 200 });
  const r2 = c.note('click', { x: 100, y: 200 });
  const r3 = c.note('click', { x: 100, y: 200 });
  const r4 = c.note('click', { x: 100, y: 200 });
  const r5 = c.note('click', { x: 100, y: 200 });
  const r8 = (() => { c.note('click', { x: 100, y: 200 }); c.note('click', { x: 100, y: 200 }); return c.note('click', { x: 100, y: 200 }); })();
  ok(r1.count === 1 && r2.count === 2, '§2 前两次计数正确');
  ok(!r1.advice && !r2.advice, '§2 第 1、2 次**不给提醒**（别烦人）');
  ok(!!r3.advice && r3.advice.indexOf('换一种做法') >= 0, '§2 第 3 次给**温和**提醒', r3.advice.slice(0, 40));
  ok(!r4.advice, '§2 第 4 次不给提醒（只在阈值点上说话）');
  ok(!!r5.advice && r5.advice.indexOf('第 5 次') >= 0, '§2 第 5 次给**详细**提醒');
  ok(r8.count === 8 && r8.block === true, '§2 第 8 次触发**安全阀**（这次不执行）', r8.advice.slice(0, 30));
}

/* §3 参数顺序不同 → 算同一个动作（这是换算法的核心理由） */
{
  const c = R.create();
  c.note('click', { y: 200, x: 100 });
  c.note('click', { x: 100, y: 200 });
  const r = c.note('click', { x: 100, y: 200, });
  ok(r.count === 3, '§3 键顺序不同仍算同一动作（累计到 3）', 'count=' + r.count);
  ok(!!r.advice, '§3 于是第 3 次能正确提醒');
}

/* §4 参数真的不同 → 各自独立计数 */
{
  const c = R.create();
  c.note('click', { x: 100 });
  c.note('click', { x: 140 });
  const r = c.note('click', { x: 100 });
  ok(r.count === 2, '§4 换了坐标就是新动作', 'count=' + r.count);
  ok(!r.advice, '§4 不误报');
}

/* §5 真用户消息 → 重置 */
{
  const c = R.create();
  c.note('click', { x: 1 }); c.note('click', { x: 1 });
  ok(c.count('click', { x: 1 }) === 2, '§5 重置前计数 2');
  c.reset();
  ok(c.count('click', { x: 1 }) === 0 && c.size() === 0, '§5 reset 之后清零');
  const r = c.note('click', { x: 1 });
  ok(r.count === 1, '§5 重置后从 1 重新数（主人插话 = 环境变了）');
}

/* §6 透明工具：未登记的不计数、也不清零 */
{
  const c = R.create({ registry: { include: ['click'] } });
  const t1 = c.note('screen_look', { q: 'x' });
  ok(t1.transparent === true && t1.count === 0, '§6 未登记工具是透明的（不计数）', JSON.stringify(t1));
  c.note('click', { x: 1 }); c.note('click', { x: 1 });
  c.note('screen_look', { q: 'x' });                       // 透明工具**不该**清零 click 的计数
  const r = c.note('click', { x: 1 });
  ok(r.count === 3, '§6 透明工具不影响其它工具的计数', 'count=' + r.count);
  /* exclude 形式 */
  const c2 = R.create({ registry: { exclude: ['windows_list'] } });
  ok(c2.note('windows_list', {}).transparent === true, '§6 exclude 形式：被排除的透明');
  ok(c2.note('click', {}).transparent === false, '§6 exclude 形式：其它参与计数');
}

/* §7 滑窗（不让计数表无限增长） */
{
  const c = R.create({ window: 5 });
  for (let i = 0; i < 20; i++) c.note('click', { x: i });
  ok(c.size() <= 5, '§7 计数表不超过 window', 'size=' + c.size());
}

/* §8 关掉安全阀（blockAt: 0）→ 纯提醒，绝不阻止 */
{
  const c = R.create({ blockAt: 0 });
  let last = null;
  for (let i = 0; i < 12; i++) last = c.note('click', { x: 1 });
  ok(last.count === 12 && last.block === false, '§8 blockAt:0 时永远不阻止（纯 DSH 语义）', JSON.stringify(last).slice(0, 60));
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
