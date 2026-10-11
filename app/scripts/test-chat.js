/* 长期对话测试驱动器
 *
 * 用法（**必须先停掉正在跑的桌宠**，因为 main.js 有单实例锁）：
 *   Remove-Item env:ELECTRON_RUN_AS_NODE
 *   electron.exe app\scripts\test-chat.js --days=3 --turns=3
 *
 * 它做的事：
 *   1. require('../main.js') —— **启动真应用**，用的是完全相同的管线与 userData
 *   2. 按剧本逐天多轮对话（走 buildSystemPrompt + memory.pickHistory + genReply + memory.onTurn）
 *   3. 每天结束调 memory.onSessionEnd()，触发真正的收尾（摘要/事实/经验/判数值）
 *   4. 换天：平移时钟 + 跑一次 onAppStart()（模拟"关掉应用第二天再打开"）
 *   5. 每轮都断言"前言不搭后语"（用固定问题问已知答案）+ 打印记忆状态
 *   6. 结束输出 testlog 聚合分析（找异常数据）
 */
const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');

/* ⚠️ 用**独立的 userData 目录**跑测试：
 *   否则测试事实（小林/豆豆/上海出差）会写进你真实的记忆里，把你的桌宠"教歪"。
 *   代码路径、人设、配置完全一致，所以行为就是真实行为，只是数据隔离。
 *   app.setPath 必须在 require('../main.js') **之前**调用，否则 main.js 里的路径已经定死了。 */
const REAL_UD = path.join(process.env.APPDATA, 'dayu-pet');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-test');
fs.mkdirSync(TEST_UD, { recursive: true });
/* 只拷"让它能跑起来 + 人设一致"的文件；记忆/数值一律从零开始，方便对照预期 */
for (const f of ['config.json', 'persona.json']) {
  try { fs.copyFileSync(path.join(REAL_UD, f), path.join(TEST_UD, f)); } catch {}
}
try { fs.unlinkSync(path.join(TEST_UD, 'clock-offset.json')); } catch {}   // 时钟复位
app.setPath('userData', TEST_UD);

require('../main.js');          // ← 启动真应用（注册 IPC、建窗口、初始化记忆）

const args = {};
process.argv.slice(2).forEach((a) => {
  const m = a.match(/^--([^=]+)=?(.*)$/);
  if (m) args[m[1]] = m[2] === '' ? true : m[2];
});
const DAYS = Math.max(1, Number(args.days) || 3);
const TURNS = Math.max(1, Number(args.turns) || 3);
const FRESH = args.fresh === '1' || args.fresh === true;   // --fresh=1 清空测试数据从零开始
if (FRESH) {
  try {
    fs.rmSync(path.join(TEST_UD, 'memory'), { recursive: true, force: true });
    for (const f of ['mood.json', 'vocab.json', 'speak-log.json', 'ipa-cache.json', 'testlog.jsonl']) {
      try { fs.unlinkSync(path.join(TEST_UD, f)); } catch {}
    }
  } catch {}
}

const out = [];
const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };

/* 剧本：每天一组。问句里带"已知答案"，用来抓前言不搭后语/记忆丢失 */
const SCRIPT = [
  { // 第 1 天
    label: '建立事实',
    turns: [
      '我叫小林，你可要记住了。',
      '我养了一只猫，叫豆豆，它特别爱吃鱼。',
      '对了，我叫什么名字？我养的是什么？',
    ],
  },
  { // 第 2 天
    label: '跨天回忆',
    turns: [
      '我下周要去上海出差三天。',
      '我叫什么来着？我那只猫叫什么？',
      '上海那边我该带点什么？',
    ],
  },
  { // 第 3 天
    label: '长期记忆 + 一致性',
    turns: [
      '我出差回来了，累死了。',
      '你还记得我去哪了吗？我家那只小家伙叫什么？',
      '帮我列一个"回家要做的事"清单，写进一个 txt 文件里。',
    ],
  },
  { // 第 4 天（如果 days>=4）
    label: '更远回忆',
    turns: [
      '我下周还要再去一趟，你记得是去哪吗？',
      '我叫什么？我养了什么？',
      '把你知道的关于我的事都列一遍。',
    ],
  },
];

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

