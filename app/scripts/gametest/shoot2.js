/* shoot2.js —— ★按指定像素尺寸抓帧（给 diag 用 ✓ 参数：w h outPath）★
 * 关键：desktopCapturer 的 thumbnailSize 用**物理像素**时，能拿到原生分辨率的画面 ✓
 *      （本机 DIP 1536x864 × 1.25 = 物理 1920x1080 ✓）
 */
'use strict';
const fs = require('fs');
const el = require('electron');
const { app, desktopCapturer } = el;
const [wArg, hArg, out] = process.argv.slice(2);
if (!app) { process.exit(1); }
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const w = Number(wArg) || 1920, h = Number(hArg) || 1080;
    const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
    if (!srcs || !srcs[0]) { app.exit(1); return; }
    fs.writeFileSync(out, srcs[0].thumbnail.toPNG());
    app.exit(0);
  } catch (e) { app.exit(1); }
});
