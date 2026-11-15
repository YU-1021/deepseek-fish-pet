/* safedrive.js —— 安全驱动层：把"动作"包上【前提断言 + 效果断言】
 *
 * ============================ 为什么需要 ============================
 * 2026-10-02 实测：这个系统里所有"动作类"工具都【报成功但不校验】——
 *   · focus_window 报 OK 而前台一个字没变（已由 focuswin v2 修好）
 *   · key|ctrl+f 报 true，实际发给了别的窗口
 *   · type|数据目录 报 true，实际打进了别的窗口的输入框
 *   · click 报"已点击"，实际可能落在别的窗口/空地方
 * 后果：模型（和她）做错了却无从知道，于是"换坐标再试一次"无限循环。
 *
 * 这一层的职责：**在动作前后把"事实"钉死**，任何一条不成立就【不动作】并显式报错。
 *
 * ============================ 三条断言 ============================
 *   ① 前台断言：动作之前，目标窗口必须真的在前台（回读 GetForegroundWindow，不信任何返回值）
 *   ② 位置断言：点击坐标必须落在目标窗口矩形内（防"点到别的窗口上"）
 *   ③ 效果断言：动作之后可选地做【局部 ROI 帧比对】，确认界面真的变了
 *
 * ============================ 为什么不用模型做验证 ============================
 * 视觉模型今天谎报过两次（"两个槽位都已进驻" ← 实际都是空的）。像素比对是确定性的。
 */
'use strict';

const fw = require('./focuswin');

/* ---------------- 断言：前台 ---------------- */
async function assertForeground(expectTitle) {
  const fg = await fw.foreground();
  const a = String(expectTitle || '').replace(/[\u200b-\u200f\ufeff]/g, '').trim();
  const b = String(fg.title || '').replace(/[\u200b-\u200f\ufeff]/g, '').trim();
  const ok = !!a && !!b && (b.indexOf(a) >= 0 || a.indexOf(b) >= 0 || b.slice(0, 10) === a.slice(0, 10));
  return { ok, expected: expectTitle, actual: fg.title, hwnd: fg.hwnd };
}

/* ---------------- 断言：光标真的到了目标（纯逻辑，可测）----------------
 * 实测事故：input.move() 返回 true，而 Win32 GetCursorPos 一查差 551px ——
 * 工具层把"命令发出去了"当成了"光标到了"。所以 move/click 之后必须【回读光标】。
 * 容差默认 6px（鼠标指针有热点偏移，且 DPI 换算可能有 ±1）。 */
function cursorMatches(target, actual, tolerance) {
  if (!target || !actual) return { ok: false, reason: 'no-data' };
  const tol = tolerance == null ? 6 : tolerance;
  const dx = Math.abs(Number(actual.x) - Number(target.x));
  const dy = Math.abs(Number(actual.y) - Number(target.y));
  return { ok: dx <= tol && dy <= tol, dx, dy, tolerance: tol };
}

/* ---------------- 坐标空间守卫：越界坐标绝不能发出去 ----------------
 * 实测（2026-10-10 probe-clickverify §4）：她给一个越界坐标（如 5000,3000）时，
 * input.norm() 会**静默把它夹到 (1.0000,1.0000)** ✗ —— 于是"点到屏幕右下角"，
 * 而回执照样写"✅ 已左键点击：(5000, 3000)" ✗。
 * ★这种"坐标是错的、但没有任何一步会说不"的路径，正是假成功的温床★
 * 所以在这里**前置拒绝**：一次点击都不发 ✓ */
function spaceBounds() {
  let w = 1920, h = 1080;
  try {
    const s = getInput().space();
    if (s && Number(s.w) > 0 && Number(s.h) > 0) { w = Number(s.w); h = Number(s.h); }
  } catch (e) { /* 拿不到就按历史默认值判，宁可宽松也不误拦 */ }
  return { w, h };
}
function outsideSpace(x, y, margin) {
  const b = spaceBounds();
  const m = margin == null ? 2 : margin;
  const nx = Number(x), ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return { ok: false, w: b.w, h: b.h, bad: 'not-a-number' };
  const bad = nx < -m || ny < -m || nx > b.w + m || ny > b.h + m;
  return bad ? { ok: false, w: b.w, h: b.h, bad: 'out-of-space' } : { ok: true, w: b.w, h: b.h };
}

/* ---------------- 光标真值：快路径 + 到达轮询 ----------------
 * ★★ 2026-10-10 实测（probe-clickverify）：假成功的真凶不止一个 ★★
 *   · PS 的 GetCursorPos 读一次要 ★561 / 575ms★（每次都现场 Add-Type 编译一遍 C#）
 *   · 而 input.exe 真正把光标移到位只要 ★14~51ms★
 *   → 所以旧写法「点完 → 睡到 570ms 后才读一次」在两个方向上都会错 ✗：
 *     · 命令没送到（遮挡/权限/夹到别处）→ 读到旧位置 → 它判"没到位"（这次是对的）
 *     · 命令送到了、但主人在这 570ms 里**动了一下鼠标** → 也读到"没到位" ✗
 *       而点击其实是成功的 —— 这正是她 13:18 那次"点了，但光标回读漂移"最可能的来源
 *       （当时主人就在旁边看着）。实测数据：目标 (1613,356) 回读 (653,265)。
 *   → ✓ 正确做法：用 **in-process 的 Electron 光标（≈0ms）每 15ms 采一次**，
 *     只要在预算内**采到过一次**"落在目标容差内"就算到位 ✓；
 *     一次都没采到，才算"没到位" ✓。
 *   ★这样同时消掉假成功（没到就不许说成功）和假失败（别拿 570ms 后的读数当铁证）★
 * ⚠️ 本模块不 require electron（纯逻辑单测要在无 electron 下能跑），
 *    所以 electron 只在 fastCursor 里 try require ✓；不在 electron 里就退回 PS 慢路径 ✓ */
