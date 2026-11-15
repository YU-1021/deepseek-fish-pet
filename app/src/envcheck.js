/* envcheck.js —— ★点击前的环境检查★（2026-10-10 真机查清的四个根因之一）
 *
 * ============================ 为什么需要 ============================
 * 今天连点 9 下，screen_diff 全是 0.0x%，我以为是"点击又坏了"。
 * ★把右边缘裁出来一看：那一片根本不是游戏那一列，是 Windows 的日历/时钟飞框★
 * （「全部清除」、日历网格、「开始专注」）。
 * 它是怎么开的：第 9 个点 y=1058 落在**任务栏**上 → 点时间就弹出日历；
 * 而更早她自己那次 click 1810,833 也在任务栏上 → ★从那时候起日历就一直开着、压着她的目标★。
 * 关了之后（Esc×2 + 中间点一下；右条亮像素比例从 ~40% 降到 0.7%），再点 9/9 全 OK。
 *
 * 结论：**点击之前必须检查"这一点上现在到底压着谁"** ——
 *   ① 目标坐标落在哪些【可见】窗口的矩形内（z 序最上面那个是谁）
 *   ② 目标周围一小块（默认 60x60）的**亮像素比例**（飞框是浅色面板 → 亮比例异常高）
 *   ③ 主人是不是正在用鼠标（那是特性不是 bug，但必须说清楚）
 * 任何一条不对 → ★先别点★，并回一条能让人看懂的话。
 *
 * ============================ 设计原则 ============================
 * · 判定是**纯逻辑**（decide / brightRatio 不碰 IO）→ 能被纯 Node 单测；
 *   取窗口列表和抓帧是异步的（checkPoint）。
 * · 没有 electron 也能跑（抓帧由调用方注入 grab；userinput 是 try require）。
 * · ★绝不因为"读不到"就放行或拒绝★ —— 读不到就如实报 undetermined，交给上层。
 */
'use strict';

const fw = require('./focuswin');

/* 桌面壳：Program Manager 永远盖满全屏，它不是"挡路的窗口"（不排除它会谁都点不了） */
const SKIP_TITLES = ['Program Manager'];
/* ★她自己的窗口和 DSH 的窗口也算"挡路的"★（用户明确要求）：
   她点下去只会点在自己/DSH 上，不是目标。桌宠的立绘窗由 main.js 的 yieldOwnWindowsAt 先让开，
   但"对话窗/DSH"不一定让得开，所以这里也拦一道。 */
const SELF_HINTS = ['dayu-pet', '大肥鱼', 'DeepSeek Harness'];
/* 已知的"飞框/系统面板"标题特征（小面板压在大窗口之上，点下去等于点在面板上） */
const PANEL_HINTS = ['日历', '时钟', '任务切换', '输入体验', '系统托盘溢出', 'CustomNotification',
  'Shell Experience Host', '小组件', 'Widgets', '通知', '搜索', '开始', 'OneDrive', 'OMEN', 'Flyout'];

const DEFAULTS = {
  minW: 24, minH: 24,        // 小于这个的窗口不当遮挡者（托盘图标/指示器之类）
  region: 60,                // 取点周围 60x60 看亮像素
  brightMax: 0.20,           // ★亮像素比例 > 20% 判"有浅色面板压着"★（实测日历 ~40%、干净时 0.7%）
  brightLum: 200,            // 单像素算"亮"的亮度门限（0.299R+0.587G+0.114B）
  panelAreaRatio: 0.25,      // 本身小于屏幕 25% 的窗口，才可能是"飞框"
  overAreaRatio: 4,          // 它下面那个窗口比它大 4 倍 → 它就是小面板压在应用上
  taskbarTop: null,          // 任务栏的上边缘（坐标空间里的 y）；null = 不知道就不判
};

