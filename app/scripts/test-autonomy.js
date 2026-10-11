/* 自主性实测：遇到"她自己能解决的问题"，她是自己解决还是把球踢给主人？
 * electron.exe app\scripts\test-autonomy.js [--only=1,3]
 *
 * 用户反馈："感觉桌宠自主思考能力有点差，每次遇到一些简单问题问我解决，问得有点多"
 * 光看聊天记录不够（那阵子大半在排查启动器权限，她的"提问"其实是对的），所以**出题实测**。
 *
 * 走**最真实的路径**：直接调对话窗渲染层自己的 send()，让它跑自己的任务循环
 * （chatSend → assistantRun → chatContinue），聊天记录照常写进 memory/chatlog.json。
 * 这样测出来的行为 == 用户手打一样。
 *
 * 4 个场景：
 *   A 写文件   —— 完全可解，看她会不会反问路径/要不要写
 *   B 调试脚本 —— 预置少了冒号的 calc.py，看她会不会 读→改→跑
 *   C 找文件   —— 只给模糊描述，看她会不会先 list_dir，而不是问主人
 *   D 对照组   —— 故意说不清，**这里应该问主人**（这才是对的）
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const REAL = path.join(process.env.APPDATA, 'dayu-pet');
const T = path.join(process.env.APPDATA, 'dayu-pet-autonomy');
fs.mkdirSync(T, { recursive: true });
try {
  fs.copyFileSync(path.join(REAL, 'config.json'), path.join(T, 'config.json'));
  fs.copyFileSync(path.join(REAL, 'persona.json'), path.join(T, 'persona.json'));
} catch {}
try { fs.unlinkSync(path.join(T, 'clock-offset.json')); } catch {}
app.setPath('userData', T);
const WORK = 'C:\\deepseek\\pet-test';

app.whenReady().then(async () => {
  const M = require('../main.js');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const HANDOFF = [
    /你自己.*(试|点|弄|看|决定|选|跑)/, /你来(试|点|弄|决定|跑|看)/, /(请|麻烦)你/,
    /帮我(看|点|弄|试|确认|决定|跑)/, /你来决定/, /你告诉我/, /要(不要|不)我/,
    /you (should|need to|have to|decide|tell me|let me know)/i, /can you/i, /your call/i, /up to you/i,
  ];
  const GIVEUP = /(没(办法|法)|做不了|做不到|我(停手|不干了)|放弃|not going to|I'm done|give up|can't do|不行了)/i;
  const asksUser = (t) => HANDOFF.some((r) => r.test(t));
  const logFile = path.join(T, 'memory', 'chatlog.json');
  const readLog = () => { try { return (JSON.parse(fs.readFileSync(logFile, 'utf8')).entries) || []; } catch { return []; } };

  async function runScenario(id, title, prompt) {
    L('');
    L('──────────────────────────────────────────────');
    L('场景 ' + id + '：' + title);
    L('  主人说：' + prompt);
    const before = readLog().length;
    const w = M.win().chatWin;
    if (!w || w.isDestroyed()) throw new Error('对话窗不在');
    const sent = await w.webContents.executeJavaScript(
      'typeof send === "function" ? (send(' + JSON.stringify(prompt) + '), "ok") : "no-send-fn"');
    if (sent !== 'ok') { L('  ❌ 渲染层没有 send()：' + sent); return { id, title, asked: false, gaveUp: false, steps: 0 }; }
    /* 等她这条任务跑完：聊天记录条数稳定 8 秒就算结束（最多等 150 秒） */
    let stable = 0, last = before, waited = 0;
    while (waited < 150000) {
      await wait(2000); waited += 2000;
      const n = readLog().length;
      if (n === last && n > before) { stable += 1; if (stable >= 4) break; } else { stable = 0; last = n; }
    }
    const entries = readLog().slice(before);
    const mine = entries.filter((e) => e.who === 'pet');
    L('  本轮共 ' + entries.length + ' 条（她 ' + mine.length + ' 条），等了 ' + Math.round(waited / 1000) + ' 秒');
    for (const e of mine.slice(0, 6)) {
      L('   她：' + String(e.en || '').replace(/\n/g, ' ').slice(0, 165));
      if (e.zh) L('      中：' + String(e.zh).replace(/\n/g, ' ').slice(0, 115));
    }
    if (mine.length > 6) L('   （还有 ' + (mine.length - 6) + ' 条，看导出的完整记录）');
    const all = mine.map((e) => String(e.en || '') + '\n' + String(e.zh || '')).join('\n');
    const asked = asksUser(all);
    const gaveUp = GIVEUP.test(all);
    const acted = /ACTION|已(点击|滚动|输入|执行|打开|读取|写入|移动|新建|创建)|(写好了|改好了|跑完了|结果是|找到了|成功)/.test(all);
    L('  → 她发言 ' + mine.length + ' 条   把球踢给主人:' + (asked ? '是' : '否') + '   放弃:' + (gaveUp ? '是' : '否') + '   有动手痕迹:' + (acted ? '是' : '否'));
    return { id, title, prompt, asked, gaveUp, acted, count: mine.length, all };
  }

  try {
    await wait(4000);
    M.createChat();
    await wait(5000);
    fs.mkdirSync(WORK, { recursive: true });
    /* B：少了冒号，跑起来会 SyntaxError —— 完全能自己发现并修好 */
    fs.writeFileSync(path.join(WORK, 'calc.py'), 'def add(a, b)\n    return a + b\n\nprint(add(2, 3))\n', 'utf8');
    /* C：文件名不直白 */
    fs.writeFileSync(path.join(WORK, 'my-notes-2026.txt'), '这是主人的随手笔记。\nWiFi 密码：12345678\n', 'utf8');
    L('=== 题目准备好了：' + WORK + ' ===');

    const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
    const want = only ? only.split(',').map(Number) : [1, 2, 3, 4];
    const results = [];
    if (want.includes(1)) results.push(await runScenario(1, '写文件（完全可解：该直接写）',
      '帮我在 ' + WORK + ' 目录下新建一个 hello.txt，里面写一行 hello world。'));
    if (want.includes(2)) results.push(await runScenario(2, '调试脚本（完全可解：该 读→改→跑）',
      '帮我跑一下 ' + WORK + '\\calc.py，把输出告诉我。'));
    if (want.includes(3)) results.push(await runScenario(3, '找文件（该先自己找，别问我要路径）',
      '我之前在那个 pet-test 文件夹里记了点东西，帮我找出来读给我听。'));
    if (want.includes(4)) results.push(await runScenario(4, '对照组：故意说不清（这里**应该**问我）',
      '那个东西帮我弄一下吧。'));

    L('');
    L('════════════════ 汇总 ════════════════');
    for (const r of results) {
      L('  ' + r.id + '. ' + String(r.title).slice(0, 20).padEnd(22)
        + ' 她说了 ' + String(r.count).padEnd(3) + ' 条   踢球:' + (r.asked ? '是' : '否')
        + '  放弃:' + (r.gaveUp ? '是' : '否') + '  动手:' + (r.acted ? '是' : '否'));
    }
    const should = results.filter((r) => r.id !== 4);
    const bad = should.filter((r) => r.asked || r.gaveUp).length;
    L('');
    L('  ★ 该自己解决的 ' + should.length + ' 个场景里，把球踢回去/放弃的有 ' + bad + ' 个');
    const ctrl = results.find((r) => r.id === 4);
    if (ctrl) L('  ★ 该问人的对照组：' + (ctrl.asked ? '问了 ✓（这是对的）' : '没问 ✗（该问却不问，同样不好）'));

    /* 把完整对话导出，便于人看 */
    try {
      const all = readLog();
      const dst = path.join(WORK, '自主性实测-聊天记录.json');
      fs.writeFileSync(dst, JSON.stringify({ at: Date.now(), results: results.map((r) => ({ id: r.id, title: r.title, asked: r.asked, gaveUp: r.gaveUp, acted: r.acted })), entries: all }, null, 2), 'utf8');
      L('  完整聊天记录已导出: ' + dst + '（' + all.length + ' 条）');
    } catch (e) { L('  导出失败: ' + ((e && e.message) || e)); }
  } catch (e) {
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit(0), 400);
});
