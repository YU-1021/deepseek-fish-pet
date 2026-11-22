import { useEffect, useState } from 'react';
import { request, subscribeEvents, usePetdStatus } from './petd';
import './agent-audit-panel.css';

type AuditMeta = { id: string; ts: string; actor: 'user' | 'agent' | 'system'; action: 'write' | 'delete' | 'rollback'; path: string; zone: string; reason: string; diffChars: number; sessionId?: string };
type AuditEntry = AuditMeta & { before: { text: string; truncated?: boolean } | null; after: { text: string; truncated?: boolean } | null; diff: string };
const errorText = (error: any) => error?.code === 'E_NOT_FOUND' ? '这条记录已不存在，请刷新列表。' : error?.code === 'E_CONFLICT' ? '文件在审计记录之后又被改过。' : error?.message ?? '操作失败，请重试。';
const actorName: Record<string, string> = { user: '用户', agent: 'AI', system: '系统' };
const actionName: Record<string, string> = { write: '写入', delete: '删除', rollback: '回滚' };

export function AgentAuditSettingsPanel() {
  const connection = usePetdStatus();
  const [scope, setScope] = useState<any>(null);
  const [entries, setEntries] = useState<AuditMeta[]>([]);
  const [total, setTotal] = useState(0);
  const [pathFilter, setPathFilter] = useState('');
  const [actor, setActor] = useState('');
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    if (connection.state !== 'connected') return;
    try {
      const [nextScope, result] = await Promise.all([
        request('agent.scope', {}), request('agent.audit.list', { ...(pathFilter.trim() ? { path: pathFilter.trim() } : {}), ...(actor ? { actor } : {}), limit: 100 }),
      ]);
      setScope(nextScope); setEntries(result.entries ?? []); setTotal(result.total ?? 0); setError('');
    } catch (cause) { setError(errorText(cause)); }
  }
  useEffect(() => { void refresh(); }, [connection.state, pathFilter, actor]);
  useEffect(() => {
    const unsubscribe = subscribeEvents((frame) => { if (frame.event === 'agent.rollback') { setSelected(null); setNotice(`已回滚：${frame.data?.path ?? ''}`); void refresh(); } });
    return () => { unsubscribe(); };
  }, [connection.state, pathFilter, actor]);
  async function open(entry: AuditMeta) {
    setError('');
    try { const result = await request('agent.audit.get', { id: entry.id }); setSelected(result.entry); }
    catch (cause) { setError(errorText(cause)); }
  }
  async function rollback(force = false) {
    if (!selected || busy) return;
    if (!force && !window.confirm(`撤销 ${selected.actor === 'agent' ? 'AI' : actorName[selected.actor]} 对「${selected.path}」的这次改动？将恢复为改动前的内容，并留下新的审计记录。`)) return;
    if (force && !window.confirm(`强制覆盖「${selected.path}」当前内容？此文件在这条记录之后又被修改过。`)) return;
    setBusy(true); setError('');
    try { const result = await request('agent.rollback', { id: selected.id, ...(force ? { force: true } : {}), reason: '通过 pet-ui 审计面板撤销' }); setNotice(`已恢复 ${result.path}（${result.restored === 'deleted' ? '删除状态' : '改动前内容'}）`); setSelected(null); await refresh(); }
    catch (cause) {
      setError(errorText(cause));
      if ((cause as any)?.code === 'E_CONFLICT' && (cause as any)?.details) {
        const details = (cause as any).details;
        setNotice(`检测到并发修改。当前 hash：${details.currentHash ?? '未知'}，预期 hash：${details.expectedHash ?? '未知'}`);
      }
    } finally { setBusy(false); }
  }
  const zones = Array.isArray(scope?.zones) ? scope.zones : [];
  return <section className="agent-audit-panel">
    <div className="agent-audit-heading"><div><span className="eyebrow">AI CHANGE AUDIT</span><h3>AI 改动记录</h3></div><span>{total} 条记录</span></div>
    <div className="agent-scope"><strong>AI 能写什么</strong><p>{scope?.scope ?? '正在读取写入范围…'}</p><p>记忆区：{scope?.memoryZone ?? '—'} · 允许目录/后缀：{zones.join('、') || '—'}</p><small>代码、普通配置与密钥不在 AI 写入范围。审计文件：{scope?.auditFile ?? '—'}</small></div>
    {error && <p className="agent-audit-error" role="alert">{error}</p>}{notice && <p className="agent-audit-notice" role="status">{notice}</p>}
    <div className="agent-audit-filters"><label>筛选路径<input value={pathFilter} onChange={(event) => setPathFilter(event.target.value)} placeholder="例如 SOUL.agent.md"/></label><label>操作者<select value={actor} onChange={(event) => setActor(event.target.value)}><option value="">全部</option><option value="agent">AI</option><option value="user">用户</option><option value="system">系统</option></select></label><button onClick={() => void refresh()} disabled={connection.state !== 'connected'}>刷新</button></div>
    {!entries.length && <p className="agent-audit-empty">筛选范围内没有审计记录。</p>}
    <div className="agent-audit-list">{entries.map((entry) => <button className="agent-audit-row" key={entry.id} onClick={() => void open(entry)}><span className={`agent-audit-action ${entry.action}`}>{actionName[entry.action] ?? entry.action}</span><strong>{entry.path}</strong><span>{actorName[entry.actor] ?? entry.actor} · {entry.zone}</span><small>{new Date(entry.ts).toLocaleString()} · {entry.reason || '无备注'} · {entry.diffChars} 字符变化</small></button>)}</div>
    {selected && <div className="agent-audit-backdrop" onClick={() => setSelected(null)}><div className="agent-audit-detail" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><div className="agent-audit-detail-head"><div><span>{actorName[selected.actor]} · {actionName[selected.action]}</span><h4>{selected.path}</h4></div><button onClick={() => setSelected(null)}>关闭</button></div><p className="agent-audit-reason">{selected.reason || '无备注'} · {new Date(selected.ts).toLocaleString()}</p><div className="agent-audit-columns"><section><strong>改动前</strong><pre>{selected.before?.text ?? '（文件不存在）'}{selected.before?.truncated && '\n…内容已截断'}</pre></section><section><strong>改动后</strong><pre>{selected.after?.text ?? '（文件已删除）'}{selected.after?.truncated && '\n…内容已截断'}</pre></section></div><section className="agent-audit-diff"><strong>Diff</strong><pre>{selected.diff.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : ''}>{line || ' '}</span>)}</pre></section><div className="agent-audit-rollback"><button onClick={() => void rollback()} disabled={busy || selected.zone !== 'agent-file'}>{busy ? '正在恢复…' : '撤销这次改动'}</button><small>{selected.zone !== 'agent-file' ? '记忆区版本请使用 Memory 面板恢复。' : '将恢复到改动前，并生成一条新的审计记录。'}</small>{error.includes('之后又被改过') && <button className="agent-force-rollback" onClick={() => void rollback(true)} disabled={busy}>仍然覆盖（force）</button>}</div></div></div>}
  </section>;
}
