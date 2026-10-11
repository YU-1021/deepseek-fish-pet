const { app, shell, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');   // OCR 收 stdout 用（见 ocr() 的注释）
const web = require('./web');
const screenstream = require('./screenstream');
const input = require('./input');
const vision = require('./vision');
const config = require('./config');
const skills = require('./skills');
const style = require('./style');
const projects = require('./projects');
const personatags = require('./personatags');
/* ⚠️ 必须显式 require：find_template_scroll 里用了 userinput.waitUntilFree，
   而这里以前只在个别分支里内联 require —— 漏了就是运行时 ReferenceError（语法检查查不出来）。 */
const userinput = require('./userinput');

/* 【前台断言的状态】记住最近一次 focus_window 成功的目标窗口。
   为什么需要：Windows 把**键盘输入发给前台窗口**，而不是"最上层窗口"。
   2026-10-02 实测：她调 key|ctrl+f 得到 true，实际 Ctrl+F 发给了别的窗口；
   type|数据目录 得到 true，字打进了另一个程序的输入框 —— 而所有工具都报成功，
   她做错了却无从知道。
   现在：key/type/click 会检查"前台是不是还是那次 focus 的目标"，
   不一致就**明确报错并说明实际前台是谁**，而不是闷头执行再返回 true。 */
let lastFocus = null;

// 每个工具所需的最低权限档
const TOOL_TIER = {
  list_dir: 'read', read_file: 'read', use_skill: 'read', skill_ls: 'read', skill_read: 'read',
  write_file: 'full',    // 写任意绝对路径
  run_file: 'full',      // 跑任意绝对路径的脚本
  focus_window: 'full',  // 把窗口抬到最前（被别的窗口挡住时用）
  windows_list: 'full',  // 列出可见窗口（标题+位置尺寸，已换算成截图空间）
  make_template: 'full', // 从当前画面裁一块存成模板
  find_template: 'full', // 用模板匹配精确定位（替代让模型估坐标）
  template_list: 'read', template_del: 'normal',
  find_text: 'full',   // OCR 当前画面找一段文字并返回坐标（文字的模板匹配）
  find_template_scroll: 'full',  // 在列表里边滚边找模板，找不到会滚回原位
  watch_screen: 'full',          // 连续看屏幕（主人演示时她跟着学）
  proj_ls: 'read', proj_read: 'read', tag_list: 'read',
  open_path: 'normal', open_url: 'normal', skill_write: 'normal', skill_rm: 'normal', proj_rm: 'normal', proj_open: 'normal', proj_run: 'normal', proj_write: 'normal',
  tag_set: 'normal', tag_rm: 'normal',
  web_open: 'web', web_click: 'web', web_type: 'web', web_read: 'web',
  screen_shot: 'full', screen_look: 'full',
  click: 'full', rclick: 'full', dclick: 'full', move: 'full', drag: 'full', scroll: 'full', type: 'full', key: 'full',
  clickz: 'full', movez: 'full', rclickz: 'full', dclickz: 'full',
  game_start: 'full', game_stop: 'read', game_status: 'read',
};
const RANK = { off: 0, read: 1, normal: 2, web: 3, full: 4 };

function allowed(tier, tool) {
  // 停手和查状态永远允许：万一权限被调低，也得能让她把游戏助手停下来
  if (tool === 'game_stop' || tool === 'game_status') return true;
  /* 【唯一声明处】优先读能力注册表（src/registry.js）里"工具自己声明"的权限档；
     表里没有的（历史遗留、或注册表还没覆盖到的）回落到老的 TOOL_TIER。
     这样新加工具只要在 TOOL_DEFS 里写一行，权限/参数/超时三处同时生效。 */
  const def = TOOLS.get('tool', tool);
  const need = def ? def.tier : TOOL_TIER[tool];
  return !!need && (RANK[tier] || 0) >= RANK[need];
}

/* ---------------- 全屏截图（主屏） ----------------
   优先走连续屏幕流（抓一帧 ~50ms），流起不来退回 desktopCapturer（~650ms）。 */
function shotsDir() {
  const d = path.join(app.getPath('userData'), 'shots');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

async function captureScreen(withGrid, noCursor) {
  const frame = await screenstream.grabFrame({ grid: !!withGrid, noCursor: !!noCursor });
  if (frame && frame.dataUrl) {
    const p = path.join(shotsDir(), 'screen-' + Date.now() + '.jpg');
    fs.writeFileSync(p, Buffer.from(frame.dataUrl.split(',')[1], 'base64'));
    return { path: p, width: frame.width, height: frame.height, dataUrl: frame.dataUrl };
  }
  return captureScreenFallback();
}

async function captureScreenFallback() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;                 // DIP 尺寸
  const scale = primary.scaleFactor || 1;
  const tw = Math.round(width * scale), th = Math.round(height * scale);   // 物理像素，更清晰
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: tw, height: th } });
  let src = sources[0];
  const match = sources.find((s) => s.display_id === String(primary.id));
  if (match) src = match;
  /* 关键：整条链路（提示词、input.norm）都约定坐标空间是 1280x720，
     而回退路径原来返回的是物理分辨率（1920x1080 / 2560x1440）→ 模型按图上的像素报坐标
     会被 norm() 静默钳到屏幕右下角，点错位置还回"✅ 已点击"。
     这里直接缩放到 1280x720，让两条路径的坐标空间完全一致。 */
  const png = src.thumbnail.resize({ width: require('./input').space().w, height: require('./input').space().h }).toPNG();

  const p = path.join(shotsDir(), 'screen-' + Date.now() + '.png');
  fs.writeFileSync(p, png);
  const _s2 = require('./input').space();
  return { path: p, width: _s2.w, height: _s2.h, dataUrl: 'data:image/png;base64,' + png.toString('base64') };
}

/* OCR 的 JSON 模式：除了文字，还要每个词的包围盒 —— 这是 find_text 定位的依据。
 * Windows OCR 的 $result.Text 有个坑：CJK 会被它当"词"，于是在每个汉字之间插空格，
 * 而且**完全丢掉了位置**。所以定位必须走 ocr.ps1 -Json（Lines/ Words/ BoundingRect）。
 * 坐标系：包围盒是**送进图片的像素坐标**，我们送的就是 1920x1080 的全屏抓帧 → 直接可用。 */
/* ★ 最近一次 OCR 的真实失败原因 ★
   为什么要有它：这个函数失败时一律返回 null，调用方看到的就是"没读到文字" ✗ ——
   和 focuswin 那次"C# 编译失败 → 静默返回 0 个窗口"是同一类病（见 test-smoke.js 的说明）。
   返回 null 的语义保持不变（避免连锁改动），但把原因记在这里，出错时能一眼分清
   "真的没有文字" 和 "查询本身坏了"。 */
/* ★ 放大锚点守卫的状态（用途见 screen_look 分支里的长注释）★
   streak: 连续放大了几次还没看过整屏；last: 上一次放大的区域（x,y,w,h）
   ★为什么要有它★：实测她 44 次 screen_look 全是放大、一次整屏都没有 ✗，
   而且"宽度不变只加高度"地原地反复试 —— 提示词提醒不够，必须程序拦 ✓ */
const ZOOM_GUARD = { streak: 0, last: null };
let lastOcrError = '';
function ocrJson(pngPath) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, '..', 'scripts', 'ocr.ps1');
    let child, done = false, out = '', err = '';
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', pngPath, '-Json'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return fin(null); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} lastOcrError = 'OCR 超时（25s）'; fin(null); }, 25000);
    const dec = new StringDecoder('utf8');
    child.stdout.on('data', (d) => { if (out.length < 400000) out += dec.write(d); });
    child.stderr.on('data', (d) => { if (err.length < 4000) err += dec.write(d); });
    child.on('error', (e) => { clearTimeout(timer); lastOcrError = 'OCR 子进程错误：' + (e && e.message); fin(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const s = String(out || '').trim();
      const i = s.indexOf('{');
      /* ★ 静默失败整治（2026-10-03）★
         以前这里无论什么原因（PS 编译失败 / 脚本抛错 / 超时 / 被杀）都只 fin(null)，
         调用方看到的就是"这条 OCR 没读到文字" —— 方向完全错 ✗。
         现在仍然返回 null（保持调用方原有语义，避免连锁改动），
         但把真实原因记进模块级 lastOcrError。 */
      if (i < 0) {
        lastOcrError = 'OCR 无 JSON 输出' + (code ? '（退出码 ' + code + '）' : '')
          + (err ? '：' + String(err).slice(0, 200) : '');
        return fin(null);
      }
      try {
        const j = JSON.parse(s.slice(i));
        if (!j || !j.ok) {
          lastOcrError = 'OCR 脚本报错：' + JSON.stringify(j || {}).slice(0, 200) + (err ? ' ' + String(err).slice(0, 200) : '');
          return fin(null);
        }
        lastOcrError = '';
        return fin(j);
      } catch (e2) {
        lastOcrError = 'OCR JSON 解析失败：' + e2.message;
        fin(null);
      }
    });
  });
}

/* 在 OCR 结果里找一段文字，返回它的中心坐标（截图空间）。
 * 为什么要做这个：模板匹配能精确找"图"，但**不认字** —— 而游戏里大量目标只有文字
 * （干员名、设施名、列表项）。这个函数就是"文字的模板匹配"。
 * 匹配规则：把每行的词**首尾相连**（OCR 会在汉字间插空格，所以要先归一化），
 *   在归一化后的行文本里找目标子串，再把命中的字符区间映射回对应词的包围盒并求并集。
 * 这样即使目标被 OCR 拆成多个"词"（"进驻" + "总览"），也能整体命中。 */
function findTextInOcr(j, needle) {
  const target = String(needle || '').replace(/\s+/g, '');
  if (!target) return null;
  const lines = (j && j.lines) || [];
  for (const ln of lines) {
    const words = ln.words || [];
    if (!words.length) continue;
    /* 归一化：拼出"字符 -> 词索引"的映射 */
    let joined = '';
    const map = [];
    for (let wi = 0; wi < words.length; wi++) {
      const t = String(words[wi].t || '').replace(/\s+/g, '');
      for (let ci = 0; ci < t.length; ci++) { joined += t[ci]; map.push(wi); }
    }
    const at = joined.indexOf(target);
    if (at < 0) continue;
    const w0 = map[at], w1 = map[Math.min(map.length - 1, at + target.length - 1)];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let wi = w0; wi <= w1 && wi < words.length; wi++) {
      const w = words[wi];
      x0 = Math.min(x0, w.x); y0 = Math.min(y0, w.y);
      x1 = Math.max(x1, w.x + w.w); y1 = Math.max(y1, w.y + w.h);
    }
    if (!Number.isFinite(x0)) continue;
    return {
      x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2),
      box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      line: String(ln.text || ''), chars: target.length,
    };
  }
  return null;
}

/* Windows 自带 OCR（离线，支持中英文）。失败返回空串，不影响截图展示。
 *
 * 必须**异步**：以前用 spawnSync，主进程事件循环被整个占住——实测单次 420~570ms，
 * 期间宠物窗和对话窗完全点不动；多步看屏任务会一路卡顿。现在改成 spawn + Promise，
 * 上限仍是 25 秒，但不再阻塞任何东西。 */
function ocr(pngPath) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, '..', 'scripts', 'ocr.ps1');
    let child, done = false, out = '', err = '';
    const fin = (t) => { if (!done) { done = true; resolve(t || ''); } };
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', pngPath],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e0) { return fin(''); }
    /* ★ 同上的静默失败整治 ★ 下面 close 里会带上 stderr */
    const timer = setTimeout(() => { try { child.kill(); } catch {} fin(''); }, 25000);
    /* 用 StringDecoder 而不是 `out += d`：后者是**逐块隐式 toString('utf8')**，
       一个中文字被切在两次 data 事件之间就会解出 U+FFFD 乱码
       （projects.js 里踩过同一个坑，那边也是这么修的）。
       配合 ocr.ps1 里设的 UTF-8 输出编码，中文才不乱。 */
    const dec = new StringDecoder('utf8');
    child.stdout.on('data', (d) => { if (out.length < 40000) out += dec.write(d); });
    child.stderr.on('data', (d) => { if (err.length < 4000) err += dec.write(d); });
    child.on('error', () => { clearTimeout(timer); fin(''); });
    child.on('close', (code) => {
      clearTimeout(timer);
      /* 以前把 stdout + stderr 直接拼起来返回，于是 powershell 的报错文本会被当成
         "屏幕上识别到的文字"喂给模型（第 89 / 115 行）。现在失败一律当"没识别到"，
         并且把混在 stdout 里的报错行剔掉。 */
      if (code !== 0) {
        if (err.trim()) { try { console.error('[ocr] ' + err.slice(0, 300)); } catch {} }
        return fin('');
      }
      const lines = String(out).split(/\r?\n/).filter((l) =>
        !/^\s*(At line:|\+ |CategoryInfo|FullyQualifiedErrorId|Exception|MethodInvocationException|MissingMethodException)/.test(l));
      fin(lines.join('\n').trim());
    });
  });
}

/* 只读文件开头 n 个字符（用 fd 定位读，不把整个文件读进内存）。
   截断时按字符边界收一下，避免最后半个多字节字符变乱码。 */
function readHead(file, n) {
  const cap = Math.max(100, Number(n) || 3000);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(cap * 4);            // 按 UTF-8 最坏 4 字节/字符留量
    const got = fs.readSync(fd, buf, 0, buf.length, 0);
    let s = buf.slice(0, got).toString('utf8');
    if (s.length > cap) s = s.slice(0, cap);
    return s + (got >= buf.length ? '\n…（文件很大，只读了开头）' : '');
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

/* 最近一次"放大看"的参数，用来把放大图坐标换算回整屏坐标。
   为什么放在模块级：她"看"和"点"是两次独立调用（screen_look 之后才是 click），
   中间必须记住那块区域的偏移和缩放比。非放大的一次 screen_look 会把它清掉。 */
let ZoomState = null;
function zoomOut(x, y) {
  if (!ZoomState) return [x, y];
  try { return [Math.round(ZoomState.x + x / ZoomState.k), Math.round(ZoomState.y + y / ZoomState.k)]; }
  catch { return [x, y]; }
}

/* 【无进展检测】同一个工具 + 同一批参数，连续产生同样的结果 → 拦住她，逼她换办法。
 *
 * 为什么需要：调研参考项目 Coopanion/Cortico 时发现，它的 CUA 世界**没有任何**重复动作/
 * 无进展检测（作者在 Minecraft 世界做了：同一轮+同一工具+读数指纹相同 → 压缩回执，
 * 但没搬到 cua）。实测我们这边会原地打转：用户刚看到她"Let me list the windows"连说了 6 次，
 * 而步数上限又被提高到 68 步 —— 没有这道闸门，她能把预算全烧在同一个动作上。
 *
 * 判定：同一个 (工具|参数) 已出现过两次、且那两次的**回执指纹相同** → 第三次拒绝执行。
 * 为什么用"回执也相同"而不是单纯数次数：scroll / key|down 这类动作本来就该重复，
 * 但它们**成功时画面会变**（回执不同），所以不会被误判 —— 只有"做了跟没做一样"才拦。
 */
const actionLog = [];
const NO_PROGRESS_TOOLS = new Set(['list_dir', 'template_list', 'windows_list', 'screen_shot']);
function actFingerprint(tool, arg) { return String(tool) + '|' + String(arg || '').slice(0, 80); }
function noProgressWarning(tool, arg) {
  const fp = actFingerprint(tool, arg);
  const same = actionLog.filter((x) => x.fp === fp);
  if (same.length < 2) return '';
  const last = same[same.length - 1], prev = same[same.length - 2];
  if (last.res && prev.res && last.res === prev.res) {
    if (NO_PROGRESS_TOOLS.has(String(tool))) {
      return 'ℹ️ 这个问题你已经问过了，答案没变：「' + last.res.slice(0, 120) + '」。请基于这个结果往下走。';
    }
    return '⚠️ **原地打转**：你已经连续三次用 `' + fp + '` 拿到同样的结果（「' + last.res.slice(0, 100) + '」）。'
      + '再做一次不会有新结果。请**换一种完全不同的办法**：换坐标（±30~60px 的邻居）→ '
      + '先 screen_look|<问题>||x,y,w,h 放大看清 → 裁模板 make_template 后用 find_template 精确定位 → '
      + '退回上一层重新进 → 换个入口；或者如实上报卡在哪一步、需要主人做什么。';
  }
  return '';
}
function noteAction(tool, arg, result) {
  const fp = actFingerprint(tool, arg);
  /* 回执指纹：把所有数字抹掉（同一个按钮每次报的坐标会飘几十像素），只留结构 */
  const res = String(result == null ? '' : result).replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 160);
  actionLog.push({ fp, res });
  while (actionLog.length > 40) actionLog.shift();
}

