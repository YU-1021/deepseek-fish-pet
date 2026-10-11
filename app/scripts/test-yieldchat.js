/* 验证：屏幕类工具执行时，对话窗会被自动让开
 * （用户反复强调过 4 次"做事第一件事就是最小化对话框"，实测她记不住 —— 所以由程序做）
 * electron.exe app\scripts\test-yieldchat.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const T = path.join(process.env.APPDATA, 'dayu-pet-yieldchat');
fs.mkdirSync(T, { recursive: true });
try {
  fs.copyFileSync(path.join(process.env.APPDATA, 'dayu-pet', 'config.json'), path.join(T, 'config.json'));
  fs.copyFileSync(path.join(process.env.APPDATA, 'dayu-pet', 'persona.json'), path.join(T, 'persona.json'));
} catch {}
app.setPath('userData', T);
require('../main.js');

app.whenReady().then(async () => {
  const M = require('../main.js');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass = 0, total = 0;
  const ck = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };
  try {
    await wait(4000);
    M.createChat();
    await wait(6000);
    const chat = M.win().chatWin;
    ck('chat window exists', !!(chat && !chat.isDestroyed()));
    chat.show(); chat.restore(); await wait(900);
    ck('start state: visible and not minimized', chat.isVisible() && !chat.isMinimized(),
      'visible=' + chat.isVisible() + ' min=' + chat.isMinimized());

    /* 走真实 IPC（对话窗渲染层 -> preload -> main），和用户点按钮完全一样 */
    let sawMinimized = false;
    const poll = setInterval(() => { try { if (chat.isMinimized()) sawMinimized = true; } catch {} }, 30);
    const r = await chat.webContents.executeJavaScript('window.petAPI.assistantRun({tool:"screen_shot"})');
    await wait(250);
    const midMin = chat.isMinimized();
    clearInterval(poll);
    L('  during call: minimized=' + midMin + '  observed-by-poll=' + sawMinimized);
    ck('★ screen_shot 执行期间对话窗确实被最小化（轮询观测到）', sawMinimized || midMin, 'poll=' + sawMinimized + ' now=' + midMin);
    ck('screen_shot 成功返回', !!(r && r.ok), JSON.stringify(r && { ok: r.ok, len: String(r.result || '').length }));
    await wait(2000);
    ck('★ 执行完对话窗恢复了', chat.isVisible() && !chat.isMinimized(),
      'visible=' + chat.isVisible() + ' min=' + chat.isMinimized());

    /* 对照：非屏幕类工具不该动对话窗 */
    chat.restore(); await wait(700);
    const poll2 = setInterval(() => { try { if (chat.isMinimized()) sawMinimized = true; } catch {} }, 30);
    sawMinimized = false;
    const r2 = await chat.webContents.executeJavaScript('window.petAPI.assistantRun({tool:"list_dir",arg:"C:\\\\deepseek"})');
    await wait(400);
    clearInterval(poll2);
    ck('非屏幕类工具（list_dir）没有动对话窗', !chat.isMinimized() && !sawMinimized, 'min=' + chat.isMinimized());
    ck('list_dir 成功返回', !!(r2 && r2.ok));

    L('');
    L('  passed ' + pass + ' / ' + total);
  } catch (e) {
    var crashed = String((e && e.stack) || e);
    L('ERROR: ' + crashed);
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 300);
});
