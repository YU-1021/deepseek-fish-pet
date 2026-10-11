/* 验证「数值增减与好感/心情挂钩」：直接调应用真实的 stats.relateOf()。
 * 网格测试期间会临时改 mood.json，跑完立刻还原（先备份）。
 * 用法：electron.exe app\scripts\test-relate.js
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

app.setPath('userData', path.join(process.env.APPDATA, 'dayu-pet'));

app.whenReady().then(() => {
  const stats = require('../src/stats');
  const moodFile = path.join(app.getPath('userData'), 'mood.json');
  const backup = fs.readFileSync(moodFile, 'utf8');
  const real = JSON.parse(backup);
  const out = [];

  const setMood = (m, a) => fs.writeFileSync(moodFile, JSON.stringify({
    affection: a, mood: m, pokes: 0, lastSeen: Date.now(),
  }, null, 2));

  const KEYS = stats.KEYS;
  const MOODS = [0, 15, 50, 85, 100];
  const BONDS = [0, 50, 100];

  /* 表1：正向事件（task-ok / away）的乘数 */
  out.push('=== 正向事件乘数（相关度高 → 涨得多）===');
  out.push('key'.padEnd(14) + MOODS.map((m) => ('心情' + m).padStart(9)).join('') + '   (好感=100)');
  for (const k of KEYS) {
    const row = [];
    for (const m of MOODS) { setMood(m, 100); row.push('×' + stats.relateOf(k, +1).toFixed(2)); }
    out.push(k.padEnd(14) + row.map((x) => x.padStart(9)).join(''));
  }
  out.push('');
  out.push('=== 负向事件乘数（相关度高 → 掉得少）===');
  out.push('key'.padEnd(14) + MOODS.map((m) => ('心情' + m).padStart(9)).join('') + '   (好感=100)');
  for (const k of KEYS) {
    const row = [];
    for (const m of MOODS) { setMood(m, 100); row.push('×' + stats.relateOf(k, -1).toFixed(2)); }
    out.push(k.padEnd(14) + row.map((x) => x.padStart(9)).join(''));
  }
  out.push('');
  out.push('=== 好感度的作用（心情固定 50）===');
  out.push('key'.padEnd(14) + BONDS.map((b) => ('好感' + b).padStart(9)).join(''));
  for (const k of KEYS) {
    const row = [];
    for (const b of BONDS) { setMood(50, b); row.push('×' + stats.relateOf(k, +1).toFixed(2)); }
    out.push(k.padEnd(14) + row.map((x) => x.padStart(9)).join(''));
  }

  /* 表2：用你此刻真实的好感/心情，算 5 个真实触发点的实际增量 */
  setMood(real.mood, real.affection);
  out.push('');
  out.push(`=== 你此刻（好感 ${real.affection} / 心情 ${real.mood}）5 个真实触发点 ===`);
  const cases = [
    ['task-ok', 'iq', 0.3, '独立办成一件事'],
    ['task-ok', 'diligence', 0.3, '认真办了事'],
    ['task-fail', 'iq', -0.5, '事情没办成'],
    ['away', 'dependency', 0.6, '隔了好久没见(>20h)'],
    ['away', 'dependency', 0.3, '半天没见(>6h)'],
  ];
  out.push('trigger'.padEnd(11) + 'key'.padEnd(13) + 'base'.padStart(7) + ' ×relate'.padStart(9) + ' = 实际'.padStart(9) + '   说明');
  for (const [trg, key, base, note] of cases) {
    const rf = stats.relateOf(key, base);
    const delta = base * stats.weight(1) * rf;      // 当天第 1 次（weight=1）
    out.push(trg.padEnd(11) + key.padEnd(13) + String(base).padStart(7) + ('×' + rf.toFixed(2)).padStart(9)
      + (Math.round(delta * 1000) / 1000).toFixed(3).padStart(9) + '   ' + note);
  }
  out.push('');
  out.push('=== 排除项确认 ===');
  const pre = stats.relateOf('iq', 0.3);
  setMood(0, 0);
  const post = stats.relateOf('iq', 0.3);
  out.push(`relateOf 确实随心情变化：心情100时 ×${pre.toFixed(2)} → 心情0时 ×${post.toFixed(2)}`);
  out.push('（judge 触发在 nudge() 里被显式跳过，乘数恒为 1 —— 见 stats.js 注释）');

  fs.writeFileSync(moodFile, backup);   // 还原
  console.log(out.join('\n'));
  console.log('\nmood.json 已还原:', fs.readFileSync(moodFile, 'utf8').replace(/\s+/g, ' '));
  app.exit(0);
});
