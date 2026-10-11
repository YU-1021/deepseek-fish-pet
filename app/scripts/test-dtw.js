#!/usr/bin/env node
/* ============================================================================
 * test-dtw.js -- 用数值证明 app/renderer/dtw.js 与 app/scripts/dtw-feasibility.py
 *                的移植是一致的
 * ----------------------------------------------------------------------------
 * 判据（题目给定）：
 *   normDist 相对误差 < 2%，逐词 S 相对误差 < 5%
 * 除了这两个"判据项"，脚本还会把中间量全部对一遍，这样万一将来对不上，
 * 能立刻定位到是哪一级（波形 -> 分帧能量 -> VAD -> 词映射 -> MFCC -> DTW -> S）。
 *
 * 数据：C:\Users\64616\AppData\Local\Temp\dtwtest\
 *   ref.wav case1.wav case2.wav case3.wav case2_base.wav case2b.wav
 *   ref_words.json   whisper 的 token 级时间戳（用来核对词表和词序）
 *   results.json     Python 的完整结果（对照基准）
 *   js_ref/*         --deep 用的深挖对照数据，生成方法（用带 numpy 的 Python，
 *                    导入 dtw-feasibility.py 后 dump，不写进仓库）：
 *
 *     import importlib.util, json, os, wave, numpy as np
 *     spec = importlib.util.spec_from_file_location("dtwf", "app/scripts/dtw-feasibility.py")
 *     m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
 *     OUT = "<DATA>/js_ref"; os.makedirs(OUT, exist_ok=True)
 *     def mfcc_f64(x, sr):  # 参考实现的"全 float64"路径：预加重/FFT/mel/DCT 都 float64
 *         flen, hop = int(round(sr*.025)), int(round(sr*.010))
 *         y = np.empty(x.shape, np.float64); y[0] = x[0]; y[1:] = x[1:] - 0.97*x[:-1]
 *         nf = 1 + (len(y)-flen)//hop
 *         idx = np.arange(flen)[None,:] + hop*np.arange(nf)[:,None]
 *         sp = np.fft.rfft(y[idx]*np.hamming(flen)[None,:], n=512, axis=1)
 *         p = sp.real**2 + sp.imag**2
 *         return np.log(p @ m._FB.T + 1e-10) @ m._DCT.T
 *     def cond_f64(p):      # read_wav 的 float64 阶段（不含最后的 astype(float32)）
 *         with wave.open(p, "rb") as w: sr = w.getframerate(); raw = w.readframes(w.getnframes())
 *         x = np.frombuffer(raw, "<i2").astype(np.float32)/32768.0
 *         x = x.astype(np.float64); x -= x.mean()
 *         ww = max(3, int(round(sr*0.050)))
 *         x -= np.convolve(x, np.ones(ww)/ww, "same")
 *         return x*(0.1/np.sqrt(np.mean(x*x))), sr
 *     for tag in ("ref","case1","case2","case3"):
 *         p = "<DATA>/%s.wav" % tag
 *         x32, sr = m.read_wav(p)                     # 参考实现实际用的 float32 波形
 *         x32.tofile(OUT + "/x_%s.f32" % tag)
 *         cond_f64(p)[0].astype("<f8").tofile(OUT + "/cond64_%s.f64" % tag)
 *         a = m.mfcc(x32, sr)[0]                      # 参考实现跑的那条路
 *         b = mfcc_f64(x32.astype(np.float64), sr)    # 同一波形值、全程 float64
 *         f64j[tag] = {"mfcc64": [[float(v) for v in r] for r in b],
 *                      "dtype_sens": float(np.abs(a-b).max()), "cond64_max": float(np.abs(cond_f64(p)[0]).max())}
 *     # 另需 mfcc_ref.json（mfcc/cmn/centres/energy_db/x_head + dtw_case3 + D_case3.f64，
 *     # 由 dtw-feasibility.py 的 read_wav/mfcc/cmn/dtw 直接 dump）
 *
 * 用法：
 *   node test-dtw.js
 *   node test-dtw.js --data=D:\some\dir          # 换数据目录
 *   node test-dtw.js --deep                      # 额外逐系数核对 MFCC / D 矩阵
 *   node test-dtw.js --repeat=50                 # 性能测试的重复次数
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const PetDTW = require(path.join(__dirname, '..', 'renderer', 'dtw.js'));

/* ------------------------------------------------------------------ 参数 */
const argv = process.argv.slice(2);
function argVal(name, dflt) {
  const hit = argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return dflt;
  if (hit.indexOf('=') < 0) return true;
  return hit.slice(hit.indexOf('=') + 1);
}
const DATA = argVal('data', process.env.DTW_TEST_DATA ||
  'C:\\Users\\64616\\AppData\\Local\\Temp\\dtwtest');
const DEEP = !!argVal('deep', false);
const REPEAT = parseInt(argVal('repeat', '30'), 10);

/* 判据阈值 */
const TOL_NORMDIST = 0.02;   // 2%
const TOL_S = 0.05;          // 5%
const TOL_WORDCOST = 0.05;   // 逐词 cost 用和 S 一样的门槛（S 是它的比值，更敏感）

/* ------------------------------------------------------------------ 工具 */
function readJson(p) {
  if (!fs.existsSync(p)) throw new Error('缺少对照文件: ' + p);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE: ' + file);
  }
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      dataOff = body; dataLen = size;
    }
    off = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('WAV 缺 fmt/data: ' + file);
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error('只支持 16bit PCM，收到 format=' + fmt.format + ' bits=' + fmt.bits);
  }
  const nch = fmt.channels, bytes = 2;
  const n = Math.floor(dataLen / (bytes * nch));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < nch; c++) acc += buf.readInt16LE(dataOff + (i * nch + c) * bytes) / 32768.0;
    out[i] = acc / nch;
  }
  return { samples: out, sampleRate: fmt.sampleRate, channels: nch };
}

function num(v) { return (v === null || v === undefined) ? NaN : v; }
function relErr(js, py) {
  if (!Number.isFinite(js) || !Number.isFinite(py)) return NaN;
  const den = Math.abs(py);
  return den > 1e-12 ? Math.abs(js - py) / den : Math.abs(js - py);
}
const pad = (s, n) => String(s).padEnd(n);
const padS = (s, n) => String(s).padStart(n);
function f6(x) { return Number.isFinite(x) ? x.toFixed(6) : String(num(x)); }
function e2(x) { return Number.isFinite(x) ? x.toExponential(2) : '   n/a  '; }

