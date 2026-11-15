/* fetch-copilot.js —— ★批量拉取 prts.maa.plus 的 copilot 作业（串行+延时+缓存+断点续传 ✓）★
 * 接口（已实测 ✓）：GET https://prts.maa.plus/copilot/query?page=N&limit=2000
 *   · limit **不封顶** ✓（实测 limit=2000 返回 2000 条 ✓）→ 全站 42,973 条约 22 次请求 ✓（不是 430 ✓）
 *   · 每条列表项的 `content` 字段**内嵌整份作业 JSON** ✓（含 stage_name/minimum_required/doc ✓）→ 无需详情请求 ✓
 * 缓存：F:\MAA\作业\_cache\page-NNNN.json（★一律 F 盘，C 盘零写入 ✓）；已存在则直接读缓存 ✓ 不重下 ✓
 * 纪律：串行 ✓ 每请求 1.2s 延时 ✓ 5xx/超时指数退避重试 ×3 ✓ 连续失败即停并汇报 ✓ 不并发 ✓
 * 用法：node tools/fetch-copilot.js [--limit=2000] [--maxPages=999]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const argv = process.argv.slice(2);
const getArg = (k, d) => { const m = argv.find((a) => a.startsWith('--' + k + '=')); return m ? m.split('=')[1] : d; };
const LIMIT = Number(getArg('limit', 2000));
const MAXP = Number(getArg('maxPages', 999));
const CACHE = 'F:/MAA/作业/_cache';
const UA = 'MAA-copilot-fetch/1.0 (personal archival; serial; cached)';
fs.mkdirSync(CACHE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function get(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(timeoutMs || 40000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

(async () => {
  let page = 1, total = null, items = 0, pagesDone = 0, cached = 0, bytes = 0, fails = 0;
  const t0 = Date.now();
  while (page <= MAXP) {
    const file = path.join(CACHE, 'page-' + String(page).padStart(4, '0') + '.json');
    let body = null;
    if (fs.existsSync(file)) { body = fs.readFileSync(file, 'utf8'); cached++; }
    else {
      let ok = false;
      for (let tryN = 1; tryN <= 3 && !ok; tryN++) {
        try {
          await sleep(tryN === 1 ? 1200 : 1500 * Math.pow(2, tryN - 1));   // ★延时 + 退避 ✓ 串行 ✓
          const r = await get('https://prts.maa.plus/copilot/query?page=' + page + '&limit=' + LIMIT, 45000);
          if (r.status === 200) { body = r.body; ok = true; }
          else if (r.status >= 500) { fails++; console.log('  第 ' + page + ' 页 HTTP ' + r.status + ' → 退避重试 ' + tryN); }
          else { console.log('★第 ' + page + ' 页 HTTP ' + r.status + '（非 5xx）→ 停 ✓ 汇报 ✓'); break; }
        } catch (e) { fails++; console.log('  第 ' + page + ' 页出错（' + e.message + '）→ 退避重试 ' + tryN); }
      }
      if (!body) { console.log('★第 ' + page + ' 页三次都失败 → ★停下并汇报✗★（不硬撞 ✓）'); break; }
      fs.writeFileSync(file, body, 'utf8');
      bytes += Buffer.byteLength(body);
    }
    let j;
    try { j = JSON.parse(body); } catch (e) { console.log('★第 ' + page + ' 页 JSON 解析失败 → 停 ✓'); break; }
    const d = j && j.data;
    if (!d) { console.log('★第 ' + page + ' 页没有 data → 停 ✓'); break; }
    if (total == null) total = d.total;
    items += (d.data || []).length;
    pagesDone++;
    console.log('  第 ' + page + ' 页 ✓ 本页 ' + (d.data || []).length + ' 条　累计 ' + items + '/' + total + '　has_next=' + d.has_next);
    if (!d.has_next) { console.log('  ★has_next=false → 扫完 ✓★'); break; }
    page++;
  }
  const cacheFiles = fs.readdirSync(CACHE).filter((f) => /^page-\d+\.json$/.test(f));
  let cacheBytes = 0; for (const f of cacheFiles) cacheBytes += fs.statSync(path.join(CACHE, f)).size;
  console.log('');
  console.log('=== 扫描统计（★先报统计，再筛选入库 ✓）===');
  console.log('  总页数 ' + pagesDone + '（缓存命中 ' + cached + ' 页 ✓ 新下 ' + (pagesDone - cached) + ' 页）');
  console.log('  总条数 ' + items + ' / 站点 total ' + total + '　耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('  缓存文件 ' + cacheFiles.length + ' 个　缓存大小 ' + (cacheBytes / 1048576).toFixed(1) + ' MB　目录 ' + CACHE);
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
