/**
 * 语音识别服务：本地 whisper.cpp + 能量 VAD + 唤醒词。
 *
 * 两条入口：
 *   - 一次性识别：transcribe(audio)（UI 录音完把整段 WAV 丢过来）；
 *   - 流式监听：listen.start / listen.feed(PCM16) / listen.stop，VAD 自动切句，
 *     每句识别后广播 asr.segment；说出唤醒词时广播 asr.wake；
 *     开了 asr.autoChat 时把整句交给 onUtterance（index 接到 ChatService）。
 *
 * 唤醒词匹配：归一化后包含 + LCS 相似度兜底（ASR 常把「大肥鱼」听成「大飞鱼」）。
 */
import { randomUUID } from 'node:crypto';
import { PetdError } from '@petd/protocol';
import type { PetdConfig } from '../kernel/config.js';
import { AsrModels, VAD_MODEL, WHISPER_MODELS, type DownloadProgress, type WhisperModelId } from './models.js';
import { StreamingVad } from './vad.js';
import { WhisperEngine, pcmToWav } from './whisper.js';

export type AsrConfig = PetdConfig['asr'];

export interface AsrLogger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  debug(msg: string, data?: unknown): void;
}

export interface AsrServiceOptions {
  config: AsrConfig;
  home: string;
  logger?: AsrLogger;
  publish?: (event: string, data: unknown) => void;
  /** 整句识别完成后的回调（autoChat 或上层想接都行） */
  onUtterance?: (text: string, wake: string | null) => void;
  /** 测试注入 */
  engine?: WhisperEngine;
  models?: AsrModels;
}

export interface AsrSegmentResult {
  streamId: string;
  index: number;
  text: string;
  language: string;
  durationMs: number;
  tookMs: number;
  wake: string | null;
}

interface ListenStream {
  id: string;
  vad: StreamingVad;
  index: number;
  createdAt: number;
  lastAt: number;
}

const MAX_STREAMS = 4;
const STREAM_IDLE_MS = 60_000;
const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

/** 唤醒词比较用：去空白/标点/符号、转小写 */
export function normalizeWakeText(text: string): string {
  try {
    return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  } catch {
    return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  }
}

/** 最长公共子序列占较长串的比例（0–1）：比二元组 Dice 更容忍单字听错 */
export function wakeSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1).fill(0);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return prev[n]! / Math.max(m, n);
}

/**
 * 在识别文本里找唤醒词：先直接包含，再滑窗 LCS 相似度兜底（阈值 0.66）。
 * 返回命中的原始唤醒词，没命中返回 null。
 */
export function matchWakeWord(text: string, words: string[]): string | null {
  const norm = normalizeWakeText(text);
  if (!norm) return null;
  for (const w of words) {
    const nw = normalizeWakeText(w);
    if (nw.length >= 2 && norm.includes(nw)) return w;
  }
  for (const w of words) {
    const nw = normalizeWakeText(w);
    if (nw.length < 2) continue;
    for (const span of [nw.length, nw.length + 1]) {
      const win = Math.min(norm.length, span);
      if (win < 2) continue;
      for (let i = 0; i + win <= norm.length; i++) {
        if (wakeSimilarity(nw, norm.slice(i, i + win)) >= 0.66) return w;
      }
    }
  }
  return null;
}

