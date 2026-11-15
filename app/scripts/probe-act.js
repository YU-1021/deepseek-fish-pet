/* probe-act.js —— ★一次只做一个动作的"手"（在 Electron 里跑 ✓ 因为 input.js 需要它）★
 *
 * 用法（Start-Process，无可见窗口 ✓）：
 *   electron.exe <repo>\app\scripts\probe-act.js -- key=ESC
 *   electron.exe <repo>\app\scripts\probe-act.js -- click=1624,1020
 * 结果写 C:\deepseek\livetest\act-result.txt（★不走 stdout ✓ 沙箱不给管道 ✓）
 *
 * ★安全★：它只做**你明确给的那一个动作** ✓，没有任何自动决策 ✓；
 *   决策全在外面（ownclick 的 panel_state / find_owned / click_checked ✓）。
 */
'use strict';
const fs = require('fs');
const OUT = 'C:/deepseek/livetest/act-result.txt';
const args = process.argv.slice(2).filter((a) => a.indexOf('=') > 0);
const kv = {};
for (const a of args) { const i = a.indexOf('='); kv[a.slice(0, i).toLowerCase()] = a.slice(i + 1); }
function say(s) { try { fs.appendFileSync(OUT, String(s) + '\n'); } catch (e) {} }
fs.writeFileSync(OUT, '');

const el = require('electron');
const { app } = el;
if (!app) { say('ERR no electron app'); process.exit(1); }
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const input = require('../src/input');
    if (kv.key) {
      const k = await input.key(kv.key);
      say('key ' + kv.key + ' -> ' + JSON.stringify(k || 'ok'));
    } else if (kv.click) {
      const [x, y] = kv.click.split(',').map((v) => Number(String(v).trim()));
      if (!Number.isFinite(x) || !Number.isFinite(y)) { say('ERR bad click coords'); app.exit(1); return; }
      const r = await input.click(x, y);
      say('click ' + x + ',' + y + ' -> ' + JSON.stringify(r || 'ok'));
    } else { say('ERR nothing to do（要 key= 或 click= ✓）'); app.exit(1); return; }
    setTimeout(() => app.exit(0), 600);
  } catch (e) { say('ERR ' + (e && e.stack || e)); app.exit(1); }
});
