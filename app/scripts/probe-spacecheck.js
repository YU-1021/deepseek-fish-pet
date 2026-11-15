/* probe-spacecheck.js —— ★量清楚"她的坐标系"：注入是不是 space()（物理像素），读回是什么★
 *
 * 跑法（在桌宠空闲时；先清 ELECTRON_RUN_AS_NODE）：
 *   cd C:\deepseek\desktop-pet\app
 *   node_modules\electron\dist\electron.exe app\scripts\probe-spacecheck.js
 *
 * 它只做两件事：**移动光标** + **读回光标**（★不点击任何东西★），
 * 以及抓一帧跑 OCR（只读）。跑完把光标放回原位、不建可见窗口、立刻退出。
 *
 * 判据（为什么这样就能定论）：
 *   · 注入点用 space() 坐标（默认 1920x1080）；读回用 focuswin.cursorPos()（那条 PS **声明了
 *     DPI 感知** → 物理像素材质）✓ 以及 Electron 的 screen.getCursorScreenPoint()（DIP）。
 *   · 若"物理读回 ≈ 注入值" → 注入的坐标语义就是 **space()=物理像素** ✓（动作类的期望就是它）
 *   · 若"物理读回 ≈ 注入值×1.25、DIP 读回 ≈ 注入值" → 注入被当成 DIP 处理 = 20~25% 系统性偏移 ✗
 *   · 取 x>1536 或 y>864 的点当靶子：那两个值在 DIP 空间里根本不存在，
 *     一旦读回真的落在那里，就★不可能是 DIP 语义★（这一条最硬 ✓）
 *
 * 结果同时写 C:\deepseek\probe-spacecheck.out.txt
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, screen } = require('electron');

const REAL = path.join(process.env.APPDATA, 'dayu-pet');
/* ⚠️ 2026-10-11：本会话的文件沙箱**不再允许写 %APPDATA%**（实测 EPERM mkdir）→
   探针的临时 userData 放进工作区里（C:\deepseek\...）✓；只**读**真 config ✓ */
const TMP = 'C:/deepseek/tmp-spacecheck';
fs.mkdirSync(TMP, { recursive: true });
try { fs.copyFileSync(path.join(REAL, 'config.json'), path.join(TMP, 'config.json')); } catch (e) {}
app.setPath('userData', TMP);
app.on('window-all-closed', function () { });

const out = [];
const OUTF = 'C:/deepseek/probe-spacecheck.out.txt';
/* ★每行都落盘★：Electron 是 GUI 子系统，崩了 stdout 会丢；上一次就是这么"一行都没有"✗ */
function L(s) { out.push(String(s)); try { fs.writeFileSync(OUTF, out.join('\n') + '\n', 'utf8'); } catch (e) {} try { process.stdout.write(String(s) + '\n'); } catch (e) {} }
let pass = 0, fail = 0;
function ok(c, label, extra) {
  if (c) { pass++; L('  [PASS] ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; L('  [FAIL] ' + label + (extra ? '   ' + extra : '')); }
}
function info(t, x2) { L('  [INFO] ' + t + (x2 ? '   ' + x2 : '')); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* OCR（和生产同一条：scripts/ocr.ps1 -Json） */
function ocrJson(pngPath) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, '..', 'scripts', 'ocr.ps1');
    let child, done = false, o = '';
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try { child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', pngPath, '-Json'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return fin(null); }
    const t = setTimeout(() => { try { child.kill(); } catch (e) {} fin(null); }, 30000);
    child.stdout.on('data', (d) => { o += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(t); fin(null); });
    child.on('close', () => {
      clearTimeout(t);
      const i = o.indexOf('{');
      if (i < 0) return fin(null);
      try { fin(JSON.parse(o.slice(i))); } catch (e) { fin(null); }
    });
  });
}

