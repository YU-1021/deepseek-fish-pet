/* match.exe 的精度/性能测试（纯 Node，不需要 Electron）
 *
 * 测试思路（往返验证）：合成一张"屏幕" BGRA 图，把一个**特征明显的方块**放在已知坐标上，
 * 从那个位置裁出模板，再让 match.exe 去全图找 —— 它必须**精确找回同一个位置**。
 * 同一套方法也用于真机：从真实截图里裁一个按钮当模板，回到同一张截图里找，坐标必须吻合。
 *
 * 额外覆盖：噪声干扰、亮度/对比度变化（NCC 应当不敏感）、错误模板应当报 LOW、ROI 限定、性能。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EXE = path.join(__dirname, '..', 'vendor', 'match', 'match.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'matchtest-'));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

/* 造一张 w x h 的 BGRA 图（Uint8Array），背景可选噪声/渐变 */
function makeFrame(w, h, noise) {
  const b = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      let v;
      if (noise) v = (Math.random() * 40 + 100) | 0;
      else v = 120 + ((x + y) % 40);
      b[p] = v; b[p + 1] = v; b[p + 2] = v; b[p + 3] = 255;
    }
  }
  return b;
}

/* 往图上贴一个"特征方块"（内部有规律的花纹，保证模板不是纯色） */
function stamp(b, w, x0, y0, tw, th, mul) {
  mul = mul || 1;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const p = ((y0 + y) * w + (x0 + x)) * 4;
      let v = ((x * 13 + y * 29) % 200) + 20;
      v = Math.max(0, Math.min(255, Math.round(v * mul)));
      b[p] = v; b[p + 1] = v; b[p + 2] = v; b[p + 3] = 255;
    }
  }
}

/* 从图上裁一块出来（当模板） */
function crop(b, w, x0, y0, tw, th) {
  const o = Buffer.alloc(tw * th * 4, 0);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const s = ((y0 + y) * w + (x0 + x)) * 4;
      const d = (y * tw + x) * 4;
      o[d] = b[s]; o[d + 1] = b[s + 1]; o[d + 2] = b[s + 2]; o[d + 3] = 255;
    }
  }
  return o;
}

function writeBin(name, buf) { const p = path.join(TMP, name); fs.writeFileSync(p, buf); return p; }

function runMatch(framePath, fw, fh, tplPath, tw, th, roi, minScore) {
  const args = [framePath, String(fw), String(fh), tplPath, String(tw), String(th)];
  if (roi) args.push(String(roi[0]), String(roi[1]), String(roi[2]), String(roi[3]));
  if (minScore != null) { if (!roi) args.push('0', '0', String(fw), String(fh)); args.push(String(minScore)); }
  let out = '';
  try { out = execFileSync(EXE, args, { encoding: 'utf8', timeout: 60000 }); }
  catch (e) { out = String((e && e.stdout) || '') + String((e && e.stderr) || ''); }
  const m = String(out).trim().match(/^(OK|LOW|ERR)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+ms=(\d+))?/);
  if (!m) return { tag: 'ERR', raw: String(out).trim() };
  return { tag: m[1], score: Number(m[2]), x: Number(m[3]), y: Number(m[4]), w: Number(m[5]), h: Number(m[6]), ms: m[7] ? Number(m[7]) : null };
}

console.log('=== match.exe 测试（' + EXE + '）===');
if (!fs.existsSync(EXE)) { console.log('  ❌ match.exe 不存在'); process.exit(1); }

const W = 1920, H = 1080, TW = 64, TH = 48;

/* §1 纯噪声背景 + 特征方块：必须精确命中 */
{
  const f = makeFrame(W, H, true);
  const TX = 1418, TY = 806;              // 故意挑一个不对称的位置
  stamp(f, W, TX, TY, TW, TH);
  const fp = writeBin('f1.bin', f);
  const tp = writeBin('t1.bin', crop(f, W, TX, TY, TW, TH));
  const r = runMatch(fp, W, H, tp, TW, TH);
  ok(r.tag === 'OK' && r.score > 0.99, '§1 噪声背景里精确命中', JSON.stringify(r));
  ok(r.x === TX + TW / 2 && r.y === TY + TH / 2, '§1 中心坐标精确（' + (TX + TW / 2) + ',' + (TY + TH / 2) + '）', '得到 (' + r.x + ',' + r.y + ')');
  console.log('      全屏匹配耗时: ' + r.ms + 'ms');
}

