// OS 级键鼠输入：spawn 一个极小的原生 input.exe（user32 的 SendInput/mouse_event）。
// 坐标约定：模型看到的是抓帧尺寸（默认 1920x1080，可配）的屏幕截图，给的坐标也在这个空间里；
// 这里归一化成 0..1 再交给 exe，避免 DPI/分辨率差异。
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const userinput = require('./userinput');

/* ⚠️ 坐标空间**必须和抓帧尺寸一致**（模型报的 x,y 基于它）。
 * 以前写死 1280x720，而抓帧也写死 1280x720，所以恰好对上。
 * 现在抓帧尺寸可配（config.screenCaptureWidth/Height，默认 1920x1080 以看清细节），
 * 这里就必须跟着读 —— 否则模型按 1920 报坐标、这里按 1280 归一化，
 * 点击会整体偏到左下角（约 1.5 倍误差）。
 * 带 2 秒缓存：norm() 是每次点击都要走的热路径，不能每次读文件。 */
let _space = null, _spaceAt = 0;
function space() {
  if (_space && Date.now() - _spaceAt < 2000) return _space;
  let w = 1920, h = 1080;
  try {
    const c = require('./config').load();
    if (Number(c.screenCaptureWidth) > 0) w = Number(c.screenCaptureWidth);
    if (Number(c.screenCaptureHeight) > 0) h = Number(c.screenCaptureHeight);
  } catch {}
  _space = { w, h }; _spaceAt = Date.now();
  return _space;
}
const W = 1280, H = 720;   // 仅作历史默认值保留（下面 norm 已改用 space()）

function exePath() {
  const dev = path.join(__dirname, '..', 'vendor', 'input', 'input.exe');
  const packed = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'vendor', 'input', 'input.exe');
  if (fs.existsSync(dev)) return dev;
  if (fs.existsSync(packed)) return packed;
  return dev;
}

function norm(x, y) {
  const s = space();
  const nx = Math.max(0, Math.min(s.w, Number(x) || 0)) / s.w;
  const ny = Math.max(0, Math.min(s.h, Number(y) || 0)) / s.h;
  return [nx.toFixed(4), ny.toFixed(4)];
}

/* ★★★ D1：常驻 input.exe（省掉每次 spawn 的进程启动开销）★★★
   实测：原来每个动作 spawnSync 一个新进程 —— ★49ms/次★（12 次移动 592ms）。
   打游戏/连续操作要 5~10ms 才够用，所以必须常驻 ✓

   ★架构上的一个关键判断★：
     input.js 的返回值只表示"命令发出去了没有"✗ ——
     真正的"做没做成"是由 safedrive 回读光标、截帧比对来验证的 ✓✓
     （今天修的正是这个：以前 input.move() 返回 true 时光标可能差 551px ✗）
   → 所以常驻模式下**只要把命令写进 stdin 就算发成功** ✓，
     不需要等回复、不需要把 API 改成 async、不用动任何调用方 ✓
   → 但回复里的 ERR 还是要收下来写日志 ✓（不然出错就彻底看不见了）

   ★三条安全规矩（优化绝不能让键鼠失灵）★：
     ① 常驻起不来/崩了/写失败 → ★自动回退一次性 spawn★ ✓（原路径一字不改）
     ② 环境变量 PET_INPUT_ONESHOT=1 → 强制回退 ✓（一键关掉这个优化）
     ③ 常驻进程空闲太久自动收掉 ✓（别留一个孤儿进程）
*/
let _proc = null;
let _procAt = 0;
let _procErrs = [];
const PROC_IDLE_MS = 5 * 60 * 1000;

function oneshotForced() {
  return String(process.env.PET_INPUT_ONESHOT || '') === '1';
}

function procAlive() {
  if (!_proc || _proc.killed || _proc.exitCode !== null) return false;
  return true;
}