/* ---------------- 纯逻辑 ---------------- */
function normTitle(s) {
  return String(s == null ? '' : s).replace(/[\u200b-\u200f\ufeff]/g, '').trim();
}
/* 标题匹配（宽容，和 safedrive.assertForeground 的规则一致）：
   相互包含，或前 10 个字符相同 —— 因为 "无标题 - 记事本" 与 "记事本" 是同一个窗口 */
function titleMatches(a, b) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return false;
  return x.indexOf(y) >= 0 || y.indexOf(x) >= 0 || x.slice(0, 10) === y.slice(0, 10);
}
function rectOf(w) { return { x: w.x, y: w.y, w: w.w, h: w.h }; }
function areaOf(w) { return Math.max(0, Number(w.w) || 0) * Math.max(0, Number(w.h) || 0); }
function inRect(x, y, w) { return x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h; }

/* 这个窗口"真的在屏幕上吗" —— 照 occlusion.js 的判据：
   visible=否 的（UWP 幽灵窗/隐藏宿主）不算；cloaked=是 的（DWM 合成器隐藏：UWP 挂起、
   别的虚拟桌面、刚关掉的 Edge）不算；最小化不算。
   ★实测（今天真机）：点 (1860,662) 时矩形含它的窗口有 6 个，但
     「任务切换」cloaked=是、「Windows 输入体验」cloaked=是、
     「[CustomNotification]CustomNotificationView」visible=否 —— 全部被这三条剔掉 ✓，
     只剩真正在屏幕上的「明日方舟」✓。不加这三条就会把全屏幽灵窗当遮挡者，谁都点不了 ✗。 */
function onScreen(w, o) {
  if (!w) return false;
  if (w.visible === false) return false;
  if (w.cloaked) return false;
  if (w.iconic) return false;
  if (SKIP_TITLES.indexOf(normTitle(w.title)) >= 0) return false;
  if ((Number(w.w) || 0) < o.minW || (Number(w.h) || 0) < o.minH) return false;
  return true;
}
function isSelf(w, opts) {
  const o = opts || {};
  const pids = o.selfPids || [];
  if (pids.length && pids.indexOf(Number(w.pid)) >= 0) return true;
  const hints = o.selfHints || SELF_HINTS;
  const t = normTitle(w.title);
  return hints.some((h) => t.toLowerCase().indexOf(String(h).toLowerCase()) >= 0);
}
function isPanelTitle(t) {
  const s = normTitle(t).toLowerCase();
  return PANEL_HINTS.some((h) => s.indexOf(String(h).toLowerCase()) >= 0);
}

/* 目标点上"按 z 序从上到下"的可见窗口（z 越小越靠上；focuswin 用 EnumWindows，
   枚举顺序就是 z 序顶部→底部 ✓） */
function stackAt(x, y, windows, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  return (windows || [])
    .filter((w) => onScreen(w, o) && inRect(x, y, w))
    .sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0));
}

/* ★纯判定★：不碰 IO，windows 由调用方给（单测直接喂假数据）。
 * 返回 { ok, blocked, reason, blocker, top, below, bright, expected, notes }
 *   reason 取值（都进回执）：
 *     target-under-own-window     —— 我自己的桌宠窗 / DSH 窗压着
 *     target-not-expected-window  —— 最上面那个不是预期窗口
 *     target-covered-by-flyout    —— 飞框/系统面板压着（标题特征，或"小面板压在大应用上"）
 *     target-covered-by-light-panel —— 亮像素比例异常高（浅色面板）
 *   ok=true 且 undetermined=true → 这一点上没有已登记的可见窗口（可能点在桌面空白上） */
