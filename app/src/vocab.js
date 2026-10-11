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

/* 取"最该练"的 n 个词，给系统提示词用。
 *
 * 为什么需要它：生词本以前是个**只写不读**的池子 —— 读错的词被自动收进来，
 * 面板上能看见，但**她本人完全不知道**（buildSystemPrompt 里那处 `vocab`
 * 其实命中的是 personatags.vocabulary()，是人设词条、不是生词本）。
 * 也就是说"生词本"完全没有回到对话里，练了等于没练。这里就是补那条回路。
 *
 * 排序依据：
 *   · 先按 (复习次数 − 答对次数) 降序 —— 练得多、对得少 = 还没掌握
 *   · 同分按"最近加入"优先（新收进来的更该马上见几面）
 *   · 完全没复习过的自然排在后面（可能只是刚存进来）
 */
function toPractice(n) {
  const max = Math.max(0, Number(n) || 8);
  return load()
    .map((x) => Object.assign({}, x, {
      miss: Math.max(0, (Number(x.review) || 0) - (Number(x.good) || 0)),
    }))
    .sort((a, b) => (b.miss - a.miss) || ((Number(b.added) || 0) - (Number(a.added) || 0)))
    .slice(0, max);
}

module.exports = { load, save, add, del, review, toPractice };
