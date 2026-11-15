/**
 * 语音识别方法：asr.*。
 *
 * - asr.status / asr.models：看引擎、模型、是否就绪
 * - asr.download：下载模型（hf-mirror 优先）
 * - asr.transcribe：一次性识别整段音频（base64 WAV）
 * - asr.listen.start / asr.listen.feed / asr.listen.stop：流式监听（PCM16 base64 分片）
 *
 * 流式监听里的识别结果通过事件 `asr.segment` / `asr.wake` 广播，UI 订阅即可。
 */
import { Type } from '@sinclair/typebox';
import type { MethodRegistry } from '../registry.js';
import type { AsrService } from '../../asr/service.js';

const ModelId = Type.Union([Type.Literal('tiny'), Type.Literal('base'), Type.Literal('small')]);

const SegmentSchema = Type.Object({
  streamId: Type.String(),
  index: Type.Integer(),
  text: Type.String(),
  language: Type.String(),
  durationMs: Type.Integer(),
  tookMs: Type.Integer(),
  wake: Type.Union([Type.String(), Type.Null()]),
});

export interface AsrMethodDeps {
  asr: AsrService;
}

export function registerAsrMethods(registry: MethodRegistry, deps: AsrMethodDeps): void {
  registry.register(
    {
      name: 'asr.status',
      scope: 'read',
      description: '语音识别状态：引擎、模型、whisper 二进制、监听数',
      params: Type.Object({}),
      timeoutMs: 10_000,
    },
    () => deps.asr.status()
  );

  registry.register(
    {
      name: 'asr.models',
      scope: 'read',
      description: '可下载的 whisper 模型清单（含就绪状态与当前使用）',
      params: Type.Object({}),
      timeoutMs: 10_000,
    },
    () => ({ models: deps.asr.modelList() })
  );

  registry.register(
    {
      name: 'asr.download',
      scope: 'write',
      description: '下载 whisper 模型（hf-mirror 优先，huggingface 兜底）；进度通过 asr.download 事件广播',
      params: Type.Object({ model: ModelId }),
      timeoutMs: 15 * 60_000,
      idempotent: true,
    },
    async (params) => {
      const p = params as { model: 'tiny' | 'base' | 'small' };
      return deps.asr.download(p.model);
    }
  );

  registry.register(
    {
      name: 'asr.transcribe',
      scope: 'write',
      description: '一次性识别整段音频（base64 WAV，建议 16kHz 单声道）',
      params: Type.Object({
        audioBase64: Type.String({ minLength: 16, maxLength: 100_000_000 }),
        language: Type.Optional(Type.String({ maxLength: 20 })),
        model: Type.Optional(ModelId),
      }),
      timeoutMs: 180_000,
      idempotent: true,
    },
    async (params) => {
      const p = params as { audioBase64: string; language?: string; model?: 'tiny' | 'base' | 'small' };
      return deps.asr.transcribe({
        audioBase64: p.audioBase64,
        ...(p.language === undefined ? {} : { language: p.language }),
        ...(p.model === undefined ? {} : { model: p.model }),
      });
    }
  );

  registry.register(
    {
      name: 'asr.listen.start',
      scope: 'write',
      description: '开始流式监听：返回 streamId、采样率与 VAD 参数',
      params: Type.Object({}),
      timeoutMs: 30_000,
      idempotent: false,
    },
    () => deps.asr.listenStart()
  );

  registry.register(
    {
      name: 'asr.listen.feed',
      scope: 'write',
      description: '喂入 PCM16（16kHz 单声道小端，base64）分片，返回本次切出的句子识别结果',
      params: Type.Object({
        streamId: Type.String({ minLength: 1, maxLength: 80 }),
        pcmBase64: Type.String({ minLength: 4, maxLength: 4_000_000 }),
      }),
      result: Type.Object({ segments: Type.Array(SegmentSchema) }),
      timeoutMs: 180_000,
      idempotent: false,
    },
    async (params) => {
      const p = params as { streamId: string; pcmBase64: string };
      const segments = await deps.asr.listenFeed(p.streamId, p.pcmBase64);
      return { segments };
    }
  );

  registry.register(
    {
      name: 'asr.listen.stop',
      scope: 'write',
      description: '结束流式监听：把最后一段强制识别并返回结果',
      params: Type.Object({ streamId: Type.String({ minLength: 1, maxLength: 80 }) }),
      result: Type.Object({ segments: Type.Array(SegmentSchema) }),
      timeoutMs: 180_000,
      idempotent: false,
    },
    async (params) => {
      const p = params as { streamId: string };
      const segments = await deps.asr.listenStop(p.streamId);
      return { segments };
    }
  );
}
