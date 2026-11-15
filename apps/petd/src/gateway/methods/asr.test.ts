/**
 * asr.* 方法测试：注册、参数校验、status/models/transcribe/listen 流程。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GatewayContext } from '@petd/protocol';
import { MethodRegistry } from '../registry.js';
import { DEFAULT_CONFIG } from '../../kernel/config.js';
import { AsrService } from '../../asr/service.js';
import type { AsrModels } from '../../asr/models.js';
import type { TranscribeOptions, TranscribeResult, WhisperEngine } from '../../asr/whisper.js';
import { pcmToWav } from '../../asr/whisper.js';
import { registerAsrMethods } from './asr.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-asr-methods-'));
}

function makePcm(ms: number, amp: number): Buffer {
  const n = (16000 * ms) / 1000;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = amp === 0 ? 0 : Math.sin((2 * Math.PI * 440 * i) / 16000) * amp;
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

class FakeModels {
  status() {
    return { dirs: ['/fake'], writeDir: '/fake', files: [] };
  }
  modelPath(id: string): string | null {
    return id === 'base' ? '/fake/ggml-base.bin' : null;
  }
  vadPath(): string | null {
    return '/fake/vad.bin';
  }
  async ensureModel(id: string): Promise<string> {
    return `/fake/ggml-${id}.bin`;
  }
  async ensureVad(): Promise<string> {
    return '/fake/vad.bin';
  }
}

class FakeEngine {
  text = '打开聊天记录';
  async transcribe(_audio: Buffer, _opts: TranscribeOptions = {}): Promise<TranscribeResult> {
    return { text: this.text, language: 'zh', durationMs: 500, tookMs: 3 };
  }
  resolveBinary(): string | null {
    return 'C:/fake/whisper-cli.exe';
  }
  status() {
    return { binary: { found: true, path: 'C:/fake/whisper-cli.exe' }, models: new FakeModels().status() };
  }
}

function setup() {
  const service = new AsrService({
    config: { ...DEFAULT_CONFIG.asr, enabled: true, model: 'base' },
    home: tmpDir(),
    models: new FakeModels() as unknown as AsrModels,
    engine: new FakeEngine() as unknown as WhisperEngine,
  });
  const reg = new MethodRegistry();
  registerAsrMethods(reg, { asr: service });
  return { reg, service };
}

const ctx = {
  sessionId: 'test-session',
  client: { name: 'test', version: '0.0.1' },
  signal: new AbortController().signal,
  startedAt: Date.now(),
} as unknown as GatewayContext;

async function call(reg: MethodRegistry, name: string, params: unknown): Promise<unknown> {
  const m = reg.get(name);
  assert.ok(m, `方法应该存在：${name}`);
  return m.handler(params, ctx);
}

test('注册 7 个 asr.* 方法，参数校验生效', () => {
  const { reg } = setup();
  assert.deepEqual(reg.names().sort(), [
    'asr.download',
    'asr.listen.feed',
    'asr.listen.start',
    'asr.listen.stop',
    'asr.models',
    'asr.status',
    'asr.transcribe',
  ]);
  assert.ok(reg.validate('asr.transcribe', {}), '缺 audioBase64 应校验失败');
  assert.ok(reg.validate('asr.transcribe', { audioBase64: 'short' }), '过短 audioBase64 应失败');
  assert.ok(reg.validate('asr.download', { model: 'huge' }), '未知模型应失败');
  assert.ok(reg.validate('asr.listen.feed', { streamId: '' }), '空 streamId 应失败');
  assert.equal(reg.validate('asr.status', {}), null);
});

test('asr.status / asr.models 返回就绪信息', async () => {
  const { reg } = setup();
  const status = (await call(reg, 'asr.status', {})) as { enabled: boolean; model: string };
  assert.equal(status.enabled, true);
  assert.equal(status.model, 'base');
  const models = (await call(reg, 'asr.models', {})) as { models: Array<{ id: string; ready: boolean }> };
  assert.equal(models.models.length, 3);
  assert.equal(models.models.find((m) => m.id === 'base')!.ready, true);
});

test('asr.transcribe 返回识别文本与唤醒标记', async () => {
  const { reg } = setup();
  const wav = pcmToWav(makePcm(300, 0.2), 16000);
  const r = (await call(reg, 'asr.transcribe', { audioBase64: wav.toString('base64') })) as {
    text: string;
    wake: string | null;
  };
  assert.equal(r.text, '打开聊天记录');
  assert.equal(r.wake, null);
});

test('asr.listen.start → feed → stop 流程', async () => {
  const { reg } = setup();
  const started = (await call(reg, 'asr.listen.start', {})) as { streamId: string; sampleRate: number };
  assert.ok(started.streamId);
  assert.equal(started.sampleRate, 16000);
  const speech = makePcm(400, 0.2);
  const silence = makePcm(800, 0);
  const fed = (await call(reg, 'asr.listen.feed', {
    streamId: started.streamId,
    pcmBase64: Buffer.concat([speech, silence]).toString('base64'),
  })) as { segments: Array<{ text: string }> };
  assert.equal(fed.segments.length, 1);
  assert.equal(fed.segments[0]!.text, '打开聊天记录');
  const stopped = (await call(reg, 'asr.listen.stop', { streamId: started.streamId })) as { segments: unknown[] };
  assert.equal(stopped.segments.length, 0);
  await assert.rejects(() => call(reg, 'asr.listen.stop', { streamId: started.streamId }), /监听流不存在/);
});
