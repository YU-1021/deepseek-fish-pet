/* 提醒 / 日历（B3）—— 她完全没有时间能力
 *
 * 【为什么需要】她现在的"时间感"只有"现在几点"，没有"过一会儿提醒我" ✗。
 *   实测主人说过"三十分钟后提醒我"，她只能回答"我记不住" ✓。
 *
 * 【设计取舍】
 *   · 只做"一次性提醒"（不是完整日历/重复日程）—— 够用，而且边界清楚 ✓
 *   · ★提醒落盘★（%APPDATA%/dayu-pet/reminders.json）：
 *     她是 Electron 应用，会热重载/重启；只放内存里的话重启就全丢了 ✗
 *   · 时间用**绝对时间戳**存 ✓（存"还有多少分钟"在重启后会算错 ✗）
 *   · 到点通过回调交回宿主（main.js）去说给她听 —— 模块本身不管提示方式 ✓
 *   · 过期太久的（超过 24 小时）标记为过期而不是疯狂补报 ✓（重启后一次性弹十几条很糟）
 */
'use strict';

const fs = require('fs');
const path = require('path');

let storeFile = null;
let items = [];           // { id, at, text, fired, createdAt }
let timer = null;
let onFire = null;        // (item) => void
let seq = 0;

function init(opts) {
  const o = opts || {};
  onFire = o.onFire || null;
  storeFile = o.file || null;
  load();
  arm();
  return status();
}

function load() {
  if (!storeFile) return;
  try {
    const j = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    items = Array.isArray(j.items) ? j.items : [];
    seq = Number(j.seq) || items.length;
  } catch (e) { items = []; }
}
function save() {
  if (!storeFile) return;
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify({ seq, items }, null, 0), 'utf8');
  } catch (e) {}
}

function newId() { seq += 1; return 'r' + seq; }

/* 下一个要响的时间到了就叫醒自己 */
function arm() {
  if (timer) { clearTimeout(timer); timer = null; }
  const pend = items.filter((x) => !x.fired).sort((a, b) => a.at - b.at);
  if (!pend.length) return;
  const next = pend[0];
  const wait = Math.max(0, Math.min(2147000000, next.at - Date.now()));
  timer = setTimeout(tick, wait);
  if (timer.unref) timer.unref();
}

function tick() {
  const now = Date.now();
  const due = items.filter((x) => !x.fired && x.at <= now);
  let fired = 0;
  for (const it of due) {
    it.fired = true;
    /* ★ 过期太久的不要补报 ★ —— 重启后一次性弹十几条历史提醒会把主人烦死 ✓ */
    const late = now - it.at;
    if (late <= 24 * 3600 * 1000) {
      fired++;
      try { if (onFire) onFire(it); } catch (e) {}
    } else {
      it.skipped = '过期超过 24 小时，不再补报';
    }
  }
  if (due.length) save();
  /* 清掉已经响过且超过 3 天的，别让文件无限长 */
  items = items.filter((x) => !(x.fired && (now - x.at) > 3 * 24 * 3600 * 1000));
  save();
  arm();
  return fired;
}

/* 相对时间：N 分钟/小时后 */
function inMinutes(min, text) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return { ok: false, error: '分钟数要是一个正数' };
  if (m > 60 * 24 * 30) return { ok: false, error: '太远了（最多 30 天）—— 这么远的提醒不如到时候再说' };
  const at = Date.now() + Math.round(m * 60000);
  const it = { id: newId(), at, text: String(text || '').slice(0, 300), fired: false, createdAt: Date.now() };
  items.push(it); save(); arm();
  return { ok: true, item: it };
}

/* 绝对时间：今天/明天的 HH:MM */
function atClock(hhmm, text) {
  const m = String(hhmm || '').trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
  if (!m) return { ok: false, error: '时间格式要像 14:30 或 9:05' };
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return { ok: false, error: '时间不合法（小时 0-23、分钟 0-59）' };
  const d = new Date();
  d.setHours(h, mi, 0, 0);
  let at = d.getTime();
  if (at <= Date.now()) at += 24 * 3600 * 1000;      // 今天过了就是明天 ✓
  const it = { id: newId(), at, text: String(text || '').slice(0, 300), fired: false, createdAt: Date.now() };
  items.push(it); save(); arm();
  return { ok: true, item: it };
}

function list() {
  const now = Date.now();
  return items.filter((x) => !x.fired).sort((a, b) => a.at - b.at)
    .map((x) => ({ id: x.id, at: x.at, inMin: Math.round((x.at - now) / 60000), text: x.text }));
}

function cancel(id) {
  const k = String(id || '').trim();
  const i = items.findIndex((x) => x.id === k);
  if (i < 0) return { ok: false, error: '没有编号为 ' + k + ' 的提醒（可以用 remind_list 看有哪些）' };
  const it = items.splice(i, 1)[0];
  save(); arm();
  return { ok: true, item: it };
}

function status() {
  const pend = items.filter((x) => !x.fired);
  return { pending: pend.length, fired: items.filter((x) => x.fired).length, armed: !!timer };
}

module.exports = { init, inMinutes, atClock, list, cancel, status, tick };
