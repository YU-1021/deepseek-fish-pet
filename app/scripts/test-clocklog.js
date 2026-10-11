/* 验证：时钟被平移时，日志的时间戳仍记**真实墙钟**
 * 背景：clock.js 劫持 Date.now() 做跨天测试，导致 testlog 的 t 字段也带上偏移，
 *   看起来落在"未来"→ audit-logs.js --since 完全筛不动（实测踩到）。
 * electron.exe app\scripts\test-clocklog.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-clocklog');
fs.mkdirSync(TEST_UD, { recursive: true });
try { fs.unlinkSync(path.join(TEST_UD, 'clock-offset.json')); } catch {}
try { fs.unlinkSync(path.join(TEST_UD, 'testlog.jsonl')); } catch {}
app.setPath('userData', TEST_UD);

app.whenReady().then(() => {
  const clock = require('../src/clock');
  const testlog = require('../src/testlog');
  const out = [];
  const L = (s) => out.push(s);
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  const realNow = Date.now();
  try {
    testlog.clear();
    /* 1. 不偏移时：t 和 td 应该一致 */
    testlog.log('probe', 'noShift', { v: 1 });
    let last = JSON.parse(fs.readFileSync(testlog.logFile(), 'utf8').trim().split('\n').pop());
    check('不偏移时 t≈真实时间', Math.abs(last.t - realNow) < 5000, 'Δ=' + (last.t - realNow) + 'ms');
    check('不偏移时 t≈td', Math.abs(last.t - last.td) < 5000, 'Δ=' + (last.t - last.td) + 'ms');

    /* 2. 平移 2 天后再记：t 必须还是真实时间，td 应该大 2 天 */
    clock.set({ days: 2 });
    const shiftedNow = Date.now();
    testlog.log('probe', 'shifted', { v: 2 });
    last = JSON.parse(fs.readFileSync(testlog.logFile(), 'utf8').trim().split('\n').pop());
    check('日期确实被平移了 2 天', clock.day() !== new Date().toISOString().slice(0, 10), clock.day());
    check('平移后 td 跟上（+2 天）', Math.abs((last.td - realNow) - 2 * 86400000) < 10000, 'Δtd=' + Math.round((last.td - realNow) / 86400000 * 100) / 100 + ' 天');
    check('★ 平移后 t 仍是**真实墙钟**', Math.abs(last.t - realNow) < 5000, 'Δ=' + Math.round((last.t - realNow) / 1000) + 's（若接近 2 天就是坏的）');
    check('t 不会跑到未来', last.t <= Date.now() + 1000 || last.t <= realNow + 1000, 't-now=' + Math.round((last.t - realNow) / 1000) + 's');

    /* 3. 耗时用单调钟：跨平移也不该出现天文数字 */
    const t0 = Date.now();
    const before = clock.offset();
    clock.set({ days: 5 });                 // 注意：set 是"设置"不是"累加"，此刻偏移从 2 天变 5 天
    const fakeDuration = Date.now() - t0;   // 这就是"用 Date.now 算耗时"的坏例子
    const jumped = clock.offset() - before;
    check('（对照）用 Date.now 算耗时会虚增', fakeDuration >= jumped - 1000,
      '虚增 ' + Math.round(fakeDuration / 86400000 * 100) / 100 + ' 天（本次时钟跳了 '
      + Math.round(jumped / 86400000) + ' 天）—— 所以 testlog/projects 改用 performance.now()');

    clock.clear();
    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