function decide(x, y, windows, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const notes = [];
  const stack = stackAt(x, y, windows, o);
  const top = stack[0] || null;
  const below = stack.slice(1);
  const out = {
    point: { x, y }, top: top ? { title: top.title, pid: top.pid, z: top.z, rect: rectOf(top) } : null,
    below: below.slice(0, 4).map((w) => ({ title: w.title, z: w.z, rect: rectOf(w) })),
    stackSize: stack.length, bright: null, expected: o.expectTitle || null, notes,
    ok: true, blocked: false, reason: null, blocker: null,
  };

  /* ⓪a ★★任务栏铁律（今天的头号坑）★★
     ★实测：点任务栏右下角的时间 → 弹出"日历/时钟"飞框 → 它盖住整个右边缘，
       之后点什么都像"没反应"（screen_diff 全 0.0x%），而我还以为坐标不准 ✗。
       她今天就是这么栽的：一发点在 1810,833（任务栏上），飞框从那时候起一直开着。★
     ⚠️ 任务栏窗口没有标题（Shell_TrayWnd），窗口枚举里根本看不到它 ——
        所以这条**不能靠窗口列表**，必须由调用方把 taskbarTop 传进来（见 assistant.envCheckOpts）。 */
  if (o.taskbarTop != null && Number(y) >= Number(o.taskbarTop)) {
    out.ok = false; out.blocked = true; out.reason = 'point-on-taskbar';
    out.blocker = { title: 'Windows 任务栏（它在窗口列表里没有标题，所以不是"某个窗口"）',
      rect: { x: 0, y: Number(o.taskbarTop), w: Number(o.screenW) || 0, h: (Number(o.screenH) || 0) - Number(o.taskbarTop) } };
    notes.push('★这一点在任务栏上（y≥' + o.taskbarTop + '）★ —— 点任务栏（尤其右下角的时间）会弹出日历飞框，'
      + '它会盖住整个右边缘，之后点什么都像"没反应"。今天的坑就是这么来的，所以我不点。');
    return out;
  }

  /* ⓪ 空：这一点上没有已登记的可见窗口。可能点在桌面空白上 —— 如实报，不拦（桌面也是合法目标）。 */
  if (!top) { out.undetermined = true; notes.push('这一点上没有已登记的可见窗口（可能是桌面空白）'); return out; }

  /* ① 自己的窗口 / DSH 的窗口 ★永远拦★ */
  if (isSelf(top, o)) {
    out.ok = false; out.blocked = true; out.reason = 'target-under-own-window'; out.blocker = out.top;
    notes.push('★最上面那个是我自己/DSH 的窗口★（' + top.title + '），点下去只会点在自己身上');
    return out;
  }

  /* ② 有预期窗口时：最上面那个必须就是它 */
  if (o.expectTitle) {
    if (!titleMatches(top.title, o.expectTitle)) {
      const why = isPanelTitle(top.title)
        ? '★它是个飞框/系统面板★（' + top.title + '）'
        : '最上面那个不是「' + o.expectTitle + '」，而是「' + top.title + '」';
      out.ok = false; out.blocked = true; out.reason = 'target-covered-by-flyout'; out.blocker = out.top;
      notes.push(why + ' —— 压在我的目标窗口上面');
      return out;
    }
    out.expected = { title: o.expectTitle, matched: true };
  } else if (isPanelTitle(top.title)) {
    /* ③ 没有预期窗口时的"飞框特征"第一判据：标题 */
    out.ok = false; out.blocked = true; out.reason = 'target-covered-by-flyout'; out.blocker = out.top;
    notes.push('★标题像飞框/系统面板★（' + top.title + '）压在这一点的最上面');
    return out;
  }

  /* ④ 没有预期窗口时的"飞框特征"第二判据：它是小面板，底下还压着一个大得多的窗口。
     实测：日历飞框 ~350x420 悬在游戏（1920x1080）右下角之上 —— 这种形状就是飞框 ✓ */
  if (!o.expectTitle) {
    const screenArea = Number(o.screenW) && Number(o.screenH) ? o.screenW * o.screenH : 0;
    const topA = areaOf(top);
    const small = (screenArea ? (topA / screenArea) < o.panelAreaRatio : true)
      && below.some((b) => areaOf(b) >= topA * o.overAreaRatio);
    if (small) {
      out.ok = false; out.blocked = true; out.reason = 'target-covered-by-flyout'; out.blocker = out.top;
      notes.push('★小面板压在大窗口上★（' + top.title + ' ' + top.w + 'x' + top.h
        + '，底下是「' + (below[0] && below[0].title) + '」）—— 形状就是飞框');
      return out;
    }
  }
  notes.push('目标点上最上面的是「' + top.title + '」' + (isPanelTitle(top.title) ? '（标题像面板，但窗口判定通过了）' : ''));
  return out;
}

