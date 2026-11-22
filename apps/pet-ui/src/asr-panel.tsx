import { useCallback, useEffect, useRef, useState } from 'react';
import { request, subscribeEvents, usePetdStatus } from './petd';
import './asr-panel.css';

type AsrModel = { name: 'tiny' | 'base' | 'small'; ready: boolean; current: boolean; sizeBytes?: number };
type AsrStatus = { enabled: boolean; engine: string; model: string; language: string; binary: { found: boolean; path: string }; models: string[]; wakeEnabled: boolean; wakeWords: string[]; listening: boolean; autoChat: boolean };
type Segment = { streamId: string; index: number; text: string; language?: string; durationMs?: number; tookMs?: number; wake?: string | null };
type DownloadProgress = { model: string; got: number; total: number; url?: string };
const modelSize: Record<string, number> = { tiny: 75_000_000, base: 148_000_000, small: 488_000_000 };
const errorText = (error: any) => error?.code === 'E_UNAVAILABLE' ? '识别服务不可用，请检查设置或下载一个模型。' : error?.code === 'E_NOT_FOUND' ? '监听流已过期，请重新开始。' : error?.code === 'E_BAD_PARAMS' ? '音频格式不正确，请检查麦克风采样率和声道。' : error?.message ?? '操作失败，请重试。';

