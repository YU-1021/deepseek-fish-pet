/* 同步桌宠的规则文件（override.md）—— 仓库 ↔ %APPDATA%
 *
 * 【为什么要它】实测（2026-10-03）：override.md 是桌宠**全部行为规则的唯一副本** ✗，
 *   住在 %APPDATA%\dayu-pet\prompts\，**没有版本控制、没有备份** ✓，
 *   而它已经涨到 15,000+ 字符、改了几十次（每次踩坑后补的 ✓）—— 丢一次就全没了 ✗。
 *
 * 【用法】
 *   node app/scripts/sync-override.js status   # 看两边一不一致
 *   node app/scripts/sync-override.js pull     # 她那边 → 仓库（收回来）
 *   node app/scripts/sync-override.js push     # 仓库 → 她那边（推过去）
 *
 * 【安全设计（★宁可拒绝，也不要冲掉别人的改动 ✗★）】
 *   · 覆盖前**先把被覆盖的那份备份**成 .bak-<时间戳> ✓
 *   · push 前**先比对**：如果她那边和仓库不一致 ✗（说明有人在运行时改过 ✓），
 *     ★拒绝覆盖★ ✓ 并要你先 pull 一次 —— 除非显式加 --force ✓
 *   · 相对路径全部基于脚本位置算 ✓（不依赖 cwd ✓）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..', 'docs', 'her-rules', 'override.md');
const LIVE = path.join(process.env.APPDATA || '', 'dayu-pet', 'prompts', 'override.md');

function sha(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch (e) { return null; }
}
function info(p) {
  try {
    const st = fs.statSync(p);
    return { exists: true, size: st.size, mtime: st.mtime, hash: sha(p) };
  } catch (e) { return { exists: false }; }
}
function backup(p) {
  if (!fs.existsSync(p)) return null;
  const dst = p + '.bak-' + Date.now();
  fs.copyFileSync(p, dst);
  return dst;
}
function short(h) { return h ? h.slice(0, 12) : '(无)'; }

function status() {
  const r = info(REPO), l = info(LIVE);
  console.log('  仓库副本 : ' + (r.exists ? (r.size + 'B  ' + r.mtime.toLocaleString('zh-CN') + '  sha ' + short(r.hash)) : '✗ 不存在'));
  console.log('  她那边   : ' + (l.exists ? (l.size + 'B  ' + l.mtime.toLocaleString('zh-CN') + '  sha ' + short(l.hash)) : '✗ 不存在'));
  if (!r.exists || !l.exists) return 'missing';
  const same = r.hash === l.hash;
  console.log('  ' + (same ? '★两边一致 ✓' : '★★两边不一致 ✗★（有人在运行时改过，或者仓库这边有新改动）'));
  return same ? 'same' : 'differ';
}

function pull() {
  const l = info(LIVE);
  if (!l.exists) { console.log('  ✗ 她那边没有这个文件，没法收回来'); process.exit(1); }
  const b = backup(REPO);
  fs.mkdirSync(path.dirname(REPO), { recursive: true });
  fs.copyFileSync(LIVE, REPO);
  console.log('  ✓ 已收回：她那边 → 仓库（' + l.size + 'B, sha ' + short(sha(REPO)) + '）');
  if (b) console.log('    仓库旧版已备份为 ' + path.basename(b) + ' ✓');
  return 0;
}

function push(force) {
  const r = info(REPO), l = info(LIVE);
  if (!r.exists) { console.log('  ✗ 仓库副本不存在，先用 pull 收一份回来'); process.exit(1); }
  if (l.exists && r.hash !== l.hash && !force) {
    console.log('  ⛔ 拒绝覆盖 —— 她那边和仓库**不一致** ✗');
    console.log('     这说明她那边有仓库里没有的改动 ✓（在运行时改过 ✓）');
    console.log('     请先 `pull` 把她的改动收回来、合进仓库，再 `push` ✓');
    console.log('     （确实确认过要丢弃她那边的话，加 --force ✓）');
    console.log('');
    status();
    return 2;
  }
  const b = backup(LIVE);
  fs.mkdirSync(path.dirname(LIVE), { recursive: true });
  fs.copyFileSync(REPO, LIVE);
  console.log('  ✓ 已推过去：仓库 → 她那边（' + r.size + 'B, sha ' + short(sha(LIVE)) + '）');
  if (b) console.log('    她那边旧版已备份为 ' + path.basename(b) + ' ✓');
  console.log('    ★不需要重启她★ —— prompts/ 不在 app/ 下，改它不触发热重载 ✓（实测过 ✓）');
  return 0;
}

function main() {
  const cmd = String(process.argv[2] || 'status').toLowerCase();
  const force = process.argv.indexOf('--force') >= 0;
  console.log('  仓库: ' + REPO);
  console.log('  实际: ' + LIVE);
  console.log('');
  if (cmd === 'status') { status(); return 0; }
  if (cmd === 'pull') return pull();
  if (cmd === 'push') return push(force);
  console.log('  用法: sync-override.js status | pull | push [--force]');
  return 1;
}

process.exit(main());
