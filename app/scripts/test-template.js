/* 模板匹配的**应用层**集成测试：走真实模块（src/matcher.js + vendor/match/match.exe）
 *
 * 用 nativeImage.createFromBitmap() 造合成 BGRA 图 —— 不需要真屏幕、不依赖游戏，
 * 但验证的是真实代码路径：存模板 → 读原始 BGRA → 写临时帧 → 调 match.exe → 解析 → 换算坐标。
 *
 * 跑法：electron.exe app\scripts\test-template.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, nativeImage } = require('electron');

/* 隔离 userData（和别的测试一样，绝不碰主人的真实配置/模板） */
const T = path.join(process.env.APPDATA, 'dayu-pet-tpltest');
fs.mkdirSync(T, { recursive: true });
app.setPath('userData', T);

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFrame(w, h) {
  const b = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const v = (Math.random() * 40 + 100) | 0;
      b[p] = v; b[p + 1] = v; b[p + 2] = v; b[p + 3] = 255;
    }
  }
  return b;
}
function stamp(b, w, x0, y0, tw, th) {
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const p = ((y0 + y) * w + (x0 + x)) * 4;
      const v = ((x * 13 + y * 29) % 200) + 20;
      b[p] = v; b[p + 1] = v; b[p + 2] = v; b[p + 3] = 255;
    }
  }
}
function toDataUrl(buf, w, h) {
  return nativeImage.createFromBitmap(buf, { width: w, height: h }).toDataURL();
}

