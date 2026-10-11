/* 生词本回路验证：读错的词有没有真的进到系统提示词里
 * electron.exe app\scripts\test-vocab-loop.js
 *
 * 背景：生词本以前是**只写不读**的 —— 读错的词自动收进来、面板上看得见，
 * 但 buildSystemPrompt 里完全没有它（那处 `vocab` 其实是 personatags.vocabulary()）。
 * 这个测试守的就是那条回路，顺便验证"加词不会把提示词的稳定前缀打乱"。
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-vocabloop');
fs.mkdirSync(TEST_UD, { recursive: true });
for (const f of ['config.json', 'persona.json']) {
  try { fs.copyFileSync(path.join(process.env.APPDATA, 'dayu-pet', f), path.join(TEST_UD, f)); } catch {}
}
try { fs.unlinkSync(path.join(TEST_UD, 'vocab.json')); } catch {}
try { fs.unlinkSync(path.join(TEST_UD, 'clock-offset.json')); } catch {}
app.setPath('userData', TEST_UD);

require('../main.js');    // 启动真应用

app.whenReady().then(async () => {
  const M = require('../main.js');
  const vocab = require('../src/vocab');
  const out = [];
  const L = (s) => out.push(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  try {
    await wait(4000);
    const cfg = M.config.load();

    L('=== 1. 生词本为空时不该出现这一节 ===');
    vocab.save([]);
    const p0 = M.buildSystemPrompt(cfg);
    check('空生词本 → 提示词里没有"正在练的词"节', !/正在练的词/.test(p0));
    check('但基本提示词还在（人格/输出格式）', /Output format/.test(p0) && /Language rules/.test(p0));

    L('');
    L('=== 2. 收词后必须出现在提示词里 ===');
    vocab.add({ w: 'pronunciation', ipa: '/prəˌnʌnsiˈeɪʃn/', zh: '发音' });
    vocab.add({ w: 'rhythm', ipa: '/ˈrɪðəm/', zh: '节奏' });
    vocab.add({ w: 'thorough', ipa: '/ˈθʌrə/', zh: '彻底的' });
    const p1 = M.buildSystemPrompt(cfg);
    check('出现了这一节', /正在练的词/.test(p1));
    check('三个词都在', ['pronunciation', 'rhythm', 'thorough'].every((w) => p1.includes(w)),
      ['pronunciation', 'rhythm', 'thorough'].filter((w) => !p1.includes(w)).join(',') || '全在');
    check('带上了音标与中文', /prəˌnʌnsiˈeɪʃn/.test(p1) && /发音/.test(p1));
    check('给了"自然使用、别当词表念"的约束', /自然|别当成词表/.test(p1));
    check('不是列在人设/隐藏设定那一带（避免破坏前缀）', p1.indexOf('正在练的词') > p1.indexOf('Language rules'),
      '位置 ' + p1.indexOf('正在练的词') + ' > Language rules ' + p1.indexOf('Language rules'));

    L('');
    L('=== 3. 只喂"最该练"的，且不超上限 ===');
    for (let i = 0; i < 20; i++) vocab.add({ w: 'filler' + i, ipa: '/f/', zh: '填充' + i });
    const p2 = M.buildSystemPrompt(cfg);
    /* ⚠️ 只在**生词本节内部**数行：第一版用 /^- [a-zA-Z]/gm 数整个提示词，
       把记忆事实、技能目录、工具列表全算进去了（数出 51 行），属于统计范围写错。 */
    const secOf = (txt) => {
      const i = txt.indexOf('# 主人正在练的词');
      if (i < 0) return '';
      const j = txt.indexOf('\n#', i + 1);
      return txt.slice(i, j < 0 ? undefined : j);
    };
    const shown = (secOf(p2).match(/^- /gm) || []).length;
    check('一节里最多 8 个词（不把提示词撑大）', shown <= 8, '生词本节里 ' + shown + ' 行词条');
    check('确实截断了（不是把 23 个词全塞进去）', shown === 8, shown + ' / 共 ' + vocab.load().length + ' 个词');
    /* 复习多、对得少的应该优先 */
    vocab.save([]);
    vocab.add({ w: 'struggling', ipa: '/s/', zh: '挣扎' });
    vocab.add({ w: 'mastered', ipa: '/m/', zh: '已掌握' });
    for (let i = 0; i < 6; i++) vocab.review('struggling', false);   // 6 次全错
    for (let i = 0; i < 6; i++) vocab.review('mastered', true);      // 6 次全对
    const ranked = vocab.toPractice(8).map((x) => x.w);
    check('toPractice 把"练得多、对得少"的排前面', ranked[0] === 'struggling', ranked.join(','));
    check('toPractice 带上了复习统计', (() => { const x = vocab.toPractice(8)[0]; return x.review === 6 && x.good === 0 && x.miss === 6; })(),
      JSON.stringify(vocab.toPractice(8)[0]));
    const p3 = M.buildSystemPrompt(cfg);
    check('提示词里标注了复习情况（她能看出你老错哪个）', /复习 6 次，对 0 次/.test(p3), (p3.match(/复习[^\n]*/) || [''])[0]);

    L('');
    L('=== 4. 加词不能把提示词的稳定前缀打乱（省钱）===');
    vocab.save([]);
    vocab.add({ w: 'alpha', ipa: '/a/', zh: '甲' });
    const a = M.buildSystemPrompt(cfg);
    vocab.add({ w: 'beta', ipa: '/b/', zh: '乙' });
    const b = M.buildSystemPrompt(cfg);
    const common = (() => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; })();
    const firstDyn = (() => {
      /* 第一个"动"的位置：应该落在生词本节附近，而不是人设区 */
      const i = a.indexOf('正在练的词');
      return i >= 0 ? i : a.length;
    })();
    check('共同前缀一直延伸到生词本节之前', common >= firstDyn - 40,
      '共同前缀 ' + common + ' 字 / 生词本节起于 ' + firstDyn);
    check('人格与隐藏设定区完全没受影响', a.slice(0, 400) === b.slice(0, 400));
    check('输出格式说明在人设之后仍然存在（顺序没乱）', b.indexOf('Output format') > b.indexOf('Language rules'));

    L('');
    L('=== 5. 生词本删空后这一节要消失（不留残影）===');
    vocab.save([]);
    const p4 = M.buildSystemPrompt(cfg);
    check('清空后不再出现这一节', !/正在练的词/.test(p4));

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 300);
});
