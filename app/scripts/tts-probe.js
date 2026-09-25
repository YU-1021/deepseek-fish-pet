/* 临时探针：验证 Edge TTS 在本机可连通，并试听若干英文音色 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('../vendor/ws');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const WSS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const CRLF = String.fromCharCode(13, 10);

function secMsGec() {
  const EPOCH = 11644473600n;
  const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(EPOCH)) * 10000000n;
  const rounded = ticks - (ticks % 3000000000n);
  return crypto.createHash('sha256').update(String(rounded) + TRUSTED_CLIENT_TOKEN, 'ascii').digest('hex').toUpperCase();
}
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function synth(voice, text, outPath, rate, pitch) {
  return new Promise((resolve, reject) => {
    const url = `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`;
    const ws = new WebSocket(url, {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_FULL_VERSION} Safari/537.36 Edg/${CHROMIUM_FULL_VERSION}`,
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error('timeout')); } }, 45000);
    const done = (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) return reject(err);
      const buf = Buffer.concat(chunks);
      if (buf.length < 100) return reject(new Error('audio too small ' + buf.length));
      fs.writeFileSync(outPath, buf);
      resolve(buf.length);
    };
    ws.on('open', () => {
      const rid = crypto.randomBytes(16).toString('hex');
      const cfg = { context: { synthesis: { audio: {
        metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } };
      const lang = voice.split('-').slice(0, 2).join('-');
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">`
        + `<voice name="${esc(voice)}"><prosody rate="${esc(rate)}" pitch="${esc(pitch)}" volume="default">${esc(text)}</prosody></voice></speak>`;
      ws.send('Content-Type:application/json; charset=utf-8' + CRLF + 'Path:speech.config' + CRLF + CRLF + JSON.stringify(cfg));
      ws.send('X-RequestId:' + rid + CRLF + 'Content-Type:application/ssml+xml' + CRLF + 'Path:ssml' + CRLF + CRLF + ssml);
    });
    ws.on('message', (data, isBinary) => {
      if (settled) return;
      if (!isBinary) { if (String(data).includes('Path:turn.end')) done(null); return; }
      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const marker = Buffer.from('Path:audio' + CRLF);
      const i = raw.indexOf(marker);
      if (i >= 0) { const body = raw.subarray(i + marker.length); if (body.length) chunks.push(body); }
      else if (raw.length) chunks.push(raw);
    });
    ws.on('error', (e) => done(e instanceof Error ? e : new Error(String((e && e.message) || e))));
    ws.on('close', (e) => { if (!settled) { chunks.length ? done(null) : done(new Error('closed early code=' + ((e && e.code) || ''))); } });
  });
}

const VOICES = process.argv.slice(2);
const outDir = path.join(__dirname, '..', 'dist', 'tts-probe');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const list = VOICES.length ? VOICES : ['en-US-AnaNeural'];
  for (const v of list) {
    const out = path.join(outDir, v + '.mp3');
    const t0 = Date.now();
    try {
      const n = await synth(v, 'Hey! I am NOT a freeloader fat fish! Do you want to play with me?', out, '+0%', '+0%');
      console.log('OK   ' + v + '  ' + n + ' bytes  ' + (Date.now() - t0) + 'ms');
    } catch (e) {
      console.log('FAIL ' + v + '  ' + ((e && e.message) || e));
    }
  }
})();
