import { useEffect, useState } from 'react';
import { request, subscribeEvents, usePetdStatus } from './petd';
import './learning-panel.css';

type Kind = 'skill' | 'prompt' | 'params' | 'preference';
type Status = 'pending' | 'approved' | 'gray' | 'rejected' | 'rolledback';
type Item = { id: string; kind: Kind; name: string; reason: string; path: string; createdAt: number; status: Status; diff?: string; contentChars: number; gray?: { percent: number; startedAt: number; rollbackAfterDays: number } };
type Detail = Item & { body: string };
const kindName: Record<Kind, string> = { skill: '技能', prompt: '提示词', params: '参数', preference: '偏好' };
const groups: Array<{ status: Status; title: string }> = [{ status: 'pending', title: '待审核' }, { status: 'gray', title: '灰度中' }, { status: 'approved', title: '已生效' }, { status: 'rejected', title: '已拒绝' }, { status: 'rolledback', title: '已回滚' }];
const statusName: Record<Status, string> = { pending: '待审核', gray: '灰度中', approved: '已生效', rejected: '已拒绝', rolledback: '已回滚' };
const errorText = (error: any) => error?.code === 'E_UNAVAILABLE' ? '学习功能当前不可用。' : error?.code === 'E_NOT_FOUND' ? '这条提案已不存在，请刷新列表。' : error?.code === 'E_CONFLICT' ? '同名产物已经存在，无法批准。' : error?.message ?? '操作失败，请重试。';