function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fastCursor() {
  try {
    const { screen } = require('electron');
    if (screen && typeof screen.getCursorScreenPoint === 'function') {
      const dip = screen.getCursorScreenPoint();                        // DIP 坐标
      /* dipToScreenPoint 是 Windows 上的 DIP→**物理像素**换算（抓帧空间就是物理像素）。
         没有这个 API 时按 DIP 用（scaleFactor=1 的机器上两者相等）。
         实测本机 1536x864 @1.25 → 物理 1920x1080，两者换算后与 PS 读数逐像素一致 ✓ */
      const p = (typeof screen.dipToScreenPoint === 'function') ? screen.dipToScreenPoint(dip) : dip;
      return { x: Math.round(p.x), y: Math.round(p.y), src: 'electron' };
    }
  } catch (e) { /* 不在 electron 里 → 走下面的 PS 慢路径 */ }
  const c = await fw.cursorPos();
  return c ? { x: c.x, y: c.y, src: 'ps' } : null;
}

function cursorDelta(target, pos) {
  if (!target || !pos) return null;
  return { dx: Math.abs(Number(pos.x) - Number(target.x)), dy: Math.abs(Number(pos.y) - Number(target.y)) };
}

/* 轮询等光标到达目标。返回 {ok, pos, tries, waitedMs, src, best}
 * ★ok=true 的意思是"我确实**看到过**光标落在目标上"★ —— 不是"命令发出去了" ✓
 * o.cursorFn 可注入（单测用假光标序列确定性地覆盖本逻辑，不用真动鼠标）✓ */
async function pollCursorArrival(target, opts) {
  const o = opts || {};
  const tol = o.tolerance == null ? 6 : o.tolerance;
  const budgetMs = o.budgetMs == null ? 900 : o.budgetMs;
  const intervalMs = o.intervalMs == null ? 15 : o.intervalMs;
  const cur = typeof o.cursorFn === 'function' ? o.cursorFn : fastCursor;
  const t0 = Date.now();
  let last = await cur();
  let tries = 1;
  let best = cursorDelta(target, last);
  if (best && best.dx <= tol && best.dy <= tol) {
    return { ok: true, pos: last, tries, waitedMs: 0, src: last && last.src, best };
  }
  /* PS 慢路径（~570ms/次）**不轮询**：再读一次就是白等一秒。
     一轮读不到就如实报"没确认到位"，比拖 1.5 秒更负责 ✓ */
  if (last && last.src === 'ps') {
    return { ok: false, pos: last, tries, waitedMs: Date.now() - t0, src: 'ps', best };
  }
  while (Date.now() - t0 < budgetMs) {
    await sleepMs(intervalMs);
    const c = await cur();
    tries++;
    const d = cursorDelta(target, c);
    if (d && d.dx <= tol && d.dy <= tol) {
      return { ok: true, pos: c, tries, waitedMs: Date.now() - t0, src: c && c.src, best: d };
    }
    if (d && (!best || (d.dx + d.dy) < (best.dx + best.dy))) best = d;
    if (c) last = c;
  }
  return { ok: false, pos: last, tries, waitedMs: Date.now() - t0, src: last && last.src, best };
}

/* ---------------- 断言：坐标在窗口内 ---------------- */
function pointInRect(x, y, rect, margin) {
  if (!rect) return { ok: false, reason: 'no-rect' };
  const m = margin == null ? 2 : margin;
  const ok = x >= rect.x + m && x <= rect.x + rect.w - m && y >= rect.y + m && y <= rect.y + rect.h - m;
  return { ok, rect, point: { x, y } };
}

/* ---------------- 组合：确保前台（必要时自己置前并校验）---------------- */
async function ensureForeground(title, opts) {
  const o = opts || {};
  /* ★ 不光要求"是前台"，还要求"没被最小化"★
     实测事故（2026-10-03）：浏览器窗口确实是前台，但处于【最小化】状态，
     于是 ensureForeground 认为"已经在前台，不用动" → 截图里只剩桌面 → OCR 读到的全是桌面图标，
     整个探针白跑一轮。最小化的窗口 IsWindowVisible 仍为 true、也仍可能是"前台"，
     所以必须单独看 iconic。 */
  let minimized = false;
  try {
    const info = await fw.windowRect(title);
    minimized = !!(info && info.iconic);
  } catch {}
  const first = await assertForeground(title);
  if (first.ok && !minimized) return { ok: true, how: 'already', foreground: first.actual };
  if (first.ok && minimized && o.noFocus) {
    return { ok: false, reason: 'target-is-minimized', expected: title, actual: first.actual };
  }
  if (o.noFocus) return { ok: false, reason: 'foreground-mismatch', expected: title, actual: first.actual };
  const r = await fw.focusWindowEx(title);
  if (!r.ok) return { ok: false, reason: 'focus-failed', raw: r.raw, foreground: r.foreground || first.actual };
  const again = await assertForeground(title);
  return again.ok
    ? { ok: true, how: 'focused(' + (r.step || '') + ')', foreground: again.actual }
    : { ok: false, reason: 'focus-claimed-ok-but-foreground-mismatch', expected: title, actual: again.actual };
}

/* ---------------- 输入闸门：键盘类动作执行前的把关 ----------------
 * 输入只会进【前台窗口】。所以：
 *   · 她之前 focus_window 成功过（lastFocus 有值）→ 断言前台仍然是它，不是就【拒绝输入】并报明实情
 *   · 她从没 focus 过（lastFocus 为 null）→ 不拦，但**必须把"这次会发给谁"告诉她**
 *     （总比一个光秃秃的 true 强：2026-10-02 实测 key|ctrl+f 报 true 而实际发给了别的窗口）
 * 返回 {ok, message?, warn?, foreground}
 */
