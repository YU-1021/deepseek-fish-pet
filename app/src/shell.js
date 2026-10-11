/* 常驻 shell 会话（B1）—— 补上她最大的一个结构性缺口
 *
 * 【为什么需要它】她执行外部命令一直是**一次性 spawn**（projects.run → 跑一个脚本就退出）。
 *   于是"进目录 → 装依赖 → 编译 → 看报错 → 改 → 再编译"这条链**断掉**：
 *   每一步都是新进程，`cd` 不留、环境变量不留、后台进程留不下。
 *   实测场景（用户提的"后面要写程序"）：她要 npm install 再 npm run build，
 *   第一条命令装到半路，第二条在另一个进程里跑，cwd 已经回到初始目录 ✗。
 *
 * 【实现要点（都是踩过的坑）】
 *  ① ★必须先把 PowerShell 的输出编码设成 UTF-8★ ——
 *     PS 5.1 的 stdout 默认是 GBK，Node 按 UTF-8 解会把中文变成乱码 ✗
 *     （今天在 Get-Content 和剪贴板工具上已经各踩过一次 ✓）。
 *  ② 用**哨兵行**判断一条命令跑完了：追加 `; Write-Output "<哨兵>$LASTEXITCODE"` ——
 *     比"等 N 秒没输出就算完"可靠（后者对慢命令必然误判 ✗）。
 *  ③ 同时把 cwd 带回来（`(Get-Location).Path`），这样她能看到自己现在在哪个目录 ✓。
 *  ④ 同一时刻只允许一条命令在跑（busy 闸门）—— 两条命令交错会让输出串台 ✗。
 *  ⑤ 超时就**不等结果**、明确报"还在跑"✗→✓（不要傻等，也不要谎报成功 ✓）。
 *  ⑥ 会话空闲太久自动关掉，别一直挂着一个 powershell 进程 ✓。
 */
'use strict';

const { spawn } = require('child_process');

const SENT = '@@PET_SH_DONE@@';
const IDLE_MS = 10 * 60 * 1000;      // 空闲 10 分钟自动回收

let proc = null;
let buf = '';
let busy = false;
let cwd = '';
let lastAt = 0;
let idleTimer = null;
let waiter = null;                    // { resolve, sentinelAt } 当前等待者
let sessionErr = '';

function dbg(msg) {
  try { require('./debug').log('[shell] ' + msg); } catch (e) {}
}

