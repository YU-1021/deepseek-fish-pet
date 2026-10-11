/* 抓帧里到底有没有鼠标光标？（"她识别光标总是有问题"）
 * electron.exe app\scripts\probe-cursor.js
 *
 * 做法：把光标移到画面中心 → 抓帧；再把光标移到角落 → 抓帧。
 * 对比两次截图在"中心那块"的像素。如果光标被画进图里，两次应该不同。
 */
const path = require('path');
const fs = require('fs');
const { app, screen, nativeImage } = require('electron');
const T = path.join(process.env.APPDATA, 'dayu-pet-cursorprobe');
fs.mkdirSync(T, { recursive: true });
try { fs.copyFileSync(path.join(process.env.APPDATA, 'dayu-pet', 'config.json'), path.join(T, 'config.json')); } catch {}
try { fs.copyFileSync(path.join(process.env.APPDATA, 'dayu-pet', 'persona.json'), path.join(T, 'persona.json')); } catch {}
app.setPath('userData', T);
require('../main.js');

const { spawnSync } = require('child_process');
function setCursor(x, y) {
  const ps = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class S{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);}'; [S]::SetCursorPos(${x},${y})`;
  try { spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 12000, windowsHide: true }); } catch {}
}

app.whenReady().then(async () => {
  const M = require('../main.js');
  const input = require('../src/input');
  const screenstream = require('../src/screenstream');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* 把两张图转成像素来做差 */
  const toBmp = (dataUrl) => {
    const img = nativeImage.createFromDataURL(dataUrl);
    return img;
  };
  const regionDiff = (a, b, cx, cy, r) => {
    /* 以 (cx,cy) 为中心取 (2r+1)^2 的区域逐点比 */
    const ia = a.toBitmap(), ib = b.toBitmap();
    const size = a.getSize();
    const w = size.width;
    let diff = 0, n = 0;
    for (let y = Math.max(0, cy - r); y <= Math.min(size.height - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
        const i = (y * w + x) * 4;
        const d = Math.abs(ia[i] - ib[i]) + Math.abs(ia[i + 1] - ib[i + 1]) + Math.abs(ia[i + 2] - ib[i + 2]);
        if (d > 40) diff++;
        n++;
      }
    }
    return { diff, n, pct: Math.round(diff / Math.max(1, n) * 1000) / 10 };
  };

  try {
    await wait(4000);
    const disp = screen.getPrimaryDisplay();
    const sp = input.space();
    L('=== 环境 ===');
    L('  屏幕 ' + disp.size.width + 'x' + disp.size.height + '  抓帧空间 ' + sp.w + 'x' + sp.h);
    L('  光标位置读取: ' + JSON.stringify(screen.getCursorScreenPoint()));

    /* 先把流预热，避免第一帧是黑的 */
    await screenstream.grabFrame();
    await wait(600);

    const cx = Math.round(sp.w / 2), cy = Math.round(sp.h / 2);
    const dipCX = Math.round(disp.size.width / 2), dipCY = Math.round(disp.size.height / 2);

    L('');
    L('=== 第 1 次：光标移到画面正中 ===');
    setCursor(dipCX, dipCY);
    await wait(700);
    L('  getCursorScreenPoint = ' + JSON.stringify(screen.getCursorScreenPoint()));
    const f1 = await screenstream.grabFrame();
    L('  抓到 ' + (f1 ? f1.width + 'x' + f1.height : '失败'));

    L('');
    L('=== 第 2 次：光标移到左下角远处 ===');
    setCursor(30, disp.size.height - 30);
    await wait(700);
    L('  getCursorScreenPoint = ' + JSON.stringify(screen.getCursorScreenPoint()));
    const f2 = await screenstream.grabFrame();
    L('  抓到 ' + (f2 ? f2.width + 'x' + f2.height : '失败'));

    if (f1 && f2) {
      const i1 = toBmp(f1.dataUrl), i2 = toBmp(f2.dataUrl);
      const r1 = regionDiff(i1, i2, cx, cy, 24);
      L('');
      L('=== 结论 ===');
      L('  中心区域（光标曾经在的地方）差异: ' + r1.diff + ' / ' + r1.n + ' 像素 (' + r1.pct + '%)');
      if (r1.pct > 3) {
        L('  → 差异明显：**截图里应该包含光标**（或至少中心有可见变化）');
      } else {
        L('  → 几乎没有差异：**截图里没有鼠标光标** ✗');
        L('     （Electron 的 desktopCapturer 默认不合成鼠标指针；');
        L('      主进程日志里那条 mouse_cursor_monitor_win.cc: Unable to get cursor info 就是它在尝试合成并失败）');
      }
      /* 存两张图便于人眼复核 */
      fs.writeFileSync(path.join(T, 'cursor-a.png'), i1.toPNG());
      fs.writeFileSync(path.join(T, 'cursor-b.png'), i2.toPNG());
      L('  两张图已存: ' + T + '\\cursor-a.png / cursor-b.png');
    }

    L('');
    L('=== 附带确认：主进程能不能读到光标（我们自己知道它在哪）===');
    setCursor(200, 200); await wait(500);
    const p = screen.getCursorScreenPoint();
    L('  SetCursorPos(200,200) → getCursorScreenPoint=' + JSON.stringify(p) + '  ' + (Math.abs(p.x - 200) < 20 && Math.abs(p.y - 200) < 20 ? '✅ 读得到' : '❌ 读不到'));
    L('  → 说明"我们知道光标在哪"，只是截图里没画出来；可以在抓帧时自己画一个标记补上。');
  } catch (e) {
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit(0), 300);
});
