/* resample.js -- re-select chapter 6..16 jobs from the FULL cached list by stage_name only (no title bias).
 * Reads F:/MAA/作业/_cache/page-*.json (42,973 items), writes _RESAMPLE.json + resample-ids.txt (ids still needing details).
 * Per lead: if the new set is very large (>5000), STOP and report instead of fetching blindly.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const CACHE = 'F:/MAA/作业/_cache';
const DETAIL = path.join(CACHE, 'detail');
const OUT = 'F:/MAA/作业';

function norm(stage) {
  const t = String(stage || '').trim().replace(/#.*$/, '').replace(/[（(].*$/, '');
  const m = /^(?:main[_-]?)?0?(\d{1,2})[-_]0?(\d{1,2})$/.exec(t);
  if (!m) return null;
  const ch = Number(m[1]), idx = Number(m[2]);
  if (ch < 6 || ch > 16 || idx < 1 || idx > 60) return null;
  return { ch, idx, key: ch + '-' + idx };
}

const perCh = {}, stages = {};
const ids = [];
const seen = new Set();
let scanned = 0, noStage = 0;
for (const f of fs.readdirSync(CACHE).filter((x) => /^page-\d+\.json$/.test(x)).sort()) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')); } catch (e) { continue; }
  for (const it of ((j.data && j.data.data) || [])) {
    scanned++;
    let c = null;
    try { c = typeof it.content === 'string' ? JSON.parse(it.content) : it.content; } catch (e) { continue; }
    const sn = c && c.stage_name;
    if (!sn) { noStage++; continue; }
    const k = norm(sn);
    if (!k) continue;
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    ids.push(it.id);
    perCh[k.ch] = (perCh[k.ch] || 0) + 1;
    stages[k.key] = (stages[k.key] || 0) + 1;
  }
}
const cached = new Set(fs.existsSync(DETAIL) ? fs.readdirSync(DETAIL).filter((f) => /^\d+\.json$/.test(f)).map((f) => Number(f.replace('.json', ''))) : []);
const need = ids.filter((id) => !cached.has(id));
console.log('=== 按 stage_name 重取样（全量列表 ' + scanned + ' 条 ✓ 不看标题 ✓）===');
console.log('  命中 6~16 章（含 #s 后缀 / main_6-xx 写法 ✓）：**' + ids.length + ' 条**');
console.log('  按章：' + Object.keys(perCh).sort((a, b) => a - b).map((c) => c + '章 ' + perCh[c]).join(' | '));
console.log('  覆盖关卡 ' + Object.keys(stages).length + ' 个');
console.log('  已在详情缓存里的 ' + (ids.length - need.length) + ' 条；★还需补拉 ' + need.length + ' 条★');
console.log('  ' + (need.length > 5000 ? '★★新集合很大（>5000）→ 按 lead 要求**停下报数字**，不闷头拉 ✗★' : '★在可接受范围内（≤5000）→ 可以补拉 ✓★'));
console.log('  无 stage_name 的条目 ' + noStage + ' 条（跳过 ✓）');
fs.writeFileSync(path.join(OUT, '_RESAMPLE.json'), JSON.stringify({ at: new Date().toISOString(), scanned, matched: ids.length, perCh, stages: Object.keys(stages).length, cachedAlready: ids.length - need.length, needFetch: need.length, stopRequired: need.length > 5000 }, null, 2));
fs.writeFileSync(path.join(CACHE, 'resample-ids.txt'), need.join('\n'), 'utf8');
console.log('  产物：F:\\MAA\\作业\\_RESAMPLE.json ✓ + _cache\\resample-ids.txt（' + need.length + ' 个 id ✓ 可直接喂给 fetch-details 的逻辑 ✓）');