async function assertForegroundOrReport(expectTitle) {
  const fg = await fw.foreground();
  const actual = (fg && fg.title) || '(未知)';
  if (!expectTitle) {
    return {
      ok: true, foreground: actual,
      warn: '⚠️ 你这次**没有先 focus_window** —— 键盘输入只会发给【前台窗口】，'
        + '而当前前台是「' + actual + '」。如果那不是你要操作的程序，先 ACTION: focus_window|<它的标题片段>。',
    };
  }
  const chk = await assertForeground(expectTitle);
  if (chk.ok) return { ok: true, foreground: actual };
  return {
    ok: false, foreground: actual, expected: expectTitle,
    message: '❌ **拒绝输入**：键盘输入只会发给前台窗口，而现在的前台是「' + actual + '」，'
      + '不是你要操作的「' + expectTitle + '」。字/按键会打进那个程序里，所以我不做。\n'
      + '请先：ACTION: focus_window|' + expectTitle
      + '（如果它报 FAIL，说明我抢不过当前前台的权限 —— 那就请主人把它点到前面，再继续。）',
  };
}

/* ---------------- 失败原因的中文说法 + 环境回执文案 ----------------
 * ★用户要求（原话）："回执要把'为什么没成'说准"，而且要能让她和主人一眼看懂，
 *   并且必须以 ❌ 开头（她的循环就是按开头标记判这一步成没成的，见 chat.js 的正则）★。
 * 所以这里只做两件事：① 给每个 reason 一句中文；② 把"是谁挡着"拼成一句人话。 */
/* "主人在动鼠标吗" —— 问一句（userinput 顶层 require electron，纯 Node 下拿不到就是 available:false） */
function userBusySafe() {
  try { return require('./envcheck').userBusy(); }
  catch (e) { return { available: false, active: false, error: String((e && e.message) || e) }; }
}

const REASON_TEXT = {
  'point-outside-capture-space': '坐标越界（我一次都没发出去）',
  'user-is-using-mouse': '主人正在操作鼠标/键盘，我让位等他停',
  'target-under-own-window': '我自己的桌宠窗/DSH 窗压在这个点上',
  'target-not-expected-window': '最上面那个不是我要点的窗口',
  'target-covered-by-flyout': '目标被飞框/别的窗口压住了',
  'target-covered-by-light-panel': '目标被浅色面板（飞框/对话框）压住了',
  'target-covered-by-unknown-window': '目标点被别的窗口压住了',
  'point-on-taskbar': '那一点在任务栏上（点它会弹出日历飞框）',
  'repeat-needs-fresh-evidence': '这个目标点过了，而且没有新的证据（复点要先重新定位）',
  'repeat-too-many': '这个目标已经点过 2 次了，不许再点（别再打了）',
  'repeat-blocked': '被"不许复点"的账本拦住了',
  'no-provenance': '这个坐标不是任何定位工具刚给出的（默认不许写坐标）',
  'bypass-without-why': '要走"没有定位来源"的逃生门，必须写清用途（why 不能空）',
  'point-outside-target-window': '坐标不在目标窗口里',
  'cursor-did-not-reach-target': '光标没到目标（命令发了，但一次都没采到）',
  'target-is-minimized': '目标窗口是最小化的',
  'foreground-mismatch': '前台不是目标窗口',
  'focus-failed': '抢不到前台',
};
function reasonText(r) { return REASON_TEXT[r] || ('其它原因（' + (r || '未知') + '）'); }
function fmtBlocker(b) {
  if (!b) return '（读不到是谁）';
  const r = b.rect || {};
  return '「' + (b.title || '未知窗口') + '」' + (r.w ? ('（' + r.w + 'x' + r.h + ' @' + r.x + ',' + r.y + '）') : '');
}
/* "主人在用鼠标"的回执 —— ★必须说清是主人占用，不是她笨★ */
function userBusyNote(u) {
  const ms = (u && u.msSinceUser != null) ? Math.round(u.msSinceUser) : null;
  return '主人正在操作鼠标' + (ms != null ? '（最近一次动鼠标是 ' + ms + 'ms 前）' : '') + '，我让位——'
    + '★这不是我做错了，也不是点击坏了★：实测主人手在鼠标上时 9/9 都没法确认光标到位，'
    + '手拿开之后 9/9 都到位。我等他停手（约 3 秒不动）再来。';
}
/* "被挡着"的回执 —— 指出是谁挡着 + 两条出路（关掉它 / 换个位置） */
function envNote(x, y, ec) {
  const b = (ec && (ec.blocker || ec.top)) || null;
  const head = '⚠️ 坐标 (' + x + ',' + y + ') 上现在压着 ' + fmtBlocker(b) + '，我先不点。';
  let tail = '';
  if (ec && ec.bright && ec.bright.ratio != null) {
    tail = '（这一点周围 ' + (ec.bright.region ? (ec.bright.region.w + 'x' + ec.bright.region.h) : '一小块')
      + ' 的亮像素比例 ' + (ec.bright.ratio * 100).toFixed(1) + '%，正常该是 1% 上下 —— '
      + '浅色面板压着的特征）';
  }
  return head + tail + '\n★要么先把它关掉（飞框一般按 Esc 或点一下别处就行），要么换一个没被压住的坐标再点★；'
    + '如果它本来就是我该点的那一层（比如目标就在 DSH 自己窗里），就先把它挪开/最小化。';
}

/* ---------------- 环境检查的"默认依赖"（不用调用方传） ----------------
 * 为什么放这里 ✗→✓：这套检查原来要 assistant.js 的 click 分支显式传
 *   （expectTitle / grab / taskbarTop / spaceW…）—— 那样**别处调用 clickSafe 就没有保护**✗，
 *   而且 assistant.js 是好几条线共用的文件（改它容易撞车）。
 *   现在：只要在 Electron 里，safedrive 自己把依赖凑齐；纯 Node 单测里拿不到 electron，
 *   环境检查自动关闭（单测不该去拉窗口列表/抓屏）。
 * ⚠️ 抓帧走 screenstream（show:false 的隐藏窗，不弹窗）；拿不到就只做窗口判定。 */
