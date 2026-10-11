/* 读后写 / CAS 的 Electron 集成探针（独立 userData）
 * 走**真实工具调用链**（assistant.run），验证：
 *   §A 写新文件 → 允许
 *   §B 同一个文件不读就再写 → **拒绝**（FS_NOT_OBSERVED）
 *   §C 先 read_file 再写 → 允许
 *   §D 读完之后文件被外部改过 → 再写 → **拒绝**（FS_STALE）
 *   §E proj_* 沙盒那条路同样生效
 * 跑法：electron app/scripts/probe-obs.js
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const T = path.join(process.env.APPDATA, 'dayu-pet-obstest');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
app.setPath('userData', T);

const TMP = path.join(T, 'work');
fs.mkdirSync(TMP, { recursive: true });
const F = path.join(TMP, 'demo.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 400));
  const A = require('../src/assistant');

  /* §A 写新文件 */
  let r = await A.run('write_file', F + '||第一版内容');
  console.log('  §A 写新文件: ' + String(r).slice(0, 60));
  console.log('  §A 文件真的存在: ' + fs.existsSync(F));

  /* §B 文件是**外部创建**的（她从未读过、也从未写过）→ 盲写必须被拒。
     注意：不能用"自己刚写完再写一次"来测 —— 写这个动作本身就会登记观测
     （我知道刚写下去的是什么），那种情况放行是合理的（DSH 的 replaceIfVersion 同理）。 */
  const FOREIGN = path.join(TMP, '别人的文件.txt');
  fs.writeFileSync(FOREIGN, '这是别人写的重要内容', 'utf8');
  r = await A.run('write_file', FOREIGN + '||第二版（没读就写）');
  const bRejected = String(r).indexOf('FS_NOT_OBSERVED') >= 0;
  console.log('  §B 盲写别人的文件: ' + (bRejected ? '✅ 被拒（FS_NOT_OBSERVED）' : '❌ 竟然写进去了！'));
  console.log('  §B 磁盘内容没被改: ' + (fs.readFileSync(FOREIGN, 'utf8') === '这是别人写的重要内容' ? '✅' : '❌'));
  console.log('  §B 给她的提示: ' + String(r).slice(0, 90));

  /* §C 先读再写（应允许） */
  await A.run('read_file', F);
  r = await A.run('write_file', F + '||第三版（读过之后写的）');
  const cOk = String(r).indexOf('已写入') >= 0;
  console.log('  §C 读过再写: ' + (cOk ? '✅ 允许' : '❌ 被拒: ' + String(r).slice(0, 70)));
  console.log('  §C 磁盘内容: ' + fs.readFileSync(F, 'utf8'));

  /* §D 读完之后被"别人"改过 → 再写应被拒（CAS） */
  await A.run('read_file', F);
  await sleep(30);
  fs.writeFileSync(F, '别人在这期间改的内容（更长一些）', 'utf8');   // 模拟外部改动
  r = await A.run('write_file', F + '||第四版（会覆盖掉别人的改动）');
  const dRejected = String(r).indexOf('FS_STALE') >= 0;
  console.log('  §D 读后被改再写: ' + (dRejected ? '✅ 被拒（FS_STALE）' : '❌ 竟然写进去了！'));
  console.log('  §D 别人的改动还在: ' + (fs.readFileSync(F, 'utf8') === '别人在这期间改的内容（更长一些）' ? '✅' : '❌'));
  console.log('  §D 两个版本号: ' + String(r).replace(/\n/g, ' ').slice(0, 130));

  /* §E 沙盒那条路：同样要用"外部创建的文件"来测盲写 */
  let e1 = await A.run('proj_write', 'demo/x.py||print(1)');
  console.log('  §E proj_write 新建: ' + (String(e1).indexOf('已写入') >= 0 ? '✅' : '❌ ' + String(e1).slice(0, 60)));
  /* 造一个"沙盒里已存在、她没碰过"的文件：直接写进 projects 沙盒 */
  let sandboxHit = '';
  try {
    const pj = require('../src/projects');
    const target = pj.safePath('demo/foreign.py');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'print("别人写的")\n', 'utf8');
    const e2 = await A.run('proj_write', 'demo/foreign.py||print(2)');
    sandboxHit = String(e2);
    console.log('  §E proj_write 盲写别人文件: ' + (sandboxHit.indexOf('FS_NOT_OBSERVED') >= 0 ? '✅ 被拒' : '❌ 写进去了: ' + sandboxHit.slice(0, 60)));
  } catch (e) { console.log('  §E 沙盒探测出错: ' + e.message); }

  const okAll = bRejected && cOk && dRejected && String(e1).indexOf('已写入') >= 0 && sandboxHit.indexOf('FS_NOT_OBSERVED') >= 0;
  console.log('  === 总体: ' + (okAll ? '全部符合预期 ✅' : '有不符合项 ❌') + ' ===');
  setTimeout(() => app.exit(okAll ? 0 : 1), 200);
});
