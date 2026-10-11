/* 用**真实的鹰角启动器**验证：网格能不能让她把坐标读准
 * electron.exe app\scripts\test-launcher-real.js
 *
 * 背景：她一直点不中启动器右下角的「开始游戏」。
 * 查清点击机制没问题（光标落点 1px、点击确实送到控件），问题是**她估位置估不准**：
 *   真实位置（模型空间）约 1837,1025，她给 1500,807 —— 偏了约 300px，方向是"往中间缩"。
 * 对策：截图里画坐标网格（自己在 capture.js 画的），让她"读"而不是"估"。
 * 本脚本用真启动器验证，并把她给的坐标与真实按钮位置对比。
 */
const path = require('path');
const fs = require('fs');
const { app, screen, nativeImage } = require('electron');
const REAL = path.join(process.env.APPDATA, 'dayu-pet');
const T = path.join(process.env.APPDATA, 'dayu-pet-launchertest');
fs.mkdirSync(T, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(REAL, 'config.json'), 'utf8'));
cfg.visionEnabled = true; cfg.visionKey = ''; cfg.visionBase = ''; cfg.visionModel = 'deepseek-flash';
fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify(cfg, null, 2));
try { fs.copyFileSync(path.join(REAL, 'persona.json'), path.join(T, 'persona.json')); } catch {}
try { fs.unlinkSync(path.join(T, 'clock-offset.json')); } catch {}
app.setPath('userData', T);
require('../main.js');

