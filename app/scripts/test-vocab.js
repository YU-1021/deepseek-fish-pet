/* 生词本验证（确定性、零 token）
 * electron.exe app\scripts\test-vocab.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-vocabtest');
fs.mkdirSync(TEST_UD, { recursive: true });
try { fs.unlinkSync(path.join(TEST_UD, 'vocab.json')); } catch {}
app.setPath('userData', TEST_UD);

app.whenReady().then(() => {
  const vocab = require('../src/vocab');
  const file = path.join(TEST_UD, 'vocab.json');
  const out = [];
  const L = (s) => out.push(s);
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  try {
    L('=== 1. 文件被写坏时必须回退成空数组（不能把面板搞崩）===');
    /* 注释里写明：写成 {} 时 load() 返回对象会让 v.findIndex is not a function 抛错 */
    for (const [name, content] of [
      ['对象 {}', '{}'],
      ['null', 'null'],
      ['纯文本', 'not json'],
      ['数组里混脏数据', '[{"w":"ok"},null,5,{"nope":1},{"w":123}]'],
      ['带 BOM 的正常内容', '\uFEFF[{"w":"hello"}]'],
      ['空文件', ''],
    ]) {
      fs.writeFileSync(file, content);
      let v = null, err = '';
      try { v = vocab.load(); } catch (e) { err = String(e.message); }
      check(name + ' → 返回数组且不抛错', Array.isArray(v) && !err, err || JSON.stringify(v).slice(0, 60));
    }
    fs.writeFileSync(file, '[{"w":"ok"},null,5,{"nope":1},{"w":123}]');
    const cleaned = vocab.load();
    check('脏数据被过滤（只留 w 是字符串的）', cleaned.length === 1 && cleaned[0].w === 'ok', JSON.stringify(cleaned));

    L('');
    L('=== 2. 新增与去重（大小写不敏感）===');
    fs.unlinkSync(file);
    vocab.add({ w: 'banana', ipa: '/bəˈnɑːnə/', zh: '香蕉' });
    vocab.add({ w: 'apple', ipa: '/ˈæpl/', zh: '苹果' });
    let v = vocab.load();
    check('加了两个词', v.length === 2, v.map((x) => x.w).join(','));
    check('新的排在最前面（unshift）', v[0].w === 'apple', v[0].w);
    check('字段都记下了', v[1].w === 'banana' && v[1].ipa === '/bəˈnɑːnə/' && v[1].zh === '香蕉');
    check('初始 review/good 都是 0', v[1].review === 0 && v[1].good === 0);
    vocab.add({ w: 'BANANA', ipa: '/new/', zh: '新解释' });
    v = vocab.load();
    check('大小写不同不会重复添加', v.length === 2, v.map((x) => x.w).join(','));
    check('重复添加会更新音标/释义', v.find((x) => x.w === 'banana').ipa === '/new/', 'ipa=' + v.find((x) => x.w === 'banana').ipa);
    check('不会把之前那个词的顺序打乱', v[v.length - 1].w === 'banana', v.map((x) => x.w).join(','));

    L('');
    L('=== 3. 空/空白词不该进本子 ===');
    const before = vocab.load().length;
    for (const bad of ['', '   ', null, undefined, {}, { w: '' }, { w: '   ' }]) vocab.add(bad);
    check('空词全部被拒绝', vocab.load().length === before, before + ' → ' + vocab.load().length);

    L('');
    L('=== 4. 复习计数 ===');
    vocab.review('apple', true);
    vocab.review('apple', true);
    vocab.review('apple', false);
    v = vocab.load().find((x) => x.w === 'apple');
    check('review 每次 +1', v.review === 3, 'review=' + v.review);
    check('good 只在答对时 +1', v.good === 2, 'good=' + v.good);
    vocab.review('APPLE', true);
    check('复习也大小写不敏感', vocab.load().find((x) => x.w === 'apple').review === 4, 'review=' + vocab.load().find((x) => x.w === 'apple').review);
    const snapshot = JSON.stringify(vocab.load());
    vocab.review('nonexistent-word', true);
    check('复习不存在的词是空操作', JSON.stringify(vocab.load()) === snapshot);

    L('');
    L('=== 5. 删除 ===');
    vocab.del('APPLE');
    v = vocab.load();
    check('删除大小写不敏感', !v.some((x) => x.w.toLowerCase() === 'apple'), v.map((x) => x.w).join(','));
    check('其他词不受影响', v.some((x) => x.w === 'banana'));
    const n1 = vocab.load().length;
    vocab.del('从来没有过的词');
    check('删除不存在的词是空操作', vocab.load().length === n1);
    vocab.del(null); vocab.del(undefined); vocab.del('');
    check('删除 null/空不崩', vocab.load().length === n1, vocab.load().length + ' 个');

    L('');
    L('=== 6. save() 的容错 ===');
    vocab.save('这不是数组');
    check('存非数组时写成空数组（不留下坏文件）', Array.isArray(vocab.load()) && vocab.load().length === 0);
    vocab.save(null);
    check('存 null 也安全', vocab.load().length === 0);

    L('');
    L('=== 7. 落盘往返 ===');
    vocab.add({ w: 'roundtrip', ipa: '/x/', zh: '往返' });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('磁盘上就是合法 JSON 数组', Array.isArray(raw) && raw[0].w === 'roundtrip', JSON.stringify(raw).slice(0, 50));
    check('字段齐全（w/ipa/zh/added/review/good）',
      ['w', 'ipa', 'zh', 'added', 'review', 'good'].every((k) => k in raw[0]), Object.keys(raw[0]).join(','));
    check('added 是时间戳', typeof raw[0].added === 'number' && raw[0].added > 1600000000000, String(raw[0].added));

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
