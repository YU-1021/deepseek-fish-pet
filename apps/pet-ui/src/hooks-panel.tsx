import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { request, subscribeEvents, usePetdStatus } from './petd';
import './hooks-panel.css';

type Risk = 'low' | 'medium' | 'high';
type PendingApproval = {
  id: string; kind: 'tool' | 'method'; name: string; ruleId: string; title: string;
  detail?: string; risk?: Risk; riskReason?: string; requestedAt: number; deadlineAt: number; sessionId?: string;
};
type HookRule = {
  id: string; description: string; enabled: boolean; kind: 'tool' | 'method'; names: string[];
  action: 'allow' | 'ask' | 'deny'; message?: string; argContains?: string; priority: number; builtin?: boolean;
};
type HookStatus = {
  enabled: boolean; mode: 'rules' | 'smart'; approvalEnabled: boolean; approvalTimeoutMs: number;
  ruleCount: number; pendingCount: number; sessionAllowedCount: number; riskEnabled: boolean;
};

const errorText = (error: any) => error?.message ?? '操作失败，请重试。';
const riskLabel: Record<Risk, string> = { low: '低风险', medium: '中风险', high: '高风险' };

export function ApprovalCoordinator() {
  const connection = usePetdStatus();
  const [assessmentNotice, setAssessmentNotice] = useState('');
  const cuaPending = useRef(false);
  useEffect(() => {
    if (connection.state !== 'connected') return;
    let live = true;
    const refresh = () => request('approval.list', {}).then((result) => {
      if (live && result.pending.length) void window.petdBootstrap?.openApprovalWindow?.();
    }).catch(() => {});
    void refresh();
    const unsubscribe = subscribeEvents((frame) => {
      if (frame.event === 'approval.requested') void window.petdBootstrap?.openApprovalWindow?.();
      if (frame.event === 'cua.permission') { cuaPending.current = true; void window.petdBootstrap?.openCuaPermissionWindow?.(frame.data); }
      if (frame.event === 'hooks.assessed') {
        const data = frame.data ?? {};
        if (data.risk === 'low' || data.risk === 'medium') {
          setAssessmentNotice(`${data.risk === 'low' ? '低风险' : '中风险'} · ${data.name ?? '操作'}：${data.reason ?? '已完成风险评估'}`);
          window.setTimeout(() => setAssessmentNotice(''), 4200);
        }
      }
      if (frame.event === 'hooks.blocked') {
        const data = frame.data ?? {};
        setAssessmentNotice(data.message || `已拦截操作：${data.name ?? '危险动作'}`);
        window.setTimeout(() => setAssessmentNotice(''), 5000);
      }
      if (frame.event === 'approval.resolved') window.setTimeout(() => {
        if (!live) return;
        void request('approval.list', {}).then((result) => {
          if (!result.pending.length && !cuaPending.current) window.setTimeout(() => { if (live && !cuaPending.current) void window.petdBootstrap?.closeApprovalWindow?.(); }, 4500);
        }).catch(() => {});
      }, 100);
    });
    const removePermissionListener = window.petdBootstrap?.onCuaPermission?.((permission) => { cuaPending.current = !!permission; });
    return () => { live = false; unsubscribe(); removePermissionListener?.(); };
  }, [connection.state]);
  return assessmentNotice ? <div className="hooks-toast" role="status">{assessmentNotice}</div> : null;
}

function usePendingApprovals() {
  const connection = usePetdStatus();
  const [pending, setPending] = useState<PendingApproval[]>([]);
  useEffect(() => {
    if (connection.state !== 'connected') { setPending([]); return; }
    let live = true;
    request('approval.list', {}).then((result) => {
      if (live) setPending((current) => [...result.pending, ...current.filter((item) => !result.pending.some((row: PendingApproval) => row.id === item.id))]);
    }).catch(() => {});
    const unsubscribe = subscribeEvents((frame) => {
      if (frame.event === 'approval.requested' && frame.data?.id) {
        setPending((current) => [frame.data as PendingApproval, ...current.filter((item) => item.id !== frame.data.id)]);
      }
      if (frame.event === 'approval.resolved' && frame.data?.id) setPending((current) => current.filter((item) => item.id !== frame.data.id));
    });
    return () => { live = false; unsubscribe(); };
  }, [connection.state]);
  return [pending, setPending] as const;
}

