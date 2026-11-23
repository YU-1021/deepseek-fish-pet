import { useEffect, useState } from 'react';
import { request, subscribeEvents, usePetdStatus } from './petd';
import './reminder-panel.css';

type Reminder = { id: string; text: string; at: number; inMinutes: number; createdAt: number; snoozes: number; source: string };
const showError = (error: any) => error?.code === 'E_UNAVAILABLE' ? '提醒功能已关闭，或待响提醒已达到上限。' : error?.code === 'E_BAD_PARAMS' ? '请检查提醒内容和时间是否有效。' : error?.message ?? '操作失败，请重试。';
const timeText = (at: number) => new Date(at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ReminderCoordinator() {
  const [due, setDue] = useState<Reminder[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const unsubscribe = subscribeEvents((frame) => {
      if (frame.event === 'reminder.due' && frame.data?.item?.id) setDue((items) => [...items.filter((item) => item.id !== frame.data.item.id), frame.data.item]);
    });
    return () => { unsubscribe(); };
  }, []);
  async function snooze(minutes: number) {
    if (busy || !due.length) return;
    setBusy(true);
    try { await Promise.all(due.map((item) => request('reminder.snooze', { id: item.id, minutes }))); setMessage(`已将 ${due.length} 条提醒延后 ${minutes} 分钟。`); setDue([]); }
    catch (error) { setMessage(showError(error)); }
    finally { setBusy(false); }
  }
  if (!due.length && !message) return null;
  return <div className="reminder-toast" role="alert" aria-live="assertive"><div className="reminder-toast-head"><strong>{due.length ? due.length > 1 ? `你有 ${due.length} 条提醒` : '提醒时间到了' : '提醒'}</strong><button onClick={() => { setDue([]); setMessage(''); }} aria-label="关闭提醒">×</button></div>{due.length ? <><ul>{due.map((item) => <li key={item.id}>{item.text}</li>)}</ul><div className="reminder-toast-actions"><button disabled={busy} onClick={() => void snooze(5)}>稍后 5 分钟</button><button disabled={busy} onClick={() => void snooze(10)}>稍后 10 分钟</button><button disabled={busy} onClick={() => { setDue([]); setMessage('已完成。'); }}>知道了</button></div></> : <span>{message}</span>}</div>;
}

export function ReminderSettingsPanel({ config }: { config: any }) {
  const connection = usePetdStatus();
  const [items, setItems] = useState<Reminder[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'minutes' | 'clock' | 'datetime'>('minutes');
  const [minutes, setMinutes] = useState('20');
  const [clock, setClock] = useState('20:30');
  const [datetime, setDatetime] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const enabled = config?.enabled !== false;
  async function refresh() {
    if (connection.state !== 'connected') return;
    try { const [nextStatus, nextList] = await Promise.all([request('reminder.status', {}), request('reminder.list', {})]); setStatus(nextStatus); setItems(nextList.items ?? []); setError(''); }
    catch (cause) { setError(showError(cause)); }
  }
  useEffect(() => { void refresh(); }, [connection.state]);
  useEffect(() => {
    const unsubscribe = subscribeEvents((frame) => {
      if (frame.event?.startsWith('reminder.')) void refresh();
    });
    return () => { unsubscribe(); };
  }, [connection.state]);
  async function create(event: React.FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value) { setError('请填写提醒内容。'); return; }
    setBusy(true); setError('');
    const timing = mode === 'minutes' ? { inMinutes: Number(minutes) } : mode === 'clock' ? { atClock: clock } : { at: new Date(datetime).toISOString() };
    try { const item = await request('reminder.create', { text: value.slice(0, 300), ...timing }); setItems((current) => [...current.filter((entry) => entry.id !== item.id), item].sort((a, b) => a.at - b.at)); setText(''); setNotice(`已设提醒：${item.text}（${timeText(item.at)}）`); await refresh(); }
    catch (cause) { setError(showError(cause)); }
    finally { setBusy(false); }
  }
  async function cancel(item: Reminder) {
    try { await request('reminder.cancel', { id: item.id }); setItems((current) => current.filter((entry) => entry.id !== item.id)); setNotice(`已取消提醒：${item.text}`); await refresh(); }
    catch (cause) { setError(showError(cause)); }
  }
  async function snooze(item: Reminder, delay: number) {
    try { const updated = await request('reminder.snooze', { id: item.id, minutes: delay }); setItems((current) => current.map((entry) => entry.id === item.id ? updated : entry).sort((a, b) => a.at - b.at)); setNotice(`已稍后 ${delay} 分钟：${item.text}`); }
    catch (cause) { setError(showError(cause)); }
  }
  return <section className="reminder-panel">
    <div className="reminder-heading"><div><span className="eyebrow">REMINDERS</span><h3>提醒</h3></div><span className={`reminder-enabled ${enabled ? 'on' : ''}`}>{enabled ? '已启用' : '已关闭'}</span></div>
    <p className="reminder-config">待响 {status?.pending ?? items.length} 条 · {status?.nextAt ? `下一条约 ${Math.max(0, Math.ceil((status.nextAt - Date.now()) / 60000))} 分钟后` : '当前没有即将响起的提醒'} · 最大待响 {config?.maxPending ?? '—'} 条 · 错过补报 {config?.catchUpHours ?? '—'} 小时</p>
    {error && <p className="reminder-error" role="alert">{error}</p>}{notice && <p className="reminder-notice" role="status">{notice}</p>}
    <form className="reminder-form" onSubmit={(event) => void create(event)}>
      <label>提醒内容<input value={text} maxLength={300} onChange={(event) => setText(event.target.value)} placeholder="喝水、休息一下…" disabled={!enabled}/><small>{text.length} / 300 字</small></label>
      <div className="reminder-time-row"><label>时间方式<select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)} disabled={!enabled}><option value="minutes">N 分钟后</option><option value="clock">今天某时（已过则明天）</option><option value="datetime">选择日期时间</option></select></label>{mode === 'minutes' ? <label>分钟<input type="number" min="0.01" max="43200" step="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} disabled={!enabled}/></label> : mode === 'clock' ? <label>时间<input type="time" value={clock} onChange={(event) => setClock(event.target.value)} disabled={!enabled}/></label> : <label>日期时间<input type="datetime-local" value={datetime} onChange={(event) => setDatetime(event.target.value)} disabled={!enabled}/></label>}</div>
      <button className="reminder-create" disabled={!enabled || busy || connection.state !== 'connected' || !text.trim() || (mode === 'datetime' && !datetime)}>{busy ? '正在保存…' : '设定提醒'}</button>
    </form>
    <div className="reminder-list-heading"><strong>待响提醒</strong><button onClick={() => void refresh()} disabled={connection.state !== 'connected'}>刷新</button></div>
    {!items.length && <p className="reminder-empty">还没有待响提醒。</p>}
    {items.map((item) => <article className="reminder-item" key={item.id}><div><strong>{item.text}</strong><span>{timeText(item.at)} · {item.inMinutes > 0 ? `${item.inMinutes} 分钟后` : '即将响起'} · 已稍后 {item.snoozes} 次</span></div><div className="reminder-item-actions"><button onClick={() => void snooze(item, 5)}>稍后</button><button className="reminder-cancel" onClick={() => void cancel(item)}>取消</button></div></article>)}
  </section>;
}
