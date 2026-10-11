/* sessionfmt.js 的单元测试 —— 纯 Node
 * 跑法：node app/scripts/test-sessionfmt.js
 */
const S = require('../src/sessionfmt');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

console.log('=== sessionfmt.js 单元测试（纯 Node）===');

/* §1 链子自检 */
{
  let threw = false;
  try { S.selfCheck(); } catch (e) { threw = true; }
  ok(!threw, '§1 迁移链自检通过（相邻、且连到当前版本）');
  ok(S.CURRENT === 2, '§1 当前版本是 2（v2 = 存事件日志）', 'CURRENT=' + S.CURRENT);
  ok(S.MIGRATIONS.length === 2 && S.MIGRATIONS[0].from === 0 && S.MIGRATIONS[1].from === 1 && S.MIGRATIONS[1].to === 2, '§1 链里有 0→1→2（相邻）');
}

/* §2 v0（没有 version 的老形状）→ v1，并把历史上那个内联补丁正式收进来 */
{
  const legacy = {
    id: 's-old', startedAt: 123, savedAt: 456,
    messages: [
      { role: 'assistant', compact: 'EN: Hello there' },      // ← 旧草稿：看起来像正常回复，会把模型教坏
      { role: 'user', content: 'hi' },
      { role: 'assistant', compact: '(earlier reply, abridged) 已经是好的' },  // ← 已经修过的，不该被改两次
    ],
  };
  const r = S.migrate(legacy);
  ok(r.ok === true && r.from === 0 && r.migrated === true, '§2 v0 被识别并迁移', JSON.stringify({ from: r.from, migrated: r.migrated }));
  ok(r.data.version === 2, '§2 v0 一路迁到 version=2');
  ok(r.data.events[0].compact.indexOf('(earlier reply, abridged)') === 0, '§2 **旧 compact 被正规化**（v0→v1 那步做的）', r.data.events[0].compact.slice(0, 46));
  ok(r.data.events[0].compact.indexOf('EN:') < 0, '§2 结果里不再有"EN:"这种误导性前缀');
  ok(r.data.events[2].compact === '(earlier reply, abridged) 已经是好的', '§2 已经修过的不被二次修改（幂等）');
  ok(r.data.id === 's-old' && r.data.startedAt === 123, '§2 其它字段原样保留');
  ok(legacy.version === undefined && legacy.messages[0].compact.indexOf('(earlier') < 0, '§2 **没有就地改原对象**（迁移是纯函数）');
  ok(Array.isArray(r.data.events) && r.data.messages === undefined, '§2 v2 里存的是 events，不再有 messages');
  ok(r.data.events.length === 3 && r.data.events[1].content === 'hi', '§2 messages 被逐条转成事件，内容不丢');
}

/* §3 幂等：已经是当前版本的再迁一次不变 */
{
  const v2 = { version: 2, id: 'a', events: [] };
  const r = S.migrate(v2);
  ok(r.ok && r.from === 2 && r.migrated === false, '§3 v2 再迁移 → 不变、且标记 migrated=false');
  const r1b = S.migrate({ version: 1, id: 'b', messages: [{ role: 'user', content: 'x' }] });
  ok(r1b.ok && r1b.from === 1 && r1b.migrated === true && r1b.data.version === 2 && r1b.data.events.length === 1, '§3 v1 → v2 单独这一步也能走');
}

/* §4 ★ 比程序还新的版本 → 拒绝加载（照 DSH :134），而且错误信息要能指导人 */
{
  const future = { version: 99, id: 'x', events: [] };
  const r = S.migrate(future);
  ok(r.ok === false, '§4 高版本被拒绝');
  ok(/更新版本/.test(r.error) && /拒绝加载/.test(r.error), '§4 错误信息说清原因和处理办法', r.error.slice(0, 60));
  ok(r.data === undefined, '§4 拒绝时**不返回可写的数据**（防止误覆盖）');
}

/* §5 坏数据不崩、也不产生可写数据 */
{
  ok(S.migrate(null).ok === true, '§5 null → 当作空数据处理');
  const r1 = S.migrate([1, 2, 3]);
  ok(r1.ok === false && /数组/.test(r1.error), '§5 数组形状被拒绝（并说明读到的是数组）', r1.error.slice(0, 40));
  const r2 = S.migrate('一段字符串');
  ok(r2.ok === false, '§5 字符串被拒绝');
  const r3 = S.migrate({ version: 'abc' });
  ok(r3.ok === true && r3.from === 0, '§5 version 不是数字 → 当成 v0（宽容）', 'from=' + r3.from);
  const r4 = S.migrate({ version: -5 });
  ok(r4.ok === true && r4.from === 0, '§5 负数版本 → 当成 v0');
}

/* §6 wrap：写盘时带上版本 */
{
  const w = S.wrap({ id: 'z', events: [] });
  ok(w.version === S.CURRENT, '§6 wrap 补上当前版本号');
  ok(S.wrap(null) === null, '§6 wrap(null) 安全');
  const r = S.migrate(w);
  ok(r.ok && r.migrated === false, '§6 wrap 出来的数据再迁移是 no-op（自洽）');
}

/* §7 缺边的链子必须**立刻抛错**（照 DSH :124 的"宁可启动就炸"） */
{
  const orig = S.MIGRATIONS.slice();
  try {
    S.MIGRATIONS.length = 0;
    let threw = false;
    try { S.selfCheck(); } catch (e) { threw = true; }
    ok(threw, '§7 链子不完整时 selfCheck 抛错（不会静默用错格式）');
    /* 缺一条 from 不匹配的 */
    S.MIGRATIONS.push({ from: 5, to: 6, up: (d) => d });
    threw = false;
    try { S.selfCheck(); } catch (e) { threw = true; }
    ok(threw, '§7 起点不连续（0 之后接 5）也抛错');
  } finally {
    S.MIGRATIONS.length = 0;
    for (const m of orig) S.MIGRATIONS.push(m);
  }
}

/* §8 缺边时 migrate 给可读错误（而不是崩） */
{
  const r = S.migrate({ version: 0 });
  ok(r.ok === true, '§8 恢复后正常路径仍然可用（§7 的破坏已还原）');
}

/* §9 ★★ 畸形文件的防御：有 events 但没有 messages（版本号被写坏过）时，绝不清空 */
{
  const malformed = { version: 1, id: 'm', events: [{ kind: 'msg', role: 'user', content: '不能丢' }] };
  const r = S.migrate(malformed);
  ok(r.ok && r.data.version === 2, '§9 畸形文件被迁到 v2');
  ok(r.data.events && r.data.events.length === 1 && r.data.events[0].content === '不能丢', '★★ §9 events 被保留（这正是 213 条丢失的场景）');
  const normal = { version: 1, id: 'n', messages: [{ role: 'user', content: '正常的' }] };
  const r2 = S.migrate(normal);
  ok(r2.data.events.length === 1 && r2.data.events[0].content === '正常的', '§9 正常的 v1（messages）照旧转换');
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
