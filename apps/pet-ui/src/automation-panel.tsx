import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { request, subscribeEvents, usePetdStatus } from './petd';
import './automation-panel.css';

type Schedule = { kind: 'interval'; everyMinutes: number } | { kind: 'daily'; atClock: string } | { kind: 'once'; at: string } | { kind: 'manual' };
type Job = { id: string; name: string; prompt: string; schedule: Schedule; scheduleText: string; enabled: boolean; nextRunAt: number | null; nextInMinutes: number | null; lastRunAt: number | null; lastStatus: string | null; runCount: number };
type Run = { id: string; jobId: string; jobName: string; startedBy: string; status: string; startedAt: number; finishedAt: number | null; durationMs: number | null; output: string | null; error: string | null; usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null };
type Kind = Schedule['kind'];
const errorText = (error: any) => error?.code === 'E_UNAVAILABLE' ? '自主任务已关闭，请在主目录 config.json 打开 automation.enabled。' : error?.code === 'E_NOT_FOUND' ? '任务已被删除，列表已刷新。' : error?.code === 'E_BAD_PARAMS' ? '请检查名称、提示词和计划时间。' : error?.message ?? '操作失败，请重试。';
const dateText = (value: number | null) => value ? new Date(value).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export function AutomationSettingsPanel({ config }: { config: any }) {
  const connection = usePetdStatus();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [runs, setRuns] = useState<Record<string, Run[]>>({});
  const [expanded, setExpanded] = useState('');
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<Kind>('manual');
  const [everyMinutes, setEveryMinutes] = useState('60');
  const [atClock, setAtClock] = useState('08:00');
  const [at, setAt] = useState('');
  const [editing, setEditing] = useState('');
  const [running, setRunning] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const enabled = config?.enabled === true;
  async function refresh() {
    if (connection.state !== 'connected') return;
    try { const [nextStatus, nextJobs] = await Promise.all([request('automation.status', {}), request('automation.list', {})]); setStatus(nextStatus); setJobs(nextJobs.jobs ?? []); setError(''); }
    catch (cause) { setError(errorText(cause)); }
  }
  useEffect(() => { void refresh(); }, [connection.state]);
  useEffect(() => {
    const unsubscribe = subscribeEvents((frame) => { if (frame.event?.startsWith('automation.')) void refresh(); });
    return () => { unsubscribe(); };
  }, [connection.state]);
  function scheduleValue(): Schedule {
    if (kind === 'interval') return { kind, everyMinutes: Number(everyMinutes) };
    if (kind === 'daily') return { kind, atClock };
    if (kind === 'once') return { kind, at: new Date(at).toISOString() };
    return { kind: 'manual' };
  }
  function clearForm() { setEditing(''); setName(''); setPrompt(''); setKind('manual'); setEveryMinutes('60'); setAtClock('08:00'); setAt(''); }
  function edit(job: Job) {
    setEditing(job.id); setName(job.name); setPrompt(job.prompt); setKind(job.schedule.kind);
    if (job.schedule.kind === 'interval') setEveryMinutes(String(job.schedule.everyMinutes));
    if (job.schedule.kind === 'daily') setAtClock(job.schedule.atClock);
    if (job.schedule.kind === 'once') { const date = new Date(job.schedule.at); setAt(new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!prompt.trim()) { setError('请填写任务提示词。'); return; }
    setError('');
    try {
      const payload = { ...(name.trim() ? { name: name.trim().slice(0, 40) } : {}), prompt: prompt.trim().slice(0, 2000), schedule: scheduleValue() };
      const job = editing ? await request('automation.update', { id: editing, ...payload }) : await request('automation.create', payload);
      setNotice(editing ? `已更新：${job.name}` : `已创建：${job.scheduleText}`); clearForm(); await refresh();
    } catch (cause) { setError(errorText(cause)); }
  }
  async function toggle(job: Job) {
    try { await request(job.enabled ? 'automation.pause' : 'automation.resume', { id: job.id }); setNotice(job.enabled ? '已暂停，将从下个计划生效。' : '已恢复任务。'); await refresh(); }
    catch (cause) { setError(errorText(cause)); if ((cause as any)?.code === 'E_NOT_FOUND') await refresh(); }
  }
  async function remove(job: Job) {
    if (!window.confirm(`删除“${job.name}”？任务会删除，petd 保留已有运行记录，会话不受影响。`)) return;
    try { await request('automation.delete', { id: job.id }); setNotice(`已删除：${job.name}`); await refresh(); }
    catch (cause) { setError(errorText(cause)); }
  }
  async function run(job: Job) {
    if (running) return;
    setRunning(job.id); setError(''); setNotice('它正在干活…这次运行会消耗模型额度。');
    try { const result = await request('automation.run', { id: job.id }, 240_000) as Run; setRuns((current) => ({ ...current, [job.id]: [result, ...(current[job.id] ?? []).filter((item) => item.id !== result.id)] })); setNotice(`已完成：${job.name}`); await refresh(); }
    catch (cause) { setError(errorText(cause)); await refresh(); }
    finally { setRunning(''); }
  }
  async function loadRuns(job: Job) {
    if (expanded === job.id) { setExpanded(''); return; }
    setExpanded(job.id);
    try { const result = await request('automation.runs', { id: job.id, limit: 10 }); setRuns((current) => ({ ...current, [job.id]: result.runs ?? [] })); }
    catch (cause) { setError(errorText(cause)); }
  }
  return <section className="automation-panel">
    <div className="automation-heading"><div><span className="eyebrow">AUTONOMOUS TASKS</span><h3>自主任务</h3></div><span className={`automation-state ${enabled ? 'on' : ''}`}>{enabled ? status?.running ? '正在运行' : '已启用' : '已关闭'}</span></div>
    <p className="automation-cost">让小鱼按计划自行执行任务会消耗你的模型 API 额度。关闭时只能查看已有任务。{config && ` 每 ${config.tickSeconds ?? '—'} 秒检查一次，最多 ${config.maxJobs ?? '—'} 个任务。`}</p>
    {error && <p className="automation-error" role="alert">{error}</p>}{notice && <p className="automation-notice" role="status">{notice}</p>}
    <form className="automation-form" onSubmit={(event) => void save(event)}>
      <h4>{editing ? '编辑任务' : '新建任务'}</h4>
      <label>名称（可选，最多 40 字）<input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} disabled={!enabled}/></label>
      <label>任务提示词<textarea value={prompt} maxLength={2000} rows={4} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：总结今天的待办，并给我一个简短建议。" disabled={!enabled}/><small>{prompt.length} / 2000 字</small></label>
      <div className="automation-form-row"><label>计划<select value={kind} onChange={(event) => setKind(event.target.value as Kind)} disabled={!enabled}><option value="interval">每 N 分钟</option><option value="daily">每天固定时间</option><option value="once">某个时间点</option><option value="manual">只手动运行</option></select></label>{kind === 'interval' && <label>分钟<input type="number" min="1" max="43200" value={everyMinutes} onChange={(event) => setEveryMinutes(event.target.value)} disabled={!enabled}/></label>}{kind === 'daily' && <label>每天时间<input type="time" value={atClock} onChange={(event) => setAtClock(event.target.value)} disabled={!enabled}/></label>}{kind === 'once' && <label>日期时间<input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} disabled={!enabled}/></label>}</div>
      <div className="automation-form-actions">{editing && <button type="button" onClick={clearForm}>取消编辑</button>}<button className="automation-primary" disabled={!enabled || connection.state !== 'connected' || !prompt.trim() || (kind === 'once' && !at)}>{editing ? '保存任务' : '创建任务'}</button></div>
    </form>
    <div className="automation-list-heading"><strong>任务列表</strong><span>{status?.jobs ?? jobs.length} 个 · 下次运行顺序</span><button onClick={() => void refresh()}>刷新</button></div>
    {!jobs.length && <p className="automation-empty">还没有任务，可以创建一个手动任务试试。</p>}
    {jobs.map((job) => <article className="automation-job" key={job.id}><div className="automation-job-head"><div><strong>{job.name}</strong><span>{job.scheduleText} · {job.enabled ? '已启用' : '已暂停'} · 已运行 {job.runCount} 次</span></div><span className={`automation-run-status ${job.lastStatus ?? ''}`}>{job.lastStatus ?? '尚未运行'}</span></div><p>{job.prompt}</p><div className="automation-job-meta"><span>下次：{dateText(job.nextRunAt)} · 最近：{dateText(job.lastRunAt)}</span><div><button disabled={!enabled || running === job.id || job.schedule.kind === 'manual' && !enabled} onClick={() => void run(job)}>{running === job.id ? '它正在干活…' : '立即运行'}</button><button disabled={!enabled} onClick={() => void toggle(job)}>{job.enabled ? '暂停' : '恢复'}</button><button onClick={() => edit(job)}>编辑</button><button className="automation-danger" disabled={!enabled} onClick={() => void remove(job)}>删除</button><button onClick={() => void loadRuns(job)}>{expanded === job.id ? '收起记录' : '运行记录'}</button></div></div>
      {expanded === job.id && <div className="automation-runs">{(runs[job.id] ?? []).map((item) => <div key={item.id} className="automation-run"><button onClick={() => setSelectedRun(item)}><strong>{item.status}</strong><span>{dateText(item.startedAt)} · {item.durationMs ? `${Math.round(item.durationMs / 1000)} 秒` : '—'}</span></button><small>{item.error ?? (item.output ? `${item.output.slice(0, 140)}${item.output.length > 140 ? '…' : ''}` : '无输出')}</small></div>)}{!(runs[job.id] ?? []).length && <small>还没有运行记录。</small>}</div>}
    </article>)}
    {selectedRun && <div className="automation-detail-backdrop" onClick={() => setSelectedRun(null)}><div className="automation-detail" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><button className="automation-detail-close" onClick={() => setSelectedRun(null)}>关闭</button><h4>{selectedRun.jobName} · {selectedRun.status}</h4><p>{selectedRun.error ?? selectedRun.output ?? '无输出'}</p><small>用量：输入 {selectedRun.usage?.promptTokens ?? 0} · 输出 {selectedRun.usage?.completionTokens ?? 0} · 合计 {selectedRun.usage?.totalTokens ?? 0} tokens</small></div></div>}
  </section>;
}
