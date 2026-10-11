/* 会话迁移的 Electron 集成探针（独立 userData）
 * 验证两件事：
 *   ① 老格式（无 version）能被自动迁移成 v1，并立刻写回磁盘；
 *   ② 文件版本比程序新时**拒绝加载**，而且**绝不覆盖原文件**（这是不可逆数据丢失的防线）。
 * 跑法：electron app/scripts/probe-session.js
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const T = path.join(process.env.APPDATA, 'dayu-pet-sesstest');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(path.join(T, 'memory'), { recursive: true });
app.setPath('userData', T);

const SESS = path.join(T, 'memory', 'session.json');

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const session = require('../src/memory/session');
  const fmt = require('../src/sessionfmt');

  /* §1 老格式（v0，含一个误导性的 EN: 老草稿）→ 自动迁移 */
  fs.writeFileSync(SESS, JSON.stringify({
    id: 'legacy-1', startedAt: 111, savedAt: 222,
    messages: [{ role: 'assistant', compact: 'EN: 老草稿内容' }, { role: 'user', content: '你好' }],
  }), 'utf8');
  const st = session.restore();
  const info1 = session.info();
  console.log('  §A restore 后: resumed=' + info1.resumed + '  migratedFrom=' + info1.migratedFrom + '  version=' + info1.version + '  readOnly=' + info1.readOnly);
  console.log('  §B 老草稿被正规化: ' + String(st.messages[0].compact).slice(0, 50));
  /* 迁移后应当已经用新格式写回磁盘 */
  const onDisk = JSON.parse(fs.readFileSync(SESS, 'utf8'));
  console.log('  §C 磁盘上的 version = ' + onDisk.version + '（应为 ' + fmt.CURRENT + '）');

  /* §2 更高版本的文件 → 拒绝加载 + 原文件必须一字不动 */
  const future = JSON.stringify({ version: 99, id: 'future-1', messages: [{ role: 'user', content: '未来的消息' }] });
  fs.writeFileSync(SESS, future, 'utf8');
  const st2 = session.restore();
  const info2 = session.info();
  console.log('  §D 读到高版本后: readOnly=' + info2.readOnly + '  resumed=' + info2.resumed + '（应为 false，开新会话）');
  /* 关键：就算她继续说话并触发保存，也不能覆盖那个文件 */
  session.push({ role: 'user', content: '这句绝不能写进去' });
  session.saveNow();
  const after = fs.readFileSync(SESS, 'utf8');
  console.log('  §E 原文件是否被保护: ' + (after === future ? '✅ 一字未动' : '❌ 被覆盖了！'));

  setTimeout(() => app.exit(after === future ? 0 : 1), 200);
});
