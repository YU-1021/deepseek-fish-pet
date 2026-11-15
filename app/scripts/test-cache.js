/* test-cache.js —— P3 缓存单测（纯 Node，不碰屏幕/视觉模型）
 * 跑法：node app/scripts/test-cache.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const LK = require(path.join(__dirname, '..', 'src', 'lookcache.js'));
const FC = require(path.join(__dirname, '..', 'src', 'framecache.js'));
const OC = require(path.join(__dirname, '..', 'src', 'ocrcache.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + ' —— ' + (e && e.message)); }
}
const T = path.join(os.tmpdir(), 'dayu-pet-cache-test');
fs.mkdirSync(T, { recursive: true });
const f1 = path.join(T, 'a.png');
const f2 = path.join(T, 'b.png');
fs.writeFileSync(f1, Buffer.from('AAA-image-bytes'));
fs.writeFileSync(f2, Buffer.from('BBB-image-bytes'));

console.log('=== P3 缓存测试 ===');
LK._reset(); FC._reset(); OC._reset();

t('lookcache：同图 problem 相同 key 命中', () => {
  const b = Buffer.from('img');
  const k = LK.key(b, 'q');
  LK.put(k, 'desc');
  const h = LK.get(k);
  assert.ok(h && h.text === 'desc');
  assert.strictEqual(h.hits, 2);
});

t('framecache：dataUrl 指纹 → 路径复用', () => {
  const url = 'data:image/jpeg;base64,ZmFrZXBuZw==';
  const k = FC.keyOfDataUrl(url);
  assert.ok(k && k.length === 40);
  FC.put(k, f1, url);
  const h = FC.get(k);
  assert.ok(h && h.path === f1 && h.hits === 2);
});

t('framecache：文件被删后不命中', () => {
  const url = 'data:image/jpeg;base64,GONE';
  const k = FC.keyOfDataUrl(url);
  const tmp = path.join(T, 'gone.png');
  fs.writeFileSync(tmp, Buffer.from('x'));
  FC.put(k, tmp, url);
  fs.unlinkSync(tmp);
  assert.strictEqual(FC.get(k), null);
});

t('ocrcache：同文件内容 → 命中且拿回原结果', () => {
  const k = OC.keyOfFile(f1);
  const val = { ok: true, lines: [{ text: '剩余可放置角色', words: [] }], text: '剩余可放置角色' };
  OC.put(k, val);
  const h = OC.get(k);
  assert.ok(h && h.ok === true && h.text === '剩余可放置角色');
  assert.strictEqual(h.__cacheHits, 2);
});

t('ocrcache：不同文件内容 → 不命中', () => {
  assert.strictEqual(OC.get(OC.keyOfFile(f2)), null);
});

t('ocrcache：!ok 的结果不缓存', () => {
  const k = OC.keyOfFile(f2);
  OC.put(k, { ok: false, error: 'x' });
  assert.strictEqual(OC.get(k), null);
});

t('ocrcache：文件不存在 → key 为 null（跳过缓存，不抛错）', () => {
  assert.strictEqual(OC.keyOfFile(path.join(T, '不存在.png')), null);
});

t('LRU 上限：三个缓存都不超过各自 MAX', () => {
  for (let i = 0; i < FC.MAX_ENTRIES + 5; i++) FC.put('k' + i, f1, 'data:image/jpeg;base64,' + 'x' + i);
  for (let i = 0; i < OC.MAX_ENTRIES + 5; i++) OC.put('k' + i, { ok: true });
  assert.ok(FC._size() <= FC.MAX_ENTRIES, 'framecache size=' + FC._size());
  assert.ok(OC._size() <= OC.MAX_ENTRIES, 'ocrcache size=' + OC._size());
});

t('开关：PA_FRAME_CACHE=0 / PA_OCR_CACHE=0 生效', () => {
  process.env.PA_FRAME_CACHE = '0';
  process.env.PA_OCR_CACHE = '0';
  assert.strictEqual(FC.disabled(), true);
  assert.strictEqual(OC.disabled(), true);
  delete process.env.PA_FRAME_CACHE;
  delete process.env.PA_OCR_CACHE;
  assert.strictEqual(FC.disabled(), false);
  assert.strictEqual(OC.disabled(), false);
});

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
