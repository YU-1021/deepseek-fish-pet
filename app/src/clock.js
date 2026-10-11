/* 统一时钟 —— 让"跨天"测试不必改系统时间
 *
 * 为什么需要：日记按天写、长期记忆的衰减/晋升也按天算，
 * 而"连聊 5 天会长成什么样"不可能真等 5 天；改系统时间又会连带影响别的程序。
 *
 * 做法：**劫持 Date.now()**（而不是去改 3 个模块里的每一处日期计算）。
 *   · 覆盖彻底：所有用 Date.now() 做日期/时长的代码自动受影响，不会漏
 *   · 安全：偏移在整个运行期间是常量，所以 `t1 = Date.now(); t1 - t0` 这类时长计算不受影响
 *   · 容易复原：偏移量存在单独的文件里（不污染 config.json），删掉文件就完全回到系统时间
 *   · 默认偏移 0 → 行为与没有这个模块时**完全一致**
 *
 * 注意：`new Date()`（不带参数）走的是系统时钟，不受影响 —— 这是故意的：
 *   testlog/debug 的时间戳保持真实时间，方便对照分析。
 *
 * ⚠️ 用 Date.now() 做**耗时测量**或**记录日志时间戳**的地方会受影响（三个真实踩到的坑）：
 *   1. 跨天那一瞬间正在跑的调用，算出来是 +86400000ms 的假耗时
 *      → testlog / projects.run 已改用单调时钟 performance.now()
 *   2. 日志条目如果记 Date.now() 会带上偏移、按时间窗审计就筛不动
 *      → testlog 的 t 字段改用 new Date().getTime()（真实墙钟），另存 td 供对照
 *   3. dsh.js 拿 Date.now() 去比**文件 mtime**（真实时钟）→ 测试里会误判"很久没同步"
 *      （生产环境偏移恒为 0，无影响）
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const file = () => path.join(app.getPath('userData'), 'clock-offset.json');
const REAL_NOW = Date.now;
let offsetMs = 0;

function loadOffset() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^\uFEFF/, ''));
    offsetMs = Number(j && j.offsetMs) || 0;
  } catch { offsetMs = 0; }
  return offsetMs;
}
loadOffset();

/* 只在有偏移时替换，避免无谓地动全局函数 */
const realNow = Date.now.bind(Date);
if (offsetMs) Date.now = () => realNow() + offsetMs;
else Date.now = () => realNow();

/** 当前（可能被平移过的）毫秒时间戳 */
const now = () => Date.now();
/** 当前（可能被平移过的）日期 YYYY-MM-DD */
const day = (ts) => {
  const d = new Date(ts == null ? Date.now() : ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};
const offset = () => offsetMs;
/** 设置偏移（毫秒，或 {days}）。传 0 / null 清除 */
function set(v) {
  let ms = 0;
  if (v && typeof v === 'object') ms = (Number(v.days) || 0) * 86400000 + (Number(v.ms) || 0);
  else ms = Number(v) || 0;
  offsetMs = ms;
  try {
    if (!ms) { try { fs.unlinkSync(file()); } catch {} }
    else fs.writeFileSync(file(), JSON.stringify({ offsetMs: ms, setAt: REAL_NOW(), note: '测试用时钟偏移，删掉本文件即恢复系统时间' }, null, 2));
  } catch {}
  Date.now = ms ? () => realNow() + ms : () => realNow();
  return { offsetMs: ms, day: day() };
}
function clear() { return set(0); }

module.exports = { now, day, offset, set, clear, file, realNow };
