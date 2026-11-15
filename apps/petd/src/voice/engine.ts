/**
 * 语音合成引擎：Edge 神经语音（在线，音质好） + Windows SAPI（离线兜底）。
 *
 * 形状参考旧桌宠 app/src/tts.js 的 Edge 实现（WS 协议、按句切分、内容寻址缓存、原子落盘），
 * 这里重写成 petd 的 TypeScript 模块，并补了一个 SAPI 引擎在网络不可用时兜底。
 * 合成结果按 sha256(引擎|音色|语速|音调|文本) 缓存到 <home>/voice-cache，重复句子不再联网。
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { PetdError } from '@petd/protocol';

const execFileAsync = promisify(execFile);

/** Edge 语音服务常量 */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
/**
 * 2026-10 起微软收紧了旧端点（speech.platform.bing.com）的 Sec-MS-GEC 校验，
 * 旧签名的握手会直接 403；Edge 朗读已迁到 api.msedgeservices.com，
 * 鉴权改为「Ocp-Apim-Subscription-Key + Sec-MS-GEC v2」。
 */
const WSS_BASE = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
const GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const CRLF = '\r\n';
const MAX_SEG = 180;
const EDGE_TIMEOUT_MS = 45_000;
/** Edge 返回的固定码率（audio-24khz-48kbitrate-mono-mp3），用来估算时长 */
const EDGE_BYTES_PER_SECOND = 48_000 / 8;

export interface VoiceInfo {
  id: string;
  label: string;
  lang: string;
  engine: VoiceEngineName;
}

export type VoiceEngineName = 'edge' | 'sapi';

/** 预置音色表（Edge） */
export const EDGE_VOICES: VoiceInfo[] = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔女声（推荐）', lang: 'zh-CN', engine: 'edge' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼女声', lang: 'zh-CN', engine: 'edge' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 阳光男声', lang: 'zh-CN', engine: 'edge' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 沉稳男声', lang: 'zh-CN', engine: 'edge' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北女声', lang: 'zh-CN', engine: 'edge' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾女声', lang: 'zh-TW', engine: 'edge' },
  { id: 'en-US-AriaNeural', label: 'Aria · 英文温柔女声', lang: 'en-US', engine: 'edge' },
  { id: 'en-US-GuyNeural', label: 'Guy · 英文男声', lang: 'en-US', engine: 'edge' },
  { id: 'ja-JP-NanamiNeural', label: '七海 · 日语女声', lang: 'ja-JP', engine: 'edge' },
];

export const DEFAULT_VOICE_ID = 'zh-CN-XiaoxiaoNeural';

export interface VoiceEngineOptions {
  /** 缓存目录 */
  cacheDir: string;
  /** 日志（可选） */
  logger?: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
  };
}

export interface SynthOptions {
  voice: string;
  /** 1.0 为正常语速 */
  rate: number;
  /** 1.0 为正常音调（仅 Edge 生效） */
  pitch: number;
}

export interface SynthResult {
  /** 缓存文件绝对路径 */
  file: string;
  mime: 'audio/mpeg' | 'audio/wav';
  bytes: number;
  /** 估算时长（毫秒） */
  durationMs: number;
  cached: boolean;
  engine: VoiceEngineName;
}

export interface SpeechEngine {
  readonly name: VoiceEngineName;
  synthesize(text: string, opts: SynthOptions): Promise<SynthResult>;
  listVoices(): Promise<VoiceInfo[]>;
}

/** 把长文本切成适合单次合成的句子（按标点 + 硬切 + 合并），上限 12 段 */
export function splitSentences(text: string): string[] {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t === '') return [];
  const parts = t.match(/[^.!?;:。！？；：]+[.!?;:。！？；：]*/g) ?? [t];
  const hard: string[] = [];
  for (const part of parts) {
    let s = part;
    while (s.length > MAX_SEG) {
      let cut = Math.max(s.lastIndexOf(' ', MAX_SEG), s.lastIndexOf('，', MAX_SEG), s.lastIndexOf('、', MAX_SEG));
      if (cut < MAX_SEG * 0.5) cut = MAX_SEG;
      hard.push(s.slice(0, cut));
      s = s.slice(cut);
    }
    if (s.trim() !== '') hard.push(s);
  }
  const out: string[] = [];
  let cur = '';
  for (const p of hard) {
    if ((cur + p).length > MAX_SEG && cur !== '') {
      out.push(cur.trim());
      cur = p;
    } else {
      cur += p;
    }
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out.filter((s) => s !== '').slice(0, 12);
}

