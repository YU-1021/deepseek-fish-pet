/* obs.js 的单元测试 —— 纯 Node（用真实临时文件，测的是真的 mtime/size）
 * 跑法：node app/scripts/test-obs.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const O = require('../src/obs');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
const F = path.join(TMP, 'a.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== obs.js 单元测试（纯 Node）===');

  /* §1 keyOf：相对/绝对、尾分隔符、大小写 */
  {
    ok(O.keyOf(F) === O.keyOf(F), '§1 同一个路径得到同一个键');
    ok(O.keyOf(path.join(TMP, 'sub', '..', 'a.txt')) === O.keyOf(F), '§1 含 .. 的等价路径归一化');
    if (O.CASE_INSENSITIVE) {
      ok(O.keyOf(F.toUpperCase()) === O.keyOf(F.toLowerCase()), '§1 ★Windows 大小写不敏感（大写小写算同一个文件）');
    } else {
      ok(true, '§1 （非 Windows，跳过大小写检查）');
    }
    ok(O.keyOf('') === '' && O.keyOf(null) === '', '§1 空路径得到空键（会被拒绝）');
  }

  /* §2 createIfAbsent */
  {
    const o = O.create();
    let r = o.checkWrite({ path: F, mode: 'createIfAbsent', stat: null });
    ok(r.ok === true, '§2 目标不存在时 createIfAbsent 放行');
    fs.writeFileSync(F, 'original', 'utf8');
    r = o.checkWrite({ path: F, mode: 'createIfAbsent', stat: fs.statSync(F) });
    ok(r.ok === false && r.code === 'FS_EXISTS', '§2 目标已存在时 createIfAbsent **拒绝**', r.code);
    ok(/已经存在/.test(r.message) && /read_file/.test(r.message), '§2 拒绝信息告诉她下一步怎么做', r.message.slice(0, 50));
  }

  /* §3 ★ 没读过就写（replaceIfVersion） → FS_NOT_OBSERVED */
  {
    const o = O.create();
    const r = o.checkWrite({ path: F, mode: 'replaceIfVersion', stat: fs.statSync(F) });
    ok(r.ok === false && r.code === 'FS_NOT_OBSERVED', '§3 **没读过就写 → 拒绝**（防盲写覆盖）', r.code);
    ok(/还没读过/.test(r.message), '§3 信息说清原因', r.message.slice(0, 44));
  }

  /* §4 读过且没变 → 放行；被改过 → FS_STALE（这才是 CAS） */
  {
    const o = O.create();
    o.noteObserved(F, fs.statSync(F), 'read');
    let r = o.checkWrite({ path: F, mode: 'replaceIfVersion', stat: fs.statSync(F) });
    ok(r.ok === true, '§4 读过且版本没变 → 放行');
    await sleep(20);
    fs.writeFileSync(F, '别的内容，而且更长一些', 'utf8');   // 模拟"这期间被别人改了"
    r = o.checkWrite({ path: F, mode: 'replaceIfVersion', stat: fs.statSync(F) });
    ok(r.ok === false && r.code === 'FS_STALE', '§4 ★读之后文件被改过 → **拒绝**（避免覆盖中间那次改动）', r.code);
    ok(r.observedVersion !== r.currentVersion, '§4 报出了两个版本号便于排查', r.observedVersion + ' vs ' + r.currentVersion);
  }

  /* §5 大小写变体不能绕过"读过"（Windows 上最容易出的漏洞） */
  if (O.CASE_INSENSITIVE) {
    const o = O.create();
    o.noteObserved(F, fs.statSync(F), 'read');
    const alt = F.toUpperCase();
    const r = o.checkWrite({ path: alt, mode: 'replaceIfVersion', stat: fs.statSync(F) });
    ok(r.ok === true, '§5 读完再用大写路径写 → 仍被认为是同一个文件（不会被误拒）');
    const o2 = O.create();
    const r2 = o2.checkWrite({ path: alt, mode: 'replaceIfVersion', stat: fs.statSync(F) });
    ok(r2.ok === false && r2.code === 'FS_NOT_OBSERVED', '§5 反过来：没读过时换大小写也绕不过去');
  } else { ok(true, '§5 （非 Windows，跳过）'); }

  /* §6 目标不存在时按新建处理（没有可覆盖的内容，不算错） */
  {
    const o = O.create();
    const r = o.checkWrite({ path: path.join(TMP, '还不存在的文件.txt'), mode: 'replaceIfVersion', stat: null });
    ok(r.ok === true && /新建/.test(r.note || ''), '§6 目标不存在 → 放行并说明按新建处理');
  }

  /* §7 显式 overwrite 绕过一切（但必须是**显式**的） */
  {
    const o = O.create();
    const r = o.checkWrite({ path: F, mode: 'overwrite', stat: fs.statSync(F) });
    ok(r.ok === true && r.mode === 'overwrite', '§7 显式 overwrite 放行');
  }

  /* §8 写完之后要重新登记（否则连着写两次会被自己的 CAS 拦下） */
  {
    const o = O.create();
    fs.writeFileSync(F, 'v1', 'utf8');
    o.noteObserved(F, fs.statSync(F), 'read');
    ok(o.checkWrite({ path: F, mode: 'replaceIfVersion', stat: fs.statSync(F) }).ok === true, '§8 第一次写：放行');
    await sleep(20);
    fs.writeFileSync(F, 'v2', 'utf8');                        // 模拟"这次写下去了"
    o.noteObserved(F, fs.statSync(F), 'write');               // 写完要重新登记
    const r = o.checkWrite({ path: F, mode: 'replaceIfVersion', stat: fs.statSync(F) });
    ok(r.ok === true, '§8 写后重新登记 → 第二次写也放行（不会自己卡自己）');
    const o2 = O.create();
    o2.noteObserved(F, fs.statSync(F), 'read');
    await sleep(20);
    fs.writeFileSync(F, 'v3', 'utf8');
    ok(o2.checkWrite({ path: F, mode: 'replaceIfVersion', stat: fs.statSync(F) }).code === 'FS_STALE',
      '§8 对照：没重新登记就仍然是 FS_STALE（说明登记是必要的）');
  }

  /* §9 forget / clear / stats */
  {
    const o = O.create();
    o.noteObserved(F, fs.statSync(F), 'read');
    ok(o.stats().count === 1 && o.observed(F), '§9 stats/observed 正常');
    ok(o.forget(F) === true && !o.observed(F), '§9 forget 生效');
    o.noteObserved(F, fs.statSync(F), 'read');
    o.clear();
    ok(o.stats().count === 0, '§9 clear 清空');
  }

  /* §10 空路径必须被拒绝（防止把"路径拼错了"当成"新建"） */
  {
    const o = O.create();
    const r = o.checkWrite({ path: '', mode: 'createIfAbsent', stat: null });
    ok(r.ok === false && r.code === 'FS_BAD_PATH', '§10 空路径被拒', r.code);
  }

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
