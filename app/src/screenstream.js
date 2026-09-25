// 连续屏幕流（MediaProjection）—— 实时屏幕感知的底座。
//
// 为什么不用 desktopCapturer.getSources 直接截图：
//   实测每次调用 ~650ms（枚举源 + 抓帧 + PNG 编码），而且缩小分辨率也救不了，
//   那个开销是 API 本身固定的。对"实时看屏幕"完全不够。
//
// 这里改成：一个隐藏窗口里用 getUserMedia(chromeMediaSource:'desktop') 拉起
// 一条 30fps 的屏幕视频流，抓一帧只要几十毫秒。grabFrame() 按需取当前帧，
// watch(fps) 供以后"持续盯屏幕"的功能按固定频率取帧。
//
// 失败时 grabFrame() 返回 null，调用方退回 desktopCapturer 慢速截图。
const { BrowserWindow, desktopCapturer, screen } = require('electron');
const path = require('path');

let win = null;
let ready = false;
let starting = null;
let failed = false;   // 流方式起不来，之后走回退
let failedAt = 0;     // 上次失败时间（冷却后允许再试一次，别一次抖动就永久放弃）

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    show: false,
    width: 640, height: 360,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'capture.html'));
  win.on('closed', () => { win = null; ready = false; });
  return win;
}

/* 等页面加载完，但**必须有失败/超时出口**：
   以前只等 did-finish-load，页面加载失败或渲染进程崩溃时它永远不触发 →
   init() 的 Promise 永不 settle、starting 永不清空，此后每次 grabFrame() 都挂在这同一个
   Promise 上 → screen_shot / screen_look 永久卡住（IPC 不返回，也不会回退到 desktopCapturer）。 */
function waitLoaded(w) {
  const wc = w.webContents;
  if (!wc.isLoading()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    const fin = (err) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try { wc.removeListener('did-finish-load', onOk); } catch {}
      try { wc.removeListener('did-fail-load', onFail); } catch {}
      try { wc.removeListener('render-process-gone', onGone); } catch {}
      err ? reject(err) : resolve();
    };
    const onOk = () => fin(null);
    const onFail = (_e, code, desc) => fin(new Error('capture.html 加载失败 ' + code + ' ' + (desc || '')));
    const onGone = () => fin(new Error('capture 渲染进程崩溃'));
    const t = setTimeout(() => fin(new Error('capture.html 加载超时')), 10000);
    wc.once('did-finish-load', onOk);
    wc.once('did-fail-load', onFail);
    wc.once('render-process-gone', onGone);
  });
}

async function init() {
  if (ready) return;
  // 冷却期内不重试（省得每次抓帧都白等一次超时）；冷却过了允许再试
  if (failed && Date.now() - failedAt < 60000) return;
  if (starting) return starting;
  starting = (async () => {
    try {
      const w = ensureWindow();
      await waitLoaded(w);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 2, height: 2 } });
      const primary = screen.getPrimaryDisplay();
      const src = sources.find((s) => s.display_id === String(primary.id)) || sources[0];
      if (!src) throw new Error('no screen source');
      await w.webContents.executeJavaScript(`window.__startStream(${JSON.stringify(src.id)})`);
      ready = true;
      failed = false;
    } catch (e) {
      failed = true;
      failedAt = Date.now();
      try { console.error('[screenstream] ' + ((e && e.message) || e)); } catch {}
      // 起不来就把这个坏窗口丢掉，下次重试时重建
      try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
      win = null;
    }
  })().finally(() => { starting = null; });
  return starting;
}

/* 抓当前帧。返回 { dataUrl(jpeg), width, height }；流不可用返回 null */
async function grabFrame() {
  await init();
  if (!ready) return null;
  try {
    const w = ensureWindow();
    return await w.webContents.executeJavaScript('window.__grabFrame()');
  } catch { return null; }
}

/* 连续取帧：每 1000/fps 毫秒抓一帧回调（封底 5fps，别把机器拖垮） */
function watch(fps, onFrame) {
  const iv = setInterval(async () => {
    try {
      const f = await grabFrame();
      if (f) onFrame(f);
    } catch {}
  }, Math.max(200, Math.round(1000 / fps)));
  return () => clearInterval(iv);
}

module.exports = { grabFrame, watch, warm: init };
