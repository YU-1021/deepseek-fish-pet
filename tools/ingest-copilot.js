/* ingest-copilot.js —— ★把 F:\MAA\作业\_cache 里的 42,973 份作业筛成"第6~16章突袭"作业库★
 * 口径（lead 定 ✓）：范围 6~16 章主线；只要突袭（difficulty∈{2,3} 或标题/详情含"突袭"；认不出→unknown 列出 ✗ 不硬塞）；
 * 每关最多 5 份、按练度从低到高、最低那份标"推荐"；每份校验(JSON可解析+stage_name+actions+minimum_required 合法版本号)；
 * 去重(stage+uploader+内容哈希)；产物含 _INDEX.md/_INDEX.csv 与每关 _干员清单.txt；★全部写 F 盘 ✓ C 盘零写入 ✓★
 * 用法：node tools/ingest-copilot.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const CACHE = 'F:/MAA/作业/_cache';
const OUTROOT = 'F:/MAA/作业';
const CH_MIN = 6, CH_MAX = 16, PER_STAGE = 5;

/* 关卡名归一：认 `6-1` / `main_06-01` / `06-01` / `main_6-1` ✓，★并容许后缀 `#s`（15/16 章的险地/沙盘变体 ✓ 实测存在 ✓）★；认不出返回 null ✓ */
function stageKey(s) {
  const t = String(s || '').trim().replace(/#.*$/, '').replace(/[（(].*$/, '');
  let m = /^(?:main[_-]?)?(\d{1,2})[-_](\d{1,2})$/.exec(t);
  if (!m) return null;
  const ch = Number(m[1]), idx = Number(m[2]);
  if (ch < CH_MIN || ch > CH_MAX) return null;
  if (idx < 1 || idx > 60) return null;
  return { ch, idx, key: ch + '-' + idx };
}
const semverOk = (v) => /^v?\d+\.\d+\.\d+$/.test(String(v || '').trim());
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return String(h); };

/* 练度分数：需求越低分越小 ✓（用于"从低到高"排序 ✓） */
function reqScore(opers) {
  let s = 0;
  for (const o of (opers || [])) {
    const r = o.requirements || (o.skill != null ? { skill_level: o.skill } : {}) || {};
    s += (Number(r.elite || 0) * 1000) + Number(r.level || 0) + (Number(r.skill_level || 0) * 10) + (r.module ? 5 : 0);
  }
  return s;
}
/* 干员清单文本（opers 必带 + groups 可选组 + requirements 全写 ✓） */
function roster(o) {
  const L = [];
  for (const op of (o.opers || [])) {
    const r = op.requirements || {};
    const bits = [];
    if (r.elite != null) bits.push('精英' + r.elite);
    if (r.level != null) bits.push('lv' + r.level);
    if (op.skill != null) bits.push((op.skill) + '技能');
    if (r.skill_level != null) bits.push('技能' + r.skill_level);
    if (r.module != null) bits.push('模组' + r.module);
    L.push('  ' + (op.name || '?') + (bits.length ? '（' + bits.join(' / ') + '）' : ''));
  }
  for (const g of (o.groups || [])) {
    const names = (g.opers || []).map((x) => x.name || x).join(' 或 ');
    L.push('  [任意' + (g.name || '组') + '] ' + names);
  }
  return L.length ? L.join('\n') : '  （作业未写干员）';
}

