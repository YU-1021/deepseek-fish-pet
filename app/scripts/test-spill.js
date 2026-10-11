/* spill.js 的单元测试 —— 纯 Node
 * 跑法：node app/scripts/test-spill.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/spill');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spill-test-'));

console.log('=== spill.js 单元测试（纯 Node）===');

/* §1 小内容原样返回 */
{
  const r = S.spill('短内容', { dir: TMP, id: 'a' });
  ok(r.spilled === false && r.content === '短内容', '§1 小内容原样返回，不落盘');
  ok(!fs.existsSync(path.join(TMP, 'a.txt')), '§1 没有多余文件');
}

/* §2 大内容：落盘 + 头尾保留 + 精确省略量 */
{
  const big = 'HEAD' + 'x'.repeat(20000) + 'TAIL';
  const r = S.spill(big, { dir: TMP, id: 'b', maxInlineBytes: 8192, headChars: 4000, tailChars: 1000 });
  ok(r.spilled === true, '§2 大内容触发 spill');
  ok(fs.existsSync(r.path), '§2 完整内容真的落盘了', r.path);
  const onDisk = fs.readFileSync(r.path, 'utf8');
  ok(onDisk === big, '§2 **落盘的是完整原文，一字不差**（回执里才截断）', onDisk.length + ' 字符');
  ok(r.content.startsWith('HEAD'), '§2 回执保留开头');
  ok(r.content.endsWith('TAIL'), '§2 回执保留结尾');
  ok(r.content.indexOf('省略') >= 0 && r.content.indexOf(r.path) >= 0, '§2 回执里写了省略量和路径');
  ok(r.content.length < big.length, '§2 回执确实比原文短', r.content.length + ' < ' + big.length);
  ok(r.omittedBytes > 0 && r.omittedBytes === S.byteLen(big) - S.byteLen(r.content.replace(/\n\n\[\.\.\.[\s\S]*?\.\.\.\]\n\n/, '')),
    '§2 省略字节数是**精确**算出来的', 'omitted=' + r.omittedBytes + ' total=' + r.totalBytes);
}

/* §3 中文（按字符切、按字节算，两个单位不能混） */
{
  const zh = '开头' + '中'.repeat(5000) + '结尾';
  const r = S.spill(zh, { dir: TMP, id: 'c', maxInlineBytes: 3000, headChars: 1000, tailChars: 200 });
  ok(r.spilled === true, '§3 中文大内容触发 spill');
  ok(r.content.startsWith('开头') && r.content.endsWith('结尾'), '§3 中文头尾都在（没有把某个汉字切成半个）');
  ok(r.omittedBytes > r.omittedChars, '§3 中文的"字节数"大于"字符数"（一个汉字 3 字节）',
    r.omittedBytes + ' 字节 / ' + r.omittedChars + ' 字符');
  ok(!/\uFFFD/.test(r.content), '§3 回执里没有出现替换字符（没切坏编码）');
}

/* §4 落盘失败 → fail-open：保留完整内容，绝不丢数据 */
{
  const big = 'y'.repeat(20000);
  const badDir = path.join(TMP, 'a-file-not-a-dir');
  fs.writeFileSync(badDir, 'x');                       // 用一个"文件"当目录 → mkdir 必失败
  const r = S.spill(big, { dir: path.join(badDir, 'sub'), id: 'd', maxInlineBytes: 100 });
  ok(r.spilled === false, '§4 落盘失败时不算 spill');
  ok(r.content === big, '§4 **完整内容原样返回**（fail-open，宁可回执长也不丢）');
  ok(!!r.warning, '§4 带警告说明', (r.warning || '').slice(0, 60));
}

/* §5 边界：正好等于上限 / 空值 / null */
{
  const edge = 'z'.repeat(1000);
  const r1 = S.spill(edge, { dir: TMP, id: 'e1', maxInlineBytes: 1000 });
  ok(r1.spilled === false, '§5 正好等于上限 → 不 spill');
  const r2 = S.spill('', { dir: TMP, id: 'e2' });
  ok(r2.spilled === false && r2.content === '', '§5 空串安全');
  const r3 = S.spill(null, { dir: TMP, id: 'e3' });
  ok(r3.spilled === false && r3.content === '', '§5 null 安全（不会崩）');
}

/* §6 不传 dir 也不崩（调用方忘了传 → 当作落盘失败走 fail-open） */
{
  const r = S.spill('q'.repeat(20000), { id: 'f', maxInlineBytes: 100 });
  ok(r.spilled === false && r.content.length === 20000, '§6 没给目录时不丢内容，走 fail-open');
}

/* §7 prune 清理旧文件 */
{
  const d = path.join(TMP, 'spilldir');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'old.txt');
  fs.writeFileSync(f, 'x');
  const old = Date.now() - 10 * 86400000;
  fs.utimesSync(f, old / 1000, old / 1000);
  const fresh = path.join(d, 'new.txt');
  fs.writeFileSync(fresh, 'y');
  const n = S.prune(d, 7);
  ok(n === 1 && !fs.existsSync(f) && fs.existsSync(fresh), '§7 prune 只删过期文件', '删了 ' + n + ' 个');
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
