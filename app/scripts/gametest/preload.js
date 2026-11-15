/* preload.js（gametest 专用）—— 只暴露两件事：写 JSONL 日志、ESC 退出 ✓（contextIsolation ✓）
 * ★每行都带 batch（= 本批启动时间戳 ✓）★ → lead 可以只读同一批的行 ✓（clicks.jsonl 每次启动清空 ✓）
 * ★只对 .btn 元素记录✗★（空白处点击不产生行 ✓）→ "报成功但日志无对应行" = 假成功✗ ✓
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { contextBridge, ipcRenderer } = require('electron');
const OUT = 'C:/deepseek/gametest/clicks.jsonl';
const BATCH = (function () { try { return String(fs.readFileSync('C:/deepseek/gametest/batch.txt', 'utf8')).trim(); } catch (e) { return 'unknown'; } })();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
contextBridge.exposeInMainWorld('gameTestLog', (rec) => {
  try { fs.appendFileSync(OUT, JSON.stringify(Object.assign({ batch: BATCH, t: Date.now(), kind: 'click' }, rec)) + '\n'); } catch (e) {}
});
contextBridge.exposeInMainWorld('gameTestQuit', () => { try { ipcRenderer.send('gametest:quit'); } catch (e) {} });