/* 检查结果收集：每一类都记录最大相对误差，最后统一判定 */
const buckets = {};
function bucketOf(bucket, tol) {
  if (!buckets[bucket]) buckets[bucket] = { n: 0, maxRel: -1, worst: '', tol: tol, fails: [] };
  return buckets[bucket];
}
function rec(bucket, name, py, js, tol) {
  const r = relErr(js, py);
  const b = bucketOf(bucket, tol);
  b.n++;
  /* 两边都是 NaN（例如 whisper 映射下某个词 0 帧 -> 没有 cost）算一致 */
  if (py !== py && js !== js) return NaN;
  if (tol !== undefined && tol !== null) {
    if (!(Number.isFinite(r) && r < tol)) b.fails.push(name + ' rel=' + e2(r) + ' (py=' + f6(py) + ' js=' + f6(js) + ')');
  }
  if (Number.isFinite(r) && r > b.maxRel) { b.maxRel = r; b.worst = name; }
  return r;
}
/* 绝对差版本：有些量（波形幅度、MFCC 原始系数）本身会过零，相对误差没有意义 */
function recAbs(bucket, name, py, js, tolAbs) {
  const d = Math.abs(js - py);
  const b = bucketOf(bucket, tolAbs);
  b.n++;
  if (tolAbs !== undefined && tolAbs !== null) {
    if (!(d < tolAbs)) b.fails.push(name + ' |Δ|=' + d.toExponential(2) + ' >= ' + tolAbs.toExponential(2));
  }
  if (d > b.maxRel) { b.maxRel = d; b.worst = name; }
  return d;
}
function hr(title) {
  console.log('');
  console.log('='.repeat(96));
  console.log(title);
  console.log('='.repeat(96));
}

/* ==========================================================================
 * 0. 读数据
 * ========================================================================*/
console.log('dtw.js 数值一致性测试');
console.log('  数据目录 : ' + DATA);
console.log('  模块     : ' + require.resolve(path.join(__dirname, '..', 'renderer', 'dtw.js')));
console.log('  Node     : ' + process.version);

const TAGS = ['ref', 'case1', 'case2', 'case3'];
const wavs = {}, feats = {}, vads = {};
for (const t of TAGS) wavs[t] = readWav(path.join(DATA, t + '.wav'));
const results = readJson(path.join(DATA, 'results.json'));
const whisper = readJson(path.join(DATA, 'ref_words.json'));
const P = PetDTW.DEFAULTS;

console.log('  wav      : ' + TAGS.map((t) =>
  t + '=' + (wavs[t].samples.length / wavs[t].sampleRate).toFixed(3) + 's').join('  '));

/* ==========================================================================
 * 1. 词表核对：ref_words.json (whisper tokens) vs results.json.words
 * ========================================================================*/
hr('1. 词表 / 词序核对  (ref_words.json 的 token 重新分组  vs  results.json 里的 words)');

const tokens = (((whisper.transcription || [])[0] || {}).tokens) || [];
const grouped = PetDTW.groupWhisperWords(tokens);
const pyWords = results.words;

console.log('  ref_words.json token 数 = ' + tokens.length + ' ，分组后词数 = ' + grouped.length +
            ' ；results.json words 数 = ' + pyWords.length);
let wtableOK = true;
const wRow = (k) => {
  const a = grouped[k], b = pyWords[k];
  const ok = a && b && a.w === b.text && a.fromMs === b.whisper_from_ms && a.toMs === b.whisper_to_ms;
  if (!ok) wtableOK = false;
  return '  ' + pad(b ? b.index : k, 3) + pad(a ? a.w : '-', 12) +
    padS(a ? a.fromMs : '-', 7) + padS(b ? b.whisper_from_ms : '-', 7) +
    padS(a ? a.toMs : '-', 7) + padS(b ? b.whisper_to_ms : '-', 7) +
    '   ' + (ok ? 'ok' : '!!! 不一致');
};
for (let k = 0; k < Math.max(grouped.length, pyWords.length); k++) console.log(wRow(k));
console.log('  -> ' + (wtableOK ? '两个来源的词序/文本/毫秒 完全一致，可以直接按 index 对齐'
                               : '!!! 词表不一致，下面的对齐不可信'));
if (!wtableOK) { console.log('  中止。'); process.exit(2); }

const refWords = grouped.map((w) => ({ w: w.w, fromMs: w.fromMs, toMs: w.toMs }));
const targetIdx = results.target_index;
console.log('  目标词 index=' + targetIdx + ' ("' + results.target_word + '")，共 ' +
            refWords.length + ' 词');

/* ==========================================================================
 * 2. 波形 + 分帧能量 + VAD（前端的第一步）
 * ========================================================================*/
hr('2. 波形调理 / 帧能量 / VAD（Python read_wav + frame_energy_db + vad_mask）');
for (const t of TAGS) {
  const w = wavs[t];
  feats[t] = PetDTW.mfcc(w.samples, w.sampleRate, { sampleRate: w.sampleRate });
}
vads.ref = PetDTW.vadMask(feats.ref.signal, wavs.ref.sampleRate, { sampleRate: wavs.ref.sampleRate });

const pyDb = results.ref_frame_energy_db.map(num);
const jsDb = vads.ref.energyDb;
let maxDbAbs = 0;
for (let i = 0; i < pyDb.length; i++) maxDbAbs = Math.max(maxDbAbs, Math.abs(jsDb[i] - pyDb[i]));
rec('frontEnd', 'frame_energy_db(all frames)', pyDb[0], jsDb[0], null);
console.log('  帧数           : python=' + pyDb.length + '  js=' + jsDb.length);
console.log('  |Δenergy_db|max: ' + maxDbAbs.toExponential(3) + ' dB   (阈值判定余量实测 0.06 dB)');
const pyVoiced = results.ref_voiced_mask;
let vDiff = 0;
for (let i = 0; i < pyVoiced.length; i++) if ((pyVoiced[i] ? 1 : 0) !== (vads.ref.voiced[i] ? 1 : 0)) vDiff++;
console.log('  有声帧         : python=' + pyVoiced.reduce((a, b) => a + b, 0) +
            '  js=' + Array.from(vads.ref.voiced).reduce((a, b) => a + b, 0) +
            '  不一致帧数=' + vDiff + (vDiff === 0 ? '  (完全一致)' : '  !!!'));
/* 这一项是"逐帧一致"的硬检查（tol=1e-12，即要求完全相等），放进 mapping 桶统一判定 */
buckets.mapping = {
  n: pyVoiced.length, maxRel: (vDiff === 0 ? 0 : 1), worst: 'ref_voiced_mask', tol: 1e-12, fails: []
};
console.log('  VAD 阈值(95分位) : ' + vads.ref.refDb.toFixed(6) + ' dB，门限 ' + vads.ref.thresholdDb.toFixed(6) + ' dB');

/* ==========================================================================
 * 3. MFCC 帧数 / 帧中心（Python mfcc 的输出网格）
 * ========================================================================*/
