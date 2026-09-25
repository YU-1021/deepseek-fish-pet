/* 语音识别自检（不需要说话）
 * 在真实 file:// 页面上跑（data: URL 拿不到麦克风）。
 * 判定：
 *   mic=denied:*        → 麦克风权限问题
 *   error:network       → 语音服务连不上（引擎不可用，国内常见）
 *   error:not-allowed   → 权限被拒
 *   error:no-speech     → 服务通了，只是没听到人说话（引擎 OK）
 *   got-result          → 直接识别出内容（引擎 OK）
 */
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const TEST = `(async () => {
  const out = { events: [], lang: navigator.language };
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    out.mic = 'granted';
    s.getTracks().forEach((t) => t.stop());
  } catch (e) { out.mic = 'denied:' + ((e && e.name) || e); }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  out.sr = !!SR;
  if (!SR) { out.reason = 'no-SpeechRecognition-API'; return out; }

  return await new Promise((resolve) => {
    let r;
    try { r = new SR(); } catch (e) { out.reason = 'ctor:' + e.message; return resolve(out); }
    r.lang = 'en-US'; r.continuous = false; r.interimResults = true;
    const t0 = Date.now();
    const at = () => Date.now() - t0;
    let done = false;
    const fin = (reason) => { if (done) return; done = true; out.reason = reason; resolve(out); };
    r.onstart = () => out.events.push('start@' + at());
    r.onaudiostart = () => out.events.push('audiostart@' + at());
    r.onsoundstart = () => out.events.push('soundstart@' + at());
    r.onspeechstart = () => out.events.push('speechstart@' + at());
    r.onresult = (e) => { out.events.push('result@' + at()); out.ok = true; try { r.stop(); } catch {} fin('got-result'); };
    r.onerror = (e) => { out.events.push('error:' + e.error + '@' + at()); fin('error:' + e.error); };
    r.onend = () => { out.events.push('end@' + at()); fin('ended-without-error'); };
    try { r.start(); } catch (e) { fin('start-throw:' + e.message); }
    setTimeout(() => { out.events.push('timeout@' + at()); try { r.stop(); } catch {} fin('timeout(12s)'); }, 12000);
  });
})()`;

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  const win = new BrowserWindow({ width: 380, height: 160, show: true, webPreferences: { contextIsolation: true } });
  await win.loadFile(path.join(__dirname, 'asr-test.html'));
  let result;
  try { result = await win.webContents.executeJavaScript(TEST, true); }
  catch (e) { result = { reason: 'execute-error:' + ((e && e.message) || e) }; }
  console.log('===ASR-RESULT===');
  console.log(JSON.stringify(result));
  console.log('===END===');
  setTimeout(() => app.exit(0), 300);
});
