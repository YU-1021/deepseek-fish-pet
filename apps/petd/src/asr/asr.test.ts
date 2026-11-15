/**
 * 语音识别测试：whisper 参数/JSON 解析/静音裁剪 + VAD 切句 + 唤醒词匹配 + AsrService 流程。
 * 全部用假引擎/假模型，不依赖本机 whisper-cli 与模型文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../kernel/config.js';
import type { AsrModels } from './models.js';
import type { TranscribeOptions, TranscribeResult, WhisperEngine } from './whisper.js';
import {
  buildWhisperArgs,
  normalizeChinese,
  parseWhisperJson,
  pcmToWav,
  trimSilence,
} from './whisper.js';
import { StreamingVad } from './vad.js';
import { AsrService, ASR_VAD_MODEL, matchWakeWord, normalizeWakeText, wakeSimilarity } from './service.js';

const SAMPLE_RATE = 16000;

/** 生成 PCM16 单声道：amp=0 是静音，否则 440Hz 正弦 */
function makePcm(ms: number, amp: number, sampleRate = SAMPLE_RATE): Buffer {
  const n = Math.round((sampleRate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = amp === 0 ? 0 : Math.sin((2 * Math.PI * 440 * i) / sampleRate) * amp;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
  }
  return buf;
}

function makeWav(pcm: Buffer): Buffer {
  return pcmToWav(pcm, SAMPLE_RATE);
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-asr-'));
}

class FakeModels {
  status() {
    return { dirs: ['/fake/asr'], writeDir: '/fake/asr', files: [], writeDirWritable: true };
  }
  modelPath(id: string): string | null {
    return id === 'base' ? '/fake/asr/ggml-base.bin' : null;
  }
  vadPath(): string | null {
    return '/fake/asr/ggml-silero-v6.2.0.bin';
  }
  async ensureModel(id: string): Promise<string> {
    return `/fake/asr/ggml-${id}.bin`;
  }
  async ensureVad(): Promise<string> {
    return '/fake/asr/ggml-silero-v6.2.0.bin';
  }
}

class FakeEngine {
  readonly calls: Array<{ audio: Buffer; opts: TranscribeOptions }> = [];
  text = '你好大肥鱼，今天天气不错';
  fail: Error | null = null;
  async transcribe(audio: Buffer, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
    if (this.fail) throw this.fail;
    this.calls.push({ audio, opts });
    return { text: this.text, language: 'zh', durationMs: 1000, tookMs: 7 };
  }
  resolveBinary(): string | null {
    return 'C:/fake/whisper-cli.exe';
  }
  status() {
    return { binary: { found: true, path: 'C:/fake/whisper-cli.exe' }, models: new FakeModels().status() };
  }
}

function makeService(opts: {
  engine?: FakeEngine;
  autoChat?: boolean;
  enabled?: boolean;
  utterances?: Array<{ text: string; wake: string | null }>;
  events?: Array<{ event: string; data: unknown }>;
} = {}): {
  service: AsrService;
  engine: FakeEngine;
  utterances: Array<{ text: string; wake: string | null }>;
  events: Array<{ event: string; data: unknown }>;
  home: string;
} {
  const home = tmpDir();
  const engine = opts.engine ?? new FakeEngine();
  const utterances = opts.utterances ?? [];
  const events = opts.events ?? [];
  const service = new AsrService({
    config: {
      ...DEFAULT_CONFIG.asr,
      enabled: opts.enabled ?? true,
      autoChat: opts.autoChat ?? false,
      model: 'base',
    },
    home,
    models: new FakeModels() as unknown as AsrModels,
    engine: engine as unknown as WhisperEngine,
    publish: (event, data) => events.push({ event, data }),
    onUtterance: (text, wake) => utterances.push({ text, wake }),
  });
  return { service, engine, utterances, events, home };
}

// ── whisper 纯函数 ──────────────────────────────────────────────────────────

test('buildWhisperArgs 生成正确参数（-ojf/-np、可选 prompt 与 VAD）', () => {
  const base = buildWhisperArgs({
    modelPath: '/m/ggml-base.bin',
    wavPath: '/t/a.wav',
    outBase: '/t/a',
    language: 'zh',
  });
  assert.deepEqual(base, ['-m', '/m/ggml-base.bin', '-f', '/t/a.wav', '-l', 'zh', '-ojf', '-of', '/t/a', '-np']);
  const full = buildWhisperArgs({
    modelPath: '/m/ggml-base.bin',
    wavPath: '/t/a.wav',
    outBase: '/t/a',
    language: 'zh',
    prompt: '你好大肥鱼。',
    vadPath: '/m/vad.bin',
    vadThreshold: 0.5,
  });
  assert.equal(full[full.indexOf('--prompt') + 1], '你好大肥鱼。');
  assert.equal(full[full.indexOf('--vad') + 1], '-vm');
  assert.equal(full[full.indexOf('-vm') + 1], '/m/vad.bin');
  assert.equal(full[full.indexOf('-vt') + 1], '0.5');
});

test('parseWhisperJson 清理时间戳与空音频标注', () => {
  const json = JSON.stringify({
    transcription: [{ text: '[00:00:00.000 --> 00:00:02.000]  你好大肥鱼 [BLANK_AUDIO]' }],
  });
  const r = parseWhisperJson(json);
  assert.equal(r.text, '你好大肥鱼');
  assert.equal(parseWhisperJson('not json').text, '');
});

test('pcmToWav 生成合法 16k 单声道 WAV 头', () => {
  const wav = makeWav(makePcm(200, 0.1));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(wav.readUInt32LE(40), 200 * 32);
  assert.equal(wav.length, 44 + 200 * 32);
});

test('trimSilence 裁掉首尾静音并同步 RIFF 长度', () => {
  const pcm = Buffer.concat([makePcm(1000, 0), makePcm(600, 0.2), makePcm(1000, 0)]);
  const wav = makeWav(pcm);
  const trimmed = trimSilence(wav);
  assert.ok(trimmed.length < wav.length);
  assert.equal(trimmed.readUInt32LE(4), trimmed.length - 8);
  assert.equal(trimmed.readUInt32LE(40), trimmed.length - 44);
});

test('normalizeChinese 繁转简；非中文原样', () => {
  assert.equal(normalizeChinese('你好大肥魚，今天天氣不錯', 'zh'), '你好大肥鱼，今天天气不错');
  assert.equal(normalizeChinese('hello world', 'en'), 'hello world');
});

// ── 唤醒词 ────────────────────────────────────────────────────────────────

test('normalizeWakeText 去掉标点空白并小写', () => {
  assert.equal(normalizeWakeText('你好，大肥鱼！ Hello'), '你好大肥鱼hello');
});

test('matchWakeWord 支持直接包含与近似发音', () => {
  assert.equal(matchWakeWord('你好大肥鱼，帮我看下时间', ['你好大肥鱼']), '你好大肥鱼');
  assert.equal(matchWakeWord('大飞鱼你在吗', ['你好大肥鱼', '大肥鱼']), '大肥鱼');
  assert.equal(matchWakeWord('今天天气不错', ['你好大肥鱼']), null);
});

test('wakeSimilarity 对单字错听仍高', () => {
  assert.ok(wakeSimilarity('大肥鱼', '大飞鱼') >= 0.66);
  assert.ok(wakeSimilarity('大肥鱼', '明天见') < 0.66);
});

// ── VAD ──────────────────────────────────────────────────────────────────

test('StreamingVad 把一段说话切成一段，丢弃纯静音', () => {
  const vad = new StreamingVad({
    sampleRate: SAMPLE_RATE,
    energyThreshold: DEFAULT_CONFIG.asr.energyThreshold,
    minSpeechMs: DEFAULT_CONFIG.asr.minSpeechMs,
    silenceMs: DEFAULT_CONFIG.asr.silenceMs,
    maxSegmentMs: DEFAULT_CONFIG.asr.maxSegmentMs,
  });
  const chunks: Buffer[] = [];
  for (let i = 0; i < 10; i++) chunks.push(makePcm(20, 0)); // 200ms 静音
  for (let i = 0; i < 25; i++) chunks.push(makePcm(20, 0.2)); // 500ms 说话
  for (let i = 0; i < 40; i++) chunks.push(makePcm(20, 0)); // 800ms 静音 → 触发切段
  const out: Array<{ durationMs: number }> = [];
  for (const c of chunks) out.push(...vad.push(c).map((s) => ({ durationMs: s.durationMs })));
  assert.equal(out.length, 1);
  assert.ok(out[0]!.durationMs >= 600, `durationMs=${out[0]!.durationMs}`);
  assert.ok(out[0]!.durationMs <= 1400, `durationMs=${out[0]!.durationMs}`);
  // 再喂一段短促噪声不应成段
  assert.equal(vad.push(makePcm(100, 0.2)).length + vad.push(makePcm(500, 0)).length, 0);
});

// ── AsrService ────────────────────────────────────────────────────────────

test('AsrService.status/models 报告就绪状态', () => {
  const { service } = makeService();
  const st = service.status();
  assert.equal(st.enabled, true);
  assert.equal(st.engine, 'whisper.cpp');
  assert.equal(st.binary.found, true);
  assert.equal(st.model, 'base');
  const models = service.modelList();
  assert.equal(models.length, 3);
  assert.equal(models.find((m) => m.id === 'base')!.ready, true);
  assert.equal(models.find((m) => m.id === 'tiny')!.ready, false);
});

test('asr 关闭时 transcribe/listen 都报 E_UNAVAILABLE', async () => {
  const { service } = makeService({ enabled: false });
  await assert.rejects(() => service.transcribe({ audioBase64: makeWav(makePcm(100, 0.2)).toString('base64') }), /E_UNAVAILABLE|语音识别已关闭/);
  assert.throws(() => service.listenStart(), /语音识别已关闭/);
});

test('AsrService.transcribe 返回文本与唤醒命中', async () => {
  const { service, engine } = makeService();
  const wav = makeWav(makePcm(500, 0.2));
  const r = await service.transcribe({ audioBase64: wav.toString('base64') });
  assert.equal(r.text, '你好大肥鱼，今天天气不错');
  assert.equal(r.wake, '你好大肥鱼');
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0]!.opts.prompt, DEFAULT_CONFIG.asr.prompt);
});

