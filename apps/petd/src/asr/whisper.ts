/**
 * whisper-cli 封装：把 WAV（或 PCM16 16k）交给本地 whisper.cpp 识别。
 *
 * 二进制与模型都走「本地已有就用、没有就下载」：
 *   - whisper-cli.exe + DLL 随仓库 `app/vendor/whisper/`（旧桌宠的拷贝），
 *     也支持配置 asr.binaryDir / 环境变量 PETD_WHISPER_DIR 指定；
 *   - 模型由 AsrModels 管理（home/asr 或旧版 %APPDATA%/dayu-pet/asr）。
 *
 * 静音裁剪逻辑参考旧桌宠 app/src/asr.js（纯能量法，不依赖额外模型）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Converter } from 'opencc-js';
import { PetdError } from '@petd/protocol';
import type { AsrModels } from './models.js';

export interface WhisperLogger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
}

export interface WhisperEngineOptions {
  models: AsrModels;
  /** 配置里的 asr.binaryDir（空 = 自动探测） */
  binaryDir?: string;
  /** 临时文件目录（home/asr/tmp） */
  tmpDir: string;
  logger?: WhisperLogger;
}

export interface TranscribeOptions {
  language?: string;
  prompt?: string;
  useVad?: boolean;
  vadThreshold?: number;
  /** 显式指定模型档位（默认配置的 asr.model） */
  model?: 'tiny' | 'base' | 'small';
}

export interface TranscribeResult {
  text: string;
  language: string;
  durationMs: number;
  tookMs: number;
}

const RUN_TIMEOUT_MS = 120_000;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

/** 生成 whisper-cli 参数（纯函数，便于测试） */
export function buildWhisperArgs(o: {
  modelPath: string;
  wavPath: string;
  outBase: string;
  language: string;
  prompt?: string;
  vadPath?: string | null;
  vadThreshold?: number;
}): string[] {
  const args = ['-m', o.modelPath, '-f', o.wavPath, '-l', o.language.trim() || 'auto', '-ojf', '-of', o.outBase, '-np'];
  const prompt = o.prompt?.trim();
  if (prompt) args.push('--prompt', prompt);
  if (o.vadPath) {
    args.push('--vad', '-vm', o.vadPath);
    if (typeof o.vadThreshold === 'number' && Number.isFinite(o.vadThreshold)) args.push('-vt', String(o.vadThreshold));
  }
  return args;
}

/** 解析 whisper 的 -ojf JSON（取第一段转录文本与语言） */
export function parseWhisperJson(text: string): { text: string; language: string } {
  try {
    const j = JSON.parse(text) as {
      transcriphion?: unknown;
      transcription?: Array<{ text?: unknown; language?: unknown }>;
      result?: { language?: unknown };
    };
    const tr = Array.isArray(j.transcription) ? j.transcription[0] : undefined;
    const raw = tr && typeof tr.text === 'string' ? tr.text : '';
    const language = typeof j.result?.language === 'string' ? j.result.language : typeof tr?.language === 'string' ? tr.language : '';
    const cleaned = raw
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { text: cleaned, language };
  } catch {
    return { text: '', language: '' };
  }
}

/** 繁体 → 简体（whisper 中文模型常输出繁体；用 OpenCC 的 tw→cn 表兜一下） */
const twToCn = Converter({ from: 'tw', to: 'cn' });

/**
 * 规范化中文识别结果：中文（或语言未知且含汉字）时转简体。
 * 其它语言原样返回。
 */
export function normalizeChinese(text: string, language: string): string {
  if (!text) return text;
  const lang = language.toLowerCase();
  const isZh = lang.startsWith('zh') || (lang === '' && /[\u4e00-\u9fff]/.test(text));
  if (!isZh) return text;
  try {
    return twToCn(text);
  } catch {
    return text;
  }
}