app.whenReady().then(async () => {
  const M = require('../main.js');
  const { config, memory, stats, mood, clock, testlog, speak } = M;

  await wait(4000);   // 等 main.js 里的异步初始化（记忆迁移/衰减/熔炼）跑完

  L('================ 长期对话测试 ================');
  L('  天数 ' + DAYS + '　每天轮数 ' + TURNS + '　起始日期 ' + clock.day() + '　时钟偏移 ' + clock.offset() + 'ms');
  const cfg = config.load();
  L('  模型 ' + cfg.model + '　AI 助手权限 ' + cfg.assistant + '　API Key ' + (cfg.apiKey ? '已配置' : '❌ 缺失'));
  L('  系统提示词 ' + M.buildSystemPrompt(cfg).length + ' 字符');
  if (!cfg.apiKey) { L('❌ 没有 API Key，无法测试'); return finish(); }

  const before = await snap(M);
  L('');
  L('--- 起始记忆状态 ---');
  L('  永久事实 ' + before.permanent.length + ' 条　日记 ' + before.long.length + ' 篇　中期 ' + before.medium.length + ' 条　技能经验 ' + before.skillmem.length + ' 条');
  L('  隐藏数值 ' + JSON.stringify(before.stats));
  L('  好感 ' + before.mood.affection + '　心情 ' + before.mood.mood);

  const timeline = [];
  for (let d = 1; d <= DAYS; d++) {
    const sc = SCRIPT[(d - 1) % SCRIPT.length];
    L('');
    L('================ 第 ' + d + ' 天（' + clock.day() + '）· ' + sc.label + ' ================');
    const lines = sc.turns.slice(0, TURNS);
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      const t0 = Date.now();
      let r;
      try {
        r = await ipcTurn(M, text);
      } catch (e) { L('  ❌ 第 ' + (i + 1) + ' 轮抛错: ' + ((e && e.message) || e)); break; }
      if (!r || !r.ok) { L('  ❌ 第 ' + (i + 1) + ' 轮失败: ' + ((r && r.error) || '未知')); continue; }
      L('  [' + (i + 1) + '] 我: ' + text);
      L('      她: ' + String(r.en || '').slice(0, 150));
      if (r.zh) L('      中: ' + String(r.zh).slice(0, 90));
      L('      (EN ' + String(r.en || '').length + ' 字 / 耗时 ' + r.ms + 'ms / 系统提示 ' + r.sysChars + ' / 历史 ' + r.histMsgs + ' 条)');
      timeline.push({ day: d, turn: i + 1, me: text, en: r.en, zh: r.zh, ms: r.ms, histMsgs: r.histMsgs, sysChars: r.sysChars });
    }
    L('');
    L('  --- 第 ' + d + ' 天结束会话（触发真正的收尾：摘要/事实/经验/判数值）---');
    const e0 = Date.now();
    const er = await memory.onSessionEnd();
    L('      收尾完成 ' + (Date.now() - e0) + 'ms　' + JSON.stringify(er).slice(0, 160));
    const s = await snap(M);
    L('      永久事实 ' + s.permanent.length + ' 条　日记 ' + s.long.length + ' 篇　中期 ' + s.medium.length + ' 条　技能经验 ' + s.skillmem.length + ' 条');
    if (s.permanent.length) L('      事实: ' + s.permanent.slice(-4).map((f) => '「' + f.text + '」(w=' + f.weight + ')').join(' '));
    if (s.long.length) L('      日记: ' + s.long.slice(-2).map((x) => x.date + ' ' + String(x.diary || '').slice(0, 60)).join(' | '));
    L('      数值 ' + JSON.stringify(s.stats) + '　好感 ' + s.mood.affection + ' 心情 ' + s.mood.mood);

    if (d < DAYS) {
      /* ⚠️ clock.set 是**设置**不是累加：以前写 clock.set({days:1})，结果第 2、3 天是同一天，
         日记按日期去重后只剩一篇。这里按"距起始第几天"设置偏移。 */
      clock.set({ days: d });
      L('');
      L('  --- 推进到第 ' + (d + 1) + ' 天（累计偏移 ' + (clock.offset() / 86400000) + ' 天，系统时间没动）→ 模拟重开应用 ---');
      await memory.onAppStart();
      await wait(1200);
      const s2 = await snap(M);
      L('      重开后：日记 ' + s2.long.length + ' 篇　永久 ' + s2.permanent.length + ' 条　数值 ' + JSON.stringify(s2.stats));
      if (s2.long.length) L('      日记列表: ' + s2.long.map((x) => x.date).join(', '));
    }
  }

  const after = await snap(M);
  L('');
  L('================ 结束状态 ================');
  L('  永久事实 ' + before.permanent.length + ' → ' + after.permanent.length + ' 条');
  L('  日记 ' + before.long.length + ' → ' + after.long.length + ' 篇　' + after.long.map((x) => x.date).join(', '));
  L('  中期 ' + before.medium.length + ' → ' + after.medium.length + ' 条');
  L('  技能经验 ' + before.skillmem.length + ' → ' + after.skillmem.length + ' 条');
  L('  数值 ' + JSON.stringify(before.stats) + ' → ' + JSON.stringify(after.stats));
  L('  好感 ' + before.mood.affection + ' → ' + after.mood.affection + '　心情 ' + before.mood.mood + ' → ' + after.mood.mood);

  /* 一致性问题：把"我问了她已知答案"的那几轮抽出来人工核对 */
  L('');
  L('================ 一致性检查点（这些问题的答案本该固定）================');
  for (const t of timeline) {
    if (/我叫什么|叫什么来着|叫什么名字|养了什么|猫叫什么|小家伙叫什么|记得我去哪|再去一趟/.test(t.me)) {
      L('  Q: ' + t.me);
      L('  A: ' + String(t.en || '').slice(0, 200));
    }
  }

  fs.writeFileSync(path.join(TEST_UD, 'test-chat-result.json'), JSON.stringify({ days: DAYS, timeline, before, after }, null, 2));
  L('');
  L('  完整时间线已写入: %APPDATA%/dayu-pet/test-chat-result.json');
  finish();

  /* 走 IPC 太绕：同一个进程里直接调 chat:send 的等价逻辑 */
  async function ipcTurn(Mod, text) {
    const c = Mod.config.load();
    const sys = Mod.buildSystemPrompt(c);
    const hist = Mod.memory.pickHistory();
    const t0 = Date.now();
    const { reply, raw } = await Mod.genReply(c, [{ role: 'system', content: sys }, ...hist, { role: 'user', content: text }]);
    if (reply.en) { Mod.memory.onTurn(text, raw, reply.en); Mod.mood.adjust({ affection: 1, mood: 2 }); }
    Mod.logTurn(text, reply);
    Mod.testlog.log('test', 'turn', { in: text, en: reply.en, ms: Date.now() - t0, histMsgs: hist.length });
    return { ok: true, en: reply.en, zh: reply.zh, ms: Date.now() - t0, sysChars: sys.length, histMsgs: hist.length };
  }
  async function snap(Mod) {
    const safe = (f, d) => { try { return f(); } catch { return d; } };
    return {
      day: Mod.clock.day(),
      stats: safe(() => Mod.stats.all(), {}),
      mood: safe(() => Mod.mood.load(), {}),
      session: safe(() => Mod.memory.session.info(), {}),
      long: safe(() => Mod.memory.long.list(), []),
      medium: safe(() => Mod.memory.medium.list(), []),
      permanent: safe(() => Mod.memory.permanent.facts(), []),
      skillmem: safe(() => Mod.memory.skillmem.candidates(), []),
    };
  }
  function finish() {
    L('');
    L('================ testlog 聚合分析 ================');
    try {
      const a = testlog.analyze({ minCount: 2 });
      L('  总行数 ' + a.totalLines + '　分组 ' + a.groups);
      for (const g of a.report.slice(0, 22)) {
        const f = Object.entries(g.fields).filter(([k]) => !/^a\d|^r$|^v$|^in$/.test(k)).slice(0, 4)
          .map(([k, s]) => k + '[' + s.min + '~' + s.max + ']').join(' ');
        L('  ' + g.key.padEnd(34) + ' n=' + String(g.n).padStart(4) + (g.errs ? ' ❌err=' + g.errs : '')
          + (g.ms ? '  ' + g.ms.min + '~' + g.ms.max + 'ms' : '') + (f ? '  ' + f : ''));
      }
      L('  完整日志: ' + testlog.logFile());
    } catch (e) { L('  分析失败: ' + ((e && e.message) || e)); }
    setTimeout(() => app.exit(0), 600);
  }
});
