/* 验证 whisper token 概率 → 逐词打分链路
 * electron.exe app\scripts\test-asr.js
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
app.setPath('userData', path.join(process.env.APPDATA, 'dayu-pet'));

app.whenReady().then(async () => {
  const asr = require('../src/asr');
  const config = require('../src/config');
  const out = [];
  const L = (s) => out.push(s);

  const BANDS = [
    { min: 0.80, key: 'good', label: '清晰' },
    { min: 0.55, key: 'ok', label: '一般' },
    { min: 0, key: 'poor', label: '含糊' },
  ];
  const bandOf = (p) => (BANDS.find((b) => p >= b.min) || BANDS[BANDS.length - 1]);

  let crashed = '';

  try {
    const wav = path.join(process.env.TEMP, 'asr-test.wav');
    L('wav = ' + wav + '  (' + (fs.existsSync(wav) ? Math.round(fs.statSync(wav).size / 1024) + ' KB' : '不存在') + ')');
    const cfg = config.load();
    L('配置模型 = ' + cfg.asrModel);
    L('');

    const t0 = Date.now();
    const r = await asr.transcribeDetailed(fs.readFileSync(wav), cfg.asrModel);
    const ms = Date.now() - t0;
    L('=== 识别结果（模型 ' + asr.pickModel(cfg.asrModel) + '，' + ms + 'ms）===');
    L('  text: ' + r.text);
    L('');
    L('=== 逐词概率 → 分档 ===');
    L('  ' + '单词'.padEnd(14) + 'p'.padEnd(9) + 'pMin'.padEnd(9) + '档位');
    for (const w of r.words) {
      const b = bandOf(w.p);
      L('  ' + w.w.padEnd(14) + String(w.p).padEnd(9) + String(w.pMin).padEnd(9) + b.label + ' (' + b.key + ')');
    }
    const ps = r.words.map((w) => w.p);
    const overall = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
    L('');
    L('  整句均分 = ' + overall.toFixed(3) + '  → ' + bandOf(overall).label);
    const counts = {};
    for (const w of r.words) { const k = bandOf(w.p).key; counts[k] = (counts[k] || 0) + 1; }
    L('  分档统计 = ' + JSON.stringify(counts));
    L('');
    L('=== 拿原始 JSON 复核 groupTokens（标点是否被正确排除）===');
    const jf = path.join(process.env.TEMP, 'asr-out.json');
    if (fs.existsSync(jf)) {
      const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
      const toks = (j.transcription && j.transcription[0] && j.transcription[0].tokens) || [];
      L('  原始 token 数 = ' + toks.length + '（含标点）');
      L('  分组后词数   = ' + asr.groupTokens(toks).length);
      const dot = toks.find((t) => String(t.text).trim() === '.');
      L('  标点 token "." 的 p = ' + (dot ? dot.p : '?') + '  → 已排除，不会拖累前一个词');
    }
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  app.exit(0);
});
