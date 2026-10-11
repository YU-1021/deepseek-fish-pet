/* 走应用自己的代码路径验证 VAD：对比 开/关 的耗时与输出（用前后各 30s 静音的音频）
 * electron.exe app\scripts\test-vad.js
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

  let crashed = '';

  try {
    const cfg = config.load();
    const wav = path.join(process.env.TEMP, 'asr-padded.wav');
    L('=== 环境 ===');
    L('  VAD 模型: ' + (asr.hasVad() ? '✅ 已装  ' + asr.vadPath() : '❌ 没装'));
    L('  VAD 模型大小: ' + (asr.hasVad() ? Math.round(fs.statSync(asr.vadPath()).size / 1024) + ' KB' : '-'));
    L('  配置 asrVad = ' + cfg.asrVad + '   threshold = ' + cfg.asrVadThreshold);
    L('  测试音频: ' + (fs.existsSync(wav) ? Math.round(fs.statSync(wav).size / 1024) + ' KB（前后各 30s 静音 + 中间说话）' : '不存在，先跑 make-padded-wav.js 30'));
    if (!fs.existsSync(wav)) { console.log(out.join('\n')); return app.exit(1); }

    const buf = fs.readFileSync(wav);
    for (const vad of [false, true]) {
      const t0 = Date.now();
      const r = await asr.transcribeDetailed(buf, cfg.asrModel, { vad, vadThreshold: cfg.asrVadThreshold });
      const ms = Date.now() - t0;
      L('');
      L('=== VAD ' + (vad ? '开' : '关') + ' ===');
      L('  耗时 ' + ms + ' ms   返回 vad=' + r.vad + '   词数 ' + r.words.length);
      L('  文本: ' + r.text);
      L('  词: ' + r.words.map((w) => w.w + '(' + w.p + ')').join(' '));
      if (vad) global.__vadOn = { ms, text: r.text, n: r.words.length };
      else global.__vadOff = { ms, text: r.text, n: r.words.length };
    }
    const a = global.__vadOff, b = global.__vadOn;
    L('');
    L('=== 结论 ===');
    L('  提速: ' + a.ms + ' -> ' + b.ms + ' ms  (' + (a.ms > 0 ? Math.round((1 - b.ms / a.ms) * 100) : 0) + '% 更快)');
    L('  词数: ' + a.n + ' -> ' + b.n);
    L('  输出是否被 VAD 修正（幻觉词是否消失）: ' + (a.text !== b.text ? '有变化' : '无变化'));
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  app.exit(0);
});
