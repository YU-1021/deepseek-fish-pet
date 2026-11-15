/* probe-electron-boot.js —— ★最小"Electron 能不能跑"探针（无可见窗口 ✓ 无管道 ✓ 结果写文件）★
 *
 * 为什么要有它 ✗：我的会话里 `electron.exe app/main.js` 一直秒退 ✗ 而且**拿不到任何输出** ✗
 *   （沙箱不给管道 ✗、`-RedirectStandard*` 又会让 electron 直接 0x80000003 ✗）→
 *   "分不清是 Electron 起不来，还是她的 main.js 崩了" ✓。
 *   所以这个探针：★不建任何可见窗口（show:false ✓）★、★把结果写成**文件**（不走 stdout ✓）★、
 *   ★跑完 process.exit(0) ✓★ —— 它过了 = Electron 在这台机器/这个目录能跑 ✓。
 *
 * 跑法：Start-Process electron.exe -ArgumentList "<repo>\app\scripts\probe-electron-boot.js" ...
 * 结果：C:\deepseek\probe-electron-boot.json
 */
'use strict';
const fs = require('fs');
const OUT = 'C:/deepseek/probe-electron-boot.json';
const steps = [];
function L(s) { steps.push(String(s)); }
function write(extra) {
  try { fs.writeFileSync(OUT, JSON.stringify(Object.assign({ steps, at: new Date().toISOString() }, extra || {}), null, 2)); } catch (e) {}
}

L('script loaded');
let app = null, BrowserWindow = null;
try {
  const el = require('electron');
  app = el.app; BrowserWindow = el.BrowserWindow;
  L('require(electron) ok; app=' + (!!app) + ' BrowserWindow=' + (!!BrowserWindow));
} catch (e) { L('require(electron) FAILED: ' + e.message); write({ ok: false }); process.exit(1); }

if (!app || !BrowserWindow) { L('no app/BrowserWindow (ELECTRON_RUN_AS_NODE?)'); write({ ok: false }); process.exit(1); }

process.on('uncaughtException', (e) => { L('uncaughtException: ' + (e && e.stack || e)); write({ ok: false }); process.exit(1); });

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  try {
    const w = new BrowserWindow({ show: false, width: 200, height: 120 });   // ★show:false —— 绝不弹窗 ✓
    w.loadURL('about:blank');
    L('whenReady ok; BrowserWindow created; visible=' + w.isVisible());
    const d = require('electron').screen.getPrimaryDisplay();
    L('primary display: ' + d.size.width + 'x' + d.size.height + ' scale=' + d.scaleFactor + ' work=' + JSON.stringify(d.workAreaSize));
    setTimeout(() => {
      write({ ok: true, electron: process.versions.electron, node: process.versions.node });
      process.exit(0);
    }, 800);
  } catch (e) { L('whenReady body FAILED: ' + (e && e.stack || e)); write({ ok: false }); process.exit(1); }
});
