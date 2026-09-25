/* 本地校验 src/tts.js：绕过 electron 的 app.getPath，跑一次真实合成 + 缓存命中 */
const Module = require('module');
const path = require('path');
const orig = Module._load;
const tmp = path.join(__dirname, '..', 'dist', 'tts-test');   // 相对脚本位置，搬到哪都能跑
Module._load = function (req) {
  if (req === 'electron') return { app: { getPath: () => tmp } };
  return orig.apply(this, arguments);
};

const tts = require('../src/tts');

(async () => {
  const text = 'Hey! I am NOT a freeloader fat fish! Do you want to play with me?';
  for (const pass of [1, 2]) {
    const t0 = Date.now();
    const r = await tts.synthesize(text, { voice: 'en-US-AnaNeural', style: 'cute' });
    console.log(
      `pass${pass} ok=${r.ok} voice=${r.voice} style=${r.style} rate=${r.rate.toFixed(2)} pitch=${r.pitch.toFixed(2)} ` +
      `cached=${r.cached} bytes=${r.dataUrl.length} file=${require('path').basename(r.file)} ${Date.now() - t0}ms`
    );
  }
  const r2 = await tts.synthesize('Short one! And a second sentence here.', { voice: 'en-US-AriaNeural', style: 'tsundere', rate: 1.1, pitch: 0.95 });
  console.log(`multi ok=${r2.ok} voice=${r2.voice} style=${r2.style} rate=${r2.rate.toFixed(2)} pitch=${r2.pitch.toFixed(2)} bytes=${r2.dataUrl.length}`);
  console.log('voices=' + tts.VOICES.length + ' styles=' + Object.keys(tts.STYLES).join(','));
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