export function ApprovalOverlay() {
  const [pending, setPending] = usePendingApprovals();
  const [remember, setRemember] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState('');
  const current = pending[0];
  useEffect(() => {
    if (!current) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [current?.id]);
  useEffect(() => {
    const unsubscribe = subscribeEvents((frame) => {
      if (frame.event !== 'approval.resolved') return;
      const data = frame.data ?? {};
      setNotice(data.reason === 'timeout' ? '没来得及回答，已自动拒绝。' : data.accepted ? '你允许了这次操作。' : '你拒绝了这次操作。');
      window.setTimeout(() => setNotice(''), 5000);
      if (new URLSearchParams(window.location.search).has('approval')) window.setTimeout(() => { void window.petdBootstrap?.closeApprovalWindow?.(); }, 4500);
    });
    return () => { unsubscribe(); };
  }, []);
  async function answer(item: PendingApproval, accepted: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await request('approval.answer', { id: item.id, accepted, remember: accepted && remember[item.id] === true });
      if (!result.found) {
        setPending((items) => items.filter((entry) => entry.id !== item.id));
        setNotice('这条审批已失效或已由其他窗口处理。');
      }
    } catch (error) { setNotice(errorText(error)); }
    finally { setBusy(false); }
  }
  const seconds = current ? Math.max(0, Math.ceil((current.deadlineAt - now) / 1000)) : 0;
  const expired = !!current && seconds === 0;
  const approvalWindow = new URLSearchParams(window.location.search).has('approval');
  return <>
    {current && <section className={`approval-overlay ${approvalWindow ? 'approval-window-card' : ''}`} role="alertdialog" aria-live="assertive" aria-label="等待你确认的操作">
      <div className="approval-head"><strong>操作确认</strong><span className="approval-queue">{pending.length > 1 ? `还有 ${pending.length - 1} 条` : '需要你确认'}</span></div>
      {current.risk === 'high' && <span className="approval-risk high">高风险</span>}
      {current.risk && current.risk !== 'high' && <span className={`approval-risk ${current.risk}`}>{riskLabel[current.risk]}</span>}
      <h3>{current.title || current.name}</h3>
      {current.detail && <p className="approval-detail">{current.detail}</p>}
      {current.riskReason && <p className="approval-reason">风险原因：{current.riskReason}</p>}
      <div className="approval-meta"><span>{current.kind === 'tool' ? '工具' : '方法'} · {current.name}</span><span>{current.sessionId ? `会话 ${current.sessionId.slice(0, 8)}` : `规则 ${current.ruleId}`} · {expired ? '等待超时，后端正在拒绝' : `${seconds} 秒后自动拒绝`}</span></div>
      <label className="approval-remember"><input type="checkbox" checked={remember[current.id] === true} onChange={(event) => setRemember((items) => ({ ...items, [current.id]: event.target.checked }))}/>本次运行都允许（该规则）</label>
      {expired ? <div className="approval-expired">没来得及回答，已自动拒绝。</div> : <div className="approval-actions"><button disabled={busy} onClick={() => void answer(current, false)}>拒绝</button><button className="approve" disabled={busy} onClick={() => void answer(current, true)}>{busy ? '提交中…' : '允许'}</button></div>}
    </section>}
    {notice && <div className="approval-notice" role="status">{notice}</div>}
  </>;
}

type RuleDraft = { description: string; kind: 'tool' | 'method'; names: string; action: 'allow' | 'ask' | 'deny'; message: string; argContains: string; priority: string };
const emptyRule: RuleDraft = { description: '', kind: 'tool', names: '', action: 'ask', message: '', argContains: '', priority: '10' };

