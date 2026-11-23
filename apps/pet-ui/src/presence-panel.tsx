import { useEffect, useState } from 'react';
import { request, subscribeEvents, usePetdStatus } from './petd';
import './presence-panel.css';

type PresenceStatus = { enabled: boolean; quiet: boolean; intervalMinutes: number; idleMinutes: number; maxPerDay: number; nightQuiet: { enabled: boolean; start: string; end: string }; countToday: number; lastAt?: number; nextAt?: number };
type PresenceActivity = { id: string; kind: string; label: string; at: number; quiet: boolean };
const activityName: Record<string, string> = { groom: '整理羽毛', stretch: '伸懒腰', window: '看窗外', nap: '打盹', tidy: '归置东西', idle: '发呆' };
const errorMessage = (error: any) => error?.code === 'E_UNAVAILABLE' ? '静默活动已关闭。' : error?.message ?? '读取失败，请重试。';

export function PresenceSettingsPanel() {
  const connection = usePetdStatus();
  const [status, setStatus] = useState<PresenceStatus | null>(null);
  const [activities, setActivities] = useState<PresenceActivity[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  async function refresh() {
    if (connection.state !== 'connected') return;
    try {
      const [nextStatus, nextList] = await Promise.all([request('presence.status', {}), request('presence.list', { limit: 5 })]);
      setStatus(nextStatus); setActivities(nextList.activities ?? []); setNotice('');
    } catch (error) { setNotice(errorMessage(error)); }
  }
  useEffect(() => { void refresh(); }, [connection.state]);
  useEffect(() => {
    const unsubscribe = subscribeEvents((frame) => {
      if (frame.event === 'presence.activity' && frame.data?.id) setActivities((items) => [frame.data as PresenceActivity, ...items.filter((item) => item.id !== frame.data.id)].slice(0, 5));
    });
    return () => { unsubscribe(); };
  }, []);
  async function runOnce() {
    if (busy || connection.state !== 'connected') return;
    setBusy(true); setNotice('');
    try { const activity = await request('presence.run_once', {}); setActivities((items) => [activity, ...items.filter((item) => item.id !== activity.id)].slice(0, 5)); await refresh(); setNotice(`小鱼刚刚${activity.label ?? activityName[activity.kind] ?? '活动了一下'}。`); }
    catch (error) { setNotice(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <section className="presence-panel">
    <div className="presence-heading"><div><span className="eyebrow">QUIET PRESENCE</span><h3>静默活动</h3></div><span className={`presence-state ${status?.enabled ? 'on' : ''}`}>{status ? status.enabled ? '已启用' : '已关闭' : '读取中…'}</span></div>
    <p className="presence-copy">只播放轻量动作，不弹气泡、不发声，也不会写入聊天记录。</p>
    {status && <div className="presence-values"><div><span>活动间隔</span><strong>{status.intervalMinutes} 分钟</strong></div><div><span>闲置门槛</span><strong>{status.idleMinutes} 分钟</strong></div><div><span>今日活动</span><strong>{status.countToday} / {status.maxPerDay}</strong></div><div><span>夜间安静</span><strong>{status.nightQuiet?.enabled ? `${status.nightQuiet.start}–${status.nightQuiet.end}` : '关闭'}</strong></div></div>}
    <button className="presence-run" onClick={() => void runOnce()} disabled={busy || connection.state !== 'connected' || status?.enabled === false}>{busy ? '正在安排…' : '现在来一个'}</button>
    {notice && <p className="presence-notice" role="status">{notice}</p>}
    <div className="presence-history"><strong>最近的安静时刻</strong>{activities.length ? activities.map((item) => <div key={item.id}><span>{item.label || activityName[item.kind] || item.kind}</span><small>{new Date(item.at).toLocaleString()}</small></div>) : <p>还没有活动记录。</p>}</div>
  </section>;
}
