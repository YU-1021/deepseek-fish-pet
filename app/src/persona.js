// 人设：一个可写文件 + 逐字段的锁
//
// 为什么要单独一个模块：
//   1) AI 现在会**自己改人设**，所以人设文件必须放在可写的地方（userData），
//      不能再放 app/persona.json（打包后是只读的 asar）
//   2) 每个字段可以上锁：锁住 = AI 不许动，但用户自己还能改
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

/* AI 可以改的字段（世界观不在这里：**只有用户能改世界观**） */
const FIELDS = ['name', 'character_setting', 'personality', 'catchphrase', 'hidden_setting'];
/* 永远只有用户能改的字段 */
const USER_ONLY = ['world_setting'];
/* 界面上要展示、能上锁的全部字段 */
const ALL_FIELDS = FIELDS.concat(USER_ONLY);
const LABELS = {
  name: '名字',
  world_setting: '世界观',
  character_setting: '人物设定',
  personality: '性格',
  catchphrase: '口头禅',
  hidden_setting: '隐藏设定',
};

const builtinFile = () => path.join(__dirname, '..', 'persona.json');   // 随包发布的默认
const file = () => path.join(app.getPath('userData'), 'persona.json');  // 实际使用的（可写）

/* 首次运行把默认人设拷进 userData（之后用户/AI 都改这份）
   逐文件读写而不是 copyFileSync —— 打包后默认人设在 asar 里，copyFileSync 不一定读得到 */
function ensure() {
  const f = file();
  if (!fs.existsSync(f)) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, fs.readFileSync(builtinFile()));
    } catch {
      try { fs.writeFileSync(f, JSON.stringify({ name: '大肥鱼' }, null, 2)); } catch {}
    }
  }
  return f;
}

function load() {
  ensure();
  try { return JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^\uFEFF/, '')) || {}; } catch { return {}; }
}
function save(next) {
  ensure();
  try { fs.writeFileSync(file(), JSON.stringify(next, null, 2)); } catch {}
  return next;
}
function patch(p) { return save({ ...load(), ...(p || {}) }); }

/* ---- 锁 ---- */
function locks() { const l = load().locks; return (l && typeof l === 'object') ? l : {}; }
function setLock(field, locked) {
  if (!ALL_FIELDS.includes(field) || USER_ONLY.includes(field)) return load();   // 世界观不给锁开关（本来就锁死）
  const p = load();
  const l = Object.assign({}, p.locks || {});
  if (locked) l[field] = true; else delete l[field];
  p.locks = l;
  return save(p);
}
/* 这个字段 AI 能不能改：世界观永远不能；其余看锁 */
function aiEditable(field) {
  if (USER_ONLY.includes(field)) return false;
  return !locks()[field];
}

/* ---- AI 写入：只改没锁、且属于 AI 可改范围的字段 ---- */
function applyAI(changes) {
  const p = load();
  const applied = [], skipped = [], ignored = [];
  for (const k of Object.keys(changes || {})) {
    const v = changes[k];
    if (!ALL_FIELDS.includes(k) || USER_ONLY.includes(k)) { ignored.push(k); continue; }
    if (!aiEditable(k)) { skipped.push(k); continue; }
    if (typeof v !== 'string' || !v.trim()) continue;
    p[k] = v.trim();
    applied.push(k);
  }
  if (applied.length) save(p);
  return { applied, skipped, ignored };
}

module.exports = { FIELDS, USER_ONLY, ALL_FIELDS, LABELS, file, builtinFile, ensure, load, save, patch, locks, setLock, aiEditable, applyAI };
