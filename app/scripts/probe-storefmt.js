/* 存储层版本与迁移的 Electron 端到端验证（独立 userData）
 *   §A 老格式（无 version）读进来 → 自动迁移（对象拿到 version=1）
 *   §B 写盘后磁盘上确实带版本
 *   §C 数组命名空间不被包装（连引用都不换）
 *   §D ending 的 null 合法通过
 *   §E 高版本文件 → 拒绝加载 + **拒绝写入**（原文一字不动）
 *   §F undefined 写入被拒绝（不再写坏文件）
 * 跑法：electron app/scripts/probe-storefmt.js
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const T = path.join(process.env.APPDATA, 'dayu-pet-storefmttest');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(path.join(T, 'memory'), { recursive: true });
app.setPath('userData', T);

const M = path.join(T, 'memory');
const P = (n) => path.join(M, n + '.json');

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const store = require('../src/store');

  /* §A 老格式 → 自动迁移 */
  fs.writeFileSync(P('permanent'), JSON.stringify({ facts: [{ text: '主人的偏好' }], cand: [] }), 'utf8');
  const v = store.read('permanent', {});
  console.log('  §A 读到: version=' + v.version + '  facts=' + (v.facts || []).length + '  '
    + (v.version === 1 && v.facts.length === 1 ? '✅ 迁移且数据没丢' : '❌'));

  /* §B 写盘带版本 */
  v.facts.push({ text: '新加的一条' });
  store.write('permanent', v);
  const onDisk = JSON.parse(fs.readFileSync(P('permanent'), 'utf8'));
  console.log('  §B 磁盘上 version=' + onDisk.version + '  facts=' + onDisk.facts.length + '  ' + (onDisk.version === 1 ? '✅' : '❌'));

  /* §C 数组命名空间原样 */
  fs.writeFileSync(P('long'), JSON.stringify([{ date: '2026-10-02', diary: '今天' }]), 'utf8');
  const arr = store.read('long', []);
  const rawArr = JSON.parse(fs.readFileSync(P('long'), 'utf8'));
  console.log('  §C long 读回来是数组: ' + (Array.isArray(arr) && arr.length === 1 ? '✅' : '❌')
    + '  未被包成对象: ' + (Array.isArray(rawArr) ? '✅' : '❌'));
  store.write('long', arr);
  const afterWrite = JSON.parse(fs.readFileSync(P('long'), 'utf8'));
  console.log('  §C 写回后磁盘上仍然是数组: ' + (Array.isArray(afterWrite) ? '✅' : '❌'));

  /* §D ending 的 null */
  fs.writeFileSync(P('ending'), 'null', 'utf8');
  const e = store.read('ending', 'FALLBACK');
  console.log('  §D ending 读回 null（不是 fallback）: ' + (e === null ? '✅' : '❌ 得到 ' + JSON.stringify(e)));

  /* §E 高版本 → 拒绝加载 + 拒绝写入 + 原文不动 */
  const future = JSON.stringify({ version: 99, counts: { iq: 999 } });
  fs.writeFileSync(P('stats'), future, 'utf8');
  const s = store.read('stats', {});
  console.log('  §E 高版本读回 fallback: ' + (s.counts === undefined ? '✅' : '❌ ' + JSON.stringify(s).slice(0, 40)));
  const w = store.write('stats', { counts: { iq: 1 } });
  const stillFuture = fs.readFileSync(P('stats'), 'utf8');
  console.log('  §E 写入被拒: ' + (w === false ? '✅' : '❌ 竟然写了') + '   原文一字未动: ' + (stillFuture === future ? '✅' : '❌'));
  console.log('  §E store.status(): ' + JSON.stringify(store.status()));

  /* §F undefined 写入被拒 */
  const f = store.write('permanent', undefined);
  const okF = JSON.parse(fs.readFileSync(P('permanent'), 'utf8')).facts.length === 2;
  console.log('  §F undefined 写入被拒: ' + (f === false ? '✅' : '❌') + '   原文件没被破坏: ' + (okF ? '✅' : '❌'));

  setTimeout(() => app.exit(0), 200);
});
