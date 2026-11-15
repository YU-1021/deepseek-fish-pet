/* test-iconlib.js —— ★图标模板库的单元测试（合成图 ✓ 不依赖真机 ✓ 纯 Node ✓）★
 *
 * 它守的是"★认不出时不许硬选✗★"这条规矩 ✓：
 *   ① 建库/认库的基本闭环 ✓；② 两个模板长得几乎一样时 → 必须报"不确定"✓（而不是随便挑一个 ✗）；
 *   ③ 完全不相关的图 → 必须报"没找到"✓；④ 亮度变化 → 仍要认得出 ✓（z-score 的作用 ✓）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const IL = require('../src/iconlib');

let pass = 0, fail = 0;
function ok(c, label, extra) {
  if (c) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

const TMP = 'C:/deepseek/iconlib-unittest';

/* 造一张"一列 3 个方块"的图：每个方块里有不同的黑白图案（能区分 ✓）+ 亮背景/暗背景 ✓ */
async function makeImage(Jimp, file, opts) {
  const o = opts || {};
  const W = o.w || 300, H = o.h || 400;
  const img = new Jimp({ width: W, height: H, color: o.bg || 0x202020ff });
  (o.centers || [100, 200, 300]).forEach((cy, i) => {
    const cx = o.cx || 150, r = o.r || 30;
    /* ★每格画**结构完全不同**的图案 ✗→✓（竖条 / 横条 / 斜叉 ✓）——
       第一版只画一个小方块 ✓ → 现场搜窄条时容易搜到背景 ✗ → 三格的补丁长得一模一样 ✗
       → "领先次优"恒为 0 ✗（测试就测不出东西了 ✓）。真实图标本来就是**整格都有内容** ✓。 */
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const lx = x - (cx - r), ly = y - (cy - r);
        let on;
        if (i % 3 === 0) on = (Math.floor(lx / 6) % 2) === 0;                     // 竖条
        else if (i % 3 === 1) on = (Math.floor(ly / 6) % 2) === 0;                // 横条
        else on = Math.abs(lx - ly) < 6 || Math.abs(lx + ly - 2 * r) < 6;        // 斜叉
        img.setPixelColor(on ? 0xf0f0f0ff : 0x303030ff, x, y);
      }
    }
  });
  /* ★噪声图（"肯定不像"的对照 ✓）：每个像素随机灰度 ✓ */
  if (o.noise) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = Math.floor(Math.random() * 256);
      img.setPixelColor((((v << 24) >>> 0) | (v << 16) | (v << 8) | 0xff) >>> 0, x, y);
    }
  }
  fs.writeFileSync(file, await img.getBuffer('image/png'));
  return file;
}
async function brighten(Jimp, src, k, out) {
  const img = await Jimp.fromBuffer(fs.readFileSync(src));
  const d = img.bitmap.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = Math.min(255, Math.round(d[i] * k)); d[i + 1] = Math.min(255, Math.round(d[i + 1] * k)); d[i + 2] = Math.min(255, Math.round(d[i + 2] * k)); }
  fs.writeFileSync(out, await img.getBuffer('image/png'));
  return out;
}

