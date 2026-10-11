/* 验证口语练习：打分分档 / 音标缓存 / 翻译器（真调一次模型）
 * electron.exe app\scripts\test-speak.js
 */
const path = require('path');
const { app } = require('electron');
app.setPath('userData', path.join(process.env.APPDATA, 'dayu-pet'));

app.whenReady().then(async () => {
  const speak = require('../src/speak');
  const llm = require('../src/llm');
  const config = require('../src/config');
  const asr = require('../src/asr');
  const out = [];
  const L = (s) => out.push(s);

  let crashed = '';

  try {
    const cfg = config.load();
    L('=== 1. 打分分档（阈值 good>=' + cfg.speakGoodP + ' ok>=' + cfg.speakOkP + '）===');
    const demo = [
      { w: 'Hello', p: 0.842 }, { w: 'there', p: 0.834 }, { w: 'practice', p: 0.986 },
      { w: 'English', p: 0.6 }, { w: 'mumble', p: 0.31 },
    ];
    const s = speak.scoreWords(demo, cfg);
    for (const w of s.words) L('  ' + w.w.padEnd(12) + 'p=' + String(w.p).padEnd(8) + '→ ' + w.band);
    L('  整句 = ' + s.overall + ' (' + s.band + ')  统计 ' + JSON.stringify(s.counts));

    L('');
    L('=== 2. 模型档位（配置 vs 实际会用哪个）===');
    L('  配置 = ' + cfg.asrModel);
    L('  实际 = ' + asr.pickModel(cfg.asrModel) + '   （缺档会自动退到已下载里最好的）');
    for (const m of Object.keys(asr.MODELS)) L('    ' + m.padEnd(10) + (asr.hasModel(m) ? '✅ 已下载' : '⬜ 未下载'));

    L('');
    L('=== 3. 音标缓存 ===');
    const probe = ['welcome', 'serendipity', 'gonna'];
    L('  查缓存: ' + JSON.stringify(speak.ipaGet(probe)));
    L('  缺的  : ' + JSON.stringify(speak.ipaMissing(probe)));

    if (!cfg.apiKey) { L(''); L('（没配 API Key，跳过第 4/5 步）'); } else {
      L('');
      L('=== 4. 音标补齐（真调模型）===');
      const raw = await llm.request(cfg, [
        { role: 'system', content: speak.buildIpaPrompt(['serendipity', 'gonna']) },
        { role: 'user', content: '请输出 JSON。' },
      ]);
      const o = speak.parseJson(raw);
      L('  模型返回: ' + JSON.stringify(o));
      const n = speak.ipaPut(o);
      L('  写入缓存 ' + n + ' 条；再查缓存: ' + JSON.stringify(speak.ipaGet(['serendipity', 'gonna'])));

      L('');
      L('=== 5. 翻译器（真调模型）===');
      const zh = '我今天好累，不想动，但还是想陪你聊会儿';
      const prompt = speak.buildTranslatePrompt(zh, { scene: '和桌宠练英语口语' });
      L('  提示词 ' + prompt.length + ' 字符');
      const t0 = Date.now();
      const raw2 = await llm.request(cfg, [{ role: 'system', content: prompt }, { role: 'user', content: '请输出 JSON。' }]);
      const ms = Date.now() - t0;
      const o2 = speak.parseJson(raw2);
      if (!o2 || !Array.isArray(o2.options)) { L('  ❌ 解析失败: ' + String(raw2).slice(0, 200)); }
      else {
        L('  ' + o2.options.length + ' 种说法，' + ms + 'ms');
        o2.options.forEach((opt, i) => {
          L('  [' + (i + 1) + '] ' + opt.en);
          L('      ' + (opt.zh || '') + (opt.note ? '   —— ' + opt.note : ''));
          const ws = (opt.words || []).map((w) => w.w + ' ' + (w.ipa || '') + ' ' + (w.zh || '')).join(' | ');
          if (ws) L('      词: ' + ws);
        });
        const okWords = o2.options.every((o) => !o.words || o.words.every((w) => w.w && w.ipa));
        L('  每个词都带音标: ' + (okWords ? '✅' : '⚠ 有缺失'));
      }
    }
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  app.exit(0);
});
