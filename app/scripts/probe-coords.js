/* probe-coords.js —— ★量清楚"她的坐标系到底是什么"（只移动光标 ✓ 绝不点击 ✓）★
 *
 * 为什么这样量 ✗→✓：光看代码容易各说各话 ✓。最硬的判据是**让光标去一个已知点，再用两套尺子读回来**：
 *   · 注入侧：input.move(x,y)（Windows 的 SetCursorPos / mouse_event 走的是**物理像素** ✓ 若进程是 DPI-aware）
 *   · 读回侧 1：Electron 的 screen.getCursorScreenPoint()（★DPI-aware 时返回**逻辑(DIP)**✓✗）
 *   · 读回侧 2：focuswin.cursorPos()（PowerShell GetCursorPos → **物理** ✓）
 * 三方一比，映射就定了：注入是什么、读回是什么、截图像素是什么 ✓（截图/OCR 之前实测 = 1920x1080 物理 ✓）。
 *
 * 结果写 C:\deepseek\livetest\coords.txt（★不用 stdout ✓ 沙箱不给管道 ✓）
 * 跑法：Start-Process electron.exe -ArgumentList "<repo>\app\scripts\probe-coords.js"
 */
'use strict';
const fs = require('fs');
const OUT = 'C:/deepseek/livetest/coords.txt';
const lines = [];
function L(s) { lines.push(s); try { fs.writeFileSync(OUT, lines.join('\n') + '\n'); } catch (e) {} }

process.on('uncaughtException', (e) => { L('ERR ' + (e && e.stack || e)); process.exit(1); });
const el = require('electron');
const { app, screen } = el;
if (!app) { L('ERR no electron app'); process.exit(1); }
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const input = require('../src/input');
    const fw = require('../src/focuswin');
    const d = screen.getPrimaryDisplay();
    L('=== 两套尺子的静态定义 ===');
    L('screen.getPrimaryDisplay(): size=' + d.size.width + 'x' + d.size.height + ' scaleFactor=' + d.scaleFactor
      + ' workArea=' + d.workAreaSize.width + 'x' + d.workAreaSize.height);
    L('input.space() = ' + JSON.stringify(input.space && input.space()));
    L('input.W,H = ' + input.W + ',' + input.H);
    try { L('input.exePath = ' + input.exePath); } catch (e) {}

    /* 三个测试点：左上、正中、右下（都在物理屏 1920x1080 内 ✓，且都远离屏幕边缘 ✓） */
    const pts = [[300, 200], [960, 540], [1600, 900]];
    L('');
    L('=== 注入 → 两套尺子读回（★只移动，不点击✗★）===');
    for (const [x, y] of pts) {
      await input.move(x, y);
      await new Promise((r) => setTimeout(r, 350));
      const dip = screen.getCursorScreenPoint();
      let phys = null;
      try { phys = await fw.cursorPos(); } catch (e) { phys = 'ERR ' + e.message; }
      L('注入 move(' + x + ',' + y + ')  →  Electron 读回(DIP?)=(' + dip.x + ',' + dip.y + ')'
        + '   focuswin 读回(物理?)=(' + (phys && phys.x != null ? phys.x + ',' + phys.y : JSON.stringify(phys)) + ')');
    }
    L('');
    L('=== 判读规则 ===');
    L('· 若 focuswin 读回 ≈ 注入值，而 Electron 读回 ≈ 注入值/1.25 → 注入是物理 ✓、Electron 读回是 DIP ✗（两者混用就会出 20% 偏移 ✗）');
    L('· 若两边读回都 ≈ 注入值 → 这个 Electron 进程是 DPI-unaware 语义或缩放被系统吸收了 ✓（要看截图尺寸再定 ✓）');
    L('· 截图/OCR 的坐标之前实测为 1920x1080 的**物理**像素 ✓（captureScreenFallback ✓）');
    app.exit(0);
  } catch (e) { L('ERR ' + (e && e.stack || e)); app.exit(1); }
});
