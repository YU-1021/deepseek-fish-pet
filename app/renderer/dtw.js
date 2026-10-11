/* ============================================================================
 * dtw.js -- MFCC + DTW 逐词发音评测前端（零依赖，浏览器 / Node 双用）
 * ----------------------------------------------------------------------------
 * 这是 app/scripts/dtw-feasibility.py 的 JS 移植版，目标运行环境是 Electron
 * 渲染层（有 Web Audio，没有 numpy）。数值必须和 Python 版一致，
 * 见 app/scripts/test-dtw.js 的逐项对照。
 *
 * 与 Python 的对应关系（文件名 dtw-feasibility.py 的行号在注释里给出）：
 *   read_wav()          -> preprocess()                 (Python:81-111)
 *   mfcc()              -> mfccFromSignal()/mfcc()      (Python:247-268)
 *   frame_energy_db()   -> frameEnergyDb()              (Python:271-281)
 *   vad_mask()          -> vadMask()                    (Python:284-294)
 *   cmn()/cmvn()        -> normaliseCepstra()           (Python:300-310)
 *   dtw()               -> dtw()                        (Python:317-398)
 *   assign/realign      -> assignFramesToWords()/
 *                          realignWordsToVoiced()       (Python:458-522)
 *   s_scores()          -> leaveOneOutScores()          (Python:862-871)
 *   group_words()       -> groupWhisperWords()          (Python:426-455)
 *
 * 零依赖：本文件不 require / import 任何东西；不使用 npm 包；
 * 只用 ES5 语法 + TypedArray（个别地方用 const/let/箭头函数以外的东西
 * 一律避免），保证渲染层直接用 <script> 引入或在 Node 里 require 都行。
 *
 * 我自己的实现（radix-2 FFT、Mel 三角滤波、DCT-II、DTW DP）全部手写，
 * 因为渲染层没有 numpy；手写部分的数值误差见 test-dtw.js 的实测对照。
 *
 * 【有意为之的差异，全部在 test-dtw.js 里量化过】
 *  1. frames 返回 Float64Array[]（不是规格里写的 Float32Array[]）。
 *     Python 的 MFCC 全程 float64，若在这里降到 float32 会引入 ~1e-7 的
 *     相对噪声，白送误差；Float64Array 同样能被下标访问，dtw() 两种都吃。
 *     为了让调用方拿得到 Web Audio 原生精度，额外提供 framesF32。
 *  2. Python 的 read_wav() 最后把波形 astype(np.float32)（L111），预加重也用
 *     float32 数组（y = np.empty_like(x)）。这里默认全程 float64。
 *     实测（test-dtw.js --deep 第 11 节）：这带来的 MFCC 系数差 ~1.6e-5（绝对），
 *     而 Python 自己把波形从 float32 换成 float64 就差 1.8e-5 —— 我的偏差比
 *     参考实现自身的 dtype 噪声还小。同一输入、全 float64 时两边只差 6e-14。
 *     想复刻那个 float32 存储就传 params.wavFloat32 = true。
 *  3. Mel 滤波器组用稀疏存储（只存非零权重），Python 用稠密矩阵。
 *     两者求和顺序里被跳过的都是 0.0，加 0 不改变浮点值，所以数值等价，
 *     只是省掉 ~26x 的乘法（26*257 -> 26*~10）。
 *  4. 滤波器组 / DCT 矩阵 / FFT 旋转因子做了缓存（Python 在模块导入时建一次，
 *     这里第一次调用时建一次），纯性能改动，不影响数值。
 * ==========================================================================*/
