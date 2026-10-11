/* 验证：渲染层到底能不能解 mp3（DTW 方案的参考音频要用）
 * 关键：不能用 fetch('file://')（Chromium 默认禁止），要从主进程注入字节。
 * electron.exe app\scripts\test-audiodecode.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const dir = path.join(process.env.APPDATA, 'dayu-pet', 'tts-cache');
  const mp3s = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp3')).slice(0, 2) : [];
  if (!mp3s.length) { console.log('tts-cache 里没有 mp3'); return app.exit(1); }
  const payload = mp3s.map((f) => ({ name: f.slice(0, 20), b64: fs.readFileSync(path.join(dir, f)).toString('base64') }));
  console.log('注入 ' + payload.length + ' 个 mp3，各约 ' + Math.round(payload[0].b64.length / 1024) + 'KB(base64)');

  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { offscreen: true, contextIsolation: false, nodeIntegration: false } });
  win.loadURL('data:text/html,<html><body>ok</body></html>');
  win.webContents.once('did-finish-load', async () => {
    const js = `
      (async () => {
        const diag = {
          AudioContext: typeof AudioContext,
          webkitAudioContext: typeof webkitAudioContext,
          OfflineAudioContext: typeof OfflineAudioContext,
          AnalyserNode: typeof AnalyserNode,
          audioKeys: Object.keys(window).filter(k => /audio|Audio/.test(k)).slice(0, 12),
        };
        const out = [];
        const AC = window.AudioContext || window.webkitAudioContext;
        for (const p of ${JSON.stringify(payload)}) {
          try {
            const bin = atob(p.b64);
            const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            const ctx = new AC();
            const audio = await ctx.decodeAudioData(u8.buffer);
            const ch = audio.getChannelData(0);
            let peak = 0; for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
            out.push({ name: p.name, ok: true, sec: +audio.duration.toFixed(2), rate: audio.sampleRate, chs: audio.numberOfChannels, n: ch.length, peak: +peak.toFixed(3) });
            ctx.close();
          } catch (e) { out.push({ name: p.name, ok: false, err: String((e && e.message) || e) }); }
        }
        return { diag, out };
      })()
    `;
    try {
      const { diag, out } = await win.webContents.executeJavaScript(js);
      console.log('\n=== Web Audio 能力 ===');
      for (const [k, v] of Object.entries(diag)) console.log('  ' + k.padEnd(22) + JSON.stringify(v));
      console.log('\n=== decodeAudioData 结果 ===');
      for (const r of out) {
        console.log(r.ok
          ? '  ✅ ' + r.name + '  ' + r.sec + 's  ' + r.rate + 'Hz  ' + r.chs + '声道  ' + r.n + ' 采样点  峰值 ' + r.peak
          : '  ❌ ' + r.name + '  ' + r.err);
      }
      const ok = out.some((r) => r.ok);
      console.log('\n结论：' + (ok
        ? '渲染层能解 mp3 → DTW 方案可直接复用 TTS 的 mp3 作参考（零新依赖）'
        : '解不了 mp3 → 参考音频改用 Windows SAPI 本地合成 16kHz WAV（离线，也能满足）'));
    } catch (e) { console.log('执行失败: ' + e.message); }
    app.exit(0);
  });
});
