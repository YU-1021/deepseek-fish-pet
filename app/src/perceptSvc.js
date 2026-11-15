/* perceptSvc.js —— 桌宠侧的常驻感知服务客户端（PaddleOCR 常驻进程）。
 *
 * 背景：ocrJson() 原来每次 spawn 一个 PowerShell 跑 OCR（~0.76s/次）。
 * 这里改成一个常驻 Python 服务（det+rec 模型只加载一次），单次 ~0.30s（实测 2.5x）。
 *
 * 兜底：服务起不来 / 超时 / 返回失败 → 调用方回退旧的 PowerShell OCR 路径。
 * 关闭开关：环境变量 PA_PERCEPT_DISABLE=1。
 *
 * 服务实现：C:\deepseek\预习助手\service\percept_service.py（可用 PA_PERCEPT_SERVICE 覆盖）
 */
'use strict';
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT_FILE = path.join(os.tmpdir(), 'pa-percept.port');
const DEFAULT_PORT = 17361;
const SERVICE = process.env.PA_PERCEPT_SERVICE || 'C:\\deepseek\\预习助手\\service\\percept_service.py';
const PY_CANDIDATES = [
  process.env.PA_PYTHON,
  'C:\\Users\\64616\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
  'python',
];

function pythonPath() {
  for (const p of PY_CANDIDATES) {
    if (!p) continue;
    if (p === 'python') return p;
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return 'python';
}
function readPort() {
  try {
    const n = Number(String(fs.readFileSync(PORT_FILE, 'utf8')).trim());
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
  } catch (e) { return DEFAULT_PORT; }
}
function request(msg, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const sock = net.connect({ host: '127.0.0.1', port: readPort() }, () => sock.write(JSON.stringify(msg) + '\n'));
    let buf = '';
    const timer = setTimeout(() => { try { sock.destroy(); } catch (e) {} fin({ ok: false, error: 'timeout' }); }, timeoutMs);
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) { clearTimeout(timer); try { sock.end(); } catch (e) {} try { fin(JSON.parse(buf.slice(0, i))); } catch (e) { fin({ ok: false, error: 'bad json' }); } }
    });
    sock.on('error', (e) => { clearTimeout(timer); fin({ ok: false, error: String(e && e.message || e) }); });
    sock.on('close', () => { clearTimeout(timer); fin({ ok: false, error: 'closed' }); });
  });
}

let starting = null;
let disabled = false;
function isDisabled() {
  if (disabled) return true;
  if (String(process.env.PA_PERCEPT_DISABLE || '') === '1') { disabled = true; return true; }
  return false;
}

async function ensure() {
  const p = await request({ id: 0, cmd: 'ping' }, 1200);
  if (p && p.ok) return { ok: true };
  if (starting) return starting;
  starting = (async () => {
    try { fs.unlinkSync(PORT_FILE); } catch (e) {}
    if (!fs.existsSync(SERVICE)) return { ok: false, error: '找不到服务脚本：' + SERVICE };
    try {
      const child = spawn(pythonPath(), [SERVICE, '--port', String(DEFAULT_PORT)], {
        detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...process.env, PA_MAA_DIR: process.env.PA_MAA_DIR || 'F:\\大肥鱼\\MAA' },
      });
      child.unref();
    } catch (e) { return { ok: false, error: '启动失败：' + e.message }; }
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      const q = await request({ id: 0, cmd: 'ping' }, 800);
      if (q && q.ok) return { ok: true };
    }
    return { ok: false, error: '服务启动超时' };
  })();
  try { return await starting; } finally { starting = null; }
}

/** 返回和旧 ocrJson 相同的形状：{ok,imgW,imgH,text,lines:[{text,words:[{t,x,y,w,h}]}]} */
async function ocr(imagePath) {
  if (isDisabled()) return null;
  const svc = await ensure();
  if (!svc.ok) return { ok: false, error: svc.error };
  const r = await request({ id: Date.now() % 1e9, cmd: 'ocr', path: imagePath, mode: 'full' }, 20000);
  return r;
}

module.exports = { ocr, ensure, isDisabled, SERVICE, PORT_FILE };
