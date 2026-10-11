/* C2：代码检查（不装 LSP，走"项目自己的检查器"）
 *
 * 【判断】LSP 服务器（TypeScript/Python/…）能给类型、定义、引用、诊断，
 *   但要装 server、管生命周期、按语言分别对接 —— 对一个桌宠太重 ✗。
 *   而"写程序"里真正卡人的 80% 是**这件事**：
 *     我改完这个文件，它还能跑吗？
 *   这个用**语言自带的检查器**就能回答，而且零依赖：
 *     · .js/.mjs/.cjs  → node --check                  （语法）
 *     · .ts/.tsx       → npx tsc --noEmit（若项目有 tsconfig）
 *     · .py            → python -m py_compile          （语法）
 *     · .json          → JSON.parse（我们自己解析，最快）
 *     · 其它           → 不猜，明确说"这个类型我不会检查"
 *   ★关键设计：检查器**不存在时要说清楚**（"这台机器上没有 python"），
 *     而不是静默成功 —— 静默成功是今天反复踩到的那类最危险的 bug ✓
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function which(exe) {
  /* Node 20+ 里 where 在 PATH 上；用 spawnSync 避免 execFileSync 抛错打断 */
  const r = spawnSync('where', [exe], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  if (r.status === 0 && r.stdout) {
    const first = String(r.stdout).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
    return first || null;
  }
  return null;
}

const PY = ['python', 'python3', 'py'];

function check(file) {
  const f = path.resolve(String(file || ''));
  if (!fs.existsSync(f)) return { ok: false, error: '文件不存在：' + f };
  const ext = path.extname(f).toLowerCase();
  const dir = path.dirname(f);
  const t0 = Date.now();

  /* ── JSON：自己解析，最快也最准 ── */
  if (ext === '.json') {
    try { JSON.parse(fs.readFileSync(f, 'utf8')); return { ok: true, kind: 'json', ms: Date.now() - t0, note: 'JSON 合法 ✓' }; }
    catch (e) { return { ok: false, kind: 'json', ms: Date.now() - t0, error: 'JSON 解析失败：' + ((e && e.message) || e) }; }
  }

  /* ── JS：node --check（只查语法，不执行） ── */
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const outText = String(r.stderr || r.stdout || '').trim();
    return {
      ok: r.status === 0, kind: 'node --check', ms: Date.now() - t0, exit: r.status,
      error: r.status === 0 ? '' : (outText.split(/\r?\n/).slice(0, 6).join('\n') || '语法检查失败'),
      note: r.status === 0 ? '语法 OK ✓（注意：node --check 只查语法，不查类型、不执行）' : '',
    };
  }

  /* ── TypeScript：npx tsc --noEmit（要求项目里有 tsconfig） ── */
  if (ext === '.ts' || ext === '.tsx') {
    const tsconfig = ['tsconfig.json', 'jsconfig.json'].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p))
      || (function up(d) {
        let cur = d;
        for (let i = 0; i < 6; i++) {
          const p = path.join(cur, 'tsconfig.json');
          if (fs.existsSync(p)) return p;
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
        return null;
      })(dir);
    if (!tsconfig) {
      return { ok: false, kind: 'tsc', ms: Date.now() - t0, error: '没找到 tsconfig.json —— 不敢用 tsc 裸跑（参数不同结论会不一样）。要么告诉我项目根目录，要么手工确认。' };
    }
    const root = path.dirname(tsconfig);
    const r = spawnSync('npx', ['--no-install', 'tsc', '--noEmit', '-p', tsconfig],
      { encoding: 'utf8', windowsHide: true, timeout: 180000, cwd: root, shell: true });
    const txt = String(r.stdout || '') + String(r.stderr || '');
    const lines = txt.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
    return {
      ok: r.status === 0, kind: 'tsc --noEmit', ms: Date.now() - t0, exit: r.status,
      error: lines.length ? (lines.slice(0, 8).join('\n')) : (r.status === 0 ? '' : txt.slice(0, 600)),
      note: r.status === 0 ? '类型检查通过 ✓' : ('共 ' + lines.length + ' 个类型错误'),
    };
  }

  /* ── Python：py_compile（只查语法） ── */
  if (ext === '.py') {
    let py = null;
    for (const c of PY) { if (which(c)) { py = c; break; } }
    if (!py) return { ok: false, kind: 'py_compile', ms: Date.now() - t0, error: '这台机器上没有找到 python —— ★不是"检查通过"，是"检查不了"★' };
    const r = spawnSync(py, ['-m', 'py_compile', f], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const txt = String(r.stderr || r.stdout || '').trim();
    return {
      ok: r.status === 0, kind: py + ' -m py_compile', ms: Date.now() - t0, exit: r.status,
      error: r.status === 0 ? '' : (txt.split(/\r?\n/).slice(-6).join('\n') || '语法检查失败'),
      note: r.status === 0 ? '语法 OK ✓（只查语法，不查类型）' : '',
    };
  }

  return { ok: false, kind: 'unknown', ms: Date.now() - t0, error: '我不认识 ' + ext + ' 这种类型，不会瞎检查。可以让我用 shell_run 跑项目自己的 lint/test。' };
}

module.exports = { check, which };
