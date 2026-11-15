/* diag-capture.js —— ★活帧"抓帧→OCR"诊断（lead 的四项数字）★
 * ① 抓一帧存 PNG，量实际尺寸 ② OCR 它能读出几个词 ③ 文字区域高频能量（锐度代理）④ 三种修法效果
 * 修法：A) 抓帧按**物理尺寸**（thumbnailSize = DIP×scaleFactor）B) 抓完先锐化/重采样再 OCR C) 窗口按物理渲染（本脚本只测 A/B）
 * 跑法：node app\scripts\gametest\diag-capture.js      （测试窗需在前台 ✓）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const OUT = 'C:/deepseek/gametest/diag';
const APP = 'C:/deepseek/desktop-pet/app';
const BAK = 'C:/Users/64616/Documents/Codex/2026-10-02/electron-ai-agent-c-deepseek-desktop/work/desktop-pet/app/node_modules/electron/dist/electron.exe';
fs.mkdirSync(OUT, { recursive: true });
function sh(c, a) { return spawnSync(c, a, { stdio: 'ignore', windowsHide: true }); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function ocrJson(png, outJson) {
  const cmd = '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); & "' + path.join(APP, 'scripts/ocr.ps1')
    + '" -Path "' + png + '" -Json | Out-File -Encoding utf8 "' + outJson + '"';
  sh('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd]);
  try { return JSON.parse(fs.readFileSync(outJson, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; }
}

(async () => {
  /* 抓帧（两种尺寸）——由 shoot2.js 按参数决定 ✓ */
  const sizes = [['dip', 1536, 864], ['physical', 1920, 1080]];
  const rows = [];
  for (const [tag, w, h] of sizes) {
    const png = path.join(OUT, 'cap-' + tag + '.png');
    sh(BAK, [path.join(APP, 'scripts/gametest/shoot2.js'), String(w), String(h), png]);
    await sleep(300);
    if (!fs.existsSync(png)) { rows.push({ tag, err: '抓帧失败' }); continue; }
    const buf = fs.readFileSync(png);
    const Jimp = require('jimp').Jimp;
    const img = await Jimp.fromBuffer(buf);
    const j = ocrJson(png, path.join(OUT, 'ocr-' + tag + '.json'));
    const words = (j && j.lines || []).reduce((n, L) => n + ((L.words || []).length), 0);
    const lines = (j && j.lines || []).length;
    /* 锐度代理：整图高频能量（相邻像素差的均方 ✓） */
    const d = img.bitmap.data; let hf = 0, n = 0;
    for (let y = 1; y < img.height - 1; y += 2) {
      for (let x = 1; x < img.width - 1; x += 2) {
        const p = (y * img.width + x) * 4;
        const l = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
        const lx = 0.299 * d[p + 4] + 0.587 * d[p + 5] + 0.114 * d[p + 6];
        const ly = 0.299 * d[p + img.width * 4] + 0.587 * d[p + img.width * 4 + 1] + 0.114 * d[p + img.width * 4 + 2];
        hf += Math.abs(l - lx) + Math.abs(l - ly); n += 2;
      }
    }
    rows.push({ tag, file: png, size: img.width + 'x' + img.height, bytes: buf.length, ocrLines: lines, ocrWords: words, sharpness: n ? hf / n : 0 });
  }

  /* 修法 B：把 DIP 帧锐化 + 重采样到物理尺寸后再 OCR */
  try {
    const Jimp = require('jimp').Jimp;
    const src = await Jimp.fromBuffer(fs.readFileSync(path.join(OUT, 'cap-dip.png')));
    const up = src.clone().resize({ w: 1920, h: 1080 });
    up.convolve([[0, -1, 0], [-1, 5, -1], [0, -1, 0]]);   // 简单锐化核 ✓
    const outB = path.join(OUT, 'cap-dip-sharp-up.png');
    fs.writeFileSync(outB, await up.getBuffer('image/png'));
    const j = ocrJson(outB, path.join(OUT, 'ocr-dip-sharp-up.json'));
    const words = (j && j.lines || []).reduce((n, L) => n + ((L.words || []).length), 0);
    rows.push({ tag: 'B:dip→锐化+放大到1920', file: outB, size: '1920x1080', ocrLines: (j && j.lines || []).length, ocrWords: words, sharpness: null });
  } catch (e) { rows.push({ tag: 'B', err: String(e.message).slice(0, 60) }); }

  console.log('=== 活帧抓帧→OCR 诊断 ===');
  for (const r of rows) console.log('  ' + JSON.stringify(r));
  fs.writeFileSync(path.join(OUT, 'diag.json'), JSON.stringify(rows, null, 2));
})().catch((e) => { console.log('ERR ' + (e && e.stack || e)); process.exit(1); });
