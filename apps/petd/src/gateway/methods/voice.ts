/**
 * 语音方法：voice.*。
 *
 * 合成由 VoiceService 完成：Edge 在线神经语音，失败回退本地 SAPI；结果带 base64 音频，
 * UI 直接 `data:${mime};base64,...` 播放，不用再回查文件。
 */
import { Type } from '@sinclair/typebox';
import type { MethodRegistry } from '../registry.js';
import type { VoiceService } from '../../voice/service.js';

const VoiceInfoSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  lang: Type.String(),
  engine: Type.Union([Type.Literal('edge'), Type.Literal('sapi')]),
});

const SpeechSchema = Type.Object({
  id: Type.String(),
  file: Type.String(),
  mime: Type.String(),
  bytes: Type.Integer(),
  durationMs: Type.Integer(),
  cached: Type.Boolean(),
  engine: Type.Union([Type.Literal('edge'), Type.Literal('sapi')]),
  voice: Type.String(),
  rate: Type.Number(),
  pitch: Type.Number(),
  text: Type.String(),
  audioBase64: Type.String(),
  elapsedMs: Type.Integer(),
});

export interface VoiceMethodDeps {
  voice: VoiceService;
}

export function registerVoiceMethods(reg: MethodRegistry, deps: VoiceMethodDeps): void {
  reg.register(
    {
      name: 'voice.status',
      scope: 'read',
      description: '语音状态：开关、引擎、默认音色、缓存文件数/大小',
      params: Type.Object({}),
      result: Type.Object({
        enabled: Type.Boolean(),
        engine: Type.Union([Type.Literal('edge'), Type.Literal('sapi')]),
        voice: Type.String(),
        cacheDir: Type.String(),
        cacheFiles: Type.Integer(),
        cacheBytes: Type.Integer(),
      }),
    },
    () => deps.voice.status()
  );

  reg.register(
    {
      name: 'voice.voices',
      scope: 'read',
      description: '可用音色列表（Edge 神经语音 + 本机 SAPI）',
      params: Type.Object({}),
      result: Type.Object({ voices: Type.Array(VoiceInfoSchema) }),
    },
    async () => ({ voices: await deps.voice.listVoices() })
  );

  reg.register(
    {
      name: 'voice.speak',
      scope: 'write',
      description: '文字转语音：返回 base64 音频（首次合成会联网或调本机 SAPI，之后命中缓存）',
      params: Type.Object({
        text: Type.String({ minLength: 1, maxLength: 4000 }),
        voice: Type.Optional(Type.String({ maxLength: 120 })),
        rate: Type.Optional(Type.Number({ minimum: 0.5, maximum: 2 })),
        pitch: Type.Optional(Type.Number({ minimum: 0.5, maximum: 2 })),
      }),
      result: SpeechSchema,
      timeoutMs: 90_000,
      idempotent: true,
    },
    async (params) => {
      const p = params as { text: string; voice?: string; rate?: number; pitch?: number };
      return deps.voice.speak(p.text, {
        ...(p.voice === undefined ? {} : { voice: p.voice }),
        ...(p.rate === undefined ? {} : { rate: p.rate }),
        ...(p.pitch === undefined ? {} : { pitch: p.pitch }),
      });
    }
  );
}