app.whenReady().then(async () => {
  console.log('=== 模板匹配集成测试 ===');
  const M = require('../src/matcher');
  /* 清理模板目录：这个测试的 userData 是复用的，上次运行残留的模板会让 §6 计数对不上
     （上一版就踩了这个：列表里多出一个上轮留下的「纯色」）。 */
  {
    const d = path.join(T, 'templates');
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) { try { fs.unlinkSync(path.join(d, f)); } catch {} }
  }
  await sleep(300);

  ok(fs.existsSync(M.EXE), 'match.exe 存在', M.EXE);

  const W = 1920, H = 1080, TX = 1418, TY = 806, TW = 64, TH = 48;
  const frame = makeFrame(W, H);
  stamp(frame, W, TX, TY, TW, TH);
  const dataUrl = toDataUrl(frame, W, H);

  /* §1 存模板 */
  const sv = M.saveTemplate(app, nativeImage, '测试按钮', dataUrl, { x: TX, y: TY, w: TW, h: TH });
  ok(sv.ok, '§1 存模板成功', sv.ok ? sv.name + ' ' + sv.w + 'x' + sv.h : sv.error);
  ok(sv.ok && fs.existsSync(path.join(T, 'templates', '测试按钮.png')), '§1 PNG 落盘（给人看）');
  ok(sv.ok && fs.existsSync(path.join(T, 'templates', '测试按钮.bin')), '§1 原始 BGRA 落盘（给 matcher 读）');

  /* §2 全屏找回来 —— 必须精确 */
  const r = await M.findTemplate(app, nativeImage, '测试按钮', dataUrl);
  ok(r.ok, '§2 全屏匹配成功', 'score=' + (r.score != null ? r.score.toFixed(3) : '?') + ' ms=' + r.ms);
  ok(r.ok && r.x === TX + TW / 2 && r.y === TY + TH / 2, '§2 **坐标精确等于**(' + (TX + TW / 2) + ',' + (TY + TH / 2) + ')',
    '得到 (' + r.x + ',' + r.y + ')');

  /* §3 ROI 限定 */
  const r2 = await M.findTemplate(app, nativeImage, '测试按钮', dataUrl, [1300, 700, 500, 350]);
  ok(r2.ok && Math.abs(r2.x - (TX + TW / 2)) <= 1 && Math.abs(r2.y - (TY + TH / 2)) <= 1, '§3 ROI 内同样精确', '(' + r2.x + ',' + r2.y + ')');
  ok(r2.ms != null && r2.ms < (r.ms || 9999), '§3 ROI 更快', r2.ms + 'ms < ' + r.ms + 'ms');

  /* §4 画面里没有这个按钮 → LOW（不许编一个高分假位置） */
  const other = makeFrame(W, H);
  const r3 = await M.findTemplate(app, nativeImage, '测试按钮', toDataUrl(other, W, H));
  ok(!!r3.low, '§4 目标不在画面里时返回 LOW', 'score=' + (r3.score != null ? r3.score.toFixed(3) : '?'));

  /* §5 模板不存在 → 可读错误 */
  const r4 = await M.findTemplate(app, nativeImage, '不存在的模板', dataUrl);
  ok(!r4.ok && !r4.low && /没有名为/.test(r4.error || ''), '§5 模板不存在时给可读错误', r4.error || '');

  /* §6 列表 / 删除 */
  const list = M.listTemplates(app);
  ok(list.length === 1 && list[0].name === '测试按钮', '§6 template_list 正确', JSON.stringify(list));
  const del = M.delTemplate(app, '测试按钮');
  ok(del === 3, '§6 删除模板（png/bin/meta 三个文件）', '删了 ' + del + ' 个');
  ok(M.listTemplates(app).length === 0, '§6 删完列表为空');

  /* §7 纯色区域不许当模板（否则匹配没有意义） */
  const flat = Buffer.alloc(200 * 200 * 4, 180);
  for (let i = 3; i < flat.length; i += 4) flat[i] = 255;
  const flatUrl = toDataUrl(flat, 200, 200);
  const sv2 = M.saveTemplate(app, nativeImage, '纯色', flatUrl, { x: 0, y: 0, w: 100, h: 100 });
  const r5 = sv2.ok ? await M.findTemplate(app, nativeImage, '纯色', flatUrl) : { error: 'save failed' };
  ok(!r5.ok, '§7 纯色模板不会给出假匹配', r5.error || ('score=' + (r5.score != null ? r5.score.toFixed(3) : '?')));


  /* §8 多尺度级联：把模板按 1.25 倍放大后，1.0 尺度必然匹配不上，
        级联应当自动换尺度命中（治"用户改了系统缩放 / 模板截自别的尺寸"）。 */
  const sv3 = M.saveTemplate(app, nativeImage, '缩放测试', dataUrl, { x: TX, y: TY, w: TW, h: TH });
  ok(sv3.ok, '§8 存缩放测试模板');
  const big = makeFrame(W, H);
  const BW = Math.round(TW * 1.25), BH = Math.round(TH * 1.25);
  const BX = 700, BY = 400;
  for (let y = 0; y < BH; y++) {
    for (let x = 0; x < BW; x++) {
      const p = ((BY + y) * W + (BX + x)) * 4;
      const sx = Math.min(TW - 1, Math.floor((x * TW) / BW));
      const sy = Math.min(TH - 1, Math.floor((y * TH) / BH));
      const v = ((sx * 13 + sy * 29) % 200) + 20;
      big[p] = v; big[p + 1] = v; big[p + 2] = v; big[p + 3] = 255;
    }
  }
  const bigUrl = toDataUrl(big, W, H);
  const rFlat = await M.findTemplate(app, nativeImage, '缩放测试', bigUrl, null, 0.7);
  ok(!!rFlat.low || !rFlat.ok, '§8 单尺度 1.0 找 1.25 倍的目标 → 应当匹配不上（证明这条测试有意义）',
    'score=' + (rFlat.score != null ? rFlat.score.toFixed(3) : '?'));
  const rCas = await M.findTemplateScaled(app, nativeImage, '缩放测试', bigUrl, null, {});
  const expX2 = BX + BW / 2, expY2 = BY + BH / 2;
  ok(rCas.ok && Math.abs(rCas.x - expX2) <= 3 && Math.abs(rCas.y - expY2) <= 3,
    '§8 级联多尺度**命中**（期望中心 ' + expX2 + ',' + expY2 + '）',
    rCas.ok ? '(' + rCas.x + ',' + rCas.y + ') 尺度=' + rCas.scale + ' score=' + rCas.score.toFixed(3) : 'ERR ' + rCas.error);
  ok(Array.isArray(rCas.tried) && rCas.tried.length >= 1, '§8 返回里说明了试过哪些尺度', JSON.stringify(rCas.tried));

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  setTimeout(() => app.exit(fail ? 1 : 0), 200);
});
