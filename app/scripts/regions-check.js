/* 校验区块图：把立绘的 alpha 提出来，采样每个多边形，看它是不是落在实心像素上。
 * 用法：先 ffmpeg 导出 alpha 原始数据，再 node 跑这个脚本。
 */
const fs = require('fs');
const path = require('path');

const W = Number(process.argv[2]) || 255;
const H = Number(process.argv[3]) || 340;
const rawPath = process.argv[4] || path.join(__dirname, '..', 'dist', 'art-alpha.raw');
const regPath = process.argv[5] || path.join(__dirname, '..', 'assets', 'pet-regions.json');

const alpha = fs.readFileSync(rawPath);
const j = JSON.parse(fs.readFileSync(regPath, 'utf8'));
if (alpha.length < W * H) { console.error('alpha 数据不足：' + alpha.length + ' < ' + W * H); process.exit(1); }

const solidAt = (x, y) => {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return false;
  return alpha[yi * W + xi] > 16;
};

const pointInPoly = (px, py, poly) => {
  let inside = false;
  for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[k][0], yj = poly[k][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
};

let bad = 0;
const rows = [];
for (const r of j.regions) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of r.poly) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  let inside = 0, solid = 0;
  const N = 24;
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < N; k++) {
      const nx = minX + (maxX - minX) * (i + 0.5) / N;
      const ny = minY + (maxY - minY) * (k + 0.5) / N;
      if (!pointInPoly(nx, ny, r.poly)) continue;
      inside++;
      if (solidAt(nx * W, ny * H)) solid++;
    }
  }
  const ratio = inside ? solid / inside : 0;
  const flag = inside === 0 ? '空多边形' : (ratio < 0.5 ? '⚠ 大多落在透明处' : 'ok');
  if (ratio < 0.5) bad++;
  rows.push({ id: r.id, name: r.name, cover: Math.round(ratio * 100) + '%', flag });
}
const w = Math.max(...rows.map((r) => r.id.length));
for (const r of rows) console.log('  ' + r.id.padEnd(w) + '  ' + r.name.padEnd(6) + ' 实心覆盖 ' + r.cover.padStart(4) + '  ' + r.flag);
console.log('\n总计 ' + rows.length + ' 个区块，覆盖不足 50% 的有 ' + bad + ' 个');