function envDeps() {
  let electron = null;
  try { electron = require('electron'); } catch (e) { return null; }
  if (!electron || !electron.screen || typeof electron.screen.getPrimaryDisplay !== 'function') return null;
  const EC = require('./envcheck');
  const capSpace = spaceBounds();
  let taskbarTop = null;
  try { taskbarTop = EC.taskbarTopOf(electron.screen.getPrimaryDisplay(), capSpace.h); } catch (e) {}
  return {
    selfPids: [process.pid],
    taskbarTop,
    spaceW: capSpace.w, spaceH: capSpace.h,
    screenW: capSpace.w, screenH: capSpace.h,
    /* 抓一帧 BGRA（只算点周围 60x60 的亮像素比例）。不写盘、不画准星。 */
    grab: async () => {
      try {
        const ss = require('./screenstream');
        const f = await ss.grabFrame({ grid: false, noCursor: true });
        if (f && f.dataUrl) {
          const img = electron.nativeImage.createFromDataURL(f.dataUrl);
          const s = img.getSize();
          if (s.width && s.height) return { bgra: img.toBitmap(), w: s.width, h: s.height, src: 'stream' };
        }
      } catch (e) {}
      try {
        const d = electron.screen.getPrimaryDisplay();
        const { width, height } = d.size;
        const scale = d.scaleFactor || 1;
        const srcs = await electron.desktopCapturer.getSources({
          types: ['screen'], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
        });
        const src = srcs.find((s) => s.display_id === String(d.id)) || srcs[0];
        if (!src) return null;
        const s2 = src.thumbnail.getSize();
        return { bgra: src.thumbnail.toBitmap(), w: s2.width, h: s2.height, src: 'capturer' };
      } catch (e) { return null; }
    },
  };
}

/* ---------------- 带断言的动作 ---------------- */
/* input 是懒加载的：这样纯逻辑测试（不碰键鼠）也能 require 本模块 */
function getInput() { return require('./input'); }

/* ---------------- 被拦下来时怎么"说出去" ----------------
 * ★★ 2026-10-11 真机 bug ★★：assistant.js 的 click 分支**只看 move 的失败、不看 click 的失败**✗ ——
 *   于是本层返回 `ok:false`（越界/被飞框挡/主人在动鼠标/光标没到位）时，
 *   上层照样写「✅ 已左键点击」✗★ —— 这正是主人看到的"她说点了、其实没点"。
 *   而 assistant.js 是好几条线共用的文件（改它容易撞车 ✗），所以**在这一层把它说出去** ✓：
 *   · 默认：**抛错** → 上层（main.js → renderer）那条链的失败文案是「❌ 操作 click 失败：…」✓
 *     （她读到的就是 ❌ 开头 + 中文原因，循环也会把这一步记为失败 ✓）
 *   · `o.softBlock === true`：只返回结构体不抛（给探针/程序化调用用 ✓）
 *   ⚠️ 不要在这里吞掉错误：宁可这一步响亮地失败，也不要静默地假装成功 ✓ */
function blockFail(out, reason, note, o) {
  const rec = Object.assign(out, { ok: false, blocked: true, reason, note });
  const text = '❌ ' + String(note || reasonText(reason)) + ' [' + reason + ']';
  if (o && o.softBlock) return rec;
  const err = new Error(text);
  err.blocked = true; err.reason = reason; err.note = rec.note; err.detail = rec;
  throw err;
}

