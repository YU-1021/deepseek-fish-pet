/* 光标可见性 + "找到按钮并点中"全链路验证
 * electron.exe app\scripts\test-cursor-click.js
 *
 * 背景（用户报）：
 *   "她识别光标和启动游戏按钮总是有问题" + "她点不了开始游戏的按钮"。
 *   实测查明：桌面捕获**不含鼠标指针**（Chromium 合成指针被系统拒绝，日志里
 *   有 mouse_cursor_monitor_win.cc Unable to get cursor info Error=5），
 *   所以模型看不到"鼠标现在在哪"。这里两部分都验：
 *     1) 抓帧里现在有没有把光标画出来
 *     2) 视觉模型能不能在一堆内容里找到"开始游戏"按钮，并按坐标真的点中它
 */
const path = require('path');
const fs = require('fs');
const { app, screen, nativeImage, BrowserWindow } = require('electron');
const REAL_UD = path.join(process.env.APPDATA, 'dayu-pet');
const T = path.join(process.env.APPDATA, 'dayu-pet-cursortest');
fs.mkdirSync(T, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(REAL_UD, 'config.json'), 'utf8'));
cfg.visionEnabled = true; cfg.visionKey = ''; cfg.visionBase = ''; cfg.visionModel = 'deepseek-flash';
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify(cfg, null, 2));
try { fs.copyFileSync(path.join(REAL_UD, 'persona.json'), path.join(T, 'persona.json')); } catch {}
try { fs.unlinkSync(path.join(T, 'clock-offset.json')); } catch {}
app.setPath('userData', T);
require('../main.js');

const { spawnSync } = require('child_process');
function setCursor(x, y) {
  const ps = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class S2{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);}'; [S2]::SetCursorPos(${x},${y})`;
  try { spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 12000, windowsHide: true }); } catch {}
}