/** 解析 WAV：返回 PCM 数据区偏移/长度/格式 */
function readWavInfo(buf: Buffer): { dataOffset: number; dataLength: number; sampleRate: number; channels: number; bits: number } | null {
  if (buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bits = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      const start = offset + 8;
      const len = Math.min(size, buf.length - start);
      return { dataOffset: start, dataLength: len, sampleRate, channels, bits };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * 静音裁剪：whisper 对首尾长静音敏感（会解出幻觉词且慢）。
 * 20ms 窗能量，掐掉首尾低于「峰值 8%」的部分，首留 280ms / 尾留 100ms 缓冲。
 */
export function trimSilence(wav: Buffer): Buffer {
  try {
    const info = readWavInfo(wav);
    if (!info || info.bits !== 16) return wav;
    const frame = 2 * info.channels;
    const win = Math.floor((info.sampleRate * 0.02) * frame);
    const total = info.dataLength;
    if (total < 6400 || win <= 0) return wav;
    const nWin = Math.floor(total / win);
    if (nWin < 3) return wav;
    const rms: number[] = [];
    let peak = 0;
    for (let w = 0; w < nWin; w++) {
      let sum = 0;
      for (let i = 0; i + frame <= win; i += frame) {
        const s = wav.readInt16LE(info.dataOffset + w * win + i) / 32768;
        sum += s * s;
      }
      const r = Math.sqrt(sum / (win / frame));
      rms.push(r);
      if (r > peak) peak = r;
    }
    const th = Math.max(0.004, peak * 0.08);
    let a = 0;
    let z = nWin - 1;
    while (a < nWin && rms[a]! < th) a++;
    while (z > a && rms[z]! < th) z--;
    if (a === 0 && z === nWin - 1) return wav;
    const padIn = Math.floor((info.sampleRate * 0.28) * frame);
    const padOut = Math.floor((info.sampleRate * 0.1) * frame);
    const start = Math.max(0, a * win - padIn);
    const end = Math.min(total, (z + 1) * win + padOut);
    if (end - start < 6400) return wav;
    const out = Buffer.concat([wav.subarray(0, info.dataOffset), wav.subarray(info.dataOffset + start, info.dataOffset + end)]);
    out.writeUInt32LE(end - start, info.dataOffset - 4);
    out.writeUInt32LE(out.length - 8, 4);
    return out;
  } catch {
    return wav;
  }
}

/** PCM16 单声道小端 → 16kHz WAV */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function wavDurationMs(wav: Buffer): number {
  const info = readWavInfo(wav);
  if (!info) return 0;
  const frame = 2 * info.channels;
  if (frame <= 0) return 0;
  return Math.round((info.dataLength / frame / info.sampleRate) * 1000);
}

export class WhisperEngine {
  private readonly models: AsrModels;
  private readonly binaryDir: string | undefined;
  private readonly tmpDir: string;
  private readonly logger: WhisperLogger | undefined;
  private cachedBinary: string | null | undefined;

  constructor(opts: WhisperEngineOptions) {
    this.models = opts.models;
    this.binaryDir = opts.binaryDir?.trim() || undefined;
    this.tmpDir = opts.tmpDir;
    this.logger = opts.logger;
  }

  /** 在若干候选位置找 whisper-cli.exe（找不到返回 null） */
  resolveBinary(): string | null {
    if (this.cachedBinary !== undefined) return this.cachedBinary;
    const candidates: string[] = [];
    const env = process.env['PETD_WHISPER_DIR'];
    if (env && env.trim()) candidates.push(path.join(env.trim(), 'whisper-cli.exe'));
    if (this.binaryDir) candidates.push(path.join(this.binaryDir, 'whisper-cli.exe'));
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      // dist/asr/whisper.js → apps/petd/vendor/whisper
      candidates.push(path.join(here, '..', '..', 'vendor', 'whisper', 'whisper-cli.exe'));
      // dist/asr → 仓库根 app/vendor/whisper（开发态）
      candidates.push(path.join(here, '..', '..', '..', '..', 'app', 'vendor', 'whisper', 'whisper-cli.exe'));
    } catch {
      /* import.meta 不可用时忽略 */
    }
    candidates.push(path.join(process.cwd(), 'app', 'vendor', 'whisper', 'whisper-cli.exe'));
    candidates.push(path.join(process.cwd(), 'vendor', 'whisper', 'whisper-cli.exe'));
    for (const c of candidates) {
      try {
        if (fs.statSync(c).isFile()) {
          this.cachedBinary = c;
          return c;
        }
      } catch {
        /* 继续找 */
      }
    }
    this.cachedBinary = null;
    return null;
  }

  status(): {
    binary: { found: boolean; path: string | null };
    models: ReturnType<AsrModels['status']>;
  } {
    const binary = this.resolveBinary();
    return { binary: { found: binary !== null, path: binary }, models: this.models.status() };
  }

  /** 识别一段音频（WAV 或任意 miniaudio 支持的格式；建议 16k 单声道 WAV） */
  async transcribe(audio: Buffer, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
    if (!Buffer.isBuffer(audio) || audio.length === 0) throw new PetdError('E_BAD_PARAMS', '音频为空');
    if (audio.length > MAX_AUDIO_BYTES) throw new PetdError('E_BAD_PARAMS', '音频太大（上限 64MB）');
    const binary = this.resolveBinary();
    if (!binary) throw new PetdError('E_UNAVAILABLE', '找不到 whisper-cli.exe（把 whisper.cpp 放到 apps/petd/vendor/whisper，或配置 asr.binaryDir）');
    const modelId = opts.model ?? 'base';
    const modelPath = this.models.modelPath(modelId);
    if (!modelPath) throw new PetdError('E_UNAVAILABLE', `语音模型 ggml-${modelId}.bin 还没下载（调 asr.download）`);
    const vadPath = opts.useVad === false ? null : this.models.vadPath();
    const isWav = audio.length >= 12 && audio.toString('ascii', 0, 4) === 'RIFF';
    const wav = isWav ? trimSilence(audio) : audio;
    const durationMs = isWav ? wavDurationMs(wav) : 0;
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const stamp = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
    const wavPath = path.join(this.tmpDir, `asr-${stamp}.wav`);
    const outBase = path.join(this.tmpDir, `asr-${stamp}`);
    fs.writeFileSync(wavPath, wav);
    const t0 = Date.now();
    try {
      const args = buildWhisperArgs({
        modelPath,
        wavPath,
        outBase,
        language: opts.language ?? 'zh',
        prompt: opts.prompt,
        vadPath,
        vadThreshold: opts.vadThreshold,
      });
      await this.run(binary, args);
      let text = '';
      let language = '';
      try {
        const parsed = parseWhisperJson(fs.readFileSync(outBase + '.json', 'utf8'));
        language = parsed.language;
        text = normalizeChinese(parsed.text, language);
      } catch {
        text = '';
      }
      const tookMs = Date.now() - t0;
      this.logger?.debug('whisper 识别完成', { durationMs, tookMs, chars: text.length });
      return { text, language, durationMs, tookMs };
    } finally {
      for (const f of [wavPath, outBase + '.json', outBase + '.txt']) {
        try {
          fs.rmSync(f, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  private run(binary: string, args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let stderr = '';
      const child = spawn(binary, args, { cwd: path.dirname(binary), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new PetdError('E_TIMEOUT', '语音识别超时（120s）'));
      }, RUN_TIMEOUT_MS);
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
        if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new PetdError('E_INTERNAL', `启动 whisper-cli 失败：${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          const tail = stderr.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' | ');
          reject(new PetdError('E_INTERNAL', `whisper-cli 退出码 ${String(code)}${tail ? `：${tail}` : ''}`));
        }
      });
    });
  }
}
