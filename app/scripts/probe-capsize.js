/* 实测：她抓到的帧到底是什么分辨率、detail 用的是哪个、图有多大
 * electron.exe app\scripts\probe-capsize.js
 */
const path = require('path');
const fs = require('fs');
const { app, screen, nativeImage } = require('electron');
const REAL = path.join(process.env.APPDATA, 'dayu-pet');
const T = path.join(process.env.APPDATA, 'dayu-pet-capsize');
fs.mkdirSync(T, { recursive: true });
try { fs.copyFileSync(path.join(REAL, 'config.json'), path.join(T, 'config.json')); } catch {}
app.setPath('userData', T);
require('../main.js');

app.whenReady().then(async () => {
  const M = require('../main.js');
  const screenstream = require('../src/screenstream');
  const input = require('../src/input');
  const config = require('../src/config');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await wait(4500);
    const cfg = config.load();
    const disp = screen.getPrimaryDisplay();
    L('显示器: DIP ' + disp.size.width + 'x' + disp.size.height + '  scaleFactor=' + disp.scaleFactor
      + '  → 物理 ' + Math.round(disp.size.width * disp.scaleFactor) + 'x' + Math.round(disp.size.height * disp.scaleFactor));
    L('input.space()（坐标空间）: ' + JSON.stringify(input.space()));
    L('config: capture=' + cfg.screenCaptureWidth + 'x' + cfg.screenCaptureHeight
      + '  jpegQ=' + cfg.screenJpegQuality + '  visionDetail=' + cfg.visionDetail);
    const f = await screenstream.grabFrame({ grid: false });
    if (!f) { L('❌ 抓帧失败'); } else {
      const bytes = Buffer.from(f.dataUrl.split(',')[1], 'base64').length;
      L('★ 实际抓到的帧: ' + f.width + 'x' + f.height + '   ' + Math.round(bytes / 1024) + 'KB   cursor=' + JSON.stringify(f.cursor));
      const img = nativeImage.createFromDataURL(f.dataUrl);
      L('  解码确认: ' + img.getSize().width + 'x' + img.getSize().height);
      fs.writeFileSync(path.join(process.env.TEMP, 'probe-capsize.png'), img.toPNG());
      L('  已存: ' + path.join(process.env.TEMP, 'probe-capsize.png'));
      L('  像素数: ' + (f.width * f.height) + '   物理屏幕像素数: ' + (disp.size.width * disp.scaleFactor * disp.size.height * disp.scaleFactor));
    }
    const f2 = await screenstream.grabFrame({ grid: true });
    if (f2) L('  带网格时同样是: ' + f2.width + 'x' + f2.height);
  } catch (e) { L('ERROR: ' + ((e && e.stack) || e)); }
  console.log(out.join('\n'));
  setTimeout(() => app.exit(0), 300);
});
