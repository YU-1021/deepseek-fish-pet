/* surface.js 的单元测试 —— 纯 Node
 * 跑法：node app/scripts/test-surface.js
 */
const S = require('../src/surface');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

console.log('=== surface.js 单元测试（纯 Node）===');

/* §1 只追加：日志和投影一一对应 */
{
  const s = S.create();
  s.append({ kind: 'msg', role: 'user', content: '你好' });
  s.append({ kind: 'msg', role: 'assistant', content: '在' });
  const p = s.project();
  ok(p.length === 2, '§1 没剪过时，投影 = 全部事件', 'nodes=' + p.length);
  ok(p[0].content === '你好' && p[1].content === '在', '§1 内容与顺序都对');
  ok(p[0].seq === 1 && p[1].seq === 2, '§1 每个节点带 sourceSeqs 便于追溯', JSON.stringify(p.map((x) => x.seq)));
}

/* §2 ★ 剪枝之后：投影变短，但**原始日志一字不少** */
{
  const s = S.create({ maxInlineChars: 100, keepRecent: 1, minSaveChars: 50 });
  s.append({ kind: 'msg', role: 'user', content: '一' });
  const long = 'X'.repeat(5000);
  s.append({ kind: 'tool', role: 'user', content: long, tool: 'screen_look' });
  s.append({ kind: 'msg', role: 'assistant', content: '最后一句' });
  const before = s.stats();
  const r = s.prune();
  ok(r.ok && r.pruned === true, '§2 剪掉了一条超长的', JSON.stringify({ shadowed: r.shadowed, saved: r.savedChars }));
  const after = s.stats();
  const p = s.project();
  ok(p.length === 3, '§2 节点数没变（被剪的位置换成了摘要节点）', 'nodes=' + p.length);
  ok(after.visibleChars < before.visibleChars, '§2 投影字符数确实下降了', before.visibleChars + ' → ' + after.visibleChars);
  /* ★ 关键：原始那条 5000 字的内容**还在日志里** */
  const evs = s.events();
  const rawLong = evs.find((e) => e.kind === 'tool');
  ok(rawLong && rawLong.content.length === 5000, '★ §2 原始长内容**仍在事件日志里**（历史没被改写）', 'len=' + (rawLong ? rawLong.content.length : '-'));
  ok(p.some((n) => n.pruned === true && /已被折叠/.test(n.content)), '§2 投影里那一条变成了摘要节点');
  ok(p.some((n) => n.content === '最后一句'), '§2 最近的一条被保留了');
}

/* §3 ★ 可回放：同样的日志投影两次结果完全一样 */
{
  const s = S.create({ maxInlineChars: 50, keepRecent: 1, minSaveChars: 10 });
  s.append({ kind: 'msg', role: 'user', content: 'a' });
  s.append({ kind: 'tool', role: 'user', content: 'Y'.repeat(400), tool: 'find_text' });
  s.prune();
  const p1 = JSON.stringify(s.project());
  const p2 = JSON.stringify(s.project());
  ok(p1 === p2, '★ §3 投影是纯函数（同样日志 → 同样结果，可回放）');
  /* 甚至"重建一个 provider 再喂同样的事件"也应当一致 */
  const s2 = S.create({ maxInlineChars: 50, keepRecent: 1, minSaveChars: 10 });
  for (const e of s.events()) s2.append(e);
  ok(JSON.stringify(s2.project()) === p1, '★ §3 把事件重放给一个新实例，投影仍然一致（真的可回放）');
}

/* §4 最近的 N 条永远不剪（她正在做的事就在里面） */
{
  const s = S.create({ maxInlineChars: 10, keepRecent: 3, minSaveChars: 1 });
  s.append({ kind: 'tool', role: 'user', content: 'A'.repeat(500), tool: 'x' });
  s.append({ kind: 'tool', role: 'user', content: 'B'.repeat(500), tool: 'x' });
  s.append({ kind: 'tool', role: 'user', content: 'C'.repeat(500), tool: 'x' });
  const r = s.prune();
  ok(r.ok && r.pruned === false, '§4 只剩最近 3 条时不再剪', r.reason);
}