(async () => {
  const Jimp = require('jimp').Jimp;
  fs.mkdirSync(TMP, { recursive: true });
  console.log('=== test-iconlib（合成图）===');
  const a = await makeImage(Jimp, TMP + '/a.png', { w: 400, h: 520, cx: 200, r: 45, centers: [110, 260, 410] });
  /* ★"不相关"的图要真的不相关 ✗→✓：第一版只是"同样的方块换个图案"✓ →
     结果有一格的图案**确实够像**（0.95 ✓）→ 被判成"就是它" ✓ ——
     ★那是**对的**（它真的像 ✓），是我的测试假设错了 ✗ → 换成"纯噪声"这种肯定不像的图 ✓。 */
  const b = await makeImage(Jimp, TMP + '/b.png', { w: 400, h: 520, cx: 200, r: 45, centers: [110, 260, 410], noise: true });

  const built = await IL.buildLibrary({ image: a, baseDir: TMP, libName: 'u1', dir: 'v', expect: 3, names: ['甲', '乙', '丙'] });
  ok(built.index.cells === 3, '① 切出 3 格、每格一个模板', 'n=' + built.index.cells);
  ok(/^t\d\d_/.test(built.index.entries[0].file), '① 文件名带序号', built.index.entries.map((e) => e.file).join(' '));

  const r1 = await IL.matchLibrary({ image: a, baseDir: TMP, libName: 'u1', dir: 'v', expect: 3 });
  ok(r1.rows.every((r) => r.verdict === 'match'), '① 同一张图 3/3 ★就是它★', r1.rows.map((r) => r.name + '@' + r.score.toFixed(2)).join(' '));
  ok(r1.rows.every((r) => r.margin >= IL.MARGIN_MIN), '① 每格都报了"领先次优"且够大', r1.rows.map((r) => r.margin.toFixed(2)).join(','));

  /* ② 库里放两个**几乎一样**的模板 → 认的时候必须报"不确定"✓ */
  const dup = JSON.parse(JSON.stringify(built.index));
  dup.entries.push(Object.assign({}, dup.entries[0], { index: 99, name: '甲的孪生', file: 't99_dup.png' }));
  IL.saveIndex(TMP, 'u2', dup);
  const r2 = await IL.matchLibrary({ image: a, baseDir: TMP, libName: 'u2', dir: 'v', expect: 3 });
  const undecided = r2.rows.filter((r) => r.verdict === 'uncertain').length;
  ok(undecided >= 1, '★② 两个几乎一样的模板 → 报"不确定"（不硬选 ✗）★', '不确定 ' + undecided + '/' + r2.rows.length
    + '，最小领先 ' + Math.min.apply(null, r2.rows.map((r) => (r.margin == null ? 9 : r.margin))).toFixed(3));

  /* ③ 完全不相关的图 → 必须报"没找到"✓ */
  const r3 = await IL.matchLibrary({ image: b, baseDir: TMP, libName: 'u3none', dir: 'v', expect: 3 }).catch(() => null);
  ok(r3 === null, '③ 没有这个库时会明确报错（不是瞎认 ✓）');
  IL.saveIndex(TMP, 'u3', built.index);
  const r3b = await IL.matchLibrary({ image: b, baseDir: TMP, libName: 'u3', dir: 'v', expect: 3 });
  ok(r3b.rows.every((r) => r.verdict !== 'match'), '③ 换了图案的图：一格都没硬凑 ✓',
    r3b.rows.map((r) => r.verdict + ':' + r.score.toFixed(2)).join(' '));

  /* ④ 亮度变了仍要认得出 ✓ */
  const bp = await brighten(Jimp, a, 0.65, TMP + '/a-dark.png');
  const r4 = await IL.matchLibrary({ image: bp, baseDir: TMP, libName: 'u1', dir: 'v', expect: 3 });
  ok(r4.rows.every((r) => r.verdict === 'match'), '④ 亮度 ×0.65 仍 3/3 认得出', r4.rows.map((r) => r.score.toFixed(3)).join(','));

  /* ⑤ 三分的阈值函数本身 ✓ */
  ok(IL.verdictOf(0.99, 0.4) === 'match', '⑤ 0.99/领先0.40 → 就是它');
  ok(IL.verdictOf(0.99, 0.01) === 'uncertain', '⑤ 0.99/领先0.01 → 不确定（差距太小 ✗ 不硬选）');
  ok(IL.verdictOf(0.95, null) === 'uncertain', '⑤ 只有一个模板（没有次优）→ 不确定（没有比较就说不了"就是它"✓）');
  ok(IL.verdictOf(0.30, 0.1) === 'none', '⑤ 0.30 → 没找到');
  ok(IL.verdictOf(0.93, 0.10) === 'match' && IL.verdictOf(0.91, 0.10) === 'uncertain', '⑤ 0.92 这条线是硬的（0.93 过、0.91 不过）');

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('❌ 崩了：' + (e && e.stack || e)); process.exit(1); });
