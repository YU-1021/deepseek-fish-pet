/* 直接验 skill_read / use_skill 到底返回什么（独立 userData，复制她的技能目录）
 * 背景：她声称 ACTION: skill_read|干员图鉴/速查/制造站-贵金属.md 成功了，随后又招认"根本没读到"。
 * 到底哪个是真的？直接调一遍就知道。
 * 跑法：electron app/scripts/probe-skillread.js
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const T = path.join(process.env.APPDATA, 'dayu-pet-skillreadtest');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
app.setPath('userData', T);

/* 把她的技能目录整个复制过来（她真实拥有的那几个技能） */
const src = path.join(process.env.APPDATA, 'dayu-pet', 'skills');
const dst = path.join(T, 'skills');
function copyDir(a, b) {
  fs.mkdirSync(b, { recursive: true });
  for (const it of fs.readdirSync(a, { withFileTypes: true })) {
    const from = path.join(a, it.name), to = path.join(b, it.name);
    if (it.isDirectory()) copyDir(from, to);
    else { try { fs.copyFileSync(from, to); } catch {} }
  }
}
try { copyDir(src, dst); } catch (e) { console.log('复制技能目录失败: ' + e.message); }

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const A = require('../src/assistant');
  const skills = require('../src/skills');

  console.log('  §0 用户技能目录: ' + skills.userDir());
  console.log('  §0 目录里有什么: ' + (() => { try { return fs.readdirSync(skills.userDir()).join(', '); } catch (e) { return '读不到: ' + e.message; } })());

  /* §A 技能列表 */
  try { console.log('  §A skill_ls → ' + String(await A.run('skill_ls', '')).replace(/\n/g, ' ').slice(0, 120)); }
  catch (e) { console.log('  §A skill_ls ❌ ' + e.message); }

  /* §B 她那次用的路径，原样再调一次 */
  const rel = '干员图鉴/速查/制造站-贵金属.md';
  let out = '';
  try { out = String(await A.run('skill_read', rel)); }
  catch (e) { out = 'ERR: ' + e.message; }
  console.log('  §B skill_read|' + rel);
  console.log('  §B 回执长度: ' + out.length + ' 字符');
  console.log('  §B 回执前 300 字: ' + out.slice(0, 300).replace(/\n/g, ' | '));
  const hasData = /砾|引星棘刺|金属工艺/.test(out);
  console.log('  §B ★回执里有没有真数据: ' + (hasData ? '有 ✅（她说"没读到"是她自己没看）' : '没有 ❌（工具真的没返回内容）'));

  /* §C 换几种写法试试，看是不是路径解析的问题 */
  for (const alt of ['干员图鉴/速查/制造站-贵金属', '干员图鉴\\速查\\制造站-贵金属.md', './干员图鉴/速查/制造站-贵金属.md']) {
    let o = '';
    try { o = String(await A.run('skill_read', alt)); } catch (e) { o = 'ERR: ' + e.message; }
    console.log('  §C [' + alt + '] → ' + o.length + ' 字符  ' + o.slice(0, 80).replace(/\n/g, ' '));
  }

  /* §D use_skill 干员图鉴（她第一步做的） */
  let u = '';
  try { u = String(await A.run('use_skill', '干员图鉴')); } catch (e) { u = 'ERR: ' + e.message; }
  console.log('  §D use_skill|干员图鉴 → ' + u.length + ' 字符');
  console.log('  §D 前 260 字: ' + u.slice(0, 260).replace(/\n/g, ' | '));

  setTimeout(() => app.exit(0), 200);
});
