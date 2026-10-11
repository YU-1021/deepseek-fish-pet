const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const file = () => path.join(app.getPath('userData'), 'mood.json');
const DEFAULTS = { affection: 30, mood: 70, pokes: 0, lastSeen: Date.now() };
/* clamp 必须自己吃掉 NaN：以前 mood.json 里出现非数字（手改、旧版本写坏）时
   clamp(NaN) = NaN → 落盘成 null → 好感度被静默归零，还会以 "Affection: 0/100" 进提示词。 */
const clamp = (v) => Math.max(0, Math.min(100, Math.round(Number.isFinite(Number(v)) ? Number(v) : 0)));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function raw() {
  try {
    const o = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^\uFEFF/, '')) || {};
    return {
      affection: num(o.affection, DEFAULTS.affection),
      mood: num(o.mood, DEFAULTS.mood),
      pokes: num(o.pokes, 0),
      lastSeen: num(o.lastSeen, Date.now()),
    };
  } catch { return { ...DEFAULTS }; }
}
function save(m) { try { fs.writeFileSync(file(), JSON.stringify(m, null, 2)); } catch {} }
function load() { return raw(); }

// 启动时按离线时长衰减心情（每小时 -2，最多 -30）
function startupDecay() {
  const m = raw();
  const hours = Math.max(0, (Date.now() - (m.lastSeen || Date.now())) / 3600000);
  if (hours > 0.02) m.mood = clamp(m.mood - Math.min(30, hours * 2));
  m.pokes = 0;
  m.lastSeen = Date.now();
  save(m);
  return m;
}

function adjust(d = {}) {
  const m = raw();
  m.affection = clamp(m.affection + num((d || {}).affection, 0));
  m.mood = clamp(m.mood + num((d || {}).mood, 0));
  m.lastSeen = Date.now();
  save(m);
  return m;
}

module.exports = { load, save, adjust, startupDecay };
