/* storefmt.js 的单元测试 —— 纯 Node
 * 跑法：node app/scripts/test-storefmt.js
 */
const S = require('../src/storefmt');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

console.log('=== storefmt.js 单元测试（纯 Node）===');

/* §1 链自检 + 版本基线 */
{
  let threw = false;
  try { S.selfCheck(); } catch { threw = true; }
  ok(!threw, '§1 迁移链自检通过（相邻、连到当前版本）');
  ok(S.CURRENT === 1, '§1 当前版本是 1', 'CURRENT=' + S.CURRENT);
  ok(S.ARRAY_NS.length === 3 && S.ARRAY_NS.indexOf('statslog') >= 0, '§1 数组命名空间登记在案', S.ARRAY_NS.join(','));
}

/* §2 ★ 对象命名空间：v0（没有 version）→ v1，而且字段一个不少 */
{
  const raw = { cand: [{ text: 'a', weight: 3 }], facts: [{ text: 'b' }] };   // 模拟真实的 permanent.json
  const m = S.migrate('permanent', raw);
  ok(m.ok && m.from === 0 && m.migrated === true && m.shape === 'object', '§2 无版本的对象被识别并迁移', JSON.stringify({ from: m.from, shape: m.shape }));
  ok(m.data.version === 1, '§2 迁移后带上 version=1');
  ok(m.data.cand && m.data.cand.length === 1 && m.data.facts && m.data.facts.length === 1, '§2 ★原有字段一个不少（只加版本，不动数据）');
  ok(raw.version === undefined, '§2 ★没有就地改传入的对象（迁移是纯函数）');
}

/* §3 已经是当前版本 → no-op */
{
  const m = S.migrate('stats', { version: 1, counts: { iq: 54 } });
  ok(m.ok && m.from === 1 && m.migrated === false, '§3 v1 再迁移是 no-op');
  ok(m.data.counts.iq === 54, '§3 数据原样');
}

/* §4 ★ 数组命名空间：保持原样（不包装），并说明原因 */
{
  const arr = [{ date: '2026-10-02', diary: 'x' }];
  const m = S.migrate('long', arr);
  ok(m.ok && Array.isArray(m.data) && m.data.length === 1, '§4 long 是数组 → 原样通过', m.note);
  ok(m.data === arr, '§4 连引用都没换（不做任何包装）');
  ok(S.migrate('statslog', [{ ts: 1 }]).shape === 'array', '§4 statslog 同理');
  /* 未登记的数组也给过，但标注出来 */
  const m2 = S.migrate('没登记过的', [{ a: 1 }]);
  ok(m2.ok && Array.isArray(m2.data) && /未登记/.test(m2.note || ''), '§4 未登记的数组原样通过并标注', m2.note);
}

/* §5 ★ ending 的 null 是合法状态（第一版审计把它当成了坏文件） */
{
  const m = S.migrate('ending', null);
  ok(m.ok && m.data === null, '★ §5 ending 的 null 原样通过（合法状态，不是坏数据）', m.note);
  ok(m.shape === 'scalar', '§5 形状识别为标量');
  ok(S.migrate('ending', 'x').data === 'x', '§5 其它标量也原样通过');
}

/* §6 ★ 高版本 → 拒绝加载，且不返回可写数据 */
{
  const m = S.migrate('style', { version: 99, name: 'x' });
  ok(m.ok === false, '§6 高版本被拒绝');
  ok(/更新版本/.test(m.error) && /只读/.test(m.error), '§6 错误信息说清原因与处置', m.error.slice(0, 56));
  ok(m.data === undefined, '§6 ★拒绝时不给可写数据（防止误覆盖）');
}

/* §7 wrap：对象加版本、数组/标量原样 */
{
  const w = S.wrap('permanent', { facts: [] });
  ok(w.version === S.CURRENT && Array.isArray(w.facts), '§7 对象被包上当前版本');
  const a = [1, 2];
  ok(S.wrap('long', a) === a, '§7 数组原样返回（引用都不换）');
  ok(S.wrap('ending', null) === null, '§7 null 原样');
  ok(S.wrap('x', undefined) === undefined, '§7 undefined 原样（由 store.write 负责拒绝）');
  const self = S.migrate('permanent', w);
  ok(self.ok && self.migrated === false, '§7 wrap 出来的数据再迁移是 no-op（自洽）');
}

/* §8 version 字段异常时的宽容处理 */
{
  ok(S.migrate('stats', { version: 'abc' }).from === 0, '§8 version 不是数字 → 当 v0');
  ok(S.migrate('stats', { version: -3 }).from === 0, '§8 负数版本 → 当 v0');
  ok(S.migrate('stats', { version: 0 }).ok === true, '§8 version: 0 也正常走迁移');
  ok(S.detectVersion([]) === 0 && S.detectVersion(null) === 0, '§8 数组/null 的版本当 0');
}

/* §9 链子断了必须抛错（照 DSH 的"宁可启动就炸"） */
{
  const orig = S.MIGRATIONS['*'];
  try {
    S.MIGRATIONS['*'] = [{ from: 0, to: 1, up: (d) => d }, { from: 3, to: 4, up: (d) => d }];
    let threw = false;
    try { S.selfCheck(); } catch { threw = true; }
    ok(threw, '§9 链子不连续时 selfCheck 抛错');
    const m = S.migrate('permanent', { a: 1 });
    ok(m.ok === false || m.ok === true, '§9 migrate 本身不崩（返回结果）');
  } finally { S.MIGRATIONS['*'] = orig; }
  ok(S.migrate('permanent', { a: 1 }).ok === true, '§9 还原后恢复正常');
}

/* §12 ★★ 自带版本体系的命名空间（session v2）绝不能被本模块覆盖 —— 这是实测数据事故的根因 */
{
  const sess = { version: 2, id: 'x', events: [{ role: 'user', content: 'hi' }] };
  const w = S.wrap('session', sess);
  ok(w.version === 2, '★★ §12 wrap 不会把 session 的 v2 覆盖成本模块的版本', 'version=' + w.version);
  ok(w.events && w.events.length === 1, '★★ §12 events 原样保留（这正是被清掉过的东西）');
  ok(w === sess, '§12 直接返回原对象（连拷贝都不做）');
  const m = S.migrate('session', sess);
  ok(m.ok && m.migrated === false && m.data.version === 2, '★★ §12 migrate 也不介入（不迁移、不判"太高"）', m.note);
  ok(S.migrate('session', sess).data.events.length === 1, '★★ §12 迁移后 events 仍在');
  /* 对比：普通命名空间仍然正常加版本 */
  const perm = S.wrap('permanent', { facts: [] });
  ok(perm.version === S.CURRENT, '§12 普通命名空间照样被包上版本');
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
