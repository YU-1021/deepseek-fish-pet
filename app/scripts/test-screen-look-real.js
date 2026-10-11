/* 真实屏幕 × 真实视觉模型：验证"看懂屏幕 + 给坐标"这条链路
 * electron.exe app\scripts\test-screen-look-real.js
 *
 * ⚠️ 这个测试会**真的截取你的屏幕并发给视觉模型**（因为要验证的就是这条链路）。
 *    它不改你的真实 config.json —— 而是拷一份副本、只在副本里把 visionEnabled 打开，
 *    所以测完你的配置仍然是关着的，不存在"忘了关"。
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const REAL_UD = path.join(process.env.APPDATA, 'dayu-pet');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-screenlook');
fs.mkdirSync(TEST_UD, { recursive: true });
const REAL_CFG = path.join(REAL_UD, 'config.json');
const before = fs.readFileSync(REAL_CFG, 'utf8');           // 留底，最后对比确认没被动过
const cfg = JSON.parse(before);
cfg.visionEnabled = true;
cfg.visionKey = '';
cfg.visionBase = '';
cfg.visionModel = 'deepseek-flash';
fs.writeFileSync(path.join(TEST_UD, 'config.json'), JSON.stringify(cfg, null, 2));
for (const f of ['persona.json']) {
  try { fs.copyFileSync(path.join(REAL_UD, f), path.join(TEST_UD, f)); } catch {}
}
app.setPath('userData', TEST_UD);

app.whenReady().then(async () => {
  const assistant = require('../src/assistant');
  const config = require('../src/config');
  const out = [];
  const L = (s) => out.push(s);
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  try {
    L('=== 前置 ===');
    const c = config.load();
    L('  测试副本 visionEnabled=' + c.visionEnabled + '  model=' + (c.visionModel || '默认'));
    L('  你的真实 config.json：visionEnabled = ' + JSON.parse(before).visionEnabled + '（本测试不改它）');
    check('副本里视觉是开的', c.visionEnabled === true);

    L('');
    L('=== 1. 看懂屏幕：让她描述当前画面 ===');
    const t0 = Date.now();
    const r1 = await assistant.run('screen_look', '屏幕上现在是什么？主要在显示什么内容？用两三句话说明。');
    const ms1 = Date.now() - t0;
    L('  截图 ' + (r1.image ? Math.round(r1.image.length / 1024) + 'KB' : '无') + '  耗时 ' + ms1 + 'ms');
    L('  她看到的：');
    String(r1.text || '').split('\n').slice(0, 10).forEach((l) => L('    ' + l));
    check('走了视觉模型（不是 OCR 降级）', /^👁/.test(String(r1.text)), String(r1.text).slice(0, 30));
    check('没有报视觉失败', !r1.visionErr, String(r1.visionErr || ''));
    check('描述有实质内容（>20 字）', String(r1.text).length > 20);
    check('没有乱编（描述里不该出现"无法查看/看不到）', !/无法查看|看不到|没有收到图/.test(String(r1.text)));

    L('');
    L('=== 2. 给坐标：让她找屏幕左下角的开始按钮 ===');
    const t1 = Date.now();
    const r2 = await assistant.run('screen_look',
      '看一下屏幕最左下角那个「开始」按钮（Windows 徽标），告诉我它中心的坐标，'
      + '并按格式输出一行 ACTION: move|x,y（坐标基于 1280x720 截图）。');
    const ms2 = Date.now() - t1;
    L('  耗时 ' + ms2 + 'ms');
    String(r2.text || '').split('\n').slice(0, 10).forEach((l) => L('    ' + l));
    L('  解析出的动作: ' + JSON.stringify(r2.action));
    check('给出了 ACTION（坐标链路可用）', !!r2.action, JSON.stringify(r2.action));
    if (r2.action) {
      const m = String(r2.action.arg).match(/(\d+)\s*,\s*(\d+)/);
      check('坐标格式是 x,y', !!m, r2.action.arg);
      if (m) {
        const x = Number(m[1]), y = Number(m[2]);
        L('    坐标 (' + x + ',' + y + ') → 屏幕占比 x=' + Math.round(x / 1280 * 100) + '% y=' + Math.round(y / 720 * 100) + '%');
        check('★ 开始按钮的坐标落在左下角区域（x<15%, y>80%）',
          x >= 0 && x < 1280 * 0.15 && y > 720 * 0.8, '(' + x + ',' + y + ')');
      }
      check('动作类型是 move（不会误点）', r2.action.tool === 'move', r2.action.tool);
    }

    L('');
    L('=== 3. 不改用户配置的确认 ===');
    const after = fs.readFileSync(REAL_CFG, 'utf8');
    check('★ 你的真实 config.json 一字未动', after === before,
      after === before ? '内容完全一致' : '❌ 被改动了！');
    check('你的真实配置仍是 visionEnabled=false', JSON.parse(after).visionEnabled === false,
      String(JSON.parse(after).visionEnabled));

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    var crashed = String((e && e.stack) || e);
    L('ERROR: ' + crashed);
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
