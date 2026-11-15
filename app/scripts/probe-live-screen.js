/* probe-live-screen.js —— ★只截一帧真实屏幕并落盘（不建任何可见窗口 ✓ 不动鼠标 ✓ 不动键盘 ✓）★
 *
 * 用途：真机"只读"取证 —— 当前游戏画面到底在哪个面板 / 会出现哪些候选词 ✓，
 *       全程**零输入**（不点、不按、不拖 ✓），所以不会干扰任何人正在做的事 ✓。
 *
 * 跑法：Start-Process electron.exe -ArgumentList "<repo>\app\scripts\probe-live-screen.js" -PassThru
 * 结果：C:\deepseek\livetest\live-<时间戳>.png + C:\deepseek\livetest\live-shot.txt
 */
'use strict';
const fs = require('fs');
const OUTDIR = 'C:/deepseek/livetest';
const RESULT = OUTDIR + '/live-shot.txt';
fs.mkdirSync(OUTDIR, { recursive: true });
function say(s) { try { fs.appendFileSync(RESULT, String(s) + '\n'); } catch (e) {} }

process.on('uncaughtException', (e) => { say('ERR ' + (e && e.stack || e)); process.exit(1); });
const el = require('electron');
const { app, desktopCapturer, screen } = el;
if (!app || !desktopCapturer) { say('ERR no electron app'); process.exit(1); }

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const d = screen.getPrimaryDisplay();
    say('display ' + d.size.width + 'x' + d.size.height + ' scale=' + d.scaleFactor);
    const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: d.size.width, height: d.size.height } });
    say('sources=' + srcs.length);
    const s = srcs[0];
    if (!s) { say('ERR no screen source'); app.exit(1); return; }
    const png = s.thumbnail.toPNG();
    const file = OUTDIR + '/live-' + Date.now() + '.png';
    fs.writeFileSync(file, png);
    say('wrote ' + file + ' bytes=' + png.length);
    app.exit(0);
  } catch (e) { say('ERR ' + (e && e.stack || e)); app.exit(1); }
});
