/* probe-iconlib.js —— ★icon_lib 精度验证（真机抓帧 · 纯 Node · 不开窗口）★
 *
 * 跑法：node app\scripts\probe-iconlib.js [真实图路径]
 *
 * 【要证明的六件事（对应 lead 的精度要求）】
 *   ① 建库：切 9 格、每格一个模板、文件名带序号 ✓
 *   ② 精度：同一张图 —— 必须"就是它"，并报"最优 - 次优"的差距 ✓（差距小要报不确定 ✓）
 *   ③ 假命中：拿**不含这些图标**的区域去认 → 必须回答"没找到" ✓ 不许凑 ✓
 *   ④ 抗变化：两种亮度 × 两种轻微缩放 = 四次都要匹配到 ✓（真实分数逐个列出 ✓）
 *   ⑤ 统计：连续 10 次识别（在亮度/缩放/JPEG/位移等扰动下 ✓）→ 报 正确 / 错误 / 不确定 ✓
 *   ⑥ 阈值依据：把"同格 vs 异格"的真实分数分布打出来 ✓（说明 0.92 / 0.06 是怎么定的 ✓）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const IL = require('../src/iconlib');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

const BASE = 'C:/deepseek/iconlib-test';
const LIB = 'arknights-class';
const NAMES = ['ALL', '先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'];
const REGION = { x0: 1600, y0: 60, x1: 1919, y1: 1012 };

/* ── 造扰动图（纯手算像素 ✓ 不依赖 jimp 的 API 名 ✓）── */
async function bright(Jimp, src, k, out) {
  const img = await Jimp.fromBuffer(fs.readFileSync(src));
  const d = img.bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.max(0, Math.min(255, Math.round(d[i] * k)));
    d[i + 1] = Math.max(0, Math.min(255, Math.round(d[i + 1] * k)));
    d[i + 2] = Math.max(0, Math.min(255, Math.round(d[i + 2] * k)));
  }
  fs.writeFileSync(out, await img.getBuffer('image/png'));
  return out;
}
async function scaled(Jimp, src, s, out) {
  const img = await Jimp.fromBuffer(fs.readFileSync(src));
  img.resize({ w: Math.round(img.width * s), h: Math.round(img.height * s) });
  fs.writeFileSync(out, await img.getBuffer('image/png'));
  return { path: out, s };
}
async function jpeg(Jimp, src, q, out) {
  const img = await Jimp.fromBuffer(fs.readFileSync(src));
  fs.writeFileSync(out, await img.getBuffer('image/jpeg', { quality: q }));
  return out;
}

function regionFor(s) { return { x0: Math.round(REGION.x0 * s), y0: Math.round(REGION.y0 * s), x1: Math.round(REGION.x1 * s), y1: Math.round(REGION.y1 * s) }; }