test('流式监听：VAD 切句 → 识别 → 事件 + autoChat 回调', async () => {
  const events: Array<{ event: string; data: unknown }> = [];
  const { service, utterances } = makeService({ autoChat: true, events });
  const start = service.listenStart();
  assert.ok(start.streamId);
  assert.equal(start.sampleRate, SAMPLE_RATE);
  const chunks: Buffer[] = [];
  for (let i = 0; i < 5; i++) chunks.push(makePcm(20, 0));
  for (let i = 0; i < 20; i++) chunks.push(makePcm(20, 0.2));
  for (let i = 0; i < 40; i++) chunks.push(makePcm(20, 0));
  let segments: Array<{ text: string; wake: string | null }> = [];
  for (const c of chunks) {
    const r = await service.listenFeed(start.streamId, c.toString('base64'));
    segments = segments.concat(r.map((s) => ({ text: s.text, wake: s.wake })));
  }
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.text, '你好大肥鱼，今天天气不错');
  assert.equal(segments[0]!.wake, '你好大肥鱼');
  assert.ok(events.some((e) => e.event === 'asr.segment'));
  assert.ok(events.some((e) => e.event === 'asr.wake'));
  assert.equal(utterances.length, 1);
  assert.equal(utterances[0]!.wake, '你好大肥鱼');
  const stopped = await service.listenStop(start.streamId);
  assert.equal(stopped.length, 0);
  await assert.rejects(() => service.listenStop(start.streamId), /监听流不存在/);
});

test('ASR_VAD_MODEL 暴露 VAD 模型信息', () => {
  assert.equal(ASR_VAD_MODEL.file, 'ggml-silero-v6.2.0.bin');
});
