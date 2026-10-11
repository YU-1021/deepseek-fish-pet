/* 高分辨率 + 坐标空间一致性验证（这是"改分辨率"最危险的地方）
 * electron.exe app\scripts\test-screen-space.js
 *
 * 为什么必须测：抓帧尺寸同时是**坐标空间** —— 模型看着 1920x1080 的图报坐标，
 * 而 input.norm 若还按 1280x720 归一化，点击会整体偏移约 1.5 倍（全点到左下角）。
 * 所以这里既验"图真的变大了"，也验"报出来的坐标真能把光标送到正确位置"。
 *
 * 不改用户配置（副本 + visionEnabled=true）。
 */
const path = require('path');
const fs = require('fs');
const { app, screen } = require('electron');
const REAL_UD = path.join(process.env.APPDATA, 'dayu-pet');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-spacetest');
fs.mkdirSync(TEST_UD, { recursive: true });
const cfgBase = JSON.parse(fs.readFileSync(path.join(REAL_UD, 'config.json'), 'utf8'));
cfgBase.visionEnabled = true; cfgBase.visionKey = ''; cfgBase.visionBase = ''; cfgBase.visionModel = 'deepseek-flash';
fs.writeFileSync(path.join(TEST_UD, 'config.json'), JSON.stringify(cfgBase, null, 2));
try { fs.copyFileSync(path.join(REAL_UD, 'persona.json'), path.join(TEST_UD, 'persona.json')); } catch {}
app.setPath('userData', TEST_UD);

const { spawnSync } = require('child_process');
function cursorPos() {
  const ps = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class C{[DllImport("user32.dll")]public static extern bool GetCursorPos(out P p);[StructLayout(LayoutKind.Sequential)]public struct P{public int X;public int Y;}public static string G(){P p;GetCursorPos(out p);return p.X+","+p.Y;}}'; [C]::G()`;
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const m = String(r.stdout || '').trim().match(/(-?\d+),(-?\d+)/);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  } catch { return null; }
}

