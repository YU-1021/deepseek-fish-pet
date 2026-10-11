/* 诊断：点击到底有没有送到靶子窗？送到的坐标对不对？
 * electron.exe app\scripts\probe-click.js
 */
const path = require('path');
const fs = require('fs');
const { app, screen, BrowserWindow } = require('electron');
const REAL = path.join(process.env.APPDATA, 'dayu-pet');
const T = path.join(process.env.APPDATA, 'dayu-pet-clickprobe');
fs.mkdirSync(T, { recursive: true });
try {
  fs.copyFileSync(path.join(REAL, 'config.json'), path.join(T, 'config.json'));
  fs.copyFileSync(path.join(REAL, 'persona.json'), path.join(T, 'persona.json'));
} catch {}
app.setPath('userData', T);
require('../main.js');

const { spawnSync } = require('child_process');
function cursorPos() {
  const ps = "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class CP{[DllImport(\"user32.dll\")]public static extern bool GetCursorPos(out PT p);[StructLayout(LayoutKind.Sequential)]public struct PT{public int X;public int Y;}public static string G(){PT p;GetCursorPos(out p);return p.X+\",\"+p.Y;}}'; [CP]::G()";
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const m = String(r.stdout || '').trim().match(/(-?\d+),(-?\d+)/);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  } catch { return null; }
}

/* 靶子页：把所有鼠标事件记下来，能一眼看出点到哪了 */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#123;height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:20px}
#go{font-size:28px;padding:30px 70px;background:#2b3a6b;color:#fff;border:3px solid #4d6bfe;border-radius:14px}
#log{color:#9fb;font-family:monospace;font-size:13px;white-space:pre}</style></head>
<body><button id="go">开始游戏</button><div id="log">事件：</div>
<script>
window.__ev = [];
function rec(s, e) {
  window.__ev.push(s + ' @' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' target=' + (e.target && e.target.id || e.target.tagName));
  document.getElementById('log').textContent = window.__ev.join('\\n').slice(-400);
}
for (const t of ['mousedown','mouseup','click']) document.addEventListener(t, (e) => rec(t, e), true);
document.getElementById('go').addEventListener('click', () => { document.title = 'CLICKED'; });
</script></body></html>`;

app.whenReady().then(async () => {
  const M = require('../main.js');
  const input = require('../src/input');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    await wait(4500);
    const disp = screen.getPrimaryDisplay();
    const sp = input.space();
    const pet = M.win().petWin;
    try { pet.hide(); } catch {}
    await wait(600);

    const win = new BrowserWindow({ width: 600, height: 400, x: 200, y: 200, title: 'TARGET', alwaysOnTop: true, webPreferences: { nodeIntegration: false } });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
    await wait(2500);
    win.show(); win.focus(); win.moveTop();
    await wait(1200);

    const r = await win.webContents.executeJavaScript('(() => { const b = document.getElementById("go").getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height}; })()');
    const pos = win.getPosition(), size = win.getSize();
    L('=== 几何 ===');
    L('  窗口 getPosition=' + JSON.stringify(pos) + ' getSize=' + JSON.stringify(size));
    L('  按钮在页内 rect=' + JSON.stringify(r));
    L('  显示器 DIP=' + disp.size.width + 'x' + disp.size.height + '  scaleFactor=' + disp.scaleFactor);
    L('  抓帧空间=' + sp.w + 'x' + sp.h);

    /* 三种候选坐标都点一遍，看哪个能到 */
    const cands = [
      ['A 窗口左上+rect（含标题栏误差）', { x: pos[0] + r.x + r.w / 2, y: pos[1] + r.y + r.h / 2 }],
      ['B 窗口左上+rect+31（把标题栏加回去）', { x: pos[0] + r.x + r.w / 2, y: pos[1] + 31 + r.y + r.h / 2 }],
      ['C 直接用 rect+窗口内容区原点(用 screenX/Y)', null],
    ];
    /* 方案 C：用渲染层的 screenX/screenY（浏览器给的"窗口内容区在屏幕上的位置"） */
    const sx = await win.webContents.executeJavaScript('({x: window.screenX, y: window.screenY, ox: window.outerWidth - window.innerWidth, oy: window.outerHeight - window.innerHeight})');
    L('  渲染层 screenX/Y=' + sx.x + ',' + sx.y + '  外框-内容=' + sx.ox + 'x' + sx.oy);
    cands[2][1] = { x: sx.x + r.x + r.w / 2, y: sx.y + r.y + r.h / 2 };

    for (const [name, p] of cands) {
      await win.webContents.executeJavaScript('window.__ev = []; document.getElementById("log").textContent = "事件："; document.title = "TARGET";');
      const mx = Math.round(p.x / disp.size.width * sp.w), my = Math.round(p.y / disp.size.height * sp.h);
      L('');
      L('=== ' + name + ' ===');
      L('  DIP(' + Math.round(p.x) + ',' + Math.round(p.y) + ') → 模型(' + mx + ',' + my + ')');
      L('  点击前 isFocused=' + win.isFocused());
      input.click(mx, my);
      await wait(1100);
      const cur = cursorPos();
      const ev = await win.webContents.executeJavaScript('window.__ev');
      L('  点击后光标实测=' + JSON.stringify(cur) + '  目标DIP=' + Math.round(p.x) + ',' + Math.round(p.y));
      L('  点击后 isFocused=' + win.isFocused() + '  标题=' + win.getTitle());
      L('  靶子收到的事件: ' + (ev.length ? ev.join(' | ') : '（**一个都没收到**）'));
    }

    L('');
    L('=== 结论要点 ===');
    L('  如果某个候选收到了 mousedown/mouseup/click，说明坐标该用那个、点击机制本身没问题；');
    L('  如果一个都没收到，说明点击根本没送到这个窗口（前台/Z 序/注入被拦）。');
    try { win.destroy(); } catch {}
    try { pet.show(); } catch {}
  } catch (e) {
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit(0), 300);
});
