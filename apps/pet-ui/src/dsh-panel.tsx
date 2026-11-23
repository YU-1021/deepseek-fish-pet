import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { request, subscribeEvents, usePetdStatus } from './petd';
import './dsh-panel.css';

type Snapshot = { workspace?: string; sessionId?: string; state?: 'idle' | 'thinking' | 'working'; active?: boolean; turn?: number | null; step?: number | null; tool?: string | null; lastText?: string | null; lastEventType?: string | null; agoMs?: number };
const stateText: Record<string, string> = { idle: '空闲', thinking: '思考中', working: '正在工作' };
const errorText = (error: any) => error?.code === 'E_UNAVAILABLE' ? 'DSH 当前不可用。检查设置中的 exePath、cliPath 和启用状态。' : error?.code === 'E_BAD_PARAMS' ? '请输入任务内容。' : error?.message ?? '操作失败，请重试。';

export function DshSettingsPanel({ config }: { config: any }) {
  const connection = usePetdStatus();
  const [status, setStatus] = useState<any>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function refresh() {
    if (connection.state !== 'connected') return;
    try { const [nextStatus, observed] = await Promise.all([request('dsh.status', {}), request('dsh.observe', {})]); setStatus(nextStatus); setSnapshot(observed.session ?? null); setError(''); }
    catch (cause) { setError(errorText(cause)); }
  }
  useEffect(() => { void refresh(); }, [connection.state]);
  useEffect(() => {
    const unsubscribe = subscribeEvents((frame) => {
      if (frame.event === 'dsh.activity') setSnapshot(frame.data as Snapshot);
      if (frame.event === 'dsh.status') void refresh();
      if (frame.event === 'dsh.event' && frame.data?.text) setNotice(`DSH 活动：${String(frame.data.text).slice(0, 100)}`);
    });
    return () => { unsubscribe(); };
  }, [connection.state]);
  async function startRuntime() {
    if (starting) return;
    setStarting(true); setError(''); setNotice('正在启动 DSH 私有 runtime…');
    try { await request('dsh.start', {}, 60_000); setNotice('DSH runtime 已启动。'); await refresh(); }
    catch (cause) { setError(errorText(cause)); setNotice(''); }
    finally { setStarting(false); }
  }
  async function stopRuntime() {
    if (!window.confirm('停止桌宠自己的 DSH runtime？不会影响 DSH 桌面应用会话。')) return;
    try { await request('dsh.stop', {}, 30_000); setNotice('已停止私有 runtime。'); await refresh(); }
    catch (cause) { setError(errorText(cause)); }
  }
  async function ask(event: FormEvent) {
    event.preventDefault(); const task = text.trim(); if (!task || busy) return;
    setBusy(true); setError(''); setAnswer(null); setNotice('正在等待 DSH 完成本轮任务…这会消耗模型额度。');
    try { const result = await request('dsh.ask', { text: task, ...(config?.askTimeoutMs ? { timeoutMs: config.askTimeoutMs } : {}) }, (config?.askTimeoutMs ?? 120_000) + 20_000); setAnswer(result); setText(''); setNotice('DSH 已完成本轮任务。'); }
    catch (cause) { setError(errorText(cause)); setNotice(''); }
    finally { setBusy(false); await refresh(); }
  }
  const observation = snapshot ?? status?.observer?.session ?? null;
  return <section className="dsh-panel">
    <div className="dsh-heading"><div><span className="eyebrow">DEEPSEEK HARNESS</span><h3>DSH 桥</h3></div><span className={`dsh-state ${status?.enabled ? 'on' : ''}`}>{status ? status.enabled ? '已启用' : '已关闭' : '读取中…'}</span></div>
    <p className="dsh-privacy">观察只读、不花 token、不上传；不会读取或显示 DSH 会话全文。把任务交给 DSH 会使用模型额度。</p>
    {error && <p className="dsh-error" role="alert">{error}</p>}{notice && <p className="dsh-notice" role="status">{notice}</p>}
    <div className="dsh-status-grid"><div><span>观察</span><strong>{status?.observe ? '开启' : '关闭'}</strong></div><div><span>私有 runtime</span><strong>{status?.runtime?.running ? `运行中 · PID ${status.runtime.pid ?? '—'}` : '未启动'}</strong></div><div><span>观察状态</span><strong>{stateText[observation?.state ?? 'idle']}{observation?.state === 'working' && observation.tool ? ` · ${observation.tool}` : ''}</strong></div><div><span>审批待答</span><strong>{status?.pendingApprovals ?? 0}</strong></div></div>
    <div className="dsh-observation"><strong>桌面观察快照</strong><span>工作区：{observation?.workspace || '未观察到活跃会话'}</span><span>会话：{observation?.sessionId || '—'}</span>{observation?.state === 'working' && observation.tool && <small>正在使用 {observation.tool}</small>}</div>
    <div className="dsh-runtime-actions"><button onClick={() => void refresh()} disabled={connection.state !== 'connected'}>立即观察</button>{status?.enabled && <>{status?.runtime?.running ? <button onClick={() => void stopRuntime()}>停止私有 runtime</button> : <button onClick={() => void startRuntime()} disabled={starting}>{starting ? '启动中…' : '启动私有 runtime'}</button>}</>}</div>
    {status?.enabled && <form className="dsh-ask-form" onSubmit={(event) => void ask(event)}><label>交给 DSH 的任务<textarea rows={3} maxLength={20000} value={text} onChange={(event) => setText(event.target.value)} placeholder="描述一个希望 DSH 完成的任务…"/></label><button disabled={!text.trim() || busy || connection.state !== 'connected'}>{busy ? 'DSH 正在工作…' : '交给 DSH（会花 token）'}</button></form>}
    {answer && <div className="dsh-answer"><strong>本轮回答</strong><p>{answer.text}</p><small>回合 {answer.turn ?? '—'} · {Math.round(answer.durationMs / 1000)} 秒</small></div>}
    {status?.lastError && <small className="dsh-last-error">最近错误：{status.lastError}</small>}
    <div className="dsh-config-readonly">配置只读 · 引擎路径：{status?.paths?.exePath || config?.exePath || '未配置'} · 策略：{config?.approvalPolicy ?? '—'}</div>
  </section>;
}

