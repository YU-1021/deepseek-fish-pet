/**
 * voice.* 方法测试：注册、参数校验、status/voices/speak。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GatewayContext } from '@petd/protocol';
import { MethodRegistry } from '../registry.js';
import { DEFAULT_CONFIG } from '../../kernel/config.js';
import { VoiceService } from '../../voice/service.js';
import type { SpeechEngine, SynthResult, VoiceInfo } from '../../voice/engine.js';
import { registerVoiceMethods } from './voice.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-voice-methods-'));
}

class FakeSapi implements SpeechEngine {
  readonly name = 'sapi' as const;
  async synthesize(text: string): Promise<SynthResult> {
    const file = path.join(tmpDir(), 'x.wav');
    const data = Buffer.from('RIFF____WAVEfmt ' + text);
    fs.writeFileSync(file, data);
    return { file, mime: 'audio/wav', bytes: data.length, durationMs: 900, cached: false, engine: 'sapi' };
  }
  async listVoices(): Promise<VoiceInfo[]> {
    return [{ id: 'Huihui', label: 'Microsoft Huihui Desktop', lang: 'zh-CN', engine: 'sapi' }];
  }
}

function setup() {
  const service = new VoiceService({
    config: { ...DEFAULT_CONFIG.voice, engine: 'sapi' },
    home: tmpDir(),
    engines: { sapi: new FakeSapi() },
  });
  const reg = new MethodRegistry();
  registerVoiceMethods(reg, { voice: service });
  return { reg };
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

test('注册 voice.status / voice.voices / voice.speak，参数校验生效', () => {
  const { reg } = setup();
  assert.deepEqual(reg.names().sort(), ['voice.speak', 'voice.status', 'voice.voices']);
  assert.ok(reg.validate('voice.speak', { text: '' }), '空文本应校验失败');
  assert.ok(reg.validate('voice.speak', { text: '你好', rate: 9 }), 'rate 超范围应失败');
  assert.equal(reg.validate('voice.speak', { text: '你好' }), null);
  assert.equal(reg.scopeOf('voice.speak'), 'write');
});

test('voice.status 与 voice.voices 返回结构', async () => {
  const { reg } = setup();
  const status = (await call(reg, 'voice.status', {})) as { enabled: boolean; engine: string; voice: string };
  assert.equal(status.enabled, true);
  assert.equal(status.engine, 'sapi');
  assert.ok(status.voice.length > 0);

  const voices = (await call(reg, 'voice.voices', {})) as { voices: VoiceInfo[] };
  // Edge 音色表是内置的（不联网），SAPI 用注入的假引擎；至少包含本机 Huihui
  assert.ok(voices.voices.length >= 1);
  assert.ok(voices.voices.some((v) => v.id === 'Huihui' && v.engine === 'sapi'));
});

test('voice.speak 返回 base64 音频', async () => {
  const { reg } = setup();
  const res = (await call(reg, 'voice.speak', { text: '方法层测试', rate: 1.2 })) as {
    audioBase64: string;
    mime: string;
    durationMs: number;
    engine: string;
  };
  assert.equal(res.engine, 'sapi');
  assert.equal(res.mime, 'audio/wav');
  assert.equal(res.durationMs, 900);
  assert.ok(res.audioBase64.length > 0);
  assert.equal(Buffer.from(res.audioBase64, 'base64').subarray(0, 4).toString(), 'RIFF');
});
