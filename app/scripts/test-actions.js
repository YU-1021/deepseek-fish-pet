/* 验证交互动作表：热区 × 人格 → 动作；以及"放图槽"的素材缺口
 * electron.exe app\scripts\test-actions.js
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
app.setPath('userData', path.join(process.env.APPDATA, 'dayu-pet'));

app.whenReady().then(() => {
  const pa = require('../src/petactions');
  const pt = require('../src/personatags');
  const ud = app.getPath('userData');
  const pFile = path.join(ud, 'persona.json');
  const pBak = fs.readFileSync(pFile, 'utf8');
  const out = [];
  const L = (s) => out.push(s);

  const setP = (ch, pe) => {
    const p = Object.assign(JSON.parse(pBak), { character_setting: ch, personality: pe });
    fs.writeFileSync(pFile, JSON.stringify(p, null, 2));
    return p;
  };

  let crashed = '';

  try {
    const t = pa.loadTable();
    L('=== 动作表 ===');
    L('  热区条目 ' + Object.keys(t.regions).length + ' 个，分组 ' + Object.keys(t.groups).join('/'));
    L('  声明的姿态名（画师照着画）：' + t.poses.join(', '));
    L('');

    const PROBE = ['ahoge', 'face', 'mouth', 'ear_l', 'hand_l', 'apron_whale', 'tail', 'shoe_l', 'skirt_hem'];
    const GROUPS = { ahoge: 'head', face: 'head', mouth: 'head', ear_l: 'head', hand_l: 'torso', apron_whale: 'torso', tail: 'lower', shoe_l: 'lower', skirt_hem: 'lower' };

    for (const [name, ch, pe] of [
      ['傲娇', '蓝发鲸鱼女仆，傲娇、温柔、嘴硬，被叫「吃白饭的大肥鱼」会炸毛。', '傲娇、温柔、嘴硬'],
      ['病娇', '黑发少女，病娇，极度偏执，独占欲强，只属于我。', '病娇、偏执'],
      ['雌小鬼', '银发小鬼，雌小鬼，爱挑衅、瞧不起人、欠揍。', '雌小鬼、挑衅'],
    ]) {
      const p = setP(ch, pe);
      L('=== 人格「' + name + '」（' + (pt.analyze(p).primary || {}).label + '）===');
      L('  ' + '热区'.padEnd(12) + 'anim'.padEnd(11) + 'pose'.padEnd(12) + '模式' + '  台词');
      for (const id of PROBE) {
        const a = pa.resolve({ id, group: GROUPS[id] }, p);
        if (!a) { L('  ' + id.padEnd(12) + '(表里没有这个热区)'); continue; }
        L('  ' + id.padEnd(12) + String(a.anim).padEnd(11) + String(a.pose || '-').padEnd(12)
          + (a.mode === 'llm' ? '模型' : '预置') + '  ' + (a.say || '(等模型说)').slice(0, 34));
      }
      L('');
    }

    L('=== 放图槽 ===');
    L('  目录: ' + pa.posesDir());
    const rep = pa.poseReport('dafeiyu');
    for (const r of rep) L('    ' + (r.has ? '✅ 已有' : '⬜ 待画') + '  ' + r.pose + (r.has ? '  → ' + pa.poseFile(r.pose, 'dafeiyu') : ''));
    L('  （把 PNG 按这些名字丢进上面的目录即生效，不用改代码、不用重启）');
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  } finally {
    fs.writeFileSync(pFile, pBak);
    L('');
    L('已还原 persona.json');
  }
  console.log(out.join('\n'));
  app.exit(0);
});
