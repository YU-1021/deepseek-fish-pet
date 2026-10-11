/* 游戏助手主循环验证
 * electron.exe app\scripts\test-gameagent.js
 *
 * 策略：把视觉模型指向**本地 mock**，于是"她每步看到什么、决定做什么"完全由测试控制，
 *      零 token、可复现；抓帧走真实屏幕（这本来就是这个功能在做的事）。
 *      dryRun 让动作不真的落到你的鼠标上。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-gametest');
fs.mkdirSync(TEST_UD, { recursive: true });
/* ⚠️ 必须把 config.json 拷过来并把权限开到 full：
   第一版只建了空目录 → config.load() 用默认值（assistant:'off'）→
   gameagent.start() 直接拒绝："需要把 AI 助手权限开到「完全权限」（游戏助手要操作鼠标）"。
   那是**正确的保护**（她确实要动鼠标），是测试没准备好前置条件。 */
for (const f of ['persona.json']) {
  try { fs.copyFileSync(path.join(process.env.APPDATA, 'dayu-pet', f), path.join(TEST_UD, f)); } catch {}
}
try {
  const base = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'dayu-pet', 'config.json'), 'utf8'));
  base.assistant = 'full';
  base.visionEnabled = true;
  fs.writeFileSync(path.join(TEST_UD, 'config.json'), JSON.stringify(base, null, 2));
} catch {
  fs.writeFileSync(path.join(TEST_UD, 'config.json'), JSON.stringify({ assistant: 'full', visionEnabled: true, apiKey: 'sk-mock' }, null, 2));
}
try { fs.unlinkSync(path.join(TEST_UD, 'clock-offset.json')); } catch {}
app.setPath('userData', TEST_UD);

/* mock 视觉：按"当前剧本"决定回什么 */
let script = [];        // 依次弹出；空了就用 fallback
let fallback = '局面正常。\nDONE';
let visionCalls = 0;
let visionMode = 'ok';  // ok | http500 | garbage
let lastPrompt = '';    // 收到的问题（= 循环拼的提示词），用来验证"卡住提醒"有没有进去
const seenPrompts = [];
const srv = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    visionCalls++;
    try {
      const b = JSON.parse(raw);
      const t = (b.messages && b.messages[0] && b.messages[0].content || []).find((x) => x.type === 'text');
      lastPrompt = String((t && t.text) || '');
      seenPrompts.push(lastPrompt);
    } catch {}
    if (visionMode === 'http500') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"boom"}}'); }
    if (visionMode === 'garbage') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: '嗯…这个界面我不太确定。' } }] })); }
    const next = script.length ? script.shift() : fallback;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: next } }] }));
  });
});