/* ★亮像素比例★（纯计算，吃 BGRA buffer，和 framediff 同一套取图约定）
 * 为什么是"亮"而不是"变"：飞框（日历）是**浅色面板**，压在深色游戏上 →
 * 实测该区域亮像素 ~40%，关掉之后 0.7%。这是**不需要认识内容**就能抓到的特征 ✓ */
function brightRatio(bgra, w, h, rect, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  if (!bgra || !w || !h) return null;
  const x0 = Math.max(0, Math.min(w - 1, Math.round(rect.x)));
  const y0 = Math.max(0, Math.min(h - 1, Math.round(rect.y)));
  const x1 = Math.max(x0 + 1, Math.min(w, Math.round(rect.x + rect.w)));
  const y1 = Math.max(y0 + 1, Math.min(h, Math.round(rect.y + rect.h)));
  let bright = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * w + x) * 4;                      // BGRA
      const lum = 0.114 * bgra[p] + 0.587 * bgra[p + 1] + 0.299 * bgra[p + 2];
      if (lum > o.brightLum) bright++;
      total++;
    }
  }
  return total ? { ratio: Math.round(bright / total * 10000) / 10000, brightPixels: bright, total, region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } } : null;
}

/* 把"点周围 region x region"换算成图上的矩形（图尺寸可能与坐标空间不同 → 按比例换算） */
function regionAround(x, y, imgW, imgH, spaceW, spaceH, region) {
  const r = Number(region) > 0 ? Number(region) : DEFAULTS.region;
  const kx = (Number(imgW) || 0) / ((Number(spaceW) || 0) || (Number(imgW) || 1));
  const ky = (Number(imgH) || 0) / ((Number(spaceH) || 0) || (Number(imgH) || 1));
  const cx = x * kx, cy = y * ky;
  return { x: Math.round(cx - r * kx / 2), y: Math.round(cy - r * ky / 2), w: Math.round(r * kx), h: Math.round(r * ky) };
}

/* ---------------- 主人是不是正在用鼠标（特性，不是 bug）----------------
 * 实测：主人手在鼠标上 → 9/9 cursor=FAIL；手拿开 → 9/9 cursor=OK。
 * `src/userinput.js` 早就在做这件事（游戏助手一直在用），这里只负责"问一句"。
 * ⚠️ userinput 顶层 require('electron') → 纯 Node 下拿不到，返回 available:false（不误判）。 */
function userBusy() {
  try {
    const ui = require('./userinput');
    if (typeof ui.isUserActive !== 'function') return { available: false, active: false };
    return { available: true, active: !!ui.isUserActive(), msSinceUser: (ui.state() || {}).msSinceUser };
  } catch (e) { return { available: false, active: false, error: String((e && e.message) || e) }; }
}

/* ---------------- 一站式：取窗口 → 判定 → （可选）抓帧量亮比例 ---------------- */
/* opts:
 *   windows     已经取好的窗口列表（不传就自己取，纯 Node 下 focuswin 走 PowerShell ✓）
 *   expectTitle 预期窗口的标题片段（有它时判据最强）
 *   selfPids    自己进程的 pid（桌宠主进程传 [process.pid]）
 *   grab        async () => { bgra, w, h } —— 抓一帧；不传就跳过亮像素检查
 *   spaceW/H    坐标空间（默认取 input.space()，拿不到就按图尺寸 1:1）
 *   brightMax   亮像素比例上限（默认 0.20）
 *   skipUser    跳过我是否在操作鼠标那一问
 */
