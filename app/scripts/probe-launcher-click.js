/* 直接验证：在按钮**正中心**点击，鹰角启动器会不会响应
 * electron.exe app\scripts\probe-launcher-click.js
 *
 * 按钮中心来自带网格截图的人工读数：模型空间 (1560, 845)
 * —— 网格图上一眼可见它在 1440 与 1680 两条竖线之间、略低于 810 横线。
 */
const path = require('path');
const fs = require('fs');
const { app, screen, nativeImage } = require('electron');
const REAL = path.join(process.env.APPDATA, 'dayu-pet');
const T = path.join(process.env.APPDATA, 'dayu-pet-clicklaunch');
fs.mkdirSync(T, { recursive: true });
try {
  fs.copyFileSync(path.join(REAL, 'config.json'), path.join(T, 'config.json'));
  fs.copyFileSync(path.join(REAL, 'persona.json'), path.join(T, 'persona.json'));
} catch {}
try { fs.unlinkSync(path.join(T, 'clock-offset.json')); } catch {}
app.setPath('userData', T);
require('../main.js');

app.whenReady().then(async () => {
  const M = require('../main.js');
  const input = require('../src/input');
  const screenstream = require('../src/screenstream');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const diffPct = (a, b) => {
    const ia = a.toBitmap(), ib = b.toBitmap();
    const w = a.getSize().width, h = a.getSize().height;
    let n = 0, d = 0;
    for (let y = 0; y < h; y += 6) for (let x = 0; x < w; x += 6) {
      const i = (y * w + x) * 4; n++;
      if (Math.abs(ia[i] - ib[i]) + Math.abs(ia[i + 1] - ib[i + 1]) + Math.abs(ia[i + 2] - ib[i + 2]) > 40) d++;
    }
    return Math.round(d / n * 1000) / 10;
  };

  try {
    await wait(4500);
    const pet = M.win().petWin;
    try { pet.hide(); } catch {}
    await wait(800);
    await screenstream.grabFrame();          // 预热
    await wait(600);

    L('=== 点前 ===');
    const f0 = await screenstream.grabFrame({ grid: false });
    fs.writeFileSync(path.join(process.env.TEMP, 'L-before.png'), nativeImage.createFromDataURL(f0.dataUrl).toPNG());
    L('  已存 L-before.png');

    for (const [name, mx, my] of [
      ['按钮中心(1560,845)', 1560, 845],
      ['稍高一点(1560,830)', 1560, 830],
    ]) {
      L('');
      L('=== 移动 + 点击 ' + name + ' ===');
      input.move(mx, my);
      await wait(500);
      const f1 = await screenstream.grabFrame({ grid: false });
      fs.writeFileSync(path.join(process.env.TEMP, 'L-hover.png'), nativeImage.createFromDataURL(f1.dataUrl).toPNG());
      L('  悬停后与点前差异 = ' + diffPct(nativeImage.createFromDataURL(f0.dataUrl), nativeImage.createFromDataURL(f1.dataUrl)) + '%  （悬停高亮会有点差别）');
      input.click(mx, my);
      await wait(2500);
      const f2 = await screenstream.grabFrame({ grid: false });
      fs.writeFileSync(path.join(process.env.TEMP, 'L-after.png'), nativeImage.createFromDataURL(f2.dataUrl).toPNG());
      const dp = diffPct(nativeImage.createFromDataURL(f0.dataUrl), nativeImage.createFromDataURL(f2.dataUrl));
      L('  点击后与点前差异 = ' + dp + '%');
      L('  → ' + (dp > 8 ? '★ 画面明显变化：**启动器响应了**' : '画面基本没变：启动器没响应（或只是没进入下一步）'));
      if (dp > 8) break;
    }
    L('');
    L('  再等 8 秒（启动游戏要时间），再看一次');
    await wait(8000);
    const f3 = await screenstream.grabFrame({ grid: false });
    fs.writeFileSync(path.join(process.env.TEMP, 'L-after8s.png'), nativeImage.createFromDataURL(f3.dataUrl).toPNG());
    L('  8 秒后与点前差异 = ' + diffPct(nativeImage.createFromDataURL(f0.dataUrl), nativeImage.createFromDataURL(f3.dataUrl)) + '%');
    L('  已存 L-after8s.png / L-hover.png / L-after.png（可人眼确认）');
    try { pet.show(); } catch {}
  } catch (e) {
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit(0), 300);
});
