/* 界面实际呈现截图：开真应用 + 真数据，把两个窗口抓成 PNG
 *   electron.exe app\scripts\shot-ui.js [--ud=dayu-pet-test] [--out=shots]
 * 目的：验证"实际呈现"（布局/配色/中英对照/打分颜色/工具栏），而不是只看日志。
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith('--' + k + '='));
  return m ? m.split('=')[1] : d;
};
const UD = path.join(process.env.APPDATA, arg('ud', 'dayu-pet-test'));
const OUT = path.join(__dirname, '..', '..', arg('out', 'shots'));
fs.mkdirSync(OUT, { recursive: true });
try { fs.unlinkSync(path.join(UD, 'clock-offset.json')); } catch {}
app.setPath('userData', UD);

require('../main.js');    // 启动真应用

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const M = require('../main.js');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  try {
    L('userData: ' + UD);
    L('输出目录: ' + OUT);
    await wait(4000);

    /* 开对话窗（真数据：chatlog 里有那 3 天的会话） */
    M.createChat();
    await wait(6000);

    const shot = async (name, win, ms) => {
      if (!win || win.isDestroyed()) { L('  ' + name + ': 窗口不存在'); return null; }
      try { win.show(); win.focus(); } catch {}
      await wait(ms || 1500);
      try {
        const img = await win.webContents.capturePage();
        const f = path.join(OUT, name + '.png');
        fs.writeFileSync(f, img.toPNG());
        const s = img.getSize();
        L('  ✅ ' + name + '.png  ' + s.width + 'x' + s.height);
        return f;
      } catch (e) { L('  ❌ ' + name + ' 截图失败: ' + ((e && e.message) || e)); return null; }
    };

    const w = M.win();
    await shot('ui-pet', w.petWin, 1200);
    await shot('ui-chat', w.chatWin, 2500);

    /* 顺便把对话窗的实际内容读出来（DOM 层面的"呈现"证据） */
    if (w.chatWin && !w.chatWin.isDestroyed()) {
      try {
        const info = await w.chatWin.webContents.executeJavaScript(`(() => {
          const msgs = Array.from(document.querySelectorAll('#msgs .msg'));
          const tb = Array.from(document.querySelectorAll('#toolbar button, .toolbar button'));
          return {
            msgCount: msgs.length,
            firstMsgs: msgs.slice(0, 6).map(m => (m.className + ' :: ' + (m.innerText||'').replace(/\\s+/g,' ').slice(0,70))),
            toolbar: tb.map(b => (b.textContent||'').trim()).filter(Boolean),
            hasPronPanel: !!document.querySelector('#pronPanel, .pron'),
            bodyBg: getComputedStyle(document.body).backgroundColor,
            fontFamily: getComputedStyle(document.body).fontFamily.slice(0, 60),
            size: window.innerWidth + 'x' + window.innerHeight,
          };
        })()`);
        L('');
        L('--- 对话窗 DOM 实测 ---');
        L('  窗口 ' + info.size + '  消息 ' + info.msgCount + ' 条  背景 ' + info.bodyBg);
        L('  字体 ' + info.fontFamily);
        L('  工具栏 ' + JSON.stringify(info.toolbar));
        for (const m of info.firstMsgs) L('    ' + m);
      } catch (e) { L('  DOM 读取失败: ' + ((e && e.message) || e)); }
    }
  } catch (e) {
    L('ERROR: ' + ((e && e.stack) || e));
  }
  L('');
  L(out.filter((x) => x).join('\n'));
  setTimeout(() => app.exit(0), 400);
});
