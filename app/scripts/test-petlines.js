/* 验证交互台词：{en,zh} 解析 / 覆盖层读写与失效 / AI 重写（真调一次模型）
 * electron.exe app\scripts\test-petlines.js
 * 跑完把覆盖层恢复原状。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
app.setPath('userData', path.join(process.env.APPDATA, 'dayu-pet'));

app.whenReady().then(async () => {
  const pa = require('../src/petactions');
  const pt = require('../src/personatags');
  const llm = require('../src/llm');
  const config = require('../src/config');
  const ud = app.getPath('userData');
  const ovFile = pa.overlayFile();
  const hadOv = fs.existsSync(ovFile);
  const ovBak = hadOv ? fs.readFileSync(ovFile, 'utf8') : null;
  const out = [];
  const L = (s) => out.push(s);

  let crashed = '';

  try {
    const cfg = config.load();
    const p = pt.loadPersona();
    const arch = pt.analyze(p).primary || {};
    const table = pa.loadTable();
    L('=== 1. 台词格式 {en,zh} ===');
    L('  人设核心人格: ' + (arch.label || '未识别') + ' (' + (arch.id || '-') + ')');
    const PROBE = ['ahoge', 'face', 'tail', 'shoe_l'];
    for (const id of PROBE) {
      const a = pa.resolve({ id, group: table.regions[id] && table.regions[id].group }, p);
      L('  ' + id.padEnd(8) + 'en: ' + (a.say ? a.say.en : '(无)'));
      L('  ' + ''.padEnd(8) + 'zh: ' + (a.say ? a.say.zh : '(无)') + '   来自AI=' + a.sayFromAI);
    }

    L('');
    L('=== 2. 覆盖层：写入 / 读取 / 人格不一致就失效 ===');
    const fake = { ahoge: { en: 'TEST-EN-ONLY', zh: '测试中文' }, tail: { en: 'TEST-TAIL', zh: '尾巴测试' } };
    pa.saveOverlay({ sig: 'x', arch: arch.id, lines: fake });
    const a1 = pa.resolve({ id: 'ahoge', group: 'head' }, p);
    L('  写入后 ahoge.say = ' + JSON.stringify(a1.say) + '  sayFromAI=' + a1.sayFromAI);
    pa.saveOverlay({ sig: 'x', arch: 'definitely-not-this-arch', lines: fake });
    const a2 = pa.resolve({ id: 'ahoge', group: 'head' }, p);
    L('  人格改成不匹配后 ahoge.say = ' + JSON.stringify(a2.say) + '  sayFromAI=' + a2.sayFromAI + '  ← 应回落到手写底稿');

    L('');
    L('=== 3. AI 重写（真调模型，只取 6 个部位）===');
    if (!cfg.apiKey) { L('  跳过：没配 API Key'); } else {
      const all = [
        ['ahoge', '呆毛'], ['face', '脸'], ['ear_l', '左鲸鳍耳'],
        ['hand_l', '左手'], ['apron_whale', '围裙上的鲸鱼'], ['tail', '鲸鱼尾'],
      ];
      const rows = all.map(([id, name]) => {
        const cur = pa.resolve({ id, group: table.regions[id] ? table.regions[id].group : '' }, p) || {};
        return { id, name, en: (cur.say || {}).en || '', zh: (cur.say || {}).zh || '' };
      });
      const sys = pa.buildRewritePrompt(p, arch, rows);
      L('  提示词 ' + sys.length + ' 字符');
      const t0 = Date.now();
      const raw = await llm.request(cfg, [{ role: 'system', content: sys }, { role: 'user', content: '请输出 JSON。' }]);
      const ms = Date.now() - t0;
      const t = String(raw || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const i = t.indexOf('{'), j = t.lastIndexOf('}');
      let o = null;
      try { o = JSON.parse(t.slice(i, j + 1)); } catch (e) { L('  ❌ JSON 解析失败: ' + t.slice(0, 200)); }
      if (o) {
        L('  模型返回 ' + Object.keys(o).length + ' 条，耗时 ' + ms + 'ms');
        L('  ' + '部位'.padEnd(14) + 'EN'.padEnd(56) + 'ZH');
        for (const [id, name] of all) {
          const line = pa.takesLine(o[id]);
          L('  ' + (name + '(' + id + ')').padEnd(14) + String(line ? line.en : '(缺)').slice(0, 54).padEnd(56) + (line ? line.zh : ''));
        }
        const okShape = Object.values(o).every((v) => v && typeof v === 'object' && typeof v.en === 'string' && typeof v.zh === 'string');
        const allEn = Object.values(o).every((v) => /^[\x00-\x7F]*$/.test(String(v.en || '')));
        L('');
        L('  形状检查 {en,zh}: ' + (okShape ? '✅' : '❌') + '   en 全是英文(无中文混入): ' + (allEn ? '✅' : '❌'));
      }
    }
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  } finally {
    if (hadOv) fs.writeFileSync(ovFile, ovBak); else { try { fs.unlinkSync(ovFile); } catch {} }
    L('');
    L('已还原覆盖层（' + (hadOv ? '恢复原文件' : '删除测试文件') + '）');
  }
  console.log(out.join('\n'));
  app.exit(0);
});
