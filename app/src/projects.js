// 项目文件夹：桌宠写的"真·小软件"都放这里
//
//   <userData>/projects/<项目名>/index.html …
//
// 和技能目录一样带路径沙箱，只能在 projects/ 里操作。
// 多行代码不走单行 ACTION（装不下），而是让模型在回复里用块：
//   <<<WRITE: 番茄钟/index.html
//   <!doctype html> …
//   >>>
// 由主进程解析出来，交给渲染层做"允许/拒绝"再落盘。
const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');

function rootDir() {
  const d = path.join(app.getPath('userData'), 'projects');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

/* 相对路径 → projects/ 下的绝对路径，禁止越界 */
function safePath(rel) {
  const base = path.resolve(rootDir());
  const cleaned = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '').trim();
  const full = path.resolve(base, cleaned);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('路径越界（只能在项目文件夹里操作）');
  /* 上面只挡了 ".."、绝对路径、UNC、C:evil 这类字符串花招，挡不住**重解析点**：
     AI 可以用 proj_run 跑一个 `mklink /J out C:\Users` 的 bat，
     之后 proj_ls / proj_read / WRITE 块全都会跟着 junction 落到项目目录外。
     所以这里再把"真实路径"校验一遍。 */
  const real = realPathOf(full);
  const realBase = realPathOf(base);
  if (real && realBase && real !== realBase && !real.startsWith(realBase + path.sep)) {
    throw new Error('路径越界（解析链接/联结点后落在项目文件夹外）');
  }
  return full;
}

/* 取真实路径：从最深的"已存在祖先"开始 realpath，再把后面还不存在的尾巴接回去 */
function realPathOf(p) {
  let cur = p, tail = '';
  for (let i = 0; i < 40; i++) {
    try { return tail ? path.join(fs.realpathSync(cur), tail) : fs.realpathSync(cur); }
    catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail = tail ? path.join(path.basename(cur), tail) : path.basename(cur);
      cur = parent;
    }
  }
  return null;
}

