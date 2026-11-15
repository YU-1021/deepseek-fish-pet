/* run.js —— ★假游戏测试跑分器（用她的工具链跑 ✓ 不是人手点 ✓）★
 *
 * 流程（每个用例）：自查前台 = DSH-GameTest（不是就等/中止 ✓）→ 抓帧 → OCR → locate/lact 定位 →
 *   act 点击（★点击前再查一次前台✗★）→ 由 window 自己写的 clicks.jsonl 判定**实际被点到的是谁** ✓
 * 判定严：★必须正好落在目标按钮上才算过★；点到别的按钮/空白/"没找到"都算不过 ✓
 *
 * 用法：node app\scripts\gametest\run.js [--per=2] [--kinds=text,dup,small,edge,icon]
 * 落盘：C:\deepseek\gametest\results.jsonl + summary.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const LAY = require('./layout');
const PE = require('../../src/percept');

const APP = 'C:/deepseek/desktop-pet/app';
const BAK = 'C:/Users/64616/Documents/Codex/2026-10-02/electron-ai-agent-c-deepseek-desktop/work/desktop-pet/app/node_modules/electron/dist/electron.exe';
const OUT = 'C:/deepseek/gametest';
const CLICKS = path.join(OUT, 'clicks.jsonl');
const SCALE = 1.25;   // ★本机 125%：DIP × 1.25 = 物理 ✓（窗口坐标=物理 ✓，而截图是 DIP ✗ → 换算由脚本做 ✓）★

const argv = process.argv.slice(2);
const getArg = (k, d) => { const m = argv.find((a) => a.startsWith('--' + k + '=')); return m ? m.split('=')[1] : d; };
const PER = Number(getArg('per', 2));
const KINDS = String(getArg('kinds', 'text,dup,small,edge,icon')).split(',');

function sh(cmd, args) { return spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true }); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ①+② 一帧 = 抓帧 + OCR（★全部在 PowerShell 里一步做完✗→✓★ —— Node 在这台机器上既不能抓子进程
   stdout（EPERM ✗）也不能可靠 spawn Electron（实测"没有文件" ✗）；PowerShell 的 Start-Process + 等待 + OCR
   是通的 ✓。离线自证 ✓：1920x1080 帧读出 64 行 / 144 词 = 预期 ✓） */
function roundFrame(tag) {
  const png = path.join(OUT, 'live-phys-' + tag + '.png');
  const json = path.join(OUT, 'ocr-' + tag + '.json');
  sh('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(APP, 'scripts/gametest/shoot-ocr.ps1'), '-Png', png, '-Out', json,
    '-Capture', '1', '-Electron', BAK]);
  if (!fs.existsSync(png)) throw new Error('抓帧失败（PowerShell 里也没拿到文件 ✗）');
  if (!fs.existsSync(json)) throw new Error('OCR 没写出文件（管道不通 ✗）');
  return { png, ocr: JSON.parse(fs.readFileSync(json, 'utf8').replace(/^\uFEFF/, '')) };
}
function shoot() { return roundFrame(String(Date.now())).png; }
/* ② OCR（★lead 给的可用写法：整个 OCR 在 PowerShell 里一步做完，Node 只读文件✗→✓★）
   踩过的坑（我全踩过 ✗）：`| Out-File -Encoding utf8` 会带 BOM/可能变 UTF-16 ✗；`>` 重定向写出过 0 字节 ✗；
   从 Node 里 spawn 抓子进程 stdout 被沙箱挡（EPERM ✗）。→ 改调 scripts/gametest/shoot-ocr.ps1 ✓
   （内部 `& ocr.ps1 … | Out-String` + `[IO.File]::WriteAllText(…, UTF8Encoding($false))` ✓），Node 只 parse ✓。
   ★离线自证✓★：同一张物理帧（1920x1080）读出 64 行 / **144 词 = 预期 144 ✓**。 */