function toBase64Pcm(samples: Float32Array, sourceRate: number) {
  const ratio = sourceRate / 16000;
  const length = Math.floor(samples.length / ratio);
  const bytes = new Uint8Array(length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < length; index += 1) {
    const from = Math.floor(index * ratio);
    const to = Math.min(samples.length, Math.ceil((index + 1) * ratio));
    let sum = 0;
    for (let cursor = from; cursor < to; cursor += 1) sum += samples[cursor] ?? 0;
    const value = Math.max(-1, Math.min(1, sum / Math.max(1, to - from)));
    view.setInt16(index * 2, Math.round(value * 0x7fff), true);
  }
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function AsrSettingsPanel() {
  const connection = usePetdStatus();
  const [status, setStatus] = useState<AsrStatus | null>(null);
  const [models, setModels] = useState<AsrModel[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [download, setDownload] = useState<DownloadProgress | null>(null);
  const [busyModel, setBusyModel] = useState('');
  const [listening, setListening] = useState(false);
  const [wakeHit, setWakeHit] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const streamId = useRef('');
  const mediaStream = useRef<MediaStream | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const worklet = useRef<AudioWorkletNode | null>(null);
  const feedQueue = useRef(0);
  const stopRef = useRef<() => Promise<void>>(async () => {});

  const refresh = useCallback(async () => {
    if (connection.state !== 'connected') return;
    try {
      const [nextStatus, nextModels] = await Promise.all([request('asr.status', {}), request('asr.models', {})]);
      setStatus(nextStatus); setModels(nextModels.models ?? []); setError('');
    } catch (cause) { setError(errorText(cause)); }
  }, [connection.state]);
  useEffect(() => { void refresh(); }, [refresh]);

  const appendSegment = useCallback((item: Segment) => {
    if (!item.text?.trim()) return;
    setSegments((items) => items.some((entry) => entry.streamId === item.streamId && entry.index === item.index) ? items : [...items, item].slice(-30));
    if (item.wake) { setWakeHit(item.wake); window.setTimeout(() => setWakeHit(''), 5000); }
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeEvents((frame) => {
      if (frame.event === 'asr.download') setDownload(frame.data as DownloadProgress);
      if (frame.event === 'asr.segment' && frame.data?.streamId === streamId.current) appendSegment(frame.data as Segment);
      if (frame.event === 'asr.wake' && frame.data?.streamId === streamId.current) {
        const word = String(frame.data.wakeWord ?? frame.data.text ?? '唤醒词'); setWakeHit(word); window.setTimeout(() => setWakeHit(''), 5000);
      }
    });
    return () => { unsubscribe(); };
  }, [appendSegment]);

  const cleanupCapture = useCallback(() => {
    worklet.current?.disconnect(); worklet.current = null;
    mediaStream.current?.getTracks().forEach((track) => track.stop()); mediaStream.current = null;
    void audioContext.current?.close(); audioContext.current = null;
    feedQueue.current = 0;
  }, []);

  const stopListening = useCallback(async () => {
    const activeId = streamId.current;
    streamId.current = '';
    cleanupCapture(); setListening(false);
    if (!activeId) return;
    try {
      const result = await request('asr.listen.stop', { streamId: activeId }, 180_000);
      for (const item of result.segments ?? []) appendSegment(item);
    } catch (cause) { setError(errorText(cause)); }
    await refresh();
  }, [appendSegment, cleanupCapture, refresh]);
  stopRef.current = stopListening;
  useEffect(() => {
    if (connection.state === 'connected') return;
    void stopRef.current();
  }, [connection.state]);
  useEffect(() => () => { void stopRef.current(); }, []);

  async function startListening() {
    if (listening || connection.state !== 'connected') return;
    setError(''); setNote(''); setWakeHit('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true } });
      mediaStream.current = stream;
      const started = await request('asr.listen.start', {}, 30_000);
      streamId.current = started.streamId;
      const context = new AudioContext({ sampleRate: 16000 });
      audioContext.current = context;
      const sourceCode = `class PetPcmCapture extends AudioWorkletProcessor { process(inputs, outputs) { const input = inputs[0] && inputs[0][0]; if (input) this.port.postMessage(input.slice(0)); for (const output of outputs) for (const channel of output) channel.fill(0); return true; } } registerProcessor('pet-pcm-capture', PetPcmCapture);`;
      const moduleUrl = URL.createObjectURL(new Blob([sourceCode], { type: 'text/javascript' }));
      try { await context.audioWorklet.addModule(moduleUrl); } finally { URL.revokeObjectURL(moduleUrl); }
      const node = new AudioWorkletNode(context, 'pet-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      worklet.current = node;
      const source = context.createMediaStreamSource(stream);
      const mute = context.createGain(); mute.gain.value = 0;
      source.connect(node).connect(mute).connect(context.destination);
      let buffered: Float32Array[] = [];
      let bufferedSamples = 0;
      node.port.onmessage = (event) => {
        if (!streamId.current) return;
        const chunk = event.data as Float32Array;
        buffered.push(chunk); bufferedSamples += chunk.length;
        if (bufferedSamples < context.sampleRate * 0.24 || feedQueue.current >= 2) return;
        const all = new Float32Array(bufferedSamples);
        let offset = 0; for (const part of buffered) { all.set(part, offset); offset += part.length; }
        buffered = []; bufferedSamples = 0;
        const activeId = streamId.current; feedQueue.current += 1;
        void request('asr.listen.feed', { streamId: activeId, pcmBase64: toBase64Pcm(all, context.sampleRate) }, 180_000)
          .then((result) => { if (streamId.current === activeId) for (const item of result.segments ?? []) appendSegment(item); })
          .catch((cause) => { if (streamId.current === activeId) setError(errorText(cause)); })
          .finally(() => { feedQueue.current = Math.max(0, feedQueue.current - 1); });
      };
      await context.resume(); setSegments([]); setListening(true); setNote('音频只在本机处理，不落盘、不上传；识别文本才会进入事件与会话。');
      await refresh();
    } catch (cause) {
      cleanupCapture();
      if (streamId.current) { const oldId = streamId.current; streamId.current = ''; void request('asr.listen.stop', { streamId: oldId }, 180_000).catch(() => {}); }
      const name = (cause as any)?.name;
      setError(name === 'NotAllowedError' ? '麦克风权限被拒绝，请在系统设置中允许此应用使用麦克风。' : name === 'NotFoundError' ? '没有找到可用麦克风。' : errorText(cause));
    }
  }

  async function downloadModel(model: string) {
    if (busyModel) return;
    setBusyModel(model); setDownload({ model, got: 0, total: modelSize[model] ?? 0 }); setError('');
    try { await request('asr.download', { model }, 15 * 60_000); await refresh(); setNote(`${model} 模型已准备就绪。`); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusyModel(''); setDownload(null); }
  }

  const totalSize = download?.total ?? 0;
  const progress = totalSize ? Math.min(100, Math.round((download?.got ?? 0) / totalSize * 100)) : 0;
  return <section className="asr-panel">
    <div className="asr-heading"><div><span className="eyebrow">LOCAL SPEECH</span><h3>语音识别与唤醒</h3></div><span className={`asr-state ${listening ? 'listening' : ''}`}>{listening ? `🎤 在听 · 已识别 ${segments.length} 句` : status ? '已停止' : '读取中…'}</span></div>
    <p className="asr-privacy">音频只在本机处理、不落盘、不上传；识别文本才会进入事件与会话。</p>
    {error && <p className="asr-error" role="alert">{error}</p>}{note && <p className="asr-note" role="status">{note}</p>}
    {status && <div className="asr-readonly"><span>ASR：{status.enabled ? '已启用' : '已关闭'} · Whisper {status.model}</span><span>自动发进聊天：{status.autoChat ? '开启' : '关闭'}</span><span>唤醒词：{status.wakeEnabled ? status.wakeWords.join('、') || '已开启' : '关闭'}</span><span>引擎：{status.binary.found ? status.binary.path : `未找到 whisper.cpp：${status.binary.path || '请检查引擎路径'}`}</span></div>}
    <div className="asr-actions"><button className="asr-primary" disabled={!status?.enabled || listening || connection.state !== 'connected'} onClick={() => void startListening()}>开始听</button><button disabled={!listening} onClick={() => void stopListening()}>停止</button></div>
    {wakeHit && <div className="asr-wake" role="status">唤醒词命中：{wakeHit}</div>}
    <div className="asr-transcript" aria-live="polite">{segments.length ? segments.map((item, index) => <p key={`${item.streamId}:${item.index}:${index}`}>{item.text}{item.wake && <strong> · 唤醒「{item.wake}」</strong>}</p>) : <span>{listening ? '正在等待识别结果…' : '开始监听后，识别字幕会显示在这里。'}</span>}</div>
    <div className="asr-model-heading"><strong>离线模型</strong><small>{status?.language ?? '语言自动识别'} · 默认配置只读</small></div>
    {models.map((model) => <div className="asr-model" key={model.name}><div><strong>{model.name}</strong><small>{model.ready ? model.current ? '当前使用' : '已下载' : `${((model.sizeBytes ?? modelSize[model.name] ?? 0) / 1024 / 1024).toFixed(0)} MB`}</small></div>{model.ready ? <span>{model.current ? '当前' : '就绪'}</span> : <button disabled={!!busyModel || connection.state !== 'connected'} onClick={() => void downloadModel(model.name)}>{busyModel === model.name ? '下载中…' : '下载'}</button>}</div>)}
    {download && <div className="asr-progress"><div><span>正在下载 {download.model}　{progress}%</span><small>{download.url ?? '下载无法保证可取消'}</small></div><progress max={100} value={progress}/><small>大模型下载可能需要较长时间；关闭界面后下载取消不保证。</small></div>}
    <small className="asr-settings-note">唤醒词与 autoChat 当前只读展示；配置写入仍由 petd 管理。</small>
  </section>;
}
