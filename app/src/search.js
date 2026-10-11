/* 代码内容搜索（B2）—— 她有 list_dir 但**没有"哪个文件里有这个函数"**的能力
 *
 * 【为什么需要】用户提的"后面要写程序"里，最常用的一步就是内容搜索：
 *   "这个函数在哪定义" / "谁调用了它" / "整个项目里哪里写了这个配置"。
 *   list_dir 只能看目录名 ✗，read_file 要一个一个试 ✗ —— 实测很浪费步数。
 *
 * 【为什么自己写而不是接 MCP / 用 rg】
 *   · 她那边没有 ripgrep ✗（DSH 自带的那份在 DSH 的 node_modules 里，不该跨程序借 ✓）
 *   · 接一个 MCP 只为"搜文本"太重 ✗（要 client / 生命周期 / 权限映射 ✓）—— 这正是之前判据里
 *     "不需要独立依赖 → 自己写"那一类 ✓
 *   · 纯 Node 走 fs + 正则，零依赖、零安装、行为完全可控 ✓✓
 *
 * 【设计上的几个安全阀（都是防"卡死/淹死"）】
 *   · 跳过 node_modules / .git / dist / build / __pycache__ 这类目录（否则一个搜索几十万文件）
 *   · 跳过二进制/媒体扩展名，跳过 >2MB 的文件（读进来也没意义，还卡）
 *   · 总时长预算（默认 15 秒）—— 到点就返回**已经找到的**，并说明"没搜完" ✓（不谎报"没有"）
 *   · 命中数上限（默认 60 条）—— 够她判断趋势，不至于把上下文淹掉
 *   · 正则写错时**回落到字面量匹配**并说明 ✓（不然她只会收到一个语法错，然后放弃）
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* 忽略目录：★实测第一版漏了 .pw-browsers，它里面有整个 chromium 缓存（几万个文件）★，
   于是搜一个词要扫 287 个文件、4.6 秒 —— 补上浏览器缓存类目录后降到几十毫秒 ✓ */
const SKIP_DIR = /^(node_modules|\.git|\.hg|\.svn|dist|build|out|\.next|\.nuxt|__pycache__|\.venv|venv|env|target|coverage|\.idea|\.vscode|bower_components|\.cache|\.dsh|\.pw-browsers|Cache|Code Cache|GPUCache|CachedData|Crashpad|blob_storage|Service Worker|IndexedDB|Local Storage|Session Storage|\.pnpm|\.yarn|\.turbo|\.parcel-cache|\.pytest_cache|\.mypy_cache|\.tox|site-packages|vendor|third_party|Pods|DerivedData)$/i;
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|7z|rar|gz|tar|bz2|xz|exe|dll|so|dylib|node|o|a|lib|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|mkv|wav|flac|bin|dat|db|sqlite3?|asar|pyc|class|jar|iso|img)$/i;
const MAX_FILE = 2 * 1024 * 1024;      // 单文件超过 2MB 不读
const MAX_FILES = 8000;                // 一次搜索最多扫这么多文件（再多就明显是搜错目录了）

/* 把用户给的模式变成一个可用的正则：
   先按正则试；语法错就当成**字面量**（转义后）再试 —— 并把这个降级如实告诉调用方 ✓ */
function makeMatcher(pattern, caseSensitive) {
  const flags = caseSensitive ? '' : 'i';
  try { return { re: new RegExp(pattern, flags), literal: false }; }
  catch (e) {
    const esc = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { re: new RegExp(esc, flags), literal: true, note: '正则语法有误，已按**字面量**匹配：' + ((e && e.message) || e) };
  }
}

/* 递归收集候选文件（带预算：目录数、深度都要有闸门） */
function collect(root, exts, budget, st) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    if (Date.now() > budget) { st.truncated = true; break; }
    const { dir, depth } = stack.pop();
    if (depth > 12) continue;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      if (Date.now() > budget) { st.truncated = true; break; }
      if (e.isDirectory()) {
        if (SKIP_DIR.test(e.name)) { st.skippedDirs++; continue; }
        stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      } else if (e.isFile()) {
        if (SKIP_EXT.test(e.name)) { st.skippedFiles++; continue; }
        if (exts && exts.length) {
          const ext = path.extname(e.name).replace(/^\./, '').toLowerCase();
          if (exts.indexOf(ext) < 0) { st.skippedExt++; continue; }
        }
        out.push(path.join(dir, e.name));
        if (out.length >= MAX_FILES) { st.truncated = true; return out; }
      }
    }
  }
  return out;
}

/* 主入口：pattern 正则或字面量；root 目录；opts { exts, maxHits, timeoutMs, caseSensitive } */
function search(pattern, root, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const timeoutMs = Math.max(1000, Math.min(60000, Number(o.timeoutMs) || 15000));
  const budget = t0 + timeoutMs;
  const maxHits = Math.max(1, Math.min(500, Number(o.maxHits) || 60));
  const st = { skippedDirs: 0, skippedFiles: 0, skippedExt: 0, readErrors: 0, truncated: false };
  const m = makeMatcher(pattern, !!o.caseSensitive);
  const hits = [];
  let scanned = 0, matchedFiles = 0;

  let abs = path.resolve(String(root || '.'));
  let stat = null;
  try { stat = fs.statSync(abs); } catch (e) { return { ok: false, error: '目录不存在或读不了：' + abs }; }

  const files = stat.isFile() ? [abs] : collect(abs, o.exts, budget, st);
  for (const f of files) {
    if (Date.now() > budget) { st.truncated = true; break; }
    let size = 0;
    try { size = fs.statSync(f).size; } catch (e) { st.readErrors++; continue; }
    if (size > MAX_FILE) { st.skippedFiles++; continue; }
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { st.readErrors++; continue; }
    if (text.indexOf('\u0000') >= 0) { st.skippedFiles++; continue; }   // 二进制
    scanned++;
    const lines = text.split(/\r?\n/);
    let fileHit = false;
    for (let i = 0; i < lines.length; i++) {
      if (m.re.test(lines[i])) {
        if (!fileHit) { fileHit = true; matchedFiles++; }
        hits.push({
          file: f, line: i + 1,
          text: lines[i].replace(/\t/g, '  ').trim().slice(0, 200),
        });
        if (hits.length >= maxHits) { st.truncated = true; break; }
      }
    }
    if (hits.length >= maxHits) break;
  }

  return {
    ok: true, hits, scanned, matchedFiles, ms: Date.now() - t0,
    truncated: st.truncated, literalFallback: !!m.literal, matcherNote: m.note || '',
    skipped: { dirs: st.skippedDirs, files: st.skippedFiles, ext: st.skippedExt, readErrors: st.readErrors },
  };
}

module.exports = { search, makeMatcher, SKIP_DIR, SKIP_EXT };
