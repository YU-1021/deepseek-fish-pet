import { useState } from 'react';
import type { ReactNode } from 'react';
import { Battery, Heart, Sparkles } from 'lucide-react';
import { request, usePetdStatus } from './petd';
import { moodErrorText, useMoodState } from './mood';
import type { MoodEntry } from './mood';

type MoodConfig = { enabled: boolean; chatInjection: boolean; chatNudge: boolean; moodDecayPerHour: number; energyRecoverPerHour: number };
type MoodSettingsPanelProps = { config: { mood?: MoodConfig }; sessionId?: string; showValues: boolean; onShowValuesChange: (show: boolean) => void };
const moodLabels: Record<MoodEntry['key'], string> = { mood: '心情', affection: '好感', energy: '精力' };
const formatDelta = (entry: MoodEntry) => `${moodLabels[entry.key]} ${entry.delta >= 0 ? '+' : ''}${Number(entry.delta.toFixed(1))}${entry.reason ? `（${entry.reason}）` : ''}`;

export function MoodSettingsPanel({ config, sessionId, showValues, onShowValuesChange }: MoodSettingsPanelProps) {
  const connection = usePetdStatus();
  const { enabled, state, history, error, refresh } = useMoodState();
  const [evaluating, setEvaluating] = useState(false);
  const [evaluateError, setEvaluateError] = useState('');
  const [resultHints, setResultHints] = useState<string[]>([]);
  const moodConfig = config.mood;
  const isEnabled = enabled ?? moodConfig?.enabled ?? false;

  async function evaluate() {
    if (!isEnabled || evaluating || connection.state !== 'connected') return;
    setEvaluating(true); setEvaluateError(''); setResultHints([]);
    try {
      const result = await request('mood.evaluate', sessionId ? { sessionId } : {}, 90_000);
      const applied = Array.isArray(result.applied) ? result.applied as MoodEntry[] : [];
      setResultHints(applied.length ? applied.map(formatDelta) : ['这次心情很平稳。']);
      await refresh();
    } catch (cause) { setEvaluateError(moodErrorText(cause)); }
    finally { setEvaluating(false); }
  }

  return <section className="mood-panel" aria-label="情绪与状态">
    <div className="mood-panel-heading"><div><span className="eyebrow">MOOD & STATUS</span><h3>情绪与状态</h3></div><span className={`mood-enabled ${isEnabled ? 'on' : ''}`}>{isEnabled ? '已启用' : '已关闭'}</span></div>
    <label className="mood-debug-toggle"><input type="checkbox" checked={showValues} onChange={(event) => onShowValuesChange(event.target.checked)}/>显示精确数值（调试）</label>
    {!isEnabled ? <p className="mood-disabled-note">情绪系统已关闭</p> : !state ? <p className="mood-muted">{error || '正在读取状态…'}</p> : <>
      {error && <p className="mood-error">{error}</p>}
      <div className="mood-state-grid">
        <MoodGauge icon={<Sparkles size={15}/>} label="心情" tier={state.tiers.mood} value={state.mood} showValues={showValues}/>
        <MoodGauge icon={<Heart size={15}/>} label="好感" tier={state.tiers.affection} value={state.affection} showValues={showValues}/>
        <MoodGauge icon={<Battery size={15}/>} label="精力" tier={state.tiers.energy} value={state.energy} showValues={showValues}/>
      </div>
      <div className="mood-affection-copy">{affectionCopy(state.tiers.affection)}</div>
      {state.energy < 25 && <p className="mood-gentle-copy">今天有点累，想安静待一会儿。</p>}
      <div className="mood-actions"><button className="primary-action" onClick={() => void evaluate()} disabled={evaluating || connection.state !== 'connected'}>{evaluating ? '正在想…' : '让它想想刚才聊得怎么样'}</button><span aria-live="polite">{evaluateError || resultHints.join(' · ')}</span></div>
      <div className="mood-config-readonly"><strong>行为设置（只读）</strong><span>聊天提示：{moodConfig?.chatInjection ? '开启' : '关闭'}</span><span>聊天后轻微变化：{moodConfig?.chatNudge ? '开启' : '关闭'}</span><span>每小时心情回落：{moodConfig?.moodDecayPerHour ?? 0} · 精力恢复：{moodConfig?.energyRecoverPerHour ?? 0}</span></div>
      <div className="mood-history"><strong>最近变化</strong>{history.length ? history.slice(0, 8).map((entry) => <div className="mood-history-row" key={`${entry.ts}-${entry.key}`}><span>{formatDelta(entry)}</span><small>{new Date(entry.ts).toLocaleString()} · {entry.source}</small></div>) : <p className="mood-muted">还没有变化记录</p>}</div>
      <p className="mood-poke-count">被戳过 {state.pokes} 次</p>
    </>}
  </section>;
}

function MoodGauge({ icon, label, tier, value, showValues }: { icon: ReactNode; label: string; tier: string; value: number; showValues: boolean }) {
  return <article className="mood-gauge"><div className="mood-gauge-head">{icon}<span>{label}</span></div><strong>{tier}</strong>{showValues && <small>{Number(value.toFixed(1))} / 100</small>}<div className="mood-gauge-track"><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }}/></div></article>;
}

function affectionCopy(tier: string): string {
  if (tier.includes('生疏') || tier.includes('陌生')) return '还在慢慢熟悉你。';
  if (tier.includes('亲近') || tier.includes('黏')) return '已经很喜欢黏着你啦。';
  if (tier.includes('熟悉')) return '和你越来越熟悉了。';
  return '正在一点点了解你。';
}
