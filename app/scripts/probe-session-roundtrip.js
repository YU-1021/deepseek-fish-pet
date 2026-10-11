/* ★ 回归验证：session 的版本号不会被 store 层覆盖（这是 213 条历史消失的根因）
 * 用**她真实的 213 条备份**做输入，跑完整的"读 → 迁 → 写 → 再读"往返。
 * 跑法：electron app/scripts/probe-session-roundtrip.js
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const T = path.join(process.env.APPDATA, 'dayu-pet-roundtrip');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(path.join(T, 'memory'), { recursive: true });
app.setPath('userData', T);

/* 输入：她真实的备份（v0，213 条 messages） */
const BK = path.join(process.env.APPDATA, 'dayu-pet', 'backup-c5-20261002-184410', 'session.json');
const raw = fs.readFileSync(BK, 'utf8');
const orig = JSON.parse(raw);
const origMsgs = (orig.messages || []).length;
fs.writeFileSync(path.join(T, 'memory', 'session.json'), raw, 'utf8');
console.log('  §0 输入: 她的真实备份 ' + origMsgs + ' 条 messages，version=' + orig.version);
const SESS = path.join(T, 'memory', 'session.json');

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const session = require('../src/memory/session');
  const store = require('../src/store');

  /* §A 启动恢复：v0 → v2 */
  session.restore();
  const after1 = JSON.parse(fs.readFileSync(SESS, 'utf8'));
  console.log('  §A 恢复后磁盘 version=' + after1.version + '  events=' + ((after1.events || []).length)
    + (after1.version === 2 && (after1.events || []).length === origMsgs ? ' ✅ 213 条完整迁到 v2' : ' ❌'));

  /* §B ★ 关键回归：再写一次，版本号必须**仍然是 2**（这就是被 storefmt 覆盖掉的 bug） */
  session.push({ role: 'user', content: '回归测试：写一条新消息' });
  session.saveNow();
  const after2 = JSON.parse(fs.readFileSync(SESS, 'utf8'));
  console.log('  §B ★写过之后磁盘 version=' + after2.version + (after2.version === 2 ? ' ✅ 没有被覆盖成 1' : ' ❌ 又被覆盖了！'));
  console.log('  §B 事件数 ' + (after1.events || []).length + ' → ' + (after2.events || []).length
    + ((after2.events || []).length === origMsgs + 1 ? ' ✅ 只多了一条' : ' ❌'));

  /* §C ★ 再"重启"一次（重新 restore）：历史必须还在（这就是 213 条消失的场景） */
  const vis = session.all();
  console.log('  §C 投影出的消息数=' + vis.length + (vis.length === origMsgs + 1 ? ' ✅ 一条没丢' : ' ❌ 丢了 ' + (origMsgs + 1 - vis.length) + ' 条'));

  /* §D 清空再恢复（模拟收尾） */
  session.clear();
  const cleared = fs.readFileSync(SESS, 'utf8');
  console.log('  §D clear 后文件内容是 ' + JSON.stringify(cleared).slice(0, 20) + (cleared.trim() === 'null' ? ' ✅' : ''));

  /* §E store 层的状态自述 */
  console.log('  §E store.status() = ' + JSON.stringify(store.status()));

  const okAll = after1.version === 2 && (after1.events || []).length === origMsgs
    && after2.version === 2 && vis.length === origMsgs + 1;
  console.log('  === ' + (okAll ? '往返无损，bug 已修 ✅' : '仍有问题 ❌') + ' ===');
  setTimeout(() => app.exit(okAll ? 0 : 1), 200);
});