/* §2 亮度整体变化（×0.55）—— NCC 应当不敏感 */
{
  const f = makeFrame(W, H, true);
  const TX = 700, TY = 240;
  stamp(f, W, TX, TY, TW, TH, 1);
  const tp = writeBin('t2.bin', crop(f, W, TX, TY, TW, TH));   // 模板取自原始亮度
  const f2 = Buffer.from(f);
  stamp(f2, W, TX, TY, TW, TH, 0.55);                          // 画面里那块变暗了
  const fp = writeBin('f2.bin', f2);
  const r = runMatch(fp, W, H, tp, TW, TH);
  ok(r.tag === 'OK' && r.score > 0.95, '§2 变暗 55% 仍能命中', 'score=' + r.score);
  ok(Math.abs(r.x - (TX + TW / 2)) <= 1 && Math.abs(r.y - (TY + TH / 2)) <= 1, '§2 坐标仍准（±1px）', '得到 (' + r.x + ',' + r.y + ')');
}

/* §3 模板不在画面里 → 必须报 LOW（不能瞎给一个高分的假位置） */
{
  const f = makeFrame(W, H, true);
  stamp(f, W, 300, 300, TW, TH);
  const fp = writeBin('f3.bin', f);
  const f2 = makeFrame(W, H, true);
  const tp = writeBin('t3.bin', crop(f2, W, 900, 500, TW, TH));   // 从另一张图裁的模板
  const r = runMatch(fp, W, H, tp, TW, TH);
  ok(r.tag === 'LOW' || r.score < 0.7, '§3 模板不在画面里时报 LOW', JSON.stringify(r));
}

/* §4 ROI 限定：目标在 ROI 内时必须命中，且比全屏快 */
{
  const f = makeFrame(W, H, true);
  const TX = 1500, TY = 900;
  stamp(f, W, TX, TY, TW, TH);
  const fp = writeBin('f4.bin', f);
  const tp = writeBin('t4.bin', crop(f, W, TX, TY, TW, TH));
  const r = runMatch(fp, W, H, tp, TW, TH, [1400, 840, 400, 240]);
  ok(r.tag === 'OK' && r.score > 0.99, '§4 ROI 内命中', JSON.stringify(r));
  ok(Math.abs(r.x - (TX + TW / 2)) <= 1 && Math.abs(r.y - (TY + TH / 2)) <= 1, '§4 ROI 内坐标精确', '得到 (' + r.x + ',' + r.y + ')');
}

/* §5 多个**完全相同**的目标：两个都是一样的按钮，命中哪个都对；
      真正要保证的是**确定性** —— 同一张图每次必须给同一个答案（否则她重试一次就"跑"到别处去了）。
      注：之所以不要求"必须左上"，是因为半分辨率粗搜阶段两处的分数会因周围噪声略有差异，
      而这两个目标在语义上完全等价。要"精确取第 N 个"属于 MAA 那种 order_by+index 的扩展，见 TODO。 */
{
  const f = makeFrame(W, H, true);
  stamp(f, W, 200, 150, TW, TH);
  stamp(f, W, 900, 600, TW, TH);
  const fp = writeBin('f5.bin', f);
  const tp = writeBin('t5.bin', crop(f, W, 200, 150, TW, TH));
  const r = runMatch(fp, W, H, tp, TW, TH);
  ok(r.tag === 'OK' && r.score > 0.99, '§5 有重复目标时给高分', 'score=' + r.score);
  const atFirst = Math.abs(r.x - (200 + TW / 2)) <= 2 && Math.abs(r.y - (150 + TH / 2)) <= 2;
  const atSecond = Math.abs(r.x - (900 + TW / 2)) <= 2 && Math.abs(r.y - (600 + TH / 2)) <= 2;
  ok(atFirst || atSecond, '§5 命中的是其中一个真实目标', '得到 (' + r.x + ',' + r.y + ')');
  const r2 = runMatch(fp, W, H, tp, TW, TH);
  const r3 = runMatch(fp, W, H, tp, TW, TH);
  ok(r2.x === r.x && r2.y === r.y && r3.x === r.x && r3.y === r.y,
    '§5 **确定性**：同样输入三次给同一个坐标', '(' + r.x + ',' + r.y + ') x3');
}

/* §6 参数错误要给出可读的 ERR，而不是崩掉 */
{
  const r = runMatch('不存在的文件.bin', W, H, '也不存在.bin', TW, TH);
  ok(r.tag === 'ERR', '§6 文件不存在时报 ERR', r.raw || '');
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
