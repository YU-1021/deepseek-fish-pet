/* probe-envcheck-node.js —— ★点击前环境检查的真机验证（纯 Node 版）★
 *
 * 为什么不用 Electron ✗：本会话沙箱里 **Electron 的子进程管道被拦**（focuswin/OCR 全拿不到结果），
 *   而纯 Node 的 spawnSync 是好的 ✓ —— 所以把真机判定放到这里跑：
 *     · 窗口列表 / 光标：focuswin.js（那段 PS 声明了 PER_MONITOR_AWARE_V2 → 物理像素 ✓）
 *     · 抓帧：.NET CopyFromScreen（先声明 DPI 感知 → 物理像素 ✓）→ jimp 解码 → BGRA → envcheck.brightRatio ✓
 *     · 任务栏上边缘：工作区 1536x816 vs 屏幕 1536x864（DIP）→ 按比例换算到 1920x1080 ✓
 * 它**不移动光标、不点击** ✓。结果写 C:\deepseek\probe-envcheck-node.out.txt
 *
 * 跑法：cd app && node scripts\probe-envcheck-node.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const APP = __dirname + path.sep + '..';
const OUT = 'C:/deepseek/probe-envcheck-node.out.txt';
const TMPDIR = 'C:/deepseek/tmp-envcheck';
fs.mkdirSync(TMPDIR, { recursive: true });
const out = [];
function L(s) { out.push(String(s)); try { fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8'); } catch (e) {} try { process.stdout.write(String(s) + '\n'); } catch (e) {} }
const info = (t, x) => L('  [INFO] ' + t + (x ? '   ' + x : ''));
let pass = 0, fail = 0;
function ok(c, label, extra) { if (c) { pass++; L('  [PASS] ' + label + (extra ? '   ' + extra : '')); } else { fail++; L('  [FAIL] ' + label + (extra ? '   ' + extra : '')); } }

const fw = require(path.join(APP, 'src', 'focuswin'));
const EC = require(path.join(APP, 'src', 'envcheck'));

function psJson(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 40000, windowsHide: true });
  return String(r.stdout || '').trim();
}
/* 抓一整屏（物理像素）+ 解码成 BGRA（jimp 的 bitmap.data 是 RGBA → 转 BGRA） */
async function grab() {
  const p = path.join(TMPDIR, 'grab-' + Date.now() + '.png').replace(/\\/g, '/');
  const ps = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;Add-Type -AssemblyName System.Drawing;'
    + 'Add-Type -TypeDefinition @"\nusing System;using System.Runtime.InteropServices;public class DD{[DllImport(\"user32.dll\")]public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr c);}\n"@;'
    + '[DD]::SetProcessDpiAwarenessContext([IntPtr](-4))|Out-Null;'
    + '$b=New-Object System.Drawing.Bitmap(1920,1080);$g=[System.Drawing.Graphics]::FromImage($b);'
    + '$g.CopyFromScreen(0,0,0,0,(New-Object System.Drawing.Size(1920,1080)));'
    + '$b.Save(' + JSON.stringify(p) + ',[System.Drawing.Imaging.ImageFormat]::Png);Write-Output SAVED';
  psJson(ps);
  if (!fs.existsSync(p)) return null;
  const { Jimp } = require('jimp');
  const img = await Jimp.fromBuffer(fs.readFileSync(p));
  const d = img.bitmap.data;
  const bgra = Buffer.alloc(img.bitmap.width * img.bitmap.height * 4);
  for (let i = 0; i < bgra.length; i += 4) { bgra[i] = d[i + 2]; bgra[i + 1] = d[i + 1]; bgra[i + 2] = d[i]; bgra[i + 3] = d[i + 3]; }
  return { bgra, w: img.bitmap.width, h: img.bitmap.height, png: p };
}

