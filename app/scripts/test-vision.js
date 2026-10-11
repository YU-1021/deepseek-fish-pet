/* 视觉 / 看屏幕验证
 * electron.exe app\scripts\test-vision.js
 *
 * 策略：HTTP 层全部用**本地 mock 服务器**（零视觉 token、确定性）；
 *       抓屏与 OCR 走真实路径（这是功能本身）。
 * 注意：会真的截取你的屏幕（截图只落在临时文件与内存里，不会外传，除非走真实视觉模型）。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-visiontest');
fs.mkdirSync(TEST_UD, { recursive: true });
try { fs.unlinkSync(path.join(TEST_UD, 'clock-offset.json')); } catch {}
app.setPath('userData', TEST_UD);

/* 1x1 红色 PNG，当测试图片用 */
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

app.whenReady().then(async () => {
  const vision = require('../src/vision');
  const config = require('../src/config');
  const assistant = require('../src/assistant');
  const out = [];
  const L = (s) => out.push(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  /* mock：按路径给不同响应；/ok 会回显它收到了几张图 */
  let lastBody = null;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      lastBody = raw;
      const u = req.url || '';
      const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.includes('/401/')) return j(401, { error: { message: 'Authentication Fails: invalid api key' } });
      if (u.includes('/500/')) return j(500, { error: { message: 'internal error' } });
      if (u.includes('/badjson/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('<html>502</html>'); }
      if (u.includes('/slow/')) return;   // 永不响应
      if (u.includes('/ok/')) return j(200, { choices: [{ message: { content: '屏幕上是桌面，左上角有个开始按钮。\nACTION: click|640,360' } }] });
      if (u.includes('/plain/')) return j(200, { choices: [{ message: { content: '屏幕上是代码编辑器。' } }] });
      res.writeHead(404); res.end('nope');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const at = (p, extra) => Object.assign({}, config.load(), { visionKey: '', apiKey: 'sk-mock', apiBase: 'http://127.0.0.1:' + port + p, visionModel: 'mock' }, extra || {});

  try {
    L('=== 1. 没配 key/地址时要给明确错误（不能静默）===');
    for (const [name, cfg] of [
      ['全空', { visionKey: '', apiKey: '', visionBase: '', apiBase: '' }],
      ['只有地址没 key', { visionKey: '', apiKey: '', visionBase: 'http://x', apiBase: 'http://x' }],
    ]) {
      let err = '';
      try { await vision.describe(cfg, PNG_1PX, '这是什么'); } catch (e) { err = String((e && e.message) || e); }
      check(name + ' → 报"未配置视觉模型"', /未配置视觉模型/.test(err), err.slice(0, 70));
    }

    L('');
    L('=== 2. 请求体要真的带上图片（多模态格式）===');
    const okText = await vision.describe(at('/ok'), PNG_1PX, '屏幕上是啥？', 'low');
    check('拿到回复', /开始按钮/.test(okText), okText.slice(0, 60).replace(/\n/g, ' '));
    check('回复里带着 ACTION 行（screen_look 要靠它操作）', /ACTION:\s*click\|640,360/i.test(okText));
    const body = JSON.parse(lastBody || '{}');
    check('请求体是 chat/completions 格式', Array.isArray(body.messages) && !!body.model, 'model=' + body.model);
    const content = body.messages && body.messages[0] && body.messages[0].content;
    check('content 是数组（多模态）', Array.isArray(content), typeof content);
    check('带上了 text 段', Array.isArray(content) && content.some((x) => x.type === 'text' && x.text));
    check('★ 带上了 image_url 段（真的把图发出去了）',
      Array.isArray(content) && content.some((x) => x.type === 'image_url' && String((x.image_url || {}).url).startsWith('data:image/png')),
      JSON.stringify(content && content.map((x) => x.type)));
    check('detail 传下去了', Array.isArray(content) && content.some((x) => x.type === 'image_url' && x.image_url.detail === 'low'));
    check('温度低（看图要稳）', body.temperature <= 0.5, 'temperature=' + body.temperature);

    L('');
    L('=== 3. HTTP / 网络错误要说人话（复用 llm.js 的翻译）===');
    const cases = [
      ['/401/', /API Key 无效|过期/, '401'],
      ['/500/', /服务端/, '500'],
      ['/badjson/', /JSON|请求失败/, '返回非 JSON'],
    ];
    for (const [p, re, name] of cases) {
      let err = '';
      try { await vision.describe(at(p), PNG_1PX, 'q'); } catch (e) { err = String((e && e.message) || e); }
      check(name + ' → 可读报错', re.test(err) && !/^\s*HTTP \d+ \{/.test(err), err.slice(0, 90));
    }
    let netErr = '';
    try { await vision.describe(Object.assign({}, config.load(), { visionKey: '', apiKey: 'sk-mock', apiBase: 'http://127.0.0.1:59322/v1' }), PNG_1PX, 'q'); }
    catch (e) { netErr = String((e && e.message) || e); }
    check('连不上 → 提示连接被拒绝并带地址', /连接被拒绝/.test(netErr) && netErr.includes('59322'), netErr.slice(0, 90));
    let toErr = '';
    const tTo = Date.now();
    try { await vision.describe(at('/slow/', { visionTimeoutMs: 5000 }), PNG_1PX, 'q'); } catch (e) { toErr = String((e && e.message) || e); }
    check('永不响应 → 超时且提示可操作', /超时/.test(toErr) && Date.now() - tTo < 20000, ((Date.now() - tTo) / 1000).toFixed(1) + 's ' + toErr.slice(0, 70));

    L('');
    L('=== 4. screen_shot：真截屏 + OCR（走真实路径）===');
    const shot = await assistant.run('screen_shot', '');
    check('返回了文本', !!shot && typeof shot.text === 'string' && shot.text.length > 5, String(shot && shot.text).slice(0, 80).replace(/\n/g, ' '));
    check('返回了图片 dataURL', !!(shot && shot.image) && shot.image.startsWith('data:image/'), String(shot && shot.image).slice(0, 30));
    check('图片不是空壳（>5KB base64）', shot && shot.image && shot.image.length > 5000, shot && shot.image ? Math.round(shot.image.length / 1024) + 'KB' : '');
    /* 截屏用的是 JPEG（screen-*.jpg，体积小），不是 PNG —— 第一版我按 PNG 魔数断言，
       结果"图片不是 PNG"这条误报。两种都接受。 */
    check('图片真的是 JPEG/PNG（魔数对得上）', (() => {
      let crashed = '';
      try {
        const head = Buffer.from(shot.image.split(',')[1], 'base64').slice(0, 4);
        const isPng = head.toString('hex') === '89504e47';
        const isJpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
        return isPng || isJpg;
      } catch { return false; }
    })(), String(shot && shot.image).slice(0, 24));
    if (shot && shot.path) check('截图文件也落盘了', fs.existsSync(shot.path), path.basename(shot.path));
    check('没识别到文字时也有兜底文案（不是空串）', !!(shot && shot.text && shot.text.trim().length), String(shot && shot.text).slice(0, 60));

    L('');
    L('=== 5. screen_look：关掉视觉时降级到 OCR，并且**说明原因** ===');
    const cfgOff = Object.assign({}, config.load(), { visionEnabled: false });
    config.save({ visionEnabled: false });
    const lookOff = await assistant.run('screen_look', '看看屏幕');
    check('返回文本', !!(lookOff && lookOff.text), String(lookOff && lookOff.text).slice(0, 70).replace(/\n/g, ' '));
    check('说明了 visionEnabled 是关的（不让人猜）', /visionEnabled|视觉/.test(String(lookOff && lookOff.text)), String(lookOff && lookOff.text).slice(-90).replace(/\n/g, ' '));
    check('没有返回 action（没看图当然不该乱操作）', !lookOff.action, JSON.stringify(lookOff.action));

    L('');
    L('=== 6. screen_look：视觉失败必须**报出原因**（以前是静默吞掉）===');
    config.save({ visionEnabled: true, apiBase: 'http://127.0.0.1:59323/v1', apiKey: 'sk-mock', visionKey: '', visionModel: 'mock' });
    const lookFail = await assistant.run('screen_look', '看看屏幕');
    const ft = String(lookFail && lookFail.text || '');
    check('★ 提示了"视觉模型调用失败，已降级为 OCR"', /视觉模型调用失败/.test(ft), ft.slice(-140).replace(/\n/g, ' '));
    check('★ 带上了失败原因（连接被拒绝之类）', /连接被拒绝|超时|API Key|服务端/.test(ft), ft.slice(-140).replace(/\n/g, ' '));
    check('visionErr 字段也回传了', !!lookFail.visionErr, String(lookFail.visionErr).slice(0, 80));

    L('');
    L('=== 7. screen_look：视觉正常时要能解析出 ACTION ===');
    config.save({ visionEnabled: true, apiBase: 'http://127.0.0.1:' + port + '/ok', apiKey: 'sk-mock', visionKey: '', visionModel: 'mock' });
    const lookOk = await assistant.run('screen_look', '看看屏幕');
    check('用了视觉模型（前缀是 👁）', /^👁/.test(String(lookOk && lookOk.text)), String(lookOk && lookOk.text).slice(0, 40).replace(/\n/g, ' '));
    check('解析出了 ACTION', !!lookOk.action && lookOk.action.tool === 'click' && lookOk.action.arg === '640,360', JSON.stringify(lookOk.action));
    check('没有 visionErr', !lookOk.visionErr, String(lookOk.visionErr || ''));
    /* 回复里没有 ACTION 时不该凭空造一个 */
    config.save({ visionEnabled: true, apiBase: 'http://127.0.0.1:' + port + '/plain', apiKey: 'sk-mock', visionKey: '', visionModel: 'mock' });
    const lookPlain = await assistant.run('screen_look', '看看屏幕');
    check('回复里没有 ACTION 时不乱造动作', !lookPlain.action, JSON.stringify(lookPlain.action));
    check('但仍然给出了视觉描述', /代码编辑器/.test(String(lookPlain.text)), String(lookPlain.text).slice(0, 60).replace(/\n/g, ' '));

    L('');
    L('=== 8. ACTION 里出现非法工具名要被忽略（不能让视觉模型直接操控）===');
    const badSrv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '好的。\nACTION: 危险工具|rm -rf /' } }] }));
    });
    await new Promise((r) => badSrv.listen(0, '127.0.0.1', r));
    config.save({ visionEnabled: true, apiBase: 'http://127.0.0.1:' + badSrv.address().port, apiKey: 'sk-mock', visionKey: '', visionModel: 'mock' });
    const lookBad = await assistant.run('screen_look', '看看');
    check('非法工具名被忽略（不返回 action）', !lookBad.action, JSON.stringify(lookBad.action));
    badSrv.close();

    try { srv.close(); } catch {}
    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 300);
});