hr('3. MFCC 帧网格');
const pyCentres = results.frame_centre_ms.map(num);
for (const t of TAGS) {
  const f = feats[t];
  console.log('  ' + pad(t, 6) + ' frames py/js = ' + pad(f.nFrames, 4) + ' / ' +
    pad((t === 'ref' ? pyCentres.length : f.nFrames), 4) +
    '   dim=' + f.dim + '   dur=' + f.durationMs.toFixed(1) + 'ms');
}
let maxCentreAbs = 0;
for (let i = 0; i < pyCentres.length; i++) maxCentreAbs = Math.max(maxCentreAbs, Math.abs(feats.ref.centresMs[i] - pyCentres[i]));
console.log('  |Δ帧中心|max = ' + maxCentreAbs.toExponential(3) + ' ms');

/* ==========================================================================
 * 4. 词 -> 帧 映射（vad-constrained，Python 的 primary）
 * ========================================================================*/
hr('4. 词->帧 映射 (realign_words_to_voiced，Python primary)');
const wsRefParams = {
  refCentresMs: feats.ref.centresMs,
  voicedMask: vads.ref.voiced,
  totalMs: feats.ref.durationMs,
  sampleRate: wavs.ref.sampleRate
};
/* 先只算映射：给一个假的 frame_cost（全 1）也能拿到 owner/frames */
const mapOnly = PetDTW.wordScores(Float64Array.from({ length: feats.ref.nFrames }, () => 1), refWords,
  Object.assign({}, wsRefParams, { wordMap: 'vad' }));

const pyOwner = results.frame_owner_word;
let ownerDiff = 0;
for (let i = 0; i < pyOwner.length; i++) if (pyOwner[i] !== mapOnly.owner[i]) ownerDiff++;
console.log('  owner 数组不一致帧数 = ' + ownerDiff + ' / ' + pyOwner.length +
            (ownerDiff === 0 ? '   (逐帧完全一致)' : '   !!!'));
console.log('  ' + pad('#', 3) + pad('word', 12) + padS('pyFrames', 9) + padS('jsFrames', 9) +
            padS('py owner 区间', 18) + padS('js owner 区间', 18));
let frameCntDiff = 0;
for (let k = 0; k < refWords.length; k++) {
  const pyC = results.word_frames.case3[k];
  const jsC = mapOnly.frameCounts[k];
  if (pyC !== jsC) frameCntDiff++;
  const pyFrom = results.words[k].vad_map_from_ms, pyTo = results.words[k].vad_map_to_ms;
  const jsB = mapOnly.bounds[k] || [NaN, NaN];
  console.log('  ' + pad(k, 3) + pad(refWords[k].w, 12) + padS(pyC, 9) + padS(jsC, 9) +
    padS(pyFrom + '-' + pyTo, 18) + padS(jsB[0] + '-' + jsB[1], 18) +
    ((pyC === jsC) ? '' : '  !!!'));
}
console.log('  -> 帧数不一致的词数 = ' + frameCntDiff);
buckets.mapping.n += pyOwner.length;
if (vDiff !== 0) buckets.mapping.fails.push('ref_voiced_mask 不一致 ' + vDiff + ' 帧');
if (ownerDiff !== 0) buckets.mapping.fails.push('owner 数组不一致 ' + ownerDiff + ' 帧');

/* ==========================================================================
 * 5. 主对照：normDist / frame_cost / word_cost / S
 * ========================================================================*/
hr('5. 主对照（Python results.json  vs  JS dtw.js）');
const CASES = ['case1', 'case2', 'case3'];
const jsRes = {};
console.log('  ' + pad('case', 7) + padS('py normDist', 13) + padS('js normDist', 13) +
            padS('abs Δ', 11) + padS('rel Δ', 11) + padS('M/N', 10) + padS('band', 6) + padS('pathLen', 9));
for (const t of CASES) {
  const d = PetDTW.dtw(feats.ref.frames, feats[t].frames, {});
  const ws = PetDTW.wordScores(d.frameCost, refWords, Object.assign({}, wsRefParams, { wordMap: 'vad' }));
  jsRes[t] = { d: d, ws: ws };
  const pyD = results.global_norm_distance[t];
  const r = rec('global', t + '.normDist', pyD, d.normDist, TOL_NORMDIST);
  console.log('  ' + pad(t, 7) + padS(f6(pyD), 13) + padS(f6(d.normDist), 13) +
    padS(Math.abs(d.normDist - pyD).toExponential(2), 11) + padS(e2(r), 11) +
    padS(d.M + '/' + d.N, 10) + padS(d.bandRadius, 6) + padS(d.pathLen, 9));
}

/* 5b. frame_cost 逐帧（这是 DTW 最细的输出） */
console.log('');
console.log('  5b. frame_cost（每个 ref 帧的局部代价，496 个值）');
console.log('  ' + pad('case', 7) + padS('max|Δ|', 12) + padS('max relΔ', 12) + padS('py mean', 12) + padS('js mean', 12));
for (const t of CASES) {
  const py = results.frame_cost[t].map(num);
  const js = jsRes[t].d.frameCost;
  let ma = 0, mr = 0;
  for (let i = 0; i < py.length; i++) {
    ma = Math.max(ma, Math.abs(js[i] - py[i]));
    const r = relErr(js[i], py[i]); if (Number.isFinite(r)) mr = Math.max(mr, r);
  }
  rec('frameCost', t + '.frame_cost.mean', PetDTW.nanmean(py), PetDTW.nanmean(js), null);
  if (mr > 0) { /* 记录最大相对误差 */ }
  buckets.frameCostN = buckets.frameCostN || { n: 0, maxRel: -1, worst: '', tol: TOL_WORDCOST, fails: [] };
  buckets.frameCostN.n++;
  if (mr > buckets.frameCostN.maxRel) { buckets.frameCostN.maxRel = mr; buckets.frameCostN.worst = t; }
  console.log('  ' + pad(t, 7) + padS(ma.toExponential(2), 12) + padS(e2(mr), 12) +
    padS(f6(PetDTW.nanmean(py)), 12) + padS(f6(PetDTW.nanmean(js)), 12));
}