/* 【重复调用提醒 —— 换成 DSH 的算法】见 src/repeat.js 的注释。
 * 旧的那套（上面的 noProgressWarning/noteAction）留着不删是因为它带"回执指纹"这一层判断，
 * 而新算法只看参数 —— 两者判的东西不同，暂时都保留观察；新算法是主路径。
 * 关键差别（照 dsh-repeat-tool-reminder）：
 *   · 判定键是【工具名 + 深度排序后的参数】，不是截断字符串；
 *   · 阈值 [3,5,8] 分三级，**只提醒、不否决**（在工具调用框架里否决会让会话状态对不上）；
 *   · 第 8 次起是安全阀（我们这边工具预算有限，DSH 没有步数预算这回事）；
 *   · **真用户消息一到就重置**（主人插话 = 环境变了）；
 *   · 未登记的工具"透明"：不计数也不清零。
 * 查询类工具（列目录/列模板/列窗口/截图）设为**不参与计数**，因为重复问一次本来就无害。 */
const REPEAT = require('./repeat').create({
  registry: { exclude: ['list_dir', 'template_list', 'windows_list', 'screen_shot', 'skill_ls', 'proj_ls'] },
  thresholds: [3, 5, 8],
  blockAt: 8,
});

/* 【能力注册表】见 src/registry.js —— 每个工具在这一个地方声明
   名字/权限档/是否需要参数/超时/说明；权限判定、参数检查、超时表都从它读。
   （起因：元信息散在三张手写表里，今天加了 windows_list/template_list 却漏登记 NOARG，
     导致它们不带参数必然报错。抄 DSH 的纪律：一个能力只声明一次。） */
const TOOLS = require('./registry').withTools();

/* 【统一超时表】见 src/timeout.js —— 一处声明、所有工具生效。 */
const { withTimeout, timeoutFor } = require('./timeout');

/* 【读后写 / CAS】见 src/obs.js —— 抄自 DSH dsh-fs-observation-policy。
   记"我读过哪些文件、读到时它是什么版本"，写之前校验，防**盲写覆盖**与**覆盖掉中间那次改动**。
   statOf：拿不到就当不存在（拿不到有两个原因：文件真不存在、或路径非法 —— 后者会在 checkWrite 里被拒）。 */
const OBS = require('./obs').create();
function statOf(p) { try { return fs.statSync(String(p == null ? '' : p)); } catch { return null; } }

/* 真正的执行体改名为 runInner；对外仍是 run（见文件末尾的包装）——
   这样"无进展检测"只需要在一个地方拦、在一个地方记账，不用去改 run 里面几十个 return。 */