async function checkPoint(x, y, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  let windows = o.windows;
  if (!windows) {
    const l = await fw.listWindows();
    if (l && l.ok === false) {
      return { ok: true, undetermined: true, reason: null,
        note: '窗口列表读不到（' + (l.error || '未知原因') + '），这一次跳过环境检查 —— 不假装干净，也不无凭据地拦。',
        enumerationFailed: true };
    }
    windows = (l && l.windows) || [];
  }
  const dec = decide(x, y, windows, o);
  /* 亮像素：只在"窗口判定没拦"时算（拦了就不必再抓帧，省一次抓图） */
  if (!dec.blocked && typeof o.grab === 'function') {
    try {
      const f = await o.grab();
      if (f && f.bgra && f.w && f.h) {
        let sw = Number(o.spaceW), sh = Number(o.spaceH);
        if (!sw || !sh) { try { const s = require('./input').space(); sw = s.w; sh = s.h; } catch (e) { sw = f.w; sh = f.h; } }
        const rect = regionAround(x, y, f.w, f.h, sw, sh, o.region);
        const b = brightRatio(f.bgra, f.w, f.h, rect, o);
        dec.bright = b;
        /* ★只有当"窗口身份"给不出正面证据时才用亮度判★
           （否则白底应用里的正常白像素会被误判成"浅色面板"） */
        const identityOk = !!(o.expectTitle && titleMatches((dec.top && dec.top.title) || '', o.expectTitle));
        if (b && b.ratio > o.brightMax && !identityOk) {
          dec.ok = false; dec.blocked = true; dec.reason = 'target-covered-by-light-panel';
          dec.blocker = dec.top;
          dec.notes.push('★这一点周围 ' + rect.w + 'x' + rect.h + ' 的亮像素比例 ' + (b.ratio * 100).toFixed(1)
            + '% > ' + (o.brightMax * 100).toFixed(0) + '%★ —— 有浅色面板（飞框/对话框）压在上面');
        } else if (b && b.ratio > o.brightMax && identityOk) {
          dec.notes.push('（亮像素比例 ' + (b.ratio * 100).toFixed(1) + '% 偏高，但最上面确实是预期窗口「'
            + dec.top.title + '」，判为它自己的浅色区域，不拦）');
        }
      } else {
        dec.notes.push('抓帧没成功，这一次只做了窗口判定');
      }
    } catch (e) { dec.notes.push('抓帧出错（' + String((e && e.message) || e) + '），只做了窗口判定'); }
  }
  /* 主人是不是在动鼠标（问一句，放进环境报告 —— 回执要能说准"为什么没成"） */
  if (!o.skipUser) dec.user = userBusy();
  if (!dec.blocked) dec.ok = true;
  return dec;
}

/* 把"屏幕工作区"换算成坐标空间里的**任务栏上边缘**。
 * 为什么要有它：任务栏（Shell_TrayWnd）没有标题 → 窗口枚举里看不到它 →
 * "这一点上压着谁"永远查不到它 ✗，而它恰恰是今天弹出日历飞框的元凶（右下角时间）。
 * 屏幕尺寸 vs 工作区尺寸的差 = 任务栏占的高度（DIP）→ 按比例换到坐标空间。
 * 任务栏自动隐藏时两者相等 → 返回空间高度（等于不拦）✓ */
function taskbarTopOf(display, spaceH) {
  try {
    const h = Number(spaceH) || 1080;
    if (!display || !display.size || !display.workAreaSize) return null;
    const dh = Number(display.size.height) || 0;
    const wh = Number(display.workAreaSize.height) || 0;
    if (!dh || wh >= dh) return null;              // 没有任务栏（或自动隐藏）→ 不判
    return Math.round(wh / dh * h);
  } catch (e) { return null; }
}

module.exports = {
  checkPoint, decide, brightRatio, regionAround, stackAt, onScreen, isSelf, isPanelTitle,
  titleMatches, userBusy, taskbarTopOf,
  SKIP_TITLES, SELF_HINTS, PANEL_HINTS, DEFAULTS,
};
