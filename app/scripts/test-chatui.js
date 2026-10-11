/* 单独把 chat.html 跑起来截图 + 抓 JS 报错（不需要主进程后端）
 * 必须用离屏渲染：窗口被别的窗口遮住时 Chromium 不绘制，capturePage() 会返回空图。
 * electron.exe app\scripts\test-chatui.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 430, height: 780, show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: false,
      nodeIntegration: false,
      preload: path.join(__dirname, 'stub-preload.js'),
    },
  });
  const errs = [];
  let lastImg = null;
  win.webContents.setFrameRate(10);
  win.webContents.on('paint', (e, dirty, image) => { lastImg = image; });
  win.webContents.on('console-message', (e, lvl, msg) => {
    const m = String(msg);
    if (lvl >= 2 && !/Security Warning|Content-Security-Policy/.test(m)) errs.push(m.slice(0, 300));
  });
  win.webContents.on('render-process-gone', (e, d) => errs.push('RENDER GONE ' + JSON.stringify(d)));

  win.loadFile(path.join(__dirname, '..', 'renderer', 'chat.html'));
  win.webContents.once('did-finish-load', async () => {
    fs.mkdirSync('C:/deepseek/desktop-pet/shots', { recursive: true });
    await new Promise((r) => setTimeout(r, 1800));
    const shot = async (name, js) => {
      if (js) { try { await win.webContents.executeJavaScript(js); } catch (e) { errs.push('exec: ' + e.message); } }
      await new Promise((r) => setTimeout(r, 900));
      let img = null;
      try { img = await win.webContents.capturePage(); } catch {}
      if (!img || img.isEmpty()) img = lastImg;
      if (!img || img.isEmpty()) { errs.push('截图为空: ' + name); return; }
      fs.writeFileSync('C:/deepseek/desktop-pet/shots/' + name, img.toPNG());
    };
    await shot('ui-1-toolbar.png', `document.getElementById('moreMenu').classList.add('hidden'); true;`);
    await shot('ui-2-menu.png', `document.getElementById('moreBtn').click(); true;`);
    await shot('ui-3-tts.png', `document.getElementById('moreMenu').classList.add('hidden'); document.getElementById('ttsBtn').click(); true;`);
    await shot('ui-4-trans.png', `document.getElementById('transBtn').click(); true;`);
    console.log('=== JS 报错 ===');
    console.log(errs.length ? errs.join('\n') : '（无）');
    app.exit(0);
  });
});