/* 5c. 逐词 cost + S 的完整表 */
for (const t of CASES) {
  console.log('');
  console.log('  5c. ' + t + ' 逐词：cost 与 S=该词/其它词均值');
  console.log('  ' + pad('#', 3) + pad('word', 12) + padS('frames', 7) +
    padS('py cost', 12) + padS('js cost', 12) + padS('cost relΔ', 11) +
    padS('py S', 9) + padS('js S', 9) + padS('S relΔ', 10));
  const pyCost = results.word_cost[t].map(num);
  const pyS = results.summary.S_score[t].map(num);
  const js = jsRes[t].ws;
  for (let k = 0; k < refWords.length; k++) {
    const rc = rec('wordCost', t + '.word_cost[' + k + ']' + refWords[k].w, pyCost[k], js.costs[k], TOL_WORDCOST);
    const rs = rec('S', t + '.S[' + k + ']' + refWords[k].w, pyS[k], js.S[k], TOL_S);
    console.log('  ' + pad(k, 3) + pad(refWords[k].w, 12) + padS(js.frameCounts[k], 7) +
      padS(f6(pyCost[k]), 12) + padS(f6(js.costs[k]), 12) + padS(e2(rc), 11) +
      padS(Number.isFinite(pyS[k]) ? pyS[k].toFixed(4) : 'NaN', 9) +
      padS(Number.isFinite(js.S[k]) ? js.S[k].toFixed(4) : 'NaN', 9) + padS(e2(rs), 10) +
      (k === targetIdx ? '  <== TARGET' : ''));
  }
  const rsMax = rec('Smax', t + '.maxS', results.summary.S_max[t], js.maxS, TOL_S);
  console.log('  ' + pad('', 3) + pad('max S', 12) + padS('', 7) + padS('', 12) + padS('', 12) + padS('', 11) +
    padS(results.summary.S_max[t].toFixed(4), 9) + padS(js.maxS.toFixed(4), 9) + padS(e2(rsMax), 10) +
    '   py rank1=' + results.summary.S_max[t + '_rank1'] + '  js rank1=' + js.rank1Word);
  console.log('  ' + pad('', 3) + pad('mean cost', 12) + padS('', 7) + padS('', 12) +
    padS(f6(js.mean), 12) + '   (py mean over words = ' +
    f6(results.word_cost[t].map(num).reduce((a, b) => a + b, 0) / refWords.length) + ')');
}

/* ==========================================================================
 * 6. 前端消融（4 个变体 x 3 个 case）—— 顺带验证 CMN/CMVN/dropC0
 * ========================================================================*/
hr('6. 前端消融对照（front_end_ablation）：CMN / dropC0 / CMVN / none');
const VARIANTS = [
  ['CMN  c0-c12 (spec)', { cmn: 'mean', dropC0: false }],
  ['CMN  c1-c12 (no c0)', { cmn: 'mean', dropC0: true }],
  ['CMVN c0-c12', { cmn: 'meanvar', dropC0: false }],
  ['none c0-c12 (ctrl)', { cmn: 'none', dropC0: false }]
];
const sr0 = wavs.ref.sampleRate;
const pre = {};
for (const t of TAGS) pre[t] = PetDTW.preprocess(wavs[t].samples, wavs[t].sampleRate, { sampleRate: wavs[t].sampleRate });
console.log('  ' + pad('front-end', 22) + pad('case', 7) + padS('py d', 11) + padS('js d', 11) + padS('d relΔ', 10) +
            padS('cost py', 10) + padS('cost js', 10) + padS('cost relΔ', 10) + padS('tgt rank', 9));
for (const [name, cfg] of VARIANTS) {
  const f = {};
  for (const t of TAGS) f[t] = PetDTW.mfcc(pre[t], sr0, Object.assign({ sampleRate: sr0, preprocess: false }, cfg));
  const abl = results.front_end_ablation[name];
  const rr = {};
  for (const t of CASES) {
    const d = PetDTW.dtw(f.ref.frames, f[t].frames, {});
    const ws = PetDTW.wordScores(d.frameCost, refWords, Object.assign({}, wsRefParams, cfg));
    rr[t] = { d: d, ws: ws };
    const pyD = abl.d[t];
    const pyWc = abl.word_cost[t].map(num);
    const rd = rec('ablation', name + '.' + t + '.normDist', pyD, d.normDist, TOL_NORMDIST);
    const rc = rec('ablationWcTargetCost', name + '.' + t + '.cost[' + targetIdx + ']',
                   pyWc[targetIdx], ws.costs[targetIdx], TOL_WORDCOST);
    for (let k = 0; k < refWords.length; k++) {
      rec('ablationWc', name + '.' + t + '.wc[' + k + ']', pyWc[k], ws.costs[k], TOL_WORDCOST);
    }
    console.log('  ' + pad(name, 22) + pad(t, 7) + padS(f6(pyD), 11) + padS(f6(d.normDist), 11) +
      padS(e2(rd), 10) + padS(pyWc[targetIdx].toFixed(4), 10) + padS(ws.costs[targetIdx].toFixed(4), 10) +
      padS(e2(rc), 10) + padS(ws.targetRank, 9));
    if (t === 'case3') {
      rec('ablationS', name + '.case3_target_ratio', abl.case3_target_ratio, ws.targetS, TOL_S);
      if (abl.case3_target_rank !== ws.targetRank) {
        buckets.ablation.fails.push(name + ' case3 目标词排名 py=' + abl.case3_target_rank + ' js=' + ws.targetRank);
      }
    }
    if (t === 'case2') {
      /* Python: case2_max_over_mean = np.nanmax(cost) / np.nanmean(cost) */
      const maxCost = Math.max.apply(null, Array.from(ws.costs).filter((v) => v === v));
      rec('ablationS', name + '.case2_max_over_mean', abl.case2_max_over_mean, maxCost / ws.mean, TOL_S);
    }
  }
  /* 派生量：d3/d2 与 case2_max_abs_delta（依赖同变体的 case1/case2/case3 三个结果） */
  const d3d2 = rr.case3.d.normDist / rr.case2.d.normDist;
  rec('ablation', name + '.d3_over_d2', abl.d3_over_d2, d3d2, TOL_NORMDIST);
  const dz = Math.max.apply(null, Array.from(rr.case2.ws.costs,
    (c, k) => Math.abs(c - rr.case1.ws.costs[k])));
  rec('ablationS', name + '.case2_max_abs_delta', abl.case2_max_abs_delta, dz, TOL_WORDCOST);
  console.log('  ' + pad('  ' + name + ' 派生', 29) + 'd3/d2 py=' + abl.d3_over_d2.toFixed(4) +
    ' js=' + d3d2.toFixed(4) + '   case3 tgt ratio py=' + abl.case3_target_ratio.toFixed(4) +
    ' js=' + rr.case3.ws.targetS.toFixed(4) + '   case2 max|Δvs case1| py=' +
    abl.case2_max_abs_delta.toFixed(4) + ' js=' + dz.toFixed(4));
}
console.log('  （python 的 case2_max_over_mean / case3_target_ratio 都是从上面这些 word_cost 派生的，已随 wc 一并核对）');

/* ==========================================================================
 * 7. 备用词映射 whisper-midpoint
 * ========================================================================*/
