/**
 * 流式能量 VAD：把连续的 PCM16（16kHz 单声道）切成「一段话」。
 *
 * 做法（参考旧桌宠的 trimSilence + 常见 ASR 前端）：
 *   - 20ms 窗口算 RMS；
 *   - 超过阈值进入「说话中」，低于阈值×0.6 累计静音；
 *   - 静音超过 silenceMs 就切段，段长不足 minSpeechMs 当噪声丢弃；
 *   - 段长超过 maxSegmentMs 强制切段；
 *   - 说话开始前保留少量 pre-roll，避免吞掉句首。
 *
 * 这里只做「切段」，识别交给 whisper。
 */

export interface VadOptions {
  sampleRate: number;
  /** RMS 阈值（0–1 归一化，默认 0.012） */
  energyThreshold: number;
  /** 一段话最短时长（毫秒） */
  minSpeechMs: number;
  /** 静音多久算说完（毫秒） */
  silenceMs: number;
  /** 单段最长时长（毫秒） */
  maxSegmentMs: number;
  /** 说话前保留的 pre-roll（毫秒，默认 300） */
  preRollMs?: number;
}

export interface VadSegment {
  /** PCM16 单声道小端 */
  pcm: Buffer;
  durationMs: number;
}

const WINDOW_MS = 20;

export class StreamingVad {
  private readonly opts: Required<VadOptions>;
  private readonly windowSamples: number;
  private pending: Buffer = Buffer.alloc(0);
  private preRoll: Buffer[] = [];
  private preRollBytes = 0;
  private speaking = false;
  private segment: Buffer[] = [];
  private segmentSamples = 0;
  private silenceSamples = 0;

  constructor(opts: VadOptions) {
    this.opts = {
      ...opts,
      preRollMs: opts.preRollMs ?? 300,
    };
    this.windowSamples = Math.round((this.opts.sampleRate * WINDOW_MS) / 1000);
  }

  private readonly preRollMax = (): number => Math.round((this.opts.sampleRate * this.opts.preRollMs) / 1000) * 2;

  /** 喂一段 PCM16，返回本次切出来的完整语音段（0~n 个） */
  push(chunk: Buffer): VadSegment[] {
    const out: VadSegment[] = [];
    if (chunk.length === 0) return out;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const windowBytes = this.windowSamples * 2;
    let offset = 0;
    while (this.pending.length - offset >= windowBytes) {
      const win = this.pending.subarray(offset, offset + windowBytes);
      offset += windowBytes;
      const seg = this.processWindow(win, out);
      if (seg) out.push(seg);
    }
    this.pending = offset >= this.pending.length ? Buffer.alloc(0) : Buffer.from(this.pending.subarray(offset));
    return out;
  }

  /** 结束监听：把正在说的话强制切出来 */
  flush(): VadSegment[] {
    const out: VadSegment[] = [];
    if (this.speaking && this.segmentSamples > 0) {
      const seg = this.finishSegment(out, false);
      if (seg) out.push(seg);
    }
    this.reset();
    return out;
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
    this.preRoll = [];
    this.preRollBytes = 0;
    this.speaking = false;
    this.segment = [];
    this.segmentSamples = 0;
    this.silenceSamples = 0;
  }

  /** 当前是否在说话（便于 status 展示） */
  isSpeaking(): boolean {
    return this.speaking;
  }

  private processWindow(win: Buffer, out: VadSegment[]): VadSegment | null {
    const rms = this.rms(win);
    const speech = rms >= this.opts.energyThreshold;
    const minSamples = Math.round((this.opts.sampleRate * this.opts.minSpeechMs) / 1000);
    const silenceSamples = Math.round((this.opts.sampleRate * this.opts.silenceMs) / 1000);
    const maxSamples = Math.round((this.opts.sampleRate * this.opts.maxSegmentMs) / 1000);
    if (!this.speaking) {
      if (!speech) {
        this.preRoll.push(Buffer.from(win));
        this.preRollBytes += win.length;
        while (this.preRollBytes > this.preRollMax() && this.preRoll.length > 0) {
          const head = this.preRoll.shift();
          this.preRollBytes -= head ? head.length : 0;
        }
        return null;
      }
      this.speaking = true;
      this.segment = [...this.preRoll, Buffer.from(win)];
      this.segmentSamples = this.segment.reduce((n, b) => n + b.length / 2, 0);
      this.preRoll = [];
      this.preRollBytes = 0;
      this.silenceSamples = 0;
      return null;
    }
    this.segment.push(Buffer.from(win));
    this.segmentSamples += win.length / 2;
    if (speech) this.silenceSamples = 0;
    else this.silenceSamples += win.length / 2;
    if (this.segmentSamples >= maxSamples) {
      return this.finishSegment(out, true);
    }
    if (this.silenceSamples >= silenceSamples) {
      const enough = this.segmentSamples - this.silenceSamples >= minSamples;
      return this.finishSegment(out, !enough);
    }
    return null;
  }

  /** 切段；dropIfShort=true 表示段太短直接丢弃 */
  private finishSegment(_out: VadSegment[], dropIfShort: boolean): VadSegment | null {
    let pcm = Buffer.concat(this.segment);
    // 尾部静音只留 200ms（whisper 不怕句尾静音，但太长会拖慢、还可能产生幻觉）
    const silenceBytes = Math.min(pcm.length, Math.round(this.silenceSamples) * 2);
    const keepTail = Math.min(silenceBytes, Math.round((this.opts.sampleRate * 0.2) / 1000) * 2);
    if (silenceBytes > 0) pcm = pcm.subarray(0, pcm.length - silenceBytes + keepTail);
    const durationMs = Math.round((pcm.length / 2 / this.opts.sampleRate) * 1000);
    this.segment = [];
    this.segmentSamples = 0;
    this.silenceSamples = 0;
    this.speaking = false;
    if (dropIfShort || durationMs < this.opts.minSpeechMs) return null;
    return { pcm, durationMs };
  }

  private rms(buf: Buffer): number {
    const samples = Math.floor(buf.length / 2);
    if (samples === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples; i++) {
      const s = buf.readInt16LE(i * 2) / 32768;
      sum += s * s;
    }
    return Math.sqrt(sum / samples);
  }
}