async function runInner(tool, arg) {
  arg = String(arg == null ? '' : arg).trim();
  /* 【闸门也读注册表】原来是 `if (!TOOL_TIER[tool]) throw`，只看老表 ——
     结果我把 flow_* 注册进能力注册表、却忘了往 TOOL_TIER 里加，调用就报"未知操作"。
     这正是"元信息散在多张表里"的典型后果（今天已经栽过两次）。
     现在两处都认：注册表里有（TOOL_DEFS）就算已知，老表只作回落。 */
  if (!TOOLS.get('tool', tool) && !TOOL_TIER[tool]) throw new Error('未知操作：' + tool);

  if (tool.startsWith('web_')) return web.run(tool, arg);

  if (tool === 'screen_shot') {
    /* ⚠️ OCR 用图**不要画坐标网格**：那些刻度数字会被 OCR 当成屏幕上的文字读进去。
       网格只给视觉模型定位用（见下面的 screen_look）。 */
    const cap = await captureScreen(false);
    const text = await ocr(cap.path);
    const result = '🖥 已截取屏幕（' + cap.width + '×' + cap.height + '）\n'
      + (text ? '屏幕上识别到的文字：\n' + text : '（未识别到文字；截图已展示在对话里，你可以自己看）');
    return { text: result, image: cap.dataUrl, path: cap.path, ocr: text };
  }

  if (tool === 'screen_look') {
    /* 分段计时：抓帧 / 视觉 / OCR 各花了多久。
       "看屏幕要 6-7 秒太慢"这种问题，光看总耗时是没法优化的 ——
       实测抓帧热态只要 22ms、视觉 API 约 1.7s，加起来远小于总耗时，
       说明大头在别处。所以把每段都打出来，别猜。 */
    const timing = {};
    const tick = () => Date.now();
    const tCap = tick();
    /* 视觉这条路**要画坐标网格**：实测模型"估位置"在贴边处能差近 300px
       （鹰角启动器右下角按钮真实 (1837,1025)，它给 (1500,807)），
       有了刻度它就能"读"坐标而不是"估"。 */
    /* 放大看时**不要网格**：实测"网格 + 整屏换算"把她绕晕了 ——
       她自己报的："放大后视觉模型说编辑队列在约 (2200,600)，已经超出 1920 宽的屏幕范围"。
       放大图只让她按【放大图自己的像素坐标】报，换算由程序做（见 ZoomState / zoomConvert）。 */
    const zoomPre = (function () { try { return /\|\|\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*$/.test(String(arg || '')); } catch { return false; } })();
    /* 放大看时**走无损的 PNG 路径**：帧流是 JPEG，把它的压缩噪点放大 3 倍只会更糊 ——
       实测她的原话："这几张放大图太糊，我定不准卡片坐标"。PNG 那条路径
       （desktopCapturer 原生图 → resize → PNG）是无损的，放大出来的字是锐利的。 */
    /* ★ 不再画坐标网格（改成 false）★
       为什么原来画：那时候是要模型给**像素坐标**，实测它"估位置"在贴边处能差近 300px
       （鹰角启动器右下角按钮真实 (1837,1025)，它给 (1500,807)），有刻度它就能"读"而不是"估"。
       为什么现在不画：**协议已经改成归一化坐标 (0~1)**（见下面提示词的【怎么告诉我位置】）。
       刻度上写的是**像素数字**，留着只会诱导它报像素值；而它也没法从一个像素网格里
       量出 0~1 的归一化位置。实测换协议后同一个模型一次命中，光标精准落在目标名字上。
       ⚠️ 要退回旧协议（要像素坐标）就得把这个改回 true —— 两件事必须一起改，别只改一边。
       （放大看时本来就不画网格，见下面的注释。） */
    const cap = zoomPre ? await captureScreenFallback() : await captureScreen(false);
    if (!zoomPre) ZoomState = null;   // 普通看屏幕：清掉上一次的放大参数
    timing.captureMs = tick() - tCap;
    /* 【局部放大】用户点出的真问题："这不是游戏问题，而是你给她分辨率太低了"。
       实测：抓帧确实是 1920x1080（= 物理屏 1:1，不能再高），但**整屏只有 207 万像素**，
       游戏里一个小按钮才 ~40px，经视觉 API 再压一次就剩 ~30px
       → 于是同一个按钮她连续几次读出的坐标差 20~120px，怎么点都打不中。
       修法不是提高抓帧（已经到顶），而是**把要看的区域裁出来放大**：
       例如裁 640x360 放大到 1920 → 那个按钮在模型眼里变成 ~120px，坐标精度上一个数量级。
       用法：screen_look|<问题>||<x,y,w,h>   （x,y,w,h 是全屏 1920x1080 坐标） */
    let capDataUrl = cap.dataUrl;
    let zoomInfo = null;
    try {
      const mm = String(arg || '').match(/\|\|\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/);
      if (mm) {
        const _s = require('./input').space();
        const rx = Math.max(0, Math.min(_s.w - 40, Number(mm[1])));
        const ry = Math.max(0, Math.min(_s.h - 40, Number(mm[2])));
        const rw = Math.max(40, Math.min(_s.w - rx, Number(mm[3])));
        const rh = Math.max(40, Math.min(_s.h - ry, Number(mm[4])));
        /* ★★★ 放大锚点守卫（2026-10-03 的实测教训）★★★
           现场：主人让她在公招计算器里找「水月」。她 44 次 screen_look
           ★全部是放大、一次整屏都没有★ ✗，而且区域一直是 x=560 起、宽 540（右边界 1103）——
           而水月在 x=1272~1660。★她不是"没看见"，是目标压根不在她的任何一张图里 ✗★。
           更关键的是：她 4 次放大的**高度一路在加**（400→450→500）、**宽度纹丝不动** ——
           说明她意识到"没看全"，但**只会在原地扩大** ✗。
           ★为什么必须程序强制★：提示词里写"先整屏定位"是**不够的** ——
           她自己那份规程里"看小字必须放大"那一条就是提示词，而它反而把她带进了坑 ✓。
           两条硬约束（都是"拒绝这次调用 + 说清为什么"）：
             ① 连续放大 ≥4 次且中间没看过整屏 → 拒绝，要求先整屏定位 ✓
             ② 同一锚点「宽度没变、高度在加」→ 拒绝，提示"你漏的多半是左右" ✓
           ⚠️ 这两条只会在**明显绕进死胡同**时触发，正常放大不受影响 ✓ */
        const _prev = ZOOM_GUARD.last;
        if (ZOOM_GUARD.streak >= 4) {
          const _hit = ZOOM_GUARD.streak;
          ZOOM_GUARD.streak = 0;
          return '⚠️ 停一下 —— 你已经连续放大 ' + _hit + ' 次、中间**一次整屏都没看过** ✗\n'
            + '放大等于主动把视野缩小：如果锚点猜错，目标就永远进不了你的图，而且**你看不出来** ✓\n'
            + '（实测：你 44 次看屏幕全是放大，视野右边界卡在 1103，而要找的东西在 1272+ —— 永远找不到 ✓）\n'
            + '★现在请先看一次整屏★：`screen_look|<问题>`（不要带 || 区域），\n'
            + '问题这样问：「目标大概在屏幕的哪个位置？给我归一化坐标」。拿到位置后再放大那一块 ✓';
        }
        if (_prev && Math.abs(rw - _prev.w) <= 8 && rh > _prev.h + 20) {
          ZOOM_GUARD.last = { x: rx, y: ry, w: rw, h: rh };
          ZOOM_GUARD.streak++;
          return '⚠️ 你这个放大区域和上一次比：【宽度没变（' + rw + '）、高度在加（' + _prev.h + '→' + rh + '）】✗\n'
            + '★这个形状通常说明你漏的是【左右】，不是上下★ ✓\n'
            + '（实测：你在 x=560~1100 这一条里反复加高，而目标在 x=1272+ —— 加多高都看不到 ✓）\n'
            + '请回整屏看一次（`screen_look|<问题>`，不带 || 区域），确认目标到底在屏幕的哪一侧 ✓';
        }
        ZOOM_GUARD.streak++;
        ZOOM_GUARD.last = { x: rx, y: ry, w: rw, h: rh };
        const { nativeImage } = require('electron');
        const img = nativeImage.createFromDataURL(cap.dataUrl).crop({ x: rx, y: ry, width: rw, height: rh });
        const scaled = img.resize({ width: Math.min(1920, rw * 3), quality: 'best' });
        capDataUrl = scaled.toDataURL();
        zoomInfo = { x: rx, y: ry, w: rw, h: rh, scale: Math.round(Math.min(1920, rw * 3) / rw * 10) / 10, k: Math.min(1920, rw * 3) / rw };
        /* 记住它：她"看"和"点"是两次独立调用，中间必须靠它把放大图坐标换算回整屏坐标 */
        ZoomState = { x: rx, y: ry, k: zoomInfo.k };
        zoomInfo.outW = Math.min(1920, rw * 3);
        zoomInfo.outH = Math.round(rh * zoomInfo.k);
      } else {
        /* 整屏看了一次 → 计数清零 ✓（这正是我们想鼓励的行为 ✓） */
        ZOOM_GUARD.streak = 0; ZOOM_GUARD.last = null;
      }
    } catch (e) { zoomInfo = null; }
    const cfg = config.load();
    let text = '';
    let usedVision = false;
    let visionErr = '';
    let action = null;
    if (cfg.visionEnabled) {
      const _sp = require('./input').space(); const CAPW = _sp.w, CAPH = _sp.h; const CAPEX = Math.round(_sp.w / 2), CAPEY = Math.round(_sp.h / 2);
      /* ⚠️ 这段必须是**模板串（反引号）**：里面用了 ${CAPW}/${CAPH}/${CAPEX}/${CAPEY}。
         之前写成了单引号 → 占位符没被插值，**模型看到的字面就是 "${CAPW}x${CAPH}"**，
         于是它照着写 `click|${CAPW-20},${CAPH-20}` 被拒（"坐标格式应为 x,y"），白费一步。
         这是监视数据里从她的报错里挖出来的，不是什么模型犯傻。 */
      /* ⚠️ 坐标空间必须**随放大与否切换**：这一段原来写死"坐标基于 1920x1080 截图"，
         结果放大时模型仍按整屏空间报数（实测：480x360 的裁剪区，它报了 (530,580)），
         换算除下来就是 (177,193) 那种落在左上角的错点 —— 她连续两次点错就卡住了。
         这正是她自己报出来的："裁剪区是 480×360，但模型报的是 (530,580)，已经超出裁剪区"。 */
      const SPACE = zoomInfo
        ? { w: zoomInfo.outW, h: zoomInfo.outH, name: '放大图', ex: Math.round(zoomInfo.outW / 2) + ',' + Math.round(zoomInfo.outH / 2) }
        : { w: CAPW, h: CAPH, name: '整屏截图', ex: CAPEX + ',' + CAPEY };
      const _zoomNote = zoomInfo
        ? ('\n\n【重要】这一张是**放大图**：它是屏幕区域 (' + zoomInfo.x + ',' + zoomInfo.y + ') 起 '
           + zoomInfo.w + 'x' + zoomInfo.h + ' 裁出来放大的，放大倍数约 ' + zoomInfo.scale
           + '，**这张图本身的尺寸是 ' + zoomInfo.outW + 'x' + zoomInfo.outH + '**。\n'
           + '**不要自己换算成整屏坐标，也不要用 1920x1080 这个数字** —— 换算由程序做。'
           + '（你要点击时请用 find_text|<文字> 或 find_template|<名字> 让程序去精确定位，别直接给像素坐标。）')
        : '';
      const q = (arg || '看看屏幕') + _zoomNote + `\n\n【怎么告诉我位置】用**归一化坐标**：左上角是 (0,0)，右下角是 (1,1)，正中央是 (0.5,0.5)。
不要给像素值，也不要自己换算 —— 换算由程序做。
（以前这里是让模型"顺着刻度网格读像素坐标"，实测那套又绕又偏：同一个卡片它会报高整整一行 ✗。
  改成归一化坐标之后，实测同一个模型一次命中，光标精准落在目标名字上 ✓。）

【输出要求】先用一句中文说明你的判断（**说清你看到了什么、那个东西叫什么名字**）。
然后，按需要单独输出一行：
· 需要把**光标移到**某个东西上（只是悬停/指出位置，不点击）：
    ACTION: move_norm|<nx>,<ny>        例如 ACTION: move_norm|0.334,0.424
· 需要程序去**点击**某个能说出名字的东西时（更稳，因为程序会自己精确定位并复核）：
    ACTION: find_text|<目标上的文字>     或     ACTION: find_template|<已存的模板名>
⚠️ **绝对不要输出带像素坐标的点击**（如 click|960,540、clickz|400,200、move|x,y、drag|x,y|x,y）——
实测这么干会点错地方（在选人面板上点屏幕正中央 = 点到某张干员卡 = 把它选上/取消），
把已经做好的选择毁掉。
（move_norm 只**移动光标**、不按下任何键，所以安全；click 这类必须走 find_text/find_template。）
说不出名字就**只描述、不要给 ACTION**，让主人/自己下一步再看一次。`;
      /* tV 必须声明在 try **外面**：catch 里也要用它算耗时，
         写在 try 内的话失败路径会 ReferenceError（实测被 §6 那条测试抓住）。 */
      let tV = tick();
      try {
        text = await vision.describe(cfg, capDataUrl, q, cfg.visionDetail || 'high');
        timing.visionMs = tick() - tV;
        usedVision = true;
        const m = text.match(/ACTION\s*[:：]\s*([a-z_]+)\s*\|\s*(.+)/i);
        if (m && m[1].trim().toLowerCase() === 'move_norm') {
          /* ★★ ACTION: move_norm|<nx>,<ny> —— 归一化坐标，只移动光标、不点击 ★★
             为什么单独开这一条：今天实测（在公招计算器上找水月）——
               让视觉模型给**归一化坐标**，它一次命中，光标精准落在目标名字上 ✓；
               而让它"顺着刻度网格读像素坐标"，同一个卡片它报高了整整一行 ✗。
             为什么只允许"移动"、不允许"点击"：见下面那段事故注释 ——
               带像素坐标的点击曾经把已经选好的干员**取消掉**（屏幕正中央正好是一张卡）。
               移动光标没有副作用，所以可以放心交给它。 */
          const nm = String(m[2]).match(/(-?\d*\.?\d+)\s*[,，]\s*(-?\d*\.?\d+)/);
          if (nm) {
            const nx = Number(nm[1]), ny = Number(nm[2]);
            if (Number.isFinite(nx) && Number.isFinite(ny) && nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
              const _s = require('./input').space();
              const px = Math.round(nx * _s.w), py = Math.round(ny * _s.h);
              try {
                require('./input').move(px, py);
                dbg('[look] move_norm ' + nx + ',' + ny + ' → 屏幕 (' + px + ',' + py + ')');
                text += '\n\n【程序已执行】把光标移到了归一化坐标 (' + nx + ',' + ny + ') 对应的屏幕位置 ('
                  + px + ',' + py + ') —— 只是悬停，没有点击。';
              } catch (e) {
                text += '\n\n【程序未能移动光标】' + ((e && e.message) || e);
              }
            } else {
              text += '\n\n【move_norm 被忽略】归一化坐标必须都在 0~1 之间，收到的是 (' + nm[1] + ',' + nm[2] + ')。';
            }
          } else {
            text += '\n\n【move_norm 被忽略】没解析出两个数字。';
          }
        } else if (m) {
          const t = m[1].trim().toLowerCase();
          /* ★★ 只接受"有可验证目标"的动作 —— **裸坐标的点击一律拒绝** ★★
             实测事故链（用户的判断完全正确）：
               ① 视觉提示词以前在**教**它写 `ACTION: clickz|900,400`（见上面的改动）；
               ② 这里 `if (TOOL_TIER[t]) action = …` **照单全收**；
               ③ chat.js 的循环见到 r.action 就**跳过文本模型直接执行**。
             后果：视觉模型随口给一个 `click|960,540`（屏幕正中）就被真点下去 ——
               在干员选择面板上，屏幕正中央是**某张干员卡**，点它 = toggle，
               于是**把刚选好的干员取消掉了**；在基建总览上点正中 = 进到某个随机房间
               （这正是她"老落在制造站4"的原因）。她自己也报过"我瞄 1370,300 实际落在 1628,509"。
             现在只放行这几个"名字/模板驱动、能复核"的工具；其余一律忽略并记日志。 */
          const VISION_OK = ['find_text', 'find_template', 'find_template_scroll', 'focus_window', 'windows_list', 'key'];
          if (VISION_OK.indexOf(t) >= 0) {
            action = { tool: t, arg: m[2].trim() };
          } else {
            dbg('[look] 忽略视觉模型给的裸坐标动作：ACTION: ' + t + '|' + String(m[2]).slice(0, 40));
          }
        }
      } catch (e) {
        /* ⚠️ 这里以前是 `text = ''`，**把视觉失败完全吞掉**：key 过期 / 余额不足 /
         * 网络不通，全都表现成"降级成 OCR"，用户和模型都不知道出了什么事，
         * 还会一直重复调。现在把原因记下来、一并报回去（翻译过的可读版本由 vision.js 给）。 */
        timing.visionMs = tick() - tV;
        visionErr = String((e && e.message) || e);
        text = '';
      }
    }
    if (!text) {
      const tO = tick();
      const t = await ocr(cap.path);
      timing.ocrMs = tick() - tO;
      text = t ? ('屏幕上识别到的文字：\n' + t) : '（未识别到文字）';
      if (visionErr) text += '\n\n⚠️ 视觉模型调用失败，已降级为 OCR：' + visionErr;
      else if (!cfg.visionEnabled) text += '\n\n（config.json 里 visionEnabled 是关的，所以没走视觉模型）';
    }
    return {
      text: (usedVision ? '👁 视觉模型：\n' : '🖥 屏幕文字：\n') + text,
      image: cap.dataUrl, path: cap.path, action, visionErr, timing,
    };
  }

  // 这几个允许空参数（列根目录 / 停手 / 查状态），其它需要参数的工具才拦
  // 这几个允许空参数（列根目录 / 停手 / 查状态 / 列窗口 / 列模板 / 列流程），其它需要参数的工具才拦。
  // ⚠️ 实测踩过：今天新加的 windows_list / template_list 忘了登记在这里，
  //    结果**不带参数调用必然抛「操作参数为空」**——她之前能用只是因为 ACTION 里带了个空格（空格是 truthy）侥幸绕过。
  //    **根治办法**：改读能力注册表里"工具自己声明的 needsArg"（src/registry.js 的 TOOL_DEFS）。
  //    下面这张 NOARG 只作回落（注册表里没有的工具才用它），不再需要手工维护。
  const NOARG = { skill_ls: 1, proj_ls: 1, game_stop: 1, game_status: 1, screen_shot: 1, web_read: 1, windows_list: 1, template_list: 1, flow_list: 1 };
  const _tdef = TOOLS.get('tool', tool);
  const _needsArg = _tdef ? _tdef.needsArg !== false : !NOARG[tool];
  if (!arg && _needsArg) throw new Error('操作参数为空');
  if (tool === 'open_url') {
    if (!/^https?:\/\//i.test(arg)) throw new Error('网址需以 http(s):// 开头');
    await shell.openExternal(arg);
    return `✅ 已打开网页：${arg}`;
  }
  if (tool === 'open_path') {
    /* 注意：这里用系统默认处理器打开，**等于能运行任意程序**（.exe/.bat/.vbs/.hta 都会被执行），
       normal 档就能用。proj_run 的"解释器白名单"只约束 proj_run，不代表这一档只能跑白名单内的东西。 */
    const err = await shell.openPath(arg);
    if (err) throw new Error(err);
    return `✅ 已打开：${arg}`;
  }
  if (tool === 'clipboard_read') {
    /* 【读剪贴板】主人说"我刚复制的那个"时用。
       ★ 参数一律走 base64：命令行里直接塞中文/引号/换行会被吃掉（今天的教训：别猜，用编码）★ */
    const { execFileSync } = require('child_process');
    try {
      /* ★★ 必须让 PS 输出 base64 ★★
         第一版直接读 stdout，结果中文全变乱码（实测：写进去 24 字符，读回 33 字符的乱码）✗ ——
         原因是 PowerShell 5.1 的输出编码默认是 GBK，而 Node 按 UTF-8 解 ✓。
         （同一个坑今天早些时候在 Get-Content 上踩过一次。） */
      const out = execFileSync('powershell.exe',
        ['-NoProfile', '-Sta', '-Command', "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw)))"],
        { encoding: 'utf8', timeout: 10000, windowsHide: true });
      let txt = '';
      try { txt = Buffer.from(String(out || '').trim(), 'base64').toString('utf8'); } catch (e) { txt = ''; }
      if (!txt.trim()) return '📋 剪贴板是空的（或者里面不是文本 —— 图片这种暂时读不了）。';
      return '📋 剪贴板里有 ' + txt.length + ' 个字符：\n' + txt.slice(0, 3000)
        + (txt.length > 3000 ? '\n…（只显示前 3000 字）' : '');
    } catch (e) {
      return '📋 读剪贴板失败：' + ((e && e.message) || e) + '（可能是剪贴板被别的程序独占，稍后再试一次）。';
    }
  }
  if (tool === 'clipboard_write') {
    /* 【写剪贴板】文本走 base64 传参，避免引号/换行/中文被命令行解析吃掉 */
    const { execFileSync } = require('child_process');
    const text = String(arg == null ? '' : arg);
    if (!text) return '用法：clipboard_write|<要复制的文本>';
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const ps = "Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "')))";
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', ps], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      /* ★ 回读校验：写完立刻读回来对一遍，别假成功（今天的教训）★ */
      let back = '';
      try {
        const rb = execFileSync('powershell.exe',
          ['-NoProfile', '-Sta', '-Command', "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw)))"],
          { encoding: 'utf8', timeout: 10000, windowsHide: true });
        try { back = Buffer.from(String(rb || '').trim(), 'base64').toString('utf8'); } catch (e) { back = ''; }
      } catch (e) {}
      const ok = back.trim() === text.trim();
      return (ok ? '📋 ✅ 已经放进剪贴板了（回读核对一致），' : '📋 ⚠️ 写入后回读**对不上**（可能被别的程序改过），')
        + '主人可以去 Ctrl+V 粘贴了。共 ' + text.length + ' 个字符。';
    } catch (e) {
      return '📋 写剪贴板失败：' + ((e && e.message) || e);
    }
  }
  if (tool === 'uia_snapshot') {
    /* ★★ 把窗口里所有【可交互控件】列成编号清单（抄 Windows-MCP 的 Snapshot 设计）★★
       为什么需要（两条实测教训）：
         ① 她 57 条动作记录里 58 个工具只用过 9 个，从没用过 uia_find ——
            ★不是它不好用，是她不知道该拿什么名字去查★ ✓
         ② 中文界面的控件名是中文：计算器数字键 5 的 name 是「五」而不是 "5" ✗
            —— 光给 uia_find 一个工具，她只会一直猜错名字然后放弃 ✓
       Windows-MCP 的做法是给一次全桌面 Snapshot，返回"可交互元素 id"，
       模型选编号而不是猜像素。这里做同一件事，但走 UIA 控件树（零识别）✓。
       ⚠️ 一律按 hwnd 取（先 listWindows + pickShown 挑真正显示着的那个）——
         uia.js 的注释里有实战：3 个「计算器」窗口按标题 NOTFOUND，按 hwnd 一次拿到 ✓ */
    const want = String(arg == null ? '' : arg).trim();
    if (!want) return '用法：uia_snapshot|<窗口标题片段>   例：uia_snapshot|计算器';
    const fw2 = require('./focuswin');
    const l = await fw2.listWindows();
    const cands = (l.windows || []).filter((w) => String(w.title).indexOf(want) >= 0);
    if (!cands.length) {
      return '🔎 没有找到标题含「' + want + '」的窗口。当前可见窗口：\n'
        + (l.windows || []).filter((w) => w.visible !== false).slice(0, 12)
            .map((w) => '  · ' + w.title).join('\n');
    }
    const picked = fw2.pickShown(cands);
    const win = picked.win || cands[0];
    const uia = require('./uia');
    const r = await uia.listElements('', win.hwnd);
    const els = (r && r.elements) || [];
    if (!els.length) {
      return '🔎 窗口「' + win.title + '」（hwnd=' + win.hwnd + '）的控件树是空的。\n'
        + '★这通常说明它是【游戏 / 画布 / 自绘界面】—— 这类没有控件树，请改用 screen_look + 模板/OCR★';
    }
    /* 只留有名字的、且类型是可交互的 */
    const INTERACTIVE = /^(Button|Edit|ComboBox|CheckBox|RadioButton|ListItem|MenuItem|TabItem|Hyperlink|Slider|Spinner|TreeItem|SplitButton|ToggleButton|DataItem|Text)$/i;
    const clickable = els.filter((e) => e.name && String(e.name).trim() && INTERACTIVE.test(String(e.controlType || '')));
    /* 按位置排序（上→下、左→右），编号才符合直觉 */
    clickable.sort((a, b) => (Math.abs(a.y - b.y) > 8 ? a.y - b.y : a.x - b.x));
    const list = clickable.slice(0, 60);
    if (!list.length) {
      return '🔎 窗口「' + win.title + '」里有 ' + els.length + ' 个控件，但**没有一个带名字的可交互控件** ✗\n'
        + '→ 改用 screen_look 看画面，或用 find_text/find_template 定位。';
    }
    const lines = list.map((e, i) =>
      String(i + 1).padStart(2) + '. 「' + String(e.name).slice(0, 26) + '」  '
      + String(e.controlType || '?').padEnd(12)
      + (e.automationId ? (' id=' + String(e.automationId).slice(0, 24)).padEnd(28) : ' '.repeat(28))
      + ' 中心 ' + Math.round(e.x) + ',' + Math.round(e.y));
    return '🔎 窗口「' + win.title + '」里可交互控件 ' + clickable.length + ' 个'
      + (clickable.length > 60 ? '（只列前 60 个）' : '') + '：\n' + lines.join('\n')
      + '\n\n★下一步：★ 挑一个控件，用 ACTION: uia_find|' + want + '|<它的名字或 id> 拿精确坐标，'
      + '再 ACTION: click|<坐标>。\n'
      + '（坐标是应用自己报的，不用看图；中文界面的名字就是中文，照抄清单里的「」内容即可。）';
  }
  if (tool === 'wait_for') {
    /* ★★★ 轮询等条件 —— 治"固定睡 N 秒"这个顽疾 ★★★
       起因（实测）：她点"基建"之后**立刻** screen_look，而游戏切界面要 1~2 秒，
       她看到旧画面就以为没点进去，换坐标再点、再点，连点三次 ✗。
       原来的权宜之计是动作后统一固定等 actionSettleMs（默认 1500ms）——
       等太短会看到旧画面，等太长就是白等 ✗。
       ★ 正确做法：把"猜时间"换成"等条件"★ —— 条件成立立刻走，超时就说清最后检查到什么。
       格式：wait_for|<类型>|<目标…>|<超时秒>   （★最后一段永远是超时秒数★）
         window|<标题片段>|8
         element|<窗口标题片段>|<控件名或AutomationId>|8
         text|<画面上的文字>|8
         change|8            （等画面变化）
       四种条件的零件她**本来就全有**：uia.js / ocrJson / listWindows / framediff ✓ */
    const parts = String(arg == null ? '' : arg).split('|').map((x) => x.trim());
    const kind = String(parts[0] || '').toLowerCase();
    if (!kind) return '用法：wait_for|<window|element|text|change>|<目标…>|<超时秒>\n例：wait_for|window|计算器|8';
    const tail = parts[parts.length - 1];
    const hasTimeout = parts.length > 1 && /^\d+(\.\d+)?$/.test(tail);
    const timeoutS = Math.max(1, Math.min(120, hasTimeout ? Number(tail) : 10));
    const targets = parts.slice(1, hasTimeout ? -1 : undefined).filter((x) => x !== '');
    const t0 = Date.now();
    let lastInfo = '（还没检查过）';
    let baseline = null;
    if (kind === 'change') {
      try { baseline = await captureScreen(false); } catch (e) { lastInfo = '抓初始帧失败：' + e.message; }
    }
    const sleepMs = (n) => new Promise((r) => setTimeout(r, n));
    while (Date.now() - t0 < timeoutS * 1000) {
      try {
        if (kind === 'window') {
          const want = targets[0] || '';
          const l = await require('./focuswin').listWindows();
          const hit = (l.windows || []).find((w) => String(w.title).indexOf(want) >= 0 && w.visible !== false);
          if (hit) return '✅ 条件成立（等了 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）：窗口「' + hit.title + '」出现了，' + hit.x + ',' + hit.y + ' ' + hit.w + 'x' + hit.h;
          const all = (l.windows || []).filter((w) => String(w.title).indexOf(want) >= 0);
          lastInfo = all.length ? ('有 ' + all.length + ' 个标题含「' + want + '」的窗口，但都是隐藏/最小化的') : ('没有任何窗口标题含「' + want + '」');
        } else if (kind === 'element') {
          const win = targets[0] || ''; const name = targets[1] || '';
          if (!win || !name) return '用法：wait_for|element|<窗口标题片段>|<控件名或AutomationId>|<超时秒>';
          const uia = require('./uia');
          /* ⚠️ 用 uia.locate() 而不是 findElement()：
             实测 findElement 返回的是 {window, elements, count}（原始清单），
             我第一版按 r.found 判断，于是控件明明在也一直判"没有" ✗
             —— 是 live 测试（wait_for|element|计算器|num5Button 超时）抓出来的。 */
          const r = await uia.locate(win, name);
          if (r && r.ok) {
            const nm = (r.extra && r.extra.name) || name;
            return '✅ 条件成立（等了 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）：控件「' + nm + '」出现了，中心 '
              + Math.round(r.x) + ',' + Math.round(r.y) + '（' + (r.how || 'uia') + '）';
          }
          lastInfo = (r && r.reason) ? ('窗口「' + win + '」里还没找到「' + name + '」（' + r.reason + '）')
            : ('窗口「' + win + '」里还没有名字含「' + name + '」的控件');
        } else if (kind === 'text') {
          const want = targets[0] || '';
          if (!want) return '用法：wait_for|text|<画面上的文字>|<超时秒>';
          const cap = await captureScreen(false);
          const j = await ocrJson(cap && cap.path);
          const f = findTextInOcr(j, want);
          if (f) return '✅ 条件成立（等了 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）：画面上出现了「' + want + '」，位置约 ' + Math.round(f.x) + ',' + Math.round(f.y);
          lastInfo = '画面上还没看到「' + want + '」（OCR ' + (j && j.words ? j.words.length : 0) + ' 个词）';
        } else if (kind === 'change') {
          if (!baseline) { lastInfo = '没有基准帧，无法比对'; }
          else {
            const now = await captureScreen(false);
            const fd = require('./framediff');
            const d = fd.diffBgra(baseline.bgra, now.bgra, baseline.width, baseline.height);
            const sum = fd.summarize(d);
            if (sum && sum.ratio > 0.002) {
              return '✅ 条件成立（等了 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）：画面变了，约 ' + (sum.ratio * 100).toFixed(2) + '% 的像素不同';
            }
            lastInfo = '画面还没变化（差异 ' + (sum && sum.ratio != null ? (sum.ratio * 100).toFixed(3) + '%' : '?') + '）';
          }
        } else {
          return '未知条件类型「' + kind + '」。可用：window / element / text / change';
        }
      } catch (e) { lastInfo = '检查时出错：' + ((e && e.message) || e); }
      await sleepMs(300);
    }
    return '⏱ 超时 ' + timeoutS + ' 秒，条件仍未成立。\n最后一次检查：' + lastInfo
      + '\n★ 别用同样的方式重试 —— 换个思路（换目标名、先 focus_window、或先确认窗口真的显示着）★';
  }
  if (tool === 'list_dir') {
    const items = fs.readdirSync(arg).slice(0, 80);
    return `📂 ${arg}（${items.length} 项）：\n${items.join('\n')}`;
  }
  if (tool === 'shell_run' || tool === 'shell_status' || tool === 'shell_close') {
    /* ★ 常驻 shell 会话（B1）★
       为什么需要：proj_run 是一次性 spawn —— cd 不留、环境不留，
       "进目录 → 装依赖 → 编译 → 看报错 → 改"这条链是断的。
       实现见 src/shell.js（命令与输出都走 base64，避免 PowerShell 的 GBK stdin 把中文弄乱）。 */
    const sh = require('./shell');
    if (tool === 'shell_status') {
      const st = sh.status();
      return '🐚 常驻会话：' + (st.alive ? '活着' : '没开')
        + '　当前目录：' + (st.cwd || '（未建立）')
        + '　' + (st.busy ? '★正忙★' : '空闲') + '　'
        + (st.lastAt ? ('上次活动 ' + Math.round(st.idleMs / 1000) + ' 秒前') : '');
    }
    if (tool === 'shell_close') {
      const st = sh.status();
      sh.close('她主动关');
      return '🐚 已关闭常驻会话（' + (st.cwd ? ('原来在 ' + st.cwd) : '本来就没开') + '）。下次 shell_run 会自动重开一个。';
    }
    const cmd = String(arg == null ? '' : arg);
    if (!cmd.trim()) return '用法：shell_run|<要执行的命令>';
    let r;
    try { r = await sh.run(cmd, timeoutFor('shell_run') || 300000); }
    catch (e) { return '🐚 ❌ 执行失败：' + ((e && e.message) || e); }
    const head = r.timeout
      ? '⏱ ' + r.error
      : (r.ok ? '✅ 跑完了（退出码 ' + (r.code === null ? '0/不适用' : r.code) + '）'
              : '❌ 退出码 ' + (r.code === null ? '未知' : r.code));
    return '🐚 ' + head + '　当前目录：' + (r.cwd || '?') + '\n--- 输出 ---\n'
      + String(r.output || '').trim().slice(0, 6000)
      + (r.error && !r.timeout ? ('\n' + r.error) : '');
  }
  if (tool === 'search_code') {
    /* ★ 代码内容搜索（B2）★
       她有 list_dir（看名字）和 read_file（读一个文件），但没有"哪个文件里有这个东西" ——
       而"后面要写程序"里这恰恰是最常用的一步。纯 Node 实现，见 src/search.js。 */
    const parts = String(arg == null ? '' : arg).split('|');
    const pat = String(parts[0] || '').trim();
    const root = String(parts[1] || '').trim();
    const extArg = String(parts[2] || '').trim();
    if (!pat) return '用法：search_code|<要搜的正则或文字>|<目录>|<可选的扩展名开关，如 js,ts>';
    if (!root) return '还要给我一个目录，例如 search_code|buildToolList|C:\\deepseek\\desktop-pet\\app';
    const exts = extArg ? extArg.split(/[,\s]+/).map((x) => x.replace(/^\./, '').toLowerCase()).filter(Boolean) : null;
    const SEARCH = require('./search');
    const r = SEARCH.search(pat, root, { exts, maxHits: 60, timeoutMs: 15000 });
    if (!r.ok) return "🔍 " + r.error;
    if (!r.hits.length) {
      return "🔍 在 " + root + " 里没找到「" + pat + "」（扫了 " + r.scanned + " 个文件，" + r.ms + "ms）"
        + (r.truncated ? "\n★ 注意：这次【没搜完】（撞上时间或文件数预算）—— 不排除后面还有，别当成「确实没有」★" : "")
        + "\n（已跳过 node_modules/.git/dist/浏览器缓存等目录、二进制文件和 >2MB 的文件）";
    }
    const body = r.hits.map((h) => h.file + ":" + h.line + ": " + h.text).join("\n");
    return "🔍 找到 " + r.hits.length + " 条（分布在 " + r.matchedFiles + " 个文件；扫了 " + r.scanned + " 个文件，" + r.ms + "ms）"
      + (r.truncated ? "　★已截断：结果不止这些★" : "")
      + (r.literalFallback ? "\n（" + r.matcherNote + "）" : "")
      + "\n" + body;
  }
  if (tool === 'sys_info') {
    /* ★ 系统信息（B4）★ —— 主人问电量/磁盘/内存时用它，别去 OCR 托盘小字 ✓ */
    const si = require('./sysinfo');
    const arg0 = String(arg == null ? '' : arg).trim();
    const r = arg0 ? si.only(arg0) : si.collect();
    const parts = (r && r.parts) || [];
    if (!parts.length) return '🖥 没查到信息' + (arg0 ? ('（可以试试 battery / disk / net / mem，或者不带参数查全部）') : '');
    return '🖥 ' + parts.join('；')
      + ((r.warn && r.warn.length) ? ('\n（' + r.warn.join('；') + '）') : '');
  }
  if (tool === 'remind_in' || tool === 'remind_at' || tool === 'remind_list' || tool === 'remind_cancel') {
    /* ★ 提醒（B3）★ —— 提醒落盘，重启也在（见 src/remind.js）✓ */
    const RM = require('./remind');
    const parts = String(arg == null ? '' : arg).split('|');
    const fmt = (ms) => { const d = new Date(ms); return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
    if (tool === 'remind_list') {
      const l = RM.list();
      if (!l.length) return '⏰ 现在没有待提醒的事。';
      return '⏰ 待提醒 ' + l.length + ' 条：\n' + l.map((x) => '  ' + x.id + '　' + fmt(x.at) + '（还有 ' + (x.inMin >= 60 ? (Math.round(x.inMin / 6) / 10 + ' 小时') : (x.inMin + ' 分钟')) + '）　' + x.text).join('\n');
    }
    if (tool === 'remind_cancel') {
      const r = RM.cancel(parts[0]);
      return r.ok ? ('⏰ 已取消：' + r.item.text + '（' + fmt(r.item.at) + '）') : ('⏰ ' + r.error);
    }
    const text = parts.slice(1).join('|').trim();
    if (!text) return '要提醒什么内容？例如 ' + (tool === 'remind_in' ? 'remind_in|30|去喝水' : 'remind_at|14:30|开会');
    const r = tool === 'remind_in' ? RM.inMinutes(parts[0], text) : RM.atClock(parts[0], text);
    if (!r.ok) return '⏰ ' + r.error;
    return '⏰ 记下了：' + fmt(r.item.at) + ' 提醒你「' + r.item.text + '」（编号 ' + r.item.id + '，可以用 remind_cancel|' + r.item.id + ' 取消）';
  }
  if (tool === 'check_code') {
    /* ★ 代码检查（C2）★ —— 不装 LSP，走语言自带的检查器（见 src/checkcode.js）
       写程序时最卡人的一步就是"我改完这个文件它还能跑吗"，这里给出确定答案 ✓ */
    const cc = require('./checkcode');
    const f = String(arg == null ? '' : arg).trim();
    if (!f) return '用法：check_code|<文件路径>';
    const r = cc.check(f);
    return (r.ok ? '✅ ' : '❌ ') + r.kind + '　' + (r.ms || 0) + 'ms\n'
      + (r.note ? (r.note + '\n') : '')
      + (r.error ? ('--- 问题 ---\n' + String(r.error).slice(0, 1500)) : '');
  }
  if (tool === 'doc_read') {
    /* ★ 文档读取（C3）★ —— 零新依赖（靠她已有的 unzipper + XML 解析）
       为什么没走 MCP / Python：★这台机器上没有可用的 Python★（store 占位符，返回 9009），
       而文档处理类 MCP server 绝大多数是 Python 写的 → 两条路都断 ✓
       而 xlsx/docx 的格式就是 zip + XML，她 node_modules 里两样都有 ✓ */
    const parts = String(arg == null ? '' : arg).split('|');
    const f = String(parts[0] || '').trim();
    const sheet = String(parts[1] || '').trim();
    if (!f) return '用法：doc_read|<文件路径>|<可选的工作表名>';
    const docs = require('./docs');
    let r;
    try { r = await docs.read(f, sheet ? { sheet } : {}); }
    catch (e) { return '📄 读文档出错：' + ((e && e.message) || e); }
    if (!r.ok) return '📄 ' + (r.error || '读不了这个文件');
    return '📄 ' + r.kind + '　' + (r.chars || 0) + ' 字'
      + (r.paragraphs ? ('／' + r.paragraphs + ' 段') : '')
      + (r.sheets && r.sheets.length ? ('／工作表：' + r.sheets.join('、')) : '')
      + (r.truncated ? '　★内容太长已截断★' : '')
      + '\n--- 内容 ---\n' + String(r.text || '');
  }
  if (tool === 'read_file') {
    /* 只读前 3000 字。以前是 readFileSync 整读再 slice——模型给个大文件路径
       （C:\Windows\Logs\CBS\CBS.log、视频、hiberfil.sys）主进程就同步卡死+内存暴涨，
       而且 read 档就能调用，用户很容易点"允许"。 */
    const text = readHead(arg, 3000);
    /* 记下"我观测过这个文件"（连同它当时的版本）—— 写的时候用它做 CAS 检查 */
    OBS.noteObserved(String(arg || ''), statOf(arg), 'read');
    return `📄 ${arg}：\n${text}`;
  }
  if (tool === 'write_file') {
    /* 【为什么加它】实测发现的能力缺口：
     * 主人说"在 C:\deepseek\pet-test 下新建 hello.txt"，
     * 而当时**只有** proj_write 能写文件，它是**沙盒内**的（相对路径、落在
     * %APPDATA%\<app>\projects\ 下）—— 于是她"换个地方写完 + 报成功"，
     * 主人去指定目录一看什么都没有，就成了"她说了做了其实没做"。
     * 现在补一个**绝对路径**的写入（和 read_file/list_dir 同一族，权限档 full），
     * 让"写到主人指定的目录"这件事真的做得成。
     *
     * 安全边界：只允许绝对路径（相对路径一律拒绝，免得又落进沙盒让人误解）；
     * 单次内容上限 200KB；写入前把父目录建出来；返回**绝对路径**，让主查看得见落点。 */
    const raw = String(arg || '');
    const i = raw.indexOf('||');
    if (i < 0) throw new Error('格式：write_file|C:\\完整\\路径\\文件名||文件内容');
    const p = raw.slice(0, i).trim().replace(/^["']|["']$/g, '');
    const content = raw.slice(i + 2);
    if (!path.isAbsolute(p)) {
      throw new Error('write_file 需要**绝对路径**（例如 C:\\deepseek\\pet-test\\hello.txt）。'
        + '如果你是想写到自己的项目沙盒里，请改用 proj_write|<相对路径>||<内容>。收到的是：' + p);
    }
    if (Buffer.byteLength(content, 'utf8') > 200 * 1024) throw new Error('内容超过 200KB，太大了');
    /* 【读后写 / CAS】照 DSH dsh-fs-observation-policy：
       · 目标是新建（不存在）→ 只允许 createIfAbsent；
       · 目标已存在 → 必须**先读过**它，而且**版本要和读到时一致**（mtime+size）——
         否则说明它在读过之后被别人改过，这时写下去会把那次改动**静默覆盖**掉。
       拒绝时返回一句能指导下一步的话（附带错误码便于排查），而不是直接抛异常。 */
    const _st = statOf(p);
    const _ck = OBS.checkWrite({ path: p, mode: _st ? 'replaceIfVersion' : 'createIfAbsent', stat: _st });
    if (!_ck.ok) return '🚫 没有写入（' + _ck.code + '）：' + _ck.message;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
    /* 写完立刻重新登记新版本，否则"连着改两次"会被自己的 CAS 拦下 */
    OBS.noteObserved(p, statOf(p), 'write');
    return '💾 已写入：' + p + '（' + Buffer.byteLength(content, 'utf8') + ' 字节）';
  }

  /* ---------------- 技能：按需加载完整说明 ---------------- */
  if (tool === 'use_skill') {
    const s = skills.read(arg);
    if (!s) {
      const ids = skills.list().map((x) => x.id).join('、') || '(暂无)';
      throw new Error('没有这个技能：' + arg + '。可用技能：' + ids);
    }
    let out = '📘 技能「' + s.name + '」\n' + s.body;
    if (s.memory && s.memory.length) {
      const facts = s.memory.slice().sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0)).slice(0, 10);
      out += '\n\n【这个技能积累下来的经验】\n' + facts.map((f) => '- ' + f.text).join('\n');
    }
    /* 【技能 × 记忆 联动的闭环】她归档经验时写的是**技能文件夹里的文件**
       （例如 skills/play-game/网页排班/经验.md），而这里原来只给 SKILL.md 正文 ——
       于是攒下来的经验下次加载**根本看不到**，同一个坑反复踩。
       现在：小文件直接把内容带上；大文件只列清单（附字节数），她想看再 read_file。
       （预算刻意压小：技能正文本身已可达 12000 字符，经验是补充而不是主体。） */
    if (s.extras && s.extras.length) {
      const shown = s.extras.filter((f) => f.text);
      const listed = s.extras.filter((f) => !f.text);
      if (shown.length) {
        out += '\n\n【这个技能文件夹里积累的经验（已带内容）】';
        for (const f of shown) out += '\n--- ' + f.rel + ' ---\n' + f.text;
      }
      if (listed.length) {
        out += '\n\n【这个技能文件夹里还有这些文件（要看内容就 read_file）】\n'
          + listed.map((f) => '- ' + f.rel + '（' + (f.bytes || '?') + ' 字节' + (f.note ? '，' + f.note : '') + '）').join('\n');
        try { out += '\n  绝对路径：' + require('path').join(skills.userDir(), s.id); } catch {}
      }
    }
    // 界面风格这一个技能要跟"记忆"联动：加载时按当前好感度/心情微调冷暖
    if (s.id === style.SKILL_ID) {
      try {
        const hint = style.moodHint(require('./mood').load());
        if (hint) out += '\n\n【当前状态微调（记忆联动）】\n' + hint;
      } catch {}
    }
    return out;
  }

  /* ---------------- 技能目录的自主管理（AI 自己整理经验） ---------------- */
  if (tool === 'skill_ls') {
    const items = skills.ls(arg || '');
    return '📂 技能目录 ' + (arg || '/') + '（' + items.length + ' 项）：\n' + (items.join('\n') || '(空)');
  }
  if (tool === 'skill_read') {
    const r = skills.readFile(arg || '');
    return '📄 ' + arg + (r.truncated ? '（只显示前 6000 字，共 ' + r.size + ' 字）' : '') + '：\n' + r.text;
  }
  if (tool === 'skill_write') {
    const s = String(arg || '');
    const i = s.indexOf('||');
    if (i < 0) throw new Error('格式：skill_write|技能/子路径/文件.md||内容');
    const rel = s.slice(0, i).trim();
    // 允许用 \n 写换行（ACTION 只能是一行）
    const content = s.slice(i + 2).replace(/\\n/g, '\n');
    const r = skills.writeFile(rel, content);
    return '💾 已写入技能文件：' + r.path + '（' + r.bytes + ' 字节）';
  }
  if (tool === 'skill_rm') {
    const r = skills.remove(arg || '');
    return '🗑 已删除：' + r.path;
  }
  /* 项目文件写入。
   * 为什么必须单独开一个工具：以前项目文件**只能**靠回复里的 <<<WRITE: 路径 …>>> 块创建，
   * 而那个语法只写在"首轮系统提示词"里 —— 多步任务续跑用的是精简提示词（buildContinuePrompt），
   * 里面完全没提 WRITE 块。于是续跑阶段她手上**唯一像写入的工具就是 skill_write**：
   * 实测她把算乘法的 `calc/mul.py` 写进了**技能文件夹**，还返回"已写入技能文件"一路成功、
   * 不报任何错 —— 属于"看着正常其实写错地方"。补上 proj_write 后续跑阶段也有正确落盘方式。 */
  if (tool === 'proj_write') {
    const s = String(arg || '');
    const i = s.indexOf('||');
    if (i < 0) throw new Error('格式：proj_write|子路径/文件.py||文件内容');
    const rel = s.slice(0, i).trim();
    const content = s.slice(i + 2).replace(/\\n/g, '\n');   // ACTION 只能一行，允许用 \n 写换行
    /* 沙盒内的写入同样走"读后写 / CAS"（路径先算成绝对路径再登记，才能和 proj_read 对上） */
    let abs = rel;
    try { abs = projects.safePath(rel); } catch {}
    const _st = statOf(abs);
    const _ck = OBS.checkWrite({ path: abs, mode: _st ? 'replaceIfVersion' : 'createIfAbsent', stat: _st });
    if (!_ck.ok) return '🚫 没有写入（' + _ck.code + '）：' + _ck.message;
    const r = projects.writeOne(rel, content);
    OBS.noteObserved(abs, statOf(abs), 'write');
    return '💾 已写入项目文件：' + r.path + '（' + r.bytes + ' 字节）';
  }

  /* ---------------- 人格词条（她自己的"人格词典"，也是将来换立绘的 key） ---------------- */
  if (tool === 'tag_list') {
    return '🏷 当前人格词条表（tier1 核心人格 = 立绘 key）：\n' + personatags.vocabulary();
  }
  if (tool === 'tag_set') {
    const s = String(arg || '');
    const i = s.indexOf('{');
    if (i < 0) throw new Error('格式：tag_set|{"id":"yandere","label":"病娇","tier":1,"moodDir":1,"words":["病娇","偏执"]}');
    let o;
    try { o = JSON.parse(s.slice(i)); } catch { throw new Error('JSON 解析失败（检查引号、逗号、不要换行）'); }
    const r = personatags.setTag(o);
    if (!r.ok) throw new Error(r.error);
    return '🏷 已' + (r.action === 'added' ? '新增' : '更新') + '词条「' + r.tag.label + '」(' + r.tag.id
      + '，tier' + r.tag.tier + '，词：' + r.tag.words.join('/') + ')，词条表共 ' + r.total + ' 条。'
      + (r.tag.tier === 1 ? '（tier1 = 核心人格，会影响立绘与行为方向）' : '');
  }
  if (tool === 'tag_rm') {
    const r = personatags.removeTag(arg);
    if (!r.ok) throw new Error(r.error);
    return '🗑 已删除词条「' + r.removed.label + '」(' + r.removed.id + ')，词表剩 ' + r.total + ' 条。';
  }

  /* ---------------- 项目文件夹（她写的小软件放这儿） ---------------- */
  if (tool === 'proj_ls') {
    const items = projects.ls(arg || '');
    return '📂 项目目录 ' + (arg || '/') + '（' + items.length + ' 项）：\n' + (items.join('\n') || '(空)');
  }
  if (tool === 'proj_read') {
    const r = projects.readFile(arg || '');
    /* 记下观测（和 proj_write 的 CAS 检查配对） */
    try { OBS.noteObserved(projects.safePath(String(arg || '')), statOf(projects.safePath(String(arg || ''))), 'read'); } catch {}
    return '📄 ' + arg + (r.truncated ? '（只显示前 8000 字，共 ' + r.size + ' 字）' : '') + '：\n' + r.text;
  }
  if (tool === 'proj_rm') {
    const r = projects.remove(arg || '');
    return '🗑 已删除：' + r.path;
  }
  if (tool === 'proj_open') {
    const r = await projects.open(arg || '');
    return '🌐 已用默认程序打开：' + r.path;
  }
  if (tool === 'proj_run' || tool === 'run_file') {
    const cfgR = config.load();
    /* run_file = 同一套执行器，但**允许绝对路径**（权限档 full 才挂得上）。
       为什么加：实测主人说"帮我跑一下 C:\deepseek\pet-test\calc.py"，
       而当时只有沙盒内的 proj_run —— 她把绝对路径传进去只收到"路径越界"，
       于是判断"文件不存在"，最后如实告诉主人"文件不在"（其实是错的）。
       现在「跑主人指定的脚本」这件事有了正确出口。 */
    const r = await projects.run(arg || '', (cfgR.memory || {}).projRunTimeout || 60000, tool === 'run_file');
    const head = r.timeout
      ? '⏱ 运行超时被强制结束（' + Math.round(r.ms / 1000) + 's）'
      : (r.code === 0 ? '✅ 运行成功（' + Math.round(r.ms / 1000) + 's，退出码 0）' : '❌ 运行出错（退出码 ' + r.code + '，' + Math.round(r.ms / 1000) + 's）');
    return head + '：' + r.path + '\n--- 输出 ---\n' + r.output;
  }

  /* ---------------- 游戏助手（默认关闭，用户开口才启动） ----------------
     懒加载：gameagent 自己依赖 assistant，放在函数里 require 避免循环依赖。 */
  if (tool === 'game_start' || tool === 'game_stop' || tool === 'game_status') {
    const game = require('./gameagent');
    if (tool === 'game_status') {
      const s = game.status();
      if (!s.running) return '🎮 游戏助手（替你打游戏的那个循环）现在**没有在运行**。\n'
        + '注意：这只表示"我没在帮打"，**不代表游戏本身开没开** —— 游戏开没开要看屏幕（用 screen_look 或 screen_shot）。';
      return '🎮 正在打：第 ' + s.step + ' / ' + s.maxSteps + ' 步，已操作 ' + (s.tally.act || 0) + ' 次'
        + '（成功 ' + (s.tally.ok || 0) + ' / 失败 ' + (s.tally.fail || 0) + '）\n任务：' + s.task;
    }
    if (tool === 'game_stop') {
      const r = game.stop();
      return r.already
        ? '🎮 游戏助手本来就没在运行，不用停（这不代表游戏没开着）。'
        : '🛑 已经让她停手了，正在收尾（一两秒内就完全停下）。';
    }
    const s = String(arg || '');
    const i = s.indexOf('||');
    const task = (i >= 0 ? s.slice(0, i) : s).trim();
    const maxSteps = i >= 0 ? (Number(s.slice(i + 2)) || 0) : 0;
    const r = await game.start({ task, maxSteps: maxSteps || undefined });
    if (!r || !r.ok) throw new Error((r && r.error) || '启动失败');
    return '🎮 已经开打了，她在持续盯屏操作，每一步都会汇报到对话里。\n任务：' + task.slice(0, 120)
      + '\n（**不需要再调 game_start**：现在只要用正常格式跟主人说一声你已经上手了、想停就说「停」。用户说停的时候再调 game_stop。）';
  }

  /* ---------------- OS 级键鼠（坐标 = 抓帧空间，见 input.space()） ---------------- */
  const parseXY = (s) => {
    const m = String(s || '').trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) throw new Error('坐标格式应为 x,y');
    return [Number(m[1]), Number(m[2])];
  };
  if (tool === 'click' || tool === 'rclick' || tool === 'dclick' || tool === 'move') {
    /* 如果她上一眼是【放大图】，她报的是放大图自己的坐标 —— 这里换算回整屏。 */
    /* ⚠️ click 永远是【整屏坐标】，绝不自动换算。
       第一版这里写的是 zoomOut.apply(...) —— 只要 ZoomState 还在就一律换算，
       而她做过一次放大之后，**后面所有整屏坐标的点击都被错误换算了一遍**：
       她自己报过"我瞄 1370,300，实际落在 1628,509"（差 250px）。
       也就是说之前统计的"坐标漂移 20~120px"，相当一部分是我这个隐藏状态造成的，不是模型飘。 */
    const [x, y] = parseXY(arg);
    const label = { click: '左键点击', rclick: '右键点击', dclick: '双击', move: '移动鼠标' }[tool];
    /* ★★ 效果断言：click / move 之后【回读光标真值】★★
       实测事故（2026-10-03）：input.move() 返回 true，而 Win32 GetCursorPos 一查差了 551 像素 ——
       "命令发出去了"不等于"光标到了"。而原来的回执只写"✅ 已移动鼠标"，看起来是成功的 ✗。
       现在：move 若回读不一致就直接判失败并说清楚；click 也把回读值写进回执（供核对）。
       ⚠️ 另外：如果她之前 focus_window 过，键盘/鼠标的目标窗口应当是它 —— 这里顺带回读前台。*/
    let cursorNote = '';
    if (tool === 'move' || tool === 'click') {
      const SDx = require('./safedrive');
      const rx = (tool === 'move') ? await SDx.moveSafe(x, y, {}) : await SDx.clickSafe(x, y, {});
      if (tool === 'move' && rx && rx.ok === false) {
        return '🖱 ❌ 移动鼠标失败：' + (rx.note || rx.reason)
          + '\n（这是"假成功"——命令发出去了但光标没到。**别当成成功继续往下做**，先查目标窗口有没有被别的窗口挡住/最小化。）';
      }
      if (rx && rx.cursorAfter) {
        const cm = SDx.cursorMatches({ x, y }, rx.cursorAfter, 6);
        cursorNote = cm.ok
          ? '  光标已回读确认到位 ✓'
          : '  ⚠️ 光标回读在 (' + rx.cursorAfter.x + ',' + rx.cursorAfter.y + ')，与目标差 ' + cm.dx + '/' + cm.dy + ' 像素';
      }
    } else {
      input[tool](x, y);
    }
    /* 【等界面反应完再返回】实测踩到的坑：她点"基建"之后**立刻** screen_look，
       而游戏切界面要 1~2 秒 —— 她看到的是**旧画面**，于是判断"没点进去"、
       换个坐标再点、再点，连点三次（日志里就是 1320,878 → 1512,810 → 1480,830），
       而其实现第二次就进去了。不该让她靠"记得等一下"来避免：
       点/按键/输入/拖拽这类**会改变界面**的动作，返回前统一等一小会儿，
       这样下一步截图看到的才是动作之后的状态。move 不改界面，不用等。 */
    if (tool !== 'move') {
      const settle = Number((config.load().memory || {}).actionSettleMs) || 1500;
      await new Promise((r) => setTimeout(r, settle));
      return `✅ 已${label}：(${x}, ${y})（已等 ${(settle / 1000).toFixed(1)}s 让界面反应）` + cursorNote;
    }
    return `✅ 已${label}：(${x}, ${y})` + cursorNote;
  }
  if (tool === 'clickz' || tool === 'movez' || tool === 'rclickz' || tool === 'dclickz') {
    if (!ZoomState) return '⚠️ 现在没有有效的放大图（上一次 screen_look 不是放大看）。请先用 screen_look|<问题>||x,y,w,h 放大看一次，或改用普通的 click（整屏坐标）。';
    const [zx, zy] = parseXY(arg);
    const [x, y] = [Math.round(ZoomState.x + zx / ZoomState.k), Math.round(ZoomState.y + zy / ZoomState.k)];
    const real = tool.replace(/z$/, '');
    input[real](x, y);
    const settle = Number((config.load().memory || {}).actionSettleMs) || 1500;
    await new Promise((r) => setTimeout(r, settle));
    return '✅ 已点击（放大图坐标换算）：放大图(' + zx + ',' + zy + ') → 整屏(' + x + ',' + y + ')（已等 ' + (settle / 1000).toFixed(1) + 's）';
  }
  if (tool === 'drag') {
    /* 两种写法都收：
     *   drag|x1,y1|x2,y2   （提示词里的标准写法）
     *   drag|x1,y1,x2,y2   （模型很自然会写成四段逗号 —— 实测她就这么发过
     *                        "960,540,960,200"，被拒后白费一步）
     * 不能直接用 parseXY 切，那个函数要求整串恰好是一对坐标。 */
    const s = String(arg || '');
    let a, b;
    if (s.includes('|')) {
      const parts = s.split('|');
      a = parseXY(parts[0]); b = parseXY(parts[1]);
    } else {
      const all = s.split(/[,，]/).map((x) => Number(String(x).trim()));
      if (all.length !== 4 || all.some((n) => !Number.isFinite(n))) {
        throw new Error('拖拽格式应为 drag|x1,y1|x2,y2（也接受 x1,y1,x2,y2 四段写法），收到的是：' + s.slice(0, 40));
      }
      a = [all[0], all[1]]; b = [all[2], all[3]];
    }
    const [x1, y1] = a, [x2, y2] = b;   // drag 同样是整屏坐标（不换算，理由见上面 click 那段）
    input.drag(x1, y1, x2, y2);
    return `✅ 已拖拽：(${x1},${y1}) → (${x2},${y2})`;
  }
  if (tool === 'scroll') {
    const parts = String(arg).split('|').map((s) => s.trim());
    const [x, y] = parseXY(parts[0]);   // scroll 也是整屏坐标
    /* 支持三种写法，意思一样：
     *   scroll|x,y|down          向下滚一屏（默认 5 格 = 600）
     *   scroll|x,y|down|10       向下滚 10 格
     *   scroll|x,y|-600          直接给滚轮量（**正数 = 向上**，Windows 原生约定）
     *
     * 为什么要加 up/down 这种写法：原来只收裸数字，而"正数向上"和很多人的直觉
     * （网页里 scrollTop 正数是往下）**相反** —— 实测模型会搞反，用户就报了
     * "滚动工具反了，不能自由滚动"。用词表达方向就没有歧义了。
     * 另外原来默认只有 120（一格），一次滚一丁点，多步任务里光滚屏就把步数耗光，
     * 这也是"不能自由滚动"的来源。现在默认向下滚一屏，还可以一次给格数。 */
    const dirWord = String(parts[1] || '').toLowerCase();
    let delta;
    if (['up', 'down', '上', '下'].includes(dirWord)) {
      const n = Math.max(1, Math.min(20, Number(parts[2]) || 5));
      delta = (dirWord === 'up' || dirWord === '上' ? 1 : -1) * n * 120;
    } else {
      delta = Number(parts[1]) || 0;
      if (!delta) delta = -600;                     // 什么都不给 → 向下滚一屏
    }
    delta = Math.max(-6000, Math.min(6000, delta));  // 封顶，别一滚到底
    input.scroll(x, y, delta);
    const up = delta > 0;
    return `✅ 已滚动：(${x},${y}) 向${up ? '上' : '下'} ${Math.abs(delta) / 120} 格\n`
      + '（滚轮只会作用于**光标下/当前有焦点**的那个窗口。要是没反应：先确认目标窗口没被别的窗口'
      + '——**包括我自己的桌宠窗**——挡住，或者先点一下目标窗口的空白处让它获得焦点，然后再滚。）';
  }
  if (tool === 'focus_window') {
    /* 把目标窗口真正置到前台（并且回读校验）。
       ⚠️ 旧注释写的是"用 SetWindowPos(HWND_TOPMOST) 抬到最上面就够（截图和点击都按最上面的算）"
       —— **这是错的**，2026-10-02 实测：
         · HWND_TOPMOST 只让窗口**看得到**，`GetForegroundWindow()` 一个字都不变 ✗
         · 而 Windows 把**键盘输入发给前台窗口**，不是"最上层窗口" ✗
         → 于是 key / type 全部打到了别的窗口上，而工具还返回 true。
       现在 focuswin v2 做的是：分层尝试（直接设 → 空按 Alt 解锁 → AttachThreadInput → 最小化再恢复）
       + **回读 GetForegroundWindow 确认**，不成功就返回 FAIL（绝不假成功）。
       ★ 它还会记下这次的目标窗口，供 key/type/click 做"前台断言"★（见下面的 lastFocus）。 */
    const r = await require('./focuswin').focusWindow(arg);
    /* ★ step-showonly：窗口显示出来了但没抢到前台（UWP 常见）★
       ⚠️ 这时**不能**设 lastFocus ✗ —— 设了会让后续 key/type 去断言前台而失败 ✓，
       但正确做法本来就不是用键盘（键盘只发前台 ✗），而是用 click 点它 ✓。
       所以：不设 lastFocus，并把"改用点击"讲清楚，别让她卡在"窗口没弄出来"的错觉里。 */
    if (/step-showonly/.test(r)) {
      return '🪟 ' + r.replace(/^OK step-showonly\s*/, '');
    }
    if (r.startsWith('OK')) {
      lastFocus = String(arg || '').trim();            // 记下来：后续键鼠动作要断言前台还是它
      return '🪟 已把窗口置到前台并通过回读校验：' + r.slice(3)
        + '\n（键盘输入现在会发给它。若屏幕上仍被别的窗口视觉遮挡，说明那是置顶窗口 —— 但输入已经能到达目标了。）';
    }
    if (r.startsWith('NOTFOUND')) return '🪟 没找到标题含「' + arg + '」的窗口。当前可见窗口：\n' + r.slice(8);
    /* FAIL：明确告诉她是哪一步没成、现在的前台是谁 —— 不许含糊过去 */
    return '🪟 ❌ 没能把「' + arg + '」置到前台（' + r + '）\n'
      + '这说明接下来的 key / type / click 会作用在**别的窗口**上 —— 所以先别继续操作，'
      + '要么换一个标题片段重试，要么先让主人把它点到前面。';
  }
  if (tool === 'watch_screen') {
    /* 【连续看屏幕】给"主人演示一遍、她跟着学"这种场景用。
       为什么单独做一个工具：screen_look 是**单张快照**，而"看人操作一遍"需要连续观察；
       如果让她自己连着调 screen_look，既会撞上"连续只看不动"的闸门，
       又会把每一帧都当独立思考（很贵，而且她记不住顺序）。
       这里一次调用完成：每隔 interval 毫秒抓一帧（**画上光标**，才看得出鼠标在点什么），
       逐帧问视觉模型"这一帧发生了什么/鼠标在哪/界面变了什么"，最后拼成一条时间线。
       帧同时存到 shots/（文件名带序号），事后能回看。
       用法：watch_screen|<秒数>[|<间隔毫秒>]   例如 watch_screen|30|2500 */
    const spW = String(arg || '').split('|').map((s) => s.trim());
    const secs = Math.max(3, Math.min(120, Number(spW[0]) || 20));
    const ivMs = Math.max(800, Math.min(8000, Number(spW[1]) || 2500));
    const cfgW = config.load();
    if (!cfgW.visionEnabled) return '⚠️ 视觉没开，看不了屏幕。';
    const total = Math.max(1, Math.min(40, Math.floor((secs * 1000) / ivMs) + 1));
    const timeline = [];
    const stamp = Date.now();
    /* ⚠️ **先连续抓帧、再逐帧分析** —— 我第一版是"抓一帧→问一次视觉"，实测每帧视觉调用约 2 秒，
       于是"看 45 秒"实际要花 90 秒，**根本跟不上主人的演示节奏**（演示早做完了，她还在分析第 3 帧）。
       抓帧本身只要几十毫秒，所以先把整段按节奏拍下来（帧图落盘、带真实时间顺序），拍完再慢慢分析。 */
    const frames = [];
    for (let k = 0; k < total; k++) {
      const capW = await captureScreen(false, false);   // 不画网格、但**画光标**（要看鼠标点了哪）
      frames.push(capW.dataUrl);
      try {
        fs.writeFileSync(path.join(shotsDir(), 'watch-' + stamp + '-' + String(k).padStart(2, '0') + '.jpg'),
          Buffer.from(capW.dataUrl.split(',')[1], 'base64'));
      } catch {}
      if (k < total - 1) await new Promise((r) => setTimeout(r, ivMs));
    }
    for (let k = 0; k < frames.length; k++) {
      const qW = '这是同一块屏幕上连续操作中的第 ' + (k + 1) + '/' + frames.length + ' 帧，'
        + '相邻两帧大约相隔 ' + (Math.round(ivMs / 100) / 10) + ' 秒。'
        + '请用**一句话**说清三件事：① 鼠标指针此刻在画面什么位置；'
        + '② 这一帧里刚发生或正在发生什么操作（点击、输入、拖动、切界面…）；'
        + '③ 界面因此变了什么（弹窗、高亮、列表变化…）。只描述你看到的，不要推测意图。';
      let one = '';
      try { one = await vision.describe(cfgW, frames[k], qW, 'low'); }
      catch (e) { one = '（这一帧视觉失败：' + ((e && e.message) || e) + '）'; }
      timeline.push('【第 ' + (k + 1) + ' 帧 · ' + (Math.round((k * ivMs) / 100) / 10) + 's】' + String(one).replace(/\s+/g, ' ').trim());
    }
    /* 【回执必须压缩】实测 40 帧 × 每帧约 200 字 ≈ 8000 字，回执被上层截断 ——
       她只看到前两帧，整个"看主人演示"就白做了。所以：
       ① 完整时间线写进文件（她想细看可以 read_file）；
       ② 回执只给"**画面真的变了**的那些帧"（连续相同的描述合并计数），并硬性截到 3000 字以内。 */
    const full = timeline.join('\n');
    const tpath = path.join(shotsDir(), 'watch-' + stamp + '-timeline.txt');
    try { fs.writeFileSync(tpath, full, 'utf8'); } catch {}
    const compact = [];
    let lastDesc = '', dup = 0;
    for (const line of timeline) {
      const desc = line.replace(/^【[^】]*】/, '');
      if (desc === lastDesc) { dup++; continue; }
      if (dup) compact[compact.length - 1] += '（之后 ' + dup + ' 帧画面基本没变）';
      dup = 0; lastDesc = desc;
      compact.push(line);
    }
    if (dup) compact[compact.length - 1] += '（之后 ' + dup + ' 帧画面基本没变）';
    let body = compact.join('\n');
    if (body.length > 3000) body = body.slice(0, 3000) + '\n…（完整时间线见文件，内容太长这里截断了）';
    /* ⚠️ 文件路径必须放在**最前面**：上次实测回执太长、被上层截到 1000 字左右，
       结果连"完整时间线在哪个文件"这行都丢了，她只看到前 3 帧、以为录制失败了。
       把路径、帧数、文件位置全放开头，截断也截不到关键信息。 */
    return '👀 连续看了 ' + frames.length + ' 帧（约 ' + secs + ' 秒，间隔 ' + ivMs + 'ms）。\n'
      + '【完整时间线（每帧都有）】' + tpath + '  ← 想知道完整过程就用 read_file 读这个文件\n'
      + '【帧图】shots/watch-' + stamp + '-NN.jpg（共 ' + frames.length + ' 张）\n'
      + '下面是**画面真正发生变化**的那些帧（连续没变的已合并）：\n' + body;
  }
  if (tool === 'find_template_scroll') {
    /* 【滚动列表里找模板】模板匹配的三个天生短板之一：目标在列表里、当前屏看不到。
       做法（学 MaaAssistantArknights 的 Scroll + next 循环重扫）：
         把光标移到列表区域中心（滚轮只作用于光标下的窗口，不移动光标滚轮就打到别处）→
         抓帧找模板 → 没找到就滚一屏 → 再找 … → 找到为止或次数用尽。
       ⚠️ **找不到时必须滚回原位**：不能把界面留在被改动过的状态（否则她下一步看到的是一个
          和之前不一样的列表，会基于错误画面做判断）。
       用法：find_template_scroll|<模板名>|<列表区域 x,y,w,h>[|down|up][|最大次数] */
    const spS = String(arg || '').split('|').map((s) => s.trim());
    const nmS = spS[0] || '';
    const roiS = (spS[1] || '').split(/[,，]/).map((v) => Number(v.trim()));
    if (!nmS || roiS.length !== 4 || !roiS.every((v) => Number.isFinite(v))) {
      return '⚠️ 用法：find_template_scroll|<模板名>|<列表区域 x,y,w,h>[|down|up][|最大次数]';
    }
    const dirS = (spS[2] || 'down').toLowerCase().startsWith('u') ? 'up' : 'down';
    const timesS = Math.max(1, Math.min(12, Number(spS[3]) || 5));
    const [rxS, ryS, rwS, rhS] = roiS;
    const cxS = Math.round(rxS + rwS / 2), cyS = Math.round(ryS + rhS / 2);
    const { nativeImage } = require('electron');
    const MS = require('./matcher');
    input.move(cxS, cyS);                       // 光标必须先落在列表上（滚轮作用于光标下的窗口）
    await new Promise((r) => setTimeout(r, 220));
    let scrolledS = 0;
    let lastS = null;
    for (let k = 0; k <= timesS; k++) {
      const capS = await captureScreen(false, true);
      lastS = await MS.findTemplate(app, nativeImage, nmS, capS.dataUrl, [rxS, ryS, rwS, rhS]);
      if (lastS.ok) {
        return '🎯 找到「' + nmS + '」：中心 (' + lastS.x + ',' + lastS.y + ')，相似度 ' + lastS.score.toFixed(3)
          + '（滚了 ' + scrolledS + ' 屏' + (lastS.ms != null ? '，本次匹配 ' + lastS.ms + 'ms' : '') + '）。'
          + '现在可以直接 ACTION: click|' + lastS.x + ',' + lastS.y + '。';
      }
      if (!lastS.low && !lastS.ok) return '⚠️ ' + (lastS.error || '匹配失败');
      if (k === timesS) break;
      await userinput.waitUntilFree(30000);      // 主人一动就等，和别的键鼠操作一致
      input.scroll(cxS, cyS, dirS === 'up' ? 'up' : 'down');
      scrolledS++;
      await new Promise((r) => setTimeout(r, 420));   // 等滚动动画结束
    }
    /* 没找到 → 滚回原位，别把界面留在改动过的状态 */
    for (let k = 0; k < scrolledS; k++) {
      input.scroll(cxS, cyS, dirS === 'up' ? 'down' : 'up');
      await new Promise((r) => setTimeout(r, 260));
    }
    return '⚠️ 在这个列表里滚了 ' + scrolledS + ' 屏也没找到「' + nmS + '」'
      + '（最佳相似度只有 ' + (lastS && lastS.score != null ? lastS.score.toFixed(2) : '?') + '，低于阈值 0.70）。'
      + '**我已经把列表滚回原来的位置了**，界面和你交给我时一样。'
      + '可能原因：模板截自别的皮肤/缩放比例，或者这个列表里确实没有它 —— 先用 screen_look 或 find_text 确认。';
  }
  if (tool === 'find_text') {
    /* 【文字的模板匹配】OCR 当前画面，找出那段文字在哪，返回中心坐标。
       用途：游戏里大量目标只有文字没有图标 —— 干员名、设施名、列表项、按钮上的字。
       （模板匹配 find_template 认图不认字，正好互补。）
       用法：find_text|要找的文字       或   find_text|要找的文字| x,y,w,h（只在这块区域里找）
       找不到时会把**整屏 OCR 到的文字**列给她 —— 这样她能看到屏幕上真实写了什么，
       而不是继续瞎猜（今天反复出现"她以为界面上有某个词、其实没有"）。 */
    const sp0 = String(arg || '').split('|').map((s) => s.trim());
    const needle = sp0[0] || '';
    if (!needle) return '⚠️ 用法：find_text|要找的文字';
    const cap4 = await captureScreenFallback();     // OCR 用无损 PNG（比 JPEG 帧更利于小字识别）
    const j = await ocrJson(cap4.path);
    if (!j) return '⚠️ OCR 没有返回结果（可能没有中文识别包，或这一步超时了）。可以改用 find_template 找图标，或 screen_look 自己看。';
    let hit = findTextInOcr(j, needle);
    /* 可选：限定区域（先整体命中再用区域过滤，避免"区域外有同名文字"干扰） */
    if (hit && sp0[1]) {
      const n = sp0[1].split(/[,，]/).map((v) => Number(v.trim()));
      if (n.length === 4 && n.every((v) => Number.isFinite(v))) {
        const inRoi = hit.x >= n[0] && hit.x <= n[0] + n[2] && hit.y >= n[1] && hit.y <= n[1] + n[3];
        if (!inRoi) hit = null;
      }
    }
    if (hit) {
      return '🔤 找到「' + needle + '」：中心 (' + hit.x + ',' + hit.y + ')，它所在的那一行是「' + hit.line
        + '」。现在可以直接 ACTION: click|' + hit.x + ',' + hit.y + '。';
    }
    const onScreen = ((j.lines || []).map((l) => String(l.text || '').replace(/\s+/g, '')).filter(Boolean)).slice(0, 12);
    return '⚠️ 当前画面上没找到「' + needle + '」。OCR 实际读到的文字是：\n'
      + (onScreen.length ? onScreen.map((t) => '- ' + t).join('\n') : '（这一屏没识别到任何文字）')
      + '\n请照这个真实结果判断：也许这一屏确实没有这个词，或者需要先切到另一屏 / 往下滚。';
  }
  if (tool === 'make_template') {
    /* 从**当前画面**裁一块存成模板（存 PNG 给人看 + 原始 BGRA 给 match.exe 用）。
       用法：make_template|按钮名| x,y,w,h
       为什么要这个工具：模板匹配的前提是"有模板"。与其由我在开发期预先截一堆游戏按钮，
       不如让她在**真正看到那个按钮的那一刻**自己裁下来 —— 下次再遇到同一个按钮就能精确定位。
       抓帧用 noCursor（不画准星）：光标压在按钮上会污染模板。 */
    const mm = String(arg || '').match(/^\s*([^|]+?)\s*\|\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/);
    if (!mm) return '⚠️ 用法：make_template|模板名| x,y,w,h（x,y,w,h 是屏幕上那块区域的坐标，用 screen_look 看准了再裁）';
    const { nativeImage } = require('electron');
    const cap2 = await captureScreen(false, true);
    const got = require('./matcher').saveTemplate(app, nativeImage, mm[1],
      cap2.dataUrl, { x: Number(mm[2]), y: Number(mm[3]), w: Number(mm[4]), h: Number(mm[5]) });
    if (!got.ok) return '⚠️ 存模板失败：' + got.error;
    const all = require('./matcher').listTemplates(app);
    return '✅ 已存模板「' + got.name + '」（' + got.w + 'x' + got.h + '），现在一共 ' + all.length + ' 个模板。'
      + '以后用 find_template|' + got.name + ' 就能在当前画面里精确定位它（返回坐标可直接 click）。';
  }
  if (tool === 'find_template') {
    /* 在**当前画面**里精确找模板，返回匹配框中心（截图空间坐标，可直接给 click）。
       这是这套改造的核心：把"她估计坐标"换成"确定性找图"。
       用法：find_template|模板名        或   find_template|模板名| x,y,w,h（限定搜索区域，快很多） */
    const sp = String(arg || '').split('|').map((s) => s.trim());
    const nm = sp[0] || '';
    let roi = null;
    if (sp[1]) {
      const n = sp[1].split(/[,，]/).map((v) => Number(v.trim()));
      if (n.length === 4 && n.every((v) => Number.isFinite(v))) roi = n;
    }
    const { nativeImage } = require('electron');
    const cap3 = await captureScreen(false, true);
    /* 级联多尺度：先按 1.0 找（快路径），分数低才依次试 0.9/1.1/0.8/1.25 ——
       治"用户改了系统缩放 / 模板截自别的尺寸"这个天生短板。 */
    const r3 = await require('./matcher').findTemplateScaled(app, nativeImage, nm, cap3.dataUrl, roi);
    if (!r3.ok && !r3.low) return '⚠️ ' + (r3.error || '匹配失败，原因未知');
    if (r3.low) {
      return '⚠️ 没找到「' + nm + '」（最佳分数只有 ' + r3.score.toFixed(2) + '，低于阈值 0.70）。'
        + '可能这一屏根本没这个按钮，或者你的模板是别的分辨率/皮肤下截的。'
        + '建议先用 screen_look 看一眼当前在哪一屏，确认那个按钮在不在。';
    }
    return '🎯 找到「' + nm + '」：中心 (' + r3.x + ',' + r3.y + ')，匹配框 ' + r3.w + 'x' + r3.h
      + '，相似度 ' + r3.score.toFixed(3) + '（' + r3.ms + 'ms）。'
      + '现在可以直接 ACTION: click|' + r3.x + ',' + r3.y + '（坐标就是截图空间，和 screen_look 一致）。';
  }

  /* ---------------- 帧比对：客观回答"界面到底变没变" ----------------
     用户点出的问题：她滚动了好几次、界面明明变了，她却说"没变" —— 因为她用的是**视觉模型的总结**，
     而视觉模型会说谎（今天它谎报过"两个槽位都已进驻"，也报过"滚了没变化"）。
     像素比对是确定性的、几毫秒、免费、不会说谎，还能告诉你变在哪一块。
     用法：screen_diff|<秒数>      例如 screen_diff|1   或  screen_diff|2
     典型用法：做完一个动作 → screen_diff|1 → 变了就是生效了、没变就换做法（别再用同一个动作重复）。 */
  if (tool === 'screen_diff') {
    const secs = Math.max(0.2, Math.min(10, Number(String(arg || '').trim()) || 1));
    const a = await captureScreen(false, true);
    await new Promise((r) => setTimeout(r, Math.round(secs * 1000)));
    const b = await captureScreen(false, true);
    const { nativeImage } = require('electron');
    const FD = require('./framediff');
    let res;
    try {
      /* 缩到 480 宽再比：够灵敏（一行的开关变化都能看出来），又足够快 */
      const scaleTo = 480;
      const ia = nativeImage.createFromDataURL(a.dataUrl).resize({ width: scaleTo });
      const ib = nativeImage.createFromDataURL(b.dataUrl).resize({ width: scaleTo });
      const sa = ia.getSize(), sb = ib.getSize();
      const w = Math.min(sa.width, sb.width), h = Math.min(sa.height, sb.height);
      res = FD.diffBgra(ia.toBitmap(), ib.toBitmap(), w, h);
      if (res.ok) res.k = (a.width || 1920) / w;      // 缩小倍率，用于把区域还原成整屏坐标
    } catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
    /* 是否要连带把"变后的那一帧"发给她看？这里不发 —— 她要看可以用 screen_look，
       这个工具的职责就是给一个**客观的是/否**，避免她被自己的感觉带偏。 */
    return FD.summarize(res, secs, res.k);
  }

  /* ---------------- 确定性流程（录制回放里的"回放"那一半，见 src/flow.js / src/flows.js） ----------------
     调研结论：对"每天做同样一套点击"这种重复任务，业界公认的最佳架构是
     **确定性回放为主 + LLM 只做异常兜底**（Power Automate Desktop 自愈 / workflow-use / Skyvern 三家一致）。
     流程存在 <userData>/flows/<名字>.json，你可以直接看/改/分享。
     用法：flow_list ／ flow_save|<名字>||<JSON> ／ flow_run|<名字> ／ flow_run|<名字>|dry ／ flow_del|<名字>
     dry = **干跑**：只解析每一步的目标、不动键鼠 —— 先确认每一步都找得到，再真的跑。 */
  if (tool === 'flow_list' || tool === 'flow_run' || tool === 'flow_save' || tool === 'flow_del') {
    const FL = require('./flows');
    const baseDir = app.getPath('userData');
    if (tool === 'flow_list') {
      const all = FL.list(baseDir);
      if (!all.length) {
        return '📜 还没有任何流程。用 flow_save|<名字>||{"title":"...","steps":[...]} 存一个；'
          + '步骤格式：{action,target:{template|text|xy},wait,assert,onFail,note}（详见 src/flow.js 顶部注释）。';
      }
      return '📜 已有 ' + all.length + ' 个流程：\n' + all.map((f) => '- ' + f.name + '（' + f.steps + ' 步'
        + (f.title ? '，' + f.title : '') + '）').join('\n');
    }
    if (tool === 'flow_del') {
      const okDel = FL.del(baseDir, String(arg || '').trim());
      return okDel ? '🗑 已删除流程「' + String(arg).trim() + '」' : '⚠️ 没有这个流程';
    }
    if (tool === 'flow_save') {
      const raw = String(arg || '');
      const i = raw.indexOf('||');
      if (i < 0) throw new Error('格式：flow_save|<名字>||{"title":"...","steps":[...]}');
      const nm = raw.slice(0, i).trim();
      let obj;
      try { obj = JSON.parse(raw.slice(i + 2)); } catch (e) { throw new Error('流程 JSON 解析失败：' + e.message); }
      const w = FL.save(baseDir, nm, obj);
      if (!w.ok) throw new Error(w.error);
      return '💾 已保存流程「' + nm + '」（' + w.steps + ' 步）→ ' + w.path;
    }
    /* flow_run|<名字>  或  flow_run|<名字>|dry */
    const sp = String(arg || '').split('|').map((s) => s.trim());
    const nm = sp[0] || '';
    const dry = /^(dry|干跑|试跑)$/i.test(sp[1] || '');
    if (!nm) throw new Error('格式：flow_run|<流程名>  或  flow_run|<名字>|dry');
    const { nativeImage } = require('electron');
    const deps = {
      dry,
      capture: () => captureScreen(false, true),
      findTemplate: (name, dataUrl, roi) => require('./matcher').findTemplateScaled(app, nativeImage, name, dataUrl, roi),
      /* 文字定位复用 find_text 那条路（它会自己抓一张无损 PNG 给 OCR —— 所以这里忽略传进来的帧） */
      findText: async (text) => {
        const capF = await captureScreenFallback();
        const j = await ocrJson(capF.path);
        if (!j) return { ok: false };
        const hit = findTextInOcr(j, text);
        return hit ? { ok: true, x: hit.x, y: hit.y } : { ok: false };
      },
      input: require('./input'),
      log: (m) => { try { dbg('[flow] ' + m); } catch {} },
    };
    const rep = await FL.run(baseDir, nm, deps);
    return FL.summarize(rep) + (dry ? '\n（这是**干跑**：只验证每一步能不能找到目标，没有动键鼠。确认没问题再去掉 dry 真跑。）' : '');
  }

  if (tool === 'template_list' || tool === 'template_del') {
    const M2 = require('./matcher');
    if (tool === 'template_list') {
      const all = M2.listTemplates(app);
      if (!all.length) return '📦 还没有任何模板。用 make_template|名字| x,y,w,h 从当前画面裁一个。';
      return '📦 已有 ' + all.length + ' 个模板：\n' + all.map((t) => '- ' + t.name + '（' + t.w + 'x' + t.h + '）').join('\n');
    }
    const n2 = M2.delTemplate(app, String(arg || '').trim());
    return n2 ? '🗑 已删除模板「' + String(arg).trim() + '」' : '⚠️ 没有这个模板';
  }
  if (tool === 'kill_app') {
    /* 【清僵尸实例】—— 用户报"计算器托不出来、我也打不开、有两个计算器在跑"之后加的。
       UWP 应用（计算器/设置/照片…）被反复开关会攒出**多个同名进程实例** ✗，
       它们共享同一个 ApplicationFrameHost，老实例会变成"僵尸"：
         visible=否 / cloaked=是 / 停在 -32000,-32000，点它没反应、focus 也抢不到前台 ✗
       → 表现就是"窗口托不出来"，而且用户自己在界面上也点不开 ✗。
       实测（2026-10-03）：杀掉多出来的旧实例后，剩下的那个 focusWindow 立刻
         "OK step4-minimize show5 [前台已回读确认]" ✓，问题消失。
       ⚠️ 安全约束：**只杀同名进程里【较老的那些】，保留最新一个** ✓，
          并且**拒绝**一批系统关键进程（见 DENY）—— 免得她把资源管理器之类干掉。
       用法：kill_app|CalculatorApp        （进程名，可以不带 .exe） */
    const want = String(arg || '').trim().replace(/\.exe$/i, '');
    if (!want) return '用法：kill_app|<进程名>   例如 kill_app|CalculatorApp';
    const DENY = ['explorer', 'winlogon', 'csrss', 'wininit', 'services', 'lsass', 'dwm',
      'sihost', 'taskhostw', 'ApplicationFrameHost', 'electron', 'node', 'powershell', 'pwsh',
      'cmd', 'conhost', 'System', 'Registry', 'Memory Compression'];
    if (DENY.some((d) => d.toLowerCase() === want.toLowerCase())) {
      return '⛔ 拒绝：' + want + ' 是系统关键进程（或我自己），不能由你结束。'
        + '\n（如果是 UWP 应用的僵尸实例，请杀它的应用进程名，例如 CalculatorApp / SystemSettings / Photos —— '
        + '★不要杀 ApplicationFrameHost ★，它同时服务别的 UWP 应用。）';
    }
    const cp = require('child_process');
    let rows = [];
    try {
      const out = cp.execSync('tasklist /FI "IMAGENAME eq ' + want + '.exe" /FO CSV /NH',
        { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      rows = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('"'))
        .map((l) => { const c = l.split('","').map((x) => x.replace(/"/g, '')); return { name: c[0], pid: Number(c[1]) }; })
        .filter((x) => Number.isFinite(x.pid));
    } catch (e) { return '🔪 查进程失败：' + ((e && e.message) || e); }
    if (!rows.length) return '🔪 没找到名为「' + want + '」的进程（它可能已经不在跑了）。';
    /* ★ 只保留最新（pid 最大 ≈ 最后启动），杀掉其余 —— UWP 僵尸总是较老的那些 ★ */
    rows.sort((a, b) => a.pid - b.pid);
    const keep = rows[rows.length - 1];
    const kill = rows.slice(0, -1);
    if (!kill.length) {
      return '🔪 「' + want + '」只跑了 1 个实例（pid ' + keep.pid + '），没有僵尸实例要清。'
        + '\n如果它还是托不出来，试试：focus_window|' + want + ' 或 focus_window|<窗口标题>';
    }
    const killed = [];
    for (const r of kill) {
      try { cp.execSync('taskkill /PID ' + r.pid + ' /F', { stdio: 'ignore', windowsHide: true, timeout: 8000 }); killed.push(r.pid); } catch (e) {}
    }
    return '🔪 已清掉「' + want + '」的 ' + killed.length + ' 个多余实例（pid ' + killed.join(', ') + '），'
      + '保留最新的 pid ' + keep.pid + ' ✓'
      + '\n（UWP 僵尸就是这么来的：反复开关应用会攒出多个实例，它们共享 ApplicationFrameHost，'
      + '老的会变成 visible=否 的僵尸 —— 窗口"托不出来"多半就是这个原因。）'
      + '\n接下来再 focus_window|' + want + '（或它的窗口标题）试一次，应该就能出来了。';
  }
  if (tool === 'uia_find') {
    /* 【UIA 通道】按"元素名字 / AutomationId"找控件 —— 对非游戏应用几乎零误差。
       参数：uia_find|<窗口标题片段>|<元素名字或 AutomationId>
       为什么值得单独一个工具：它拿的是**应用自己报告的**元素身份和矩形，
       没有"识别"这一步，天然抗 DPI / 主题 / 缩放。
       实测（2026-10-02）：计算器 num3Button (1652,662)、equalButton (1750,724)，
       与截图空间逐字一致；而 OCR 给的是 (1647,655)，差 5~8px。
       ⚠️ 对游戏基本无效（控件树是空的）—— 那时改用模板/OCR/Set-of-Marks。 */
    const seg = String(arg || '').split('|').map((x) => x.trim());
    if (seg.length < 2 || !seg[0] || !seg[1]) return '用法：uia_find|<窗口标题片段>|<元素名字或 AutomationId>';
    const r = await require('./uia').locate(seg[0], seg[1]);
    if (!r.ok) {
      if (r.reason === 'window-not-found') return '🔍 UIA：没找到标题含「' + seg[0] + '」的窗口。';
      if (r.reason === 'element-not-found') {
        return '🔍 UIA：窗口里没有名字/Id 含「' + seg[1] + '」的元素（共读到 ' + (r.count || 0) + ' 个）。'
          + '可以先用 ACTION: uia_dump|' + seg[0] + ' 看有哪些元素。';
      }
      return '🔍 UIA 失败：' + (r.reason || '未知') + (r.raw ? '\n' + String(r.raw).slice(0, 200) : '');
    }
    return '🔍 UIA 精确命中：' + (r.extra && r.extra.name ? '「' + r.extra.name + '」' : '')
      + '  AutomationId=' + ((r.extra && r.extra.automationId) || '-')
      + '  中心 (' + r.x + ',' + r.y + ')  置信度 ' + r.confidence
      + '\n（这是应用【自己报告】的坐标，不是识别出来的 —— 可直接 ACTION: click|' + r.x + ',' + r.y + '）';
  }
  if (tool === 'uia_dump') {
    /* 列出某窗口的控件树（探索用） */
    const r = await require('./uia').listElements(String(arg || '').trim());
    if (!r.window) {
      return '🔍 UIA：' + (r.notFound ? '没找到该窗口' : (r.error || '查询失败'))
        + (r.raw ? '\n' + String(r.raw).slice(0, 200) : '');
    }
    const lines = r.elements.slice(0, 40).map((e) => '  [' + e.controlType + '] ' + (e.automationId || '-')
      + '  "' + e.name + '"  ' + e.cx + ',' + e.cy);
    return '🔍 UIA 控件树：' + r.window.title + '  ' + r.window.x + ',' + r.window.y + ' ' + r.window.w + 'x' + r.window.h
      + '\n共 ' + r.count + ' 个元素，列前 ' + Math.min(40, r.elements.length) + ' 个：\n' + lines.join('\n')
      + '\n（用 uia_find|' + String(arg || '').trim() + '|<名字或Id> 精确定位其中一个）';
  }
  if (tool === 'windows_list') {
    /* 列出可见窗口（标题 + 位置尺寸，**物理像素**，和截图空间一致）。
       抄自参考项目 Coopanion 的 cua_windows：给模型一条"结构化通道"，
       这样"哪个窗口在哪、该切哪个"就不必靠模型猜坐标。

       ⚠️⚠️ 坐标换算的责任在【底层】而不是这里 —— 这里**绝对不能再乘任何系数**。
       历史：旧版 `focuswin.listWindows` 的注释写着"返回前必须乘回 scaleFactor"，
       但代码里根本没乘（返回的是 PowerShell 子进程被虚拟化的坐标，物理÷1.25），
       于是这里用 capK = 截图宽/逻辑宽 补乘了一次 —— 工具因此是对的，但底层是错的。
       2026-10-02 我把底层改成**声明 DPI 感知**（DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2），
       它现在直接返回物理像素（实测：浏览器 16,124 1074x665，与 UIA 真值逐字一致）。
       所以这里那次补乘必须删掉 —— 否则又会偏大 25%（同一个 bug 换个方向再犯一次）。
       验收判据：本工具输出的窗口坐标，必须和 UI Automation 报的 BoundingRectangle 一致。 */
    const list = await require('./focuswin').listWindows();
    /* ★ 列窗口失败必须说清楚，不能含糊成"没读到任何窗口" ★
       实测（2026-10-03）：PS 侧 C# 编译失败时 listWindows 曾静默返回 0 个窗口 ✗，
       旧的这句提示会让人以为是"被权限挡了"，方向完全错。
       现在 listWindows 带回 ok/error，这里直接把真实原因转出去。 */
    if (list && list.ok === false) {
      return '🪟 ❌ 列窗口失败（不是"没有窗口"，是查询本身出错了）：' + (list.error || '未知原因')
        + (list.rawOut ? '\n原始输出：' + String(list.rawOut).slice(0, 200) : '');
    }
    const allRows = (list && list.windows) || [];
    if (!allRows.length) return '🪟 没读到任何可见窗口（可能被权限挡了）。';
    /* ★★ 必须把"幽灵窗"滤掉或标注出来（2026-10-03）★★
       实测事故：她自己说"计算器一直被一个全屏的「任务切换」浮层盖住" ——
       而那个「任务切换」是 **cloaked=是 / visible=否 的隐藏帮手窗**（Task View 的宿主窗），
       **根本不在屏幕上** ✗。她这么判断，源头就是这里：
       旧的 windows_list 把所有窗口一视同仁地列出来，幽灵窗看起来就像个正常浮层。
       → 现在：幽灵窗单独分组、明确标注"看不到、不算遮挡"，真窗口排前面。 */
    const isGhost = (w) => (w.cloaked === true) || (w.visible === false);
    const rows = allRows.filter((w) => !isGhost(w));
    const ghosts = allRows.filter(isGhost);
    const fg = await require('./focuswin').foreground();
    const lines = rows.slice(0, 30).map((r) => '- 「' + r.title + '」 左上('
      + r.x + ',' + r.y + ') 大小 ' + r.w + 'x' + r.h
      + (r.iconic ? '  【最小化】' : '')
      + (fg && fg.title === r.title ? '  ★当前前台★' : ''));
    let out = '🪟 当前可见窗口（坐标是**物理像素**，可直接用于 click / focus_window）：\n'
      + lines.join('\n')
      + '\n（★标的是当前前台窗口 —— 键盘输入只会发给它。要让别的窗口收键盘，先 focus_window。）';
    if (ghosts.length) {
      /* 只列前几个，免得刷屏；关键是让模型明白"这些不在屏幕上、不构成遮挡" */
      out += '\n\n⚠️ 另有 ' + ghosts.length + ' 个**隐藏窗口**（cloaked 或 visible=false）—— '
        + '**它们没有显示在屏幕上，不算遮挡，不要因为它们而以为自己被挡住了**：\n'
        + ghosts.slice(0, 6).map((r) => '   · 「' + r.title + '」 ' + r.w + 'x' + r.h).join('\n')
        + (ghosts.length > 6 ? '\n   · …还有 ' + (ghosts.length - 6) + ' 个' : '')
        + '\n（实测：她曾把「任务切换」这个 cloaked 的宿主窗当成"盖住我的全屏浮层"，一直围着它绕。）';
    }
    return out;
  }
  if (tool === 'type') {
    /* 【分段可中断输入】抄自参考项目 Coopanion（packages/cortico-world-cua/src/engine-child.ts:113-126）：
       长文本按 16 字符一段发，**每段之间再查一次主人是否在用键鼠**，他一动就停手，
       并**如实回报实际打出了几个字符**（它的 cua_type 回执就写"只输入了 x/y 个字符：
       用户开始操作，停了下来"）。原来是一次性把整段发进 Input.exe —— 主人中途接手时
       她的输入会继续灌进去，把人正在打的字搅乱。

       ★ 前台断言（2026-10-02 加）★：输入只会进【前台窗口】。如果最近一次 focus_window
       的目标窗口现在不是前台了，就**拒绝输入并报明实情** —— 否则字会打进别的程序里，
       而她还以为成功了（这一天实测过两次）。 */
    const gate = await require('./safedrive').assertForegroundOrReport(lastFocus);
    if (!gate.ok) return gate.message;
    const text = String(arg);
    const CHUNK = 16;
    let done = 0;
    try {
      const ui = require('./userinput');
      for (let i = 0; i < text.length; i += CHUNK) {
        if (done > 0 && ui.isUserActive()) break;      // 主人开始操作 → 立刻停手
        const part = text.slice(i, i + CHUNK);
        input.type(part);
        done += part.length;
        if (i + CHUNK < text.length) await new Promise((r) => setTimeout(r, 60));
      }
    } catch (e) {
      if (!done) { input.type(text); done = text.length; }
    }
    /* 同上：输入会改变界面，等它反应完再让她看屏幕 */
    const settle = Number((config.load().memory || {}).actionSettleMs) || 1500;
    await new Promise((r) => setTimeout(r, settle));
    if (done < text.length) {
      return `⚠️ 只输入了 ${done}/${text.length} 个字符：**主人开始操作了，我停下来了**。`
        + `已经打进去的是：「${text.slice(0, done)}」；还没打的是：「${text.slice(done, done + 30)}${text.length - done > 30 ? '…' : ''}」。`
        + `主人松手后可以让我接着输入剩下的部分。`;
    }
    return `✅ 已输入文字：${text.slice(0, 50)}（已等 ${(settle / 1000).toFixed(1)}s）`;
  }
  if (tool === 'key') {
    /* ★ 前台断言（2026-10-02 加）★：按键只会进【前台窗口】。
       实测事故：她调 key|ctrl+f 得到 true，而 Ctrl+F 发给了别的窗口。
       现在若最近一次 focus_window 的目标已经不是前台，就拒绝执行并报明实情。 */
    const gateK = await require('./safedrive').assertForegroundOrReport(lastFocus);
    if (!gateK.ok) return gateK.message;
    input.key(arg);
    /* 按键（回车/ESC/方向键）常常触发界面跳转（比如登录、确认对话框），同样要等 */
    const settle = Number((config.load().memory || {}).actionSettleMs) || 1500;
    await new Promise((r) => setTimeout(r, settle));
    return `✅ 已按键：${arg}（已等 ${(settle / 1000).toFixed(1)}s，发给了前台「${gateK.foreground}」）`
      + (gateK.warn ? '\n' + gateK.warn : '');
  }
}

/* 对外入口：先查"是不是又在原地打转"，执行完再记一笔（用于下次判重）。
   包一层的好处：runInner 里有几十个 return，不用逐个去加记账代码。 */
/* 对外入口：先记一次"重复调用"（DSH 算法），执行完把提醒**前置**到回执里。
   包一层的好处：runInner 里有几十个 return，不用逐个去加记账代码。
   与旧实现的区别（重要）：
     · 旧的在第 3 次就**直接阻止**执行 —— 她辛苦想出的一步被吞掉，体验差；
     · 新的**只把提醒前置到回执**（照 dsh-repeat-tool-reminder 的 additionalContexts 语义），
       让她自己看到"这个动作重复了"再决定怎么办；只有到第 8 次（安全阀）才真的不执行。 */
async function run(tool, arg) {
  const t = String(tool == null ? '' : tool);
  const rep = REPEAT.note(t, arg);
  if (rep.block) return rep.advice;                       // 安全阀（第 8 次起）
  /* 【统一超时】照 DSH 的 dsh-tool-call-timeout-policy：超时表集中声明（src/timeout.js），
     这里对**每个工具**套一层。语义是"只通知、不抛弃"：
       · 超时 → 返回结构化的 TOOL_TIMEOUT 文案（模型知道该怎么办），原操作继续跑完；
       · 正常失败 → 异常原样抛回（保持原有语义，不改变调用方的 catch 行为）。
     两层配合：外层负责"告诉模型这个工具超时了"，各调用点自己的 execFile timeout
     负责真正杀死卡住的子进程、不留孤儿。 */
  const r = await withTimeout(runInner(t, arg), timeoutFor(t), t, (toolName, ms) => {
    try { dbg('[' + toolName + '] 超过 ' + ms + 'ms 没返回，已按 TOOL_TIMEOUT 处理（操作仍在跑）'); } catch {}
  });
  if (r.timedOut) {
    noteAction(t, arg, 'TIMEOUT');
    return r.message;
  }
  if (r.error) {
    noteAction(t, arg, 'ERR ' + ((r.error && r.error.message) || r.error));
    throw r.error;
  }
  const out = r.value;
  noteAction(t, arg, out);
  if (rep.advice && typeof out === 'string') return rep.advice + '\n' + out;
  return out;
}

/* __captureForTest / __captureFallbackForTest：只给测试脚本用（抓帧链路 + 无光标选项）。
   带下划线前缀表示"不是给模型调用的工具"，不进 TOOL_TIER、不进工具清单。 */
module.exports = {
  run, allowed, TOOL_TIER, RANK,
  __captureForTest: (grid, noCursor) => captureScreen(grid, noCursor),
  __captureFallbackForTest: () => captureScreenFallback(),
  __findTextInOcr: (j, needle) => findTextInOcr(j, needle),
  __noProgressWarning: (t, a) => noProgressWarning(t, a),
  __noteAction: (t, a, r) => noteAction(t, a, r),
  __actionLog: () => actionLog,
  __obs: () => OBS.stats(),
  __obsClear: () => OBS.clear(),
  __repeatReset: () => REPEAT.reset(),
  __repeatNote: (t, a) => REPEAT.note(t, a),
  __repeatState: () => ({ size: REPEAT.size(), cfg: REPEAT.config }),
  __ocrJson: (p) => ocrJson(p),
  __lastOcrError: () => lastOcrError,
  __zoomGuard: () => ({ streak: ZOOM_GUARD.streak, last: ZOOM_GUARD.last }),
  __zoomGuardReset: () => { ZOOM_GUARD.streak = 0; ZOOM_GUARD.last = null; },
  /* ★ 最近一次 OCR 的真实失败原因（空串=上次成功）★ */
};