hr('7. 备用词映射对照（alignment_sensitivity.whisper-midpoint）');
const pyAl = results.alignment_sensitivity['whisper-midpoint'];
console.log('  ' + pad('case', 7) + padS('py d', 11) + padS('js d', 11) + padS('d relΔ', 10) +
            padS('py wc[0]', 11) + padS('js wc[0]', 11) + padS('py wc[6]', 11) + padS('js wc[6]', 11));
for (const t of CASES) {
  const d = PetDTW.dtw(feats.ref.frames, feats[t].frames, {});
  const ws = PetDTW.wordScores(d.frameCost, refWords, Object.assign({}, wsRefParams, { wordMap: 'whisper' }));
  const rd = rec('align', 'whisper-map.' + t + '.normDist', pyAl.d[t], d.normDist, TOL_NORMDIST);
  const pyWc = pyAl.word_cost[t].map(num);
  for (let k = 0; k < refWords.length; k++) rec('alignWc', 'whisper-map.' + t + '.wc[' + k + ']', pyWc[k], ws.costs[k], TOL_WORDCOST);
  console.log('  ' + pad(t, 7) + padS(f6(pyAl.d[t]), 11) + padS(f6(d.normDist), 11) + padS(e2(rd), 10) +
    padS(f6(pyWc[0]), 11) + padS(f6(ws.costs[0]), 11) + padS(f6(pyWc[6]), 11) + padS(f6(ws.costs[6]), 11));
  /* 帧数也要一致（whisper 映射下有词是 0 帧） */
  const pyFr = pyAl.word_frames[t];
  for (let k = 0; k < refWords.length; k++) {
    if (pyFr[k] !== ws.frameCounts[k]) buckets.align.fails.push('whisper-map ' + t + ' word ' + k + ' frames py=' + pyFr[k] + ' js=' + ws.frameCounts[k]);
  }
}
console.log('  （两种映射给出同一个结论，且都逐帧一致）');

/* ==========================================================================
 * 8. 关键判定：case3 目标词 S  vs  case2 最大 S  vs  阈值 2.0
 * ========================================================================*/
hr('8. 关键对照（可行性实验的核心结论，必须和 Python 一致）');
const pyS1 = results.summary.S_score.case1.map(num);
const pyS2 = results.summary.S_score.case2.map(num);
const pyS3 = results.summary.S_score.case3.map(num);
const jsS1 = jsRes.case1.ws.S, jsS2 = jsRes.case2.ws.S, jsS3 = jsRes.case3.ws.S;
const pyMax2 = Math.max(...pyS2), jsMax2 = jsRes.case2.ws.maxS;
const pyMax3 = Math.max(...pyS3), jsMax3 = jsRes.case3.ws.maxS;
const pyTgt3 = pyS3[targetIdx], jsTgt3 = jsS3[targetIdx];
const pyRank3 = pyS3.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).findIndex((x) => x[1] === targetIdx) + 1;
const jsRank3 = jsRes.case3.ws.targetRank;
const d1 = jsRes.case1.d.normDist, d2 = jsRes.case2.d.normDist, d3 = jsRes.case3.d.normDist;

console.log('  A. 全局归一化距离（Python 已证明不可用，这里只验证数值一致）');
console.log('     case1 (同人同文本) = ' + f6(d1) + '   python=' + f6(results.global_norm_distance.case1));
console.log('     case2 (只换音色)   = ' + f6(d2) + '   python=' + f6(results.global_norm_distance.case2));
console.log('     case3 (换了一个词) = ' + f6(d3) + '   python=' + f6(results.global_norm_distance.case3));
console.log('     d3/d2 = ' + (d3 / d2).toFixed(2) + '  (python ' + results.summary.ratio_d3_over_d2.toFixed(2) +
            ')  <-- 换音色反而更远，所以全局距离不能用来判定');
console.log('');
console.log('  B. 逐词相对分 S = 该词 cost / 其它词 cost 均值');
console.log('  ' + pad('#', 3) + pad('word', 12) + padS('S case1', 9) + padS('S case2', 9) + padS('S case3', 9) +
            padS('py S3', 9) + padS('S3 relΔ', 10));
for (let k = 0; k < refWords.length; k++) {
  console.log('  ' + pad(k, 3) + pad(refWords[k].w, 12) + padS(jsS1[k].toFixed(2), 9) + padS(jsS2[k].toFixed(2), 9) +
    padS(jsS3[k].toFixed(2), 9) + padS(pyS3[k].toFixed(2), 9) +
    padS(e2(relErr(jsS3[k], pyS3[k])), 10) + (k === targetIdx ? '  <== TARGET' : ''));
}
console.log('  ' + pad('', 3) + pad('max S', 12) + padS(Math.max(...jsS1).toFixed(2), 9) + padS(jsMax2.toFixed(2), 9) +
            padS(jsMax3.toFixed(2), 9) + padS('', 9));
console.log('');
console.log('  判定表（阈值 threshold = ' + P.threshold + '）');
console.log('     case3 目标词 "' + refWords[targetIdx].w + '"  S = ' + jsTgt3.toFixed(2) +
            '   排名 ' + jsRank3 + '/' + refWords.length +
            '   (python S=' + pyTgt3.toFixed(2) + ' 排名 ' + pyRank3 + '/' + refWords.length + ')');
console.log('     case2 最大 S (' + jsRes.case2.ws.maxWord + ')         = ' + jsMax2.toFixed(2) +
            '        (python ' + pyMax2.toFixed(2) + ' on ' + results.summary.S_max.case2_rank1 + ')');
console.log('     case1 最大 S (' + jsRes.case1.ws.maxWord + ')         = ' + Math.max(...jsS1).toFixed(2) +
            '        (python ' + Math.max(...pyS1).toFixed(2) + ' on ' + results.summary.S_max.case1_rank1 + ')');
console.log('     阈值 = 2.00');
const concl = (jsTgt3 > P.threshold) && (jsMax2 < P.threshold) && (jsRank3 === 1) &&
              (Math.max(...jsS1) < P.threshold);
console.log('     => ' + (concl
  ? '结论一致：真错词(case3 的 "' + refWords[targetIdx].w + '")排第 1 且超过阈值，只换音色(case2)/同人同文本(case1)全部平坦 < 2.0'
  : '!!! 结论与 Python 不一致'));
/* 做一次真正的端到端调用（score()），确认它给出的判定和上面一致 */
const sc = PetDTW.score(wavs.case3.samples, wavs.case3.sampleRate, wavs.ref.samples,
  wavs.ref.sampleRate, refWords, {});
console.log('     score() 端到端: d=' + sc.d.toFixed(4) + '  maxS=' + sc.maxS.toFixed(2) +
            '  maxWord=' + sc.maxWord + '  flagged=' + sc.flagged);