async function main() {
  const input = require(path.join(__dirname, '..', 'src', 'input'));
  const fw = require(path.join(__dirname, '..', 'src', 'focuswin'));
  const assistant = require(path.join(__dirname, '..', 'src', 'assistant'));
  const space = input.space();
  const d = screen.getPrimaryDisplay();

  L('=== probe-spacecheck（坐标系：注入 / OCR / UIA）===');
  info('Electron 显示器(DIP)：' + d.size.width + 'x' + d.size.height + '  scaleFactor=' + d.scaleFactor
    + '  工作区 ' + d.workAreaSize.width + 'x' + d.workAreaSize.height);
  info('input.space()（她的坐标空间）：' + space.w + 'x' + space.h + '   物理屏 = DIP×scale = '
    + Math.round(d.size.width * d.scaleFactor) + 'x' + Math.round(d.size.height * d.scaleFactor));
  const orig = screen.getCursorScreenPoint();
  info('光标原位（DIP）：' + orig.x + ',' + orig.y);

  /* ---------------- §1 注入 → 两套尺子读回 ---------------- */
  L('');
  L('§1 注入 space() 坐标 → 读回（★只看光标位置，不点击★）');
  /* (1860,662) x>1536、(1600,900) y>864 —— 这两点在 DIP 空间里不存在，最硬 ✓ */
  const pts = [[300, 200], [960, 540], [1600, 900], [1860, 662], [1700, 1020]];
  for (const [x, y] of pts) {
    await input.move(x, y);
    await wait(320);
    const dip = screen.getCursorScreenPoint();
    let phys = null;
    try { phys = await fw.cursorPos(); } catch (e) { phys = null; }
    const dx = phys ? Math.abs(phys.x - x) : null, dy = phys ? Math.abs(phys.y - y) : null;
    const ddx = Math.abs(dip.x - x), ddy = Math.abs(dip.y - y);
    L('  注入 ' + x + ',' + y + '  →  物理读回 ' + (phys ? (phys.x + ',' + phys.y) : '读不到')
      + ' (Δ' + dx + '/' + dy + ')' + '   DIP 读回 ' + dip.x + ',' + dip.y + ' (Δ' + ddx + '/' + ddy + ')');
    ok(phys && dx <= 3 && dy <= 3, '§1 ★物理读回 ≈ 注入值 → 动作类要的就是 space()（物理像素）★', 'Δ' + dx + '/' + dy);
  }

  /* ---------------- §2 OCR 的空间 + 光标本位命中 ---------------- */
  L('');
  L('§2 抓一帧（生产同一条回退路径）+ OCR → 坐标在哪一套空间里？');
  const cap = await assistant.__captureFallbackForTest();
  info('抓帧：' + cap.width + 'x' + cap.height + '  文件 ' + cap.path);
  ok(cap.width === space.w && cap.height === space.h, '§2 ★抓帧尺寸 = space()（1920x1080）★', cap.width + 'x' + cap.height);
  const ocr = await ocrJson(cap.path);
  if (!ocr || !ocr.ok) {
    ok(false, '§2 OCR 跑失败了', JSON.stringify(ocr && ocr.ok));
  } else {
    info('OCR JSON：imgW=' + ocr.imgW + ' imgH=' + ocr.imgH + ' 行数=' + (ocr.lines || []).length);
    ok(ocr.imgW === space.w && ocr.imgH === space.h, '§2 ★OCR 的包围盒基于 1920x1080 的图 = space()★', ocr.imgW + 'x' + ocr.imgH);
    /* 任务栏那一条（y>1000）：DIP 空间里屏幕只有 864 高 → 那里的字不可能出现在 y>1000 的 DIP 坐标上 */
    const words = [];
    for (const line of (ocr.lines || [])) for (const w of (line.words || [])) words.push(w);
    const taskbarWords = words.filter((w) => w.y > 1000);
    info('y>1000（任务栏那一条）上的词 ' + taskbarWords.length + ' 个：'
      + taskbarWords.slice(0, 6).map((w) => w.t + '(' + w.x + ',' + w.y + ')').join(' '));
    ok(taskbarWords.length > 0 && taskbarWords.every((w) => w.y <= space.h + 4),
      '§2 ★OCR 读到了 y>1000 的任务栏文字 → 它是**物理像素**（DIP 屏只有 864 高，不可能）★',
      taskbarWords.length ? ('例：' + taskbarWords[0].t + ' @' + taskbarWords[0].x + ',' + taskbarWords[0].y) : '一个都没有');
    /* 拿一个屏幕中部、长度>=2 的词做"光标本位"命中测试 */
    const mid = words.filter((w) => String(w.t).length >= 2 && w.y > 120 && w.y < 900 && w.x > 120).sort((a, b) => String(b.t).length - String(a.t).length)[0];
    if (!mid) {
      ok(false, '§2 没找到可用的中部文字目标（换一次抓帧可能就有）');
    } else {
      const cx = Math.round(mid.x + mid.w / 2), cy = Math.round(mid.y + mid.h / 2);
      info('目标词「' + mid.t + '」包围盒 ' + mid.x + ',' + mid.y + ' ' + mid.w + 'x' + mid.h + ' → 中心 ' + cx + ',' + cy);
      await input.move(cx, cy);
      await wait(320);
      const p2 = await fw.cursorPos();
      const hit = p2 ? (Math.abs(p2.x - cx) <= 3 && Math.abs(p2.y - cy) <= 3) : false;
      L('  移动到这个 OCR 中心 → 物理读回 ' + (p2 ? (p2.x + ',' + p2.y) : '读不到')
        + '  Δ' + (p2 ? (Math.abs(p2.x - cx) + '/' + Math.abs(p2.y - cy)) : '-'));
      ok(hit, '§2 ★"用 OCR 坐标移过去"命中（替代法：读回光标与目标逐像素比对）★', hit ? ('Δ≤3px，目标 ' + cx + ',' + cy) : '没命中');
      /* 顺便验 find_text 这条工具链（不是我自己的 OCR） */
      const rep = await assistant.run('find_text', String(mid.t));
      const m = String(rep).match(/\((-?\d+)\s*,\s*(-?\d+)\)/);
      if (m) {
        const fx = Number(m[1]), fy = Number(m[2]);
        info('find_text|' + mid.t + ' → ' + fx + ',' + fy + '（我独立 OCR 的中心 ' + cx + ',' + cy + '，Δ'
          + Math.abs(fx - cx) + '/' + Math.abs(fy - cy) + '）');
        ok(Math.abs(fx - cx) <= 12 && Math.abs(fy - cy) <= 12, '§2 ★find_text 与独立 OCR 指同一个点（同一套空间）★',
          'Δ' + Math.abs(fx - cx) + '/' + Math.abs(fy - cy));
      } else {
        info('find_text 回执没解析出坐标：' + String(rep).slice(0, 90));
      }
    }
  }

  /* ---------------- §3 UIA 的空间 ---------------- */
  L('');
  L('§3 uia_find 报的矩形 vs DPI 感知枚举（focuswin）');
  const lw = await fw.listWindows();
  const uia = require(path.join(__dirname, '..', 'src', 'uia'));
  let checked = 0;
  for (const name of ['明日方舟', 'DeepSeek Harness', 'Clash for Windows']) {
    const u = await uia.findElement(name, '');
    const w = lw.windows.filter((x) => x.title.indexOf(name) >= 0).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (!u.window || !w) { info('  ' + name + '：UIA ' + (u.window ? '有' : '无') + ' / 窗口 ' + (w ? '有' : '无') + '（跳过）'); continue; }
    const rx = (w.w / u.window.w), ry = (w.h / u.window.h);
    info('  ' + name + '：UIA ' + u.window.x + ',' + u.window.y + ' ' + u.window.w + 'x' + u.window.h
      + '   focuswin(物理) ' + w.x + ',' + w.y + ' ' + w.w + 'x' + w.h + '   比值 ' + rx.toFixed(4) + '/' + ry.toFixed(4));
    ok(Math.abs(rx - 1) < 0.01 && Math.abs(ry - 1) < 0.01, '§3 ★UIA 矩形 = 物理像素（不是 DIP，没差 1.25）★', rx.toFixed(3) + 'x');
    checked++;
  }
  if (!checked) ok(false, '§3 没找到可比对的窗口');

  /* ---------------- 收尾：把光标放回原位 ---------------- */
  try { await input.move(Math.round(orig.x * (d.scaleFactor || 1)), Math.round(orig.y * (d.scaleFactor || 1))); } catch (e) {}
  L('');
  L('通过 ' + pass + ' / ' + (pass + fail));
  try { fs.writeFileSync('C:/deepseek/probe-spacecheck.out.txt', out.join('\n'), 'utf8'); } catch (e) {}
  process.exit(fail ? 1 : 0);
}

app.whenReady().then(() => {
  main().catch((e) => {
    L('探针崩了：' + ((e && e.stack) || e));
    try { fs.writeFileSync('C:/deepseek/probe-spacecheck.out.txt', out.join('\n'), 'utf8'); } catch (e2) {}
    process.exit(2);
  });
});
