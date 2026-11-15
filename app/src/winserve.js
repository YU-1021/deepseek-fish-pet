/* winserve.js —— 常驻原生窗口/光标服务（DSH 风格的“进程内速度”：不再每次 spawn PowerShell）
 *
 * 实测旧路径（PowerShell + Add-Type 每次重新编译 C#）：
 *   windows_list 666ms / foreground 567ms / window_rect ~600ms / cursor ~500ms
 * 常驻 winserve.exe（serve 模式，stdin 逐行命令 → stdout 一行 JSON）：
 *   list ~2-5ms（首次含进程启动 ~50ms）/ cursor ~1ms
 *
 * 兜底：进程起不来/崩了/超时 → 返回 {ok:false}，调用方回退旧 PowerShell 路径。
 * 关闭开关：PET_WINSERVE_ONESHOT=1。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let _proc = null;
let _buf = '';
let _waiters = [];
let _lastAt = 0;
const IDLE_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5000;

function disabled() {
  return String(process.env.PET_WINSERVE_ONESHOT || '') === '1';
}

function exePath() {
  const dev = path.join(__dirname, '..', 'vendor', 'winserve', 'winserve.exe');
  const packed = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'vendor', 'winserve', 'winserve.exe');
  try { if (fs.existsSync(dev)) return dev; } catch (e) {}
  return packed;
}

function alive() {
  return !!(_proc && !_proc.killed && _proc.exitCode === null);
}

function failAll(reason) {
  const ws = _waiters; _waiters = [];
  for (const w of ws) { clearTimeout(w.timer); try { w.res({ ok: false, error: reason }); } catch (e) {} }
}

function ensure() {
  if (disabled()) return null;
  if (alive()) {
    if (Date.now() - _lastAt > IDLE_MS) { try { _proc.stdin.write('quit\n'); } catch (e) {} try { _proc.kill(); } catch (e) {} _proc = null; }
    else return _proc;
  }
  try {
    const exe = exePath();
    if (!fs.existsSync(exe)) return null;
    _proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    _proc.stdout.setEncoding('utf8');
    _proc.stderr.setEncoding('utf8');
    _buf = '';
    _proc.stdout.on('data', (d) => {
      _buf += d;
      let i;
      while ((i = _buf.indexOf('\n')) >= 0) {
        const line = _buf.slice(0, i); _buf = _buf.slice(i + 1);
        if (!line.trim()) continue;
        let j = null;
        try { j = JSON.parse(line); } catch (e) { j = null; }
        const w = _waiters.shift();
        if (w) { clearTimeout(w.timer); try { w.res(j || { ok: false, error: 'bad-json' }); } catch (e) {} }
      }
    });
    _proc.stderr.on('data', (d) => { try { require('./debug').log('[winserve] ' + String(d).slice(0, 200)); } catch (e) {} });
    _proc.on('exit', () => { _proc = null; failAll('winserve-exit'); });
    _proc.on('error', () => { _proc = null; failAll('winserve-error'); });
    _lastAt = Date.now();
    return _proc;
  } catch (e) { _proc = null; return null; }
}

function request(cmd, timeoutMs) {
  return new Promise((resolve) => {
    const p = ensure();
    if (!p || !p.stdin || p.stdin.destroyed) return resolve({ ok: false, error: 'no-proc' });
    const w = { res: resolve, timer: null };
    w.timer = setTimeout(() => {
      const i = _waiters.indexOf(w);
      if (i >= 0) _waiters.splice(i, 1);
      try { p.kill(); } catch (e) {}
      _proc = null;
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs || TIMEOUT_MS);
    _waiters.push(w);
    try { p.stdin.write(cmd + '\n'); _lastAt = Date.now(); } catch (e) { clearTimeout(w.timer); resolve({ ok: false, error: 'write-fail' }); }
  });
}

async function list() { return request('list'); }
async function cursor() { return request('cursor'); }
async function ping() { return request('ping', 2000); }

/* UIA 查询：uia <hwnd>|<b64 title>|<b64 needle>
   hwnd != 0 按句柄；否则按标题找顶层元素。needle 非空 = find 模式。 */
function b64(s) { return Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64'); }
async function uia(hwnd, title, needle) {
  const line = 'uia ' + (Number(hwnd) || 0) + '|' + b64(title || '') + '|' + b64(needle || '');
  return request(line, 8000);
}

module.exports = { list, cursor, ping, uia, disabled, exePath };
