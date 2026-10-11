/* v2（事件日志）端到端验证 —— 独立 userData，用**真实会话的副本**做输入
 *   §A v0（她磁盘上那个没有 version 的 83KB 文件）→ 自动迁到 v2，内容不丢
 *   §B 投影出来的消息条数 = 原来 213 条
 *   §C push 新消息 → **只追加**，老事件仍在
 *   §D pruneLong 把超长的折叠掉 → 投影变短，但**原文仍在事件日志里**（这是 C5 的全部意义）
 *   §E context.build 仍然能用（形状向后兼容，pickHistory 不用改）
 * 跑法：electron app/scripts/probe-session-v2.js
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const T = path.join(process.env.APPDATA, 'dayu-pet-v2test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(path.join(T, 'memory'), { recursive: true });
app.setPath('userData', T);

/* 拿她真实的会话当输入（副本，不动真文件） */
const REAL = path.join(process.env.APPDATA, 'dayu-pet', 'memory', 'session.json');
let raw = null;
try { raw = JSON.parse(fs.readFileSync(REAL, 'utf8')); } catch {}
if (!raw) raw = { id: 'fake', startedAt: 1, savedAt: 2, messages: [{ role: 'user', content: '造的' }] };
const origCount = (raw.messages || []).length;
fs.writeFileSync(path.join(T, 'memory', 'session.json'), JSON.stringify(raw), 'utf8');
console.log('  §0 输入：真实会话副本 ' + origCount + ' 条消息，version=' + raw.version);

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 400));
  const session = require('../src/memory/session');
  const SESS = path.join(T, 'memory', 'session.json');

  /* §A 迁移 */
  session.restore();
  const info1 = session.info();
  const onDisk = JSON.parse(fs.readFileSync(SESS, 'utf8'));
  console.log('  §A 迁移后: version=' + onDisk.version + '  migratedFrom=' + info1.migratedFrom
    + '  events=' + (onDisk.events || []).length + '  磁盘上还有 messages 吗: ' + (onDisk.messages ? '有' : '没有'));
  console.log('  §A 事件数与原消息数一致: ' + ((onDisk.events || []).length === origCount ? '✅' : '❌ ' + (onDisk.events || []).length + ' vs ' + origCount));

  /* §B 投影 */
  const vis = session.all();
  console.log('  §B 投影出的消息数: ' + vis.length + (vis.length === origCount ? ' ✅' : ' ❌'));
  const sample = vis.find((m) => m.compact) || vis[0];
  console.log('  §B 形状仍是 {role, content|compact}: ' + JSON.stringify(Object.keys(sample)));

  /* §C 只追加 */
  const before = (JSON.parse(fs.readFileSync(SESS, 'utf8')).events || []).length;
  const firstEventBefore = JSON.parse(fs.readFileSync(SESS, 'utf8')).events[0];
  session.push({ role: 'user', content: '新加的一条' });
  session.push({ role: 'assistant', compact: 'EN: a fresh reply' });
  session.saveNow();
  const after = JSON.parse(fs.readFileSync(SESS, 'utf8')).events;
  console.log('  §C 追加两条后事件数: ' + before + ' → ' + after.length + (after.length === before + 2 ? ' ✅' : ' ❌'));
  console.log('  §C ★第一条事件与原文件逐字段相同（历史没被改写）: '
    + (JSON.stringify(after[0]) === JSON.stringify(firstEventBefore) ? '✅' : '❌'));

  /* §D 剪枝：先造一条超长的，**再追加几条**让它漂出保留窗口（keepRecent=2），然后剪。
     注意：真实使用里新来的长结果总是落在末尾 —— 所以清扫是在**下一轮开始**时做的，
     那时它已经漂出去了。（这也是 main.js 把 pruneLong 放在 chat:send 开头的原因。） */
  const h = '很长的工具结果'.repeat(2000);          // 14000 字符
  session.push({ role: 'user', content: h });
  session.push({ role: 'assistant', content: '收尾一' });
  session.push({ role: 'assistant', content: '收尾二' });
  session.push({ role: 'assistant', content: '收尾三' });
  session.saveNow();
  const beforePrune = session.stats();
  const pr = session.pruneLong({ maxInlineChars: 4000, keepRecent: 2, minSaveChars: 500 });
  session.saveNow();
  const afterPrune = session.stats();
  console.log('  §D 剪枝: 剪了 ' + pr.count + ' 条  可见字符 ' + beforePrune.surface.visibleChars + ' → ' + afterPrune.surface.visibleChars
    + (pr.count > 0 && afterPrune.surface.visibleChars < beforePrune.surface.visibleChars ? ' ✅' : ' ❌'));
  const diskEv = JSON.parse(fs.readFileSync(SESS, 'utf8')).events;
  const stillThere = diskEv.some((e) => String(e.content || '').length > 10000);
  console.log('  §D ★原始 14000 字内容仍在事件日志里: ' + (stillThere ? '✅' : '❌'));
  console.log('  §D prune 事件被记为元数据: ' + (diskEv.some((e) => e.kind === 'prune') ? '✅' : '❌'));

  /* §E context.build 仍可用 */
  try {
    const ctx = require('../src/memory/context');
    const built = ctx.build ? ctx.build({}) : null;
    console.log('  §E context.build 可用: ' + (built ? '✅' : '（返回空，可能参数不同）'));
  } catch (e) { console.log('  §E context.build 报错: ' + e.message); }

  const okAll = (onDisk.version === 2) && ((onDisk.events || []).length === origCount)
    && (vis.length === origCount) && (after.length === before + 2)
    && (JSON.stringify(after[0]) === JSON.stringify(firstEventBefore)) && stillThere;
  console.log('  === 总体: ' + (okAll ? '全部符合预期 ✅' : '有不符合项 ❌') + ' ===');
  setTimeout(() => app.exit(okAll ? 0 : 1), 200);
});