(async () => {
  L('=== probe-envcheck-node（点击前环境检查：真机窗口 + 亮像素 + 任务栏）===');
  const l = await fw.listWindows();
  info('focuswin: ok=' + l.ok + ' DPI=' + l.dpi + ' scale=' + l.scale + ' 前台=' + l.foregroundTitle);
  /* 任务栏上边缘（DIP 工作区 1536x816 → 坐标空间 1080 里 = 816/864*1080 = 1020 ✓）
     ⚠️ 铁律：JS 字符串里不嵌套 ASCII 双引号 → 用 String.fromCharCode(34) ✓
     （第一版直接写了 "x" 字面量，真机上 PS 返回空串、taskbarTop=null，白跑一轮 ✓） */
  const Q = String.fromCharCode(34);
  const waScript = 'Add-Type -AssemblyName System.Windows.Forms;'
    + '[Console]::WriteLine([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width.ToString() + ' + Q + 'x' + Q
    + ' + [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height.ToString() + ' + Q + ' work=' + Q
    + ' + [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Width.ToString() + ' + Q + 'x' + Q
    + ' + [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea.Height.ToString())';
  const wa = psJson(waScript);
  info('屏幕/工作区（DIP）= ' + wa);
  let taskbarTop = null;
  const m = /(\d+)x(\d+) work=(\d+)x(\d+)/.exec(wa);
  if (m) taskbarTop = Math.round(Number(m[4]) / Number(m[2]) * 1080);
  info('任务栏上边缘（换算到 1920x1080）= ' + taskbarTop);
  ok(taskbarTop != null && taskbarTop > 900, '真机算出了任务栏上边缘', 'y≥' + taskbarTop);

  const g = await grab();
  if (!g) { ok(false, '抓帧失败（后面几条验不了）'); }
  else info('抓到 ' + g.w + 'x' + g.h + '（' + g.png + '）');

  const base = { selfPids: [process.pid], taskbarTop, spaceW: 1920, spaceH: 1080, screenW: 1920, screenH: 1080, grab: async () => g };

  /* §1 纯判定（假数据）：飞框压小面板 / 自己的窗 / cloaked 幽灵窗 / 干净 */
  const GAME = { title: '明日方舟', x: 0, y: 0, w: 1920, h: 1080, hwnd: 1, pid: 111, z: 13, visible: true, iconic: false, cloaked: false, topmost: false };
  const CAL = { title: '日历', x: 1560, y: 400, w: 350, h: 420, hwnd: 2, pid: 222, z: 1, visible: true, iconic: false, cloaked: false, topmost: true };
  const PET = { title: '大肥鱼 · 对话', x: 100, y: 500, w: 500, h: 400, hwnd: 3, pid: 333, z: 2, visible: true, iconic: false, cloaked: false, topmost: true };
  const CLK = { title: 'Windows 输入体验', x: 0, y: 0, w: 1920, h: 1080, hwnd: 4, pid: 444, z: 5, visible: true, iconic: false, cloaked: true, topmost: false };
  const r1 = EC.decide(1860, 662, [GAME, CLK], { screenW: 1920, screenH: 1080 });
  ok(r1.blocked === false && r1.top && r1.top.title === '明日方舟', '§1 只有游戏 + 一个 cloaked 幽灵窗 → 放行', 'top=' + (r1.top && r1.top.title));
  const r2 = EC.decide(1860, 662, [CAL, GAME], { screenW: 1920, screenH: 1080 });
  ok(r2.blocked === true && r2.reason === 'target-covered-by-flyout', '§1 日历飞框压着 → 拦住', String(r2.reason));
  const r3 = EC.decide(200, 600, [PET, GAME], { screenW: 1920, screenH: 1080 });
  ok(r3.blocked === true && r3.reason === 'target-under-own-window', '§1 自己的窗压着 → 拦住', String(r3.reason));
  const r4 = EC.decide(960, 1060, [GAME], { screenW: 1920, screenH: 1080, taskbarTop: 1030 });
  ok(r4.blocked === true && r4.reason === 'point-on-taskbar', '§1 任务栏那一条 → 拦住', String(r4.reason));

  /* §2/§3 真机：用**预期窗口**这条判据做对照，这样和"屏幕上恰好是谁"无关 ✓
     · 压着的是别人（预期=另一个窗口）→ 必须拦住并说出**真实压着的那个**是谁 ✓
     · 预期=真正压着的那个 → 放行 ✓（附带亮像素比例 ✓） */
  const vis = (l.windows || []).filter((w) => w.visible !== false && !w.cloaked && !w.iconic && w.w >= 64 && w.h >= 64)
    .sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0));
  const topW = vis[0];
  info('真机 z 序最上面的可见窗口 = ' + (topW ? (topW.title + ' ' + topW.x + ',' + topW.y + ' ' + topW.w + 'x' + topW.h) : '（没有）'));
  if (!topW) { ok(false, '§2 屏幕上没有可见窗口可比对（换台机器/换个时刻再跑）'); }
  else {
    const px = Math.max(2, Math.min(1918, Math.round(topW.x + topW.w / 2)));
    const py = Math.max(2, Math.min(1018, Math.round(topW.y + topW.h / 2)));
    info('取样点 = (' + px + ',' + py + ')');
    /* (a) 预期 = 别的窗口 → 必须拦住，且 blocker 报的是**真正压着的那个** ✓
       （理由可能是 target-under-own-window（她的窗/DSH 窗）或 target-covered-by-flyout —— 两个都对 ✓） */
    const other = vis.map((w) => w.title).find((t) => t !== topW.title && t.length > 1) || '一个不存在的窗口标题';
    const e2 = await EC.checkPoint(px, py, Object.assign({}, base, { expectTitle: other }));
    info('checkPoint(expect=「' + other + '」): blocked=' + e2.blocked + ' reason=' + e2.reason + ' blocker=' + (e2.blocker && e2.blocker.title));
    ok(e2.blocked === true && e2.blocker && e2.blocker.title === topW.title,
      '§2 真机：最上面那个不是预期窗口 → 拦住，并说出真正压着的是谁',
      'blocker=' + (e2.blocker && e2.blocker.title) + ' reason=' + e2.reason);
    const note2 = require(path.join(APP, 'src', 'safedrive')).envNote(px, py, e2);
    info('回执 note = ' + note2.split('\n')[0].slice(0, 96));
    /* (b) 干净放行：找一个"最上面那个窗口**不是我自己/DSH 的窗**"的点 ——
       自己的窗永远拦（那是设计 ✓），所以不能拿它当"放行"的样本 ✓ */
    const SELF = EC.SELF_HINTS;
    let clean = null;
    for (const w of vis) {
      const cxp = Math.max(2, Math.min(1918, Math.round(w.x + w.w / 2)));
      const cyp = Math.max(2, Math.min(1018, Math.round(w.y + w.h / 2)));
      const st = EC.stackAt(cxp, cyp, l.windows, {});
      const t = st[0];
      if (t && !SELF.some((h) => String(t.title).toLowerCase().indexOf(String(h).toLowerCase()) >= 0)) { clean = { x: cxp, y: cyp, top: t }; break; }
    }
    if (!clean) {
      L('  [SKIP] §3 这一刻屏幕上每个可见窗口的最上面都是"我自己的窗/DSH 窗"（设计上一定拦 ✗）→');
      L('         没法验证"预期命中就放行"那一条；换一台/换一个时刻再跑就有 ✓（判据逻辑在 §1 假数据里已覆盖 ✓）');
    } else {
      const e3 = await EC.checkPoint(clean.x, clean.y, Object.assign({}, base, { expectTitle: clean.top.title }));
      info('checkPoint(' + clean.x + ',' + clean.y + ', expect=「' + clean.top.title + '」): blocked=' + e3.blocked
        + ' top=' + (e3.top && e3.top.title) + ' bright=' + (e3.bright ? (e3.bright.ratio * 100).toFixed(1) + '%' : 'null'));
      ok(e3.blocked === false, '§3 真机：预期窗口对上了 → 放行（环境干净）', 'top=' + (e3.top && e3.top.title));
      ok(!!(e3.bright && e3.bright.ratio != null), '§3 亮像素比例真的量出来了（点的也是它）',
        e3.bright ? ((e3.bright.ratio * 100).toFixed(1) + '% @' + e3.bright.region.w + 'x' + e3.bright.region.h) : 'null');
    }
    const whole = EC.brightRatio(g.bgra, g.w, g.h, { x: 0, y: 0, w: g.w, h: g.h });
    info('同一帧：整屏平均亮像素 ' + (whole.ratio * 100).toFixed(1) + '%');
  }

  /* §4 真机：任务栏那一条 */
  const e4 = await EC.checkPoint(960, taskbarTop + 8, base);
  info('checkPoint(960,' + (taskbarTop + 8) + '): blocked=' + e4.blocked + ' reason=' + e4.reason);
  ok(e4.blocked === true && e4.reason === 'point-on-taskbar', '§4 真机：任务栏上的点 → 拦住（点它会弹日历飞框）', String(e4.reason));

  /* §5 失败原因的细分数值 + 中文（回执走 assistant.js 那一跳，沙箱里跑不到，这里验它的原料） */
  const SD = require(path.join(APP, 'src', 'safedrive'));
  const reasons = ['point-outside-capture-space', 'user-is-using-mouse', 'target-under-own-window', 'target-covered-by-flyout', 'target-covered-by-light-panel', 'point-on-taskbar', 'cursor-did-not-reach-target'];
  const miss = reasons.filter((r) => !SD.reasonText(r) || SD.reasonText(r).indexOf('其它原因') === 0);
  ok(miss.length === 0, '§5 七种失败原因都有中文说法', miss.length ? miss.join(',') : SD.reasonText('point-on-taskbar'));
  const ob = await SD.outsideSpace(5000, 3000);
  ok(ob.ok === false, '§5 越界坐标在 clickSafe 里会被前置拒绝（一次点击都不发）', JSON.stringify(ob));

  L('');
  L('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
