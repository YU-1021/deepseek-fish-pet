/* 录音器（渲染层共用）：直接产出 whisper 要的 16kHz 单声道 WAV
 * 两种模式：
 *   pushStart/pushStop   —— 按住说话（空格 / 麦克风按钮）
 *   startAlwaysOn        —— 常驻听：自己用能量 VAD 切句，检测到"说完一段"就回调
 * 不依赖任何在线服务。
 */
(function () {
  const SR = 16000;
  const FRAME = 2048;                 // 128ms/帧
  const MAX_PUSH_FRAMES = Math.round((SR * 120) / FRAME);   // push 模式最长缓冲 120 秒
  let stream = null, ctx = null, src = null, proc = null, sink = null;
  let mode = null;                    // 'push' | 'always'
  let chunks = [];
  let onUtter = null;
  let vad = null;

  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioContext);

  async function open() {
    if (ctx) return true;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
    src = ctx.createMediaStreamSource(stream);
    proc = ctx.createScriptProcessor(FRAME, 1, 1);
    sink = ctx.createGain();
    sink.gain.value = 0;               // 不回放，避免啸叫
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(d.length);
      copy.set(d);
      /* push 模式必须有上限：每帧 8KB、7.8 帧/秒 ≈ 3.7MB/分钟。
         一旦因为状态机问题没能停下录音（例如按住说话启动期间就松手），
         以前 chunks 会一直涨，挂一小时就是 200MB+。 */
      if (mode === 'push') { if (chunks.length < MAX_PUSH_FRAMES) chunks.push(copy); }
      else if (mode === 'always' && vad) vadPush(copy);
    };
    src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
    return true;
  }

  function close() {
    try { if (proc) proc.onaudioprocess = null; } catch {}
    try { src && src.disconnect(); } catch {}
    try { proc && proc.disconnect(); } catch {}
    try { sink && sink.disconnect(); } catch {}
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { ctx && ctx.close(); } catch {}
    stream = ctx = src = proc = sink = null;
    chunks = []; vad = null; mode = null;
  }

  function join(list) {
    let n = 0;
    for (const c of list) n += c.length;
    const out = new Float32Array(n);
    let o = 0;
    for (const c of list) { out.set(c, o); o += c.length; }
    return out;
  }

  function toWav(f32) {
    const n = f32.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE');
    ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, n * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
    return buf;
  }

  const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };

  /* ---------- 按住说话 ---------- */
  async function pushStart() {
    close();
    await open();
    chunks = []; mode = 'push';
    return true;
  }
  function pushStop() {
    if (mode !== 'push') { close(); return null; }
    mode = 'push';                    // 先取数据再关
    const data = join(chunks);
    const out = data.length > SR * 0.25 ? toWav(data) : null;
    close();
    return out;
  }

  /* ---------- 常驻听（能量 VAD） ---------- */
  function vadPush(copy) {
    const level = rms(copy);
    const v = vad;
    if (v.cal < 10) {                 // 前 ~1.3s 当噪声底
      v.cal++;
      v.noise = v.noise * 0.7 + level * 0.3;
      v.pre.push(copy);
      if (v.pre.length > 5) v.pre.shift();
      return;
    }
    const thr = Math.max(0.013, v.noise * 3.0);
    if (level > thr) { v.voiced++; v.silence = 0; } else { v.silence++; if (v.voiced > 0 && v.silence > 3) v.voiced = 0; }

    if (!v.speaking) {
      v.pre.push(copy);
      if (v.pre.length > 5) v.pre.shift();
      if (v.voiced >= 3) {            // 连续 ~0.4s 有声音 → 认定开始说话
        v.speaking = true;
        v.seg = v.pre.slice();
        v.pre = [];
        v.silence = 0;
        v.frames = v.seg.length;
      }
      return;
    }

    v.seg.push(copy);
    v.frames++;
    const tooLong = v.frames > Math.round((SR * 15) / FRAME);   // 最长 15 秒
    if (v.silence >= 8 || tooLong) {                            // ~1s 静音 → 说完一段
      const data = join(v.seg);
      v.speaking = false; v.seg = []; v.pre = []; v.voiced = 0; v.silence = 0; v.frames = 0;
      if (data.length > SR * 0.35 && onUtter) {
        try { onUtter(toWav(data)); } catch {}
      }
    }
  }

  async function startAlwaysOn(cb) {
    close();
    onUtter = cb;
    await open();
    vad = { cal: 0, noise: 0.006, speaking: false, seg: [], pre: [], voiced: 0, silence: 0, frames: 0 };
    mode = 'always';
    return true;
  }
  function stopAlwaysOn() { onUtter = null; close(); }

  window.PetASR = { supported, pushStart, pushStop, startAlwaysOn, stopAlwaysOn, isOpen: () => !!ctx, SR };
})();