/* §5 反复剪：pruneAll 能一次剪多次，且不会重复剪同一条 */
{
  const s = S.create({ maxInlineChars: 100, keepRecent: 1, minSaveChars: 50 });
  s.append({ kind: 'msg', role: 'user', content: '头' });
  for (let i = 0; i < 5; i++) s.append({ kind: 'tool', role: 'user', content: 'Z'.repeat(1000) + i, tool: 't' + i });
  s.append({ kind: 'msg', role: 'assistant', content: '尾' });
  const r = s.pruneAll();
  ok(r.ok && r.count === 5, '§5 五条超长的都被剪了', 'count=' + r.count);
  const p = s.project();
  ok(p.length === 7, '§5 节点数不变（每一条都换成了摘要）', 'nodes=' + p.length);
  const again = s.pruneAll();
  ok(again.count === 0, '§5 再剪一次没有可剪的（**不会重复剪同一条**）', again.last);
  ok(s.stats().prunes === 5, '§5 事件日志里正好 5 条 prune 记录', 'prunes=' + s.stats().prunes);
}

/* §6 剪不动的情况要给出原因（而不是默默什么都不做）
   注意：长条目要放在**保留窗口之外**（keepRecent=2 → 得让它不是最后两条之一），
   否则会被"保留最近的"规则先挡掉，测不到 minSaveChars 这条。 */
{
  const s = S.create({ maxInlineChars: 1000, keepRecent: 2, minSaveChars: 5000 });
  s.append({ kind: 'msg', role: 'user', content: '头' });
  s.append({ kind: 'tool', role: 'user', content: 'M'.repeat(2000), tool: 't' });   // 超过 maxInlineChars(1000)，但省不下 minSaveChars(5000)
  s.append({ kind: 'msg', role: 'assistant', content: '中' });
  s.append({ kind: 'msg', role: 'assistant', content: '尾' });                      // 让它落在保留窗口外
  const r = s.prune();
  ok(r.ok && r.pruned === false && /省不下/.test(r.reason || ''), '§6 省得不够多时不剪，并说明原因', r.reason);
}

/* §7 外部拿去的事件是拷贝，改不动内部 */
{
  const s = S.create();
  s.append({ kind: 'msg', role: 'user', content: '原文' });
  const evs = s.events();
  evs[0].content = '被篡改';
  ok(s.project()[0].content === '原文', '§7 events() 返回拷贝（外部改不动历史）');
  const p = s.project();
  p[0].content = '又篡改';
  ok(s.project()[0].content === '原文', '§7 project() 也返回拷贝');
}

/* §8 stats 说清"原始多少 / 可见多少 / 省了多少" */
{
  const s = S.create({ maxInlineChars: 100, keepRecent: 1, minSaveChars: 10 });
  s.append({ kind: 'msg', role: 'user', content: 'a' });
  s.append({ kind: 'tool', role: 'user', content: 'W'.repeat(2000), tool: 't' });
  s.append({ kind: 'msg', role: 'assistant', content: '尾' });   // 让长条目落在保留窗口外
  const r = s.prune();
  ok(r.ok && r.pruned === true, '§8 前置：这次真的剪到了', r.reason || ('省 ' + r.savedChars));
  const st = s.stats();
  ok(st.events === 4 && st.prunes === 1 && st.rawNodes === 3 && st.visibleNodes === 3, '§8 事件/剪枝/原始节点/可见节点 计数正确', JSON.stringify(st));
  ok(st.rawChars > st.visibleChars && st.savedChars > 0, '§8 原始字符 > 可见字符，且报出省下多少', '省 ' + st.savedChars);
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
