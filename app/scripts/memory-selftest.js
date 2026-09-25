/* 记忆系统自测（mock electron + mock LLM）
 * 验证：草稿/恢复、历史预算+老回合压缩、中期摘要、日记熔炼、
 *      永久记忆候选累加 → 阈值晋升、保留策略。
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const orig = Module._load;
const TMP = path.join(__dirname, '..', 'dist', '_memtest');   // 相对脚本位置，搬到哪都能跑
fs.rmSync(TMP, { recursive: true, force: true });
Module._load = function (req) {
  if (req === 'electron') return { app: { getPath: () => TMP } };
  return orig.apply(this, arguments);
};
const mem = require('../src/memory');

const RAW = 'EN: You are a lazy bones.\nZH: 你真是个懒虫。\nWORDS: lazy=/ˈleɪzi/=懒, bones=/bəʊnz/=骨头\nC1: I know.\nC1ZH: 我知道。\nC2: Whatever.\nC2ZH: 随便吧。';
const RAW2 = 'EN: Good luck with that.\nZH: 那祝你好运。';
const RAW3 = 'EN: Still at it? Fine.\nZH: 还在弄？行吧。';

const llm = {
  request: async (cfg, messages) => {
    const sys = String((messages && messages[0] && messages[0].content) || '');
    if (sys.includes('记忆筛选器')) return '主人在准备考研|9|目标,学业\n主人讨厌早上被叫醒|6|偏好\n今天天气不错|2|闲聊';
    if (sys.includes('日记代笔')) return '（日记）今天主人又来缠着我练英语，哼，勉强陪他一会儿。';
    if (sys.includes('压缩')) return '主人来练英语，聊了早起和考研。';
    return 'EN: ok\nZH: 好';
  }
};
const config = { load: () => ({ apiKey: 'test', memory: {} }) };
mem.init({ llm, config, persona: () => ({ name: '大肥鱼' }) });

const ok = (label, cond, extra) => console.log((cond ? '  ✅ ' : '  ❌ ') + label + (extra !== undefined ? '  ' + extra : ''));

(async () => {
  console.log('— 1) 启动 + 草稿恢复 —');
  await mem.onAppStart();
  console.log('  session:', JSON.stringify(mem.session.info()));

  console.log('— 2) 两轮对话入库 + 历史预算/老回合压缩 —');
  mem.onTurn('我早上起不来', RAW, 'You are a lazy bones.');
  mem.onTurn('我在准备考研', RAW2, 'Good luck with that.');
  mem.onTurn('还在弄呢', RAW3, 'Still at it? Fine.');
  const h = mem.pickHistory(6000, 1);
  console.log('  历史条数:', h.length);
  console.log('  最后一条助手内容前 40 字:', JSON.stringify(String(h[h.length - 1].content).slice(0, 40)));
  const olderAssistant = h.filter((m) => m.role === 'assistant')[0];
  ok('老助手回合被压成 compact（只留 EN:）', String(olderAssistant.content).startsWith('EN: ') && !String(olderAssistant.content).includes('ZH:'), JSON.stringify(String(olderAssistant.content).slice(0, 30)));
  ok('最近一条助手回合仍是完整格式', String(h[h.length - 1].content).includes('ZH:') || String(h[h.length - 1].content).includes('EN:'));

  console.log('— 3) 会话收尾：中期摘要 + 抽永久记忆 —');
  const r = await mem.onSessionEnd();
  console.log('  收尾结果:', JSON.stringify(r));
  console.log('  中期:', JSON.stringify(mem.medium.list().map((e) => ({ date: e.date, summary: e.summary }))));
  console.log('  永久记忆:', JSON.stringify(mem.permanent.facts().map((f) => f.text + ' (w=' + f.weight + ')')));
  console.log('  候选池:', JSON.stringify(mem.permanent.candidates().map((c) => c.text + ' (w=' + c.weight + ', hits=' + c.hits + ')')));
  ok('草稿已清空（不会重复记账）', mem.session.info().count === 0);

  console.log('— 4) 第二次会话：同一要点应累加权重并晋升 —');
  mem.onTurn('我还在准备考研', RAW2, 'Good luck with that.');
  await mem.onSessionEnd();
  console.log('  永久记忆:', JSON.stringify(mem.permanent.facts().map((f) => f.text + ' (w=' + f.weight + ')')));
  console.log('  候选池:', JSON.stringify(mem.permanent.candidates().map((c) => c.text + ' (w=' + c.weight + ', hits=' + c.hits + ')')));
  ok('「主人讨厌早上被叫醒」累加后晋升进永久记忆', mem.permanent.facts().some((f) => f.text.includes('讨厌早上')));

  console.log('— 5) 熔炼历史中期为日记（造一条前天的） —');
  mem.medium.save([{ id: 'x1', date: '2026-09-20', turns: 4, ts: Date.now() - 86400000, summary: '主人说他在准备考研。' }]);
  await mem.onAppStart();
  console.log('  日记:', JSON.stringify(mem.long.list().map((e) => e.date + ' → ' + String(e.diary).slice(0, 24))));
  ok('非今天的中期 → 变成日记', mem.long.list().some((e) => e.date === '2026-09-20'));
  ok('非今天的中期已被清掉', !mem.medium.list().some((e) => e.date === '2026-09-20'));

  console.log('— 6) 保留策略 —');
  mem.long.save(Array.from({ length: 30 }, (_, i) => ({ date: '2026-08-' + String(i + 1).padStart(2, '0'), diary: 'd' + i, ts: i })));
  mem.medium.save(Array.from({ length: 30 }, (_, i) => ({ id: 'm' + i, date: '2026-09-24', ts: i, summary: 's' + i })));
  await mem.onAppStart();
  console.log('  日记天数:', mem.long.list().length, ' 中期条数:', mem.medium.list().length);

  console.log('— 7) 上下文装配（顺序固定） —');
  console.log(mem.buildContext().split('\n').slice(0, 6).join('\n'));
  console.log('\n自测结束。文件：');
  for (const f of fs.readdirSync(path.join(TMP, 'memory'))) console.log('  memory/' + f);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