app.whenReady().then(async () => {
  const out = [];
  const L = (s) => out.push(s);
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  try {
    const screenstream = require('../src/screenstream');
    const input = require('../src/input');
    const config = require('../src/config');
    const disp = screen.getPrimaryDisplay();
    const cfg = config.load();
    L('=== 配置与屏幕 ===');
    L('  配置抓帧: ' + cfg.screenCaptureWidth + 'x' + cfg.screenCaptureHeight + '  JPEG q=' + cfg.screenJpegQuality + '  detail=' + cfg.visionDetail);
    L('  显示器: ' + disp.size.width + 'x' + disp.size.height + ' (DIP, scale=' + disp.scaleFactor + ')');
    check('input.space() 和配置一致',
      input.space().w === cfg.screenCaptureWidth && input.space().h === cfg.screenCaptureHeight,
      JSON.stringify(input.space()));

    L('');
    L('=== 1. 抓帧分辨率真的提上去了吗 ===');
    let t = Date.now();
    const f1 = await screenstream.grabFrame();
    const cold = Date.now() - t;
    check('抓到帧', !!f1, cold + 'ms');
    if (f1) {
      const bytes = Buffer.from(f1.dataUrl.split(',')[1], 'base64').length;
      L('  实际抓帧: ' + f1.width + 'x' + f1.height + '   ' + Math.round(bytes / 1024) + 'KB   ' + cold + 'ms');
      check('★ 抓帧尺寸 = 配置尺寸（不再是 1280x720）',
        f1.width === cfg.screenCaptureWidth && f1.height === cfg.screenCaptureHeight,
        f1.width + 'x' + f1.height);
      check('★ 分辨率确实比原来高（像素数 > 1280x720）', f1.width * f1.height > 1280 * 720,
        Math.round(f1.width * f1.height / (1280 * 720) * 100) + '% of 1280x720');
      const warm = [];
      for (let i = 0; i < 3; i++) { t = Date.now(); await screenstream.grabFrame(); warm.push(Date.now() - t); }
      L('  热态抓帧: ' + warm.join('/') + 'ms（分辨率涨了，抓帧仍要够快）');
      check('抓帧仍然很快（<400ms）', Math.max(...warm) < 400, warm.join('/') + 'ms');
    }

    L('');
    L('=== 2. ★ 坐标映射：模型报的坐标能不能把光标送到正确位置 ===');
    /* 用屏幕 DIP 尺寸换算期望值：模型空间 → 屏幕 DIP */
    const expectScreen = (mx, my) => ({
      x: mx / input.space().w * disp.size.width,
      y: my / input.space().h * disp.size.height,
    });
    for (const [name, mx, my] of [
      ['左上角', 20, 20], ['中心', Math.round(input.space().w / 2), Math.round(input.space().h / 2)],
      ['右下角', input.space().w - 20, input.space().h - 20],
    ]) {
      input.move(mx, my);
      await new Promise((r) => setTimeout(r, 250));
      const got = cursorPos();
      const want = expectScreen(mx, my);
      const err = got ? Math.round(Math.hypot(got.x - want.x, got.y - want.y)) : 9999;
      check('模型(' + mx + ',' + my + ') [' + name + '] → 屏幕偏差 <20px', err < 20,
        got ? ('实测 ' + got.x + ',' + got.y + ' 期望 ' + Math.round(want.x) + ',' + Math.round(want.y) + '  偏差 ' + err + 'px') : '读不到光标');
    }

    L('');
    L('=== 3. ★ 全链路：真视觉模型在人机界面上找元素 → 真的把光标送过去 ===');
    const assistant = require('../src/assistant');
    t = Date.now();
    const r = await assistant.run('screen_look',
      '看一下屏幕最左下角那个 Windows「开始」按钮（任务栏最左边的徽标）。'
      + '只输出一行 ACTION: move|x,y，坐标基于你看到的截图尺寸。');
    const ms = Date.now() - t;
    L('  耗时 ' + ms + 'ms   action=' + JSON.stringify(r.action));
    L('  她的原话: ' + String(r.text).replace(/\n/g, ' ').slice(0, 110));
    check('给出了 ACTION', !!r.action, JSON.stringify(r.action));
    if (r.action) {
      const m = String(r.action.arg).match(/(\d+)\s*,\s*(\d+)/);
      if (m) {
        const mx = Number(m[1]), my = Number(m[2]);
        const sp = input.space();
        L('  坐标 (' + mx + ',' + my + ') → 占比 x=' + Math.round(mx / sp.w * 100) + '% y=' + Math.round(my / sp.h * 100) + '%');
        check('★ 坐标落在左下角（x<15%, y>85%）', mx / sp.w < 0.15 && my / sp.h > 0.85, '(' + mx + ',' + my + ')');
        /* 真的把光标送过去，看它落在哪 */
        input.move(mx, my);
        await new Promise((r2) => setTimeout(r2, 300));
        const got = cursorPos();
        const want = expectScreen(mx, my);
        const err = got ? Math.round(Math.hypot(got.x - want.x, got.y - want.y)) : 9999;
        check('★ 按她给的坐标移动后，光标真的到位（偏差 <25px）', err < 25,
          got ? ('光标 ' + got.x + ',' + got.y + '  期望 ' + Math.round(want.x) + ',' + Math.round(want.y) + '  偏差 ' + err + 'px') : '读不到');
        check('光标确实在屏幕左下角区域', got && got.x < disp.size.width * 0.15 && got.y > disp.size.height * 0.85,
          got ? (got.x + ',' + got.y) : '');
      } else check('坐标格式 x,y', false, r.action.arg);
    }

    L('');
    L('=== 4. 高分辨率对识别质量的实际影响（用合成小字图对比 low/high）===');
    const PNG = path.join(process.env.TEMP, 'space-probe.png');
    if (fs.existsSync(PNG)) {
      const du = 'data:image/png;base64,' + fs.readFileSync(PNG).toString('base64');
      const vision = require('../src/vision');
      for (const d of ['low', 'high']) {
        t = Date.now();
        let txt = '';
        try { txt = await vision.describe(Object.assign({}, config.load(), { visionDetail: d }), du, '图里的文字是什么？', d); } catch (e) { txt = '错误 ' + e.message.slice(0, 40); }
        check('detail=' + d + ' 能读出 Hello 7391', /HELLO/i.test(txt) && /7391/.test(txt), (Date.now() - t) + 'ms  ' + txt.replace(/\n/g, ' ').slice(0, 60));
      }
    } else L('  （没有合成图，跳过）');

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    var crashed = String((e && e.stack) || e);
    L('ERROR: ' + crashed);
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
