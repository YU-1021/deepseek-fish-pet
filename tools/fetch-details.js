/* fetch-details.js —— ★按批准的 1165 条逐条拉详情（路径式接口 ✓ 串行+延时+逐条缓存+断点续传 ✓）★
 * 接口（源码证据 ✓ maa-cli/crates/maa-cli/src/run/preset/copilot.rs L22）：
 *   `const COPILOT_API: &str = "https://prts.maa.plus/copilot/get/";` → ★路径式：/copilot/get/<id> ✓ 无需鉴权/header ★
 * 注意：响应 `data.content` 是**字符串** → 要**再解析一次**才是作业对象 ✓（判定入库标准：解析后含 actions 数组 ✓）
 * 缓存：F:\MAA\作业\_cache\detail\<id>.json ✓（已有 id 直接读 ✓ 断点续传 ✓）
 * 纪律：只拉 _INDEX_LIST.csv 里的 id ✓ 不全站拉 ✓；串行 + 1.2s 延时 ✓；5xx/超时指数退避 ×3 ✓；连续 5 次失败即停并汇报 ✓
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const LIST = 'F:/MAA/作业/_INDEX_LIST.csv';
const DETAIL = 'F:/MAA/作业/_cache/detail';
const UA = 'MAA-copilot-fetch/1.0 (personal archival; serial; cached)';
fs.mkdirSync(DETAIL, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

(async () => {
  /* 从列表索引里拿 id ✓；★支持 --ids=<文件>（重取样后的清单 ✓ lead 的"按 stage_name 选样"口径 ✓）★ */
  const idsArg = (process.argv.find((a) => a.startsWith('--ids=')) || '').split('=')[1];
  const ids = idsArg
    ? fs.readFileSync(idsArg, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((x) => /^\d+$/.test(x))
    : fs.readFileSync(LIST, 'utf8').split(/\r?\n/).slice(1)
        .map((l) => (l.split(',')[1] || '').replace(/"/g, '').trim())
        .filter((x) => /^\d+$/.test(x));
  const uniq = Array.from(new Set(ids));
  console.log('列表里待拉 id = ' + uniq.length + ' 条（去重后 ✓）');

  let ok = 0, cached = 0, failed = 0, consec = 0, noActions = 0, bytes = 0;
  const t0 = Date.now();
  for (let i = 0; i < uniq.length; i++) {
    const id = uniq[i];
    const file = path.join(DETAIL, id + '.json');
    if (fs.existsSync(file)) { cached++; consec = 0; continue; }
    let body = null;
    for (let t = 1; t <= 3 && !body; t++) {
      try {
        if (!(t === 1 && cached === 0 && ok === 0)) await sleep(t === 1 ? 1600 : 1500 * Math.pow(2, t - 1));   // ★放宽到 1.6s（1.5~2s 带 ✓ 站点可能限流 ✓；第一版是 1.2s ✓）
        else await sleep(300);
        const r = await get('https://prts.maa.plus/copilot/get/' + id);
        if (r.status === 200) body = r.body;
        else if (r.status >= 500) { failed++; console.log('  id ' + id + ' HTTP ' + r.status + ' → 退避重试 ' + t); }
        else { failed++; console.log('  id ' + id + ' HTTP ' + r.status + '（非 5xx）→ 跳过'); break; }
      } catch (e) { failed++; console.log('  id ' + id + ' 出错（' + e.message + '）→ 退避重试 ' + t); }
    }
    if (!body) {
      consec++;
      if (consec >= 5) { console.log('★连续 5 次失败 → ★停下汇报✗★（不硬撞 ✓）已拉 ' + ok + ' 条'); break; }
      continue;
    }
    consec = 0;
    /* ★解析两次（content 是字符串 ✓）+ 判定含 actions ✓ */
    try {
      const j = JSON.parse(body);
      const c = JSON.parse(j.data.content);
      if (!Array.isArray(c.actions) || !c.actions.length) { noActions++; console.log('  id ' + id + ' 解析后无 actions → 不算入库 ✓'); continue; }
      fs.writeFileSync(file, body, 'utf8');   // ★只把"解析通过"的存档 ✓
      ok++; bytes += Buffer.byteLength(body);
    } catch (e) { failed++; console.log('  id ' + id + ' 解析失败：' + String(e.message).slice(0, 40)); }
    if ((ok + cached) % 50 === 0) console.log('  进度 ' + (ok + cached) + '/' + uniq.length + '（新拉 ' + ok + ' / 缓存 ' + cached + ' / 失败 ' + failed + '）@ ' + new Date().toISOString());   // ★每 50 条（lead 要了三轮 ✓ 已改 ✓）
  }
  const fns = fs.readdirSync(DETAIL).filter((f) => /^\d+\.json$/.test(f));
  let sz = 0; for (const f of fns) sz += fs.statSync(path.join(DETAIL, f)).size;
  console.log('');
  console.log('=== 详情拉取统计 ===');
  console.log('  成功（新拉）' + ok + '　缓存命中 ' + cached + '　失败 ' + failed + '　解析后无 actions 不算入库 ' + noActions);
  console.log('  缓存文件 ' + fns.length + ' 个　' + (sz / 1048576).toFixed(1) + ' MB　目录 ' + DETAIL);
  console.log('  耗时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