function ensureProc() {
  if (oneshotForced()) return null;
  if (procAlive()) {
    if (Date.now() - _procAt > PROC_IDLE_MS) { try { _proc.stdin.write("quit\n"); } catch (e) {} try { _proc.kill(); } catch (e) {} _proc = null; }
    else return _proc;
  }
  try {
    const { spawn } = require('child_process');
    _proc = spawn(exePath(), ['serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    _proc.stdout.setEncoding('utf8');
    _proc.stderr.setEncoding('utf8');
    /* ★ 收 ERR 与崩溃信息：优化之后如果出错，必须还能看见 ✓ */
    let acc = "";
    const onData = (d) => {
      acc += d;
      let i;
      while ((i = acc.indexOf("\n")) >= 0) {
        const line = acc.slice(0, i).trim();
        acc = acc.slice(i + 1);
        if (line.indexOf("ERR ") === 0) {
          _procErrs.push({ at: Date.now(), msg: line.slice(4) });
          while (_procErrs.length > 20) _procErrs.shift();
          try { require('./debug').log('[input] 常驻模式报错: ' + line.slice(4)); } catch (e) {}
        }
      }
    };
    _proc.stdout.on("data", onData);
    _proc.stderr.on("data", onData);
    _proc.on('exit', () => { _proc = null; });
    _proc.on('error', () => { _proc = null; });
    _procAt = Date.now();
    return _proc;
  } catch (e) { _proc = null; return null; }
}

/* 常驻进程的一次性调用（失败返回 false，由 run() 回退）*/
function tryProc(action, args) {
  const p = ensureProc();
  if (!p || !p.stdin || p.stdin.destroyed) return false;
  let line;
  if (action === "type") {
    /* ★ type 的文本必须走 base64★：协议按空格切，带空格/换行/中文的文本会被切碎 ✓ */
    line = "type " + Buffer.from(String(args[0] == null ? "" : args[0]), "utf8").toString("base64");
  } else {
    line = [action].concat(args.map(String)).join(" ");
  }
  try {
    p.stdin.write(line + "\n");
    _procAt = Date.now();
    return true;
  } catch (e) {
    _proc = null;
    return false;
  }
}

function procErrors() { return _procErrs.slice(); }

function procStatus() {
  return { persistent: procAlive(), oneshotForced: oneshotForced(), recentErrors: _procErrs.length };
}
function run(action, args) {
  const exe = exePath();
  if (!fs.existsSync(exe)) throw new Error('缺少 input.exe');
  /* ★ 优先走常驻进程；任何一步不对就回退到原来的 spawnSync 路径 ✓ */
  if (tryProc(action, args)) return true;
  const r = spawnSync(exe, [action].concat(args.map(String)), { encoding: 'utf8', timeout: 8000, windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('input 失败：' + String(r.stderr || '').trim());
  return true;
}

/* 落点要在**执行之前**登记（src/userinput.js 的让位检测用）：
 *   如果放在执行之后，轮询（默认 40ms）完全可能插在 run() 和 mark() 中间，
 *   于是她自己刚移过去的位移被当成"主人在用鼠标"→ 她一动就把自己暂停（实测踩到过）。
 *   登记失败绝不能影响真正要做的操作，所以整块 try 包住。
 *   注：动作失败时这条预期落点会失效，但检测里有 3 秒窗口 + 40px 半径，不会长期误判。 */
function mark(x, y) { try { userinput.notePetMoveModel(x, y); } catch {} }

function click(x, y) { const p = norm(x, y); mark(x, y); return run('click', p); }
function rclick(x, y) { const p = norm(x, y); mark(x, y); return run('rclick', p); }
function dclick(x, y) { const p = norm(x, y); mark(x, y); return run('dclick', p); }
function move(x, y) { const p = norm(x, y); mark(x, y); return run('move', p); }
function drag(x1, y1, x2, y2) { const p = norm(x1, y1).concat(norm(x2, y2)); mark(x2, y2); return run('drag', p); }
function scroll(x, y, delta) { const p = norm(x, y); mark(x, y); return run('scroll', p.concat([String(delta == null ? 120 : delta)])); }
function type(text) { return run('type', [String(text)]); }

/* 键名白名单（和 vendor/input/Input.cs 的 Vk() 保持一致）。
 * 为什么 Node 侧也要拦一道：C# 那边抛的是 "unknown key: cmd" 这种，模型拿到不知道怎么改；
 * 这里给它"可用哪些键"的明确提示，它下一轮就能自己改正。
 * 更重要的是**在 spawn 之前就拒绝** —— 坏键名根本不会碰到键盘。
 * （键盘卡死那个事故就是坏键名引起的，见 Input.cs 里 key 分支的注释。） */
const KEY_NAMES = ['enter', 'esc', 'escape', 'tab', 'space', 'backspace', 'delete', 'del', 'insert', 'ins',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'ctrl', 'control', 'alt', 'shift', 'win',
  /* 符号键的**名字**：模型很自然会写 `key|ctrl+plus`（想按 Ctrl++ 缩放），实测她就这么发过，
   被拒后白跑一步。这些名字在 Input.cs 的 Vk() 里都有对应 VK。 */
  'equal', 'minus', 'comma', 'period', 'dot', 'slash', 'backslash', 'semicolon', 'quote', 'apostrophe',
  'backtick', 'grave', 'bracketleft', 'lbracket', 'bracketright', 'rbracket',
  'add', 'numpadplus', 'subtract', 'numpadminus'];

/* 别名 → 规范写法。为什么需要：VK 层面 "+" 其实是 **shift + "=" 键**；
   而符号单字符（+ _ < > ? : " { } | ~）也都要带 shift 才是那个符号本身。
   以前这些要么被拒、要么更糟 —— 直接把 ASCII 当 VK 发出去（见 Input.cs 的修复），静默按错键。 */
const KEY_ALIAS = {
  plus: 'shift+equal', '+': 'shift+equal', underscore: 'shift+minus', '_': 'shift+minus',
  equal: 'equal', '=': 'equal', minus: 'minus', '-': 'minus',
  comma: 'comma', ',': 'comma', less: 'shift+comma', '<': 'shift+comma',
  period: 'period', dot: 'period', '.': 'period', greater: 'shift+period', '>': 'shift+period',
  slash: 'slash', '/': 'slash', question: 'shift+slash', '?': 'shift+slash',
  backslash: 'backslash', '\\': 'backslash', pipe: 'shift+backslash', '|': 'shift+backslash',
  semicolon: 'semicolon', ';': 'semicolon', colon: 'shift+semicolon', ':': 'shift+semicolon',
  quote: 'quote', apostrophe: 'quote', "'": 'quote', dquote: 'shift+quote', '"': 'shift+quote',
  backtick: 'backtick', grave: 'backtick', '`': 'backtick', tilde: 'shift+backtick', '~': 'shift+backtick',
  bracketleft: 'bracketleft', lbracket: 'bracketleft', '[': 'bracketleft',
  braceleft: 'shift+bracketleft', '{': 'shift+bracketleft',
  bracketright: 'bracketright', rbracket: 'bracketright', ']': 'bracketright',
  braceright: 'shift+bracketright', '}': 'shift+bracketright',
  add: 'add', numpadplus: 'add', subtract: 'subtract', numpadminus: 'subtract',
};
const KEY_HELP = '可用：enter / esc / tab / space / backspace / delete / up,down,left,right / home / end / '
  + 'pageup / pagedown / f1~f24 / 单个字母或数字 / 符号用名字写（plus minus equal comma period slash '
  + 'backslash semicolon quote backtick bracketleft bracketright add subtract）/ '
  + '组合键用 ctrl+alt+shift+win 加号连接（例如 ctrl+plus、ctrl+c）';
function validateKey(name) {
  const raw = String(name == null ? '' : name).toLowerCase().trim();
  if (!raw) throw new Error('按键名为空');
  /* 特例：整串就是 "+"。它同时是分隔符，split('+') 会得到两个空串、被当成格式错误 ——
     但模型很可能就写 key|+ 想按加号。这里直接按符号处理。 */
  if (raw === '+') return 'shift+equal';
  /* 逐段翻译，**允许别名展开成多段**并递归展开（plus → shift+equal）。
     第一版我加了"别名里含 + 就不翻译"想防重复展开，结果恰好把 plus 挡住了 ——
     因为 plus 的正确展开本来就带 +。最多展开 3 轮，防止别名互相引用时无限增长。 */
  let parts = [raw];
  for (let round = 0; round < 3; round++) {
    const next = [];
    let changed = false;
    for (const seg of parts) {
      for (const p of String(seg).split('+').map((x) => x.trim())) {
        if (!p) throw new Error('按键名写错了（是不是多了个 + ？）：' + raw);
        const a = KEY_ALIAS[p];
        if (a && a !== p) { next.push(a); changed = true; } else next.push(p);
      }
    }
    parts = next;
    if (!changed) break;
  }
  const okOne = (n) => KEY_NAMES.includes(n) || /^[a-z0-9]$/.test(n) || /^f([1-9]|1[0-9]|2[0-4])$/.test(n);
  for (const p of parts) {
    if (!okOne(p)) throw new Error('不认识的按键名「' + p + '」。' + KEY_HELP);
  }
  return parts.join('+');
}
function key(name) { return run('key', [validateKey(name)]); }

/* 把所有可能卡住的修饰键和鼠标键松开。
 * 这是"键盘被搞坏"的兜底：应用启动时清一次上次异常退出留下的卡键、
 * 游戏助手收手时、退出之前各调一次。
 * 实测旧版 input.exe 只要键名写错就会把 Ctrl 卡住（用户表现：输入不了东西、
 * 键盘像错位了，只能重启）—— 现在启动时就能自动治好。 */
function releaseAll() {
  try { return run('releaseall', []); } catch { return false; }
}

module.exports = { click, rclick, dclick, move, drag, scroll, type, key, W, H, exePath, norm, releaseAll, validateKey, procStatus, procErrors, KEY_NAMES, space };
