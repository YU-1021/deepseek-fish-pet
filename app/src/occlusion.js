/* occlusion.js —— 遮挡模型：回答"我看到的这块像素到底属于谁"
 *
 * ============================ 为什么必须有它 ============================
 * 实测事故（2026-10-03）：截图是【屏幕像素】，不是"窗口像素"——
 *   **被遮挡的部分根本没有被捕获**，捕获到的是【遮挡者的像素】。
 * 而当时的代码按"目标窗口矩形"过滤 OCR 词 → 于是把我自己窗口里的
 * "水月 / 阿 / 温蒂" 等等，当成了浏览器页面里的卡片名字 ✗，
 * 我据此把鼠标移到了错误的位置，还宣布了成功 ✗。
 *
 * 关键教训有两条：
 *   ① 过滤必须看【z 序】，不能只看"矩形是否重叠" —— 压在下面的自己不算遮挡者
 *   ② "我自己进程的窗口"必须【动态取】，不能硬编码位置（窗口会移动）
 *
 * ============================ 本模块提供 ============================
 *   纯逻辑（可单测）：intersects / pointCovered / filterWords / computeCovered
 *   场景组装（需要窗口枚举）：scene()
 */
'use strict';

const fw = require('./focuswin');

/* ---------------- 纯逻辑 ---------------- */
function intersects(a, b, margin) {
  if (!a || !b) return false;
  const m = margin == null ? 0 : margin;
  return a.x < b.x + b.w + m && a.x + a.w + m > b.x && a.y < b.y + b.h + m && a.y + a.h + m > b.y;
}

function pointCovered(x, y, rects) {
  if (!rects || !rects.length) return null;
  for (const r of rects) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
  return null;
}

/* 过滤识别结果：词框的【中心】落在任一被覆盖矩形内 → 丢弃 */
function filterWords(words, coveredRects) {
  if (!coveredRects || !coveredRects.length) return { kept: words.slice(), dropped: [] };
  const kept = [], dropped = [];
  for (const w of words) {
    const cx = w.x + (w.w || 0) / 2, cy = w.y + (w.h || 0) / 2;
    const hit = pointCovered(cx, cy, coveredRects);
    if (hit) dropped.push(Object.assign({}, w, { coveredBy: hit.title || '(未知窗口)' }));
    else kept.push(w);
  }
  return { kept, dropped };
}

/* 计算"压在目标窗口之上的窗口"—— 这是本模块的核心判据
 *   above = 与目标相交 且 （置顶 或 z 序比目标更靠前）
 *   ⚠️ 只看矩形不看 z 会把压在下面的自己也算成遮挡者（我第一版就错）
 */
function computeCovered(target, allWindows, extraRects) {
  const out = [];
  if (!target) return out;
  for (const w of (allWindows || [])) {
    if (!w || w.hwnd === target.hwnd) continue;
    if (w.visible === false) continue;                        // ★ 隐藏的窗口不是遮挡者（实测误报过 100% 遮盖）★
    if (w.w < 24 || w.h < 24) continue;                       // 忽略托盘/指示器之类的小窗口
    if (!intersects({ x: w.x, y: w.y, w: w.w, h: w.h }, target, -2)) continue;
    const aboveByZ = (w.z != null && target.z != null) ? (w.z < target.z) : false;
    const aboveByTop = !!w.topmost;
    if (aboveByZ || aboveByTop) {
      out.push({ x: w.x, y: w.y, w: w.w, h: w.h, title: w.title, hwnd: w.hwnd, topmost: !!w.topmost, z: w.z });
    }
  }
  for (const r of (extraRects || [])) {
    if (r && intersects(r, target, -2)) out.push(Object.assign({ title: '(自己的窗口)' }, r));
  }
  return out;
}

/* ---------------- 场景组装 ---------------- */
/* opts = { targetTitle?, selfPids?: number[], selfTitles?: string[] }
 * 返回 { ok, list, target, covered, usable, foreground }
 *   covered = 压在目标之上的窗口矩形（识别结果里落在这里的一律丢弃）
 *   usable  = !ok 时为 null；否则给调用方的提示（目标有没有被挡）
 */
async function scene(opts) {
  const o = opts || {};
  const list = await fw.listWindows();
  /* ★ 同上：列窗口失败不能当成"没有遮挡" ★
     否则会得出"目标干净可见"的结论，而真相是根本没读到窗口列表。 */
  if (list.ok === false) {
    return { ok: false, reason: 'window-enumeration-failed', error: list.error, covered: [], selfRects: [] };
  }
  const wins = list.windows || [];
  const selfPids = o.selfPids || [process.pid];
  const selfTitles = o.selfTitles || [];

  /* 自己进程的窗口：动态取，绝不硬编码位置 */
  const selfRects = wins
    .filter((w) => (selfPids.indexOf(w.pid) >= 0 || selfTitles.some((t) => w.title.indexOf(t) >= 0)) && w.w > 40 && w.h > 40)
    .map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h, title: w.title, hwnd: w.hwnd, z: w.z, topmost: !!w.topmost }));

  let target = null;
  if (o.targetTitle) {
    const cands = wins.filter((w) => w.title.indexOf(o.targetTitle) >= 0);
    target = cands.find((w) => w.hwnd === list.foregroundHwnd)
      || cands.filter((w) => w.visible !== false && !w.iconic).sort((a, b) => b.w * b.h - a.w * a.h)[0]
      || cands.sort((a, b) => b.w * b.h - a.w * a.h)[0] || null;
  }
  if (!target) return { ok: false, reason: 'no-target', list, selfRects, foreground: list.foregroundTitle };

  const rect = { x: target.x, y: target.y, w: target.w, h: target.h };
  const covered = computeCovered(Object.assign({ hwnd: target.hwnd, z: target.z }, rect), wins, selfRects);
  /* ⚠️ 不要把各遮挡窗口的面积【累加】—— 它们互相重叠，累加会算出 >100%（实测 1354%）✗
     改报"最大的那一个占目标的多少"，并加一句"可能有重叠"的说明。 */
  const maxArea = covered.reduce((m, r) => Math.max(m, Math.min(r.w, rect.w) * Math.min(r.h, rect.h)), 0);
  return {
    ok: true, list, target: Object.assign({}, target, rect), selfRects, covered,
    coveredRatio: Math.round((Math.min(maxArea, rect.w * rect.h) / Math.max(1, rect.w * rect.h)) * 100) / 100,
    coveredNote: covered.length ? '有 ' + covered.length + ' 个窗口压在上面（比例只取最大单个，未累加）' : '没有窗口压在上面',
    foreground: list.foregroundTitle,
    isForeground: target.hwnd === list.foregroundHwnd,
  };
}

module.exports = { intersects, pointCovered, filterWords, computeCovered, scene };