(function (globalScope, factory) {
  'use strict';
  var api = factory();
  /* Node（测试脚本 / preload）*/
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  /* 浏览器渲染层 */
  if (typeof window !== 'undefined') window.PetDTW = api;
  if (globalScope && typeof globalScope === 'object' && !globalScope.PetDTW) {
    globalScope.PetDTW = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ==========================================================================
   * 1. 默认参数
   * --------------------------------------------------------------------------
   * 规则：所有写死的常量都在这里，代码里不许再出现魔数。
   * 每一项都标了它来自 Python 的哪一行 / 原值多少。
   * ========================================================================*/
  var DEFAULTS = {
    /* ---- 波形采样 ---- */
    sampleRate: 16000,        // Python SR (L59)；score() 里若传了真实采样率则以传入为准

    /* ---- 分帧 / 频谱（Python L60-68）---- */
    frameMs: 25.0,            // FRAME_MS
    hopMs: 10.0,              // HOP_MS
    nfft: 512,                // NFFT（必须是 2 的幂；帧长 400 < 512，即补零到 512）
    nmel: 26,                 // NMEL
    ncep: 13,                 // NCEP
    preemph: 0.97,            // PREEMPH
    fmin: 0.0,                // FMIN
    fmax: 8000.0,             // FMAX（实验规格：Mel 滤波器覆盖 0..8000Hz）
    eps: 1e-10,               // EPS，log(mel + EPS) 的底噪

    /* ---- read_wav() 里的信号调理（Python L100-110 写死的）---- */
    preprocess: true,         // mfcc()/score() 是否对入参做下面这套调理。
                              // true = 入参是原始 PCM（推荐）；false = 已经调理过
    dcRemove: true,           // x = x - x.mean()                (L100)
    highpassMs: 50.0,         // 减去 50ms 滑动均值的高通        (L106: w = sr*0.050)
    highpassMinSamples: 3,    //                          (L106: max(3, ...))
    rmsNorm: 0.1,             // RMS 归一化目标                  (L110: x * (0.1/rms))
    rmsFloor: 1e-12,          //                          (L109: if rms > 1e-12)
    wavFloat32: false,        // Python 的 read_wav 最后 x.astype(np.float32)（L111），
                              // 所以参考实现是拿 float32 波形去算 MFCC 的。默认 false =
                              // 全程 float64。设 true 复刻 Python 的 float32 存储；注意它
                              // **不会**让两边 MFCC 完全一致（仍差 ~1e-5）：numpy 的
                              // np.convolve 与这里的前缀和在末位有别，落在 float32 舍入
                              // 边界上的样本会差 1 ULP，而 log(mel+eps) 对低能量 Mel 通道
                              // 会把这点扰动放大。实测结论见 test-dtw.js --deep 第 11 节：
                              // 我的实现误差（同一输入、全 float64）只有 6e-14。

    /* ---- 倒谱归一化 ---- */
    cmn: 'mean',              // 'none' | 'mean'(=cmn, L300) | 'meanvar'(=cmvn, L305)
    cmnStdFloor: 1e-8,        // cmvn 里 s[s<1e-8]=1e-8          (L309)
    dropC0: false,            // true 等价于 Python 消融里的 'CMN c1-c12'（L775）

    /* ---- DTW ---- */
    dtwBand: null,            // 带宽约束；null = 自动（Python band_radius=None, L324）
    bandAbsPad: 15,           // 自动带宽：(L325) abs(M-N) + 15
    bandFrac: 0.25,           // 自动带宽：(L325) int(0.25 * max(M,N))
    bandMin: 40,              // 自动带宽：(L325) 40
    // 注意：Python 的 DTW 三个转移 (1,0)/(0,1)/(1,1) 都**没有**步长惩罚，
    // 这里同样没有。若将来加 stepPenalty，必须默认 0 才保持与 Python 一致。

    /* ---- VAD / 词对齐（Python L284-294, L458-522）---- */
    speechFloorDb: -35.0,     // vad_mask 的 rel_db（L284）
    vadPercentile: 95,        // vad_mask 的 np.percentile(db, 95)（L293）
    energyEps: 1e-12,         // frame_energy_db 的 +1e-12（L281）
    edgePadMs: 30.0,          // assign_frames_to_words 的 edge_pad_ms（L458）
    minWordDurMs: 60.0,       // realign_words_to_voiced 的 min_dur_ms（L483）
    minWordFrames: 1,         // **Python 没有这个参数**。Python 只保证每个词至少
                              // 1 帧。>=2 时，帧数不足的词只是被标 reliable:false
                              // 并从「是否告警」里排除，绝不改任何数值。
    wordMap: 'vad',           // 'vad' = Python 的 primary 映射（L669）
                              // 'whisper' = 备用的 whisper-midpoint 映射（L664）

    /* ---- 判定（Python L891: 建议只 flag S > 2.0）---- */
    threshold: 2.0,           // 判定阈值
    targetWord: 'practice'    // 实验关注的词（L74）
  };

  /* shallow merge：没给的用默认值 */
  function mergeParams(params) {
    var out = {}, k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) out[k] = DEFAULTS[k];
    if (params) for (k in params) if (Object.prototype.hasOwnProperty.call(params, k)) out[k] = params[k];
    return out;
  }

  /* Python 3 的 round() 是「四舍六入五成双」，和 JS 的 Math.round（.5 一律进位）
     不同。Python 里 flen/hop 由 int(round(sr*frame_ms/1000)) 得到（L249-250）：
     16kHz 下是 400/160 整除，没差别；但 44.1kHz*25ms = 1102.5 这种就会分叉，
     所以照抄 Python 的舍入规则。*/
  function pyRound(v) {
    var f = Math.floor(v), d = v - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }

  /* ==========================================================================
   * 2. Mel 滤波器组 / DCT 矩阵 / FFT（建一次，缓存复用）
   * ========================================================================*/
  function hz2mel(f) { return 2595.0 * Math.log10(1.0 + f / 700.0); }   // Python L206
  function mel2hz(m) { return 700.0 * (Math.pow(10.0, m / 2595.0) - 1.0); } // L210

  var _melCache = {}, _dctCache = {}, _fftCache = {};

  /* 三角 Mel 滤波器组，严格照抄 Python mel_filterbank()（L214-231）。
   * 关键边界（容易移植错的地方，逐条对齐）：
   *   - 频点 = np.linspace(hz2mel(fmin), hz2mel(fmax), nmel+2)（含两端点，last 精确取右端）
   *   - bin = floor((nfft+1) * hz / sr)，再 clip 到 [0, nfft/2]
   *   - ce == lo 时 ce = min(lo+1, nfreqs-1)；hi == ce 时 hi = min(ce+1, nfreqs-1)
   *   - 上升段写 [lo, ce)，下降段写 [ce, hi)：注意 ce 这个点由**下降段**写成 1.0，
   *     两段首尾相接正好不重叠，且 k = hi 处保持 0（Python 也没有写它）
   *   - 稀疏化只丢掉权重恰为 0 的项（上升段 k=lo 那一项），不影响求和结果
   */
  function buildMelFilterbank(sr, nfft, nmel, fmin, fmax) {
    var key = 'mel|' + sr + '|' + nfft + '|' + nmel + '|' + fmin + '|' + fmax;
    if (_melCache[key]) return _melCache[key];

    var nfreqs = (nfft >> 1) + 1;
    var m0 = hz2mel(fmin), m1 = hz2mel(fmax);
    var melPts = new Float64Array(nmel + 2);
    for (var i = 0; i <= nmel + 1; i++) melPts[i] = m0 + (m1 - m0) * i / (nmel + 1);
    melPts[nmel + 1] = m1;              // numpy.linspace 会把末点精确置为右端

    var bins = new Int32Array(nmel + 2);
    for (i = 0; i < nmel + 2; i++) {
      var b = Math.floor((nfft + 1) * mel2hz(melPts[i]) / sr);
      if (b < 0) b = 0;
      if (b > nfreqs - 1) b = nfreqs - 1;
      bins[i] = b;
    }

    var fbStart = new Int32Array(nmel + 1);
    var fbBin = [], fbW = [];
    for (i = 0; i < nmel; i++) {
      var lo = bins[i], ce = bins[i + 1], hi = bins[i + 2];
      if (ce === lo) ce = Math.min(lo + 1, nfreqs - 1);
      if (hi === ce) hi = Math.min(ce + 1, nfreqs - 1);
      fbStart[i] = fbBin.length;
      var k;
      for (k = lo; k < ce; k++) {
        var w1 = (k - lo) / (ce - lo);
        if (w1 !== 0) { fbBin.push(k); fbW.push(w1); }
      }
      for (k = ce; k < hi; k++) {
        var w2 = (hi - k) / (hi - ce);
        if (w2 !== 0) { fbBin.push(k); fbW.push(w2); }
      }
    }
    fbStart[nmel] = fbBin.length;

    var fb = {
      nfreqs: nfreqs, nmel: nmel, fbStart: fbStart,
      fbBin: Int32Array.from(fbBin), fbW: Float64Array.from(fbW)
    };
    _melCache[key] = fb;
    return fb;
  }

  /* DCT-II 矩阵，照抄 Python dct_matrix()（L234-240）：
   * m[k,i] = cos(pi/nmel * (i+0.5) * k) * (k==0 ? 1/sqrt2 : 1) * sqrt(2/nmel)
   * 乘的顺序也照抄（先 1/sqrt2 再 sqrt(2/nmel)），避免最后一位的差异。*/
  function buildDct(nmel, ncep) {
    var key = 'dct|' + nmel + '|' + ncep;
    if (_dctCache[key]) return _dctCache[key];
    var m = new Float64Array(ncep * nmel);
    var s = Math.sqrt(2.0 / nmel);
    for (var k = 0; k < ncep; k++) {
      for (var i = 0; i < nmel; i++) {
        var v = Math.cos(Math.PI / nmel * (i + 0.5) * k);
        if (k === 0) v *= 1.0 / Math.sqrt(2.0);
        v *= s;
        m[k * nmel + i] = v;
      }
    }
    _dctCache[key] = { m: m, nmel: nmel, ncep: ncep };
    return _dctCache[key];
  }

  /* 基 2 迭代 FFT：numpy 的 rfft 是 pocketfft（结果精确到浮点舍入），
   * 这里用标准 Cooley-Tukey，实信号按普通复 FFT 处理（虚部填 0）。
   * 差异只有 ~1e-16 相对量级。nfft=512 时 5 秒音频约 500 帧 -> 4700 点 x 500，
   * 实测 10ms 量级，够实时。
   * 逆序表 / 每级旋转因子都预先算好，避免每帧重复 Math.cos。*/
  function buildFft(n) {
    var key = 'fft|' + n;
    if (_fftCache[key]) return _fftCache[key];
    var levels = Math.round(Math.log2(n));
    if ((1 << levels) !== n) throw new Error('dtw.js: nfft 必须是 2 的幂，收到 ' + n);
    var rev = new Uint32Array(n);
    for (var i = 0; i < n; i++) {
      var r = 0;
      for (var b = 0; b < levels; b++) if (i & (1 << b)) r |= 1 << (levels - 1 - b);
      rev[i] = r;
    }
    var cosT = [], sinT = [];
    for (var len = 2, s = 0; len <= n; len <<= 1, s++) {
      var half = len >> 1;
      var c = new Float64Array(half), si = new Float64Array(half);
      for (var k = 0; k < half; k++) {
        var ang = -2.0 * Math.PI * k / len;
        c[k] = Math.cos(ang); si[k] = Math.sin(ang);
      }
      cosT.push(c); sinT.push(si);
    }
    var fft = { n: n, rev: rev, cosT: cosT, sinT: sinT };
    _fftCache[key] = fft;
    return fft;
  }

  function fftInPlace(re, im, F) {
    var n = F.n, rev = F.rev, i, j, t;
    for (i = 0; i < n; i++) {
      j = rev[i];
      if (j > i) {
        t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (var len = 2, s = 0; len <= n; len <<= 1, s++) {
      var half = len >> 1, c = F.cosT[s], si = F.sinT[s];
      for (i = 0; i < n; i += len) {
        for (var k = 0; k < half; k++) {
          var a = i + k, b = a + half;
          var tr = re[b] * c[k] - im[b] * si[k];
          var ti = re[b] * si[k] + im[b] * c[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr;        im[a] += ti;
        }
      }
    }
  }

  /* ==========================================================================
   * 3. read_wav() 的信号调理部分（Python L99-111）
   * --------------------------------------------------------------------------
   * 这一段看着不起眼，其实是整个实验能不能成立的关键：
   * SAPI 在静音段写的是**恒定非零**电平，不做处理的话每个静音帧完全相同，
   * DTW 会给整段静音一个常数代价，然后泄漏到时间轴上"拥有"这段静音的单词里
   * （whisper 的词跨度经常覆盖停顿）。50ms 滑动均值高通 + RMS 归一化之后，
   * 静音帧不再是常数，能量 VAD 也才能工作。
   * ========================================================================*/
  function preprocess(samples, sampleRate, params) {
    var p = mergeParams(params);
    var sr = sampleRate || p.sampleRate;
    var n = samples.length;
    var x = new Float64Array(n);
    var i;
    for (i = 0; i < n; i++) x[i] = samples[i];
    if (n === 0) return x;

    if (p.dcRemove) {                       // Python L100
      var mean = 0.0;
      for (i = 0; i < n; i++) mean += x[i];
      mean /= n;
      for (i = 0; i < n; i++) x[i] -= mean;
    }

    var w = Math.max(p.highpassMinSamples, Math.round(sr * p.highpassMs / 1000.0)); // L106
    if (p.highpassMs > 0 && n > 1 && w > 1) {
      /* 对应 np.convolve(x, ones(w)/w, mode='same')。
       * 'same' 对长度 N 的信号返回长度 N，起点是全卷积的第 (w-1)//2 个样本：
       *   out[n] = (1/w) * sum_{j=n-((w-1)//2) ... }  ——具体地，w=800 时
       *   窗口是 x[n-400 .. n+399]，即"多取左边一个"的居中窗口（w 为偶数时
       *   并不是严格对称的，这点必须照抄，否则会整体平移半个样本）。
       * 用前缀和实现，O(N)，和 Python 的卷积数值等价（求和顺序不同，
       * 差异 ~1e-16 相对量级）。*/
      var right = Math.floor((w - 1) / 2);
      var left = right - w + 1;
      var pre = new Float64Array(n + 1);
      for (i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
      var inv = 1.0 / w;
      for (i = 0; i < n; i++) {
        var a = i + left, b = i + right;
        if (a < 0) a = 0;
        if (b > n - 1) b = n - 1;
        x[i] -= (pre[b + 1] - pre[a]) * inv;
      }
    }

    if (p.rmsNorm > 0) {                    // Python L108-110
      var acc = 0.0;
      for (i = 0; i < n; i++) acc += x[i] * x[i];
      var rms = Math.sqrt(acc / n);
      if (rms > p.rmsFloor) {
        var g = p.rmsNorm / rms;
        for (i = 0; i < n; i++) x[i] *= g;
      }
    }
    if (p.wavFloat32) {                     // 复刻 Python L111 的 astype(np.float32)
      var x32 = new Float32Array(n);
      for (i = 0; i < n; i++) x32[i] = x[i];
      return x32;
    }
    return x;
  }

  /* ==========================================================================
   * 4. 分帧 + 能量（Python frame_energy_db L271-281）
   * ========================================================================*/
  function frameCount(len, flen, hop) {
    if (len < flen) len = flen;                  // Python 先补零到 flen（L255-256）
    return 1 + Math.floor((len - flen) / hop);
  }

  function frameEnergyDb(x, sampleRate, params) {
    var p = mergeParams(params);
    var sr = sampleRate || p.sampleRate;
    var flen = pyRound(sr * p.frameMs / 1000.0);
    var hop = pyRound(sr * p.hopMs / 1000.0);
    var nf = frameCount(x.length, flen, hop);
    var out = new Float64Array(nf);
    for (var t = 0; t < nf; t++) {
      var off = t * hop, acc = 0.0;
      for (var k = 0; k < flen; k++) {
        var idx = off + k;
        var v = idx < x.length ? x[idx] : 0.0;   // 尾部补零
        acc += v * v;
      }
      /* Python: (frames**2).mean(axis=1) 再 10*log10(e + 1e-12)，帧内是简单求和 */
      out[t] = 10.0 * Math.log10(acc / flen + p.energyEps);
    }
    return out;
  }

  /* np.percentile(a, q) 默认 'linear'：位置 = q/100*(n-1)，线性插值 */
  function percentile(values, q) {
    var a = Array.prototype.slice.call(values);
    a.sort(function (u, v) { return u - v; });
    if (a.length === 0) return NaN;
    var pos = (a.length - 1) * q / 100.0;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return a[lo];
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }

  /* vad_mask()（Python L284-294）：相对 95 分位能量 -35dB 以内的帧算有声 */
  function vadMask(x, sampleRate, params) {
    var p = mergeParams(params);
    var db = frameEnergyDb(x, sampleRate, p);
    var ref = percentile(db, p.vadPercentile);
    var thr = ref + p.speechFloorDb;
    var voiced = new Uint8Array(db.length);
    for (var i = 0; i < db.length; i++) voiced[i] = db[i] > thr ? 1 : 0;
    return { voiced: voiced, energyDb: db, thresholdDb: thr, refDb: ref };
  }

  /* ==========================================================================
   * 5. MFCC（Python L247-268）+ CMN（L300-310）
   * ========================================================================*/
  function normaliseCepstra(raw, nFrames, ncep, p) {
    /* raw: Float64Array(nFrames*ncep)，行主序，列 = 倒谱系数 */
    var out = new Float64Array(nFrames * ncep);
    var i, k, t;
    if (p.cmn === 'none') {
      out.set(raw);
    } else {
      var mu = new Float64Array(ncep);
      for (t = 0; t < nFrames; t++) for (k = 0; k < ncep; k++) mu[k] += raw[t * ncep + k];
      for (k = 0; k < ncep; k++) mu[k] /= nFrames;
      var sd = null;
      if (p.cmn === 'meanvar') {                      // Python cmvn() L305-310
        sd = new Float64Array(ncep);
        for (t = 0; t < nFrames; t++) {
          for (k = 0; k < ncep; k++) { var d = raw[t * ncep + k] - mu[k]; sd[k] += d * d; }
        }
        for (k = 0; k < ncep; k++) {
          /* np.std 默认 ddof=0（除以 N），再 s[s<1e-8]=1e-8 */
          sd[k] = Math.sqrt(sd[k] / nFrames);
          if (!(sd[k] >= p.cmnStdFloor)) sd[k] = p.cmnStdFloor;
        }
      }
      for (t = 0; t < nFrames; t++) {
        for (k = 0; k < ncep; k++) {
          var v = raw[t * ncep + k] - mu[k];
          out[t * ncep + k] = sd ? v / sd[k] : v;
        }
      }
    }
    if (!p.dropC0) return { data: out, dim: ncep };
    /* dropC0 = Python 消融 'CMN c1-c12'：先 CMN 再砍掉第 0 维（L775）*/
    var dim = ncep - 1;
    if (dim <= 0) throw new Error('dtw.js: dropC0 必须保留至少 1 个系数');
    var cut = new Float64Array(nFrames * dim);
    for (t = 0; t < nFrames; t++) {
      for (k = 1; k < ncep; k++) cut[t * dim + (k - 1)] = out[t * ncep + k];
    }
    return { data: cut, dim: dim };
  }

  /* x 必须是已经调理过的 Float64Array（Python 的 mfcc() 就是这么拿到的）*/
  function mfccFromSignal(x, sampleRate, p) {
    var sr = sampleRate || p.sampleRate;
    var flen = pyRound(sr * p.frameMs / 1000.0);      // L249  -> 400
    var hop = pyRound(sr * p.hopMs / 1000.0);         // L250  -> 160
    var n = x.length;
    var y = new Float64Array(n);
    if (n > 0) {
      y[0] = x[0];                                   // L252-254 预加重
      for (var i = 1; i < n; i++) y[i] = x[i] - p.preemph * x[i - 1];
    }
    var nf = frameCount(n, flen, hop);                // L257

    var fb = buildMelFilterbank(sr, p.nfft, p.nmel, p.fmin, p.fmax);
    var dct = buildDct(p.nmel, p.ncep);
    var F = buildFft(p.nfft);
    var nfreqs = fb.nfreqs;

    var win = new Float64Array(flen);                 // np.hamming(flen)  L260
    for (i = 0; i < flen; i++) win[i] = 0.54 - 0.46 * Math.cos(2.0 * Math.PI * i / (flen - 1));

    var raw = new Float64Array(nf * p.ncep);
    var re = new Float64Array(p.nfft), im = new Float64Array(p.nfft);
    var power = new Float64Array(nfreqs);
    var logmel = new Float64Array(p.nmel);
    var t, k, e;

    for (t = 0; t < nf; t++) {
      var off = t * hop;
      for (k = 0; k < p.nfft; k++) {                  // 帧 -> 加窗 -> 补零到 nfft
        var idx = off + k;
        re[k] = (k < flen && idx < n) ? y[idx] * win[k] : 0.0;
        im[k] = 0.0;
      }
      fftInPlace(re, im, F);
      /* numpy 的 rfft 只需要 0..nfft/2 的功率谱 */
      for (k = 0; k < nfreqs; k++) power[k] = re[k] * re[k] + im[k] * im[k];
      for (e = 0; e < p.nmel; e++) {                  // 稀疏 Mel 滤波
        var s = fb.fbStart[e], end = fb.fbStart[e + 1], acc = 0.0;
        for (var q = s; q < end; q++) acc += power[fb.fbBin[q]] * fb.fbW[q];
        logmel[e] = Math.log(acc + p.eps);            // L265
      }
      var base = t * p.ncep;
      for (k = 0; k < p.ncep; k++) {                  // DCT
        var mrow = k * p.nmel, sum = 0.0;
        for (e = 0; e < p.nmel; e++) sum += dct.m[mrow + e] * logmel[e];
        raw[base + k] = sum;
      }
    }

    var centresMs = new Float64Array(nf);             // L267
    for (t = 0; t < nf; t++) centresMs[t] = (t * hop + flen / 2.0) / sr * 1000.0;

    var norm = normaliseCepstra(raw, nf, p.ncep, p);
    var frames = [], framesF32 = [];
    for (t = 0; t < nf; t++) {
      var f64 = norm.data.subarray(t * norm.dim, (t + 1) * norm.dim);
      frames.push(new Float64Array(f64));
      framesF32.push(Float32Array.from(f64));
    }
    var rawFrames = [];
    for (t = 0; t < nf; t++) rawFrames.push(raw.subarray(t * p.ncep, (t + 1) * p.ncep));

    return {
      frames: frames,          // Float64Array[]（见文件头说明 1）
      framesF32: framesF32,    // Float32Array[]，同样的数值
      nFrames: nf,
      dim: norm.dim,
      centresMs: centresMs,
      sampleRate: sr,
      frameLen: flen,
      hopLen: hop,
      durationMs: n / sr * 1000.0,
      rawFrames: rawFrames,    // 归一化之前的倒谱（消融实验要用）
      cmnMode: p.cmn,
      dropC0: !!p.dropC0
    };
  }

  /* 公开 API：mfcc(samples, sampleRate, params)
   * 默认把入参当**原始 PCM**，先做 read_wav 那套调理再算倒谱；
   * 如果调用方已经调理过（比如复用自己的 read_wav），传 preprocess:false。*/
  function mfcc(samples, sampleRate, params) {
    var p = mergeParams(params);
    var sr = sampleRate || p.sampleRate;
    var x = p.preprocess ? preprocess(samples, sr, p) : toFloat64(samples);
    var out = mfccFromSignal(x, sr, p);
    out.signal = x;            // 调理后的波形（VAD 必须用同一份，别重复调理）
    out.energyDb = frameEnergyDb(x, sr, p);
    return out;
  }

  function toFloat64(a) {
    if (a instanceof Float64Array) return a;
    var out = new Float64Array(a.length);
    for (var i = 0; i < a.length; i++) out[i] = a[i];
    return out;
  }

  /* ==========================================================================
   * 6. DTW（Python L317-398）
   * --------------------------------------------------------------------------
   * 与 Python 完全一致的几件事：
   *   - 局部代价 = 欧氏距离，且**照抄 Python 的展开式** sqrt(max(|a|^2+|b|^2-2ab, 0))
   *     （L330-334）。这不是笔误：|a|^2 可以预计算，比逐维相减快，代价是
   *     极小的舍入差异（定理上 ~1e-15，实测见测试脚本）。既然要"数值证明"，
   *     就跟着原式走，连消去顺序都不改。
   *   - 自动带宽 max(|M-N|+15, int(0.25*max(M,N)), 40)（L325），带宽判据
   *     |j - i*(N/M)| <= R（L344）——注意 Python 是在**反对角线**上做这个判据的，
   *     等价于全体格点。
   *   - 三个转移 (1,0)/(0,1)/(1,1)、**无步长惩罚**（L350-355）
   *   - 平局取第一个：np.argmin 在 [up, lf, dg] 上返回最先出现的最小值，
   *     所以 up 优先于 lf 优先于 dg（L353）。这一条会改变回溯路径，
   *     进而改变 frame_cost，必须照抄。
   *   - normDist = 总代价 / 路径长度（L394），不是 /M 也不是 /N。
   *   - 每个 ref 帧的局部代价 = 该帧在路径上的 D 的**平均**（L380-386）。
   * 改成的地方：不再物化整张 D 矩阵（M*N*8 字节），DP 时即时算、回溯时按路径
   * 重算那几个格点（path 长度 ~M+N，比 M*N 小两个数量级）。数值不变。
   * ========================================================================*/
  function dtw(A, B, params) {
    var p = mergeParams(params);
    var M = A.length, N = B.length;
    if (M === 0 || N === 0) throw new Error('dtw.js: 特征序列为空');
    var D = A[0].length;
    if (B[0].length !== D) throw new Error('dtw.js: 两个序列的维度不一致（' + D + ' vs ' + B[0].length + '）');

    var band = p.dtwBand;
    if (band === null || band === undefined) {
      band = Math.max(Math.abs(M - N) + p.bandAbsPad,
                      Math.trunc(p.bandFrac * Math.max(M, N)),
                      p.bandMin);
    }
    var R = Number(band);

    /* |a|^2 预计算（对应 Python 的 ra / rb）*/
    var ra = new Float64Array(M), rb = new Float64Array(N);
    var i, j, k;
    for (i = 0; i < M; i++) { var s = 0.0, ai = A[i]; for (k = 0; k < D; k++) s += ai[k] * ai[k]; ra[i] = s; }
    for (j = 0; j < N; j++) { var s2 = 0.0, bj = B[j]; for (k = 0; k < D; k++) s2 += bj[k] * bj[k]; rb[j] = s2; }

    function localDist(ii, jj) {
      var a2 = A[ii], b2 = B[jj], dot = 0.0;
      for (var q = 0; q < D; q++) dot += a2[q] * b2[q];
      var d2 = ra[ii] + rb[jj] - 2.0 * dot;
      return Math.sqrt(d2 > 0 ? d2 : 0);      // np.maximum(d2, 0) L333
    }

    var dp = new Float64Array(M * N).fill(Infinity);
    var bp = new Uint8Array(M * N).fill(255);
    dp[0] = localDist(0, 0);                  // A[0,0] = D[0,0]  L337
    var ratio = N / M;

    for (var diag = 1; diag <= M + N - 2; diag++) {   // s = 反角线序号  L339
      var i0 = Math.max(0, diag - (N - 1));
      var i1 = Math.min(M - 1, diag);
      for (i = i0; i <= i1; i++) {
        j = diag - i;
        if (Math.abs(j - i * ratio) > R) continue;    // L344 带宽
        var up = Infinity, lf = Infinity, dg = Infinity, kk = 255, best = Infinity;
        if (i > 0) { up = dp[(i - 1) * N + j]; if (up < best) { best = up; kk = 0; } }
        if (j > 0) { lf = dp[i * N + j - 1];  if (lf < best) { best = lf; kk = 1; } }
        if (i > 0 && j > 0) { dg = dp[(i - 1) * N + j - 1]; if (dg < best) { best = dg; kk = 2; } }
        dp[i * N + j] = localDist(i, j) + best;
        bp[i * N + j] = kk;
      }
    }

    var total = dp[(M - 1) * N + (N - 1)];
    if (!isFinite(total)) {
      throw new Error('dtw.js: 带宽内无可行路径（把 dtwBand 调大；当前 R=' + R + '）');
    }

    var path = [];
    i = M - 1; j = N - 1;
    for (;;) {
      path.push([i, j]);
      if (i === 0 && j === 0) break;
      var b = bp[i * N + j];
      if (b === 0) i--;
      else if (b === 1) j--;
      else if (b === 2) { i--; j--; }
      else throw new Error('dtw.js: 回溯指针损坏 @(' + i + ',' + j + ')');
    }
    path.reverse();                           // Python L378

    /* 每个 ref 帧的局部代价 = 路径上落在该帧的 D 的均值（L380-386）*/
    var acc = new Float64Array(M), cnt = new Int32Array(M);
    for (var q2 = 0; q2 < path.length; q2++) {
      var pi = path[q2][0], pj = path[q2][1];
      acc[pi] += localDist(pi, pj);
      cnt[pi] += 1;
    }
    var frameCost = new Float64Array(M);
    for (i = 0; i < M; i++) frameCost[i] = acc[i] / Math.max(cnt[i], 1);

    return {
      dist: total,                            // = Python total_cost（路径上的累计代价）
      normDist: total / path.length,          // = Python norm_distance（除以路径长度！）
      path: path,
      frameCost: frameCost,
      M: M, N: N, bandRadius: band, pathLen: path.length, dim: D
    };
  }

  /* ==========================================================================
   * 7. whisper 词时间戳 -> 逐词代价
   * ========================================================================*/
  /* group_words()（Python L426-455）：带前导空格的 token 开新词，无前导空格的
   * （标点）挂到当前词；丢掉 [_BEG_] / [_TT_*] / <|...|> / 纯空白。*/
  function groupWhisperWords(tokens) {
    var words = [], cur = null;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i] || {};
      var txt = t.text === undefined || t.text === null ? '' : String(t.text);
      if (txt.charAt(0) === '[' || txt.indexOf('<|') === 0 || txt.trim() === '') continue;
      var off = t.offsets || {};
      var from = off.from, to = off.to;
      if (from === undefined || from === null) continue;
      if (to === undefined || to === null) to = from;
      if (txt.charAt(0) === ' ') {
        if (cur) words.push(cur);
        cur = { w: txt.slice(1), fromMs: from, toMs: to };
      } else if (!cur) {
        cur = { w: txt, fromMs: from, toMs: to };
      } else {
        cur.w += txt;
        cur.toMs = Math.max(cur.toMs, to);
      }
    }
    if (cur) words.push(cur);
    return words;
  }

  /* 词对象的字段名归一化。
   * 接口约定是 [{w, fromMs, toMs}]，但本仓库下面两层给的是 **whisper 原生字段名**：
   *   app/src/asr.js  groupTokens() -> { w, ps, from, to }
   *   app/main.js     fillWordGaps() -> { w, from, to }
   * 两者都是毫秒。如果这里只认 fromMs，那边传进来的就是 undefined，时长全变 NaN，
   * 逐词分全成 NaN、maxS 变 NaN、判定恒为"没问题" —— 一个不会报错的静默失败。
   * 所以这里同时接受 fromMs/toMs、from/to、offsets.from/offsets.to 三种写法。
   * 词文本同时接受 w 和 text。*/
  function normWords(list) {
    var out = [];
    list = list || [];
    for (var i = 0; i < list.length; i++) {
      var x = list[i] || {};
      var off = x.offsets || {};
      var f = (x.fromMs !== undefined && x.fromMs !== null) ? x.fromMs
        : (x.from !== undefined && x.from !== null) ? x.from : off.from;
      var t = (x.toMs !== undefined && x.toMs !== null) ? x.toMs
        : (x.to !== undefined && x.to !== null) ? x.to : off.to;
      f = Number(f); t = Number(t);
      if (!isFinite(f)) f = 0;
      if (!isFinite(t)) t = f;
      if (t < f) t = f;
      var txt = (x.w !== undefined && x.w !== null) ? x.w : x.text;
      out.push({ w: txt === undefined || txt === null ? '' : String(txt), fromMs: f, toMs: t });
    }
    return out;
  }

  /* realign_words_to_voiced()（Python L483-522）—— primary 映射：
   * whisper 的词**时长**比它的绝对偏移可靠得多（实测这份 ref.wav 里 token 时长
   * 之和 3130ms 恰好等于有声总时长，但偏移会漂 100-400ms，把 'I' 塞进停顿、
   * 把 'today' 排到音频结束之后）。所以保留相对时长当权重，把词按顺序
   * "浇"到有声帧序列上：任何词都不会拿到静音帧，也不会有词拿到 0 帧。
   * 只用 ref.wav + ref 文本 + whisper，绝不使用"哪个词读错了"的信息。*/
  function realignWordsToVoiced(words, voiced, centresMs, p) {
    var vidx = [], i;
    var nC = centresMs.length;
    var nV = Math.min(voiced.length, nC);
    for (i = 0; i < nV; i++) if (voiced[i]) vidx.push(i);
    var nv = vidx.length;

    var nw = words.length;
    var w = new Float64Array(nw), wsum = 0.0;
    for (i = 0; i < nw; i++) {
      w[i] = Math.max(words[i].toMs - words[i].fromMs, p.minWordDurMs);   // L499
      wsum += w[i];
    }
    var want = new Float64Array(nw), alloc = new Int32Array(nw), tot = 0;
    for (i = 0; i < nw; i++) { want[i] = (wsum > 0 ? w[i] / wsum : 1.0 / nw) * nv; alloc[i] = Math.floor(want[i]); tot += alloc[i]; }
    var rem = nv - tot;
    if (rem > 0) {
      /* 最大余数法：np.argsort(-frac) 取前 rem 个 +1。
       * frac 相等时 numpy 的 introsort 平局顺序未定义；这里用稳定排序（下标小者在前）。
       * 实测这份数据 frac 两两不等，所以不会分叉——测试脚本会核对 owner 数组。*/
      var idx = [], frac = new Float64Array(nw);
      for (i = 0; i < nw; i++) { frac[i] = want[i] - alloc[i]; idx.push(i); }
      idx.sort(function (u, v) { return frac[v] - frac[u]; });
      for (i = 0; i < rem && i < idx.length; i++) alloc[idx[i]] += 1;
    } else if (rem < 0) {
      var idx2 = [];
      for (i = 0; i < nw; i++) idx2.push(i);
      idx2.sort(function (u, v) { return alloc[u] - alloc[v]; });     // np.argsort(alloc)
      for (i = 0; i < (-rem) && i < idx2.length; i++) if (alloc[idx2[i]] > 0) alloc[idx2[i]] -= 1;
    }

    var owner = new Int32Array(nC).fill(-1);
    var bounds = [];
    var pos = 0;
    for (var k = 0; k < nw; k++) {
      var c = alloc[k];
      if (c > 0 && pos < nv) {
        var sel = vidx.slice(pos, pos + c);
        for (i = 0; i < sel.length; i++) owner[sel[i]] = k;
        bounds.push([centresMs[sel[0]], centresMs[sel[sel.length - 1]]]);
        pos += c;
      } else {
        bounds.push([NaN, NaN]);
      }
    }
    return { owner: owner, bounds: bounds, alloc: alloc };
  }

  /* assign_frames_to_words()（Python L458-480）—— 备用映射：
   * 用词跨度**中心**做锚点，切分点取相邻锚点的中点；首词/末词再向外放
   * edge_pad_ms。之后再按 VAD 把静音帧置 -1。*/
  function assignFramesToWords(words, centresMs, totalMs, p) {
    var nw = words.length;
    var anchors = [], k;
    for (k = 0; k < nw; k++) anchors.push(0.5 * (words[k].fromMs + words[k].toMs));
    var bounds = [];
    for (k = 0; k < nw; k++) {
      var lo = (k === 0) ? 0.0 : 0.5 * (anchors[k - 1] + anchors[k]);
      var hi = (k === nw - 1) ? totalMs : 0.5 * (anchors[k] + anchors[k + 1]);
      bounds.push([lo, hi]);
    }
    bounds[0][0] = Math.max(0.0, words[0].fromMs - p.edgePadMs);
    bounds[nw - 1][1] = Math.min(totalMs, words[nw - 1].toMs + p.edgePadMs);

    var owner = new Int32Array(centresMs.length).fill(-1);
    for (k = 0; k < nw; k++) {                       // 注意：按 k 升序覆盖写，和后写者胜
      var b = bounds[k];
      for (var t = 0; t < centresMs.length; t++) {
        if (centresMs[t] >= b[0] && centresMs[t] < b[1]) owner[t] = k;
      }
    }
    return { owner: owner, bounds: bounds };
  }

  /* 逐词代价 = 该词拥有的 ref 帧的 frame_cost 均值（Python word_costs L527-535）。
   * 没有帧的词 -> NaN（Python 也是 NaN，jarr 时变 null）。*/
  function wordCosts(frameCost, owner, nwords) {
    var sum = new Float64Array(nwords), cnt = new Int32Array(nwords);
    for (var i = 0; i < owner.length && i < frameCost.length; i++) {
      var k = owner[i];
      if (k >= 0 && k < nwords) { sum[k] += frameCost[i]; cnt[k] += 1; }
    }
    var cost = new Float64Array(nwords);
    for (var k2 = 0; k2 < nwords; k2++) cost[k2] = cnt[k2] > 0 ? sum[k2] / cnt[k2] : NaN;
    return { cost: cost, frames: cnt };
  }

  /* s_scores()（Python L862-871）：S(k) = cost(k) / mean(其它词的 cost)，NaN 安全。
   * 这就是可行性实验的核心统计量：逐词**相对**分。*/
  function leaveOneOutScores(cost) {
    var n = cost.length, tot = 0.0, cnt = 0, k;
    for (k = 0; k < n; k++) if (cost[k] === cost[k]) { tot += cost[k]; cnt += 1; }
    var out = new Float64Array(n);
    for (k = 0; k < n; k++) {
      if (cost[k] !== cost[k]) { out[k] = NaN; continue; }
      var rest = (tot - cost[k]) / Math.max(cnt - 1, 1);
      out[k] = rest > 0 ? cost[k] / rest : NaN;
    }
    return out;
  }

  function nanmean(a) {
    var s = 0, n = 0;
    for (var i = 0; i < a.length; i++) if (a[i] === a[i]) { s += a[i]; n++; }
    return n > 0 ? s / n : NaN;
  }

  /* 降序排名（NaN 排最后），返回 1-based rank 数组。对应 Python rank_of()/argsort(-v) */
  function ranksDescending(values) {
    var idx = [], i;
    for (i = 0; i < values.length; i++) idx.push(i);
    idx.sort(function (u, v) {
      var a = values[u], b = values[v];
      var au = a !== a, bv = b !== b;
      if (au && bv) return u - v;
      if (au) return 1;
      if (bv) return -1;
      if (b !== a) return b - a;
      return u - v;
    });
    var rank = new Int32Array(values.length);
    for (i = 0; i < idx.length; i++) rank[idx[i]] = i + 1;
    return { order: idx, rank: rank };
  }

  /* ==========================================================================
   * 8. wordScores(frameCost, refWords, params)
   * --------------------------------------------------------------------------
   * refWords: [{w, fromMs, toMs}, ...]（顺序必须与 ref 音频里的词序一致）
   * 要复现 Python 的 primary（vad-constrained）映射，还需要两个"参考侧"的量，
   * 通过 params 传进来（score() 会自动带）：
   *   params.refCentresMs  参考音频每帧的中心时刻（mfcc().centresMs）
   *   params.voicedMask    参考音频的有声掩码（vadMask().voiced）
   *   params.totalMs       参考音频总时长（mfcc().durationMs）
   * 缺 refCentresMs 时退化为"帧间隔 = hopMs"的均匀假设；缺 voicedMask 时视为
   * 全有声（结果里会带 mappingFallback:true 提醒）。
   * ========================================================================*/
  function wordScores(frameCost, refWords, params) {
    var p = mergeParams(params);
    var words = normWords(refWords);      // 兼容 {fromMs,toMs} / {from,to} 两种字段名
    var nw = words.length;
    var nF = frameCost.length;

    var centres = p.refCentresMs;
    var fallback = false;
    if (!centres) {
      fallback = true;
      var flen = pyRound((p.sampleRate * p.frameMs) / 1000.0);
      var hop = pyRound((p.sampleRate * p.hopMs) / 1000.0);
      centres = new Float64Array(nF);
      for (var t = 0; t < nF; t++) centres[t] = (t * hop + flen / 2.0) / p.sampleRate * 1000.0;
    } else if (centres.length !== nF) {
      throw new Error('dtw.js: refCentresMs 长度(' + centres.length + ') 与 frameCost 长度(' + nF + ') 不一致');
    }
    var voiced = p.voicedMask;
    if (!voiced) {
      fallback = true;
      voiced = new Uint8Array(centres.length);
      for (var v = 0; v < voiced.length; v++) voiced[v] = 1;
    }
    var totalMs = p.totalMs;
    if (totalMs === undefined || totalMs === null) {
      totalMs = centres.length ? centres[centres.length - 1] + p.hopMs : 0.0;
      fallback = true;
    }

    var mapped;
    if (p.wordMap === 'whisper') {
      mapped = assignFramesToWords(words, centres, totalMs, p);
      /* Python L666：再把静音帧剔掉 */
      for (var q = 0; q < mapped.owner.length && q < voiced.length; q++) {
        if (!voiced[q]) mapped.owner[q] = -1;
      }
    } else {
      mapped = realignWordsToVoiced(words, voiced, centres, p);
    }

    var wc = wordCosts(frameCost, mapped.owner, nw);
    var S = leaveOneOutScores(wc.cost);
    var rk = ranksDescending(wc.cost);

    /* 退化检测：如果**没有任何一个词**有非零时长，说明时间戳根本没传进来
     * （字段名不对 / ASR 没给）。这种情况下 realign 会把词平均摊到有声帧上，
     * 结果看着很正常，却是在错误的位置上打分 —— 实测会指认错词
     * （把 12 个词等分后 case3 会在 "to" 上给出 S=5.91）。与其误伤，
     * 不如明确标记出来让上层拒绝判定。*/
    var nTimed = 0;
    for (var q2 = 0; q2 < nw; q2++) if (words[q2].toMs > words[q2].fromMs) nTimed++;
    var timingDegenerate = (nw > 0 && nTimed === 0);

    var list = [], maxS = -Infinity, maxIndex = -1;
    for (var k = 0; k < nw; k++) {
      var reliable = wc.frames[k] >= p.minWordFrames;
      list.push({
        w: words[k].w, cost: wc.cost[k], S: S[k], frames: wc.frames[k],
        rank: rk.rank[k], reliable: reliable, fromMs: words[k].fromMs, toMs: words[k].toMs
      });
      if (reliable && S[k] === S[k] && S[k] > maxS) { maxS = S[k]; maxIndex = k; }
    }
    if (maxIndex < 0) { maxS = NaN; }

    /* 关注词（默认 'practice'）：Python 是 strip('.,!?') 后小写比较（L652）*/
    var targetIndex = -1;
    for (k = 0; k < nw; k++) {
      if (String(words[k].w).replace(/^[.,!?]+|[.,!?]+$/g, '').toLowerCase() === String(p.targetWord).toLowerCase()) {
        targetIndex = k;
      }
    }

    return {
      words: list,
      maxS: maxS,
      maxWord: maxIndex >= 0 ? words[maxIndex].w : null,
      maxIndex: maxIndex,
      /* rank1：把第 1 名的完整信息 + 下标都给出来（"rank1" 两种理解都能直接用）*/
      rank1: maxIndex >= 0 ? list[maxIndex] : null,
      rank1Index: maxIndex,
      rank1Word: maxIndex >= 0 ? words[maxIndex].w : null,
      mean: nanmean(wc.cost),
      costs: wc.cost,
      frameCounts: wc.frames,
      S: S,
      ranks: rk.rank,
      order: rk.order,
      owner: mapped.owner,
      bounds: mapped.bounds,
      targetIndex: targetIndex,
      targetWord: targetIndex >= 0 ? words[targetIndex].w : null,
      targetCost: targetIndex >= 0 ? wc.cost[targetIndex] : NaN,
      targetS: targetIndex >= 0 ? S[targetIndex] : NaN,
      targetRank: targetIndex >= 0 ? rk.rank[targetIndex] : -1,
      wordMap: p.wordMap,
      mappingFallback: fallback,
      timingDegenerate: timingDegenerate,
      timedWords: nTimed
    };
  }

  /* ==========================================================================
   * 9. score(...)：一次跑完 ref vs user
   * ========================================================================*/
  function score(userSamples, userRate, refSamples, refRate, refWords, params) {
    var p = mergeParams(params);
    var uRate = userRate || p.sampleRate;
    var rRate = refRate || p.sampleRate;

    /* 各自调理一次，然后复用（mfcc 里不再重复调理）*/
    var refX = p.preprocess ? preprocess(refSamples, rRate, p) : toFloat64(refSamples);
    var usrX = p.preprocess ? preprocess(userSamples, uRate, p) : toFloat64(userSamples);
    var inner = mergeParams(p); inner.preprocess = false;

    var ref = mfcc(refX, rRate, inner);
    var usr = mfcc(usrX, uRate, inner);
    var vad = vadMask(refX, rRate, p);
    ref.signal = refX; usr.signal = usrX;
    ref.energyDb = vad.energyDb;
    usr.energyDb = frameEnergyDb(usrX, uRate, p);
    ref.voiced = vad.voiced;

    var d = dtw(ref.frames, usr.frames, p);

    /* 把**合并后的完整参数**原样传给 wordScores，再补上参考侧上下文。
     * 不要在这里手写参数白名单：那样调用方传的任何自定义项（dtwBand、
     * minWordFrames、wordMap、threshold...）都会被悄悄丢掉。*/
    var wsParams = mergeParams(p);
    wsParams.sampleRate = rRate;          // 参考侧采样率（缺 refCentresMs 时推导帧中心要用）
    wsParams.refCentresMs = ref.centresMs;
    wsParams.voicedMask = vad.voiced;
    wsParams.totalMs = ref.durationMs;
    var ws = wordScores(d.frameCost, refWords, wsParams);

    /* 判定：可行性实验的结论是"只 flag S > 2.0"（Python L891），
     * 两个对照组（同人同文本 case1、只换音色 case2）都停在 1.3 以下。
     * 另外：时间戳退化时一律不 flag —— 宁可漏报也不要在错的位置上指认单词。*/
    var flagged = !!(ws.maxS === ws.maxS && ws.maxS > p.threshold && !ws.timingDegenerate);
    var reason;
    if (ws.timingDegenerate) {
      reason = '参考句没有可用的词级时间戳（' + refWords.length + ' 个词的时长全是 0），' +
               '逐词归因不可信，不作判定';
    } else if (flagged) {
      reason = '词"' + ws.maxWord + '"的相对分 S=' + ws.maxS.toFixed(2) +
               ' 超过阈值 ' + p.threshold.toFixed(2) + '，判定该词读错';
    } else if (ws.maxS === ws.maxS) {
      reason = '最大相对分 S=' + ws.maxS.toFixed(2) + ' 未超过阈值 ' +
               p.threshold.toFixed(2) + '，判定为音色/语速差异，无读错的词';
    } else {
      reason = '没有可用的逐词分数（参考词或帧分配为空）';
    }
    var verdict = {
      flagged: flagged, word: ws.maxWord, S: ws.maxS, threshold: p.threshold,
      targetWord: ws.targetWord, targetS: ws.targetS, targetRank: ws.targetRank,
      timingDegenerate: ws.timingDegenerate,
      reason: reason,
      text: (ws.timingDegenerate ? '未判定：' : (flagged ? '读错：' : '通过：')) + reason
    };

    return {
      /* ---- 题意要求的三件套 ---- */
      d: d.normDist,                 // 全局归一化 DTW 距离（注意：Python 已证明它不可用）
      S: ws.S,                       // 逐词相对分
      判定: verdict,                  // = verdict 的别名，中文键按接口要求保留

      /* ---- 合并结果 ---- */
      verdict: verdict,
      flagged: flagged,
      timingDegenerate: ws.timingDegenerate,
      dtw: d,
      wordScores: ws,
      words: ws.words,
      maxS: ws.maxS,
      maxWord: ws.maxWord,
      rank1: ws.rank1,
      mean: ws.mean,
      targetIndex: ws.targetIndex,
      targetS: ws.targetS,
      targetRank: ws.targetRank,
      ref: ref,
      user: usr,
      params: p
    };
  }

  /* ==========================================================================
   * 10. 顺手的工具（不是接口必需，但接线时省事）
   * ========================================================================*/
  /* 最小 WAV 解码：16bit / 8bit / 32bit PCM + IEEE float32，多声道取平均。
   * 返回 {samples: Float32Array(已除 32768), sampleRate}。
   * 需要 ArrayBuffer（浏览器里用 FileReader/Blob.arrayBuffer() 拿）。*/
  function decodeWav(arrayBuffer) {
    var dv = new DataView(arrayBuffer);
    if (dv.getUint32(0, false) !== 0x52494646) throw new Error('dtw.js: 不是 RIFF 文件');
    var offset = 12, fmt = null, dataOff = -1, dataLen = 0;
    while (offset + 8 <= dv.byteLength) {
      var id = dv.getUint32(offset, false);
      var size = dv.getUint32(offset + 4, true);
      var body = offset + 8;
      if (id === 0x666d7420) {                    // 'fmt '
        fmt = {
          format: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          sampleRate: dv.getUint32(body + 4, true),
          bits: dv.getUint16(body + 14, true)
        };
      } else if (id === 0x64617461) {             // 'data'
        dataOff = body; dataLen = size;
      }
      offset = body + size + (size & 1);
    }
    if (!fmt || dataOff < 0) throw new Error('dtw.js: WAV 缺少 fmt/data 块');
    var bytes = fmt.bits >> 3, nch = fmt.channels;
    var n = Math.floor(dataLen / (bytes * nch));
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var acc = 0.0;
      for (var c = 0; c < nch; c++) {
        var p = dataOff + (i * nch + c) * bytes;
        var v;
        if (fmt.format === 3) v = dv.getFloat32(p, true);
        else if (bytes === 2) v = dv.getInt16(p, true) / 32768.0;
        else if (bytes === 1) v = (dv.getUint8(p) - 128) / 128.0;
        else if (bytes === 4) v = dv.getInt32(p, true) / 2147483648.0;
        else throw new Error('dtw.js: 不支持的位深 ' + fmt.bits);
        acc += v;
      }
      out[i] = acc / nch;
    }
    return { samples: out, sampleRate: fmt.sampleRate, channels: nch };
  }

  return {
    DEFAULTS: DEFAULTS,
    mergeParams: mergeParams,

    /* ---- 接口要求的 4 个函数 ---- */
    mfcc: mfcc,
    dtw: dtw,
    wordScores: wordScores,
    score: score,

    /* ---- 前端各步（拆开方便单测 / 消融）---- */
    preprocess: preprocess,
    frameEnergyDb: frameEnergyDb,
    vadMask: vadMask,
    percentile: percentile,
    normaliseCepstra: normaliseCepstra,
    leaveOneOutScores: leaveOneOutScores,
    realignWordsToVoiced: realignWordsToVoiced,
    assignFramesToWords: assignFramesToWords,
    wordCosts: wordCosts,
    ranksDescending: ranksDescending,
    nanmean: nanmean,

    /* ---- 工具 ---- */
    decodeWav: decodeWav,
    groupWhisperWords: groupWhisperWords,
    normWords: normWords,
    hz2mel: hz2mel,
    mel2hz: mel2hz,
    buildMelFilterbank: buildMelFilterbank,
    buildDct: buildDct,
    pyRound: pyRound,

    _version: '1.0.0'
  };
});
