/* test-lookcache.js —— screen_look 同帧缓存（纯 Node，不碰屏幕/视觉模型）
 * 跑法：node app/scripts/test-lookcache.js（不需要 electron）
 */
'use strict';
const assert = require('assert');
const path = require('path');
const LK = require(path.join(__dirname, '..', 'src', 'lookcache.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + ' —— ' + (e && e.message)); }
}

console.log('=== lookcache 测试 ===');
LK._reset();

t('同一帧+同一问题 → key 相同', () => {
  const a = LK.key(Buffer.from('img'), '看看屏幕');
  const b = LK.key(Buffer.from('img'), '看看屏幕');
  assert.strictEqual(a, b);
});

t('不同问题 → key 不同', () => {
  assert.notStrictEqual(LK.key(Buffer.from('img'), '问题A'), LK.key(Buffer.from('img'), '问题B'));
});

t('不同图 → key 不同', () => {
  assert.notStrictEqual(LK.key(Buffer.from('img1'), 'q'), LK.key(Buffer.from('img2'), 'q'));
});

t('put 后 get 命中，第二次 hits=2', () => {
  const k = LK.key(Buffer.from('img-x'), 'q1');
  LK.put(k, '画面是主界面');
  const h1 = LK.get(k);
  assert.ok(h1 && h1.text === '画面是主界面', '第一次应命中');
  const h2 = LK.get(k);
  assert.strictEqual(h2.hits, 3, '第二次命中的 hits 应为 3（put 记 1，两次 get 各 +1）');
});

t('未 put 的 key 不命中', () => {
  assert.strictEqual(LK.get(LK.key(Buffer.from('never'), 'q')), null);
});

t('put 空文本也能命中（不崩）', () => {
  const k = LK.key(Buffer.from('empty'), 'q');
  LK.put(k, '');
  const h = LK.get(k);
  assert.ok(h && h.text === '');
});

t('LRU 上限：塞超过 MAX 条后 size 不超过上限', () => {
  for (let i = 0; i < LK.MAX_ENTRIES + 8; i++) LK.put(LK.key(Buffer.from('k' + i), 'q'), 't' + i);
  assert.ok(LK._size() <= LK.MAX_ENTRIES, 'size=' + LK._size() + ' 应 <= ' + LK.MAX_ENTRIES);
});

t('PA_LOOK_CACHE=0 时 disabled()=true', () => {
  process.env.PA_LOOK_CACHE = '0';
  assert.strictEqual(LK.disabled(), true);
  delete process.env.PA_LOOK_CACHE;
  assert.strictEqual(LK.disabled(), false);
});

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