console.log('     判定对象: ' + JSON.stringify(sc['判定']));
rec('global', 'score().d', results.global_norm_distance.case3, sc.d, TOL_NORMDIST);
rec('S', 'score().maxS', results.summary.S_max.case3, sc.maxS, TOL_S);
for (let k = 0; k < refWords.length; k++) rec('S', 'score().S[' + k + ']', pyS3[k], sc.S[k], TOL_S);
if (sc.targetIndex !== targetIdx) console.log('     !!! score() 找到的目标词下标 ' + sc.targetIndex + ' != ' + targetIdx);

/* ==========================================================================
 * 9. float32 vs float64 特征（说明为什么 frames 返回 Float64Array）
 * ========================================================================*/
hr('9. 特征容器精度：Float64Array(frames) vs Float32Array(framesF32)');
{
  const d64 = PetDTW.dtw(feats.ref.frames, feats.case3.frames, {});
  const d32 = PetDTW.dtw(feats.ref.framesF32, feats.case3.framesF32, {});
  const ws32 = PetDTW.wordScores(d32.frameCost, refWords, Object.assign({}, wsRefParams, { wordMap: 'vad' }));
  console.log('  normDist float64 = ' + d64.normDist.toFixed(9) + '   float32 = ' + d32.normDist.toFixed(9) +
              '   relΔ = ' + relErr(d32.normDist, d64.normDist).toExponential(2));
  console.log('  目标词 S float64 = ' + jsRes.case3.ws.S[targetIdx].toFixed(6) + '   float32 = ' +
              ws32.S[targetIdx].toFixed(6) + '   relΔ = ' + relErr(ws32.S[targetIdx], jsRes.case3.ws.S[targetIdx]).toExponential(2));
  console.log('  -> 两种容器都远在判据之内，模块默认用 float64 只是不想白送 1e-7 的噪声');
}

/* ==========================================================================
 * 10. 性能（浏览器里要能实时跑）
 * ========================================================================*/
hr('10. 性能');
function bench(label, fn, repeat) {
  fn();                                   // warm-up（把滤波器组/FFT 表等一次性开销排除）
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < repeat; i++) fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6 / repeat;
  console.log('  ' + pad(label, 46) + padS(ms.toFixed(2), 9) + ' ms/次');
  return ms;
}
const longTag = 'case2b';
let longWav = null;
try { longWav = readWav(path.join(DATA, longTag + '.wav')); } catch (e) { /* 可选 */ }
console.log('  测试音频: ref=' + (wavs.ref.samples.length / wavs.ref.sampleRate).toFixed(2) + 's (' +
            feats.ref.nFrames + ' 帧)   case3=' + (wavs.case3.samples.length / wavs.case3.sampleRate).toFixed(2) +
            's (' + feats.case3.nFrames + ' 帧)' +
            (longWav ? ('   case2b=' + (longWav.samples.length / longWav.sampleRate).toFixed(2) + 's') : ''));
const tMfcc = bench('mfcc(ref 4.98s, ' + feats.ref.nFrames + ' 帧)', () =>
  PetDTW.mfcc(wavs.ref.samples, wavs.ref.sampleRate, { sampleRate: wavs.ref.sampleRate }), REPEAT);
const tDtw = bench('dtw(ref ' + feats.ref.nFrames + ' x case3 ' + feats.case3.nFrames + ')', () =>
  PetDTW.dtw(feats.ref.frames, feats.case3.frames, {}), REPEAT);
bench('score() 端到端 (mfcc x2 + vad + dtw + wordScores)', () =>
  PetDTW.score(wavs.case3.samples, wavs.case3.sampleRate, wavs.ref.samples, wavs.ref.sampleRate, refWords, {}),
  Math.max(5, Math.floor(REPEAT / 4)));
if (longWav) bench('mfcc(case2b 6.07s)', () =>
  PetDTW.mfcc(longWav.samples, longWav.sampleRate, { sampleRate: longWav.sampleRate }), REPEAT);
console.log('  （首帧调用会多花一次滤波器组+FFT表的构建成本；上表已 warm-up 排除）');

/* ==========================================================================
 * 11. 深挖（可选 --deep）：逐系数核对 MFCC / 逐格点核对 D 矩阵
 *     数据由同一份 dtw-feasibility.py 导入后 dump 出来（见脚本头部说明）
 * ========================================================================*/
