/* 真实视觉模型验证（用**合成图片**，不含你的屏幕内容）
 * electron.exe app\scripts\test-vision-real.js
 *
 * 为什么用合成图：验证的是"我们的请求格式 + 这个模型到底能不能看图"，
 * 不需要把你的桌面截图发出去。合成图上有已知内容：文字 HELLO 7391、红圆、蓝方块 BLUE BOX。
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-visionreal');
fs.mkdirSync(TEST_UD, { recursive: true });
/* 用真实配置（拿真 key），但只改我们需要的项；**不动你的 config.json** */
try {
  const base = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'dayu-pet', 'config.json'), 'utf8'));
  base.visionEnabled = true;
  base.visionKey = '';
  base.visionBase = '';
  base.visionModel = 'deepseek-flash';
  fs.writeFileSync(path.join(TEST_UD, 'config.json'), JSON.stringify(base, null, 2));
} catch (e) { console.log('拷 config 失败: ' + e.message); }
app.setPath('userData', TEST_UD);

const IMG = path.join(process.env.TEMP, 'vision-probe.png');

app.whenReady().then(async () => {
  const vision = require('../src/vision');
  const config = require('../src/config');
  const out = [];
  const L = (s) => out.push(s);
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  try {
    const cfg = config.load();
    L('=== 配置 ===');
    L('  model=' + (cfg.visionModel || '(默认)') + '  base=' + (cfg.visionBase || cfg.apiBase) + '  key=' + (cfg.visionKey || cfg.apiKey ? '已配置' : '❌ 缺'));
    if (!fs.existsSync(IMG)) { L('❌ 测试图不存在: ' + IMG); throw new Error('缺测试图'); }
    const buf = fs.readFileSync(IMG);
    const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
    L('  测试图 ' + Math.round(buf.length / 1024) + 'KB，内容是：文字「HELLO 7391」+ 红圆 + 蓝方块「BLUE BOX」');
    L('  （这张图是本机生成的，**不含你的屏幕内容**）');

    L('');
    L('=== 真调视觉模型（1 次） ===');
    const t0 = Date.now();
    let text = '', err = '';
    try {
      text = await vision.describe(cfg, dataUrl,
        '这张图里有什么？请说出所有能看到的文字，以及有哪些几何形状和它们的颜色。', 'low');
    } catch (e) { err = String((e && e.message) || e); }
    const ms = Date.now() - t0;
    L('  耗时 ' + ms + 'ms');
    if (err) {
      L('  ❌ 调用失败: ' + err);
      check('视觉模型可用', false, err.slice(0, 140));
      /* 失败也要判断是不是"模型不支持图片"这种可诊断的原因 */
      L('');
      L('  → 如果是 400/404 且提到 image/vision，说明当前模型不支持看图，');
      L('    需要在 config.json 里把 visionModel 换成支持多模态的模型。');
    } else {
      L('  模型回答:');
      String(text).split('\n').slice(0, 8).forEach((l) => L('    ' + l));
      check('视觉模型返回了内容', text.trim().length > 5, text.length + ' 字');
      const t = String(text);
      check('★ 认出了文字 HELLO 7391', /HELLO/i.test(t) && /7391/.test(t), (t.match(/HELLO[^\n]*/) || [''])[0].slice(0, 60));
      check('★ 认出了红色圆形', /红|red/i.test(t) && /圆|circle|ellipse|圆形/i.test(t), '');
      check('★ 认出了蓝色方块及其文字', /蓝|blue/i.test(t) && /方|square|rect|矩形|方块/i.test(t), (t.match(/[^\n]*BLUE[^\n]*/i) || [''])[0].slice(0, 60));
      check('没有乱编不存在的东西（提到图里没有的物体）',
        !/(猫|狗|汽车|人像|face|car)/.test(t), (t.match(/(猫|狗|汽车|人像)/g) || []).join(',') || '没有明显幻觉');
    }

    L('');
    L('=== 顺带确认 screen_look 在 visionEnabled=true 时会走视觉而不是 OCR ===');
    L('  （这条已经在 test-vision.js 用本地 mock 验过；这里只确认开关真的读得到）');
    check('visionEnabled 被读为 true', config.load().visionEnabled === true, String(config.load().visionEnabled));

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    var crashed = String((e && e.stack) || e);
    L('ERROR: ' + crashed);
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
