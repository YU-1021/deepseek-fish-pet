/**
 * whisper.cpp 模型管理：模型目录探测 + 镜像下载。
 *
 * 形状参考旧桌宠 `app/src/asr.js`（whisper-cli + ggml 模型缓存），按 petd 的
 * 类型/错误约定重写：模型放 home/asr（或配置指定），旧版 %APPDATA%/dayu-pet/asr
 * 里的模型直接复用，不重复下载。
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

export type WhisperModelId = 'tiny' | 'base' | 'small';

export interface WhisperModelDef {
  id: WhisperModelId;
  file: string;
  size: number;
  label: string;
}

export const WHISPER_MODELS: Record<WhisperModelId, WhisperModelDef> = {
  tiny: { id: 'tiny', file: 'ggml-tiny.bin', size: 77_704_715, label: 'Tiny（最快，约 78MB，识别率一般）' },
  base: { id: 'base', file: 'ggml-base.bin', size: 147_964_211, label: 'Base（速度快，约 148MB，中文可用）' },
  small: { id: 'small', file: 'ggml-small.bin', size: 487_601_967, label: 'Small（更准，约 466MB，中文更好）' },
};

export interface VadModelDef {
  file: string;
  size: number;
  label: string;
}

export const VAD_MODEL: VadModelDef = { file: 'ggml-silero-v6.2.0.bin', size: 885_098, label: 'Silero VAD（约 0.9MB，过滤静音、减少幻觉）' };

/** 国内镜像优先（hf-mirror 实测可达）；直连 huggingface 作为后备。 */
const WHISPER_MIRRORS = [
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/',
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/',
];
const VAD_MIRRORS = [
  'https://hf-mirror.com/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
  'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
];

export interface DownloadProgress {
  model: string;
  got: number;
  total: number;
  url?: string;
}

export interface AsrModelsOptions {
  home: string;
  /** 配置里的 asr.modelDir（空 = 自动） */
  modelDir?: string;
  logger?: { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void };
}

interface MinimalLogger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
}

/** 旧版桌宠的模型目录（复用已下载的模型） */
function legacyDirs(): string[] {
  const out: string[] = [];
  const appData = process.env['APPDATA'];
  if (appData && appData.trim()) out.push(path.join(appData.trim(), 'dayu-pet', 'asr'));
  out.push(path.join(os.homedir(), 'AppData', 'Roaming', 'dayu-pet', 'asr'));
  return out;
}

function isFileBigEnough(file: string, minSize: number): boolean {
  try {
    return fs.statSync(file).size >= minSize;
  } catch {
    return false;
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** 下载单个 URL 到 dest（先写 .part 再改名）；跟随重定向、有超时与大小校验 */
function downloadOne(url: string, dest: string, expectedSize: number, onProgress?: (p: DownloadProgress) => void, modelName = ''): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const part = dest + '.part';
    let settled = false;
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      if (err) {
        try {
          fs.unlinkSync(part);
        } catch {
          /* ignore */
        }
        reject(err);
      } else {
        resolve();
      }
    };
    const get = (target: string, depth: number): void => {
      if (depth > 5) {
        finish(new Error('重定向次数过多'));
        return;
      }
      const mod = target.startsWith('https:') ? https : http;
      const req = mod.get(
        target,
        { headers: { 'User-Agent': 'petd-asr', Accept: '*/*' } },
        (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            get(new URL(res.headers.location, target).href, depth + 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            finish(new Error(`HTTP ${String(res.statusCode)}`));
            return;
          }
          const total = Number(res.headers['content-length'] ?? 0) || expectedSize;
          let got = 0;
          const out = fs.createWriteStream(part);
          const fail = (e: Error): void => {
            try {
              out.destroy();
            } catch {
              /* ignore */
            }
            finish(e);
          };
          res.on('error', fail);
          res.on('aborted', () => fail(new Error('下载连接被中断')));
          req.on('error', fail);
          res.on('data', (chunk: Buffer) => {
            got += chunk.length;
            try {
              onProgress?.({ model: modelName, got, total, url: target });
            } catch {
              /* ignore */
            }
          });
          res.pipe(out);
          out.on('finish', () => {
            out.close(() => {
              const size = fileSize(part);
              // 模型完整性下限：至少一半预期大小（防止半截文件被当成模型）
              const minOk = Math.max(1024 * 1024, Math.floor(expectedSize * 0.5));
              if (size < minOk) {
                finish(new Error(`下载文件过小（${String(size)} 字节）`));
                return;
              }
              try {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.rmSync(dest, { force: true });
                fs.renameSync(part, dest);
                finish(null);
              } catch (e) {
                finish(e instanceof Error ? e : new Error(String(e)));
              }
            });
          });
          out.on('error', fail);
        },
      );
      req.on('error', (e) => finish(e));
      req.setTimeout(30_000, () => req.destroy(new Error('下载超时')));
    };
    get(url, 0);
  });
}