function clearIdle() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}
function armIdle() {
  clearIdle();
  idleTimer = setTimeout(() => { try { close('idle'); } catch (e) {} }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

/* 吃掉一段 stdout/stderr：哨兵行里带的是 **base64**，解码后才知道内容 */
function onData(chunk) {
  buf += chunk;
  if (!waiter) return;
  const idx = buf.indexOf(SENT);
  if (idx < 0) return;
  const lineEnd = buf.indexOf('\n', idx);
  const head = buf.slice(0, idx);
  const tailLine = buf.slice(idx, lineEnd < 0 ? buf.length : lineEnd);
  buf = buf.slice(lineEnd < 0 ? buf.length : lineEnd + 1);
  /* 哨兵行：@@PET_SH_DONE@@<base64>，解码后是 `输出|退出码|当前目录` */
  const m = tailLine.match(/@@PET_SH_DONE@@([A-Za-z0-9+/=]*)/);
  let payload = '';
  if (m && m[1]) { try { payload = Buffer.from(m[1], 'base64').toString('utf8'); } catch (e) { payload = ''; } }
  let output = '', code = null;
  if (payload) {
    const p1 = payload.lastIndexOf('|');
    const p0 = p1 > 0 ? payload.lastIndexOf('|', p1 - 1) : -1;
    if (p0 >= 0 && p1 > p0) {
      output = payload.slice(0, p0);
      const codeStr = payload.slice(p0 + 1, p1).trim();
      const cwdStr = payload.slice(p1 + 1).trim();
      code = codeStr === '' ? null : Number(codeStr);
      if (cwdStr) cwd = cwdStr;
    } else { output = payload; }
  }
  const w = waiter;
  waiter = null;
  busy = false;
  lastAt = Date.now();
  armIdle();
  w.resolve({ output: output.replace(/\r/g, ''), code, cwd });
}

function start() {
  if (proc && !proc.killed) return;
  sessionErr = '';
  buf = '';
  proc = spawn('powershell.exe',
    ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', (e) => { sessionErr = String(e && e.message || e); dbg('spawn 出错: ' + sessionErr); });
  proc.on('exit', (code) => {
    dbg('会话退出 code=' + code);
    proc = null; busy = false;
    if (waiter) { const w = waiter; waiter = null; w.resolve({ output: '', code: null, cwd, dead: true }); }
  });
  cwd = '';
  /* ★★★ 会话第一件事：把**输入和输出两侧**的编码都设成 UTF-8 ★★★
     2026-10-03 实测（原始 hex 抓到的）：
       只设输出编码是不够的 ✗ —— Node 按 UTF-8 把命令写进 stdin，
       而 PowerShell **按 GBK 读 stdin** ✗，所以我发过去的"中文"到了 PS 那边
       就已经是乱码了（`hi 中文` → `hi 涓枃` → 再 UTF-8 输出 → 双重乱码 ✗）。
     两行都是**纯 ASCII**，所以它们自己不会被编码问题影响 ✓（这一点很关键：
     要修的代码本身必须是 ASCII 安全的，否则就成了"用坏掉的信道传修复指令"）。 */
  write('[Console]::InputEncoding = [Text.Encoding]::UTF8');
  write('[Console]::OutputEncoding = [Text.Encoding]::UTF8');
  write('$OutputEncoding = [Text.Encoding]::UTF8');
}

function write(s) {
  if (!proc || proc.killed) return false;
  try { proc.stdin.write(s + '\n'); return true; } catch (e) { return false; }
}

/* 跑一条命令，返回它的真实输出（会话保留：cwd / 环境 / 变量都留着） */
async function run(cmd, timeoutMs) {
  const c = String(cmd == null ? '' : cmd);
  if (!c.trim()) return { ok: false, error: '命令为空' };
  if (busy) return { ok: false, error: '上一条命令还在跑，等它结束再发下一条（同一会话里命令不能交错）' };
  start();
  if (sessionErr) return { ok: false, error: 'shell 起不来：' + sessionErr };
  await new Promise((r) => setTimeout(r, 120));      // 等编码设置那行进得去
  buf = '';
  busy = true;
  lastAt = Date.now();
  const wait = new Promise((resolve) => { waiter = { resolve }; });
  /* ★★★ 命令和输出都走 base64 —— 纯 ASCII 信道 ★★★
     2026-10-03 实测（原始 hex 抓到的）：直接把命令写进 stdin 是不行的 ✗ ——
       Node 按 UTF-8 写 ✓，而 PowerShell **按 GBK 读 stdin** ✗，
       于是命令里的中文到 PS 那边就是乱码；更糟的是引号会因此不闭合 ✗，
       PS 一直等后续输入 → 那条命令**永远不结束**（实测 `Write-Output "切好了"` 超时 15 秒 ✓）。
     修法（和剪贴板工具同一招，已经验证过）：
       · 发送：把命令 base64 编码塞进一段**纯 ASCII** 的包装脚本 ✓
       · 接收：让 PS 把输出也 base64 出来，Node 侧解码 ✓
     这样信道里永远只有 ASCII，编码问题**在结构上**不可能再发生 ✓✓。
     包装脚本里 `2>&1 | Out-String` 是把 stderr 也抓进来（不然报错看不到 ✓）。 */
  const b64 = Buffer.from(c, 'utf8').toString('base64');
  /* ⚠️ 每条命令前把 $LASTEXITCODE 清零：它是**会话级**变量，会残留 ——
     实测 cmd /c exit 3 之后，后面所有命令都继承 code=3（明明成功也报失败）。 */
  const script = '$global:LASTEXITCODE = 0; '
    + '$__c=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + b64 + '")); '
    + '$__o=(Invoke-Expression $__c 2>&1 | Out-String); '
    + 'Write-Output ("' + SENT + '" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($__o + "|" + $LASTEXITCODE + "|" + (Get-Location).Path))))';
  write(script);
  const to = Math.max(3000, Math.min(600000, Number(timeoutMs) || 120000));
  const timeout = new Promise((r) => setTimeout(() => r({ __timeout: true }), to));
  const got = await Promise.race([wait, timeout]);
  if (got && got.__timeout) {
    /* ★ 超时不等于失败：命令可能还在跑。但不能只把 busy 放开 ✗ ——
       那样下一条命令的输出会和这条**串在一起**，谁也分不清哪句是谁的 ✓。
       所以超时后**重建整个会话**：明确、干净，宁可丢掉 cwd 也不要张冠李戴 ✓。 */
    const seen = buf.replace(/\r/g, '').slice(-4000);
    close('timeout');
    return {
      ok: false, timeout: true, cwd,
      error: '命令在 ' + Math.round(to / 1000) + ' 秒内没有结束。★会话已重建★（因为无法确认它是否跑完，'
        + '继续用同一个会话会让下一条命令的输出和它串台）。可以再发一次，或者换个更快的做法。',
      output: seen,
    };
  }
  if (got && got.dead) return { ok: false, error: 'shell 会话已经退出（可能是上一条命令把它弄崩了）', output: got.output || '' };
  /* ★ code === null 表示"这条语句没有退出码"（比如纯 Write-Output、或纯 cmdlet）——
     那不是失败 ✗，别把它当错误（第一版写成 got.code === 0，于是所有 cmdlet 都被判失败 ✓）。 */
  const ok = (got.code === null || got.code === undefined) ? true : got.code === 0;
  return { ok, code: got.code, cwd: got.cwd, output: got.output || '' };
}

function close(reason) {
  clearIdle();
  if (proc && !proc.killed) { try { write('exit'); } catch (e) {} try { proc.kill(); } catch (e) {} }
  proc = null; busy = false; waiter = null; buf = '';
  dbg('会话关闭（' + (reason || '手动') + '）');
}

function status() {
  return { alive: !!(proc && !proc.killed), busy, cwd, lastAt, idleMs: lastAt ? Date.now() - lastAt : 0 };
}

module.exports = { run, close, status, SENT };
