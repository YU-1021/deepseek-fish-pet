/* probe-win-shot.js —— ★真机验证「按窗口截图」那条路★（纯 Node，不开任何窗口 ✓）
 *
 * 跑法：node app\scripts\probe-win-shot.js [进程名，默认 Arknights]
 *
 * 【它回答三个问题，全部用真数据、不用想象】
 *   ① desktop-auto 这台 MCP server 真的起得来吗？工具真有 23 个吗？
 *   ② bot_screenshot 拿到的图，**是不是那一个窗口的图**？windowBounds 对不对？
 *   ③ ★关键诚实问题★：它到底是不是"窗口自绘"的截图？
 *      —— 用 `整屏截图按 windowBounds 裁一块` 与 `bot_screenshot` 的结果**逐像素比对**：
 *         if 几乎完全一致 → 它其实是"整屏裁窗口矩形"✗（**遮挡会被拍进去**✗）
 *         if 明显不同     → 它是窗口自绘通道 ✓（遮挡拍不进去 ✓）
 *     这个结论决定工具描述怎么写 —— ★宁可写出坏消息，也不能写错的好处✗★。
 *
 * 产物：shots/win-<进程>-<时间>.jpg、shots/win-<进程>-full.jpg、C:\deepseek\probe-winshot.json
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MCP = require('../src/mcp');
const SHOTS = path.join(__dirname, '..', '..', 'shots');
const OUT = 'C:/deepseek/probe-winshot.json';

const PROC = process.argv[2] || 'Arknights';
const log = [];
function L(s) { log.push(s); console.log(s); }

/* 两张 JPEG 的比较：Jimp 解码成位图后算"平均绝对差"与"完全相同像素占比" */
async function compare(aBuf, bBuf) {
  const { Jimp } = require('jimp');
  const A = await Jimp.fromBuffer(aBuf);
  const B = await Jimp.fromBuffer(bBuf);
  if (A.width !== B.width || A.height !== B.height) {
    return { sameSize: false, a: { w: A.width, h: A.height }, b: { w: B.width, h: B.height } };
  }
  const pa = A.bitmap.data, pb = B.bitmap.data;
  let sum = 0, n = 0, identical = 0;
  for (let i = 0; i < pa.length; i += 4) {
    const d = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
    sum += d / 3; n++;
    if (d === 0) identical++;
  }
  return { sameSize: true, w: A.width, h: A.height, meanAbsDiff: +(sum / n).toFixed(3), identicalPct: +(identical / n * 100).toFixed(2) };
}

function contentOf(res) {
  const img = ((res && res.content) || []).find((c) => c && c.type === 'image');
  const txt = ((res && res.content) || []).find((c) => c && c.type === 'text');
  let meta = null;
  try { meta = txt ? JSON.parse(txt.text) : null; } catch (e) {}
  return { img, meta, raw: res };
}

(async () => {
  try { fs.mkdirSync(SHOTS, { recursive: true }); } catch (e) {}
  const t0 = Date.now();
  MCP.configure({});
  L('=== probe-win-shot（按窗口截图 · 真机）===');
  L('服务器配置：' + JSON.stringify(MCP.servers()['desktop-auto'] && MCP.servers()['desktop-auto'].args));

  const tools = await MCP.listTools('desktop-auto');
  L('① 工具数 = ' + tools.length + '（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）');
  L('   ' + tools.map((t) => t.name).join(', '));

  /* 目标窗口边界（用来判定"到底截了哪一块"） */
  let wins = null;
  try {
    const w = contentOf(await MCP.callTool('desktop-auto', 'bot_list_windows', {}));
    let list = null;
    try { list = JSON.parse(w.raw.content[0].text); } catch (e) {}
    wins = list && (list.windows || list);
    L('② bot_list_windows 拿到 ' + (Array.isArray(wins) ? wins.length : '?') + ' 个窗口');
    if (Array.isArray(wins)) {
      const hit = wins.filter((x) => JSON.stringify(x).toLowerCase().indexOf(String(PROC).toLowerCase()) >= 0);
      L('   与「' + PROC + '」相关的：' + hit.slice(0, 5).map((x) => (x.title || x.name || '?') + ' ' + JSON.stringify(x.bounds || x.rect || '')).join(' | '));
    }
  } catch (e) { L('② bot_list_windows 失败：' + e.message); }

  const shot = contentOf(await MCP.callTool('desktop-auto', 'bot_screenshot', { processName: PROC, quality: 100, maxWidth: 4096 }));
  if (!shot.img) { L('❌ bot_screenshot 没返回图片：' + JSON.stringify(shot.raw).slice(0, 500)); }
  const buf = Buffer.from((shot.img && shot.img.data) || '', 'base64');
  const file = path.join(SHOTS, 'win-' + PROC.replace(/[^\w-]/g, '') + '-' + Date.now() + '.jpg');
  fs.writeFileSync(file, buf);
  L('③ bot_screenshot：' + JSON.stringify(shot.meta));
  L('   落盘 ' + file + '（' + Math.round(buf.length / 1024) + ' KB，mimeType=' + (shot.img && shot.img.mimeType) + '）');

  /* ④ 它是不是"整屏裁窗口矩形"？ */
  let cmp = null;
  try {
    const full = contentOf(await MCP.callTool('desktop-auto', 'bot_screenshot_fullscreen', {}));
    const fbuf = Buffer.from((full.img && full.img.data) || '', 'base64');
    const ffile = path.join(SHOTS, 'win-' + PROC.replace(/[^\w-]/g, '') + '-full.jpg');
    fs.writeFileSync(ffile, fbuf);
    L('④ 整屏图：' + JSON.stringify(full.meta) + ' → ' + ffile);
    const m = shot.meta || {};
    const wb = m.windowBounds || {};
    const { Jimp } = require('jimp');
    const F = await Jimp.fromBuffer(fbuf);
    const fscale = F.width / (full.meta && full.meta.width ? full.meta.width : F.width);
    const crop = F.clone().crop({
      x: Math.max(0, Math.round(wb.x * fscale)), y: Math.max(0, Math.round(wb.y * fscale)),
      w: Math.round(wb.width * fscale), h: Math.round(wb.height * fscale),
    });
    crop.resize({ w: (shot.meta && shot.meta.width) || crop.width, h: (shot.meta && shot.meta.height) || crop.height });
    cmp = await compare(buf, await crop.getBuffer('image/jpeg', { quality: 100 }));
    cmp = Object.assign({ cropFrom: { x: wb.x, y: wb.y, w: wb.width, h: wb.height }, fullSize: { w: F.width, h: F.height } }, cmp);
    L('   ★判定★ 窗口图 vs 整屏裁同一矩形：' + JSON.stringify(cmp));
    L(cmp.sameSize && cmp.meanAbsDiff < 3
      ? '   → ★结论：它其实就是【整屏截图 + 按窗口矩形裁】✗ —— 遮挡会被拍进去 ✗★'
      : '   → ★结论：它与整屏裁的那一块明显不同 ✓ —— 更像是窗口自绘通道 ✓★');
  } catch (e) { L('④ 比对失败：' + e.message); }

  fs.writeFileSync(OUT, JSON.stringify({ proc: PROC, tools: tools.map((t) => t.name), meta: shot.meta, compare: cmp, log }, null, 2), 'utf8');
  L('写出 ' + OUT);
  MCP.stopAll();
  process.exit(0);
})().catch((e) => { console.log('❌ 探针崩了：' + (e && e.stack || e)); try { fs.writeFileSync(OUT, JSON.stringify({ error: String(e), log }, null, 2)); } catch (e2) {} process.exit(1); });