async function downloadFromMirrors(urls: string[], dest: string, expectedSize: number, modelName: string, onProgress?: (p: DownloadProgress) => void, logger?: MinimalLogger): Promise<void> {
  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      await downloadOne(url, dest, expectedSize, onProgress, modelName);
      return;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      logger?.warn('模型下载失败，换下一个镜像', { url, error: lastError.message });
    }
  }
  throw lastError ?? new Error('全部镜像都下载失败');
}

export class AsrModels {
  /** 下载/写入目录（home/asr 或配置指定） */
  readonly writeDir: string;
  private readonly readDirs: string[];
  private readonly logger: MinimalLogger | undefined;

  constructor(opts: AsrModelsOptions) {
    const configured = opts.modelDir?.trim();
    this.writeDir = configured ? path.resolve(configured) : path.join(opts.home, 'asr');
    this.readDirs = [this.writeDir, ...legacyDirs()];
    this.logger = opts.logger;
  }

  /** 读取顺序：配置目录 → home/asr → 旧版 dayu-pet/asr（去重） */
  private dirs(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const d of this.readDirs) {
      const key = d.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
    return out;
  }

  find(file: string): string | null {
    for (const dir of this.dirs()) {
      const full = path.join(dir, file);
      if (fs.existsSync(full)) return full;
    }
    return null;
  }

  findReady(file: string, minSize: number): string | null {
    for (const dir of this.dirs()) {
      const full = path.join(dir, file);
      if (isFileBigEnough(full, minSize)) return full;
    }
    return null;
  }

  modelPath(id: WhisperModelId): string | null {
    return this.findReady(WHISPER_MODELS[id].file, 10 * 1024 * 1024);
  }

  vadPath(): string | null {
    return this.findReady(VAD_MODEL.file, 300 * 1024);
  }

  status(): {
    dir: string;
    models: Array<{ id: WhisperModelId; file: string; size: number; label: string; ready: boolean; path: string | null }>;
    vad: { file: string; size: number; label: string; ready: boolean; path: string | null };
  } {
    return {
      dir: this.writeDir,
      models: (Object.keys(WHISPER_MODELS) as WhisperModelId[]).map((id) => {
        const def = WHISPER_MODELS[id];
        const file = this.modelPath(id);
        return { id, file: def.file, size: def.size, label: def.label, ready: file !== null, path: file };
      }),
      vad: {
        file: VAD_MODEL.file,
        size: VAD_MODEL.size,
        label: VAD_MODEL.label,
        ready: this.vadPath() !== null,
        path: this.vadPath(),
      },
    };
  }

  /** 确保模型可用；缺了就按镜像顺序下载 */
  async ensureModel(id: WhisperModelId, onProgress?: (p: DownloadProgress) => void): Promise<string> {
    const existing = this.modelPath(id);
    if (existing) return existing;
    const def = WHISPER_MODELS[id];
    const dest = path.join(this.writeDir, def.file);
    this.logger?.info('开始下载语音模型', { model: id, size: def.size });
    await downloadFromMirrors(
      WHISPER_MIRRORS.map((base) => base + def.file),
      dest,
      def.size,
      id,
      onProgress,
      this.logger,
    );
    this.logger?.info('语音模型下载完成', { model: id, path: dest });
    return dest;
  }

  /** 确保 silero VAD 模型可用（可选能力；失败不阻塞主流程） */
  async ensureVad(onProgress?: (p: DownloadProgress) => void): Promise<string> {
    const existing = this.vadPath();
    if (existing) return existing;
    const dest = path.join(this.writeDir, VAD_MODEL.file);
    await downloadFromMirrors(VAD_MIRRORS, dest, VAD_MODEL.size, 'vad', onProgress, this.logger);
    return dest;
  }
}