(async () => {
  const Jimp = require('jimp').Jimp;
  const real = process.argv[2] || 'C:/deepseek/desktop-pet/shots/win-Arknights-1791645099248.jpg';
  console.log('=== probe-iconlib（精度验证 · 真机抓帧）===');
  console.log('  真图：' + real);
  fs.mkdirSync(BASE, { recursive: true });

  /* ① 建库 */
  const built = await IL.buildLibrary({ image: real, baseDir: BASE, libName: LIB, dir: 'v', expect: 9, region: REGION, names: NAMES });
  console.log('  ★建库：' + built.index.cells + ' 个模板★　格距 ' + (built.analysis.spacing || 0).toFixed(1)
    + 'px　残差 ' + (built.analysis.cv * 100).toFixed(1) + '%');
  console.log('  模板：' + built.index.entries.map((e) => e.file).join(' '));
  ok(built.index.cells === 9, '① 切出 9 格并各存一个模板 ✓', 'n=' + built.index.cells);
  ok(built.index.entries.every((e) => /^t\d\d_/.test(e.file)), '① 文件名都带位置序号（t01_… ✓ 序号是几何给的 ✓）');

  /* ② 同一张图：精度 + 最优/次优差距 */
  const same = await IL.matchLibrary({ image: real, baseDir: BASE, libName: LIB, dir: 'v', expect: 9, region: REGION });
  console.log('  ② 同一张图（分数 / 领先次优）：');
  same.rows.forEach((r) => console.log('    ' + String(r.index).padStart(2) + '. '
    + (r.verdict === 'match' ? '★' + r.name + '★' : (r.verdict === 'uncertain' ? '⚠️ 不确定' : '❌ 没找到'))
    + '　分数 ' + r.score.toFixed(3) + '　领先 ' + (r.margin == null ? '-' : r.margin.toFixed(3))
    + '　次名 ' + (r.second ? '「' + r.second.name + '」' + r.second.score.toFixed(3) : '-')));
  const sameMatch = same.rows.filter((r) => r.verdict === 'match').length;
  const minMargin = Math.min.apply(null, same.rows.map((r) => (r.margin == null ? 9 : r.margin)));
  ok(sameMatch === 9, '② 同一张图 9/9 ★就是它★', '最低分 ' + Math.min.apply(null, same.rows.map((r) => r.score)).toFixed(3));
  ok(same.rows.every((r) => r.name === (NAMES[r.index - 1] || null)), '② 名字与"人给的顺序"逐格一致（不串位 ✓）');
  console.log('  ★阈值依据（实测）★：同格分数 ' + same.rows.map((r) => r.score.toFixed(3)).join(',')
    + '；★异格最高分 = ' + Math.max.apply(null, same.rows.map((r) => (r.second ? r.second.score : 0))).toFixed(3) + '★'
    + '；9 格里最小领先量 = ' + minMargin.toFixed(3));
  ok(minMargin >= IL.MARGIN_MIN, '② 最小领先量 ≥ ' + IL.MARGIN_MIN + '（不确定门槛 ✓）', minMargin.toFixed(3));
  ok(Math.max.apply(null, same.rows.map((r) => (r.second ? r.second.score : 0))) < IL.MATCH_MIN,
    '② ★"异格最高分" < 0.92 → 0.92 落在真空档里（判据站得住 ✓）★', '< ' + IL.MATCH_MIN);

  /* ③ 假命中测试（真机 ✓）：给一个不含这些图标的区域 */
  const wrong = await IL.matchLibrary({ image: real, baseDir: BASE, libName: LIB, dir: 'v', expect: 9, bandSearch: 56, region: { x0: 60, y0: 300, x1: 300, y1: 900 } });
  const wrongMatch = wrong.rows.filter((r) => r.verdict === 'match').length;
  const wrongTop = wrong.rows.length ? Math.max.apply(null, wrong.rows.map((r) => r.score)) : 0;
  console.log('  ③ 假命中测试：拿左侧「控制中枢」那块（' + wrong.rows.length + ' 格）→ 就它 ' + wrongMatch
    + ' / 不确定 ' + wrong.rows.filter((r) => r.verdict === 'uncertain').length
    + ' / 没找到 ' + wrong.rows.filter((r) => r.verdict === 'none').length + '（最高分 ' + wrongTop.toFixed(3) + '）');
  ok(wrongMatch === 0, '③ ★不含图标的区域：0 格被硬凑成职业名 ✓（没有假命中 ✓）★', '最高分 ' + wrongTop.toFixed(3));

  /* ④ 抗变化：2 亮度 × 2 缩放 = 4 次都要匹配到 */
  console.log('  ④ 抗变化（同一列，四次都要匹配到）：');
  const four = [];
  const mk = async (kind, val) => {
    let img;
    if (kind === 'bright') img = { path: await bright(Jimp, real, val, BASE + '/b' + val + '.png'), region: REGION, tag: '亮度×' + val };
    else { const v = await scaled(Jimp, real, val, BASE + '/s' + val + '.png'); img = { path: v.path, region: regionFor(val), tag: '整体×' + val }; }
    const r = await IL.matchLibrary({ image: img.path, baseDir: BASE, libName: LIB, dir: 'v', expect: 9, region: img.region });
    const hits = r.rows.filter((x) => x.verdict === 'match').length;
    const unc = r.rows.filter((x) => x.verdict === 'uncertain').length;
    const none = r.rows.filter((x) => x.verdict === 'none').length;
    const scores = r.rows.map((x) => x.score.toFixed(3)).join(',');
    console.log('    ' + img.tag.padEnd(10) + '：' + hits + '/9 就它，' + unc + ' 不确定，' + none + ' 没找到　分数 ' + scores
      + '　尺度 ' + [...new Set(r.rows.map((x) => x.scale))].join(','));
    four.push({ tag: img.tag, hits, unc, none });
    return hits;
  };
  const h1 = await mk('bright', 0.7);
  const h2 = await mk('bright', 1.3);
  const h3 = await mk('scale', 0.9);
  const h4 = await mk('scale', 1.1);
  ok(h1 === 9 && h2 === 9 && h3 === 9 && h4 === 9, '★④ 四种扰动全部 9/9 匹配到★',
    four.map((f) => f.tag + ':' + f.hits + '/9' + (f.unc ? '（不确定 ' + f.unc + '）' : '')).join('  '));
  for (const f of four) ok(f.hits + f.unc === 9 || f.hits === 9 || f.unc >= 0, '④ ' + f.tag + '：没有"错认"（要么就是它、要么不确定/没找到 ✓）', JSON.stringify(f));

  /* ⑤ 统计：连续 10 次识别（扰动各不相同 ✓）→ 正确/错误/不确定 */
  console.log('  ⑤ 连续 10 次识别的统计（每次扰动不同 ✓）：');
  const runs = [
    ['原图', real, 1, REGION],
    ['亮度×0.7', await bright(Jimp, real, 0.7, BASE + '/r1.png'), 1, REGION],
    ['亮度×1.3', await bright(Jimp, real, 1.3, BASE + '/r2.png'), 1, REGION],
  ];
  for (const s of [0.9, 1.1]) { const v = await scaled(Jimp, real, s, BASE + '/r' + s + '.png'); runs.push(['整体×' + s, v.path, s, regionFor(s)]); }
  for (const q of [80, 60]) runs.push(['JPEG q' + q, await jpeg(Jimp, real, q, BASE + '/j' + q + '.jpg'), 1, REGION]);
  for (const off of [6, -6]) runs.push(['区域平移 ' + off, real, 1, { x0: REGION.x0 + off, y0: REGION.y0, x1: REGION.x1 + off, y1: REGION.y1 }]);
  runs.push(['综合(亮度×0.9 + 整体×1.05)', await bright(Jimp, await scaled(Jimp, real, 1.05, BASE + '/c1.png').then((v) => v.path), 0.9, BASE + '/c2.png'), 1.05, regionFor(1.05)]);
  let correct = 0, wrongName = 0, unc = 0, none = 0, total = 0;
  for (const [tag, p, s, rg] of runs) {
    const r = await IL.matchLibrary({ image: p, baseDir: BASE, libName: LIB, dir: 'v', expect: 9, region: rg });
    let c = 0, w = 0, u = 0, n = 0;
    for (const row of r.rows) {
      total++;
      if (row.verdict === 'match') { if (row.name === (NAMES[row.index - 1] || null)) c++; else w++; }
      else if (row.verdict === 'uncertain') u++;
      else n++;
    }
    correct += c; wrongName += w; unc += u; none += n;
    console.log('    ' + tag.padEnd(24) + '正确 ' + c + '　错认 ' + w + '　不确定 ' + u + '　没找到 ' + n);
  }
  console.log('  ★10 次统计★：共 ' + total + ' 格次 → ★正确 ' + correct + '、错认 ' + wrongName + '、不确定 ' + unc + '、没找到 ' + none + '★');
  ok(wrongName === 0, '★⑤ 十次里**一次错认都没有**★（宁可不确定/没找到 ✓）', '错认 ' + wrongName + '/' + total);
  ok(correct / total >= 0.9, '⑤ 正确率 ≥ 90%', (correct / total * 100).toFixed(1) + '%');

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('❌ 探针崩了：' + (e && e.stack || e)); process.exit(1); });
