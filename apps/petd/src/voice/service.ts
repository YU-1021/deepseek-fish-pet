/**
 * 语音服务：文本 → 音频（Edge 在线神经语音，失败回退 Windows SAPI），带内容寻址缓存。
 *
 * 对外只暴露 speak()/listVoices()/status()，供 gateway 的 voice.* 方法与 chat.send 的自动朗读使用。
 * 音频以 base64 塞进返回结果（一首短句约 20–80KB），UI 直接 data URL 播放，不必再回查文件。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import type { PetdConfig } from '../kernel/config.js';
import {
  createEdgeEngine,
  createSapiEngine,
  defaultSapiScript,
  sanitizeSpeechText,
  type SpeechEngine,
  type SynthOptions,
  type VoiceEngineName,
  type VoiceInfo,
} from './engine.js';

export type VoiceConfig = PetdConfig['voice'];

export interface VoiceLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

/** 一次朗读结果：UI 用 audioBase64 直接播放 */
export interface SpeechResult {
  id: string;
  file: string;
  mime: string;
  bytes: number;
  durationMs: number;
  cached: boolean;
  engine: VoiceEngineName;
  voice: string;
  rate: number;
  pitch: number;
  text: string;
  audioBase64: string;
  elapsedMs: number;
}

export interface VoiceStatus {
  enabled: boolean;
  engine: VoiceEngineName;
  voice: string;
  cacheDir: string;
  cacheFiles: number;
  cacheBytes: number;
}

export interface VoiceServiceOptions {
  config: VoiceConfig;
  home: string;
  logger?: VoiceLogger;
  publish?: (event: string, data: Record<string, unknown>) => void;
  /** 测试注入：覆盖真实引擎 */
  engines?: Partial<Record<VoiceEngineName, SpeechEngine>>;
}

export interface SpeakOptions {
  /** 覆盖默认音色 */
  voice?: string;
  /** 覆盖默认语速 */
  rate?: number;
  /** 覆盖默认音调（仅 edge） */
  pitch?: number;
}

export class VoiceService {
  private readonly config: VoiceConfig;
  private readonly home: string;
  private readonly logger?: VoiceLogger;
  private readonly publish?: (event: string, data: Record<string, unknown>) => void;
  private readonly cacheDir: string;
  private readonly injected: Partial<Record<VoiceEngineName, SpeechEngine>>;
  private readonly engines = new Map<VoiceEngineName, SpeechEngine>();

  constructor(opts: VoiceServiceOptions) {
    this.config = opts.config;
    this.home = opts.home;
    this.logger = opts.logger;
    this.publish = opts.publish;
    this.cacheDir = path.join(opts.home, 'voice-cache');
    this.injected = opts.engines ?? {};
  }

  status(): VoiceStatus {
    const files = this.cacheStat();
    return {
      enabled: this.config.enabled,
      engine: this.config.engine,
      voice: this.config.voice,
      cacheDir: this.cacheDir,
      cacheFiles: files.count,
      cacheBytes: files.bytes,
    };
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const all: VoiceInfo[] = [];
    for (const name of ['edge', 'sapi'] as const) {
      try {
        const engine = this.engine(name);
        const voices = await engine.listVoices();
        for (const v of voices) {
          if (!all.some((x) => x.engine === v.engine && x.id === v.id)) all.push(v);
        }
      } catch (error) {
        this.logger?.warn(`读取 ${name} 音色失败`, { error: String(error) });
      }
    }
    return all;
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<SpeechResult> {
    if (!this.config.enabled) throw new PetdError('E_UNAVAILABLE', '语音功能已关闭（config.voice.enabled=false）');
    const clean = sanitizeSpeechText(text);
    if (clean === '') throw new PetdError('E_BAD_PARAMS', '没有可朗读的文本');
    if (clean.length > this.config.maxChars) {
      throw new PetdError('E_BAD_PARAMS', `要朗读的文本太长（${clean.length} 字，上限 ${this.config.maxChars} 字）`);
    }
    const voice = opts.voice?.trim() || this.config.voice;
    const rate = clampRange(opts.rate ?? this.config.rate, 0.5, 2);
    const pitch = clampRange(opts.pitch ?? this.config.pitch, 0.5, 2);
    const synthOptions: SynthOptions = { voice, rate, pitch };
    const started = Date.now();
    const preferred = this.config.engine;
    let result;
    try {
      result = await this.engine(preferred).synthesize(clean, synthOptions);
    } catch (error) {
      if (preferred !== 'edge' || !this.config.fallbackToSapi || !this.hasEngine('sapi')) {
        throw error instanceof PetdError ? error : new PetdError('E_UNAVAILABLE', `语音合成失败：${messageOf(error)}`);
      }
      this.logger?.warn('Edge 合成失败，回退本地 SAPI', { error: messageOf(error) });
      try {
        result = await this.engine('sapi').synthesize(clean, { ...synthOptions, voice: '' });
      } catch (fallbackError) {
        throw new PetdError('E_UNAVAILABLE', `语音合成失败（Edge：${messageOf(error)}；SAPI：${messageOf(fallbackError)}）`);
      }
    }
    const audioBase64 = fs.readFileSync(result.file).toString('base64');
    const elapsedMs = Date.now() - started;
    const id = createHash('sha256').update(`${result.engine}|${voice}|${rate}|${pitch}|${clean}`).digest('hex').slice(0, 16);
    const speech: SpeechResult = {
      id,
      file: result.file,
      mime: result.mime,
      bytes: result.bytes,
      durationMs: result.durationMs,
      cached: result.cached,
      engine: result.engine,
      voice,
      rate,
      pitch,
      text: clean,
      audioBase64,
      elapsedMs,
    };
    this.publish?.('voice.speech', {
      id: speech.id,
      file: speech.file,
      mime: speech.mime,
      bytes: speech.bytes,
      durationMs: speech.durationMs,
      cached: speech.cached,
      engine: speech.engine,
      voice: speech.voice,
      text: speech.text,
    });
    this.logger?.info('语音合成完成', { engine: speech.engine, bytes: speech.bytes, cached: speech.cached, elapsedMs });
    return speech;
  }

  private hasEngine(name: VoiceEngineName): boolean {
    return name === 'sapi';
  }

  private engine(name: VoiceEngineName): SpeechEngine {
    const existing = this.engines.get(name);
    if (existing) return existing;
    const injected = this.injected[name];
    if (injected) {
      this.engines.set(name, injected);
      return injected;
    }
    const common = {
      cacheDir: this.cacheDir,
      ...(this.logger === undefined ? {} : { logger: this.logger }),
    };
    const created =
      name === 'edge' ? createEdgeEngine(common) : createSapiEngine({ ...common, scriptFile: defaultSapiScript() });
    this.engines.set(name, created);
    return created;
  }

  private cacheStat(): { count: number; bytes: number } {
    try {
      const entries = fs.readdirSync(this.cacheDir, { withFileTypes: true });
      let count = 0;
      let bytes = 0;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        try {
          count += 1;
          bytes += fs.statSync(path.join(this.cacheDir, entry.name)).size;
        } catch {
          /* ignore */
        }
      }
      return { count, bytes };
    } catch {
      return { count: 0, bytes: 0 };
    }
  }
}

function clampRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(min, value));
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
