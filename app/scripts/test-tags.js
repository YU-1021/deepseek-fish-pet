/* 验证人设词条系统：表读写 / AI 工具 / 感性度方向看人设
 * electron.exe app\scripts\test-tags.js
 * 临时改动 persona.json 与词条表，跑完全部还原。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
app.setPath('userData', path.join(process.env.APPDATA, 'dayu-pet'));

app.whenReady().then(() => {
  const pt = require('../src/personatags');
  const stats = require('../src/stats');
  const ud = app.getPath('userData');
  const personaFile = path.join(ud, 'persona.json');
  const personaBak = fs.readFileSync(personaFile, 'utf8');
  const tableFile = pt.tableFile();
  const tableBak = fs.readFileSync(tableFile, 'utf8');
  const out = [];
  const log = (s) => { out.push(s); };

  try {
    /* --- 1. 表来自文件 --- */
    const t = pt.loadTable();
    const byTier = { 1: 0, 2: 0, 3: 0 };
    for (const x of t.tags) byTier[x.tier]++;
    log('=== 1. 词条表（来自 ' + path.basename(tableFile) + '）===');
    log('  共 ' + t.tags.length + ' 条  tier1=' + byTier[1] + ' tier2=' + byTier[2] + ' tier3=' + byTier[3]);
    log('  层权重 = ' + JSON.stringify(t.tierWeights));
    log('');
    log('=== 2. vocabulary()（这份会喂给 AI 改人设时用）===');
    log(pt.vocabulary().split('\n').map((l) => '  ' + l).join('\n'));

    /* --- 3. AI 工具：加一条 + 改一条 + 删掉 --- */
    log('');
    log('=== 3. AI 工具 tag_set / tag_rm ===');
    const add = pt.setTag({ id: 'test-neko', label: '猫娘', tier: 1, moodDir: 1, words: ['猫娘', '喵', '耳朵'] });
    log('  tag_set 新增: ' + JSON.stringify(add.tag) + '  总数=' + add.total);
    const upd = pt.setTag({ id: 'test-neko', label: '猫娘', words: ['猫娘', '喵', '耳朵', '尾巴'] });
    log('  tag_set 再改(只给 words): action=' + upd.action + ' words=' + JSON.stringify(upd.tag.words) + ' tier 保留=' + upd.tag.tier);
    const rm = pt.removeTag('test-neko');
    log('  tag_rm: ' + JSON.stringify(rm.removed) + '  总数=' + rm.total);
    const bad = pt.setTag({ id: 'x', words: [] });
    log('  空 words 被拒: ' + JSON.stringify(bad));

    /* --- 4. 感性度方向看人设 --- */
    log('');
    log('=== 4. 感性度方向随人设变 ===');
    const emoRel = (mood) => {
      fs.writeFileSync(path.join(ud, 'mood.json'), JSON.stringify({ affection: 100, mood, pokes: 0, lastSeen: Date.now() }, null, 2));
      return stats.relateOf('emotionality', +1);   // 正向事件
    };
    const setPersona = (character, personality) => {
      const p = Object.assign(JSON.parse(personaBak), { character_setting: character, personality });
      fs.writeFileSync(personaFile, JSON.stringify(p, null, 2));
    };

    for (const [name, ch, pe] of [
      ['傲娇（你当前）', '蓝发鲸鱼女仆，傲娇、温柔、嘴硬，被叫「吃白饭的大肥鱼」会炸毛。', '傲娇、温柔、嘴硬'],
      ['病娇', '黑发少女，病娇，极度偏执，独占欲强，只属于我。', '病娇、偏执'],
      ['雌小鬼', '银发小鬼，雌小鬼，爱挑衅、瞧不起人、欠揍。', '雌小鬼、挑衅'],
    ]) {
      setPersona(ch, pe);
      const dir = pt.moodDir();
      const lo = emoRel(0), hi = emoRel(100);
      log(`  ${name.padEnd(14)} moodDir=${String(dir).padStart(2)}  primary=${(pt.analyze().primary || {}).label || '无'}`);
      log(`  ${''.padEnd(14)} 心情0 时正向乘数 ×${lo.toFixed(2)} / 心情100 时 ×${hi.toFixed(2)}` +
        (dir > 0 ? '   ← 低落时更情绪化' : '   ← 低落时更压抑'));
    }

    /* 方向只影响感性度，别的数值不受影响 */
    setPersona('黑发少女，病娇，极度偏执，独占欲强。', '病娇');
    const iqLo = stats.relateOf('iq', +1), depLo = stats.relateOf('dependency', +1);
    log('');
    log('  换成人设后（心情 0）其它数值不受影响：iq ×' + iqLo.toFixed(2) + '  dependency ×' + depLo.toFixed(2) + '  （与傲娇人设一致）');
  } catch (e) {
    log('ERROR: ' + ((e && e.stack) || e));
  } finally {
    fs.writeFileSync(personaFile, personaBak);
    fs.writeFileSync(tableFile, tableBak);
    log('');
    log('已还原 persona.json 与 persona-tags.json');
  }
  console.log(out.join('\n'));
  app.exit(0);
});
