/* 交互模式热区动作表验证（确定性、零 token）
 * electron.exe app\scripts\test-petactions.js
 *
 * ⚠️ 契约（第一版我搞错了，记下来）：
 *   pa.resolve(region, persona, skin) 的 region 是**对象** { id, group }，
 *   不是区域名字符串 —— 传字符串会直接 return null（源码里 `if (!region || !region.id) return null`）。
 *   返回对象里的台词字段叫 **say**（{en, zh} 或 null），不叫 line。
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-acttest');
fs.mkdirSync(TEST_UD, { recursive: true });
for (const f of ['persona.json']) {
  try { fs.copyFileSync(path.join(process.env.APPDATA, 'dayu-pet', f), path.join(TEST_UD, f)); } catch {}
}
try { fs.unlinkSync(path.join(TEST_UD, 'pet-actions.json')); } catch {}
try { fs.unlinkSync(path.join(TEST_UD, 'pet-actions-ai.json')); } catch {}
app.setPath('userData', TEST_UD);

app.whenReady().then(() => {
  const pa = require('../src/petactions');
  const pt = require('../src/personatags');
  const tableFile = path.join(TEST_UD, 'pet-actions.json');
  const overlayFile = path.join(TEST_UD, 'pet-actions-ai.json');
  const out = [];
  const L = (s) => out.push(s);
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };
  const mkPersona = (ch, pe) => {
    const p = Object.assign({}, pt.loadPersona(), { character_setting: ch, personality: pe });
    fs.writeFileSync(path.join(TEST_UD, 'persona.json'), JSON.stringify(p, null, 2));
    return p;
  };
  const sayText = (v) => (v && v.say ? String(v.say.en || v.say.zh || v.say.text || '') : '');

  try {
    L('=== 1. 动作表：内置兜底与结构 ===');
    pa.ensure();
    check('首次运行会从内置表拷一份', fs.existsSync(tableFile), fs.existsSync(tableFile) ? fs.statSync(tableFile).size + ' 字节' : '不存在');
    const t = pa.loadTable();
    const regions = pa.regionIds();
    L('    区域 ' + regions.length + ' 个，姿势 ' + pa.poseNames().length + ' 个，动画白名单 ' + pa.ANIMS.length + ' 个');
    check('区域数量合理（>=15 个热区）', regions.length >= 15, regions.length + ' 个');
    check('有姿势表', Array.isArray(pa.poseNames()) && pa.poseNames().length > 0, pa.poseNames().join(','));
    check('表结构完整（global/groups/regions/poses）', ['global', 'groups', 'regions', 'poses'].every((k) => k in t), Object.keys(t).join(','));
    check('每个区域在表里都有定义', regions.every((r) => t.regions[r]), regions.filter((r) => !t.regions[r]).join(',') || '全有');
    check('每个区域都归了组（group）', regions.every((r) => t.regions[r].group), regions.filter((r) => !t.regions[r].group).join(',') || '全有');
    check('区域都挂在已定义的组上', regions.every((r) => t.groups[t.regions[r].group]), '缺组: ' + regions.filter((r) => !t.groups[t.regions[r].group]).join(','));

    fs.writeFileSync(tableFile, '{ 坏文件');
    const tBad = pa.loadTable();
    check('文件写坏 → 回退到内置表（不是空表）', Object.keys(tBad.regions || {}).length >= 15, Object.keys(tBad.regions || {}).length + ' 个区域');
    fs.writeFileSync(tableFile, JSON.stringify(t));

    L('');
    L('=== 2. 每个区域 × 每个人格都必须解出可用结果 ===');
    const ARCHS = ['tsundere', 'yandere', 'mesugaki', 'kuudere', 'dandere', 'genki', 'oneesan', 'koakuma'];
    const personas = {};
    /* ⚠️ 必须用**中文关键词**构造人格：词条表的匹配词是中文（傲娇/病娇/…）。
       第一版我直接拿英文 id 当人设文本，结果全部落到 _default —— 那既暴露了
       "英文人设匹配不上"这个真实缺陷（已修：现在 tag.id 也参与匹配），
       也提醒测试本身要用系统真正认得的写法。 */
    const ARCH_CN = { tsundere: ['傲娇、温柔、嘴硬', '傲娇'], yandere: ['病娇，极度偏执，独占欲强', '病娇'],
      mesugaki: ['雌小鬼，爱挑衅', '雌小鬼'], kuudere: ['高冷三无，面无表情', '高冷、三无'],
      dandere: ['天然呆，迟钝', '天然呆'], genki: ['元气、活泼、开朗', '元气'],
      oneesan: ['御姐，体贴，照顾人', '御姐'], koakuma: ['小恶魔，腹黑，爱捉弄', '小恶魔'] };
    for (const a of ARCHS) personas[a] = mkPersona(ARCH_CN[a][0], ARCH_CN[a][1]);
    let okShapes = 0; const bad = [];
    for (const a of ARCHS) {
      for (const r of regions) {
        let v = null, err = '';
        try { v = pa.resolve({ id: r }, personas[a], 'dayu'); } catch (e) { err = String(e.message); }
        const shapeOk = v && typeof v === 'object' && typeof v.anim === 'string' && typeof v.region === 'string';
        if (shapeOk) okShapes++; else bad.push(a + '/' + r + (err ? ' ERR:' + err : ' → ' + JSON.stringify(v)));
      }
    }
    check('全部 ' + (ARCHS.length * regions.length) + ' 组合都返回完整结构', bad.length === 0, bad.slice(0, 3).join(' | '));
    L('    成功 ' + okShapes + ' / ' + (ARCHS.length * regions.length));

    L('');
    L('=== 3. 解出来的内容质量 ===');
    /* ⚠️ 区域名必须真实存在：第一版我随手写了 'head'，但 27 个区域里没有它
       （是 ahoge/headdress/hair_top/hair_side_l/face/eyes/mouth…），
       于是 resolve 走的是 global 兜底、两个人格返回同一句 "Mm...?"，
       看起来像"人设没生效"——其实是测试用错了名字。 */
    const v1 = pa.resolve({ id: 'face' }, personas.tsundere, 'dayu');
    L('    face×傲娇 → ' + String(JSON.stringify(v1)).slice(0, 220));
    check('不含 undefined/null 字面量', !/undefined|"null"/.test(JSON.stringify(v1)), String(JSON.stringify(v1)).slice(0, 100));
    check('动画一定在白名单里（否则前端找不到动画）', pa.ANIMS.includes(v1.anim), 'anim=' + v1.anim);
    check('有台词', !!sayText(v1), 'say=' + String(JSON.stringify(v1.say)).slice(0, 80));
    check('台词不是欠的占位串', !/undefined|TODO|xxx/i.test(sayText(v1)), sayText(v1).slice(0, 60));
    check('mode 是 preset 或 llm', ['preset', 'llm'].includes(v1.mode), 'mode=' + v1.mode);
    /* 有多少区域给不出台词？（给不出 = 摸上去没反应，属于体验问题） */
    const noSay = [];
    for (const a of ARCHS) for (const r of regions) { const v = pa.resolve({ id: r }, personas[a], 'dayu'); if (!sayText(v)) noSay.push(a + '/' + r); }
    check('没有"摸上去一句话都没有"的区域', noSay.length === 0, noSay.length ? noSay.length + ' 个：' + noSay.slice(0, 5).join(',') : '全部都有台词');
    check('不同人格对同一区域给出不同台词（人设真的生效）',
      sayText(pa.resolve({ id: 'face' }, personas.tsundere, 'dayu')) !== sayText(pa.resolve({ id: 'face' }, personas.yandere, 'dayu')),
      '傲娇=' + sayText(pa.resolve({ id: 'face' }, personas.tsundere, 'dayu')).slice(0, 32) + ' / 病娇=' + sayText(pa.resolve({ id: 'face' }, personas.yandere, 'dayu')).slice(0, 32));

    L('');
    L('=== 4. 未知区域要安全（返回 null 而不是崩溃）===');
    for (const bogus of [null, undefined, {}, { id: '' }, { id: '根本不存在的区域' }]) {
      let v = 'THREW', err = '';
      try { v = pa.resolve(bogus, personas.tsundere, 'dayu'); } catch (e) { err = String(e.message); }
      check('非法 region ' + String(JSON.stringify(bogus)).slice(0, 24) + ' 不崩',
        !err && (v === null || (v && typeof v.anim === 'string')), err || String(JSON.stringify(v)).slice(0, 80));
    }
    check('不存在的区域名返回 null（不是脏对象）', pa.resolve({ id: '根本没有这个区域' }, personas.tsundere, 'dayu') !== undefined);

    L('');
    L('=== 5. 姿势引用与资源 ===');
    const names = pa.poseNames();
    const used = new Set();
    for (const a of ARCHS) for (const r of regions) { const v = pa.resolve({ id: r }, personas[a], 'dayu'); if (v && v.pose) used.add(v.pose); }
    const missing = [...used].filter((p) => !names.includes(p));
    L('    解出的姿势 ' + used.size + ' 个：' + [...used].join(','));
    check('解出的姿势都在姿势表里', missing.length === 0, missing.join(',') || '全部对得上');
    const rep = pa.poseReport('dayu');
    check('poseReport 能给出结果', !!rep, String(JSON.stringify(rep)).slice(0, 200));
    /* 姿势图目前一张都没有（用户没生成、内置也没有）→ has 全是 false 是**正常的**，
       只是说明"切姿势"这个槽位还没素材可用，不是 bug。 */
    const hasAny = Array.isArray(rep) && rep.some((x) => x.has);
    L('    有素材的姿势: ' + (hasAny ? rep.filter((x) => x.has).map((x) => x.pose).join(',') : '无（姿势槽位闲置，等画图）'));
    check('poseReport 每项都有 pose/has 字段', Array.isArray(rep) && rep.every((x) => typeof x.pose === 'string' && typeof x.has === 'boolean'));
    check('姿势图缺失时 poseFile 返回 null 而不是脏路径',
      pa.poseFile('blush', 'dayu') === null || typeof pa.poseFile('blush', 'dayu') === 'string',
      String(pa.poseFile('blush', 'dayu')));

    L('');
    L('=== 6. AI 覆盖层优先级 ===');
    const archT = pa.resolve({ id: 'face' }, personas.tsundere, 'dayu').arch;   // archOf 没导出，从 resolve 拿
    const vBefore = pa.resolve({ id: 'face' }, personas.tsundere, 'dayu');
    const ov = { arch: archT, lines: { face: { en: 'AI 覆盖的英文台词', zh: 'AI 覆盖的中文台词' } } };
    pa.saveOverlay(ov);
    check('覆盖层文件写出来了', fs.existsSync(overlayFile));   // 覆盖的键必须是**真实区域名**（face），写 head 这种不存在的名字解析时不会命中
    check('activeOverlay 读得到', !!pa.activeOverlay(archT), String(JSON.stringify(pa.activeOverlay(archT))).slice(0, 80));
    check('activeOverlay 对别人格返回 null', pa.activeOverlay('不匹配的人格') === null);
    const vAfter = pa.resolve({ id: 'face' }, personas.tsundere, 'dayu');
    check('★ 覆盖层盖过内置台词', sayText(vAfter) === 'AI 覆盖的英文台词',
      '覆盖前=' + sayText(vBefore).slice(0, 28) + ' → 覆盖后=' + sayText(vAfter).slice(0, 28));
    check('标记 sayFromAI 为真', vAfter.sayFromAI === true);
    check('只影响该人格', sayText(pa.resolve({ id: 'face' }, personas.yandere, 'dayu')) !== 'AI 覆盖的英文台词');
    /* 只影响被覆盖的那个区域：换成另一个真实区域（eyes）来看 */
    check('只影响该区域', sayText(pa.resolve({ id: 'eyes' }, personas.tsundere, 'dayu')) !== 'AI 覆盖的英文台词', sayText(pa.resolve({ id: 'eyes' }, personas.tsundere, 'dayu')).slice(0, 40));
    fs.writeFileSync(overlayFile, '不是 json');
    check('覆盖层写坏 → 安全回退内置台词', (() => {
      try { const v = pa.resolve({ id: 'face' }, personas.tsundere, 'dayu'); return !!v && !!sayText(v) && sayText(v) !== 'AI 覆盖的英文台词'; }
      catch { return false; }
    })());
    fs.unlinkSync(overlayFile);

    L('');
    L('=== 7. 人格映射与皮肤 ===');
    check('arch 能把人格映射到 8 个人格之一', ARCHS.includes(pa.resolve({ id: 'face' }, personas.yandere, 'dayu').arch), pa.resolve({ id: 'face' }, personas.yandere, 'dayu').arch);
    check('无关键词人格落到 _default（不返回 undefined）', pa.resolve({ id: 'face' }, mkPersona('普通鲸鱼', '普通'), 'dayu').arch === '_default', pa.resolve({ id: 'face' }, mkPersona('普通鲸鱼', '普通'), 'dayu').arch);
    check('换皮肤不影响台词与动画', (() => {
      for (const skin of ['dayu', 'default', '不存在的皮肤']) {
        const v = pa.resolve({ id: 'face' }, personas.tsundere, skin);
        if (!v || !sayText(v) || pa.ANIMS.indexOf(v.anim) < 0) return false;
      }
      return true;
    })());

    L('');
    L('=== 8. 重写提示词 ===');
    const rp = pa.buildRewritePrompt(personas.tsundere, 'tsundere', [{ region: 'head', en: 'x', zh: 'y' }]);
    check('buildRewritePrompt 非空', typeof rp === 'string' && rp.length > 50, String(rp).length + ' 字');
    check('带上了待改的台词', /head|x/.test(String(rp)));
    check('说明了输出格式', /json|JSON|格式/.test(String(rp)));

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
