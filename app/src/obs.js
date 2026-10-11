/* 读后写 / CAS 版本（observation policy）—— 抄自 DSH 的 dsh-fs-observation-policy
 *
 * 【为什么】原来对"写文件"唯一的防线是 projects.safePath 的**越界检查**（别写到项目目录外面去）。
 *   但**盲写覆盖**没有任何防线：她（或我）可以不去看一个文件，直接把它整个替换掉 ——
 *   如果那文件在这期间被改过（用户自己改的、上一轮改的），改动就**静默消失**了。
 *   这正是"静默数据丢失"这一类最难查的事故。
 *
 * 【DSH 怎么做（dsh-fs-observation-policy/lib/index.js）】
 *   · :64 `editIntent` 对**没有被观测过**的目标抛 `FS_NOT_OBSERVED`；
 *   · :51 写意图只有两种：`createIfAbsent`（只新建）和 `replaceIfVersion`（按版本替换）；
 *   · :22 状态是 `WeakMap<session, Map<targetKey, {kind, version}>>`，由 `fs/*-intent` 事件驱动
 *     —— 也就是说"读过"这件事本身是**被记录的事件**，不是靠调用方自觉。
 *
 * 【本模块的取舍】
 *   · 版本用 **mtimeMs + size** 拼（够用、零依赖；DSH 那边另有内容哈希，这里不必）；
 *   · ⚠️ **Windows 路径大小写不敏感**：同一个文件写成 `C:\a\B.txt` 和 `c:\A\b.txt` 必须算同一个键，
 *     否则"读过了"这件事会被绕过（§3 专门测这条）；
 *   · 相对路径先 resolve 成绝对路径再当键，否则 `./x` 和 `x` 会变成两把钥匙；
 *   · 判定只**返回结果**，不抛异常 —— 调用方要把 code 变成一句能指导下一步的话交回模型。
 */
'use strict';

const path = require('path');

/* Windows: 大小写不敏感 → 键要统一小写。其它平台保持原样。 */
const CASE_INSENSITIVE = process.platform === 'win32';

function keyOf(p) {
  let s = String(p == null ? '' : p).trim();
  if (!s) return '';
  try { s = path.resolve(s); } catch {}
  /* 去掉尾部分隔符（'C:\a\' 与 'C:\a' 是同一个目标） */
  s = s.replace(/[\\/]+$/, '');
  return CASE_INSENSITIVE ? s.toLowerCase() : s;
}

function versionOf(stat) {
  if (!stat) return '';
  return String(Math.round(Number(stat.mtimeMs) || 0)) + ':' + String(Number(stat.size) || 0);
}

function create() {
  const seen = new Map();   // key → { kind, version, at, displayPath }

  /* 记一次"我看过这个文件"（kind: 'read' | 'write'） */
  function noteObserved(displayPath, stat, kind) {
    const k = keyOf(displayPath);
    if (!k) return null;
    const rec = { kind: kind || 'read', version: versionOf(stat), at: Date.now(), displayPath: String(displayPath) };
    seen.set(k, rec);
    return rec;
  }

  function observed(displayPath) {
    const k = keyOf(displayPath);
    return k ? (seen.get(k) || null) : null;
  }

  function forget(displayPath) {
    const k = keyOf(displayPath);
    return k ? seen.delete(k) : false;
  }

  /* 写之前的检查。
   * 入参：{ path, mode: 'createIfAbsent'|'replaceIfVersion'|'overwrite', stat }
   *   stat = 目标**当前**的 fs.statSync 结果（不存在则 null）
   * 返回：{ ok:true } 或 { ok:false, code, message }
   *   FS_EXISTS        createIfAbsent 但目标已存在
   *   FS_NOT_OBSERVED  replaceIfVersion 但没读过这个文件
   *   FS_STALE         读过，但文件在这之后被改过（版本不一致）—— 这才是 CAS
   */
  function checkWrite(o) {
    const target = o && o.path;
    const mode = (o && o.mode) || 'replaceIfVersion';
    const stat = (o && o.stat) || null;
    const display = String(target == null ? '' : target);
    if (!keyOf(display)) return { ok: false, code: 'FS_BAD_PATH', message: '文件路径为空，没法写。' };

    if (mode === 'overwrite') return { ok: true, mode };

    if (mode === 'createIfAbsent') {
      if (stat) {
        return { ok: false, code: 'FS_EXISTS', mode,
          message: '「' + display + '」**已经存在**了，而这一步是"只新建"。'
            + '要么换个新名字，要么先 read_file 读它、确认要改哪里，再用覆盖方式写。' };
      }
      return { ok: true, mode };
    }

    /* replaceIfVersion：必须先读过，而且版本要对得上 */
    const rec = observed(display);
    if (!stat) {
      /* 目标不存在：按"新建"处理（没有可覆盖的东西，不会丢数据） */
      return { ok: true, mode, note: '目标还不存在，按新建处理' };
    }
    if (!rec) {
      return { ok: false, code: 'FS_NOT_OBSERVED', mode,
        message: '「' + display + '」**已经存在**，但你还没读过它就打算写 —— 那样会把它原有内容整个覆盖掉。'
          + '先 read_file 读一遍（顺便确认要改的是哪一段），然后再写。' };
    }
    const nowVer = versionOf(stat);
    if (rec.version !== nowVer) {
      return { ok: false, code: 'FS_STALE', mode, observedVersion: rec.version, currentVersion: nowVer,
        message: '「' + display + '」**在你读过之后又被改过了**（你读到时是 ' + rec.version + '，现在是 ' + nowVer + '）。'
          + '为了避免把中间那次改动覆盖掉，这次不写 —— 请重新 read_file 看一眼现在的内容，再决定怎么改。' };
    }
    return { ok: true, mode };
  }

  function stats() {
    const out = [];
    for (const [k, v] of seen) out.push({ key: k, kind: v.kind, version: v.version, displayPath: v.displayPath });
    return { count: out.length, entries: out };
  }

  function clear() { seen.clear(); }

  return { noteObserved, observed, forget, checkWrite, stats, clear, keyOf, versionOf };
}

module.exports = { create, keyOf, versionOf, CASE_INSENSITIVE };