function ls(rel) {
  const p = safePath(rel);
  const st = fs.statSync(p);
  if (!st.isDirectory()) return [path.basename(p)];
  return fs.readdirSync(p, { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.'))
    .map((d) => (d.isDirectory() ? d.name + '/' : d.name))
    .sort();
}

function readFile(rel, max) {
  const p = safePath(rel);
  if (fs.statSync(p).isDirectory()) throw new Error('这是文件夹，用 proj_ls 看里面');
  const cap = Math.max(500, Math.min(40000, Number(max) || 8000));
  const text = fs.readFileSync(p, 'utf8');
  return { text: text.slice(0, cap), truncated: text.length > cap, size: text.length };
}

/* 写一个文件（自动建目录）。单个文件上限 200KB，防跑飞 */
function writeOne(rel, content) {
  const p = safePath(rel);
  if (p === path.resolve(rootDir())) throw new Error('不能写项目根目录');
  const text = String(content == null ? '' : content);
  if (Buffer.byteLength(text) > 200 * 1024) throw new Error('文件太大（上限 200KB）：' + rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return { path: String(rel).replace(/\\/g, '/'), bytes: Buffer.byteLength(text) };
}

/* 批量写（来自回复里的 WRITE 块） */
function writeMany(files) {
  const out = [];
  for (const f of files || []) {
    if (!f || !f.path) continue;
    out.push(writeOne(f.path, f.content));
  }
  return out;
}

function remove(rel) {
  const p = safePath(rel);
  if (p === path.resolve(rootDir())) throw new Error('不能删项目根目录');
  const st = fs.statSync(p);
  if (st.isDirectory()) fs.rmSync(p, { recursive: true });
  else fs.unlinkSync(p);
  return { path: String(rel) };
}

/* 用系统默认程序打开（.html 就是浏览器） */
async function open(rel) {
  const p = safePath(rel);
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
  return { path: String(rel) };
}

/* 解析回复里的 WRITE 块（可能多个）
   结束标记必须是**单独一行**的 >>>：以前用非贪婪 `([\s\S]*?)…>>>`，
   内容里只要出现 `>>>`（JS 里 `a >>> 2` 非常常见）就会提前结束，
   文件被静默截断，工具还回"已写入 N 字节"，模型以为自己写对了。 */
function parseWriteBlocks(raw) {
  const out = [];
  const re = /<<<\s*WRITE\s*[:：]\s*([^\r\n]+?)\s*\r?\n([\s\S]*?)\r?\n[ \t]*>>>[ \t]*(?=\r?\n|$)/g;
  let m;
  while ((m = re.exec(String(raw || '')))) {
    const p = String(m[1]).trim().replace(/^["'`]|["'`]$/g, '');
    if (p) out.push({ path: p, content: m[2] });
  }
  return out;
}

function openFolder(rel) { return shell.openPath(rel ? safePath(rel) : rootDir()); }

/* ---------------- 执行脚本 ----------------
 * 只允许白名单解释器（不跑任意 exe），带超时强杀，输出/报错都抓回来给模型看。
 * 注意：这是**真在你电脑上跑程序**，沙箱拦不住它——所以执行权限由助手的权限档把关：
 *   normal/web 档 → 每次弹「允许 / 拒绝」
 *   full 完全权限 → 自动执行、不再确认
 */
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const MAX_OUT = 200000;   // 累积输出上限（字符）：以前是等进程结束才截断，死循环 print 能把内存顶到 GB 级

/* 杀**整棵**进程树：child.kill() 只杀直接子进程，而 .bat/.ps1 里再起的 python/node
   会变成孤儿继续跑（占 CPU/端口），应用既回收不了也管不到。 */
function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {}
  try { child.kill(); } catch {}
}

const RUNNERS = {
  '.py': [['python', (p) => [p]], ['py', (p) => [p]]],
  '.js': [['node', (p) => [p]]],
  '.mjs': [['node', (p) => [p]]],
  '.cjs': [['node', (p) => [p]]],
  '.bat': [['cmd', (p) => ['/c', p]]],
  '.cmd': [['cmd', (p) => ['/c', p]]],
  '.ps1': [['powershell', (p) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p]]],
};

function clipOut(s, max) {
  const t = String(s || '');
  const cap = max || 4000;
  return t.length > cap ? t.slice(0, cap) + '\n…（输出过长已截断，共 ' + t.length + ' 字）' : t;
}

function run(rel, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = safePath(rel);
    if (!fs.existsSync(p)) return reject(new Error('文件不存在：' + rel));
    if (fs.statSync(p).isDirectory()) return reject(new Error('这是个文件夹，不能运行'));
    const ext = path.extname(p).toLowerCase();
    const cands = RUNNERS[ext];
    if (!cands) {
      return reject(new Error('不支持直接运行 ' + (ext || '（无扩展名）') + '。能运行：' + Object.keys(RUNNERS).join(' / ') + '（网页 .html 请用 proj_open 打开）'));
    }
    const cwd = path.dirname(p);
    const t0 = Date.now();
    const limit = Math.max(3000, Math.min(300000, Number(timeoutMs) || 60000));
    let out = '', done = false, cut = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    /* 一边收一边就封顶：StringDecoder 保证多字节字符跨块不被切开（以前 out += d
       是逐块隐式 toString，中文/emoji 在分块边界会变 U+FFFD 乱码）。 */
    const dec = new StringDecoder('utf8');
    const take = (d) => {
      if (cut) return;
      const s = dec.write(d);
      if (out.length + s.length > MAX_OUT) {
        out += s.slice(0, Math.max(0, MAX_OUT - out.length));
        cut = true;
      } else out += s;
    };
    const tailNote = () => (cut ? '\n（输出过多，已提前停止累积）' : '');

    const tryAt = (i) => {
      if (i >= cands.length) return reject(new Error('没找到可用的解释器（试过：' + cands.map((c) => c[0]).join(' / ') + '）'));
      const [cmd, mk] = cands[i];
      let child;
      try {
        child = spawn(cmd, mk(p), { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { return tryAt(i + 1); }
      const timer = setTimeout(() => {
        killTree(child);
        finish({ path: String(rel), code: -1, timeout: true, ms: Date.now() - t0, output: clipOut(out) + tailNote() + '\n（超过 ' + Math.round(limit / 1000) + ' 秒，已连子进程一起强制结束）' });
      }, limit);
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', (e) => {
        clearTimeout(timer);
        if (done) return;
        if (e && e.code === 'ENOENT') { out = ''; cut = false; return tryAt(i + 1); }   // 解释器不在，换下一个
        done = true; reject(new Error('启动失败：' + ((e && e.message) || e)));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish({ path: String(rel), code, timeout: false, ms: Date.now() - t0, output: clipOut(out) + tailNote() || '(程序没有任何输出)' });
      });
    };
    tryAt(0);
  });
}

module.exports = { rootDir, safePath, ls, readFile, writeOne, writeMany, remove, open, openFolder, parseWriteBlocks, run };