function ocrOf(png, outJson) {
  sh('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(APP, 'scripts/gametest/shoot-ocr.ps1'), '-Png', png, '-Out', outJson]);
  if (!fs.existsSync(outJson)) throw new Error('OCR 没写出文件（管道不通 ✗）');
  return JSON.parse(fs.readFileSync(outJson, 'utf8').replace(/^\uFEFF/, ''));
}
/* ③ 前台自查（★点之前必查✗★） */
function foreground() {
  const r = spawnSync('node', ['-e', "require('" + APP + "/src/focuswin').foreground().then(f=>console.log(f.title))"], { encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').trim();
}
/* ④ 点击（Electron 子进程 ✓ 一次一个动作 ✓） */
function clickAt(x, y) { sh(BAK, [path.join(APP, 'scripts/probe-act.js'), '--', 'click=' + Math.round(x) + ',' + Math.round(y)]); }
function clickCount() { try { return fs.readFileSync(CLICKS, 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; } }
function lastClick() { try { const l = fs.readFileSync(CLICKS, 'utf8').split('\n').filter(Boolean); return l.length ? JSON.parse(l[l.length - 1]) : null; } catch (e) { return null; } }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  const targets = LAY.buttons.filter((b) => KINDS.indexOf(b.kind) >= 0);
  console.log('=== gametest 跑分：' + targets.length + ' 个目标 × 每个 ' + PER + ' 次　（前台自查每次点击前 ✓）===');

  /* 每轮先抓一帧 + OCR 一次（同一帧上跑所有目标 ✓ 省时间 ✓） */
  for (let round = 0; round < PER; round++) {
    const fg0 = foreground();
    if (fg0 !== LAY.title) { console.log('★前台不是测试窗（' + fg0 + '）→ 中止本轮 ✗（不点别的窗口 ✓）'); break; }
    const png = shoot();
    const ocr = ocrOf(png, path.join(OUT, 'ocr-round' + round + '.json'));
    PE.install({
      capture: async () => ({ path: png }),
      ocrJson: async () => ocr,
      act: async (kind, x, y) => { clickAt(x, y); },
      vision: async () => '（不参与）',
      space: () => ({ w: 1920, h: 1080 }),
      display: () => ({ w: 1920, h: 1080, scaleFactor: 1.25 }),
      shotDir: () => OUT,
    });
    for (const t of targets) {
      const label = t.label || '';
      const before = clickCount();
      let hit = false, note = '', cx = null, cy = null;
      try {
        /* ★不再换算：抓帧已是物理 1920x1080 ✓ = 布局空间 ✓★（第一版这里除以 1.25 → 0/42 ✗） */
        const rq = [t.x, t.y, t.w, t.h].map((v) => Math.round(v));
        const loc = await PE.run('locate', label + '||img=' + png + '|region=' + rq.join(','));
        const m = /★编号 (L\d+)★/.exec(loc);
        if (!m) { note = /ambiguous/.test(loc) ? 'ambiguous' : 'not-found'; }
        else {
          const fg1 = foreground();
          if (fg1 !== LAY.title) { note = '前台变了(' + fg1 + ')'; }
          else {
            const a = await PE.run('act', m[1] + '|click|img=' + png);
            const mm = /目标「[^」]*」中心 \((-?\d+),(-?\d+)\)/.exec(a);
            if (mm) { cx = Number(mm[1]); cy = Number(mm[2]); }
            note = /★闸门拒绝✗★|不接受裸坐标/.test(a) ? 'gated' : (/verified = ★true/.test(a) ? 'verified' : 'clicked-unverified');
          }
        }
      } catch (e) { note = 'err:' + String(e.message).slice(0, 40); }
      await sleep(220);
      const after = clickCount();
      const lc = lastClick();
      hit = after > before && !!lc && lc.id === t.id;
      const actual = after > before ? (lc && lc.id) : null;
      results.push({ round, target: t.id, kind: t.kind, label, truth: { x: t.x + Math.round(t.w / 2), y: t.y + Math.round(t.h / 2) }, clicked: { x: cx, y: cy }, actualButton: actual, hit, note });
      if (!hit && after > before) { try { fs.copyFileSync(png, path.join(OUT, 'fail-' + t.id + '-r' + round + '.png')); } catch (e) {} }
    }
    console.log('  第 ' + (round + 1) + ' 轮完成（累计 ' + results.length + ' 用例）');
  }

  fs.writeFileSync(path.join(OUT, 'results.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const byKind = {};
  for (const r of results) { byKind[r.kind] = byKind[r.kind] || { n: 0, hit: 0 }; byKind[r.kind].n++; if (r.hit) byKind[r.kind].hit++; }
  const errs = results.filter((r) => r.hit && r.clicked.x != null).map((r) => Math.hypot(r.clicked.x - r.truth.x, r.clicked.y - r.truth.y)).sort((a, b) => a - b);
  const summary = {
    at: new Date().toISOString(), per: PER, kinds: KINDS,
    total: results.length, hit: results.filter((r) => r.hit).length,
    rate: results.length ? results.filter((r) => r.hit).length / results.length : 0,
    byKind: Object.keys(byKind).map((k) => ({ kind: k, n: byKind[k].n, hit: byKind[k].hit, rate: byKind[k].n ? byKind[k].hit / byKind[k].n : 0 })),
    centerErr: errs.length ? { n: errs.length, mean: errs.reduce((a, b) => a + b, 0) / errs.length, p95: errs[Math.floor(errs.length * 0.95)], max: errs[errs.length - 1] } : null,
    falseSuccess: results.filter((r) => /verified/.test(r.note) && !r.hit).length,
    notes: results.reduce((acc, r) => { acc[r.note] = (acc[r.note] || 0) + 1; return acc; }, {}),
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('');
  console.log('总通过 ' + summary.hit + '/' + summary.total + ' = ' + (summary.rate * 100).toFixed(1) + '%');
  for (const k of summary.byKind) console.log('  ' + k.kind.padEnd(6) + k.hit + '/' + k.n + ' = ' + (k.rate * 100).toFixed(1) + '%');
  if (summary.centerErr) console.log('中心误差：平均 ' + summary.centerErr.mean.toFixed(1) + 'px / p95 ' + summary.centerErr.p95.toFixed(1) + 'px / 最大 ' + summary.centerErr.max.toFixed(1) + 'px');
  console.log('★假成功次数（报了 verified 但窗口没记录到点击）= ' + summary.falseSuccess + '★');
  console.log('判定分布：' + JSON.stringify(summary.notes));
  process.exit(0);
})().catch((e) => { console.log('❌ 跑分器崩了：' + (e && e.stack || e)); process.exit(1); });
