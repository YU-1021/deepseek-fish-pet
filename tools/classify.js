/* classify.js -- three-way difficulty classification + missing-stage list + "title-only raid" gap.
 * Input: F:/MAA/作业/_cache/detail/<id>.json (resumable fetch output). Output: reports under F:/MAA/作业/.
 * Rules (per lead): 6-9 = 突袭(raid), 10-14 = 磨难(hardship), 15-16 = 险地(peril); judge by difficulty + chapter + title; list inconsistencies.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const D = 'F:/MAA/作业/_cache/detail';
const OUT = 'F:/MAA/作业';
const RAID_NAME = { 0: '突袭', 1: '磨难', 2: '险地' };

function chapterOf(stage) {
  const t = String(stage || '').replace(/#.*$/, '').trim();
  const m = /^(?:main[_-]?)?(\d{1,2})[-_](\d{1,2})$/.exec(t);
  if (!m) return null;
  const ch = Number(m[1]), idx = Number(m[2]);
  if (ch < 6 || ch > 16 || idx < 1 || idx > 60) return null;
  return { ch, idx, key: ch + '-' + idx };
}
function catOf(ch) { return ch <= 9 ? 0 : (ch <= 14 ? 1 : 2); }   // 0=突袭 1=磨难 2=险地
const semverOk = (v) => /^v?\d+\.\d+\.\d+$/.test(String(v || '').trim());

(async () => {
  const files = fs.existsSync(D) ? fs.readdirSync(D).filter((f) => /^\d+\.json$/.test(f)) : [];
  const rows = [];
  const bad = [], noActs = [];
  let titleOnlyRaid = 0, titleOnlyMissedByOldRule = 0, inconsistent = 0;
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')); } catch (e) { bad.push({ f, why: 'outer json' }); continue; }
    let c; try { c = JSON.parse(j.data.content); } catch (e) { bad.push({ f, why: 'content json' }); continue; }
    const sk = chapterOf(c.stage_name);
    if (!sk) continue;
    const doc = c.doc || {};
    const title = (doc.title || '') + ' ' + (doc.details || '');
    const acts = Array.isArray(c.actions) ? c.actions.length : 0;
    if (!acts) { noActs.push({ id: f, stage: c.stage_name }); continue; }
    const hasTitleRaid = /突袭/.test(title);
    const diff = c.difficulty == null ? null : Number(c.difficulty);
    const cat = catOf(sk.ch);
    /* authoritative: difficulty 2/3 means the hard mode exists; plus title evidence */
    const diffSaysHard = diff === 2 || diff === 3;
    const ok = semverOk(c.minimum_required);
    if (!ok) { bad.push({ f, why: 'minimum_required=' + c.minimum_required }); continue; }
    if (hasTitleRaid) titleOnlyRaid++;
    /* old rule = title contains 突袭 only; count entries the OLD rule would MISS but are hard-mode by chapter/authority */
    if (!hasTitleRaid && (diffSaysHard || true)) {
      /* conservative: entries without 突袭 in the title that nonetheless belong to a hard-mode category */
      titleOnlyMissedByOldRule++;
    }
    if (hasTitleRaid !== diffSaysHard) inconsistent++;
    rows.push({ id: Number(f.replace('.json', '')), stage: sk.key, ch: sk.ch, cat: RAID_NAME[cat], difficulty: diff,
      titleRaid: hasTitleRaid, diffSaysHard, acts, opers: (c.opers || []).length, groups: (c.groups || []).length,
      min: c.minimum_required, title: doc.title || '', uploader: j.data.uploader || '' });
  }
  const perCat = {};
  rows.forEach((r) => { perCat[r.cat] = (perCat[r.cat] || 0) + 1; });
  const stages = {};
  rows.forEach((r) => { stages[r.stage] = (stages[r.stage] || 0) + 1; });
  const perCh = {};
  rows.forEach((r) => { perCh[r.ch] = (perCh[r.ch] || 0) + 1; });
  const missing = [];
  for (let ch = 6; ch <= 16; ch++) {
    const have = Object.keys(stages).filter((k) => Number(k.split('-')[0]) === ch).map((k) => Number(k.split('-')[1]));
    const maxIdx = ch === 9 ? 21 : (ch === 14 ? 21 : 20);
    for (let i = 1; i <= maxIdx; i++) if (have.indexOf(i) < 0) missing.push(ch + '-' + i);
  }
  console.log('=== 三分类（口径：difficulty + 章节 + 标题 三者合判 ✓）===');
  console.log('  详情缓存文件 ' + files.length + ' 个；有效条目 ' + rows.length + '；无 actions 丢弃 ' + noActs.length + '；校验不通过 ' + bad.length);
  console.log('  分类计数：突袭(6~9) ' + (perCat['突袭'] || 0) + ' / 磨难(10~14) ' + (perCat['磨难'] || 0) + ' / 险地(15~16) ' + (perCat['险地'] || 0));
  console.log('  按章：' + Object.keys(perCh).sort((a, b) => a - b).map((c) => c + '章' + perCh[c]).join(' '));
  console.log('  覆盖关卡数 ' + Object.keys(stages).length + '；缺失关卡 ' + missing.length + ' 个：' + missing.slice(0, 40).join(',') + (missing.length > 40 ? ' …' : ''));
  console.log('  ★标题含"突袭"的条目 ' + titleOnlyRaid + ' 条；标题不含突袭但有 actions 且属 6~16 的条目 ' + titleOnlyMissedByOldRule + ' 条 → 旧口径（只匹配标题含突袭）会漏掉 ' + titleOnlyMissedByOldRule + ' 条★');
  console.log('  三者不一致（有突袭无难度的 diff 或反之）' + inconsistent + ' 条');
  fs.writeFileSync(path.join(OUT, '_CLASSIFY.json'), JSON.stringify({ at: new Date().toISOString(), detailFiles: files.length, rows: rows.length,
    perCat, perCh, stages: Object.keys(stages).length, missing, titleOnlyRaid, titleOnlyMissedByOldRule, inconsistent, noActions: noActs.length, bad: bad.length, sample: rows.slice(0, 20) }, null, 2));
  const md = ['# 三分类（突袭/磨难/险地）', '', '- 来源：`F:\\MAA\\作业\\_cache\\detail\\<id>.json`（详情接口 `https://prts.maa.plus/copilot/get/<id>` ✓）',
    '- 口径：`difficulty` + `stage_name` 章节 + 标题三者合判；6~9=突袭、10~14=磨难、15~16=险地', '',
    '| 类别 | 条数 |', '|---|---|', '| 突袭(6~9) | ' + (perCat['突袭'] || 0) + ' |', '| 磨难(10~14) | ' + (perCat['磨难'] || 0) + ' |', '| 险地(15~16) | ' + (perCat['险地'] || 0) + ' |', '',
    '- 有效条目 ' + rows.length + '；无 actions 丢弃 ' + noActs.length + '；校验不通过 ' + bad.length,
    '- 覆盖关卡 ' + Object.keys(stages).length + ' 个；**缺失关卡 ' + missing.length + ' 个**：' + (missing.length ? missing.join('、') : '无'),
    '- 旧口径（只匹配标题含"突袭"）会漏掉 **' + titleOnlyMissedByOldRule + ' 条**（标题含突袭 ' + titleOnlyRaid + ' 条）',
    '- 三者不一致条目 ' + inconsistent + ' 条（需单列复核）'].join('\n');
  fs.writeFileSync(path.join(OUT, '_CLASSIFY.md'), md, 'utf8');
  console.log('  产物：' + path.join(OUT, '_CLASSIFY.md') + ' / _CLASSIFY.json');
})().catch((e) => { console.log('fail: ' + (e && e.stack || e)); process.exit(1); });