async function clickSafe(x, y, opts) {
  const o = opts || {};
  const kind = o.kind === 'rclick' || o.kind === 'dclick' ? o.kind : 'click';
  const out = { action: kind, point: { x, y } };
  /* ⓪ ★坐标空间守卫★：越界坐标会被静默夹到屏幕边缘 → 点到完全别的地方 ✗
        （实测 2026-10-10 probe-clickverify §4）这里拒绝，一次点击都不发 ✓ */
  const sp = outsideSpace(x, y, o.spaceMargin);
  if (!sp.ok) {
    return blockFail(Object.assign(out, { space: { w: sp.w, h: sp.h } }), 'point-outside-capture-space',
      '★坐标越界，我一次点击都没发★ 你给的是 (' + x + ',' + y + ')，'
      + '而可用的坐标空间是 ' + sp.w + 'x' + sp.h + '（左上 0,0 → 右下 ' + sp.w + ',' + sp.h + '）。'
      + '这种坐标以前会被**静默夹到屏幕边缘**、点到完全别的地方还报成功 —— 现在直接拒绝。'
      + '★请先确认目标的真实坐标：能读到文字/控件名的目标请用 find_text / uia_snapshot + uia_find，'
      + '要精确位置可用 find_template / find_grid。', o);
  }
  /* ⓪b ★★环境检查：这一点上现在压着谁？★★（2026-10-10 的根因 3）
     真机经过：连点 9 下、screen_diff 全是 0.0x%，我以为"点击又坏了" ——
     ★把右边缘裁出来一看，那一片是 Windows 的日历飞框★（点任务栏的时间弹出来的），
     它一直开着压着游戏那一列；关掉之后（亮像素比例 40% → 0.7%）9/9 全 OK。
     所以【发点击之前】必须先看这一点的环境，任何一条不对就★先别点★，并把"是谁挡着"写进回执 ✓
     ★开关★：Electron 里**默认开**；`o.envCheck === false` 关掉；纯 Node（没有 electron）自动关。 */
  let env = null;
  const dep = (o.envCheck === false) ? null : envDeps();
  if (dep) {
    const EC = require('./envcheck');
    const ecOpts = Object.assign({}, dep, (o.envCheck && o.envCheck !== true) ? o.envCheck : {});
    env = await EC.checkPoint(x, y, ecOpts);
    out.env = {
      ok: env.ok !== false, blocked: !!env.blocked, reason: env.reason || null,
      top: env.top || null, below: (env.below || []).slice(0, 3),
      bright: (env.bright && env.bright.ratio != null) ? env.bright.ratio : null,
      userActive: !!(env.user && env.user.active), notes: env.notes || [],
      undetermined: !!env.undetermined,
    };
    if (env.blocked) {
      return blockFail(Object.assign(out, { blocker: env.blocker || env.top || null }),
        env.reason || 'target-covered-by-unknown-window', envNote(x, y, env), o);
    }
    /* ★主人在动鼠标 → 让位★（这是**特性**不是 bug：实测手在鼠标上 9/9 没到位、手拿开 9/9 到位）。
       宁可这一步不点、如实说"我等他停"，也不要发出一次注定被搅掉的点击 ✓ */
    if (env.user && env.user.available && env.user.active) {
      return blockFail(out, 'user-is-using-mouse', userBusyNote(env.user), o);
    }
  }
  /* ① 前台 */
  if (o.expectForeground) {
    const f = await ensureForeground(o.expectForeground, o);
    out.foreground = f;
    if (!f.ok) return blockFail(out, f.reason || 'foreground-mismatch', f.message || null, o);
  }
  /* ② 位置 */
  if (o.windowRect) {
    const p = pointInRect(x, y, o.windowRect, o.margin);
    out.inWindow = p;
    if (!p.ok) return blockFail(out, 'point-outside-target-window', null, o);
  }
  /* ②b ★★不许复点★（2026-10-11 主人症状③的正解）★★
     实测：click 一次只发一组 down+up（间隔 45ms），Windows 认双击的窗口 500ms/4px，
     而她两次点击实测隔 3~6 秒 → **不可能被并成双击**；
     "点对一次又点掉一次" = 两次**独立单击**打在同一个 toggle 上（第一下开/选中，第二下关/取消）。
     所以：★同一个目标默认只点一次；想再点必须有**新证据**（点完之后重新定位过一次）；最多 2 次，第 3 次拒绝★。
     账本用 prov.js 的**共用实例**（locate/act 那条线也用它 —— 只有一本账 ✓）。
     ⚠️ 纯 Node 单测里没有账本副作用也没关系（prov 是纯逻辑 ✓）；o.skipRepeatGuard 只给探针/诊断用 ✓ */
  if (!o.skipRepeatGuard) {
    const ledger = require('./prov').instance;
    /* ★★ 2026-10-11 主人的决定：默认必须有**定位来源**★★
       坐标必须来自本次会话已登记的 offer（uia_find / find_text / find_template / find_owned /
       click_checked / grid_count / icon_lib / locate ✓，且只认**已换算成她坐标空间**的那种 ✓）；
       没登记 → 抛 ❌（no-provenance）✓。
       ★逃生门★：`{requireOffer:false, why:'<用途>'}`（why 必填、放行会记日志 ✓）——
         只给探针/开发/诊断用，**不写进她读得到的工具表** ✗。
       ⚠️ input.js 里还有一道同样的闸门（drag/scroll 直接调它 ✓）—— 两处共用同一本账 ✓，
         结论必然一致 ✓；这一道负责把结构化信息（repeatGuard / bypass）带进回执 ✓。 */
    const g = ledger.gate(kind, x, y, { requireOffer: o.requireOffer, why: o.why });
    out.repeatGuard = {
      ok: g.ok, code: g.code || null, bypass: g.bypass || null,
      alreadyClicked: g.alreadyClicked == null ? null : g.alreadyClicked,
    };
    if (!g.ok) return blockFail(out, g.code || 'no-provenance', g.reason + '\n' + (g.hint || ''), o);
    if (g.bypass) out.bypass = { why: g.bypass, at: Date.now() };
  }
  /* ③ 动作（把两个选项**透传**给 input：它在那一层还要再判一次 ✓，drag/scroll 也靠它 ✓） */
  const IN = getInput();
  const fn = (typeof IN[kind] === 'function' ? IN[kind] : IN.click).bind(IN);
  out.result = await fn(x, y, { requireOffer: o.requireOffer, why: o.why });
  /* ★点完记一笔账★（不管有没有确认到位都记：重点是"这一点刚刚已经点过了" ✓） */
  if (!o.skipRepeatGuard) {
    try { require('./prov').instance.note(kind, x, y, 'clickSafe'); } catch (e) {}
  }
  /* ④ ★效果断言：轮询采到过"光标在目标上"才算到位★
      ⚠️ 旧写法是「发完命令 → 单次回读」并且【无条件 ok=true】——
         实测它自己都回读到"差 960/91 像素"、回执照样写"✅ 已点击" ✗，
         而主人看到的就是"她说点了、其实没点到" ✗。
      现在：没看到光标到过目标 → ok=false、reason=cursor-did-not-reach-target ✓ */
  const arr = await pollCursorArrival({ x, y }, { tolerance: o.tolerance, budgetMs: o.arriveMs, intervalMs: o.sampleMs });
  out.cursorAfter = arr.pos;
  out.cursorVerified = arr.ok;
  out.cursorDelta = arr.best || null;
  out.cursorSamples = arr.tries;
  out.cursorSrc = arr.src;
  if (!arr.ok) {
    /* ★★失败原因必须细分★★（用户要求：回执要说准"为什么没成"，不能只有一句含糊的"没做成"）
       今天之前失败只有 cursor-did-not-reach-target 一个值，主人根本分不清是
       "我还占着鼠标" / "目标被飞框挡住了" / "坐标越界"。现在分四类，各有中文说法：
         user-is-using-mouse   主人在操作鼠标/键盘，安全层让位（**不是她的错**，等他停）
         target-*              目标被别的窗口/飞框挡住（进来看见的是别人的像素）
         point-outside-...     坐标越界（发都没发出去）
         cursor-did-not-reach-target  其它（命令发出去了、但一次都没看到光标落在目标上） */
    let reason = 'cursor-did-not-reach-target';
    let why = '';
    const bus = userBusySafe();
    if (bus.available && bus.active) {
      reason = 'user-is-using-mouse'; why = userBusyNote(bus);
    } else if (env && env.top && env.notes && env.notes.length) {
      /* 环境本身有异常记录（例如亮比例偏高但没到拦的门限）→ 作为线索附上 */
      why = '（另外：环境检查的备注 —— ' + env.notes.join('；') + '）';
    }
    return blockFail(out, reason,
      '点击命令**发出去了**，但在 ' + arr.waitedMs + 'ms 内（' + arr.tries + ' 次采样）'
      + '我★一次都没看到光标落在目标 (' + x + ',' + y + ') 上★：最后一次采到的是 '
      + (arr.pos ? '(' + arr.pos.x + ',' + arr.pos.y + ')' : '读不到光标')
      + (arr.best ? '，与目标相差 ' + arr.best.dx + '/' + arr.best.dy + ' 像素' : '') + '。'
      + '★所以这不是"已点击"，很可能根本没点中★。'
      + (why ? '\n原因判断：' + why : '')
      + '\n（另一种可能：命令执行那一瞬间**主人正在动鼠标** —— 那只说明"我无法确认"，不代表一定没点中。）'
      + '★别急着重试★：先确认目标窗口没被挡住、没最小化、坐标是不是它**现在**的真实位置；'
      + '能读到文字/控件名的目标请改用 uia_find + click，或者直接 uia_invoke（零坐标触发）。', o);
  }
  out.ok = true;
  out.how = 'cursor-arrived(' + (arr.src || '?') + ', ' + arr.waitedMs + 'ms, ' + arr.tries + ' 次采样)';
  return out;
}

