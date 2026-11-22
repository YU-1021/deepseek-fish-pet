import { useEffect, useState } from 'react';
import { request, usePetdStatus } from './petd';
import './cua-panel.css';

type Permission = { id: string; kind: 'see' | 'act'; question: string; deadlineAt: number };
const errorText = (error: any) => error?.code === 'E_UNAVAILABLE' ? 'CUA 未启用、已暂停或当前平台不受支持。' : error?.code === 'E_FORBIDDEN' ? '操作被权限设置或用户拒绝。' : error?.code === 'E_BAD_PARAMS' ? '坐标无效，或需要先获取最新截图。' : error?.message ?? '操作失败，请重试。';

export function CuaPermissionOverlay() {
  const [permission, setPermission] = useState<Permission | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    void window.petdBootstrap?.readCuaPermission?.().then((value) => { if (live) setPermission(value); });
    const unsubscribe = window.petdBootstrap?.onCuaPermission?.((value) => { setPermission(value); setNotice(''); });
    return () => { live = false; unsubscribe?.(); };
  }, []);
  useEffect(() => { if (!permission) return; const timer = window.setInterval(() => setNow(Date.now()), 500); return () => window.clearInterval(timer); }, [permission?.id]);
  useEffect(() => {
    if (!permission || permission.deadlineAt > now) return;
    const expired = permission;
    setNotice('没来得及回答，已拒绝。'); setPermission(null);
    void window.petdBootstrap?.clearCuaPermission?.(expired.id);
    const timer = window.setTimeout(async () => {
      try { const pending = await request('approval.list', {}); if (!pending.pending.length) await window.petdBootstrap?.closeApprovalWindow?.(); }
      catch { await window.petdBootstrap?.closeApprovalWindow?.(); }
    }, 4500);
    return () => window.clearTimeout(timer);
  }, [permission?.id, now]);
  async function answer(accepted: boolean) {
    if (!permission || busy) return;
    setBusy(true);
    try {
      const result = await request('cua.answer', { id: permission.id, accepted });
      setNotice(accepted ? '你允许了这次电脑操作。' : '你拒绝了这次电脑操作。');
      await window.petdBootstrap?.clearCuaPermission?.(permission.id);
      setPermission(null);
      if (result.found === false) setNotice('这条授权已超时。');
      window.setTimeout(async () => {
        try { const pending = await request('approval.list', {}); if (!pending.pending.length) await window.petdBootstrap?.closeApprovalWindow?.(); }
        catch { await window.petdBootstrap?.closeApprovalWindow?.(); }
      }, 4500);
    } catch (cause) { setNotice(errorText(cause)); }
    finally { setBusy(false); }
  }
  const seconds = permission ? Math.max(0, Math.ceil((permission.deadlineAt - now) / 1000)) : 0;
  return <>{permission && <section className="cua-permission-card" role="alertdialog" aria-live="assertive"><div className="cua-permission-head"><strong>电脑操作授权</strong><span>{permission.kind === 'see' ? '查看屏幕' : '控制鼠标键盘'}</span></div><p>{permission.question}</p><small>{seconds ? `${seconds} 秒后自动拒绝` : '授权已超时，后端将自动拒绝'}</small>{seconds > 0 ? <div className="cua-permission-actions"><button disabled={busy} onClick={() => void answer(false)}>拒绝</button><button disabled={busy} className="cua-allow" onClick={() => void answer(true)}>{busy ? '提交中…' : '允许'}</button></div> : <p className="cua-timeout">没来得及回答，已拒绝。</p>}</section>}{notice && <div className="cua-permission-notice" role="status">{notice}</div>}</>;
}

export function CuaSettingsPanel({ config }: { config: any }) {
  const connection = usePetdStatus();
  const [status, setStatus] = useState<any>(null);
  const [runStatus, setRunStatus] = useState<any>(null);
  const [screenshot, setScreenshot] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    if (connection.state !== 'connected') return;
    try { const [next, run] = await Promise.all([request('cua.status', {}), request('run.status', {})]); setStatus(next); setRunStatus(run); setError(''); }
    catch (cause) { setError(errorText(cause)); }
  }
  useEffect(() => { void refresh(); }, [connection.state]);
  async function pauseRun() {
    try { const result = await request(runStatus?.paused ? 'run.resume' : 'run.pause', {}); setRunStatus(result); await refresh(); }
    catch (cause) { setError(errorText(cause)); }
  }
  async function preview() {
    setBusy(true); setError(''); setScreenshot(null);
    try { const result = await request('cua.screenshot', { includeImage: true }, 30_000); setScreenshot(result); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <section className="cua-panel">
    <div className="cua-heading"><div><span className="eyebrow">COMPUTER ACCESS</span><h3>电脑操作（CUA）</h3></div><span className={`cua-state ${status?.enabled ? 'on' : ''}`}>{status ? status.enabled ? '已启用' : '已关闭' : '读取中…'}</span></div>
    <p className="cua-danger-note">CUA 可查看屏幕并操作鼠标键盘。当前设置只读；只有在主目录配置中明确开启后模型才会获得相关工具。</p>
    {error && <p className="cua-error" role="alert">{error}</p>}
    {status && <div className="cua-values"><div><span>模式</span><strong>{status.control ? '可操作' : '只读'}</strong></div><div><span>权限</span><strong>{status.permission}</strong></div><div><span>运行</span><strong>{runStatus?.paused || status.paused ? '已暂停' : '正常'}</strong></div><div><span>引擎 / 显示器</span><strong>{status.engine} · {status.displays?.length ?? 0}</strong></div><div className="cua-foreground"><span>前台窗口</span><strong>{status.foreground ? `${status.foreground.app} · ${status.foreground.title}` : '无'}</strong></div></div>}
    <div className="cua-setting-readonly">{[['CUA 总开关', config?.enabled ? '开启' : '关闭'], ['控制权限', config?.control ? '可操作' : '只读'], ['授权时长', `${config?.grantMinutes ?? '—'} 分钟`], ['终端跳过确认', config?.skipTerminalAsk ? '开启（不建议）' : '关闭'], ['截图尺寸 / 质量', `${config?.screenshot?.maxWidth ?? '—'} × ${config?.screenshot?.maxHeight ?? '—'} · ${config?.screenshot?.quality ?? '—'}`], ['操作后截图', config?.screenshot?.afterAction ? '开启' : '关闭'], ['多模态截图', config?.includeImages ? '开启 · 会增加 token' : '关闭']].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <div className="cua-actions"><button onClick={() => void pauseRun()} disabled={connection.state !== 'connected'}>{runStatus?.paused || status?.paused ? '继续运行' : '暂停运行'}</button><button onClick={() => void preview()} disabled={!status?.enabled || busy || connection.state !== 'connected'}>{busy ? '读取屏幕…' : '预览当前屏幕'}</button><button onClick={() => void refresh()} disabled={connection.state !== 'connected'}>刷新</button></div>
    {screenshot && <div className="cua-preview"><div className="cua-preview-head"><strong>{screenshot.foreground?.title || screenshot.text}</strong><button onClick={() => setScreenshot(null)}>清除预览</button></div>{screenshot.imageBase64 && <img src={`data:image/jpeg;base64,${screenshot.imageBase64}`} alt="当前屏幕预览"/>}<small>截图仅在当前页面内存展示，不保存到聊天历史或磁盘。</small></div>}
  </section>;
}
