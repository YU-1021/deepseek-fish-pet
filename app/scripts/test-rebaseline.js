/* 验证：核心人格 → 数值基线 + 语气倾向；改人设时按基线平移
 * electron.exe app\scripts\test-rebaseline.js   （跑完还原 stats.json / persona.json）
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
app.setPath('userData', path.join(process.env.APPDATA, 'dayu-pet'));

app.whenReady().then(() => {
  const pt = require('../src/personatags');
  const stats = require('../src/stats');
  const ud = app.getPath('userData');
  const pFile = path.join(ud, 'persona.json');
  const pBak = fs.readFileSync(pFile, 'utf8');
  const statsFile = path.join(ud, 'memory', 'stats.json');
  const sBak = fs.readFileSync(statsFile, 'utf8');
  const out = [];
  const L = (s) => out.push(s);

  const setPersona = (ch, pe) => {
    const p = Object.assign(JSON.parse(pBak), { character_setting: ch, personality: pe });
    fs.writeFileSync(pFile, JSON.stringify(p, null, 2));
    return p;
  };
  const KEYS = stats.KEYS;

  try {
    /* --- 1. 核心人格 → 基线 --- */
    L('=== 1. 核心人格给出的数值基线（来自 persona-tags.json）===');
    L('  ' + '人设'.padEnd(10) + KEYS.map((k) => k.slice(0, 6).padStart(8)).join(''));
    for (const [name, ch, pe] of [
      ['傲娇', '蓝发鲸鱼女仆，傲娇、温柔、嘴硬，被叫「吃白饭的大肥鱼」会炸毛。', '傲娇、温柔、嘴硬'],
      ['病娇', '黑发少女，病娇，极度偏执，独占欲强，只属于我。', '病娇、偏执'],
      ['雌小鬼', '银发小鬼，雌小鬼，爱挑衅、瞧不起人、欠揍。', '雌小鬼、挑衅'],
      ['高冷三无', '白发少女，高冷三无，面无表情，话少。', '高冷、三无'],
      ['没关键词', '一只普通的鲸鱼。', '普通'],
    ]) {
      const p = setPersona(ch, pe);
      const b = stats.baselineFromPersona(p);
      const prim = (pt.analyze(p).primary || {}).label || '（未识别→关键词兜底）';
      L('  ' + name.padEnd(10) + KEYS.map((k) => String(b[k]).padStart(8)).join('') + '   ← ' + prim);
    }

    /* --- 2. 语气倾向 --- */
    L('');
    L('=== 2. toneOf()（会写进系统提示词）===');
    for (const [name, ch, pe] of [
      ['傲娇', '蓝发鲸鱼女仆，傲娇、温柔、嘴硬。', '傲娇、温柔、嘴硬'],
      ['病娇', '黑发少女，病娇，极度偏执，独占欲强。', '病娇、偏执'],
      ['雌小鬼', '银发小鬼，雌小鬼，爱挑衅、瞧不起人。', '雌小鬼、挑衅'],
    ]) {
      const p = setPersona(ch, pe);
      L('  【' + name + '】');
      L(pt.toneOf(p).split('\n').map((l) => '    ' + l).join('\n'));
    }

    /* --- 3. 改人设 → 按基线平移（累积保留） --- */
    L('');
    L('=== 3. 改人设时重新评估：按基线变化量平移 ===');
    setPersona('蓝发鲸鱼女仆，傲娇、温柔、嘴硬。', '傲娇、温柔、嘴硬');
    const r0 = stats.rebaseline(pt.loadPersona());
    const before = stats.all();
    L('  起点（傲娇）: ' + KEYS.map((k) => k + '=' + before[k]).join('  '));
    L('  基线        : ' + KEYS.map((k) => k + '=' + stats.baselineFromPersona(pt.loadPersona())[k]).join('  '));
    L('  （"偏移"= 当前值 − 基线，这部分代表陪伴累积，平移时要保留）');
    L('  偏移        : ' + KEYS.map((k) => k + '=' + (Math.round((before[k] - stats.baselineFromPersona(pt.loadPersona())[k]) * 100) / 100)).join('  '));

    setPersona('黑发少女，病娇，极度偏执，独占欲强，只属于我。', '病娇、偏执');
    const r1 = stats.rebaseline(pt.loadPersona());
    const after = stats.all();
    L('');
    L('  切到「病娇」→ applied:');
    for (const a of r1.applied) L(`    ${a.key.padEnd(13)} ${String(a.from).padStart(7)} -> ${String(a.to).padStart(7)}  (${a.delta > 0 ? '+' : ''}${a.delta})`);
    L('  结果        : ' + KEYS.map((k) => k + '=' + after[k]).join('  '));
    const keep = KEYS.every((k) => Math.abs((after[k] - stats.baselineFromPersona(pt.loadPersona())[k]) - (before[k] - stats.baselineFromPersona({ character_setting: '蓝发鲸鱼女仆，傲娇、温柔、嘴硬。', personality: '傲娇、温柔、嘴硬' })[k])) < 0.011);
    L('  累积偏移是否保持不变: ' + (keep ? '✅ 是（只平移了底子，陪伴的累积没丢）' : '⚠ 有偏差'));

    /* --- 4. 只改无关字段 → 数值不动 --- */
    L('');
    L('=== 4. 只改口头禅（基线不变）→ 数值应当原地不动 ===');
    const snapshot = JSON.stringify(stats.all());
    setPersona('蓝发鲸鱼女仆，傲娇、温柔、嘴硬。', '傲娇、温柔、嘴硬');
    stats.rebaseline(pt.loadPersona());          // 先回到傲娇基线
    const mid = JSON.stringify(stats.all());
    const p2 = Object.assign(JSON.parse(pBak), {
      character_setting: '蓝发鲸鱼女仆，傲娇、温柔、嘴硬。', personality: '傲娇、温柔、嘴硬',
      catchphrase: 'I am NOT a freeloader fat fish! (v2)',
    });
    fs.writeFileSync(pFile, JSON.stringify(p2, null, 2));
    const r2 = stats.rebaseline(pt.loadPersona());
    L('  changed=' + r2.changed + '  applied=' + r2.applied.length + ' 条');
    L('  数值是否不变: ' + (JSON.stringify(stats.all()) === mid ? '✅ 不变' : '⚠ 变了'));
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  } finally {
    fs.writeFileSync(pFile, pBak);
    fs.writeFileSync(statsFile, sBak);
    L('');
    L('已还原 persona.json 与 stats.json（当前值仍为 ' + JSON.stringify(stats.all()) + '）');
  }
  console.log(out.join('\n'));
  app.exit(0);
});
