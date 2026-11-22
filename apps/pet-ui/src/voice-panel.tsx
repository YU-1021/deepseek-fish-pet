import { useEffect, useState } from 'react';
import { request, usePetdStatus } from './petd';
import './voice-panel.css';

type VoiceInfo = { id: string; label: string; lang: string; engine: 'edge' | 'sapi' };
type VoiceStatus = { enabled: boolean; engine: 'edge' | 'sapi'; voice: string; cacheFiles: number; cacheBytes: number };

export function VoiceSettingsPanel({ config }: { config: any }) {
  const connection = usePetdStatus();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (connection.state !== 'connected') return;
    let live = true;
    Promise.all([request('voice.status', {}), request('voice.voices', {})]).then(([nextStatus, nextVoices]) => {
      if (live) { setStatus(nextStatus); setVoices(nextVoices.voices ?? []); setError(''); }
    }).catch((cause) => { if (live) setError(cause?.code === 'E_UNAVAILABLE' ? '语音服务已关闭。' : cause?.message ?? '无法读取语音设置。'); });
    return () => { live = false; };
  }, [connection.state]);
  const voiceConfig = config?.voice ?? {};
  const selected = voiceConfig.voice ?? status?.voice ?? '';
  const engine = voiceConfig.engine ?? status?.engine ?? 'edge';
  const filtered = voices.filter((item) => item.engine === engine);
  return <section className="voice-panel">
    <div className="voice-heading"><div><span className="eyebrow">VOICE</span><h3>语音与朗读</h3></div><span className={`voice-state ${voiceConfig.enabled ?? status?.enabled ? 'on' : ''}`}>{voiceConfig.enabled ?? status?.enabled ? '已启用' : status ? '已关闭' : '读取中…'}</span></div>
    {error && <p className="voice-error" role="status">{error}</p>}
    <p className="voice-note">当前配置只读。petd 尚无语音设置写入方法；可在聊天消息旁朗读，停止按钮会中断当前播放。</p>
    <div className="voice-readonly-grid"><div><span>引擎</span><strong>{engine === 'edge' ? 'Edge 在线语音' : 'Windows SAPI'}</strong></div><div><span>自动朗读</span><strong>{voiceConfig.autoSpeak ? '开启' : '关闭'}</strong></div><div><span>语速 / 音调</span><strong>{voiceConfig.rate ?? 1} / {voiceConfig.pitch ?? 1}</strong></div><div><span>缓存</span><strong>{status ? `${status.cacheFiles} 个 · ${(status.cacheBytes / 1024 / 1024).toFixed(1)} MB` : '读取中…'}</strong></div></div>
    <label className="voice-select">音色<select value={selected} disabled><option value="">{selected || '默认音色'}</option>{filtered.map((item) => <option key={`${item.engine}:${item.id}`} value={item.id}>{item.label} · {item.lang}</option>)}</select></label>
    <div className="voice-sliders"><label>语速 <input type="range" min="0.5" max="2" step="0.1" value={voiceConfig.rate ?? 1} disabled/><strong>{voiceConfig.rate ?? 1}</strong></label><label>音调 <input type="range" min="0.5" max="2" step="0.1" value={voiceConfig.pitch ?? 1} disabled/><strong>{voiceConfig.pitch ?? 1}</strong></label></div>
  </section>;
}