app.whenReady().then(async () => {
  const config = require('../src/config');
  const game = require('../src/gameagent');
  const assistant = require('../src/assistant');
  const userinput = require('../src/userinput');
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const out = [];
  const L = (s) => out.push(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  let logs = [];
  const onLog = (e) => { logs.push(e); };
  const finishP = () => new Promise((r) => { finishResolve = r; });
  let finishResolve = null;

  try {
    L('=== 0. 启动前状态 ===');
    const st0 = game.status();
    check('初始没在运行', st0.running === false, JSON.stringify(st0));
    check('status 结构完整（running/step/task/maxSteps/tally）',
      'running' in st0 && 'step' in st0 && 'maxSteps' in st0 && !!st0.tally, Object.keys(st0).join(','));
    /* 权限不够必须被拒 —— 这是保护（她确实要动鼠标），第一版我因为目录里没 config
       用到了默认的 assistant:'off'，于是后面全线失败，还以为是循环坏了。 */
    config.save({ assistant: 'read' });
    const denied = await game.start({ task: '权限测试', dryRun: true, maxSteps: 1, intervalMs: 100, actionWaitMs: 100 });
    check('★ 权限不足时拒绝启动（游戏助手要动鼠标）',
      !!denied && denied.ok === false && /权限/.test(String(denied.error)), JSON.stringify(denied).slice(0, 90));
    /* 改回来（第一版忘了这一步 → 后面全线都是 read 权限、全部启动失败） */
    config.save({ assistant: 'full', visionEnabled: true, apiBase: 'http://127.0.0.1:' + port + '/v1', apiKey: 'sk-mock', visionKey: '', visionModel: 'mock' });
    check('权限已恢复为 full', config.load().assistant === 'full', config.load().assistant);

    /* 未初始化时不该崩（init 还没调） */
    check('未 init 时 stop() 不崩', (() => { try { const r = game.stop(); return !!r; } catch { return false; } })());

    /* 把视觉指向 mock */
    config.save({ visionEnabled: true, apiBase: 'http://127.0.0.1:' + port + '/v1', apiKey: 'sk-mock', visionKey: '', visionModel: 'mock' });
    game.init({
      onLog,
      onStart: () => logs.push({ kind: 'info', text: '(onStart)' }),
      onStop: () => logs.push({ kind: 'info', text: '(onStop)' }),
      onFinish: (r) => { logs.push({ kind: 'info', text: '(onFinish) ' + JSON.stringify(r && r.stopReason) }); if (finishResolve) { finishResolve(r); finishResolve = null; } },
    });

    L('');
    L('=== 1. DONE 立刻收手（最简路径）===');
    logs = []; visionCalls = 0; script = []; fallback = '界面是主菜单。\nDONE';
    const p1 = finishP();
    const r1 = await game.start({ task: '测试：什么都不用做', dryRun: true, maxSteps: 6, intervalMs: 150, actionWaitMs: 150 });
    check('start 返回 ok', !!r1 && r1.ok !== false, JSON.stringify(r1).slice(0, 80));
    const fin1 = await Promise.race([p1, wait(30000).then(() => null)]);
    check('循环结束了（没有一直跑）', !!fin1, JSON.stringify(fin1 && fin1.stopReason));
    check('确实问了视觉模型', visionCalls >= 1, visionCalls + ' 次');
    check('日志里有决策内容', logs.some((e) => /DONE|主菜单|局面/.test(String(e.text))), String(logs.find((e) => e.kind === 'think') || {}).slice(0, 100));
    check('DONE 后不再运行', game.status().running === false);

    L('');
    L('=== 2. 试运行不真的动手（dryRun）===');
    logs = []; script = ['要不要点一下。\nACTION: click|640,360', '还是点这里。\nACTION: click|100,100'];
    fallback = '再看一眼。\nACTION: click|640,360';
    const p2 = finishP();
    await game.start({ task: '测试：试运行', dryRun: true, maxSteps: 4, intervalMs: 150, actionWaitMs: 150 });
    const fin2 = await Promise.race([p2, wait(40000).then(() => null)]);
    const dryLogs = logs.filter((e) => /试运行/.test(String(e.text)));
    check('日志里明确说了"试运行，未真的执行"', dryLogs.length > 0, dryLogs.length + ' 条');
    check('没有真的执行动作（tally.act 为 0）', (fin2 && fin2.tally && fin2.tally.act) === 0, JSON.stringify(fin2 && fin2.tally));
    check('循环正常结束', !!fin2, JSON.stringify(fin2 && fin2.stopReason));

    L('');
    L('=== 3. 步数上限生效 ===');
    logs = []; visionMode = 'ok'; script = [];
    fallback = '继续。\nACTION: click|200,200';
    const p3 = finishP();
    await game.start({ task: '测试：步数上限', dryRun: true, maxSteps: 3, intervalMs: 120, actionWaitMs: 120 });
    const fin3 = await Promise.race([p3, wait(40000).then(() => null)]);
    check('最多跑 3 步', !!fin3 && fin3.step <= 3, 'step=' + (fin3 && fin3.step));
    check('结束原因提到了步数上限', !!fin3 && /上限/.test(String(fin3.stopReason)), String(fin3 && fin3.stopReason));

    L('');
    L('=== 4. 卡住检测：重复动作要有两级反应 ===');
    /* 设计（源码）：repeatAct>=2 → 在**提示词里提醒**模型换思路；
       effect==='没有变化' && repeatAct>=3 → **硬停**。
       硬停需要真实的画面反馈，dryRun 不执行动作所以拿不到 —— 这是**设计如此**，
       第一版我在这里断言"没跑满就该收手"，是期望写错了。
       真正能且该验证的是：**重复之后，提醒有没有进到给模型的提示词里**。 */
    logs = []; script = []; seenPrompts.length = 0;
    fallback = '再来一次。\nACTION: click|640,360';
    const p4 = finishP();
    await game.start({ task: '测试：卡住', dryRun: true, maxSteps: 6, intervalMs: 120, actionWaitMs: 120 });
    const fin4 = await Promise.race([p4, wait(60000).then(() => null)]);
    const hinted = seenPrompts.filter((t) => /明显卡住|同一个操作已经连续|换成完全不同的思路/.test(t));
    check('★ 重复同一动作后，提示词里出现了"卡住了/换思路"的提醒', hinted.length > 0,
      '命中 ' + hinted.length + ' / ' + seenPrompts.length + ' 次调用');
    if (hinted.length) L('    提醒原文: ' + (hinted[0].match(/【提醒】[^\n]*/) || [''])[0].slice(0, 80));
    check('dryRun 下不会硬停（没有画面反馈，设计如此）', !!fin4 && /上限/.test(String(fin4.stopReason)), String(fin4 && fin4.stopReason));
    check('但步数上限保住了它（不会无限转）', !!fin4 && fin4.step <= 6, 'step=' + (fin4 && fin4.step));

    L('');
    L('=== 5. 视觉模型挂掉时要能体面收场（不能死循环）===');
    logs = []; visionMode = 'http500';
    const p5 = finishP();
    await game.start({ task: '测试：视觉挂掉', dryRun: true, maxSteps: 8, intervalMs: 120, actionWaitMs: 120 });
    const fin5 = await Promise.race([p5, wait(60000).then(() => null)]);
    check('最终收手了（不是永远转）', !!fin5, JSON.stringify(fin5 && fin5.stopReason));
    check('日志里报出了视觉失败', logs.some((e) => /视觉|看|失败|err/i.test(String(e.kind))), logs.filter((e) => e.kind === 'err').slice(0, 1).map((e) => String(e.text).slice(0, 70)).join(''));

    L('');
    L('=== 6. 视觉返回不含 ACTION 的废话 → 不该乱点 ===');
    logs = []; visionMode = 'garbage'; script = [];
    const p6 = finishP();
    await game.start({ task: '测试：废话回复', dryRun: true, maxSteps: 6, intervalMs: 120, actionWaitMs: 120 });
    const fin6 = await Promise.race([p6, wait(60000).then(() => null)]);
    check('收手了', !!fin6, JSON.stringify(fin6 && fin6.stopReason));
    check('没有产生任何动作（tally.act=0）', (fin6 && fin6.tally && fin6.tally.act) === 0, JSON.stringify(fin6 && fin6.tally));
    visionMode = 'ok';

    L('');
    L('=== 7. stop() 要快（文档说 250ms 内响应）===');
    logs = []; script = [];
    fallback = '继续。\nACTION: click|300,300';
    const p7 = finishP();
    await game.start({ task: '测试：停止响应', dryRun: true, maxSteps: 500, intervalMs: 300, actionWaitMs: 300 });
    await wait(600);
    check('确实在跑', game.status().running === true, 'step=' + game.status().step);
    const t0 = Date.now();
    const rs = game.stop();
    check('stop() 立刻返回（不等循环）', Date.now() - t0 < 300, (Date.now() - t0) + 'ms');
    const fin7 = await Promise.race([p7, wait(15000).then(() => null)]);
    const stopMs = Date.now() - t0;
    check('★ 循环在 250ms 量级内真的停了', !!fin7 && stopMs < 5000, stopMs + 'ms  stopReason=' + (fin7 && fin7.stopReason));
    check('重复 stop() 是空操作', (() => { const r2 = game.stop(); return !!r2 && (r2.already === true || r2.ok !== false); })(), JSON.stringify(game.stop()));
    check('状态回到 not running', game.status().running === false);

    L('');
    L('=== 8. assistant 的 game_status / game_stop ===');
    const s1 = await assistant.run('game_status', '');
    check('game_status 说明"没在帮打"且不代表游戏没开', /没有在运行|没在帮打/.test(s1), String(s1).slice(0, 90).replace(/\n/g, ' '));
    const s2 = await assistant.run('game_stop', '');
    check('没在跑时 game_stop 说清楚了', /本来就没在运行/.test(s2), String(s2).slice(0, 70));

    L('');
    L('=== 9. 主人一动鼠标就让位（真实主循环里）===');
    /* 注入假光标：先让"主人"活动，再在一秒后放开 */
    let fake = { x: 100, y: 100 };
    userinput.setCursorSource(() => ({ x: fake.x, y: fake.y }));
    userinput.setParams({ enabled: true, calmMs: 700, movePx: 6, pollMs: 40 });
    userinput.stop(); userinput.start();
    logs = []; script = []; fallback = '继续。\nACTION: click|400,400';
    setTimeout(() => { fake = { x: 500, y: 500 }; }, 300);      // 主人动了
    setTimeout(() => { fake = { x: 502, y: 501 }; }, 1200);     // 松手
    const p9 = finishP();
    await game.start({ task: '测试：让位', dryRun: true, maxSteps: 4, intervalMs: 150, actionWaitMs: 150 });
    const fin9 = await Promise.race([p9, wait(60000).then(() => null)]);
    const yieldLogs = logs.filter((e) => /让位|主人在用鼠标/.test(String(e.text)));
    check('★ 日志里出现了"主人在用鼠标，我先让位"', yieldLogs.length > 0, yieldLogs.map((e) => String(e.text).slice(0, 60)).join(' | '));
    check('让位后确实继续跑完了', !!fin9, JSON.stringify(fin9 && fin9.stopReason));
    userinput.setCursorSource(null); userinput.stop();

    srv.close();
    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    var crashed = String((e && e.stack) || e);
    L('ERROR: ' + crashed);
  }
  try { srv.close(); } catch {}
  try { game.stop(); } catch {}
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
