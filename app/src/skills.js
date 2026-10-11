// 技能系统
//
// 结构：
//   <userData>/skills/<技能名>/SKILL.md   ← 技能说明书（用户可编辑）
//   <userData>/skills/<技能名>/memory.json ← 该技能独有的经验永久库（阶段 2 用）
//   app/skills/                            ← 内置技能模板，首次运行拷进 userData
//
// 注入策略（渐进式披露）：
//   catalog() 只给"名字 + 一句话"，很省 token，常驻提示词；
//   聊到相关的任务时，模型才用 use_skill 把完整 SKILL.md load 进来。
const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const NS = 'skillmem';   // 共有的技能长期记忆库（候选池，阶段 2 用）

function builtinDir() {
  const dev = path.join(__dirname, '..', 'skills');
  const packed = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'skills');
  if (fs.existsSync(dev)) return dev;
  if (fs.existsSync(packed)) return packed;
  return dev;
}

function userDir() {
  const d = path.join(app.getPath('userData'), 'skills');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

/* 首次运行：把内置技能拷进 userData（之后用户随便改，不会覆盖）
   注意逐文件读写，而不是 cpSync —— 打包后内置技能在 asar 里，cpSync 不一定能读 */
function ensureBuiltins() {
  try {
    const src = builtinDir();
    if (!fs.existsSync(src)) return;
    const dst = userDir();
    for (const name of fs.readdirSync(src)) {
      const fromDir = path.join(src, name);
      const toDir = path.join(dst, name);
      if (!fs.existsSync(path.join(fromDir, 'SKILL.md')) || fs.existsSync(toDir)) continue;
      fs.mkdirSync(toDir, { recursive: true });
      for (const f of fs.readdirSync(fromDir)) {
        const from = path.join(fromDir, f);
        try {
          if (fs.statSync(from).isFile()) fs.writeFileSync(path.join(toDir, f), fs.readFileSync(from));
        } catch {}
      }
    }
  } catch {}
}

/* 解析 SKILL.md 开头的 --- name/description --- 元信息 */
function parseFront(text) {
  const m = String(text).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text).trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

/* 列出所有技能：userData 优先，内置兜底（同名以内置为准之前先看用户目录） */
function list() {
  ensureBuiltins();
  const out = [];
  for (const dir of [userDir(), builtinDir()]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const p = path.join(dir, name, 'SKILL.md');
      if (!fs.existsSync(p)) continue;
      if (out.some((s) => s.id === name)) continue;
      try {
        const { meta, body } = parseFront(fs.readFileSync(p, 'utf8'));
        out.push({
          id: name,
          name: meta.name || name,
          description: meta.description || '',
          dir: path.join(dir, name),
          body,
        });
      } catch {}
    }
  }
  return out;
}

/* 常驻提示词的"短目录"（只有名字 + 一句话） */
function catalog() {
  const items = list();
  if (!items.length) return '';
  return items.map((s) => '- ' + s.id + '：' + (s.description || s.name)).join('\n');
}

/* 某个技能独有经验库里的要点（阶段 2 写入；没有就返回空）
 * ⚠️ 实测发现：**没有任何代码往这个文件里写** —— 归档时她写的是 Markdown 文件
 *    （例如 skills/play-game/网页排班/经验.md，那文件真的存在），而这个结构化的
 *    memory.json 读取路径一直是空的。所以真正该做的是**把技能文件夹里她攒的经验
 *    一并给出来**（见下面的 extras），这个函数保留是为了兼容可能已经存在的旧文件。 */
function memoryFacts(id) {
  try {
    const p = path.join(userDir(), id, 'memory.json');
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    /* 这个文件不在 store.js 管的记忆命名空间里（它是技能文件夹里的散文件），没有版本机制兜底，
       所以干脆**两种形状都认**：{ facts: [...] }（现在的约定）和裸数组 [...]（一开始可能是这么写的）。 */
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.facts)) return v.facts;
    return [];
  } catch { return []; }
}

/* 技能文件夹里**除 SKILL.md 之外**的文件（她归档进来的经验就在这些文件里）。
 * 为什么需要它：归档写的是文件，而 use_skill 原来只给 SKILL.md 正文 →
 * 攒下来的经验下次加载时**根本看不到**，同一个坑会反复踩。
 * 返回 [{ rel, bytes, text? }]，text 只在文件小、预算够时带上（其余只给清单，让她按需 read_file）。 */