type DshApproval = { id: string; sessionId: string; toolName: string; reason: string; at: number };
export function DshApprovalOverlay() {
  const [approval, setApproval] = useState<DshApproval | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    void window.petdBootstrap?.readDshApproval?.().then((value) => { if (live) setApproval(value); });
    const unsubscribe = window.petdBootstrap?.onDshApproval?.((value) => { setApproval(value); setNotice(''); });
    return () => { live = false; unsubscribe?.(); };
  }, []);
  useEffect(() => { if (!approval) return; const timer = window.setInterval(() => setNow(Date.now()), 500); return () => window.clearInterval(timer); }, [approval?.id]);
  useEffect(() => {
    if (!approval || now - approval.at < 120_000) return;
    const expired = approval; setApproval(null); setNotice('没来得及回答，DSH 已自动拒绝。');
    void window.petdBootstrap?.clearDshApproval?.(expired.id);
    const timer = window.setTimeout(async () => {
      try { const [pending, cua] = await Promise.all([request('approval.list', {}), window.petdBootstrap?.readCuaPermission?.()]); if (!pending.pending.length && !cua) await window.petdBootstrap?.closeApprovalWindow?.(); }
      catch { if (!await window.petdBootstrap?.readCuaPermission?.()) await window.petdBootstrap?.closeApprovalWindow?.(); }
    }, 4500);
    return () => window.clearTimeout(timer);
  }, [approval?.id, now]);
  async function answer(outcome: 'allowed-once' | 'rejected') {
    if (!approval || busy) return;
    setBusy(true);
    try { const result = await request('dsh.approval.answer', { id: approval.id, outcome }); setNotice(result.resolved ? outcome === 'allowed-once' ? '已允许 DSH 本次工具操作。' : '已拒绝 DSH 本次工具操作。' : '这条审批已超时。'); setApproval(null); await window.petdBootstrap?.clearDshApproval?.(approval.id); }
    catch (cause) { setNotice((cause as any)?.message ?? '回答失败，请重试。'); }
    finally { setBusy(false); }
    window.setTimeout(async () => {
      try { const [pending, cua] = await Promise.all([request('approval.list', {}), window.petdBootstrap?.readCuaPermission?.()]); if (!pending.pending.length && !cua) await window.petdBootstrap?.closeApprovalWindow?.(); }
      catch { if (!await window.petdBootstrap?.readCuaPermission?.()) await window.petdBootstrap?.closeApprovalWindow?.(); }
    }, 4500);
  }
  const remaining = approval ? Math.max(0, Math.ceil((120_000 - (now - approval.at)) / 1000)) : 0;
  return <>{approval && <section className="dsh-approval-card" role="alertdialog" aria-live="assertive"><div className="dsh-approval-head"><strong>DSH 工具授权</strong><span>DSH</span></div><p>{approval.toolName || '工具操作'}</p><p>{approval.reason || 'DSH 请求执行一次工具操作。'}</p><small>{remaining ? `${remaining} 秒后自动拒绝` : '没来得及回答，已拒绝。'}</small>{remaining > 0 && <div className="dsh-approval-actions"><button disabled={busy} onClick={() => void answer('rejected')}>拒绝</button><button className="allow-once" disabled={busy} onClick={() => void answer('allowed-once')}>{busy ? '提交中…' : '允许一次'}</button></div>}</section>}{notice && <div className="dsh-approval-notice" role="status">{notice}</div>}</>;
}
