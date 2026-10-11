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

/* ---------------- 带断言的动作 ---------------- */
/* input 是懒加载的：这样纯逻辑测试（不碰键鼠）也能 require 本模块 */
function getInput() { return require('./input'); }

async function clickSafe(x, y, opts) {
  const o = opts || {};
  const out = { action: 'click', point: { x, y } };
  /* ① 前台 */
  if (o.expectForeground) {
    const f = await ensureForeground(o.expectForeground, o);
    out.foreground = f;
    if (!f.ok) return Object.assign(out, { ok: false, blocked: true, reason: f.reason });
  }
  /* ② 位置 */
  if (o.windowRect) {
    const p = pointInRect(x, y, o.windowRect, o.margin);
    out.inWindow = p;
    if (!p.ok) return Object.assign(out, { ok: false, blocked: true, reason: 'point-outside-target-window' });
  }
  /* ③ 动作 */
  out.result = await getInput().click(x, y);
  /* ★ click 也会把光标移过去，所以同样回读 ★ */
  const pos = await fw.cursorPos();
  out.cursorAfter = pos;
  const cm = cursorMatches({ x, y }, pos, o.tolerance);
  out.cursorVerified = cm.ok;
  out.cursorDelta = { dx: cm.dx, dy: cm.dy };
  /* 点击本身不该因为光标没到位就判失败（可能点中了但光标被系统挪走），只记录 */
  out.ok = true;
  return out;
}

async function moveSafe(x, y, opts) {
  const o = opts || {};
  const out = { action: 'move', point: { x, y } };
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
  out.result = await getInput().move(x, y);
  /* ★ 效果断言：回读光标真值 ★ */
  const pos = await fw.cursorPos();
  out.cursorAfter = pos;
  const cm = cursorMatches({ x, y }, pos, o.tolerance);
  out.verified = cm.ok;
  out.delta = { dx: cm.dx, dy: cm.dy };
  if (!cm.ok) {
    return Object.assign(out, { ok: false, reason: 'cursor-did-not-reach-target',
      note: '命令返回了成功，但回读 GetCursorPos 发现光标在 (' + (pos ? pos.x + ',' + pos.y : '未知') + ')，'
        + '与目标相差 ' + cm.dx + '/' + cm.dy + ' 像素 —— 这就是"假成功"。' });
  }
  out.ok = true;
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
  const reallyShown = (w) => w.visible !== false && !w.cloaked && !w.iconic;
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
  _internals: { pointInRect },
};
