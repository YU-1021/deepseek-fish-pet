const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const file = () => path.join(app.getPath('userData'), 'vocab.json');
/* 必须保证返回数组：文件被手改坏（例如写成 {}）时，load() 返回对象会让
   v.findIndex is not a function 直接抛错，整个生词本面板就废了。 */
const load = () => {
  try {
    const v = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(v)) return [];
    return v.filter((x) => x && typeof x === 'object' && typeof x.w === 'string');
  } catch { return []; }
};
const save = (v) => { try { fs.writeFileSync(file(), JSON.stringify(Array.isArray(v) ? v : [], null, 2)); } catch {} };

function add(word) {
  const w = String((word && word.w) || '').trim();
  if (!w) return load();
  const v = load();
  const i = v.findIndex((x) => x.w.toLowerCase() === w.toLowerCase());
  if (i >= 0) {
    v[i].ipa = word.ipa || v[i].ipa;
    v[i].zh = word.zh || v[i].zh;
  } else {
    v.unshift({ w, ipa: word.ipa || '', zh: word.zh || '', added: Date.now(), review: 0, good: 0 });
  }
  save(v);
  return v;
}

function del(w) {
  const v = load().filter((x) => x.w.toLowerCase() !== String(w || '').toLowerCase());
  save(v);
  return v;
}

function review(w, ok) {
  const v = load();
  const i = v.findIndex((x) => x.w.toLowerCase() === String(w || '').toLowerCase());
  if (i >= 0) {
    v[i].review = (v[i].review || 0) + 1;
    if (ok) v[i].good = (v[i].good || 0) + 1;
    save(v);
  }
  return v;
}

module.exports = { load, save, add, del, review };
