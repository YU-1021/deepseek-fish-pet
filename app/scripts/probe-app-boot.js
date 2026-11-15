/* probe-app-boot.js —— ★她的 app（仓库 main.js）能不能起来？带/不带 --no-sandbox 各一次★
 *
 * 背景（lead 的发现）：`electron --no-sandbox scripts/probe-electron-boot.js` 成功、不带则
 *   exit -2147483645（0x80000003 STATUS_BREAKPOINT）。问：**仓库那份 app** 是不是同样规律？
 *
 * 这个探针做的（干净、可复现、不碰她的真数据）：
 *   · userData 指到工作区（C:/deepseek/tmp-appboot）—— 沙箱只允许写工作区 ✓，
 *     也避免动她真实的 session/记忆 ✓（config/persona 只读拷一份 ✓）
 *   · require('../main.js') —— ★就是她启动时走的那份入口★（不是另写的假 app ✓）
 *   · 起来后先把窗口**藏起来**（少弹一会儿 ✓），6 秒后收集证据写文件，然后**自己退出** ✓
 *     （不需要杀任何进程 ✓）
 *
 * 跑法：
 *   cd app
 *   node_modules\electron\dist\electron.exe --no-sandbox scripts\probe-app-boot.js
 *   node_modules\electron\dist\electron.exe              scripts\probe-app-boot.js   # 对照：不带
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const REAL = path.join(process.env.APPDATA, 'dayu-pet');
const TMP = 'C:/deepseek/tmp-appboot';
const OUT = 'C:/deepseek/probe-app-boot.json';
fs.mkdirSync(TMP, { recursive: true });
for (const f of ['config.json', 'persona.json']) {
  try { fs.copyFileSync(path.join(REAL, f), path.join(TMP, f)); } catch (e) {}
}
app.setPath('userData', TMP);
const steps = [];
function L(s) { steps.push(String(s)); }
const NO_SANDBOX = process.argv.indexOf('--no-sandbox') >= 0;

function dump(extra) {
  const data = Object.assign({
    ok: !!extra && extra.ok !== false,
    noSandboxFlag: NO_SANDBOX,
    pid: process.pid,
    electron: process.versions.electron,
    node: process.versions.node,
    appReady: app.isReady(),
    steps: steps,
    windows: BrowserWindow.getAllWindows().map((w) => ({
      title: (() => { try { return w.getTitle(); } catch (e) { return ''; } })(),
      visible: (() => { try { return w.isVisible(); } catch (e) { return null; } })(),
      destroyed: (() => { try { return w.isDestroyed(); } catch (e) { return null; } })(),
    })),
    at: new Date().toISOString(),
  }, extra || {});
  let dbg = '';
  try { dbg = fs.readFileSync(path.join(TMP, 'debug.log'), 'utf8').split(/\r?\n/).slice(-6).join(' | '); } catch (e) {}
  data.debugLogTail = dbg.slice(0, 800);
  try { fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8'); } catch (e) {}
  try { process.stdout.write(JSON.stringify(data).slice(0, 400) + '\n'); } catch (e) {}
}

process.on('uncaughtException', (e) => {
  L('uncaughtException: ' + ((e && e.stack) || e));
  dump({ ok: false, error: String((e && e.message) || e) });
  process.exit(3);
});

L('script loaded (argv=' + process.argv.slice(1).join(' ') + ')');
try {
  require('../main.js');                 // ★她的真实入口★
  L('require(../main.js) ok');
  const m = require('../main.js');
  L('main.js exports: ' + Object.keys(m || {}).slice(0, 8).join(','));
} catch (e) {
  L('require(../main.js) 失败: ' + ((e && e.message) || e));
  dump({ ok: false, error: String((e && e.message) || e) });
  process.exit(2);
}

app.whenReady().then(() => {
  L('whenReady ok；窗口 ' + BrowserWindow.getAllWindows().length + ' 个');
  setTimeout(() => {
    try { for (const w of BrowserWindow.getAllWindows()) w.hide(); L('已把窗口藏起来（少弹一会儿）'); } catch (e) {}
  }, 1200);
  setTimeout(() => {
    L('6 秒观察结束，收集证据并退出');
    dump({ ok: true });
    app.exit(0);
  }, 6000);
});
/* 兜底：15 秒还没退就自己退（绝不留下常驻进程 ✓） */
setTimeout(() => { L('兜底超时，强制退出'); dump({ ok: false, error: 'timeout-15s' }); app.exit(4); }, 15000);