async function moveSafe(x, y, opts) {
  const o = opts || {};
  const out = { action: 'move', point: { x, y } };
  /* ⓪ 坐标空间守卫（理由同 clickSafe） */
  const sp = outsideSpace(x, y, o.spaceMargin);
  if (!sp.ok) {
    return Object.assign(out, {
      ok: false, blocked: true, reason: 'point-outside-capture-space',
      space: { w: sp.w, h: sp.h },
      note: '★坐标越界，我一次都没动★ 你给的是 (' + x + ',' + y + ')，坐标空间是 '
        + sp.w + 'x' + sp.h + ' —— 越界坐标会被静默夹到边缘，落到完全别的位置。',
    });
  }
  /* ⓪b ★移动也要**定位来源**★（2026-10-11 主人的决定：move 也在收紧名单里 ✓）——
     理由：move 不改界面，但"模型自己写一个坐标让光标过去"同样是错坐标的来源之一 ✓
     （而且它会把 userinput 的"主人动鼠标"判定搅乱 ✓）。规则/逃生门同 clickSafe ✓。 */
  if (!o.skipRepeatGuard) {
    const g = require('./prov').instance.gate('move', x, y, { requireOffer: o.requireOffer, why: o.why });
    out.moveGuard = { ok: g.ok, code: g.code || null, bypass: g.bypass || null };
    if (!g.ok) return blockFail(out, g.code || 'no-provenance', g.reason + '\n' + (g.hint || ''), o);
    if (g.bypass) out.bypass = { why: g.bypass, at: Date.now() };
  }
  if (o.expectForeground) {
    const f = await ensureForeground(o.expectForeground, o);
    out.foreground = f;
    if (!f.ok) return Object.assign(out, { ok: false, blocked: true, reason: f.reason });
  }
  if (o.windowRect) {
    const p = pointInRect(x, y, o.windowRect, o.margin);
    out.inWindow = p;
    if (!p.ok) return Object.assign(out, { ok: false, blocked: true, reason: 'point-outside-target-window' });
  }
  out.result = await getInput().move(x, y, { requireOffer: o.requireOffer, why: o.why });
  /* ★ 效果断言：轮询等它到达（旧写法是单次 570ms 后的回读 → 会把"其实到了"误判成没到）★ */
  const arr = await pollCursorArrival({ x, y }, { tolerance: o.tolerance, budgetMs: o.arriveMs, intervalMs: o.sampleMs });
  out.cursorAfter = arr.pos;
  out.verified = arr.ok;
  out.delta = arr.best || null;
  out.cursorSamples = arr.tries;
  out.cursorSrc = arr.src;
  if (!arr.ok) {
    /* 移动的失败原因也细分（同 clickSafe）：主人在动鼠标 → 说清楚是让位，不是她做错 */
    const bus = userBusySafe();
    const reason = (bus.available && bus.active) ? 'user-is-using-mouse' : 'cursor-did-not-reach-target';
    return Object.assign(out, { ok: false, reason,
      note: '移动命令返回了成功，但 ' + arr.waitedMs + 'ms 内（' + arr.tries + ' 次采样）'
        + '光标★一次都没到过★目标：最后一次在 '
        + (arr.pos ? '(' + arr.pos.x + ',' + arr.pos.y + ')' : '读不到')
        + (arr.best ? '，与目标相差 ' + arr.best.dx + '/' + arr.best.dy + ' 像素' : '') + ' —— 这就是"假成功"。'
        + (reason === 'user-is-using-mouse' ? '\n原因判断：' + userBusyNote(bus) : '') });
  }
  out.ok = true;
  out.how = 'cursor-arrived(' + (arr.src || '?') + ', ' + arr.waitedMs + 'ms, ' + arr.tries + ' 次采样)';
  return out;
}