export function HooksSettingsPanel() {
  const connection = usePetdStatus();
  const [status, setStatus] = useState<HookStatus | null>(null);
  const [rules, setRules] = useState<HookRule[]>([]);
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [form, setForm] = useState(emptyRule);
  const [editingId, setEditingId] = useState('');
  const [assessKind, setAssessKind] = useState<'tool' | 'method'>('tool');
  const [assessName, setAssessName] = useState('');
  const [assessArgs, setAssessArgs] = useState('{}');
  const [assessment, setAssessment] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (connection.state !== 'connected') return;
    setError('');
    try {
      const [nextStatus, nextRules, nextPending] = await Promise.all([
        request('hooks.status', {}), request('hooks.list', {}), request('approval.list', {}),
      ]);
      setStatus(nextStatus); setRules(nextRules.rules); setPending(nextPending.pending);
    } catch (cause) { setError(errorText(cause)); }
  }
  useEffect(() => { void refresh(); }, [connection.state]);
  useEffect(() => {
    const unsubscribe = subscribeEvents((frame) => {
      if (frame.event === 'hooks.changed' || frame.event === 'approval.requested' || frame.event === 'approval.resolved') void refresh();
    });
    return () => { unsubscribe(); };
  }, [connection.state]);
  async function answer(item: PendingApproval, accepted: boolean) {
    try { await request('approval.answer', { id: item.id, accepted }); await refresh(); }
    catch (cause) { setError(errorText(cause)); }
  }
  async function toggleRule(rule: HookRule) {
    try { await request('hooks.toggle', { id: rule.id, enabled: !rule.enabled }); await refresh(); }
    catch (cause) { setError(errorText(cause)); }
  }
  function beginEdit(rule: HookRule) {
    setEditingId(rule.id);
    setForm({ description: rule.description ?? '', kind: rule.kind, names: rule.names.join(', '), action: rule.action, message: rule.message ?? '', argContains: rule.argContains ?? '', priority: String(rule.priority) });
  }
  function clearForm() { setEditingId(''); setForm(emptyRule); }
  async function saveRule(event: FormEvent) {
    event.preventDefault();
    const payload = {
      description: form.description.trim(), kind: form.kind, names: form.names.split(',').map((name) => name.trim()).filter(Boolean),
      action: form.action, ...(form.message.trim() ? { message: form.message.trim() } : {}),
      ...(form.argContains.trim() ? { argContains: form.argContains.trim() } : {}), priority: Number(form.priority),
    };
    if (!payload.names.length) { setError('至少填写一个规则名称，可使用 * 和 ? 通配。'); return; }
    setBusy(true); setError('');
    try {
      if (editingId) await request('hooks.update', { id: editingId, ...payload });
      else await request('hooks.create', payload);
      clearForm(); await refresh();
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  async function deleteRule(rule: HookRule) {
    if (rule.builtin || !window.confirm(`删除规则“${rule.description || rule.id}”？`)) return;
    try { await request('hooks.delete', { id: rule.id }); await refresh(); }
    catch (cause) { setError(errorText(cause)); }
  }
  async function previewAssessment(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setAssessment(null);
    try {
      const args = assessArgs.trim() ? JSON.parse(assessArgs) : undefined;
      const result = await request('hooks.assess', { kind: assessKind, name: assessName.trim(), ...(args === undefined ? {} : { args }) }, 35000);
      setAssessment(result);
    } catch (cause) { setError(cause instanceof SyntaxError ? '参数摘要必须是有效 JSON。' : errorText(cause)); }
    finally { setBusy(false); }
  }
  function setField<K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) { setForm((current) => ({ ...current, [key]: value })); }

  return <section className="hooks-panel">
    <div className="hooks-title"><div><span className="eyebrow">SAFETY GATE</span><h3>危险动作确认</h3></div><button onClick={() => void refresh()} disabled={connection.state !== 'connected'}>刷新</button></div>
    {error && <div className="hooks-error" role="alert">{error}</div>}
    <div className="hooks-status-grid">
      <div><span>审批门</span><strong>{status ? status.enabled ? '已开启' : '已关闭' : '读取中…'}</strong></div>
      <div><span>模式</span><strong>{status?.mode === 'smart' ? '智能评审' : status?.mode === 'rules' ? '仅规则' : '—'}</strong></div>
      <div><span>风险模型</span><strong>{status ? status.riskEnabled ? '已开启' : '已关闭' : '—'}</strong></div>
      <div><span>审批状态</span><strong>{status ? status.approvalEnabled ? '等待确认时询问' : '等待确认时拒绝' : '—'}</strong></div>
      <div><span>等待中</span><strong>{pending.length}</strong></div>
      <div><span>运行内记住</span><strong>{status?.sessionAllowedCount ?? '—'}</strong></div>
    </div>
    <p className="hooks-config-note">全局开关、模式和超时目前只读：petd 尚无审批配置写入方法。关闭审批开关会让 ask 规则直接拒绝，不会放行。</p>
    <label className="hooks-config-readonly">审批超时 <strong>{status ? `${Math.ceil(status.approvalTimeoutMs / 1000)} 秒` : '—'}</strong></label>

    <div className="hooks-subhead"><h4>待回答审批</h4><span>{pending.length} 条</span></div>
    {!pending.length && <p className="hooks-muted">当前没有等待确认的操作。</p>}
    {pending.map((item) => <article className="hooks-pending" key={item.id}>
      <div className="hooks-rule-head"><strong>{item.title || item.name}</strong>{item.risk && <span className={`approval-risk ${item.risk}`}>{riskLabel[item.risk]}</span>}</div>
      <p>{item.detail || `${item.kind} · ${item.name}`}</p>{item.riskReason && <small>{item.riskReason}</small>}
      <div className="hooks-pending-actions"><button onClick={() => void answer(item, false)}>拒绝</button><button className="approve" onClick={() => void answer(item, true)}>允许</button></div>
    </article>)}

    <div className="hooks-subhead"><h4>规则列表</h4><span>{rules.length} 条 · 规则优先于模型评审</span></div>
    <div className="hooks-rule-list">{rules.map((rule) => <article className="hooks-rule" key={rule.id}>
      <div className="hooks-rule-head"><strong>{rule.description || rule.id}</strong><div>{rule.builtin && <span className="builtin-badge">内置</span>}<span className={`rule-action ${rule.action}`}>{rule.action === 'ask' ? '询问' : rule.action === 'deny' ? '拒绝' : '允许'}</span></div></div>
      <p>{rule.kind} · {rule.names.join(', ')}{rule.argContains ? ` · 参数含「${rule.argContains}」` : ''}</p>
      <div className="hooks-rule-foot"><small>优先级 {rule.priority}{rule.message ? ` · ${rule.message}` : ''}</small><div><button onClick={() => void toggleRule(rule)}>{rule.enabled ? '停用' : '启用'}</button>{!rule.builtin && <><button onClick={() => beginEdit(rule)}>编辑</button><button className="danger-link" onClick={() => void deleteRule(rule)}>删除</button></>}</div></div>
    </article>)}</div>

    <form className="hooks-rule-form" onSubmit={(event) => void saveRule(event)}>
      <h4>{editingId ? '编辑规则' : '新建规则'}</h4>
      <label>说明<input value={form.description} maxLength={120} onChange={(event) => setField('description', event.target.value)}/></label>
      <div className="hooks-form-row"><label>类别<select value={form.kind} onChange={(event) => setField('kind', event.target.value as 'tool' | 'method')}><option value="tool">工具</option><option value="method">方法</option></select></label><label>动作<select value={form.action} onChange={(event) => setField('action', event.target.value as 'allow' | 'ask' | 'deny')}><option value="ask">询问</option><option value="allow">允许</option><option value="deny">拒绝</option></select></label><label>优先级<input type="number" min="0" max="1000" value={form.priority} onChange={(event) => setField('priority', event.target.value)}/></label></div>
      <label>名称（逗号分隔，支持 * ?）<input required value={form.names} onChange={(event) => setField('names', event.target.value)} placeholder="memory_delete, file_*"/></label>
      <label>参数需包含（可选）<input value={form.argContains} onChange={(event) => setField('argContains', event.target.value)}/></label>
      <label>提示文案（可选）<input maxLength={300} value={form.message} onChange={(event) => setField('message', event.target.value)}/></label>
      <div className="hooks-form-actions">{editingId && <button type="button" onClick={clearForm}>取消编辑</button>}<button className="primary-action" disabled={busy || connection.state !== 'connected'}>{busy ? '保存中…' : editingId ? '保存规则' : '创建规则'}</button></div>
    </form>

    <form className="hooks-assess-form" onSubmit={(event) => void previewAssessment(event)}>
      <h4>预览风险（只评估，不执行）</h4>
      <div className="hooks-form-row"><label>类别<select value={assessKind} onChange={(event) => setAssessKind(event.target.value as 'tool' | 'method')}><option value="tool">工具</option><option value="method">方法</option></select></label><label>操作名<input required value={assessName} onChange={(event) => setAssessName(event.target.value)}/></label></div>
      <label>参数摘要 JSON<textarea rows={3} value={assessArgs} onChange={(event) => setAssessArgs(event.target.value)}/></label>
      <button disabled={busy || !assessName.trim() || connection.state !== 'connected'}>{busy ? '评估中…' : '评估风险'}</button>
      {assessment && <div className="hooks-assessment"><span className={`approval-risk ${assessment.level}`}>{riskLabel[assessment.level as Risk]}</span><p>{assessment.reason}</p>{assessment.cached && <small>使用缓存评估</small>}{assessment.fallback && <small>模型不可用，使用安全回退等级</small>}</div>}
      <p className="hooks-muted">预览结果不会替你批准或拒绝操作。智能模式下，低/中风险由后端自动放行，高风险仍会询问。</p>
    </form>
  </section>;
}