function extras(id, opts) {
  const o = Object.assign({ maxFiles: 12, maxTotalChars: 3000, maxOneFileChars: 1500 }, opts || {});
  const base = path.join(userDir(), String(id || ''));
  const out = [];
  let budget = o.maxTotalChars;
  const walk = (dir, rel) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (out.length >= o.maxFiles) return;
      const abs = path.join(dir, it.name);
      const r = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) { walk(abs, r); continue; }
      if (!it.isFile()) continue;
      if (/^SKILL\.md$/i.test(it.name)) continue;           // 正文由 body 负责
      if (/^memory\.json$/i.test(it.name)) continue;        // 结构化经验由 memoryFacts 负责（否则会重复贴一遍）
      if (/\.(png|jpg|jpeg|webp|gif|bin|exe|zip)$/i.test(it.name)) { out.push({ rel: r, bytes: 0, note: '（二进制，不读内容）' }); continue; }
      let text = '';
      let bytes = 0;
      try {
        const st = fs.statSync(abs);
        bytes = st.size;
        if (bytes <= o.maxOneFileChars && budget > 0) {
          text = fs.readFileSync(abs, 'utf8').slice(0, Math.min(bytes, budget));
          budget -= text.length;
        }
      } catch {}
      out.push({ rel: r, bytes, text });
    }
  };
  walk(base, '');
  return out;
}

/* 按需读取：完整说明 + 该技能的经验（结构化的 memory.json + 文件夹里归档的经验文件） */
function read(id) {
  const key = String(id || '').trim();
  const s = list().find((x) => x.id === key || x.name === key || x.id.toLowerCase() === key.toLowerCase());
  if (!s) return null;
  s.memory = memoryFacts(s.id);
  try { s.extras = extras(s.id); } catch { s.extras = []; }
  return s;
}

function openFolder() { return shell.openPath(userDir()); }

/* ---------------- AI 自主管理：技能目录内的读写（带路径沙箱） ---------------- */

/* 把相对路径解析成 skills/ 下的绝对路径，禁止越界（..、绝对路径都挡掉） */
function safePath(rel) {
  const base = path.resolve(userDir());
  const cleaned = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '').trim();
  const full = path.resolve(base, cleaned);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('路径越界：这里只能填**技能目录内的相对路径**（例如 play-game 或 play-game/某游戏/日常.md），'
      + '留空表示技能根目录；不要填 C:\\ 这种绝对路径。用 skill_ls| 先看看有哪些技能。');
  }
  return full;
}

/* 列目录：文件夹带结尾 / */
function ls(rel) {
  const p = safePath(rel);
  const items = fs.readdirSync(p, { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.'))
    .map((d) => (d.isDirectory() ? d.name + '/' : d.name))
    .sort();
  return items;
}

/* 读一个文件（限制长度，别把上下文撑爆） */
function readFile(rel, max) {
  const p = safePath(rel);
  const st = fs.statSync(p);
  if (st.isDirectory()) throw new Error('这是个文件夹，用 skill_ls 看里面');
  const cap = Math.max(500, Math.min(20000, Number(max) || 6000));
  const text = fs.readFileSync(p, 'utf8');
  return { text: text.slice(0, cap), truncated: text.length > cap, size: text.length, path: rel };
}

/* 写文件（自动建目录），限制单次大小 */
function writeFile(rel, content) {
  const p = safePath(rel);
  if (p === path.resolve(userDir())) throw new Error('不能写技能根目录');
  const text = String(content == null ? '' : content);
  if (text.length > 20000) throw new Error('内容太长（上限 20000 字）');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return { path: rel, bytes: Buffer.byteLength(text) };
}

/* 删文件（或空文件夹） */
function remove(rel) {
  const p = safePath(rel);
  if (p === path.resolve(userDir())) throw new Error('不能删技能根目录');
  const st = fs.statSync(p);
  if (st.isDirectory()) fs.rmdirSync(p);   // 只删空目录，防误删
  else fs.unlinkSync(p);
  return { path: rel };
}

module.exports = { list, catalog, read, memoryFacts, extras, openFolder, userDir, builtinDir, ensureBuiltins, parseFront, safePath, ls, readFile, writeFile, remove, NS };