/** 去掉气泡脚本标记等不该朗读的内容 */
export function sanitizeSpeechText(text: string): string {
  return String(text ?? '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cacheKey(engine: VoiceEngineName, voice: string, rate: number, pitch: number, text: string): string {
  return createHash('sha256')
    .update(`${engine}|${voice}|${rate.toFixed(3)}|${pitch.toFixed(3)}|${text}`, 'utf8')
    .digest('hex');
}

function writeAtomic(file: string, data: Buffer): void {
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/** Edge 在线神经语音 */
export class EdgeEngine implements SpeechEngine {
  readonly name: VoiceEngineName = 'edge';
  private readonly cacheDir: string;
  private readonly logger?: VoiceEngineOptions['logger'];

  constructor(opts: VoiceEngineOptions) {
    this.cacheDir = opts.cacheDir;
    this.logger = opts.logger;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return EDGE_VOICES;
  }

  async synthesize(text: string, opts: SynthOptions): Promise<SynthResult> {
    const voice = EDGE_VOICES.some((v) => v.id === opts.voice) ? opts.voice : DEFAULT_VOICE_ID;
    const key = cacheKey(this.name, voice, opts.rate, opts.pitch, text);
    const file = path.join(this.cacheDir, `edge-${key}.mp3`);
    if (this.isUsable(file)) {
      const bytes = fs.statSync(file).size;
      return { file, mime: 'audio/mpeg', bytes, durationMs: Math.round((bytes / EDGE_BYTES_PER_SECOND) * 1000), cached: true, engine: this.name };
    }
    const segments = splitSentences(text);
    if (segments.length === 0) throw new PetdError('E_BAD_PARAMS', '没有可朗读的文本');
    const chunks: Buffer[] = [];
    for (const [index, segment] of segments.entries()) {
      const buf = await this.synthesizeSegment(voice, segment, opts.rate, opts.pitch, index);
      chunks.push(buf);
    }
    const data = Buffer.concat(chunks);
    if (data.length < 100) throw new PetdError('E_UNAVAILABLE', `语音合成结果异常（${data.length} 字节）`);
    writeAtomic(file, data);
    return { file, mime: 'audio/mpeg', bytes: data.length, durationMs: Math.round((data.length / EDGE_BYTES_PER_SECOND) * 1000), cached: false, engine: this.name };
  }

  private isUsable(file: string): boolean {
    try {
      return fs.statSync(file).size > 100;
    } catch {
      return false;
    }
  }

  private synthesizeSegment(voice: string, text: string, rate: number, pitch: number, index: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const params = new URLSearchParams({
        ConnectionId: randomBytes(16).toString('hex'),
        'Ocp-Apim-Subscription-Key': TRUSTED_CLIENT_TOKEN,
        'Sec-MS-GEC': generateSecMsGec(),
        'Sec-MS-GEC-Version': GEC_VERSION,
      });
      const url = `${WSS_BASE}?${params.toString()}`;
      const major = CHROMIUM_FULL_VERSION.split('.')[0];
      const ws = new WebSocket(url, {
        headers: {
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
          Cookie: `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
        },
      });
      const chunks: Buffer[] = [];
      let settled = false;
      let sawEnd = false;
      const timer = setTimeout(() => finish(new Error('TTS 超时')), EDGE_TIMEOUT_MS);

      const finish = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (error) {
          reject(error);
          return;
        }
        const data = Buffer.concat(chunks);
        if (data.length < 20) {
          reject(new Error('音频过短'));
          return;
        }
        resolve(data);
      };

      ws.on('open', () => {
        const requestId = randomBytes(16).toString('hex');
        const speechConfig = {
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        };
        const lang = voice.split('-').slice(0, 2).join('-');
        const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">`
          + `<voice name="${escapeXml(voice)}"><prosody rate="${toPercent(rate)}" pitch="${toPercent(pitch)}" volume="default">`
          + `${escapeXml(text)}</prosody></voice></speak>`;
        ws.send(`Content-Type:application/json; charset=utf-8${CRLF}Path:speech.config${CRLF}${CRLF}${JSON.stringify(speechConfig)}`);
        ws.send(`X-RequestId:${requestId}${CRLF}Content-Type:application/ssml+xml${CRLF}Path:ssml${CRLF}${CRLF}${ssml}`);
      });

      ws.on('message', (data: Buffer | string, isBinary: boolean) => {
        if (settled) return;
        if (!isBinary) {
          if (String(data).includes('Path:turn.end')) {
            sawEnd = true;
            finish(null);
          }
          return;
        }
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
        // Edge 二进制帧：前 2 字节（大端）是头部长度，之后是头部文本，再之后是音频体
        if (raw.length >= 2) {
          const headerLen = raw.readUInt16BE(0);
          if (headerLen > 0 && headerLen + 2 <= raw.length) {
            const headerText = raw.subarray(2, 2 + headerLen).toString('latin1');
            if (headerText.includes('Path:audio')) {
              const body = raw.subarray(2 + headerLen);
              if (body.length > 0) chunks.push(body);
            }
            return;
          }
        }
        // 兜底：没有头长度字段的旧格式（按 Path:audio 标记找音频体）
        const marker = Buffer.from(`Path:audio${CRLF}`);
        const idx = raw.indexOf(marker);
        if (idx >= 0) {
          const body = raw.subarray(idx + marker.length);
          if (body.length > 0) chunks.push(body);
        } else if (raw.length > 0) {
          chunks.push(raw);
        }
      });

      ws.on('error', (error: Error) => finish(error instanceof Error ? error : new Error(String(error))));
      ws.on('close', (code: number) => {
        if (settled) return;
        if (sawEnd && chunks.length > 0) finish(null);
        else finish(new Error(`连接中断（${code}）第 ${index + 1} 段`));
      });
    });
  }
}

/** Windows SAPI 离线语音（System.Speech，走 PowerShell） */
export class SapiEngine implements SpeechEngine {
  readonly name: VoiceEngineName = 'sapi';
  private readonly cacheDir: string;
  private readonly scriptFile: string;
  private readonly logger?: VoiceEngineOptions['logger'];

  constructor(opts: VoiceEngineOptions & { scriptFile: string }) {
    this.cacheDir = opts.cacheDir;
    this.scriptFile = opts.scriptFile;
    this.logger = opts.logger;
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  async listVoices(): Promise<VoiceInfo[]> {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptFile, '-ListVoices'],
        { timeout: 20_000, windowsHide: true }
      );
      const voices = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => {
          const [name, culture] = line.split('|');
          return {
            id: (name ?? '').trim(),
            label: `${(name ?? '').trim()} · ${(culture ?? '').trim()}`,
            lang: (culture ?? '').trim(),
            engine: this.name,
          } satisfies VoiceInfo;
        })
        .filter((v) => v.id !== '');
      if (voices.length === 0) return this.fallbackVoices();
      return voices;
    } catch (error) {
      this.logger?.warn('读取 SAPI 音色失败', { error: String(error) });
      return this.fallbackVoices();
    }
  }

  async synthesize(text: string, opts: SynthOptions): Promise<SynthResult> {
    const key = cacheKey(this.name, opts.voice, opts.rate, opts.pitch, text);
    const file = path.join(this.cacheDir, `sapi-${key}.wav`);
    if (this.isUsable(file)) {
      const bytes = fs.statSync(file).size;
      return { file, mime: 'audio/wav', bytes, durationMs: wavDurationMs(fs.readFileSync(file)), cached: true, engine: this.name };
    }
    const textFile = path.join(this.cacheDir, `sapi-${key}.txt`);
    const sapiRate = Math.max(-10, Math.min(10, Math.round((opts.rate - 1) * 10)));
    fs.writeFileSync(textFile, text, 'utf8');
    try {
      await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptFile, '-OutFile', file, '-TextFile', textFile, '-Voice', opts.voice, '-Rate', String(sapiRate)],
        { timeout: 60_000, windowsHide: true }
      );
    } finally {
      try {
        fs.unlinkSync(textFile);
      } catch {
        /* ignore */
      }
    }
    if (!this.isUsable(file)) throw new PetdError('E_UNAVAILABLE', 'SAPI 合成结果为空');
    const bytes = fs.statSync(file).size;
    const durationMs = wavDurationMs(fs.readFileSync(file));
    return { file, mime: 'audio/wav', bytes, durationMs, cached: false, engine: this.name };
  }

  private isUsable(file: string): boolean {
    try {
      return fs.statSync(file).size > 44;
    } catch {
      return false;
    }
  }

  private fallbackVoices(): VoiceInfo[] {
    return [
      { id: 'Microsoft Huihui Desktop', label: 'Microsoft Huihui Desktop · zh-CN', lang: 'zh-CN', engine: 'sapi' },
      { id: 'Microsoft Zira Desktop', label: 'Microsoft Zira Desktop · en-US', lang: 'en-US', engine: 'sapi' },
    ];
  }
}