function decodeBase64(b64: string, maxBytes: number, label: string): Buffer {
  if (typeof b64 !== 'string' || b64.length === 0) throw new PetdError('E_BAD_PARAMS', `${label}为空`);
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    throw new PetdError('E_BAD_PARAMS', `${label}不是合法 base64`);
  }
  if (buf.length === 0) throw new PetdError('E_BAD_PARAMS', `${label}解码后为空`);
  if (buf.length > maxBytes) throw new PetdError('E_BAD_PARAMS', `${label}太大（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
  return buf;
}

export class AsrService {
  private readonly config: AsrConfig;
  private readonly home: string;
  private readonly logger: AsrLogger | undefined;
  private readonly publish: ((event: string, data: unknown) => void) | undefined;
  private readonly onUtterance: ((text: string, wake: string | null) => void) | undefined;
  private readonly models: AsrModels;
  private readonly engine: WhisperEngine;
  private readonly streams = new Map<string, ListenStream>();

  constructor(opts: AsrServiceOptions) {
    this.config = opts.config;
    this.home = opts.home;
    this.logger = opts.logger;
    this.publish = opts.publish;
    this.onUtterance = opts.onUtterance;
    const modelDir = this.config.modelDir.trim();
    this.models =
      opts.models ??
      new AsrModels({
        home: this.home,
        ...(modelDir ? { modelDir } : {}),
        ...(this.logger ? { logger: this.logger } : {}),
      });
    const binaryDir = this.config.binaryDir.trim();
    this.engine =
      opts.engine ??
      new WhisperEngine({
        models: this.models,
        ...(binaryDir ? { binaryDir } : {}),
        tmpDir: `${this.home}/asr/tmp`,
        ...(this.logger ? { logger: this.logger } : {}),
      });
  }

  private emit(event: string, data: unknown): void {
    try {
      this.publish?.(event, data);
    } catch (e) {
      this.logger?.warn('广播语音识别事件失败', { event, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private assertEnabled(): void {
    if (!this.config.enabled) throw new PetdError('E_UNAVAILABLE', '语音识别已关闭（config.asr.enabled=false）');
  }

  private assertReady(): void {
    const binary = this.engine.resolveBinary();
    if (!binary) throw new PetdError('E_UNAVAILABLE', '找不到 whisper-cli.exe（把 whisper.cpp 放到 apps/petd/vendor/whisper，或配置 asr.binaryDir）');
    const model = this.config.model;
    if (!this.models.modelPath(model)) {
      throw new PetdError('E_UNAVAILABLE', `语音模型 ggml-${model}.bin 还没下载（调 asr.download，model="${model}"）`);
    }
  }

  status(): {
    enabled: boolean;
    engine: 'whisper.cpp';
    model: WhisperModelId;
    language: string;
    binary: { found: boolean; path: string | null };
    models: ReturnType<AsrModels['status']>;
    wakeEnabled: boolean;
    wakeWords: string[];
    listening: number;
    autoChat: boolean;
  } {
    return {
      enabled: this.config.enabled,
      engine: 'whisper.cpp',
      model: this.config.model,
      language: this.config.language,
      binary: this.engine.status().binary,
      models: this.models.status(),
      wakeEnabled: this.config.wakeEnabled,
      wakeWords: this.config.wakeWords,
      listening: this.streams.size,
      autoChat: this.config.autoChat,
    };
  }

  /** 可下载模型清单 + 当前是否就绪 */
  modelList(): Array<{
    id: WhisperModelId;
    label: string;
    size: number;
    ready: boolean;
    path: string | null;
    current: boolean;
  }> {
    return (Object.keys(WHISPER_MODELS) as WhisperModelId[]).map((id) => {
      const def = WHISPER_MODELS[id];
      return {
        id,
        label: def.label,
        size: def.size,
        ready: Boolean(this.models.modelPath(id)),
        path: this.models.modelPath(id),
        current: id === this.config.model,
      };
    });
  }

  /** 下载模型（VAD 模型一并确保） */
  async download(model: WhisperModelId): Promise<{ model: string; path: string; vad: boolean }> {
    const id = model;
    if (!(id in WHISPER_MODELS)) throw new PetdError('E_BAD_PARAMS', `未知模型：${String(model)}`);
    const progress = (p: DownloadProgress): void => this.emit('asr.download', p);
    const modelPath = await this.models.ensureModel(id, progress);
    let vad = false;
    try {
      await this.models.ensureVad(progress);
      vad = true;
    } catch (e) {
      this.logger?.warn('VAD 模型下载失败，将不带 VAD 识别', { error: e instanceof Error ? e.message : String(e) });
    }
    this.logger?.info('语音模型已就绪', { model: id, path: modelPath, vad });
    return { model: id, path: modelPath, vad };
  }

  /** 一次性识别整段音频（WAV 优先） */
  async transcribe(input: {
    audioBase64: string;
    language?: string;
    model?: WhisperModelId;
  }): Promise<{ text: string; language: string; durationMs: number; tookMs: number; wake: string | null }> {
    this.assertEnabled();
    this.assertReady();
    const audio = decodeBase64(input.audioBase64, MAX_AUDIO_BYTES, '音频');
    const model = input.model;
    const result = await this.engine.transcribe(audio, {
      language: input.language ?? this.config.language,
      prompt: this.config.prompt,
      useVad: this.config.useVad,
      vadThreshold: this.config.vadThreshold,
      ...(model ? { model } : {}),
    });
    const wake = this.config.wakeEnabled ? matchWakeWord(result.text, this.config.wakeWords) : null;
    this.emit('asr.transcribed', { ...result, wake });
    return { ...result, wake };
  }

  listenStart(): {
    streamId: string;
    sampleRate: number;
    vad: { energyThreshold: number; minSpeechMs: number; silenceMs: number; maxSegmentMs: number };
    model: WhisperModelId;
    wakeEnabled: boolean;
    wakeWords: string[];
  } {
    this.assertEnabled();
    this.assertReady();
    this.cleanupStreams();
    if (this.streams.size >= MAX_STREAMS) {
      throw new PetdError('E_UNAVAILABLE', `同时监听数已达上限（${MAX_STREAMS}），先 stop 掉一个`);
    }
    const id = `asr-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.streams.set(id, {
      id,
      vad: new StreamingVad({
        sampleRate: this.config.sampleRate,
        energyThreshold: this.config.energyThreshold,
        minSpeechMs: this.config.minSpeechMs,
        silenceMs: this.config.silenceMs,
        maxSegmentMs: this.config.maxSegmentMs,
      }),
      index: 0,
      createdAt: now,
      lastAt: now,
    });
    this.logger?.info('开始监听', { streamId: id });
    return {
      streamId: id,
      sampleRate: this.config.sampleRate,
      vad: {
        energyThreshold: this.config.energyThreshold,
        minSpeechMs: this.config.minSpeechMs,
        silenceMs: this.config.silenceMs,
        maxSegmentMs: this.config.maxSegmentMs,
      },
      model: this.config.model,
      wakeEnabled: this.config.wakeEnabled,
      wakeWords: this.config.wakeWords,
    };
  }

  /** 喂 PCM16（16kHz 单声道小端）base64，返回本次切出的句子识别结果 */
  async listenFeed(streamId: string, pcmBase64: string): Promise<AsrSegmentResult[]> {
    this.assertEnabled();
    const stream = this.streams.get(streamId);
    if (!stream) throw new PetdError('E_NOT_FOUND', `监听流不存在或已结束：${streamId}`);
    const pcm = decodeBase64(pcmBase64, MAX_CHUNK_BYTES, 'PCM 数据');
    stream.lastAt = Date.now();
    const segments = stream.vad.push(pcm);
    return this.transcribeSegments(stream, segments);
  }

  async listenStop(streamId: string): Promise<AsrSegmentResult[]> {
    const stream = this.streams.get(streamId);
    if (!stream) throw new PetdError('E_NOT_FOUND', `监听流不存在或已结束：${streamId}`);
    this.streams.delete(streamId);
    const segments = stream.vad.flush();
    const results = await this.transcribeSegments(stream, segments);
    this.logger?.info('结束监听', { streamId, segments: results.length });
    this.emit('asr.listen.stopped', { streamId });
    return results;
  }

  private async transcribeSegments(
    stream: ListenStream,
    segments: Array<{ pcm: Buffer; durationMs: number }>
  ): Promise<AsrSegmentResult[]> {
    const out: AsrSegmentResult[] = [];
    for (const seg of segments) {
      let text = '';
      let language = '';
      let tookMs = 0;
      try {
        const r = await this.engine.transcribe(pcmToWav(seg.pcm, this.config.sampleRate), {
          language: this.config.language,
          prompt: this.config.prompt,
          useVad: this.config.useVad,
          vadThreshold: this.config.vadThreshold,
        });
        text = r.text;
        language = r.language;
        tookMs = r.tookMs;
      } catch (e) {
        this.logger?.warn('单句识别失败', { streamId: stream.id, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      if (!text.trim()) continue;
      const wake = this.config.wakeEnabled ? matchWakeWord(text, this.config.wakeWords) : null;
      const item: AsrSegmentResult = {
        streamId: stream.id,
        index: stream.index++,
        text,
        language,
        durationMs: seg.durationMs,
        tookMs,
        wake,
      };
      out.push(item);
      this.emit('asr.segment', item);
      if (wake) {
        this.logger?.info('唤醒词命中', { word: wake, text });
        this.emit('asr.wake', { word: wake, text, streamId: stream.id });
      }
      if (this.config.autoChat && this.onUtterance) {
        try {
          this.onUtterance(text, wake);
        } catch (e) {
          this.logger?.warn('自动聊天回调失败', { error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    return out;
  }

  private cleanupStreams(): void {
    const now = Date.now();
    for (const [id, s] of this.streams) {
      if (now - s.lastAt > STREAM_IDLE_MS) {
        this.streams.delete(id);
        this.logger?.warn('监听流空闲超时已回收', { streamId: id, idleMs: now - s.lastAt });
      }
    }
  }
}

/** 供测试/文档用：VAD 模型信息 */
export const ASR_VAD_MODEL = VAD_MODEL;
