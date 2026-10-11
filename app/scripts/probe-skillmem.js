/* 技能 × 记忆 联动健康检查（独立 userData）
 * 技能和记忆是**两个**联动点（skills.js 里写着）：
 *   ① <userData>/skills/<技能名>/memory.json —— 该技能独有的经验永久库（use_skill 返回时读它）
 *   ② NS='skillmem'（memory/skillmem.json）  —— 所有技能共有的候选池
 * 本探针验证：技能工具还能用、记忆事实会被带进技能说明、写入/删除不坏、
 * 以及**各记忆文件的版本现状**（C8 只给 session 加了版本，这里把全貌列出来）。
 * 跑法：electron app/scripts/probe-skillmem.js
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const T = path.join(process.env.APPDATA, 'dayu-pet-skillmemtest');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
app.setPath('userData', T);

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 400));
  const A = require('../src/assistant');
  const skills = require('../src/skills');

  /* §A 技能工具还能用吗 */
  let ls = '';
  try { ls = String(await A.run('skill_ls', '')); } catch (e) { ls = 'ERR: ' + e.message; }
  console.log('  §A skill_ls: ' + ls.replace(/\n/g, ' ').slice(0, 70));

  /* §B 造一个技能 + 它独有的记忆，然后 use_skill —— 看记忆事实有没有被带进来 */
  const dir = path.join(T, 'skills', 'demo-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo-skill\ndescription: 健康检查用的技能\n---\n\n# demo-skill\n\n这是正文。\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ facts: [
    { text: '这条经验权重最高', weight: 9, hits: 3 },
    { text: '这条次要', weight: 1, hits: 1 },
  ] }), 'utf8');
  /* 再造一个"归档进来的经验文件"——这正是 play-game/网页排班/经验.md 那种东西 */
  fs.mkdirSync(path.join(dir, '排班'), { recursive: true });
  fs.writeFileSync(path.join(dir, '排班', '经验.md'), '# 排班经验\n\n- 铁律：对话窗会挡住右侧干员列表，自己动手最小化。\n', 'utf8');
  let used = '';
  try { used = String(await A.run('use_skill', 'demo-skill')); } catch (e) { used = 'ERR: ' + e.message; }
  console.log('  §B use_skill 全文↓');
  for (const ln of used.split('\n')) console.log('       | ' + ln);
  console.log('  §B ★技能记忆被带进说明: ' + (used.indexOf('这条经验权重最高') >= 0 ? '✅' : '❌ 没带上'));
  console.log('  §B ★归档的经验文件(排班/经验.md)被带进说明: ' + (used.indexOf('对话窗会挡住右侧干员列表') >= 0 ? '✅' : '❌ 没带上'));
  console.log('  §B ★memory.json 没有被重复贴: ' + (used.indexOf('memory.json') < 0 ? '✅' : '❌ 重复了'));
  console.log('  §B ★按权重排序（高权重在前）: ' + (used.indexOf('这条经验权重最高') < used.indexOf('这条次要') ? '✅' : '❌ 顺序不对'));

  /* §C 技能共有的候选池（skillmem NS） */
  const skillmem = require('../src/memory/skillmem');
  try {
    const before = skillmem.load ? skillmem.load() : null;
    console.log('  §C skillmem 读取: ' + (before === null ? '返回 null' : '正常'));
    if (skillmem.merge) { const r = skillmem.merge([{ text: '共有池里的一条经验', weight: 2, skill: 'demo-skill' }]); console.log('  §C skillmem.merge 可用 ✅ ' + JSON.stringify(r)); }
    if (skillmem.save) { skillmem.save(); console.log('  §C skillmem.save() 不传参数也不再崩 ✅'); }
  } catch (e) { console.log('  §C skillmem 出错: ' + e.message); }

  /* §D 技能写入 / 删除 */
  try { const w = await A.run('skill_write', 'demo2/notes.md||内容'); console.log('  §D skill_write: ' + String(w).slice(0, 80)); }
  catch (e) { console.log('  §D skill_write 出错: ' + e.message); }

  /* §E 记忆文件的版本全貌（这是用户点出来的问题：C8 只覆盖了 session） */
  const md = path.join(T, 'memory');
  console.log('  §E 记忆文件版本现状:');
  try {
    for (const f of fs.readdirSync(md).filter((x) => x.endsWith('.json')).sort()) {
      const p = path.join(md, f);
      let v = '?';
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        v = Array.isArray(j) ? '(数组)' : (j.version === undefined ? '★没有' : String(j.version));
      } catch { v = '解析失败'; }
      console.log('       ' + f.padEnd(18) + ' 版本=' + v);
    }
  } catch { console.log('       （还没有 memory 目录）'); }
  /* 技能自己的记忆文件有没有版本 */
  /* 再验一次：裸数组形状也要认（把 memory.json 换成裸数组，重读一遍） */
  try {
    fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify([{ text: '裸数组形状的经验', weight: 5 }]), 'utf8');
    const s2 = require('../src/skills').read('demo-skill');
    console.log('  §F 裸数组也要认: ' + ((s2.memory || []).some((x) => x.text === '裸数组形状的经验') ? '✅' : '❌'));
  } catch (e) { console.log('  §F 出错: ' + e.message); }
  const mdemo = path.join(dir, 'memory.json');
  try {
    const j = JSON.parse(fs.readFileSync(mdemo, 'utf8'));
    console.log('       技能自己的 memory.json: ' + (Array.isArray(j) ? '(数组，没有版本)' : (j.version === undefined ? '★没有版本' : j.version)));
  } catch {}

  setTimeout(() => app.exit(0), 200);
});
