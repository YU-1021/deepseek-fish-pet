/* probe-stoplog.js —— ★D 条的真机验证探针★：停止原因真的落进**会话日志**了吗？
 *
 * 跑法：
 *   cd C:\deepseek\desktop-pet\app
 *   Remove-Item env:ELECTRON_RUN_AS_NODE
 *   node_modules\electron\dist\electron.exe app\scripts\probe-stoplog.js
 *   （跑完去看 %APPDATA%\dayu-pet-stoplog-probe\memory\session.json，或直接 grep 它）
 *
 * 它调的是 **main.js 那个 IPC handler 调用的同一个函数**（src/stoplog.js 的 noteStop），
 * 走的是真的 session/store/迁移管线 —— 不是"我另写一遍再验我自己的实现"。
 *
 * ⚠️ 用**独立 userData**（临时目录），绝不写进主人真实的会话日志 ✓
 * ⚠️ 不开任何可见窗口 ✓
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const TMP = path.join(process.env.APPDATA, 'dayu-pet-stoplog-probe');
fs.mkdirSync(TMP, { recursive: true });
try { fs.copyFileSync(path.join(process.env.APPDATA, 'dayu-pet', 'config.json'), path.join(TMP, 'config.json')); } catch (e) {}
/* 干净开始：把上一次探针留下的会话清掉，免得读到旧数据以为"这次写进去了" */
try { fs.rmSync(path.join(TMP, 'memory'), { recursive: true, force: true }); } catch (e) {}
app.setPath('userData', TMP);

const out = [];
function L(s) { out.push(String(s)); try { process.stdout.write(String(s) + '\n'); } catch (e) {} }
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; L('  [PASS] ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; L('  [FAIL] ' + label + (extra ? '   ' + extra : '')); }
}
function info(label, extra) { L('  [INFO] ' + label + (extra ? '   ' + extra : '')); }

function readSessionFile() {
  const p = path.join(TMP, 'memory', 'session.json');
  if (!fs.existsSync(p)) return { p, j: null };
  try { return { p, j: JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch (e) { return { p, j: null, err: String(e.message) }; }
}

function main() {
  L('=== probe-stoplog（停止原因 → 会话日志）===');
  const session = require(path.join(__dirname, '..', 'src', 'memory', 'session'));
  const stoplog = require(path.join(__dirname, '..', 'src', 'stoplog'));
  const loop = require(path.join(__dirname, '..', 'renderer', 'loop'));
  info('临时 userData：' + TMP);

  /* 前置：loop 的原因表和 stoplog 的登记表必须是同一套（不然会记成 unknown） */
  const same = loop.REASONS.slice().sort().join(',') === stoplog.KNOWN.slice().sort().join(',');
  ok(same, '★loop.REASONS 与 stoplog.KNOWN 是同一套原因★（2026-10-10 起 8 个，含 interrupted ✓）', loop.REASONS.join('/'));

  session.restore();
  session.push({ role: 'user', content: '（探针）这一轮任务' });
  session.push({ role: 'assistant', content: '（探针）好的' });

  /* ① 正常的停止原因 */
  const r1 = stoplog.noteStop({ stopReason: 'look-streak', ok: false, steps: 4, lookStreak: 5 });
  session.saveNow();
  info('noteStop 返回：' + JSON.stringify(r1));
  ok(r1.wrote === true && r1.known === true, '① 记下了 look-streak（登记表里的原因）');
  let f = readSessionFile();
  ok(!!(f.j && Array.isArray(f.j.events)), '① 会话日志文件存在且是事件流', f.p);
  const ev1 = f.j && (f.j.events || []).find((e) => e.kind === 'stop' && e.reason === 'look-streak');
  ok(!!ev1, '★① 会话日志里能查到 stop 事件（kind=stop, reason=look-streak）★',
    ev1 ? JSON.stringify(ev1) : '没找到');
  ok(!!(ev1 && ev1.steps === 4), '① 步数也一起记下来了', ev1 ? String(ev1.steps) : '');

  /* ② ★元数据绝不能进模型看到的对话★（进了就会多一条空消息，把模型教坏） */
  const proj = session.all();
  const leaked = proj.filter((m) => /look-streak/.test(String(m.content || '')));
  ok(leaked.length === 0, '★② stop 事件不在投影里（模型看不到它）★', '投影条数=' + proj.length);
  info('投影（模型看到的）=' + JSON.stringify(proj.map((m) => String(m.content || '').slice(0, 12))));

  /* ③ 没登记的原因也要如实记（不是"没有原因"，而是"没登记的原因"） */
  const r3 = stoplog.noteStop({ stopReason: 'some-new-thing', ok: true });
  session.saveNow();
  f = readSessionFile();
  const ev3 = f.j && (f.j.events || []).find((e) => e.kind === 'stop' && e.reason === 'some-new-thing');
  ok(!!ev3 && ev3.unknownReason === true, '③ 未登记的原因也照记，并打上 unknownReason 标记', ev3 ? JSON.stringify(ev3) : '没找到');

  /* ④ 没有原因就不许瞎写一条空记录 */
  const r4 = stoplog.noteStop({});
  ok(r4.wrote === false, '④ 没有 stopReason → 不写（宁可没有，也不要一条空记录）', JSON.stringify(r4));

  /* ⑤ 一轮里记两条 stop 也都在（只追加，不覆盖） */
  const all = (readSessionFile().j || {}).events || [];
  const stops = all.filter((e) => e.kind === 'stop');
  ok(stops.length === 2, '⑤ 两次停止 = 两条 stop 事件（只追加，历史不会被改写）', 'stops=' + stops.length);

  L('');
  L('会话日志文件：' + path.join(TMP, 'memory', 'session.json'));
  L('通过 ' + pass + ' / ' + (pass + fail));
  try { fs.writeFileSync('C:/deepseek/probe-stoplog.out.txt', out.join('\n'), 'utf8'); } catch (e) {}
  process.exit(fail ? 1 : 0);
}

app.whenReady().then(() => {
  try { main(); } catch (e) {
    L('探针崩了：' + ((e && e.stack) || e));
    try { fs.writeFileSync('C:/deepseek/probe-stoplog.out.txt', out.join('\n'), 'utf8'); } catch (e2) {}
    process.exit(2);
  }
});