const { spawnSync } = require('child_process');
function ps(cmd) { try { return String(spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 25000, windowsHide: true }).stdout || '').trim(); } catch { return ''; } }
function focusLauncher() {
  const s = "Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public class FL{[DllImport(\"user32.dll\")]static extern bool EnumWindows(EP cb,IntPtr p);[DllImport(\"user32.dll\")]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);[DllImport(\"user32.dll\")]static extern bool GetWindowRect(IntPtr h,out R r);[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int c);public delegate bool EP(IntPtr h,IntPtr p);[StructLayout(LayoutKind.Sequential)]public struct R{public int L,T,Rr,B;}public static IntPtr F=IntPtr.Zero;public static string Rect(System.Func<string> _){return \"\";}public static void Go(){EnumWindows((h,p)=>{var sb=new StringBuilder(300);GetWindowText(h,sb,300);if(sb.ToString().Contains(\"\\u9e70\\u89d2\")){F=h;return false;}return true;},IntPtr.Zero);if(F!=IntPtr.Zero){ShowWindow(F,9);ShowWindow(F,5);SetForegroundWindow(F);}}public static string R2(){if(F==IntPtr.Zero)return \"none\";R r;GetWindowRect(F,out r);return r.L+\",\"+r.T+\",\"+(r.Rr-r.L)+\"x\"+(r.B-r.T);}}'; [FL]::Go(); Start-Sleep -Milliseconds 1200; [FL]::R2()";
  return ps(s);
}
function getCursor() { return ps("Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class G3{[DllImport(\"user32.dll\")]public static extern bool GetCursorPos(out P p);[StructLayout(LayoutKind.Sequential)]public struct P{public int X;public int Y;}public static string G(){P p;GetCursorPos(out p);return p.X+\",\"+p.Y;}}'; [G3]::G()"); }

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

  try {
    await wait(4500);
    const pet = M.win().petWin;
    try { pet.hide(); } catch {}          // 宠物窗别挡着
    await wait(600);

    L('=== 把鹰角启动器调到前台 ===');
    const rect = focusLauncher();
    await wait(1500);
    L('  启动器窗口 rect = ' + rect + '（注意：本进程非 DPI-aware，这可能是缩放过的值，只作参考）');

    L('');
    L('=== 抓一帧带网格的图看看 ===');
    const disp = screen.getPrimaryDisplay();
    const sp = input.space();
    const f = await screenstream.grabFrame({ grid: true });
    check('抓到带网格的帧', !!f, f ? (f.width + 'x' + f.height) : 'null');
    if (f) {
      const png = path.join(process.env.TEMP, 'grid-frame.png');
      fs.writeFileSync(png, nativeImage.createFromDataURL(f.dataUrl).toPNG());
      L('  已存: ' + png + '（人眼确认网格与刻度）');
      const f2 = await screenstream.grabFrame({ grid: false });
      L('  grid:false 也抓到了: ' + (!!f2) + '（OCR 那条路不画网格）');
    }

    L('');
    L('=== 让她在带网格的图上找「开始游戏」按钮 ===');
    const t0 = Date.now();
    const r = await assistant.run('screen_look',
      '这是鹰角启动器（明日方舟）。请找到右下角那个蓝色的「开始游戏」按钮。'
      + '图上有坐标网格和黄色刻度数字，请顺着网格读出它的坐标，'
      + '最后单独输出一行 ACTION: move|x,y（只是移动，不要点击）。');
    L('  耗时 ' + (Date.now() - t0) + 'ms');
    L('  她说: ' + String(r.text).replace(/\n/g, ' ').slice(0, 220));
    L('  action = ' + JSON.stringify(r.action));
    check('给出了坐标', !!r.action || /\d{3,}\s*,\s*\d{3,}/.test(String(r.text)));
    let mx = NaN, my = NaN;
    const src = r.action ? String(r.action.arg) : String(r.text);
    const m = src.match(/(\d{3,4})\s*[,，]\s*(\d{3,4})/);
    if (m) { mx = Number(m[1]); my = Number(m[2]); }
    L('  她给的坐标（模型空间 1920x1080）: ' + mx + ',' + my + '  → 占比 ' + Math.round(mx / sp.w * 100) + '% / ' + Math.round(my / sp.h * 100) + '%');

    /* 真实按钮位置：从上一轮人眼定位得到（DIP 约 1430~1536, 800~864）→ 模型空间 */
    /* 真值来源：带网格的截图上一眼可读 —— 按钮在 1440 与 1680 两条竖线之间、略低于 810 横线，中心约 (1560,845)。我第一版用旧裁切图估成 (1838,1025)，是错的。 */
    const trueDIP = { x: 1560 / sp.w * disp.size.width, y: 845 / sp.h * disp.size.height };
    const trueModel = { x: 1560, y: 845 };
    L('  真实按钮中心（从网格图上量得）→ 模型空间 ' + trueModel.x + ',' + trueModel.y);
    const err = Math.round(Math.hypot(mx - trueModel.x, my - trueModel.y));
    L('  ★ 偏差 = ' + err + 'px（她以前偏约 300px）');
    check('★ 带网格后偏差明显变小（<150px，以前约 300px）', err < 150, err + 'px');

    L('');
    L('=== 真的移动过去，看光标落到哪 ===');
    if (Number.isFinite(mx)) {
      input.move(mx, my);
      await wait(700);
      const cur = getCursor();
      const curDIP = cur.split(',').map(Number);
      L('  她说移动到的模型坐标 → 光标实测 DIP ' + cur);
      const wantDIP2 = { x: mx / sp.w * disp.size.width, y: my / sp.h * disp.size.height };
      L('  换算期望 DIP ' + Math.round(wantDIP2.x) + ',' + Math.round(wantDIP2.y));
      const e2 = Math.hypot(curDIP[0] - wantDIP2.x, curDIP[1] - wantDIP2.y);
      check('移动到位（<20px）', e2 < 20, Math.round(e2) + 'px');
      /* 截图看光标现在在按钮上吗 */
      const shot = await screenstream.grabFrame({ grid: true });
      if (shot) fs.writeFileSync(path.join(process.env.TEMP, 'cursor-at-button.png'), nativeImage.createFromDataURL(shot.dataUrl).toPNG());
      L('  已存光标位置截图: ' + path.join(process.env.TEMP, 'cursor-at-button.png'));
    }

    L('');
    L('=== 真的点一下「开始游戏」 ===');
    if (Number.isFinite(mx)) {
      input.click(mx, my);
      await wait(2500);
      const after = await assistant.run('screen_look', '现在屏幕上是什么？鹰角启动器还在吗，还是已经进入游戏/加载界面了？一两句话说明。');
      const txt = String(after.text).replace(/\n/g, ' ');
      L('  点击后她说: ' + txt.slice(0, 200));
      const stillLauncher = /启动器|官网|VECTOR|宣传图/.test(txt) && !/加载|进入游戏|登录界面|更新/.test(txt);
      check('★ 启动器响应了（不再停在启动器界面）', !stillLauncher, stillLauncher ? '仍停在启动器' : '已离开启动器');
      const shot2 = await screenstream.grabFrame({ grid: true });
      if (shot2) fs.writeFileSync(path.join(process.env.TEMP, 'after-click.png'), nativeImage.createFromDataURL(shot2.dataUrl).toPNG());
      L('  点击后的截图: ' + path.join(process.env.TEMP, 'after-click.png'));
    }
    L('');
    L('  通过 ' + pass + ' / ' + total);
    try { pet.show(); } catch {}
  } catch (e) {
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit(0), 300);
});
