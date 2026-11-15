/**
 * 语音服务测试：合成/回退/关闭/上限/音色合并，以及 chat.send 的 speak 联动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../kernel/events.js';
import { DEFAULT_CONFIG } from '../kernel/config.js';
import type { CompleteOptions, LlmReply } from '../llm/client.js';
import type { SpeechEngine, SynthOptions, SynthResult, VoiceInfo } from './engine.js';
import { VoiceService } from './service.js';
import { ChatStore } from '../chat/store.js';
import { ChatService } from '../chat/service.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-voice-'));
}

class FakeEngine implements SpeechEngine {
  readonly calls: Array<{ text: string; opts: SynthOptions }> = [];
  fail: Error | null = null;
  voices: VoiceInfo[] = [];
  private cache = new Set<string>();

  constructor(readonly name: 'edge' | 'sapi') {}

  async synthesize(text: string, opts: SynthOptions): Promise<SynthResult> {
    if (this.fail) throw this.fail;
    this.calls.push({ text, opts });
    const key = `${this.name}|${opts.voice}|${opts.rate}|${opts.pitch}|${text}`;
    const cached = this.cache.has(key);
    this.cache.add(key);
    const file = path.join(tmpDir(), `${this.name}-${this.calls.length}.wav`);
    const data = Buffer.from('RIFF____WAVEfmt fake audio payload');
    fs.writeFileSync(file, data);
    return {
      file,
      mime: this.name === 'edge' ? 'audio/mpeg' : 'audio/wav',
      bytes: data.length,
      durationMs: 1234,
      cached,
      engine: this.name,
    };
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return this.voices;
  }
}

function makeVoice(overrides: Partial<typeof DEFAULT_CONFIG.voice> = {}) {
  const edge = new FakeEngine('edge');
  const sapi = new FakeEngine('sapi');
  sapi.voices = [{ id: 'Huihui', label: 'Microsoft Huihui Desktop', lang: 'zh-CN', engine: 'sapi' }];
  edge.voices = [{ id: 'zh-CN-XiaoxiaoNeural', label: '晓晓', lang: 'zh-CN', engine: 'edge' }];
  const events: Array<{ event: string; data: unknown }> = [];
  const service = new VoiceService({
    config: { ...DEFAULT_CONFIG.voice, ...overrides },
    home: tmpDir(),
    engines: { edge, sapi },
    publish: (event, data) => events.push({ event, data }),
  });
  return { service, edge, sapi, events };
}

test('speak：合成成功、返回 base64、发布 voice.speech、第二次缓存命中', async () => {
  const { service, events } = makeVoice();
  const first = await service.speak('你好呀，今天过得怎么样？');
  assert.equal(first.engine, 'edge');
  assert.equal(first.cached, false);
  assert.equal(first.durationMs, 1234);
  assert.ok(first.audioBase64.length > 0);
  assert.equal(fs.readFileSync(first.file).toString('base64'), first.audioBase64);
  assert.equal(events.filter((e) => e.event === 'voice.speech').length, 1);

  const second = await service.speak('你好呀，今天过得怎么样？');
  assert.equal(second.cached, true);
  assert.equal(second.id, first.id);
  assert.equal(second.voice, first.voice);
  assert.equal(fs.existsSync(second.file), true);
});

test('speak：关闭/空文本/超长文本报错', async () => {
  const disabled = makeVoice({ enabled: false });
  await assert.rejects(() => disabled.service.speak('你好'), /语音功能已关闭/);

  const { service } = makeVoice();
  await assert.rejects(() => service.speak('   '), /没有可朗读的文本/);
  await assert.rejects(() => service.speak('字'.repeat(2000)), /太长/);
});

test('speak：Edge 失败时回退 SAPI，两边都失败报 E_UNAVAILABLE', async () => {
  const { service, edge, sapi } = makeVoice();
  edge.fail = new Error('edge boom');
  const result = await service.speak('回退测试');
  assert.equal(result.engine, 'sapi');
  assert.equal(sapi.calls.length, 1);

  edge.fail = new Error('edge boom');
  sapi.fail = new Error('sapi boom');
  await assert.rejects(() => service.speak('都失败'), /Edge：edge boom；SAPI：sapi boom/);
});

test('listVoices 合并两个引擎并去重', async () => {
  const { service, sapi } = makeVoice();
  sapi.voices.push({ id: 'Huihui', label: 'dup', lang: 'zh-CN', engine: 'sapi' });
  const voices = await service.listVoices();
  assert.equal(voices.length, 2);
  assert.deepEqual(voices.map((v) => v.engine).sort(), ['edge', 'sapi']);
});

test('status：开关/引擎/音色/缓存统计', async () => {
  const { service } = makeVoice();
  await service.speak('缓存统计');
  await service.speak('缓存统计');
  const status = service.status();
  assert.equal(status.enabled, true);
  assert.equal(status.engine, 'edge');
  assert.equal(status.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(typeof status.cacheFiles, 'number');
  assert.ok(status.cacheDir.length > 0);
});

class FakeLlm {
  async complete(_opts: CompleteOptions): Promise<LlmReply> {
    return { text: '我在呢，主人。', model: 'fake', usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } };
  }
}

function makeChat(voice?: VoiceService, autoSpeak = false) {
  const dir = tmpDir();
  const store = new ChatStore({ dir });
  const bus = new EventBus(() => 100);
  const chat = new ChatService({
    store,
    llm: new FakeLlm(),
    chat: { ...DEFAULT_CONFIG.chat, maxToolRounds: 0 },
    publish: (event, data) => {
      bus.emit(event, data);
    },
    systemPrompt: () => '你是大肥鱼',
    ...(voice === undefined ? {} : { voice }),
    autoSpeak,
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return { chat };
}

test('chat.send：speak=true 时返回语音；默认不朗读；语音失败不影响回复', async () => {
  const { service } = makeVoice();
  const { chat } = makeChat(service);
  const spoken = await chat.send({ text: '在吗', speak: true });
  assert.ok(spoken.speech);
  assert.equal(spoken.speech?.engine, 'edge');

  const silent = await chat.send({ text: '再说一句' });
  assert.equal(silent.speech, null);

  const broken = makeVoice();
  broken.edge.fail = new Error('boom');
  broken.sapi.fail = new Error('boom');
  const { chat: chat2 } = makeChat(broken.service);
  const result = await chat2.send({ text: '语音坏了也要回', speak: true });
  assert.equal(result.speech, null);
  assert.equal(result.reply.text, '我在呢，主人。');
});

test('chat.send：autoSpeak 为 true 时默认朗读', async () => {
  const { service, edge } = makeVoice();
  const { chat } = makeChat(service, true);
  const result = await chat.send({ text: '默认朗读' });
  assert.ok(result.speech);
  assert.equal(edge.calls.length, 1);

  const off = await chat.send({ text: '这次别读', speak: false });
  assert.equal(off.speech, null);
});
