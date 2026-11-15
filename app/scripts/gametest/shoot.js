/* shoot.js —— ★给测试台抓一帧（Electron 子进程 ✓ 结果写 C:\deepseek\gametest\live-<ts>.png ✓ 不走管道 ✓）★ */
'use strict';
const fs = require('fs');
const OUT = 'C:/deepseek/gametest';
const el = require('electron');
const { app, desktopCapturer, screen } = el;
if (!app) { process.exit(1); }
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const d = screen.getPrimaryDisplay();                 // ★返回 DIP 尺寸（本机 1536x864 ✓ = 物理/1.25 ✓）
    const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: d.size.width, height: d.size.height } });
    if (!srcs || !srcs[0]) { app.exit(1); return; }
    const png = srcs[0].thumbnail.toPNG();
    fs.writeFileSync(OUT + '/live-' + Date.now() + '.png', png);
    app.exit(0);
  } catch (e) { app.exit(1); }
});
