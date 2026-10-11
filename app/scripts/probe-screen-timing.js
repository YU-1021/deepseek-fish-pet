/* screen_look 分段耗时诊断（连续多次，看冷/热差异）
 * electron.exe app\scripts\probe-screen-timing.js
 * 不改用户配置：用副本 + visionEnabled=true。
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const REAL_UD = path.join(process.env.APPDATA, 'dayu-pet');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-timing2');
fs.mkdirSync(TEST_UD, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(REAL_UD, 'config.json'), 'utf8'));
cfg.visionEnabled = true; cfg.visionKey = ''; cfg.visionBase = ''; cfg.visionModel = 'deepseek-flash';
fs.writeFileSync(path.join(TEST_UD, 'config.json'), JSON.stringify(cfg, null, 2));
try { fs.copyFileSync(path.join(REAL_UD, 'persona.json'), path.join(TEST_UD, 'persona.json')); } catch {}
app.setPath('userData', TEST_UD);

app.whenReady().then(async () => {
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  try {
    const assistant = require('../src/assistant');
    const screenstream = require('../src/screenstream');
    const config = require('../src/config');

    L('=== 0. 不预热，直接第一次 screen_look（模拟真实首次使用）===');
    let t = Date.now();
    let r = await assistant.run('screen_look', '屏幕上现在是什么？一句话说明。');
    L('  总 ' + (Date.now() - t) + 'ms   分段=' + JSON.stringify(r.timing));

    L('');
    L('=== 1. 再连续来三次（热态）===');
    for (let i = 1; i <= 3; i++) {
      t = Date.now();
      r = await assistant.run('screen_look', '屏幕上现在是什么？一句话说明。');
      L('  第 ' + i + ' 次: 总 ' + (Date.now() - t) + 'ms   分段=' + JSON.stringify(r.timing));
    }

    L('');
    L('=== 2. detail 换成 high 会不会更慢（不动实现，直接调 vision）===');
    const c = config.load();
    const cap = await screenstream.grabFrame();
    for (const d of ['low', 'high']) {
      t = Date.now();
      try { await require('../src/vision').describe(c, cap.dataUrl, '屏幕上是什么？一句话。', d); } catch (e) {}
      L('  detail=' + d + ': ' + (Date.now() - t) + 'ms');
    }
  } catch (e) {
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit(0), 200);
});
