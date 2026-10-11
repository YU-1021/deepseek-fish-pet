/* 故障注入 / 健壮性测试
 *
 * 思路：正常路径都测过了，**坏路径**才是没人走的地方 —— 文件被写坏、网络断、脚本失控、
 * 用户粘了 10MB 文本。这些情况不会报"代码错"，但会让应用卡死/静默丢数据。
 *
 * electron.exe app\scripts\test-robust.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-robust');
fs.mkdirSync(TEST_UD, { recursive: true });
for (const f of ['config.json']) {
  try { fs.copyFileSync(path.join(process.env.APPDATA, 'dayu-pet', f), path.join(TEST_UD, f)); } catch {}
}
try { fs.unlinkSync(path.join(TEST_UD, 'clock-offset.json')); } catch {}
try { fs.rmSync(path.join(TEST_UD, 'memory'), { recursive: true, force: true }); } catch {}
try { fs.rmSync(path.join(TEST_UD, 'projects'), { recursive: true, force: true }); } catch {}
app.setPath('userData', TEST_UD);

app.whenReady().then(async () => {
  const out = [];
  const L = (s) => out.push(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  let crashed = '';

  try {
    const store = require('../src/store');
    const config = require('../src/config');
    const memory = require('../src/memory');
    const mood = require('../src/mood');
    const stats = require('../src/stats');
    const tokens = require('../src/tokens');
    const projects = require('../src/projects');
    const llm = require('../src/llm');

    /* ---------- 1. 存储文件被写坏 ---------- */
    L('=== 1. 存储文件被写坏（手工编辑/断电写坏/旧版本格式）===');
    const bad = '{ 这不是 JSON !!!';
    const cases = [
      ['memory/permanent.json', () => require('../src/memory/permanent').facts(), []],
      ['memory/long.json', () => require('../src/memory/long').list(), []],
      ['memory/medium.json', () => require('../src/memory/medium').list(), []],
      ['mood.json', () => mood.load(), null],
      ['memory/stats.json', () => stats.all(), null],
    ];
    for (const [file, fn, want] of cases) {
      const p = path.join(TEST_UD, file);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, bad);
      let ok = false, err = '', val = null;
      try { val = fn(); ok = true; } catch (e) { err = String((e && e.message) || e); }
      const usable = ok && val != null && !(Array.isArray(val) && val.length);
      check(file + ' 坏掉后不崩且回退到空/默认', usable, err || JSON.stringify(val).slice(0, 70));
    }
    /* store 是否把坏文件挪走（留证据，而不是静默丢掉用户数据） */
    const quarantined = fs.existsSync(path.join(TEST_UD, 'memory')) &&
      fs.readdirSync(path.join(TEST_UD, 'memory')).some((f) => /corrupt/.test(f));
    check('坏文件被隔离成 *.corrupt-*（不静默丢数据）', quarantined,
      fs.existsSync(path.join(TEST_UD, 'memory')) ? fs.readdirSync(path.join(TEST_UD, 'memory')).filter((f) => /corrupt/.test(f)).slice(0, 3).join(',') : 'memory 目录不存在');

    /* ---------- 2. config.json 被写坏 ---------- */
    L('');
    L('=== 2. config.json 被写坏 ===');
    const cfgPath = path.join(TEST_UD, 'config.json');
    fs.writeFileSync(cfgPath, 'not json at all');
    let c = null, cErr = '';
    try { c = config.load(); } catch (e) { cErr = String(e.message); }
    check('能加载且回退到默认值', !!c && !cErr, cErr || ('model=' + (c && c.model) + ' asrModel=' + (c && c.asrModel)));
    check('默认值里有 apiKey 字段（哪怕为空）', c && 'apiKey' in c);

    /* ---------- 3. 失控脚本：死循环狂打输出 ---------- */
    L('');
    L('=== 3. 失控脚本（死循环打输出）===');
    projects.writeOne('runaway.js', 'let i=0; while(true){ console.log(" spam ".repeat(200) + (i++)); }');
    const t0 = Date.now();
    let r3 = null, e3 = '';
    try { r3 = await projects.run('runaway.js', 4000); } catch (e) { e3 = String(e.message); }
    const ms3 = Date.now() - t0;
    check('超时后被强制结束（不永久挂住）', ms3 < 20000, ms3 + 'ms' + (e3 ? ' err=' + e3.slice(0, 60) : ''));
    if (r3) {
      check('输出被截断（不会把内存吃爆）', r3.output.length < 400000, 'output ' + r3.output.length + ' 字');
      check('标了 timeout', r3.timeout === true || r3.code === -1, 'code=' + r3.code + ' timeout=' + r3.timeout);
    } else {
      check('输出被截断（不会把内存吃爆）', false, '没跑起来');
      check('标了 timeout', false, e3.slice(0, 60));
    }
    /* 子进程真的死了吗（孤儿进程会一直烧 CPU） */
    await wait(600);
    const { execSync } = require('child_process');
    let alive = '';
    try { alive = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV', { encoding: 'utf8', timeout: 8000 }); } catch {}
    check('没有留下烧 CPU 的孤儿 node 进程', (alive.match(/node\.exe/gi) || []).length <= 2,
      '当前 node.exe 数=' + (alive.match(/node\.exe/gi) || []).length);

    /* ---------- 4. 超大输入 ---------- */
    L('');
    L('=== 4. 超大输入（粘 5MB 文本）===');
    const huge = 'x'.repeat(5 * 1024 * 1024);
    let t4 = 0, e4 = '';
    try { t4 = tokens.est(huge); } catch (e) { e4 = String(e.message); }
    check('token 估算不崩', !e4 && t4 > 0, e4 || ('est=' + t4));
    let clipOk = false, clipLen = 0;
    try { const c2 = tokens.clip(huge, 500); clipOk = typeof c2 === 'string' && c2.length <= 700; clipLen = c2.length; } catch (e) { e4 = String(e.message); }
    check('clip 能截断到上限', clipOk, 'len=' + clipLen);
    /* 单个超长单词（没有空格）不该让任何按词切分的逻辑卡死 */
    let noword = '';
    try { const c3 = tokens.clip('a'.repeat(200000), 100); noword = 'len=' + c3.length; } catch (e) { noword = 'ERR ' + e.message; }
    check('无空格超长串也能截断', /len=\d+/.test(noword), noword);

    /* ---------- 5. 网络与 HTTP 错误（本地 mock，不花 token）----------
     * ⚠️ 配置键是 **apiBase**（不是 baseUrl）。第一版我猜成 baseUrl，
     *   覆盖被静默忽略 → 请求打到**真实 DeepSeek 端点**、拿假 key 换了个 401，
     *   测试还"通过"了 —— 典型假阳性。所以这里用**本地 http 服务器**当模型端点，
     *   把 HTTP 层完整测掉（零 token），并专门加一条回归断言防再次打到真实端点。 */
    L('');
    L('=== 5. 网络与 HTTP 错误（本地 mock 服务器）===');
    const http = require('http');
    const srv = http.createServer((req, res) => {
      const u = req.url || '';
      const j = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.includes('/401/')) return j(401, { error: { message: 'Authentication Fails, Your api key is invalid' } });
      if (u.includes('/429/')) return j(429, { error: { message: 'Rate limit reached' } });
      if (u.includes('/500/')) return j(500, { error: { message: 'internal' } });
      if (u.includes('/notjson/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('<html>502 Bad Gateway</html>'); }
      if (u.includes('/ok/')) return j(200, { choices: [{ message: { content: 'EN: Hello there.\nZH: 你好。\nWORDS: hello=/həˈloʊ/=你好' } }] });
      if (u.includes('/empty/')) return j(200, { choices: [] });
      if (u.includes('/slow/')) return;                    // 永不响应 → 测超时
      res.writeHead(404); res.end('nope');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const at = (p, extra) => Object.assign({}, config.load(), { apiKey: 'sk-mock', apiBase: 'http://127.0.0.1:' + port + p, model: 'mock' }, extra || {});
    const msgs = [{ role: 'user', content: 'hi' }];
    const grab = async (cfg) => { try { return { ok: true, v: await llm.request(cfg, msgs) }; } catch (e) { return { ok: false, e: String((e && e.message) || e) }; } };

    const r401 = await grab(at('/401'));
    check('401 → 提示"API Key 无效"', !r401.ok && /API Key 无效|过期/.test(r401.e), r401.e);
    const r429 = await grab(at('/429'));
    check('429 → 提示"太频繁/限额"', !r429.ok && /太频繁|限额/.test(r429.e), r429.e);
    const r500 = await grab(at('/500'));
    check('500 → 提示"服务端错误，不是你的问题"', !r500.ok && /服务端内部错误/.test(r500.e), r500.e);
    const rNj = await grab(at('/notjson'));
    check('返回非 JSON（网关塞 HTML）→ 可读报错', !rNj.ok && !!rNj.e && !/undefined/.test(rNj.e), rNj.e.slice(0, 90));
    const rEmpty = await grab(at('/empty'));
    check('空 choices → 返回空串而不是崩', rEmpty.ok && rEmpty.v === '', rEmpty.ok ? JSON.stringify(rEmpty.v) : rEmpty.e);

    /* 正常路径：本地 mock 拿一句完整回复，再走 parseReply —— 整条链路零 token 验证 */
    const rOk = await grab(at('/ok'));
    check('正常返回能取到内容', rOk.ok && /Hello there/.test(rOk.v), JSON.stringify(rOk.v || rOk.e).slice(0, 80));
    if (rOk.ok) {
      const rep = llm.parseReply(rOk.v);
      check('parseReply 能解出 en/zh/words', rep.en === 'Hello there.' && rep.zh === '你好。' && rep.words.length === 1,
        JSON.stringify({ en: rep.en, zh: rep.zh, w: rep.words.length }));
    } else check('parseReply 能解出 en/zh/words', false, '上一步就失败了');

    /* 连不上（关掉服务器后的端口）—— 这才是真正的"网络不可用" */
    /* ⚠️ 别用 9 端口：它在 fetch 规范的**被禁端口黑名单**里（discard），undici 直接拒绝、
       连都不连，报的是 cause="bad port" —— 第一次就是这么写的，结果测出来的
       根本不是"连不上"，而我的分类逻辑也因此没被真正验证到。换一个没人监听的高端口。 */
    const closedPort = 59321;
    const dead = Object.assign({}, config.load(), { apiKey: 'sk-mock', apiBase: 'http://127.0.0.1:' + closedPort + '/v1', model: 'x' });
    const t5 = Date.now();
    let e5 = '';
    try { await llm.request(dead, msgs); } catch (e) { e5 = String((e && e.message) || e); }
    check('连不上时报错**快**且说人话（含地址）',
      Date.now() - t5 < 30000 && /连不上模型服务器|连接被拒绝/.test(e5) && e5.includes('127.0.0.1:' + closedPort),
      (Date.now() - t5) + 'ms  ' + e5.slice(0, 100));
    check('★ 没打到真实端点（假阳性回归）', !/deepseek\.com|Authentication Fails/i.test(e5),
      /deepseek|Authentication/i.test(e5) ? '❌ 又打到真实端点了' : 'ok');

    /* 被禁端口（真实用户可能配出来）也要说人话 */
    let eBad = '';
    try { await llm.request(Object.assign({}, config.load(), { apiKey: 'sk-mock', apiBase: 'http://127.0.0.1:9/v1', model: 'x' }), msgs); }
    catch (e) { eBad = String((e && e.message) || e); }
    check('被禁端口 → 提示"端口被安全策略禁止"', /端口被浏览器安全策略禁止/.test(eBad), eBad.slice(0, 100));

    /* 超时保护：mock 故意不响应，把超时压到 6 秒 */
    const t7 = Date.now();
    let e7t = '';
    try { await llm.request(at('/slow', { llmTimeoutMs: 6000 }), msgs); } catch (e) { e7t = String((e && e.message) || e); }
    check('永不响应 → 超时并给出可操作提示', /超时/.test(e7t) && Date.now() - t7 < 20000,
      ((Date.now() - t7) / 1000).toFixed(1) + 's ' + e7t.slice(0, 90));

    /* 没配 key 时不该发请求 */
    let e7b = '';
    try { await llm.request(Object.assign({}, config.load(), { apiKey: '' }), msgs); } catch (e) { e7b = String((e && e.message) || e); }
    check('没配 key 时立刻报错', /API Key/.test(e7b), e7b.slice(0, 60));
    try { srv.close(); } catch {}



    /* ---------- 6. 磁盘写入失败（目录被换成文件）---------- */
    L('');
    L('=== 6. 存储写入失败 ===');
    const memDir = path.join(TEST_UD, 'memory');
    try { fs.rmSync(memDir, { recursive: true, force: true }); fs.writeFileSync(memDir, 'blocker'); } catch {}
    let e8 = '';
    try { store.write('probe', { a: 1 }); } catch (e) { e8 = String(e.message); }
    let readBack = 'n/a';
    try { readBack = JSON.stringify(store.read('probe', { fallback: true })); } catch (e) { readBack = 'ERR ' + e.message; }
    check('写入失败不抛到调用方（内部吞掉并继续）', e8 === '', e8 || 'ok');
    check('读回来是 fallback（不返回脏数据）', /fallback/.test(readBack), readBack.slice(0, 60));
    try { fs.unlinkSync(memDir); } catch {}    // 还原成目录，免得影响后续
    try { fs.mkdirSync(memDir, { recursive: true }); } catch {}

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 300);
});
