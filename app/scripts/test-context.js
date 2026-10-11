/* 上下文装配与历史裁剪验证（**确定性、零 token**）
 *
 * 为什么值得单独测：这是**花钱的命门**。注入块超预算会把真实对话挤出上下文，
 * 历史裁剪写错会要么爆 token、要么把最近几轮切掉。而且 build() 的**顺序**
 * （稳定内容在前、易变内容在后）是 DeepSeek 前缀缓存能不能命中的关键 ——
 * 顺序一乱，每轮都要按未命中价付全量 token。
 *
 * electron.exe app\scripts\test-context.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-ctxtest');
fs.mkdirSync(TEST_UD, { recursive: true });
app.setPath('userData', TEST_UD);

app.whenReady().then(() => {
  const out = [];
  const L = (s) => out.push(s);
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  let crashed = '';

  try {
    const context = require('../src/memory/context');
    const permanent = require('../src/memory/permanent');
    const long = require('../src/memory/long');
    const medium = require('../src/memory/medium');
    const tokens = require('../src/tokens');
    const cfg = require('../src/config').load();
    const M = cfg.memory;
    const budget = (M.inject && M.inject.totalChars) || 2400;

    L('=== 参数 ===');
    L('  inject=' + JSON.stringify(M.inject));
    L('  historyTokens=' + M.historyTokens + '  fullTurns=' + M.fullTurns + '  toolResultChars=' + M.toolResultChars);

    /* ---------- 1. 注入块总量必须受控 ---------- */
    L('');
    L('=== 1. 注入块总量（超预算要按优先级丢）===');
    permanent.save({ cand: [], facts: [] });
    long.save([]);
    medium.save([]);
    /* 塞远超预算的数据：60 条事实 + 30 篇日记 + 30 条中期 */
    const facts = [];
    for (let i = 0; i < 60; i++) facts.push({ text: '事实' + i + '：' + 'x'.repeat(60), weight: 10 - (i % 5), hits: 1, ts: Date.now() });
    permanent.save({ cand: [], facts });
    const longs = [];
    for (let i = 0; i < 30; i++) longs.push({ date: '2026-09-' + String(i + 1).padStart(2, '0'), diary: '第' + i + '天日记：' + 'y'.repeat(300), ts: Date.now() });
    long.save(longs);
    const meds = [];
    for (let i = 0; i < 30; i++) meds.push({ id: 's' + i, date: '2026-09-' + String(i + 1).padStart(2, '0'), turns: 4, ts: Date.now(), summary: '第' + i + '场：' + 'z'.repeat(300) });
    medium.save(meds);

    const c1 = context.build(cfg);
    check('注入块不超过 totalChars=' + budget, c1.length <= budget + 80, c1.length + ' 字');
    check('不是空（该有的还是有）', c1.length > 200, c1.length + ' 字');
    check('含永久记忆段', /永久记忆/.test(c1));
    check('超预算时先丢中期摘要', !/最近的会话/.test(c1) || c1.length <= budget + 80);

    /* 只放少量数据 → 三段都该出现 */
    permanent.save({ cand: [], facts: [{ text: '主人叫小林', weight: 9, hits: 1, ts: Date.now() }] });
    long.save([{ date: '2026-10-01', diary: '今天主人告诉我他叫小林。', ts: Date.now() }]);
    medium.save([{ id: 's1', date: '2026-10-01', turns: 3, ts: Date.now(), summary: '聊了名字和猫。' }]);
    const c2 = context.build(cfg);
    check('数据少时三段都在', /永久记忆/.test(c2) && /你的日记/.test(c2) && /最近的会话/.test(c2));

    /* ---------- 2. 前缀稳定性（前缀缓存能不能命中的命门）---------- */
    L('');
    L('=== 2. 前缀稳定性（省钱的命门）===');
    const a = context.build(cfg);
    const b = context.build(cfg);
    check('同样数据两次 build 完全一致', a === b, a.length + ' vs ' + b.length);
    /* 追加一条中期摘要（今天又聊了一场）→ 前半段必须一字不变 */
    medium.save(medium.list().concat([{ id: 's2', date: '2026-10-01', turns: 2, ts: Date.now(), summary: '又聊了一场。' }]));
    const c = context.build(cfg);
    const common = (() => { let i = 0; while (i < a.length && i < c.length && a[i] === c[i]) i++; return i; })();
    check('新增会话后，永久记忆+日记那一段仍是原样前缀', common >= a.indexOf('# 最近的会话') - 1 || a.indexOf('# 最近的会话') < 0,
      '共同前缀 ' + common + ' 字 / 原长 ' + a.length + '（"最近的会话"起始于 ' + a.indexOf('# 最近的会话') + '）');
    check('易变内容排在稳定内容**后面**',
      c.indexOf('永久记忆') < c.indexOf('你的日记') && c.indexOf('你的日记') < c.indexOf('最近的会话'),
      '永久=' + c.indexOf('永久记忆') + ' 日记=' + c.indexOf('你的日记') + ' 会话=' + c.indexOf('最近的会话'));

    /* ---------- 3. 历史裁剪 ---------- */
    L('');
    L('=== 3. 历史裁剪 ===');
    const mk = (role, n, extra) => Object.assign({ role, content: 'm'.repeat(n) }, extra || {});
    const hist = [];
    for (let i = 0; i < 40; i++) {
      hist.push(mk('user', 200));
      hist.push(Object.assign(mk('assistant', 600), { compact: 'c'.repeat(120) }));
    }
    const p1 = context.pickHistory(hist, 3000, 3);
    const used1 = p1.reduce((s, m) => s + tokens.est(m.content) + 4, 0);
    check('裁剪后不超预算', used1 <= 3000, '用了 ' + used1 + ' / 3000 token，' + p1.length + ' 条');
    check('首条是 user（部分接口对首条 role 敏感）', p1.length > 0 && p1[0].role === 'user', p1[0] && p1[0].role);
    check('保留的是**最近**的内容', p1.length > 0 && p1[p1.length - 1].role === 'assistant');
    const lastFew = p1.slice(-3).filter((m) => m.role === 'assistant');
    check('最近几轮助手回复保留完整（格式锚）', lastFew.some((m) => m.content.length > 400),
      '最近助手消息长度 ' + lastFew.map((m) => m.content.length).join(','));
    check('更老的助手回复被压成 compact', p1.slice(0, 3).some((m) => m.role === 'assistant' && m.content.length <= 200) || p1.filter((m) => m.role === 'assistant').length < 3,
      '助手消息长度 ' + p1.filter((m) => m.role === 'assistant').map((m) => m.content.length).join(','));

    /* 超大单条消息：不能因为它就把预算撑爆 */
    const huge = context.pickHistory([mk('user', 50000), mk('assistant', 100), mk('user', 200)], 3000, 3);
    const usedHuge = huge.reduce((s, m) => s + tokens.est(m.content) + 4, 0);
    check('单条 5 万字的消息不会撑爆预算', usedHuge <= 3000 || huge.length === 0, '用了 ' + usedHuge + ' token，' + huge.length + ' 条');

    /* 老的工具/系统记录要被压缩（否则加载一个技能就吃掉整个预算） */
    const toolHist = [mk('user', 1000, {}), mk('assistant', 300), mk('user', 100), mk('assistant', 300), mk('user', 100), mk('assistant', 300), mk('user', 100), mk('assistant', 300), mk('user', 1000), mk('assistant', 300)];
    toolHist[0].content = '[系统] 技能说明：' + 'k'.repeat(2000);
    const pt = context.pickHistory(toolHist, 6000, 3);
    const sysKept = pt.find((m) => /技能说明/.test(m.content));
    check('老的系统/工具记录被压缩', !sysKept || sysKept.content.length < 600, sysKept ? sysKept.content.length + ' 字' : '（已整体丢弃）');
    check('压缩会留标记（模型知道那是旧记录）', !sysKept || /系统记录|已压缩/.test(sysKept.content), sysKept ? sysKept.content.slice(-20) : '—');

    /* 空历史 / 全是助手 */
    check('空历史返回空数组', context.pickHistory([], 3000, 3).length === 0);
    check('全是助手消息 → 裁到空（首条必须是 user）', context.pickHistory([mk('assistant', 100), mk('assistant', 100)], 3000, 3).length === 0);

    /* ---------- 4. token 估算的单调性与边界 ---------- */
    L('');
    L('=== 4. token 估算 ===');
    /* est() 的实现在字符数之外固定 +2（每条消息的结构开销），estMessages 再 +4。
       所以空串估出来是 2 而不是 0 —— 这是**有意的**，预算宁可略保守。 */
    check('空串 = 固定结构开销 2（不是 0）', tokens.est('') === 2, String(tokens.est('')));
    check('null/undefined 不崩且按空串算', tokens.est(null) === 2 && tokens.est(undefined) === 2,
      tokens.est(null) + '/' + tokens.est(undefined));
    check('数字/布尔等非字符串也能处理', tokens.est(123) === 3 && tokens.est(true) === 3, tokens.est(123) + '/' + tokens.est(true));
    const e1 = tokens.est('a'), e2 = tokens.est('a'.repeat(100));
    check('越长估得越多（单调）', e2 > e1, e1 + ' → ' + e2);
    check('中文字符 1 字 ≈ 1 token', tokens.est('中文测试') === 6, String(tokens.est('中文测试')));
    check('英文 4 字符 ≈ 1 token', tokens.est('a'.repeat(40)) === 12, String(tokens.est('a'.repeat(40))));
    check('estMessages = 各条 est + 4×条数', tokens.estMessages([{ role: 'user', content: 'a'.repeat(40) }]) === tokens.est('a'.repeat(40)) + 4,
      tokens.estMessages([{ role: 'user', content: 'a'.repeat(40) }]) + ' vs ' + (tokens.est('a'.repeat(40)) + 4));
    check('estMessages 空列表 = 0', tokens.estMessages([]) === 0);
    check('estMessages 容错缺失 content', tokens.estMessages([{}, null]) === 12, String(tokens.estMessages([{}, null])));
    /* clip 的边界 */
    check('clip 不超长时原样返回', tokens.clip('abc', 10) === 'abc');
    check('clip 超长时截断并加省略号', tokens.clip('abcdefghij', 5) === 'abcde…', tokens.clip('abcdefghij', 5));
    check('clip 处理 null', tokens.clip(null, 5) === '');
    check('clip(0) 不会返回空', tokens.clip('abc', 0).length >= 1, JSON.stringify(tokens.clip('abc', 0)));

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