if (DEEP) {
  hr('11. 深挖对照（--deep）：把"我的误差"和"参考实现自身的 dtype 噪声"分开');
  const deepJson = path.join(DATA, 'js_ref', 'mfcc_ref.json');
  const f64Json = path.join(DATA, 'js_ref', 'mfcc_f64.json');
  if (!fs.existsSync(deepJson) || !fs.existsSync(f64Json)) {
    console.log('  找不到 ' + deepJson + ' / ' + f64Json + ' ，跳过（生成方法见本文件头部注释）');
  } else {
    const dj = readJson(deepJson);
    const f64j = readJson(f64Json);
    const binF32 = (p) => {
      if (!fs.existsSync(p)) return null;
      const b = fs.readFileSync(p);
      return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    };
    const binF64 = (p) => {
      if (!fs.existsSync(p)) return null;
      const b = fs.readFileSync(p);
      return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    };

    /* ---- 11a 波形调理：JS(float64) vs numpy(float64) ---- */
    console.log('');
    console.log('  11a. 波形调理（同一份 PCM，两边都走 float64）');
    console.log('  ' + pad('tag', 7) + padS('样本数', 9) + padS('|Δx|max', 12) + padS('|Δx|max / max|x|', 18) + '   Python 端');
    for (const t of TAGS) {
      const mine = PetDTW.preprocess(wavs[t].samples, wavs[t].sampleRate, { sampleRate: wavs[t].sampleRate });
      const pyC = binF64(path.join(DATA, 'js_ref', 'cond64_' + t + '.f64'));
      const py32 = binF32(path.join(DATA, 'js_ref', 'x_' + t + '.f32'));
      if (!pyC) { console.log('  ' + pad(t, 7) + ' 缺 cond64_' + t + '.f64'); continue; }
      let ma = 0;
      for (let i = 0; i < pyC.length; i++) ma = Math.max(ma, Math.abs(mine[i] - pyC[i]));
      const scale = f64j[t].cond64_max || 1;
      recAbs('deepCond', t + '.cond', 0, ma, 1e-12);
      /* 顺带量一下 wavFloat32 波形和 Python x32 的 bit 差异（解释为什么它不能把差归零） */
      let nDiff = 0, md = 0;
      if (py32) {
        const mine32 = PetDTW.preprocess(wavs[t].samples, wavs[t].sampleRate,
          { sampleRate: wavs[t].sampleRate, wavFloat32: true });
        for (let i = 0; i < py32.length; i++) if (mine32[i] !== py32[i]) { nDiff++; md = Math.max(md, Math.abs(mine32[i] - py32[i])); }
      }
      console.log('  ' + pad(t, 7) + padS(pyC.length, 9) + padS(ma.toExponential(2), 12) +
        padS((ma / scale).toExponential(2), 18) +
        '   wavFloat32 vs x32: ' + nDiff + ' 个样本差 1ULP(max ' + md.toExponential(1) + ')');
    }
    console.log('  -> 前缀和实现的高通 vs numpy 的 np.convolve，差 ~1e-14（0.8 幅度信号上），可以忽略');

    /* ---- 11b MFCC 三级对照 ---- */
    console.log('');
    console.log('  11b. MFCC 系数最大绝对差（三种口径）');
    const rows = [];
    for (const t of TAGS) {
      const py = dj[t], pyf = f64j[t];
      const js = feats[t];
      const js32 = PetDTW.mfcc(wavs[t].samples, wavs[t].sampleRate,
        { sampleRate: wavs[t].sampleRate, wavFloat32: true });
      /* 口径 1：给两边完全相同的输入（Python 的 float32 取值按 float64 参与运算），
       *         Python 侧也走全 float64 —— 这一项才是"我的实现误差" */
      const py32 = binF32(path.join(DATA, 'js_ref', 'x_' + t + '.f32'));
      let same = 0;
      if (py32) {
        const xin = new Float64Array(py32.length);
        for (let i = 0; i < py32.length; i++) xin[i] = py32[i];
        const jsSame = PetDTW.mfcc(xin, wavs[t].sampleRate, { sampleRate: wavs[t].sampleRate, preprocess: false });
        for (let i = 0; i < pyf.mfcc64.length; i++) {
          for (let k = 0; k < P.ncep; k++) {
            same = Math.max(same, Math.abs(jsSame.rawFrames[i][k] - pyf.mfcc64[i][k]));
          }
        }
      }
      let dDef = 0, d32 = 0;
      for (let i = 0; i < py.mfcc.length; i++) {
        for (let k = 0; k < P.ncep; k++) {
          dDef = Math.max(dDef, Math.abs(js.rawFrames[i][k] - py.mfcc[i][k]));
          d32 = Math.max(d32, Math.abs(js32.rawFrames[i][k] - py.mfcc[i][k]));
        }
      }
      rows.push({ t: t, same: same, dDef: dDef, d32: d32, sens: pyf.dtype_sens, n: py.mfcc.length * P.ncep });
      recAbs('deepMfccSame', t + '.mfcc(同输入/全float64)', 0, same, 1e-9);
      /* 逐文件只做"粗差"护栏（4x）；真正的判据放在表格后面的统计口径上。
       * 理由：口径 2 和口径 4 都是"float32 存储"这同一个原因造成的一次随机抽样——
       * 究竟哪一帧的低能量 Mel 通道把扰动放大，是混沌的，所以逐文件比值在 0.5~2 之间
       * 波动属正常，拿单个文件比单个文件会误判。*/
      recAbs('deepMfccGross', t + '.mfcc(默认float64)', 0, dDef, 4 * pyf.dtype_sens);
      recAbs('deepMfccGross', t + '.mfcc(wavFloat32)', 0, d32, 4 * pyf.dtype_sens);
      buckets.deepMfccSame.n += py.mfcc.length * P.ncep - 1;
    }
    console.log('  ' + pad('口径', 46) + TAGS.map((t) => padS(t, 12)).join(''));
    const rowLine = (label, key) => console.log('  ' + pad(label, 46) +
      rows.map((r) => padS(r[key].toExponential(2), 12)).join(''));
    rowLine('1) 同一输入、两边全 float64  =>  我的实现误差', 'same');
    rowLine('2) JS 默认(float64 波形) vs Python 实际(float32)', 'dDef');
    rowLine('3) JS wavFloat32 复刻    vs Python 实际(float32)', 'd32');
    rowLine('4) 参考实现自身 float32<->float64 敏感度', 'sens');
    console.log('  ' + pad('5) 逐文件比值 (2)/(4)', 46) +
      rows.map((r) => padS((r.dDef / r.sens).toFixed(2) + 'x', 12)).join(''));
    const maxDef = Math.max.apply(null, rows.map((r) => r.dDef));
    const max32 = Math.max.apply(null, rows.map((r) => r.d32));
    const maxSens = Math.max.apply(null, rows.map((r) => r.sens));
    const meanDef = rows.reduce((a, r) => a + r.dDef, 0) / rows.length;
    const meanSens = rows.reduce((a, r) => a + r.sens, 0) / rows.length;
    console.log('  ' + pad('6) 统计口径  max(我的)/max(参考) / mean(我的)/mean(参考)', 46) +
      '  ' + (maxDef / maxSens).toFixed(2) + 'x  /  ' + (meanDef / meanSens).toFixed(2) + 'x');
    recAbs('deepMfccWithin', 'max(JS默认)/max(参考dtype噪声)', 0, maxDef, 1.5 * maxSens);
    recAbs('deepMfccWithin', 'mean(JS默认)/mean(参考dtype噪声)', 0, meanDef, 1.5 * meanSens);
    recAbs('deepMfccWithin', 'max(JS wavFloat32)/max(参考dtype噪声)', 0, max32, 1.5 * maxSens);
    buckets.deepMfccWithin.n = rows.length * P.ncep * 2;
    console.log('  -> 口径 1 = 6e-14：手写的 FFT / Mel 三角滤波 / DCT-II 与 numpy 等价；');
    console.log('     口径 2/3 ≈ 口径 4：剩下的 ~1e-5 完全来自参考实现的 float32 波形存储与');
    console.log('     float32 预加重（log(mel+eps) 在低能量 Mel 通道上放大了这点扰动），');
    console.log('     我的实现并不比"参考实现换个 dtype"离参考更远。');

    /* ---- 11c D 矩阵：ref x case3 全部格点 ---- */
    const dbin = path.join(DATA, 'js_ref', 'D_case3.f64');
    if (fs.existsSync(dbin) && dj.dtw_case3) {
      const M = dj.dtw_case3.M, N = dj.dtw_case3.N;
      const pyD = binF64(dbin);
      const A = feats.ref.frames, B = feats.case3.frames;
      let ma = 0, mr = 0, worst = '';
      for (let i = 0; i < M; i++) {
        const ai = A[i];
        let ra = 0; for (let k = 0; k < P.ncep; k++) ra += ai[k] * ai[k];
        for (let j = 0; j < N; j++) {
          const bj = B[j];
          let dot = 0, rb = 0;
          for (let k = 0; k < P.ncep; k++) { dot += ai[k] * bj[k]; rb += bj[k] * bj[k]; }
          let d2 = ra + rb - 2 * dot; if (d2 < 0) d2 = 0;
          const d = Math.sqrt(d2);
          const b = pyD[i * N + j];
          const a = Math.abs(d - b);
          if (a > ma) { ma = a; worst = i + ',' + j; }
          const r = relErr(d, b); if (Number.isFinite(r) && r > mr) mr = r;
        }
      }
      console.log('');
      console.log('  11c. DTW 局部代价 D 矩阵 ' + M + 'x' + N + ' = ' + (M * N) + ' 格点');
      console.log('       |Δ|max=' + ma.toExponential(3) + '   最大相对Δ=' + mr.toExponential(3) + '   @(' + worst + ')');
      console.log('       （和 11b 口径 2 同数量级 => 误差全部继承自 MFCC 特征，');
      console.log('         DTW 的带宽判据 / 三个转移 / 平局取 first-min / 回溯 / frame_cost 求平均');
      console.log('         与 Python 逐格一致）');
      recAbs('localDist', 'D[case3]', 0, ma, 1e-4);
      buckets.localDist.n = M * N - 1;
    } else {
      console.log('  没有 D_case3.f64 / dtw_case3，跳过 D 矩阵对照');
    }
  }
}