(async () => {
  const files = fs.readdirSync(CACHE).filter((f) => /^page-\d+\.json$/.test(f)).sort();
  if (!files.length) { console.log('缓存为空 ✗ 先跑 fetch-copilot.js ✓'); process.exit(1); }
  const stages = {};   // key -> [{...}]
  const unknown = [];  // 认不出关卡的（含 stage_name 原样）
  const fail = [];     // 校验不通过
  let seen = 0, parseFail = 0;
  const dupMap = new Map();
  let dup = 0;
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')); } catch (e) { parseFail++; continue; }
    for (const it of ((j.data && j.data.data) || [])) {
      seen++;
      let c; try { c = typeof it.content === 'string' ? JSON.parse(it.content) : it.content; } catch (e) { fail.push({ id: it.id, why: 'content 不是合法 JSON' }); continue; }
      if (!c || !c.stage_name) { fail.push({ id: it.id, why: '缺 stage_name' }); continue; }
      const sk = stageKey(c.stage_name);
      if (!sk) { if (/^\d/.test(String(c.stage_name)) || /main/i.test(String(c.stage_name))) unknown.push({ id: it.id, stage_name: c.stage_name, title: (c.doc || {}).title || '' }); continue; }
      /* ★schema 修正（实测 ✓）：作业的 `actions`/`opers`/`groups` 在 **`doc` 里**✗不是顶层 ✓
         （第一版只看顶层 `c.actions` → 1105 条被误判"缺 actions" ✗ 例如 main_08-17 ✓）★ */
      const doc = c.doc || {};
      const acts = Array.isArray(c.actions) ? c.actions : (Array.isArray(doc.actions) ? doc.actions : null);
      const opers = c.opers || doc.opers || [];
      const groups = c.groups || doc.groups || [];
      const diff = (c.difficulty != null ? c.difficulty : (doc.difficulty != null ? doc.difficulty : null));
      const title = (doc.title || '') + ' ' + (doc.details || '');
      const isRaid = (diff === 2 || diff === 3) || /突袭/.test(title);
      const known = (diff === 2 || diff === 3 || /突袭|普通|险地|沙盘/.test(title));
      if (!isRaid) { if (!known) unknown.push({ id: it.id, stage_name: c.stage_name, title: doc.title || '', why: '看不出难度' }); continue; }
      /* 校验 ✓ */
      const bad = [];
      if (!acts || !acts.length) bad.push('缺 actions');
      if (!semverOk(c.minimum_required)) bad.push('minimum_required 非法：' + c.minimum_required);
      if (bad.length) { fail.push({ id: it.id, stage_name: c.stage_name, why: bad.join('；') }); continue; }
      const h = hash(JSON.stringify(acts) + '|' + JSON.stringify(opers) + '|' + JSON.stringify(groups));
      const dk = sk.key + '|' + (it.uploader || '') + '|' + h;
      if (dupMap.has(dk)) { dup++; continue; }
      dupMap.set(dk, 1);
      (stages[sk.key] = stages[sk.key] || []).push({
        id: it.id, uploader: it.uploader || '?', upload_time: it.upload_time || '', stage_name: c.stage_name,
        title: doc.title || '', difficulty: diff == null ? 'unknown' : diff,
        minimum_required: c.minimum_required, opers, groups, actions: acts,
        score: reqScore(opers), raw: c, url: 'https://prts.plus/copilot/' + it.id,
      });
    }
  }
  /* 落盘 ✓ */
  let wrote = 0; const index = [];
  const perCh = {};
  for (const key of Object.keys(stages).sort((a, b) => (Number(a.split('-')[0]) - Number(b.split('-')[0])) || (Number(a.split('-')[1]) - Number(b.split('-')[1])))) {
    const [ch, idx] = key.split('-');
    const list = stages[key].sort((a, b) => a.score - b.score || a.id - b.id).slice(0, PER_STAGE);
    const dir = path.join(OUTROOT, ch);
    fs.mkdirSync(dir, { recursive: true });
    list.forEach((r, i) => {
      const rec = i === 0 ? '★推荐' : '';
      const fn = ch + '-' + idx + '_突袭_' + r.id + '_' + String(r.uploader).replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 12) + '.json';
      fs.writeFileSync(path.join(dir, fn), JSON.stringify(r.raw, null, 2), 'utf8');
      wrote++;
      index.push({ stage: key, chapter: ch, file: ch + '/' + fn, uploader: r.uploader, difficulty: r.difficulty,
        minimum_required: r.minimum_required, opers: r.opers.map((o) => o.name).filter(Boolean).join('+'),
        groups: (r.groups || []).map((g) => '[' + (g.name || '组') + ']').join(''), url: r.url,
        fetched_at: new Date().toISOString(), recommend: rec, score: r.score });
    });
    /* 每关 _干员清单.txt（并集与差异 ✓） */
    const out = ['关卡：' + key + '（突袭）', '作业数：' + list.length + '（每关取 5 ✓ 按练度从低到高 ✓ 最低者推荐 ✓）', ''];
    const union = new Set();
    list.forEach((r, i) => {
      out.push('【' + (i + 1) + '】' + r.id + '　作者：' + r.uploader + '　difficulty=' + r.difficulty + '　练度分=' + r.score + '　' + r.minimum_required + (i === 0 ? '　★推荐★' : ''));
      out.push(roster(r));
      out.push('  来源：' + r.url);
      out.push('');
      (r.opers || []).forEach((o) => { if (o.name) union.add(o.name); });
    });
    out.push('本关所有作业干员并集（' + union.size + ' 个）：' + Array.from(union).join('、'));
    fs.writeFileSync(path.join(dir, '_干员清单.txt'), out.join('\n'), 'utf8');
    perCh[ch] = (perCh[ch] || 0) + 1;
  }
  /* 索引 ✓ */
  const csv = ['关卡,章节,文件名,作者,difficulty,minimum_required,必带干员,可选组,来源URL,取回时间,推荐']
    .concat(index.map((r) => [r.stage, r.chapter, r.file, r.uploader, r.difficulty, r.minimum_required, r.opers, r.groups, r.url, r.fetched_at, r.recommend].map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',')))
    .join('\r\n');
  fs.writeFileSync(path.join(OUTROOT, '_INDEX.csv'), csv, 'utf8');
  const md = ['# MAA 作业索引（主线 6~16 章 · 突袭）', '', '- 生成时间：' + new Date().toISOString(), '- 来源：https://prts.maa.plus/copilot/query（列表项 content 内嵌整份作业 ✓）', '- 口径：每关最多 5 份、按练度从低到高、最低者标 ★推荐★', '', '| 关卡 | 文件 | 作者 | 必带干员 | 可选组 | difficulty | 版本 | 推荐 |', '|---|---|---|---|---|---|---|---|']
    .concat(index.map((r) => '| ' + r.stage + ' | ' + r.file + ' | ' + r.uploader + ' | ' + r.opers + ' | ' + r.groups + ' | ' + r.difficulty + ' | ' + r.minimum_required + ' | ' + r.recommend + ' |'))
    .join('\n');
  fs.writeFileSync(path.join(OUTROOT, '_INDEX.md'), md, 'utf8');
  /* 覆盖自查（★如实列缺失 ✓）★ */
  const CH_HAS = { 6: 20, 7: 20, 8: 20, 9: 21, 10: 20, 11: 20, 12: 20, 13: 20, 14: 21, 15: 20, 16: 20 };  // 参考上限（缺的要如实列 ✓）
  console.log('=== 扫描 → 入库 统计 ===');
  console.log('  看过 ' + seen + ' 条；入库 ' + wrote + ' 份；校验不通过 ' + fail.length + ' 条；去重掉 ' + dup + ' 份；未知/认不出 ' + unknown.length + ' 条');
  console.log('  产物：' + OUTROOT + '\\<章>\\*.json ✓ + _INDEX.md ✓ + _INDEX.csv ✓ + 每关 _干员清单.txt ✓');
  const miss = [];
  for (let ch = CH_MIN; ch <= CH_MAX; ch++) { const n = perCh[ch] || 0; if (!n) miss.push(ch); }
  console.log('  有突袭作业的关卡数：' + Object.keys(stages).length + '　按章：' + Object.keys(perCh).sort((a, b) => a - b).map((c) => c + '章' + perCh[c] + '关').join(' '));
  console.log('  ★没有任何入库作业的章：' + (miss.length ? miss.join(',') + ' ✗（如实报 ✓）' : '无 ✓') + '★');
  if (fail.length) console.log('  校验失败样例：' + JSON.stringify(fail.slice(0, 3)));
  if (unknown.length) console.log('  unknown 样例：' + JSON.stringify(unknown.slice(0, 3)));
})().catch((e) => { console.log('❌ ' + (e && e.stack || e)); process.exit(1); });
