/* 真屏幕冒烟测试（精简版）：只依赖 screenstream + matcher，不 require main.js
 *
 * 目的：验证"真实抓帧 → 原始 BGRA → 模板匹配"这条**生产链路**（合成测试之外的真机验证），
 * 并顺便量一下 JPEG 帧与 PNG 帧对匹配分数的影响（调研说"模板匹配别用 JPEG"）。
 *
 * 每一步都打日志 + 每步都有超时保护：一旦挂住，日志会直接指出挂在哪一步。
 * 跑法：electron.exe app\scripts\smoke-match-live.js
 */
const path = require('path');
const fs = require('fs');
const { app, nativeImage, desktopCapturer, screen } = require('electron');

const T = path.join(process.env.APPDATA, 'dayu-pet-matchsmoke');
fs.mkdirSync(T, { recursive: true });
app.setPath('userData', T);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 给任意 promise 套超时：挂住时不至于静默卡死，日志能说清是哪一步 */
function withTimeout(p, ms, label) {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + ms + 'ms: ' + label)), ms)),
  ]);
}

app.whenReady().then(async () => {
  const log = (s) => console.log(s);
  log('=== 真屏幕冒烟测试（精简版）===');
  const M = require('../src/matcher');

  log('  [1/6] 检查 match.exe …');
  log('        ' + (fs.existsSync(M.EXE) ? '✅ 存在 ' + M.EXE : '❌ 不存在'));
  if (!fs.existsSync(M.EXE)) return setTimeout(() => app.exit(1), 200);

  const d = screen.getPrimaryDisplay();
  log('  [2/6] 显示器: DIP ' + d.size.width + 'x' + d.size.height + '  scale=' + d.scaleFactor
    + ' → 物理 ' + Math.round(d.size.width * d.scaleFactor) + 'x' + Math.round(d.size.height * d.scaleFactor));

  /* --- 3) 用 desktopCapturer 直接抓一帧 PNG（无损，绕开流，最可靠） --- */
  log('  [3/6] desktopCapturer 抓 PNG 帧（20s 超时）…');
  let pngUrl = null, pngW = 0, pngH = 0;
  try {
    const tw = Math.round(d.size.width * d.scaleFactor), th = Math.round(d.size.height * d.scaleFactor);
    const srcs = await withTimeout(desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: tw, height: th } }), 20000, 'getSources');
    if (srcs && srcs[0]) {
      const img = srcs[0].thumbnail;
      pngW = img.getSize().width; pngH = img.getSize().height;
      pngUrl = img.toDataURL();
      log('        ✅ ' + pngW + 'x' + pngH + '  ' + Math.round(pngUrl.length / 1024) + 'KB');
    } else log('        ❌ 没有拿到屏幕源');
  } catch (e) { log('        ❌ ' + e.message); }
  if (!pngUrl) return setTimeout(() => app.exit(1), 200);

  /* --- 4) 挑一块有纹理的区域当模板 --- */
  log('  [4/6] 找纹理最丰富的区域当模板 …');
  const bmp = M.toBgra(nativeImage, pngUrl);
  log('        toBitmap: ' + bmp.w + 'x' + bmp.h + '  ' + bmp.buf.length + ' 字节（期望 ' + (bmp.w * bmp.h * 4) + '）'
    + (bmp.buf.length === bmp.w * bmp.h * 4 ? ' ✅' : ' ❌'));
  const TW = 96, TH = 72, STEP = 140;
  const gray = (p) => (bmp.buf[p + 2] * 77 + bmp.buf[p + 1] * 150 + bmp.buf[p] * 29) >> 8;
  let best = { v: -1, x: 0, y: 0 };
  for (let y = 0; y + TH < bmp.h; y += STEP) {
    for (let x = 0; x + TW < bmp.w; x += STEP) {
      let s = 0, s2 = 0, n = 0;
      for (let yy = 0; yy < TH; yy += 4) {
        for (let xx = 0; xx < TW; xx += 4) {
          const g = gray(((y + yy) * bmp.w + (x + xx)) * 4);
          s += g; s2 += g * g; n++;
        }
      }
      const m = s / n, va = s2 / n - m * m;
      if (va > best.v) best = { v: va, x, y };
    }
  }
  log('        选到 (' + best.x + ',' + best.y + ') 方差=' + Math.round(best.v)
    + (best.v < 50 ? '  ⚠️ 屏幕偏纯色，说明力有限（但流程仍被验证）' : '  ✅ 有纹理'));

  /* --- 5) 存模板 + 用 PNG 帧找回来 --- */
  log('  [5/6] 存模板并用同一张 PNG 找回 …');
  const sv = M.saveTemplate(app, nativeImage, 'live', pngUrl, { x: best.x, y: best.y, w: TW, h: TH });
  log('        ' + (sv.ok ? '✅ 已存 ' + sv.w + 'x' + sv.h : '❌ ' + sv.error));
  if (!sv.ok) return setTimeout(() => app.exit(1), 200);
  const rPng = await withTimeout(M.findTemplate(app, nativeImage, 'live', pngUrl), 40000, 'findTemplate(PNG)');
  const expX = best.x + TW / 2, expY = best.y + TH / 2;
  log('        PNG 帧: ' + (rPng.ok || rPng.low ? 'score=' + rPng.score.toFixed(4) + '  得到(' + rPng.x + ',' + rPng.y + ')  ' + rPng.ms + 'ms' : 'ERR ' + rPng.error));
  log('        期望  : (' + expX + ',' + expY + ')  → '
    + (Math.abs(rPng.x - expX) <= 1 && Math.abs(rPng.y - expY) <= 1 ? '✅ **精确吻合（真机链路成立）**' : '❌ 偏差 ' + Math.abs(rPng.x - expX) + 'px'));

  /* --- 6) JPEG 帧（走屏幕流）对比 --- */
  log('  [6/6] 用屏幕流抓 JPEG 帧再找一次（对比分数）…');
  try {
    const ss = require('../src/screenstream');
    const jpg = await withTimeout(ss.grabFrame({ grid: false, noCursor: true }), 25000, 'grabFrame');
    if (!jpg) { log('        ⚠️ 屏幕流不可用（返回 null）—— 生产时会自动回退到 desktopCapturer，不影响正确性'); }
    else {
      log('        JPEG 帧: ' + jpg.width + 'x' + jpg.height + '  ' + Math.round(jpg.dataUrl.length / 1024) + 'KB');
      const rJpg = await withTimeout(M.findTemplate(app, nativeImage, 'live', jpg.dataUrl), 40000, 'findTemplate(JPEG)');
      if (rJpg.ok || rJpg.low) {
        log('        JPEG 帧: score=' + rJpg.score.toFixed(4) + '  得到(' + rJpg.x + ',' + rJpg.y + ')  ' + rJpg.ms + 'ms');
        if (rPng.score != null) {
          const dd = rPng.score - rJpg.score;
          log('        → PNG 比 JPEG 高 ' + dd.toFixed(4)
            + (dd > 0.02 ? '  ← 调研那句"别用 JPEG"确实有影响，模板值得改用 PNG 抓' : '  ← 差别很小，JPEG 流够用（还能省掉慢速抓帧）'));
        }
      } else log('        ERR ' + rJpg.error);
    }
  } catch (e) { log('        ⚠️ ' + e.message + '（生产路径有回退，不算失败）'); }

  log('');
  log('模板目录: ' + M.listTemplates(app).map((t) => t.name + '(' + t.w + 'x' + t.h + ')').join(', ') || '(空)');
  log('冒烟测试结束');
  setTimeout(() => app.exit(0), 300);
});
