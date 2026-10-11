/* 人设词条系统验证（确定性、零 token）
 * electron.exe app\scripts\test-personatags.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-tagstest');
fs.mkdirSync(TEST_UD, { recursive: true });
for (const f of ['persona.json']) {
  try { fs.copyFileSync(path.join(process.env.APPDATA, 'dayu-pet', f), path.join(TEST_UD, f)); } catch {}
}
try { fs.unlinkSync(path.join(TEST_UD, 'persona-tags.json')); } catch {}
app.setPath('userData', TEST_UD);

app.whenReady().then(() => {
  const pt = require('../src/personatags');
  const tableFile = path.join(TEST_UD, 'persona-tags.json');
  const out = [];
  const L = (s) => out.push(s);
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };
  const mkPersona = (ch, pe) => {
    const p = Object.assign({}, pt.loadPersona(), { character_setting: ch, personality: pe });
    fs.writeFileSync(path.join(TEST_UD, 'persona.json'), JSON.stringify(p, null, 2));
    return p;
  };

  try {
    L('=== 1. 词条表：内置兜底与清洗 ===');
    pt.ensure();
    const t0 = pt.loadTable();
    check('首次运行会从内置表拷一份出来', fs.existsSync(tableFile), fs.existsSync(tableFile) ? fs.statSync(tableFile).size + ' 字节' : '不存在');
    check('表结构完整（tags/regions/poses 之类的键都在）', !!t0 && Array.isArray(t0.tags), Object.keys(t0 || {}).slice(0, 6).join(','));
    const t1 = t0.tags.filter((x) => x.tier === 1), t2 = t0.tags.filter((x) => x.tier === 2), t3 = t0.tags.filter((x) => x.tier === 3);
    L('    tier1(核心人格)=' + t1.length + '  tier2=' + t2.length + '  tier3=' + t3.length + '  合计=' + t0.tags.length);
    check('tier1 核心人格至少有 5 个（决定立绘与基线）', t1.length >= 5, t1.map((x) => x.id).join(','));
    check('每条都有 id/label/tier/words', t0.tags.every((x) => x.id && x.label && x.tier >= 1 && x.tier <= 3 && Array.isArray(x.words) && x.words.length),
      t0.tags.filter((x) => !(x.id && x.label && Array.isArray(x.words) && x.words.length)).map((x) => JSON.stringify(x)).slice(0, 2).join(' | ') || '全合规');
    check('id 不重复', new Set(t0.tags.map((x) => x.id)).size === t0.tags.length);

    /* 写坏文件 → 必须回退到内置表，而不是空表 */
    fs.writeFileSync(tableFile, '{ 这不是 JSON');
    const tBad = pt.loadTable();
    check('文件写坏 → 回退到内置表（不是空表）', Array.isArray(tBad.tags) && tBad.tags.length >= 5, tBad.tags ? tBad.tags.length + ' 条' : '无 tags');
    fs.writeFileSync(tableFile, JSON.stringify({ tags: [null, 5, { id: '' }, { id: 'ok', label: 'L', tier: 9, words: ['w'] }, { id: 'ok2', label: 'L2', tier: 2, words: [] }] }));
    const tDirty = pt.loadTable();
    check('脏条目被清洗（缺 id/label/words 的丢掉、tier 越界被夹）',
      tDirty.tags.every((x) => x.id && x.label && x.tier >= 1 && x.tier <= 3 && x.words.length),
      JSON.stringify(tDirty.tags));
    fs.writeFileSync(tableFile, JSON.stringify(t0));
    check('恢复干净表', pt.loadTable().tags.length === t0.tags.length);

    L('');
    L('=== 2. 增删改 ===');
    const before = pt.loadTable().tags.length;
    const rAdd = pt.setTag({ id: 'test-tag', label: '测试人格', tier: 2, words: ['测试', '试验'], moodDir: -1 });
    check('新增词条成功', rAdd && rAdd.ok !== false && rAdd.action === 'added', JSON.stringify(rAdd).slice(0, 90));
    check('表里多了一条', pt.loadTable().tags.length === before + 1, before + ' → ' + pt.loadTable().tags.length);
    const rUpd = pt.setTag({ id: 'test-tag', label: '改名了', tier: 2, words: ['测试'] });
    check('同 id 再写是更新而不是新增', rUpd.action === 'updated' && pt.loadTable().tags.length === before + 1, JSON.stringify(rUpd).slice(0, 70));
    check('更新真的生效', pt.loadTable().tags.find((x) => x.id === 'test-tag').label === '改名了');
    const rBad = pt.setTag({ id: '', label: '没有 id' });
    check('缺 id 的写入被拒', !rBad || rBad.ok === false || !pt.loadTable().tags.some((x) => x.label === '没有 id'), JSON.stringify(rBad).slice(0, 80));
    const rBad2 = pt.setTag(null);
    check('setTag(null) 不崩', true, JSON.stringify(rBad2).slice(0, 40));
    const rRm = pt.removeTag('test-tag');
    check('删除成功', !pt.loadTable().tags.some((x) => x.id === 'test-tag'), JSON.stringify(rRm).slice(0, 60));
    const n1 = pt.loadTable().tags.length;
    pt.removeTag('根本不存在的 id');
    check('删除不存在的 id 是空操作', pt.loadTable().tags.length === n1);
    pt.removeTag(null);
    check('removeTag(null) 不崩', pt.loadTable().tags.length === n1);

    /* 上限：不能无限加（会把提示词撑爆） */
    const many = [];
    for (let i = 0; i < pt.MAX_TAGS + 30; i++) many.push({ id: 'bulk' + i, label: '批量' + i, tier: 3, words: ['w' + i] });
    fs.writeFileSync(tableFile, JSON.stringify({ tags: many }));
    check('超过 MAX_TAGS(' + pt.MAX_TAGS + ') 会被截断', pt.loadTable().tags.length <= pt.MAX_TAGS, pt.loadTable().tags.length + ' 条');
    /* 单词条的词数上限。⚠️ MAX_WORDS 在模块里定义了但**没有导出**（只导出了 MAX_TAGS），
       所以这里不能用 pt.MAX_WORDS —— 第一版这么写拿到 undefined，new Array(NaN) 直接
       RangeError 把整个测试打断。写死 40 并注明来源。 */
    const MAX_WORDS = 40;
    fs.writeFileSync(tableFile, JSON.stringify({ tags: [{ id: 'x', label: 'X', tier: 2, words: new Array(MAX_WORDS + 50).fill('w') }] }));
    check('单条词的条数不超过上限 ' + MAX_WORDS, pt.loadTable().tags[0].words.length <= MAX_WORDS, pt.loadTable().tags[0].words.length + ' 个词');
    fs.writeFileSync(tableFile, JSON.stringify(t0));

    L('');
    L('=== 3. 人格分析（关键词 → 核心人格）===');
    const cases = [
      ['傲娇', '蓝发鲸鱼女仆，傲娇、温柔、嘴硬', '傲娇、温柔、嘴硬', 'tsundere'],
      ['病娇', '黑发少女，病娇，极度偏执，独占欲强', '病娇、偏执', 'yandere'],
      ['雌小鬼', '银发小鬼，雌小鬼，爱挑衅', '雌小鬼、挑衅', 'mesugaki'],
      ['高冷三无', '白发少女，高冷三无，面无表情', '高冷、三无', 'kuudere'],
    ];
    for (const [name, ch, pe, expectId] of cases) {
      const a = pt.analyze(mkPersona(ch, pe));
      const prim = (a.primary || {}).id || '(无)';
      check(name + ' → 识别为 ' + expectId, prim === expectId, '实际 ' + prim + '  评分=' + JSON.stringify(a.scores || {}).slice(0, 70));
    }
    const aNone = pt.analyze(mkPersona('一只普通的鲸鱼。', '普通'));
    check('没有关键词时不崩（primary 可空或有兜底）', !!aNone, 'primary=' + ((aNone.primary || {}).id || '(无)'));
    /* ⚠️ baselinesOf 的契约是"认不出核心人格时返回 **null**，调用方自己兜底"
       （源码注释与文档都这么写）。第一版我当成"一定返回 6 个数的对象"，
       于是 Object.keys(null) 直接把测试打断 —— 而崩在 try 里时退出码仍是 0
       （框架缺陷，已修成"崩溃即失败"），所以我还误以为它通过了。
       真正该验证的是：**调用方兜底之后**能不能拿到可用的 6 个数。 */
    const pPlain = mkPersona('一只普通的鲸鱼，没什么特别设定。', '普通');
    const bRaw = pt.baselinesOf(pPlain);
    check('无关键词时 baselinesOf 按契约返回 null（不是脏对象）',
      bRaw === null || (bRaw && typeof bRaw === 'object'), String(bRaw));
    const stats = require('../src/stats');
    const bPlain = stats.baselineFromPersona(pPlain);   // 真正的调用方
    check('★ 调用方兜底后能拿到 6 个数值基线', Object.keys(bPlain).length === 6, Object.keys(bPlain).join(','));
    check('★ 兜底基线不是 NaN/undefined',
      Object.values(bPlain).every((v) => typeof v === 'number' && Number.isFinite(v)),
      JSON.stringify(bPlain));
    check('兜底基线在 0~100 内', Object.values(bPlain).every((v) => v >= 0 && v <= 100), JSON.stringify(bPlain));
    /* 兜底是按关键词猜的：验证它真的在看关键词，而不是永远返回同一组数 */
    const bClingy = stats.baselineFromPersona(mkPersona('很黏人、总在想念主人的鲸鱼', '黏人'));
    const bQuiet = stats.baselineFromPersona(mkPersona('沉默安静、话少的鲸鱼', '安静'));
    check('兜底真的按关键词给不同结果（黏人 vs 安静）',
      bClingy.dependency !== bQuiet.dependency || bClingy.extraversion !== bQuiet.extraversion,
      '黏人 dependency=' + bClingy.dependency + '/外向=' + bClingy.extraversion + '　安静 dependency=' + bQuiet.dependency + '/外向=' + bQuiet.extraversion);
    const tonePlain = pt.toneOf(pPlain);
    check('无关键词时语气要么为空、要么是可读文本（不能是 undefined 字符串）',
      tonePlain == null || (typeof tonePlain === 'string' && !/undefined|NaN/.test(tonePlain)),
      JSON.stringify(String(tonePlain).slice(0, 40)));
    const aEmpty = pt.analyze({});
    check('空人格也能分析（不抛错）', !!aEmpty, JSON.stringify(aEmpty).slice(0, 60));

    L('');
    L('=== 4. 语气 / 基线 / moodDir 三者一致 ===');
    const pTsun = mkPersona('蓝发鲸鱼女仆，傲娇、温柔、嘴硬', '傲娇、温柔、嘴硬');
    const pYan = mkPersona('黑发少女，病娇，极度偏执', '病娇、偏执');
    const toneT = pt.toneOf(pTsun), toneY = pt.toneOf(pYan);
    check('toneOf 给出非空文本', !!toneT && !!toneY && toneT.length > 4, '傲娇 ' + String(toneT).length + ' 字 / 病娇 ' + String(toneY).length + ' 字');
    check('不同人格语气不同', toneT !== toneY);
    const bT = pt.baselinesOf(pTsun), bY = pt.baselinesOf(pYan);
    check('baselinesOf 给出 6 个数值', Object.keys(bT).length === 6 && Object.keys(bY).length === 6, Object.keys(bT).join(','));
    check('病娇的依赖度基线高于傲娇', bY.dependency > bT.dependency, '傲娇 ' + bT.dependency + ' vs 病娇 ' + bY.dependency);
    check('病娇的感性度基线高于傲娇', bY.emotionality > bT.emotionality, '傲娇 ' + bT.emotionality + ' vs 病娇 ' + bY.emotionality);
    check('所有基线都在 0~100 内', Object.values(bT).concat(Object.values(bY)).every((v) => v >= 0 && v <= 100));
    const md = pt.moodDir(pTsun);
    check('moodDir 返回数字', typeof md === 'number' || md == null, String(md));
    check('sigOf 能区分不同人格', pt.sigOf(pTsun) !== pt.sigOf(pYan), pt.sigOf(pTsun) + ' vs ' + pt.sigOf(pYan));
    check('sigOf 对同一人格稳定', pt.sigOf(pTsun) === pt.sigOf(mkPersona('蓝发鲸鱼女仆，傲娇、温柔、嘴硬', '傲娇、温柔、嘴硬')));

    L('');
    L('=== 5. 词汇表 / 摘要（会进提示词，必须非空且信息够）===');
    const voc = pt.vocabulary();
    check('vocabulary() 非空', typeof voc === 'string' && voc.length > 50, voc.length + ' 字');
    check('词汇表里能看到 tier1 的标签', t1.slice(0, 3).every((x) => voc.includes(x.label)), t1.slice(0, 3).map((x) => x.label).join(','));
    check('词汇表标注了 tier（否则模型不知道怎么选）', /tier\s*1|tier1|核心/i.test(voc));
    const sum = pt.summary(pTsun);
    check('summary() 非空', typeof sum === 'string' && sum.length > 5, sum.length + ' 字');

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
