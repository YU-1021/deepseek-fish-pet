/* 验证"16k WAV 才能拿到可用词级时间戳"这个前提（并清掉之前存的坏缓存）
 * electron.exe app\scripts\test-pron-timing.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
app.setPath('userData', path.join(process.env.APPDATA, 'dayu-pet'));

app.whenReady().then(async () => {
  const asr = require('../src/asr');
  const speak = require('../src/speak');
  const tts = require('../src/tts');
  const config = require('../src/config');
  const out = [];
  const L = (s) => out.push(s);
  const TEXT = 'Hello there. I would like to practice speaking English with you today.';

  /* 1. 清掉之前用 mp3 跑出来的坏缓存（时间戳是零长的） */
  try { fs.unlinkSync(speak.refFile(TEXT)); L('已清除旧缓存: ' + path.basename(speak.refFile(TEXT))); } catch { L('旧缓存不存在（不用清）'); }

  const sanity = (words) => {
    if (!words.length) return '没有词';
    let bad = 0, prev = -1;
    for (const w of words) {
      if (!(w.to > w.from)) bad++;
      if (w.from < prev) bad++;
      prev = w.from;
    }
    const span = words[words.length - 1].to - words[0].from;
    return '零长/乱序的词 = ' + bad + ' / ' + words.length + '　首词起点=' + words[0].from + 'ms  末词终点=' + words[words.length - 1].to + 'ms  跨度=' + span + 'ms';
  };

  let crashed = '';

  try {
    const cfg = config.load();
    /* 2. 先用 mp3 跑一遍（已知时间戳会坏，作为对照） */
    const mp3 = await tts.synthesize(TEXT, { voice: cfg.ttsVoice || undefined });
    const tmpMp3 = path.join(os.tmpdir(), 'pron-cmp.mp3');
    fs.writeFileSync(tmpMp3, Buffer.from(String(mp3.dataUrl).split(',')[1] || '', 'base64'));
    const rm = await asr.transcribeDetailed(fs.readFileSync(tmpMp3), cfg.asrModel, { vad: false, ext: 'mp3' });
    L('');
    L('=== A. 48kHz mp3 直接喂 whisper（当前 pron:ref 的旧做法）===');
    L('  词数 ' + rm.words.length + '   ' + sanity(rm.words));
    L('  ' + rm.words.map((w) => w.w + '[' + w.from + '-' + w.to + ']').join(' '));
    try { fs.unlinkSync(tmpMp3); } catch {}

    /* 3. 用 16k 单声道 WAV 跑（新做法：渲染层重采样后就是这个格式） */
    const wav16 = path.join(process.env.TEMP, 'asr-test.wav');   // SAPI 生成的 16k 单声道 WAV
    if (!fs.existsSync(wav16)) { L(''); L('⚠ 缺少 16k 测试 WAV: ' + wav16); }
    else {
      const rw = await asr.transcribeDetailed(fs.readFileSync(wav16), cfg.asrModel, { vad: true });
      L('');
      L('=== B. 16kHz 单声道 WAV（新做法）===');
      L('  词数 ' + rw.words.length + '   ' + sanity(rw.words));
      L('  ' + rw.words.map((w) => w.w + '[' + w.from + '-' + w.to + ']').join(' '));
      L('');
      L('=== 结论 ===');
      const oka = rm.words.filter((w) => w.to > w.from).length;
      const okb = rw.words.filter((w) => w.to > w.from).length;
      L('  非零长词：mp3 ' + oka + '/' + rm.words.length + '　vs　16k WAV ' + okb + '/' + rw.words.length);
      L('  ' + (okb > oka ? '✅ 16k WAV 明显更可靠 → 重采样这一步是必须的' : '⚠ 两者差不多，需要重新判断根因'));
    }
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  app.exit(0);
});
