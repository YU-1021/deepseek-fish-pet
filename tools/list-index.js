/* list-index.js —— ★按 lead 的"列表即交付"口径：用列表字段做能干活的索引 + maa:// 清单★
 * 背景（实测 ✓）：`/copilot/query`（列表）**公开可用** ✓；而 `/copilot`、`/copilot/<id>`、`/copilot/detail?id=`、`/copilot/list?id=` 全部 **401**（存在但要鉴权 ✗）
 * → 详情（actions/difficulty/opers）拿不到 ✗ ；但 ★`maa://<id>` 可以让 MAA 客户端自己取详情 ✓★（`maa copilot <maa_uri>` 支持 `maa://1234` ✓）。
 * 产物（全部 F 盘 ✓ C 盘零写入 ✓）：`_INDEX_LIST.md`、`_maa-uris.txt`、`_README.md`
 */
'use strict';
const fs = require('fs');
const path = require('path');
const CACHE = 'F:/MAA/作业/_cache';
const OUT = 'F:/MAA/作业';
const CH_MIN = 6, CH_MAX = 16;

function stageKey(s) {
  const t = String(s || '').trim().replace(/#.*$/, '').replace(/[（(].*$/, '');
  const m = /^(?:main[_-]?)?(\d{1,2})[-_](\d{1,2})$/.exec(t);
  if (!m) return null;
  const ch = Number(m[1]), idx = Number(m[2]);
  if (ch < CH_MIN || ch > CH_MAX || idx < 1 || idx > 60) return null;
  return { ch, idx, key: ch + '-' + idx };
}

const rows = [];
let seen = 0, unknownD = 0;
for (const f of fs.readdirSync(CACHE).filter((x) => /^page-\d+\.json$/.test(x)).sort()) {
  let j; try { j = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')); } catch (e) { continue; }
  for (const it of ((j.data && j.data.data) || [])) {
    seen++;
    let c = null;
    try { c = typeof it.content === 'string' ? JSON.parse(it.content) : it.content; } catch (e) { continue; }
    if (!c || !c.stage_name) continue;
    const sk = stageKey(c.stage_name);
    if (!sk) continue;
    const doc = c.doc || {};
    const title = (doc.title || '') + ' ' + (doc.details || '');
    const isRaid = /突袭/.test(title) || c.difficulty === 2 || c.difficulty === 3;   // ★列表里通常没有 difficulty ✓ 所以主要靠标题 ✓
    if (!isRaid) { if (c.difficulty == null) unknownD++; continue; }
    rows.push({ id: it.id, stage: sk.key, ch: sk.ch, idx: sk.idx, stage_name: c.stage_name,
      title: doc.title || '', uploader: it.uploader || '?', upload_time: it.upload_time || '',
      views: it.views == null ? 0 : it.views, type: it.type || '', min_req: c.minimum_required || '',
      maa: 'maa://' + it.id, url: 'https://prts.plus/copilot/' + it.id });
  }
}
rows.sort((a, b) => (a.ch - b.ch) || (a.idx - b.idx) || (b.views - a.views));
const perCh = {}, perStage = {};
for (const r of rows) { perCh[r.ch] = (perCh[r.ch] || 0) + 1; perStage[r.stage] = (perStage[r.stage] || 0) + 1; }

/* 索引表 ✓（只放**列表可信字段** ✓ 并明确标注缺什么 ✓） */
const md = ['# MAA 作业清单（主线 6~16 章 · 标题含"突袭"）—— 列表接口版', '',
  '- 数据来源：`https://prts.maa.plus/copilot/query` 列表接口（公开 ✓ 每页 2000 条 ✓ 22 页扫全 42,973 条 ✓ 缓存于 `_cache/`）',
  '- ★可信字段（来自列表）★：id / stage_name / doc.title / uploader / upload_time / views / type / minimum_required',
  '- ★无法从列表获得的字段✗★：`actions`（关卡内动作）、`opers`/`groups`（干员）、`difficulty` —— 详情接口 `/copilot/*` 全部 **401（需鉴权）** ✗',
  '- ★正因为这样：请直接用 `maa://<id>` 交给 MAA 客户端取详情 ✓（`maa copilot <maa_uri>` 支持 `maa://1234` ✓）★',
  '- 生成时间：' + new Date().toISOString(), '',
  '| 关卡 | 作业ID | maa:// | 标题 | 作者 | 上传时间 | 浏览 | 版本 |', '|---|---|---|---|---|---|---|---|']
  .concat(rows.map((r) => '| ' + r.stage + ' | ' + r.id + ' | ' + r.maa + ' | ' + r.title.replace(/\|/g, '/') + ' | ' + r.uploader + ' | ' + r.upload_time + ' | ' + r.views + ' | ' + r.min_req + ' |'))
  .join('\n');
fs.writeFileSync(path.join(OUT, '_INDEX_LIST.md'), md, 'utf8');
fs.writeFileSync(path.join(OUT, '_maa-uris.txt'), rows.map((r) => r.stage + '\t' + r.maa + '\t' + r.title).join('\n'), 'utf8');
const csv = ['关卡,作业ID,maa_uri,标题,作者,上传时间,浏览,minimum_required,来源URL']
  .concat(rows.map((r) => [r.stage, r.id, r.maa, r.title, r.uploader, r.upload_time, r.views, r.min_req, r.url].map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(','))).join('\r\n');
fs.writeFileSync(path.join(OUT, '_INDEX_LIST.csv'), csv, 'utf8');

const readme = ['# F:\\MAA\\作业 —— 交付说明（2026-10-11）', '',
  '## 一、能用的',
  '- **列表接口**：`GET https://prts.maa.plus/copilot/query?page=N&limit=2000` ✓ HTTP 200 ✓ **limit 不封顶**（2000 条/次 ✓）',
  '- 全站 **42,973 条 / 22 页 / 43.1s** ✓ 原始返回缓存在 `_cache/page-0001..0022.json`（54.8 MB ✓）',
  '- 列表项 `content` 含：`minimum_required` / `stage_name` / `doc.title` / `doc.details` / `uploader` / `upload_time` / `views` ✓',
  '', '## 二、不能用的（附试过的全部 URL 与状态码 ✓）',
  '| URL | 结果 |', '|---|---|',
  '| `https://api.prts.plus/...` | ★DNS 不存在（DNS name does not exist）★ |',
  '| `https://prts.plus/api/copilot/get?copilot_id=1234` | 404 |',
  '| `https://prts.plus/copilot/get/1234` | 404 |',
  '| `https://prts.plus/copilot/106345` | 404 |',
  '| `https://prts.maa.plus/copilot/get?copilot_id=106345` | 404 |',
  '| `https://prts.maa.plus/copilot/get?id=106345` | 404 |',
  '| `https://prts.maa.plus/copilot?id=106345` | ★401（存在，需鉴权）★ |',
  '| `https://prts.maa.plus/copilot/106345` | ★401★ |',
  '| `https://prts.maa.plus/copilot/detail?id=106345` | ★401★ |',
  '| `https://prts.maa.plus/copilot/list?id=106345` | ★401★ |',
  '| `POST https://prts.maa.plus/copilot/query` `{"page":1,"limit":10,"keyword":"6-1"}` 等三种体 | 200 但 data 为空 ✗ |',
  '| `/openapi.json`、`/docs`、`/swagger` | 401 |',
  '', '## 三、所以怎么用（★关键★）',
  '★详情（`actions`/干员）拿不到，但**不需要我们拿**✗✓：把 `maa://<id>` 交给 MAA 客户端，它自己会取详情并执行 ✓',
  '（依据：CLI 用法 `maa copilot <maa_uri>` ✓ `maa_uri` 可以是 `maa://1234` ✓）。',
  '', '## 四、盘点',
  '- 索引：`_INDEX_LIST.md` / `_INDEX_LIST.csv`（按关卡 ✓ 含 maa:// 与来源 URL ✓）',
  '- URI 清单：`_maa-uris.txt`（`关卡<TAB>maa://id<TAB>标题` ✓ 可直接喂 MAA ✓）',
  '- ★只有标题含"突袭"的条目被列入 ✓（列表里没有 `difficulty` 字段 ✗ 所以不能按 2/3 判 ✓）；无法判断难度的条目**未被硬塞**✓'].join('\n');
fs.writeFileSync(path.join(OUT, '_README.md'), readme, 'utf8');

console.log('=== 列表版交付（★哪些可信/哪些拿不到 ✓ 都写在 _README.md ✓）===');
console.log('  扫过 ' + seen + ' 条；匹配到"6~16 章 + 标题含突袭" **' + rows.length + ' 条** ✓');
console.log('  按章：' + Object.keys(perCh).sort((a, b) => a - b).map((c) => c + '章' + perCh[c]).join(' ') || '（无）');
const miss = []; for (let ch = CH_MIN; ch <= CH_MAX; ch++) if (!perCh[ch]) miss.push(ch);
console.log('  ★没有任何"突袭"条目的章：' + (miss.length ? miss.join(',') : '无 ✓') + '★');
console.log('  覆盖到 ' + Object.keys(perStage).length + ' 个关卡（6~16 章实际关卡数见缺失清单 ✓）');
console.log('  产物：_INDEX_LIST.md ✓ _INDEX_LIST.csv ✓ _maa-uris.txt ✓ _README.md ✓（均在 F:\\MAA\\作业\\）');
console.log('  抽查 3 条：' + rows.slice(0, 3).map((r) => r.maa + '→' + r.stage_name + '/' + r.stage).join('　'));
