/* probe-spacecheck-node.js —— ★坐标系实测（纯 Node，不需要 Electron）★
 *
 * 为什么用纯 Node：2026-10-11 本会话的沙箱里，**Electron 子进程起不来**
 *   （piped stdio 被拦：focuswin/ocr 都返回空、input.exe 也无效）✗，
 *   而**纯 Node 的 spawnSync 是好的** ✓（focuswin 列窗口、.NET 抓屏、input.exe 都能跑）。
 *
 * 跑法：
 *   cd C:\deepseek\desktop-pet\app
 *   node scripts\probe-spacecheck-node.js
 *
 * 它量三件事（★只移动光标、不点击任何东西★）：
 *   ① 注入 space() 坐标 → 用 **DPI 感知的 GetCursorPos**（focuswin）读回物理像素
 *      · 靶子含 (1860,662)：x>1536 → DIP 空间里根本不存在这个值，一旦读到它就不可能是 DIP ✓
 *   ② 抓一帧（.NET CopyFromScreen，DPI 感知 → 物理像素）→ OCR → 坐标是哪一套空间？
 *      · 判据：任务栏那一条（y≈1020~1080）的文字。物理屏才有 y>1000；DIP 屏只有 864 高 ✓
 *   ③ uia_find 报的窗口矩形 vs focuswin（DPI 感知）→ 比值是不是 1.0000
 * 结果同时写 C:\deepseek\probe-spacecheck-node.out.txt
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const APP = __dirname + path.sep + '..';
const OUT = 'C:/deepseek/probe-spacecheck-node.out.txt';
const TMPDIR = 'C:/deepseek/tmp-spacecheck';
fs.mkdirSync(TMPDIR, { recursive: true });
const out = [];
function L(s) { out.push(String(s)); try { fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8'); } catch (e) {} try { process.stdout.write(String(s) + '\n'); } catch (e) {} }
function info(t, x) { L('  [INFO] ' + t + (x ? '   ' + x : '')); }
let pass = 0, fail = 0;
function ok(c, label, extra) { if (c) { pass++; L('  [PASS] ' + label + (extra ? '   ' + extra : '')); } else { fail++; L('  [FAIL] ' + label + (extra ? '   ' + extra : '')); } }
const fw = require(path.join(APP, 'src', 'focuswin'));
const uia = require(path.join(APP, 'src', 'uia'));
const INPUT_EXE = path.join(APP, 'vendor', 'input', 'input.exe');
const SPACE = { w: 1920, h: 1080 };
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { const t = Date.now(); while (Date.now() - t < ms) {} } };

/* input.js 的 norm() + run() 语义：0..1 交给 input.exe（一次性 spawn，和 PET_INPUT_ONESHOT=1 同一条） */
function injectMove(x, y) {
  const fx = (Math.max(0, Math.min(SPACE.w, x)) / SPACE.w).toFixed(4);
  const fy = (Math.max(0, Math.min(SPACE.h, y)) / SPACE.h).toFixed(4);
  const r = spawnSync(INPUT_EXE, ['move', fx, fy], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  return { fx, fy, status: r.status, err: r.error ? String(r.error.message) : '', stderr: String(r.stderr || '').trim() };
}
/* 纯 Node 抓屏：PS 里**声明 DPI 感知**后 CopyFromScreen → 物理像素 ✓ */
function grabPhysicalPng() {
  const p = path.join(TMPDIR, 'grab-' + Date.now() + '.png').replace(/\\/g, '/');
  const ps = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
    + 'Add-Type -AssemblyName System.Drawing,System.Windows.Forms;'
    + 'try{[Win]::SetProcessDpiAwarenessContext }catch{};'
    + 'Add-Type -TypeDefinition @"\nusing System;using System.Runtime.InteropServices;public class D{[DllImport(\"user32.dll\")]public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr c);}\n"@;'
    + '[D]::SetProcessDpiAwarenessContext([IntPtr](-4))|Out-Null;'
    + '$b=New-Object System.Drawing.Bitmap(1920,1080);$g=[System.Drawing.Graphics]::FromImage($b);'
    + '$g.CopyFromScreen(0,0,0,0,(New-Object System.Drawing.Size(1920,1080)));'
    + '$b.Save(' + JSON.stringify(p) + ',[System.Drawing.Imaging.ImageFormat]::Png);'
    + 'Write-Output ("SAVED " + ' + JSON.stringify(p) + ')';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 40000, windowsHide: true });
  if (!fs.existsSync(p)) return { ok: false, err: String((r.stderr || '').slice(0, 200)) || 'no-file' };
  return { ok: true, path: p, bytes: fs.statSync(p).size };
}
function ocrJson(png) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(APP, 'scripts', 'ocr.ps1'), '-Path', png, '-Json'], { encoding: 'utf8', timeout: 40000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const s = String(r.stdout || '');
  const i = s.indexOf('{');
  if (i < 0) return { ok: false, err: String((r.stderr || '').slice(0, 200)) || 'no-json' };
  try { return JSON.parse(s.slice(i)); } catch (e) { return { ok: false, err: String(e.message) }; }
}

