/* 无进展检测的测试（纯逻辑，不需要屏幕）
 * 这个机制抄自参考项目 Coopanion 在 Minecraft 世界里的做法（同一工具+读数指纹相同→压缩回执），
 * 它的 CUA 世界反而没有 —— 而我们的实测是：用户看到她"Let me list the windows"连说 6 次。
 * 跑法：electron.exe app\scripts\test-noprogress.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const T = path.join(process.env.APPDATA, 'dayu-pet-noprog');
fs.mkdirSync(T, { recursive: true });
app.setPath('userData', T);

let pass = 0, fail = 0;
function ok(c, l, e) { if (c) { pass++; console.log('  ✅ ' + l + (e ? '   ' + e : '')); } else { fail++; console.log('  ❌ ' + l + (e ? '   ' + e : '')); } }

app.whenReady().then(async () => {
  console.log('=== 无进展检测测试 ===');
  await new Promise((r) => setTimeout(r, 400));
  const A = require('../src/assistant');
  const W = A.__noProgressWarning, N = A.__noteAction;

  ok(W('click', '100,200') === '', '第 1 次同动作 → 不拦');
  N('click', '100,200', '✅ 已左键点击：(100, 200)');
  N('click', '100,200', '❌ 坐标格式应为 x,y');
  ok(W('click', '100,200') === '', '两次结果**不同** → 不拦（正常重试不该被误伤）');
  N('click', '100,200', '❌ 坐标格式应为 x,y');
  const w = W('click', '100,200');
  ok(w.indexOf('原地打转') >= 0, '连续两次同结果 → 第三次拦住并逼她换办法', (w || '').slice(0, 50) + '…');
  ok(w.indexOf('find_template') >= 0, '警告里给了具体出路（提到了 find_template）');
  ok(W('click', '150,200') === '', '换了坐标 = 新动作 → 不拦');
  /* 坐标飘动不该被当成不同动作：回执里的数字会被抹掉，所以同一按钮不同坐标、回执结构相同 → 仍然拦 */
  N('screen_look', '看到按钮', '👁 视觉模型：按钮在 (100,200)');
  N('screen_look', '看到按钮', '👁 视觉模型：按钮在 (137,205)');
  const w2 = W('screen_look', '看到按钮');
  ok(w2.indexOf('原地打转') >= 0, '★ 坐标飘动但结论相同 → 仍然拦住（抹掉数字后指纹一致）', (w2 || '').slice(0, 45) + '…');
  N('windows_list', '', '两个窗口');
  N('windows_list', '', '两个窗口');
  const w3 = W('windows_list', '');
  ok(w3.indexOf('问过了') >= 0, '查询类工具重复 → 只提醒（不骂、话术更轻）', (w3 || '').slice(0, 40) + '…');
  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  setTimeout(() => app.exit(fail ? 1 : 0), 200);
});