function escapeXml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toPercent(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '+0%';
  const pct = Math.round((n - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

/** Sec-MS-GEC v2 的固定前缀（57 字节 ASCII） */
const GEC_PREFIX = Buffer.from('Copyright (C) Microsoft Corporation. All rights reserved.', 'ascii');

const rol16 = (x: number): number => ((x << 16) | (x >>> 16)) >>> 0;

/** 把字节按小端 32 位拆成字，并补零到 8 字节的倍数 */
function toLeWords(bytes: Buffer): number[] {
  const padded = Buffer.alloc(Math.ceil(bytes.length / 8) * 8);
  bytes.copy(padded);
  const words: number[] = [];
  for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i));
  return words;
}

/** CS64 双链之一：按字对做可交换混合 */
function cs64WordSwap(words: number[], a: number, b: number): [number, number] {
  let acc = 0;
  let last = 0;
  for (let i = 0; i < words.length; i += 2) {
    const x = words[i]!;
    const y = words[i + 1]!;
    let t = rol16((Math.imul(rol16(x), 0xef0569fb) + Math.imul(x, a)) >>> 0);
    let q = Math.imul(t, 0x76f50f34) >>> 0;
    acc = (acc + Math.imul(rol16(q), 0xc3efea97) + q) >>> 0;
    t = rol16((Math.imul(rol16(y), 0xc31713db) + Math.imul(y, b)) >>> 0);
    q = Math.imul(t, 0x1881ce3c) >>> 0;
    last = (Math.imul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    acc = (acc + last) >>> 0;
  }
  return [last, acc];
}

/** CS64 双链之二：可逆混合（与上面的结果异或后作为令牌前半） */
function cs64Reversible(words: number[], a: number, b: number): [number, number] {
  let state = 0;
  let acc = 0;
  for (let i = 0; i < words.length; i += 2) {
    state = Math.imul(state + words[i]!, a) >>> 0;
    for (const c of [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83]) {
      state = Math.imul(rol16(state), c) >>> 0;
    }
    let t = Math.imul(words[i + 1]! + state, b) >>> 0;
    t = Math.imul(rol16(t), 0xa27416f5) >>> 0;
    t = rol16(Math.imul(rol16(t), 0xd38396ff) >>> 0);
    acc = (acc + state) >>> 0;
    state = Math.imul(rol16(Math.imul(t, 0x7c932b89) >>> 0), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  return [state, acc];
}

/**
 * 生成 Sec-MS-GEC v2 令牌：`<CS64 8 字节大写hex>-<SHA256 大写hex>`。
 * 时间窗口 5 分钟；输入 = 固定版权前缀 + Windows file time ticks + 客户端令牌。
 */
export function generateSecMsGec(now: number = Date.now()): string {
  let ticks = Math.floor(now / 1000) + 11644473600; // 1601 纪元偏移
  ticks -= ticks % 300; // 5 分钟取整
  ticks *= 10000000; // 100ns 单位
  const suffix = Buffer.from(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii');
  const data = Buffer.concat([GEC_PREFIX, suffix]);
  const digest = createHash('sha256').update(data).digest();
  const words = toLeWords(data);
  const a = (digest.readUInt32LE(0) | 1) >>> 0;
  const b = (digest.readUInt32LE(4) | 1) >>> 0;
  const [s0, s1] = cs64WordSwap(words, a, b);
  const [r0, r1] = cs64Reversible(words, a, b);
  const cs = Buffer.alloc(8);
  cs.writeUInt32LE((s0 ^ r0) >>> 0, 0);
  cs.writeUInt32LE((s1 ^ r1) >>> 0, 4);
  return `${cs.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}

/** 解析 WAV 文件时长（毫秒）：扫描 RIFF 块找 fmt 的 byteRate 与 data 大小 */
export function wavDurationMs(data: Buffer): number {
  try {
    if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return 0;
    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= data.length) {
      const id = data.toString('ascii', offset, offset + 4);
      const size = data.readUInt32LE(offset + 4);
      if (id === 'fmt ') {
        byteRate = data.readUInt32LE(offset + 16);
      } else if (id === 'data') {
        dataSize = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    if (byteRate === 0 || dataSize === 0) return 0;
    return Math.round((dataSize / byteRate) * 1000);
  } catch {
    return 0;
  }
}

/** 按配置创建语音引擎（edge 失败时由 VoiceService 回退 sapi） */
export function createEdgeEngine(opts: VoiceEngineOptions): SpeechEngine {
  return new EdgeEngine(opts);
}

export function createSapiEngine(opts: VoiceEngineOptions & { scriptFile: string }): SpeechEngine {
  return new SapiEngine(opts);
}

/** 默认 SAPI 脚本位置（apps/petd/scripts/sapi-tts.ps1） */
export function defaultSapiScript(): string {
  // 注意：不能用 new URL(...).pathname——它会把中文路径百分号编码（%E5...），PowerShell 找不到脚本
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'sapi-tts.ps1');
}