(async () => {
  L('=== probe-spacecheck-node（坐标系实测：注入 / OCR / UIA）===');
  /* 起点信息：DPI 从 focuswin 拿（那段 PS 声明了 PER_MONITOR_AWARE_V2 → 物理像素） */
  const l0 = await fw.listWindows();
  info('focuswin: ok=' + l0.ok + ' DPI=' + l0.dpi + ' → scale=' + l0.scale + '（120/96=1.25）');
  const game = (l0.windows || []).find((w) => w.title === '明日方舟');
  info('物理屏（由一个全屏窗口实测）: ' + (game ? (game.w + 'x' + game.h + '  @' + game.x + ',' + game.y) : '没找到全屏窗口'));
  info('input.space()（她的坐标空间）= 1920x1080；DIP（Electron 报的）应该是 1536x864');
  const orig = await fw.cursorPos();
  info('光标原位（物理）: ' + (orig ? orig.x + ',' + orig.y : '读不到'));

  /* ---------------- §1 注入 → 物理读回 ---------------- */
  L('');
  L('§1 ★注入 space() 坐标 → 用 DPI 感知的 GetCursorPos 读回（物理像素）★');
  const pts = [[300, 200], [960, 540], [1600, 900], [1860, 662], [1700, 1020]];
  for (const [x, y] of pts) {
    const inj = injectMove(x, y);
    sleep(320);
    const p = await fw.cursorPos();
    const dx = p ? Math.abs(p.x - x) : null, dy = p ? Math.abs(p.y - y) : null;
    L('  注入 ' + x + ',' + y + '（归一化 ' + inj.fx + ',' + inj.fy + '，exe status=' + inj.status + '）'
      + ' → 物理读回 ' + (p ? p.x + ',' + p.y : '读不到') + '  Δ' + dx + '/' + dy);
    ok(!!p && dx <= 3 && dy <= 3, '§1 注入值的语义 = space()（物理像素）', 'Δ' + dx + '/' + dy);
  }
  const hard = await (async () => { injectMove(1860, 662); sleep(320); return fw.cursorPos(); })();
  ok(!!hard && Math.abs(hard.x - 1860) <= 3, '§1 ★x=1860 > 1536（DIP 宽度）也真的落在那里 → 注入不可能是 DIP 语义★',
    hard ? ('读回 ' + hard.x + ',' + hard.y) : '读不到');

  /* ---------------- §2 OCR 的空间 ---------------- */
  L('');
  L('§2 ★.NET 抓一帧（DPI 感知 → 物理像素）→ OCR → 它的坐标在哪一套空间里？★');
  const g = grabPhysicalPng();
  if (!g.ok) { ok(false, '§2 抓帧失败', g.err); }
  else {
    info('抓到 ' + g.path + '（' + Math.round(g.bytes / 1024) + ' KB）');
    const j = ocrJson(g.path);
    if (!j || !j.ok) { ok(false, '§2 OCR 失败', JSON.stringify(j && j.err)); }
    else {
      info('OCR JSON：imgW=' + j.imgW + ' imgH=' + j.imgH + ' 行数=' + (j.lines || []).length);
      ok(j.imgW === SPACE.w && j.imgH === SPACE.h, '§2 ★包围盒基于 1920x1080 的图 = space()★', j.imgW + 'x' + j.imgH);
      const words = [];
      for (const line of (j.lines || [])) for (const w of (line.words || [])) words.push(w);
      const tb = words.filter((w) => w.y > 1000);
      info('y>1000（任务栏那一条）上的词 ' + tb.length + ' 个：' + tb.slice(0, 8).map((w) => w.t + '(' + w.x + ',' + w.y + ')').join(' '));
      ok(tb.length > 0, '§2 ★OCR 读到了 y>1000 的任务栏文字 → 它是物理像素（DIP 屏只有 864 高）★',
        tb.length ? ('例：' + tb[0].t + ' @' + tb[0].x + ',' + tb[0].y) : '一个都没有（可能任务栏没文字）');
      /* 光标本位命中（替代"真机点"）：拿 OCR 给出的中心把光标移过去，再读回物理位置比对 */
      const mid = words.filter((w) => String(w.t).length >= 2 && w.y > 150 && w.y < 900 && w.x > 150)
        .sort((a, b) => String(b.t).length - String(a.t).length)[0];
      if (!mid) ok(false, '§2 没找到可用的中部文字目标');
      else {
        const cx = Math.round(mid.x + mid.w / 2), cy = Math.round(mid.y + mid.h / 2);
        info('目标词「' + mid.t + '」框 ' + mid.x + ',' + mid.y + ' ' + mid.w + 'x' + mid.h + ' → 中心 ' + cx + ',' + cy);
        injectMove(cx, cy); sleep(320);
        const p2 = await fw.cursorPos();
        const hit = p2 && Math.abs(p2.x - cx) <= 3 && Math.abs(p2.y - cy) <= 3;
        L('  移过去 → 物理读回 ' + (p2 ? p2.x + ',' + p2.y : '读不到') + '  Δ' + (p2 ? (Math.abs(p2.x - cx) + '/' + Math.abs(p2.y - cy)) : '-'));
        ok(hit, '§2 ★"用 OCR 坐标移过去"命中（替代法：读回光标与目标逐像素比对）★', hit ? 'Δ≤3px' : '没命中');
      }
    }
  }

  /* ---------------- §3 UIA 的空间 ---------------- */
  L('');
  L('§3 ★uia_find 报的矩形 vs DPI 感知枚举（focuswin）★');
  let n = 0;
  for (const name of ['明日方舟', 'DeepSeek Harness', 'Clash for Windows']) {
    const u = await uia.findElement(name, '');
    const w = (l0.windows || []).filter((x) => x.title.indexOf(name) >= 0).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (!u.window || !w) { info(name + '：UIA ' + (u.window ? '有' : '无') + ' / 窗口 ' + (w ? '有' : '无') + '（跳过）'); continue; }
    const rx = w.w / u.window.w, ry = w.h / u.window.h;
    info(name + '：UIA ' + u.window.x + ',' + u.window.y + ' ' + u.window.w + 'x' + u.window.h
      + '   focuswin(物理) ' + w.x + ',' + w.y + ' ' + w.w + 'x' + w.h + '   比值 ' + rx.toFixed(4) + '/' + ry.toFixed(4));
    ok(Math.abs(rx - 1) < 0.01 && Math.abs(ry - 1) < 0.01, '§3 UIA 矩形 = 物理像素（不是 DIP）', rx.toFixed(3));
    n++;
  }
  if (!n) ok(false, '§3 没找到可比对的窗口');

  if (orig) { injectMove(orig.x, orig.y); }
  L('');
  L('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