export function LearningSettingsPanel({ config }: { config: any }) {
  const connection = usePetdStatus();
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [gray, setGray] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function refresh() {
    if (connection.state !== 'connected') return;
    try { const [nextStatus, result] = await Promise.all([request('learning.status', {}), request('learning.list', {})]); setStatus(nextStatus); setItems(result.items ?? []); setError(''); }
    catch (cause) { setError(errorText(cause)); }
  }
  useEffect(() => { void refresh(); }, [connection.state]);
  useEffect(() => {
    const unsubscribe = subscribeEvents((frame) => { if (frame.event?.startsWith('learning.')) { if (selected && frame.data?.id === selected.id && frame.event === 'learning.rolledback') setSelected(null); void refresh(); } });
    return () => { unsubscribe(); };
  }, [connection.state, selected?.id]);
  async function open(item: Item) {
    try { const result = await request('learning.get', { id: item.id }); setSelected(result.item); setGray(true); }
    catch (cause) { setError(errorText(cause)); }
  }
  async function decide(action: 'approve' | 'reject' | 'rollback') {
    if (!selected || busy) return;
    if (action === 'approve' && !window.confirm(`批准「${selected.name}」？${selected.kind === 'skill' ? '这会把候选技能转正并供后续聊天使用。' : '这会将学习内容加入系统提示词。'}${gray ? ' 默认以灰度方式生效。' : ' 将立即全量生效。'}`)) return;
    if (action === 'reject' && !window.confirm(`拒绝「${selected.name}」？提案文件会保留用于审计，但不会生效。`)) return;
    if (action === 'rollback' && !window.confirm(`撤销「${selected.name}」？${selected.kind === 'skill' ? '对应技能文件会被删除。' : '学习产物会被删除。'}`)) return;
    setBusy(true); setError('');
    try {
      if (action === 'approve') await request('learning.approve', { id: selected.id, gray });
      else if (action === 'reject') await request('learning.reject', { id: selected.id });
      else await request('learning.rollback', { id: selected.id });
      setNotice(action === 'approve' ? gray ? `已批准并进入灰度：${selected.name}` : `已全量批准：${selected.name}` : action === 'reject' ? `已拒绝：${selected.name}` : `已撤销：${selected.name}`);
      setSelected(null); await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  const grayDays = Number(config?.grayDays ?? 7);
  return <section className="learning-panel">
    <div className="learning-heading"><div><span className="eyebrow">LEARNING LOOP</span><h3>它想学的东西</h3></div><span className={`learning-state ${status?.enabled ? 'on' : ''}`}>{status ? status.enabled ? '已启用' : '已关闭' : '读取中…'}</span></div>
    <p className="learning-note">提案只会成为候选内容；批准前不会影响行为。批准、拒绝和撤销都由你决定。默认先灰度，不会自动批准。</p>
    {error && <p className="learning-error" role="alert">{error}</p>}{notice && <p className="learning-notice" role="status">{notice}</p>}
    {status && <div className="learning-counts">{groups.map((group) => <div key={group.status}><span>{group.title}</span><strong>{status.counts?.[group.status] ?? items.filter((item) => item.status === group.status).length}</strong></div>)}</div>}
    <div className="learning-setting-summary">{status?.requireApproval ? '需要用户逐条批准' : '批准策略由后端控制'} · 灰度默认 {config?.grayPercent ?? '—'}% · {config?.grayDays ?? '—'} 天后可考虑转正 · 待审上限 {status?.maxPending ?? config?.maxPending ?? '—'}</div>
    {groups.map((group) => {
      const groupItems = items.filter((item) => item.status === group.status);
      return <div className="learning-group" key={group.status}><div className="learning-group-heading"><strong>{group.title}</strong><span>{groupItems.length}</span></div>{!groupItems.length && <p className="learning-empty">没有{group.title}内容。</p>}{groupItems.map((item) => {
        const readyToGraduate = item.status === 'gray' && item.gray && Date.now() >= item.gray.startedAt + item.gray.rollbackAfterDays * 86400000;
        return <article className="learning-item" key={item.id}><button className="learning-item-main" onClick={() => void open(item)}><div><span className={`learning-kind ${item.kind}`}>{kindName[item.kind] ?? item.kind}</span><span className={`learning-status ${item.status}`}>{statusName[item.status]}</span><strong>{item.name}</strong></div><p>{item.reason}</p><small>{new Date(item.createdAt).toLocaleString()} · {item.contentChars} 字 · {item.path}</small>{item.gray && <small>灰度中：约 {item.gray.percent}% 的回合会参考它 · {new Date(item.gray.startedAt).toLocaleDateString()} 开始 · {item.gray.rollbackAfterDays} 天回滚期</small>}{readyToGraduate && <small className="learning-graduate-note">已达到建议灰度期限；当前没有自动转正接口，请人工确认后按需全量批准。</small>}</button><button className="learning-detail-button" onClick={() => void open(item)}>详情</button></article>;
      })}</div>;
    })}
    {selected && <div className="learning-backdrop" onClick={() => setSelected(null)}><div className="learning-detail" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><div className="learning-detail-head"><div><span className={`learning-kind ${selected.kind}`}>{kindName[selected.kind]}</span><span className={`learning-status ${selected.status}`}>{statusName[selected.status]}</span><h4>{selected.name}</h4></div><button onClick={() => setSelected(null)}>关闭</button></div><p className="learning-reason">{selected.reason} · {new Date(selected.createdAt).toLocaleString()}</p>{selected.diff && <section><strong>Diff</strong><pre>{selected.diff}</pre></section>}<section><strong>候选正文</strong><pre>{selected.body}</pre></section>{selected.status === 'pending' && <><label className="learning-gray-choice"><input type="checkbox" checked={gray} onChange={(event) => setGray(event.target.checked)}/>默认灰度批准（{config?.grayPercent ?? 20}% 回合参考，最多 {grayDays} 天）</label><div className="learning-actions"><button className="learning-reject" onClick={() => void decide('reject')} disabled={busy}>拒绝</button><button className="learning-approve" onClick={() => void decide('approve')} disabled={busy}>{busy ? '处理中…' : gray ? '批准（默认灰度）' : '直接全量批准'}</button></div></>}{(selected.status === 'approved' || selected.status === 'gray') && <div className="learning-actions"><button className="learning-reject" onClick={() => void decide('rollback')} disabled={busy}>撤销并删除产物</button></div>}</div></div>}
  </section>;
}
