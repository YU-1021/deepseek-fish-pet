const path = require('path'); const fs = require('fs'); const { app } = require('electron');
const REAL_UD = path.join(process.env.APPDATA, 'dayu-pet');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-thinking');
fs.mkdirSync(TEST_UD, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(REAL_UD, 'config.json'), 'utf8'));
fs.writeFileSync(path.join(TEST_UD, 'config.json'), JSON.stringify(cfg, null, 2));
app.setPath('userData', TEST_UD);
app.whenReady().then(async () => {
  const out = []; const L = (s) => { out.push(s); process.stdout.write(s + '\n'); };
  try {
    const c = require('../src/config').load();
    const cap = await require('../src/screenstream').grabFrame();
    const base = String(c.apiBase).replace(/\/+$/, '');
    const Q = '看一下屏幕最左下角那个「开始」按钮（Windows 徽标），告诉我它中心的坐标，'
      + '并按格式输出一行 ACTION: move|x,y（坐标基于 1280x720 截图）。';
    const mk = (extra) => Object.assign({
      model: c.visionModel || 'deepseek-flash', temperature: 0.2,
      messages: [{ role: 'user', content: [{ type: 'text', text: Q }, { type: 'image_url', image_url: { url: cap.dataUrl, detail: 'low' } }] }],
    }, extra || {});
    for (const [name, extra] of [
      ['当前实现（不带 thinking 参数）', {}],
      ['thinking 显式关闭', { thinking: { type: 'disabled' } }],
      ['当前实现 第二次', {}],
      ['thinking 关闭 第二次', { thinking: { type: 'disabled' } }],
    ]) {
      const t = Date.now();
      try {
        const r = await fetch(base + '/chat/completions', { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
          body: JSON.stringify(mk(extra)), signal: AbortSignal.timeout(120000) });
        const j = await r.json();
        const txt = (j.choices && j.choices[0] && j.choices[0].message.content) || '';
        const rt = j.choices && j.choices[0] && j.choices[0].message.reasoning_content;
        L('  ' + name + ': ' + (Date.now() - t) + 'ms  输出 ' + txt.length + ' 字' +
          '  usage=' + JSON.stringify(j.usage && { in: j.usage.prompt_tokens, out: j.usage.completion_tokens }) +
          (rt ? '  ⚠ 有 reasoning_content ' + rt.length + ' 字' : ''));
        L('      → ' + txt.replace(/\n/g, ' ').slice(0, 70));
      } catch (e) { L('  ' + name + ': 错误 ' + String(e.message).slice(0, 70)); }
    }
  } catch (e) { L('ERROR: ' + e.stack); }
  console.log(out.join('\n'));
  setTimeout(() => app.exit(0), 200);
});
