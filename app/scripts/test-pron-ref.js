/* 验证发音评测的"参考句"链路（就是 main.js 里 pron:ref 做的事）：
 *   目标句 → TTS(mp3) → whisper 拿词级时间戳 → 缓存 → 二次调用命中缓存
 * electron.exe app\scripts\test-pron-ref.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
app.setPath('userData', path.join(process.env.APPDATA, 'dayu-pet'));

app.whenReady().then(async () => {
  const tts = require('../src/tts');
  const asr = require('../src/asr');
  const speak = require('../src/speak');
  const config = require('../src/config');
  const out = [];
  const L = (s) => out.push(s);

  const TEXT = 'Hello there. I would like to practice speaking English with you today.';
  let crashed = '';
  try {
    const cfg = config.load();
    L('=== 配置 ===');
    L('  asrModel = ' + cfg.asrModel);
    L('  pron.enabled = ' + cfg.pron.enabled + '  threshold = ' + cfg.pron.threshold
      + '  dropC0 = ' + cfg.pron.dropC0 + '  cmn = ' + cfg.pron.cmn);
    L('  参数个数 = ' + Object.keys(cfg.pron).length + '（全部可在 config.json 里改）');
    L('  缓存键 = ' + speak.refKey(TEXT));
    L('');

    for (const round of [1, 2]) {
      const t0 = Date.now();
      const hit = !!speak.refGet(TEXT);
      const t1 = Date.now();
      const mp3 = await tts.synthesize(TEXT, { voice: cfg.ttsVoice || undefined });
      const t2 = Date.now();
      if (!mp3 || !mp3.dataUrl) { L('❌ TTS 合成失败（第 ' + round + ' 轮）'); break; }
      let words = hit ? speak.refGet(TEXT).words : null;
      let t3 = t2;
      if (!words) {
        const tmp = path.join(os.tmpdir(), 'dayu-pron-test.mp3');
        fs.writeFileSync(tmp, Buffer.from(String(mp3.dataUrl).split(',')[1] || '', 'base64'));
        const r = await asr.transcribeDetailed(fs.readFileSync(tmp), cfg.asrModel, { vad: false, ext: 'mp3' });
        try { fs.unlinkSync(tmp); } catch {}
        words = (r.words || []).filter((w) => Number.isFinite(w.from) && Number.isFinite(w.to));
        if (words.length) speak.refPut(TEXT, words);
        t3 = Date.now();
      }
      L('=== 第 ' + round + ' 轮 ===');
      L('  缓存命中: ' + (hit ? '✅ 是' : '否（这次要跑 whisper）'));
      L('  TTS: ' + Math.round(t2 - t1) + ' ms   mp3 ' + Math.round(String(mp3.dataUrl).length / 1024) + ' KB(base64)');
      if (!hit) L('  whisper 分析参考句: ' + Math.round(t3 - t2) + ' ms');
      L('  总耗时: ' + Math.round(Date.now() - t0) + ' ms');
      L('  词级时间戳 ' + (words ? words.length : 0) + ' 个:');
      if (words) L('    ' + words.map((w) => w.w + '[' + w.from + '-' + w.to + ']').join(' '));
      L('');
    }
    L('=== 结论 ===');
    L('  参考句链路: ' + (speak.refGet(TEXT) ? '✅ 通（缓存已写入，二次调用不再跑 whisper）' : '❌ 不通'));
    L('  缓存目录: ' + speak.refDir());
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  app.exit(0);
});