/* 键盘类动作：【必须】有前台断言 —— 没有它就会打到别的窗口上（今天的两次事故）。
 * 如果不传 expectForeground，就退而求其次：把"当前前台是谁"记下来并返回，
 * 让调用方知道它到底发给了谁（总比一个光秃秃的 true 强）。 */
async function keySafe(name, opts) {
  const o = opts || {};
  const out = { action: 'key', key: name };
  const before = await fw.foreground();
  out.foregroundBefore = before.title;
  if (o.expectForeground) {
    const f = await ensureForeground(o.expectForeground, o);
    out.foreground = f;
    if (!f.ok) return Object.assign(out, { ok: false, blocked: true, reason: f.reason });
  } else if (o.warnNoTarget) {
    out.warning = '没指定 expectForeground —— 这个按键会发给『' + before.title + '』，请确认那是你要的窗口';
  }
  out.result = await getInput().key(name);
  out.ok = true;
  return out;
}

async function typeSafe(text, opts) {
  const o = opts || {};
  const out = { action: 'type', text: String(text).slice(0, 40) };
  const before = await fw.foreground();
  out.foregroundBefore = before.title;
  if (o.expectForeground) {
    const f = await ensureForeground(o.expectForeground, o);
    out.foreground = f;
    if (!f.ok) return Object.assign(out, { ok: false, blocked: true, reason: f.reason });
  } else if (o.warnNoTarget) {
    out.warning = '没指定 expectForeground —— 这些字会打进『' + before.title + '』，请确认那是你要的窗口';
  }
  out.result = await getInput().type(text);
  out.ok = true;
  return out;
}

/* ---------------- 效果断言：局部 ROI 帧比对 ---------------- */
/* 全屏比对噪声大（调研明确点出），所以支持只比一个区域。
 * beforeFrame / afterFrame 是 { dataUrl } 或 nativeImage；这里只做"裁区域→比对"，
 * 取图和 nativeImage 的活交给调用方（保持本模块可纯 Node 测）。 */
function diffRegion(FD, beforeBmp, afterBmp, w, h, rect, opts) {
  if (!rect) return FD.diffBgra(beforeBmp, afterBmp, w, h, opts);
  const x0 = Math.max(0, Math.min(w - 1, rect.x));
  const y0 = Math.max(0, Math.min(h - 1, rect.y));
  const x1 = Math.max(x0 + 1, Math.min(w, rect.x + rect.w));
  const y1 = Math.max(y0 + 1, Math.min(h, rect.y + rect.h));
  const rw = x1 - x0, rh = y1 - y0;
  const a = Buffer.alloc(rw * rh * 4), b = Buffer.alloc(rw * rh * 4);
  for (let y = 0; y < rh; y++) {
    const src = ((y0 + y) * w + x0) * 4;
    const dst = (y * rw) * 4;
    beforeBmp.copy(a, dst, src, src + rw * 4);
    afterBmp.copy(b, dst, src, src + rw * 4);
  }
  const r = FD.diffBgra(a, b, rw, rh, opts);
  return Object.assign(r, { region: { x: x0, y: y0, w: rw, h: rh } });
}