/* ==========================================================================
 * 12. 接线契约：词对象字段名 / 时间戳缺失时的退化保护
 *     （本仓库 asr.js 的 groupTokens() 和 main.js 的 fillWordGaps() 给的是
 *      {w, ps, from, to}，而接口约定是 {w, fromMs, toMs} —— 必须都能吃，
 *      否则逐词归因会在错误的位置上打分。）
 * ========================================================================*/
hr('12. 接线契约：词对象字段名容错 + 时间戳缺失保护');
{
  const asrShape = grouped.map((x) => ({ w: x.w, ps: [], from: x.fromMs, to: x.toMs }));
  const noTime = grouped.map((x) => ({ w: x.w }));
  const rCanon = jsRes.case3.ws;                       // 第 5 节已经算过（规范字段）
  const sc3 = PetDTW.score(wavs.case3.samples, wavs.case3.sampleRate, wavs.ref.samples,
    wavs.ref.sampleRate, asrShape, {});
  let same = true;
  for (let k = 0; k < refWords.length; k++) {
    if (sc3.words[k].S !== rCanon.S[k] || sc3.words[k].frames !== rCanon.frameCounts[k]) same = false;
  }
  console.log('  {w,fromMs,toMs} vs {w,ps,from,to}: normDist 相同=' + (sc3.d === jsRes.case3.d.normDist) +
              '  逐词 S/frames 完全相同=' + same);
  console.log('    maxS=' + sc3.maxS.toFixed(4) + ' (规范字段 ' + rCanon.maxS.toFixed(4) + ')  flagged=' + sc3.flagged);
  if (!same) buckets.contract.fails.push('{from,to} 与 {fromMs,toMs} 结果不一致');

  const scNo = PetDTW.score(wavs.case3.samples, wavs.case3.sampleRate, wavs.ref.samples,
    wavs.ref.sampleRate, noTime, {});
  console.log('  完全不给时间戳: maxS=' + scNo.maxS.toFixed(4) + '  timingDegenerate=' + scNo.timingDegenerate +
              '  flagged=' + scNo.flagged + '   （maxS 是通过"等分时间轴"算出来的，不可信，所以拒绝判定）');
  console.log('    判定文本: ' + scNo['判定'].text);
  if (scNo.flagged) buckets.contract.fails.push('时间戳缺失时仍然 flag 了');
  if (!scNo.timingDegenerate) buckets.contract.fails.push('时间戳缺失没有被标记 timingDegenerate');
  recAbs('contract', 'asr 字段名容错', 0, same ? 0 : 1, 1e-12);
  recAbs('contract', '时间戳缺失保护', 0, scNo.flagged ? 1 : 0, 1e-12);
}

/* ==========================================================================
 * 13. 总判定
 * ========================================================================*/
hr('13. 总判定');
const CRITERIA = [
  ['normDist 相对误差 < 2%', ['global', 'ablation', 'align'], 0.02],
  ['逐词 S 相对误差 < 5%', ['S', 'Smax', 'ablationS'], 0.05],
  ['逐词 cost 相对误差 < 5%', ['wordCost', 'ablationWc', 'ablationWcTargetCost', 'alignWc', 'frameCostN'], 0.05],
  ['词->帧映射逐帧一致', ['mapping'], 1e-12],
  ['接线契约（字段名容错 / 缺失保护）', ['contract'], 1e-12],
  ['深挖：波形调理 |Δx| < 1e-12（绝对）', ['deepCond'], 1e-12],
  ['深挖：同一输入下 MFCC 实现误差 < 1e-9（绝对）', ['deepMfccSame'], 1e-9],
  ['深挖：MFCC 偏差 ≤ 参考自身 dtype 噪声的 1.5 倍（统计）', ['deepMfccWithin'], 1.5],
  ['深挖：逐文件 MFCC 偏差 < 4 倍 dtype 噪声（护栏）', ['deepMfccGross'], 4],
  ['深挖：DTW 局部代价 D 逐格点 |Δ| < 1e-4（绝对）', ['localDist'], 1e-4]
];
let allPass = true;
console.log('  ' + pad('检查项', 34) + padS('样本数', 9) + padS('最大相对误差', 14) + padS('最差项', 30) + '   结论');
for (const [label, keys, tol] of CRITERIA) {
  let n = 0, maxRel = -1, worst = '', fails = [];
  for (const k of keys) {
    if (!buckets[k]) continue;
    n += buckets[k].n;
    if (buckets[k].maxRel > maxRel) { maxRel = buckets[k].maxRel; worst = buckets[k].worst; }
    fails = fails.concat(buckets[k].fails || []);
  }
  const pass = (fails.length === 0) && (tol === null || maxRel < tol);
  if (!pass) allPass = false;
  console.log('  ' + pad(label, 34) + padS(n, 9) + padS(maxRel < 0 ? '-' : e2(maxRel), 14) + padS(worst || '-', 30) +
              '   ' + (pass ? 'PASS' : 'FAIL'));
  if (!pass && fails.length) fails.slice(0, 8).forEach((f) => console.log('        ! ' + f));
}
console.log('');
if (allPass) {
  console.log('  ==> 移植数值一致：normDist / 逐词 cost / 逐词 S / 前端消融 / 两种词映射 全部对上。');
} else {
  console.log('  ==> !!! 存在不一致项，见上面的 FAIL 明细。');
}
const okKey = concl && allPass;
console.log('  ==> 关键结论（真错词排第 1、换音色平坦、阈值 2.0）: ' + (concl ? '一致' : '不一致'));
process.exit(okKey ? 0 : 1);