app.whenReady().then(async () => {
  const M = require('../main.js');
  const input = require('../src/input');
  const screenstream = require('../src/screenstream');
  const assistant = require('../src/assistant');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  const diffRegion = (a, b, cx, cy, r) => {
    const ia = a.toBitmap(), ib = b.toBitmap();
    const w = a.getSize().width, h = a.getSize().height;
    let diff = 0, n = 0;
    for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
        const i = (y * w + x) * 4;
        if (Math.abs(ia[i] - ib[i]) + Math.abs(ia[i + 1] - ib[i + 1]) + Math.abs(ia[i + 2] - ib[i + 2]) > 40) diff++;
        n++;
      }
    }
    return { diff, n, pct: Math.round(diff / Math.max(1, n) * 1000) / 10 };
  };

  try {
    await wait(4500);
    const disp = screen.getPrimaryDisplay();
    const sp = input.space();
    const pet = M.win().petWin;
    try { pet.hide(); } catch {}                 // 宠物窗 alwaysOnTop，会挡住靶子
    await screenstream.grabFrame();
    await wait(800);

    L('');
    L('=== 1. 抓帧里现在有没有光标 ===');
    const cx = Math.round(sp.w / 2), cy = Math.round(sp.h / 2);
    setCursor(Math.round(disp.size.width / 2), Math.round(disp.size.height / 2));
    await wait(700);
    const f1 = await screenstream.grabFrame();
    setCursor(40, disp.size.height - 40);
    await wait(700);
    const f2 = await screenstream.grabFrame();
    if (f1 && f2) {
      L('  抓帧返回里带 cursor 字段: ' + JSON.stringify(f1.cursor) + ' / ' + JSON.stringify(f2.cursor));
      check('抓帧回传了光标坐标', !!(f1.cursor && Number.isFinite(f1.cursor.x)), JSON.stringify(f1.cursor));
      const r = diffRegion(nativeImage.createFromDataURL(f1.dataUrl), nativeImage.createFromDataURL(f2.dataUrl), cx, cy, 26);
      L('  中心区域差异: ' + r.diff + ' / ' + r.n + ' 像素 (' + r.pct + '%)');
      check('★ 光标被画进画面了（中心区域有明显差异）', r.pct > 3, r.pct + '%');
      check('第一次抓帧的光标坐标 ≈ 画面中心',
        Math.abs(f1.cursor.x - cx) < 30 && Math.abs(f1.cursor.y - cy) < 30,
        'cursor=' + JSON.stringify(f1.cursor) + ' 中心=(' + cx + ',' + cy + ')');
      fs.writeFileSync(path.join(T, 'with-cursor.png'), nativeImage.createFromDataURL(f1.dataUrl).toPNG());
      L('  图已存: ' + path.join(T, 'with-cursor.png') + '（可以人眼确认十字准星）');
    } else {
      check('抓帧成功', false, 'f1/f2 为空');
    }

    L('');
    L('=== 2. 开一个带「开始游戏」按钮的靶子窗 ===');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;background:#1b2030;color:#eee;font-family:"Microsoft YaHei",sans-serif;display:flex;
           flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:28px}
      h1{font-size:34px;margin:0;letter-spacing:4px;color:#8fb4ff}
      p{color:#8b93a8;margin:0}
      #go{font-size:30px;padding:26px 76px;border-radius:16px;border:3px solid #4d6bfe;background:#2b3a6b;
          color:#fff;cursor:pointer;letter-spacing:6px}
      #go:hover{background:#3a4f8f}</style></head>
      <body><h1>大肥鱼·测试靶场</h1>
      <p>这是一个测试窗口，用来验证"能不能找到按钮并点中"</p>
      <button id="go" onclick="document.title='CLICKED'">开始游戏</button>
      <p id="st">状态：未点击</p>
      <script>document.getElementById('go').addEventListener('click',function(){document.getElementById('st').textContent='状态：已点击';});</script>
      </body></html>`;
    const win = new BrowserWindow({ width: 560, height: 420, x: Math.round(disp.size.width / 2 - 280), y: 120, title: 'TARGET', alwaysOnTop: true, webPreferences: { nodeIntegration: false } });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await wait(2500);
    win.show(); win.focus();
    await wait(1200);
    const pos = win.getPosition(), size = win.getSize();
    L('  靶子窗位置 ' + JSON.stringify(pos) + ' 尺寸 ' + JSON.stringify(size) + '  标题=' + win.getTitle());
    check('靶子窗起来了', win.getTitle() === 'TARGET', win.getTitle());
    /* 按钮在这个窗里的相对位置：垂直偏下（flex 布局第三个元素） */
    const btnRect = await win.webContents.executeJavaScript(`(() => { const b=document.getElementById('go').getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height}; })()`);
    const trueDIP = { x: pos[0] + btnRect.x + btnRect.w / 2, y: pos[1] + btnRect.y + btnRect.h / 2 };
    L('  按钮真实中心（屏幕 DIP）: ' + JSON.stringify(trueDIP) + '  按钮尺寸 ' + Math.round(btnRect.w) + 'x' + Math.round(btnRect.h));

    L('');
    L('=== 3. 让视觉模型找「开始游戏」并按它的坐标点 ===');
    const t0 = Date.now();
    const r = await assistant.run('screen_look', '屏幕上有一个深色窗口，里面有个蓝色边框的大按钮写着「开始游戏」。请给出这个按钮中心的坐标，最后单独输出一行 ACTION: click|x,y');
    L('  耗时 ' + (Date.now() - t0) + 'ms   action=' + JSON.stringify(r.action));
    L('  她的话: ' + String(r.text).replace(/\n/g, ' ').slice(0, 130));
    check('给出了 ACTION: click', !!r.action && r.action.tool === 'click', JSON.stringify(r.action));
    if (r.action) {
      const m = String(r.action.arg).match(/(\d+)\s*,\s*(\d+)/);
      if (m) {
        const mx = Number(m[1]), my = Number(m[2]);
        const wantDIP = { x: trueDIP.x / disp.size.width * sp.w, y: trueDIP.y / disp.size.height * sp.h };
        const errModel = Math.round(Math.hypot(mx - wantDIP.x, my - wantDIP.y));
        const btnModelW = btnRect.w / disp.size.width * sp.w;
        L('  她给的坐标 (' + mx + ',' + my + ')   按钮真实中心在模型空间 (' + Math.round(wantDIP.x) + ',' + Math.round(wantDIP.y) + ')');
        L('  偏差 ' + errModel + 'px  （按钮在模型空间宽约 ' + Math.round(btnModelW) + 'px）');
        check('★ 她给的坐标落在按钮内（偏差 < 按钮半宽）', errModel < btnModelW / 2, errModel + 'px vs 半宽 ' + Math.round(btnModelW / 2) + 'px');
        /* 真的点下去 */
        input.click(mx, my);
        await wait(1200);
        check('★ 按钮真的被点中了', win.getTitle() === 'CLICKED', '标题=' + win.getTitle());
        const st = await win.webContents.executeJavaScript("document.getElementById('st').textContent");
        L('  靶子状态: ' + st);
        check('页面上也记录了点击', /已点击/.test(st), st);
      } else check('坐标格式', false, r.action.arg);
    }
    try { win.destroy(); } catch {}
    try { M.win().petWin.show(); } catch {}

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    var crashed = String((e && e.stack) || e);
    L('ERROR: ' + crashed);
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 300);
});