/* ---------------- 一站式：找窗口 → 置前 → 校验 → （可选）点位 ---------------- */
async function target(title, opts) {
  const o = opts || {};
  const list = await fw.listWindows();
  /* ★ 列窗口失败就必须显式失败 ★
     实测：focuswin 的 PS 里 C# 编译失败时 listWindows 曾**静默返回 0 个窗口** ✗，
     于是 target() 报"window-not-found"，看起来像"目标窗口不在" —— 完全是误导。
     现在 listWindows 会带回 ok/error，这里必须认它。 */
  if (list.ok === false) {
    return { ok: false, reason: 'window-enumeration-failed', error: list.error, rawOut: list.rawOut };
  }
  const want = String(title || '');
  /* ★ 同名窗口要优先挑【前台那个】★
     实测：Edge 会为同一个页面暴露多个顶层窗口，标题几乎一样（"公招计算 · 可露希尔基建终端…"），
     我原来按【面积】挑，挑到了 (16,124) 那个 —— 而实际可见/在前台的是 (101,100)，
     于是窗口矩形对不上，OCR 结果里滤进来一堆【桌面图标】（白跑一轮）。
     现在：先看前台窗口标题属于谁，能在候选里对上就优先它；否则再看"可见且非最小化"，最后才按面积。 */
  const cands = list.windows.filter((w) => w.title.indexOf(want) >= 0);
  const fgTitle = (list.foregroundTitle || '').replace(/[\u200b-\u200f\ufeff]/g, '');
  const normT = (x) => String(x).replace(/[\u200b-\u200f\ufeff\s]/g, '');
  /* ★ 优先用【前台 HWND】精确挑 ★：标题会重复，hwnd 不会。 */
  /* ⚠️ 前台那一个【还必须可见】：实测 UWP 应用（计算器）会有一个 visible=false 的宿主窗口，
     而它居然是 GetForegroundWindow() 的返回值 —— 不加 visible 条件就会挑中它，
     随后 UIA 查不到元素树（NOTFOUND）、点击也落不到真正可见的窗口上。 */
  /* ★ "真的在屏幕上"的判定：visible && !cloaked && !iconic ★
     实测（2026-10-03）：同机有 8 个标题都含「可露希尔」的 Edge 窗口，
     **全部 visible=否**，其中一个还是 cloaked=是；屏幕上其实只有桌面和我的窗口。
     而 target() 因为"前台 HWND 匹配"挑中了其中一个 —— 前台也会是这种幽灵窗口 ✗。
     DWM 的 cloaked = 被合成器隐藏（UWP 挂起 / 别的虚拟桌面 / 刚关掉的 Edge），
     Win32 的 IsWindowVisible 对这种窗口照样返回 true，只有它才靠得住。 */
  /* ★★ 不再强求 visible（2026-10-03 实测更正）★★
     原来写的是 visible !== false && !cloaked && !iconic。但实测发现：
     **UWP 应用（Windows 计算器）的 visible 标志会在"是/否"之间来回翻** ✗ ——
     同一个 hwnd，focus 之前 visible=是、focus 之后 visible=否，而窗口其实好好地显示着。
     更早我还见过一批 Edge 幽灵窗也是 visible=否（那批**确实不在屏幕上**）——
     也就是说 **visible 这个标志区分不了"UWP 真窗口"和"真幽灵"** ✗。
     现在只保留 !cloaked && !iconic（这两个是可靠的），
     真正的"看得见吗"交给两道更强的判据：
       · 遮挡前提断言（occlusion.scene，按 z 序 + 可见性剔除幽灵）
       · 截图 / 帧比对（最终仲裁 —— 这也是用户教的那条："截图看看不就知道了吗"） */
  const reallyShown = (w) => !w.cloaked && !w.iconic;
  let win = (list.foregroundHwnd ? cands.find((w) => w.hwnd === list.foregroundHwnd && reallyShown(w)) : null)
    || cands.find((w) => fgTitle && normT(w.title) === normT(fgTitle) && w.visible !== false)
    || cands.filter(reallyShown).sort((a, b) => b.w * b.h - a.w * a.h)[0]
    || null;
  /* ★ 兜底不能再退到"不可见的窗口" ★
     实测事故：浏览器其实已经被关掉了，只剩一个 visible=false 的残留 Edge 窗口，
     而旧代码的最后一道兜底是"按面积取第一个匹配" —— 它不看 visible，
     于是 target() 报 ok 并返回那个隐藏窗口的矩形，后面所有定位/点击全建在错的位置上 ✗。
     没有"可见且非最小化"的匹配时，就如实失败。 */
  if (!win) {
    return {
      ok: false, reason: 'window-not-visible',
      candidates: cands.map((w) => ({ title: w.title, visible: w.visible, iconic: w.iconic, cloaked: w.cloaked })),
      message: '找到 ' + cands.length + ' 个标题匹配的窗口，但【没有一个可见且非最小化】——'
        + '目标大概是关掉了，或者被 DWM 隐藏着（cloaked）。先把它打开/切到前台，再继续。'
    };
  }
  if (!win) return { ok: false, reason: 'window-not-found', candidates: list.windows.map((w) => w.title).slice(0, 20) };
  const f = await ensureForeground(want, o);
  /* ★★ 前提断言：目标不能被"压在它上面的窗口"盖住 ★★
     实测事故（2026-10-03）：计算器确实是前台（回读确认 ✓），但被 6 个**置顶**窗口
     （任务切换 / Codex / 通知窗…）压着 —— 于是截图里根本没有计算器，
     随后 UIA / OCR / 几何三条定位器【全部必然失败】，而"前台校验"却报了成功。
     **前台 ≠ 可见。** 所以这里必须再查一次遮挡：被压得太多就直接判不通过，
     并明确告诉调用方"先让它露出来"，而不是带着一个看不见的目标往下走。 */
  let occlusion = null;
  try {
    const oc = require('./occlusion');
    const sc = await oc.scene({ targetTitle: want, selfPids: o.selfPids || [process.pid] });
    if (sc.ok) {
      occlusion = { covered: sc.covered, ratio: sc.coveredRatio, note: sc.coveredNote };
      const limit = o.maxCovered == null ? 0.35 : o.maxCovered;
      if (sc.coveredRatio > limit) {
        return {
          ok: false, reason: 'target-is-covered',
          window: win, foreground: f, occlusion,
          rect: { x: win.x, y: win.y, w: win.w, h: win.h },
          message: '目标窗口「' + want + '」被别的窗口盖住了（最大单个遮住约 '
            + Math.round(sc.coveredRatio * 100) + '%）：'
            + sc.covered.slice(0, 5).map((c) => String(c.title).slice(0, 22)).join(' / ')
            + '。截图里可能根本没有它，任何定位都会失败 —— **先让它露出来再操作**。',
        };
      }
    }
  } catch (e) { occlusion = { error: String((e && e.message) || e) }; }
  /* ★ 聚焦之后必须【重新读矩形】★
     实测：最小化的窗口 GetWindowRect 返回 -32000,-32000（Windows 把最小化窗口扔到屏幕外），
     恢复之后才是真坐标。第一版直接用了聚焦前的 rect，于是返回了 -32000 —— 照它点击必然全错。
     （这正是"拿着一个看起来像数据的旧值就用了"，和今天批评的那些假成功同一类错误。） */
  let fresh = win;
  if (f.ok) {
    const again = await fw.listWindows();
    const w2 = again.windows.filter((w) => w.title.indexOf(want) >= 0).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (w2 && !w2.iconic && w2.w > 200) fresh = w2;
    else if (w2) fresh = w2;   // 至少用新值（哪怕它仍是最小化 —— 调用方能用 iconic 判断）
  }
  return {
    ok: f.ok && !fresh.iconic, window: fresh, foreground: f,
    rect: { x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h },
    stale: fresh === win,
    dpi: list.dpi, scale: list.scale,
  };
}

module.exports = {
  assertForeground, assertForegroundOrReport, pointInRect, cursorMatches, ensureForeground, diffRegion, target,
  clickSafe, moveSafe, keySafe, typeSafe,
  /* 2026-10-10 新增：快路径光标 + 到达轮询 + 坐标空间守卫（都是纯逻辑/可注入，能被单测覆盖） */
  fastCursor, pollCursorArrival, cursorDelta, outsideSpace, spaceBounds,
  /* 2026-10-10 新增：失败原因的中文说法 + 环境回执文案（回执必须说准"为什么没成"） */
  reasonText, REASON_TEXT, envNote, userBusyNote, userBusySafe,
  _internals: { pointInRect },
};
