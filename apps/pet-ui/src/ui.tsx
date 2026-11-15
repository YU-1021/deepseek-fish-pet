import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Activity, BookOpen, Bot, MessageCircle, Paperclip, PawPrint, Plus, Send, Settings2, Sparkles, Wifi, WifiOff, X } from 'lucide-react';
import { request, subscribeEvents, usePetdStatus } from './petd';
import { MemoryPanel, uploadAttachmentFile } from './memory-panel';
import type { QueuedAttachment } from './memory-panel';
import fishIdle from './assets/fish-idle.webm';

type Session = { id: string; title: string; updatedAt: string; messageCount: number };
type Message = { role: 'user' | 'assistant'; content: string; ts: string };
type View = 'chat' | 'persona' | 'memory' | 'settings';
const friendlyError = (error: any) => {
  const code = String(error?.code ?? '');
  const known: Record<string, string> = {
    E_CONFLICT: '内容刚刚被其他操作更新了，请载入最新版本后重试。', E_UNAUTHORIZED: 'petd 鉴权失败，请检查连接配置。',
    E_TIMEOUT: '请求超时了，请稍后重试。', E_UNAVAILABLE: '服务暂时不可用，请稍后重试。',
    E_NOT_FOUND: '找不到这条记录，可能已被删除。', E_LLM_AUTH: '模型服务鉴权失败，请检查 petd 的模型配置。',
    E_LLM_RATE_LIMIT: '模型服务请求太频繁，请稍后再试。', E_LLM_TIMEOUT: '模型响应超时，请稍后重试。',
    E_LLM_NETWORK: '暂时无法连接模型服务，请检查网络。', E_LLM_EMPTY: '模型没有生成回复，请换个说法再试。',
    E_LLM_BAD_RESPONSE: '模型返回内容异常，请稍后重试。', E_LLM_CONFIG: '模型配置不完整，请检查 petd 设置。',
    E_LLM_QUOTA: '模型账户额度不足，请检查模型服务账户。', E_LLM_RATE: '模型服务请求太频繁，请稍后再试。', E_LLM_HTTP: '模型服务返回异常，请稍后重试。',
  };
  if (known[code]) return known[code];
  if (code.startsWith('E_LLM_')) return '模型服务暂时遇到问题，请检查网络或配置后重试。';
  return error?.message ?? '操作失败，请重试。';
};

export function App() {
  const status = usePetdStatus();
  const [view, setView] = useState<View>('chat');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<QueuedAttachment[]>([]);
  const [messageAttachments, setMessageAttachments] = useState<Record<string, QueuedAttachment[]>>({});
  const [imagePreview, setImagePreview] = useState<{ src: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [persona, setPersona] = useState<any>(null);
  const [personaDraft, setPersonaDraft] = useState<Record<string, string>>({});
  const [personaEditing, setPersonaEditing] = useState(false);
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaHistory, setPersonaHistory] = useState<any[]>([]);
  const [config, setConfig] = useState<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  if (new URLSearchParams(window.location.search).has('pet')) return <PetOverlay />;

  async function loadSessions(preferred?: string) {
    const result = await request('session.list', {}) as { sessions: Session[] };
    setSessions(result.sessions);
    const chosen = preferred || activeId || result.sessions[0]?.id;
    if (chosen && result.sessions.some((s) => s.id === chosen)) setActiveId(chosen);
    else if (!result.sessions.length) { setActiveId(''); setMessages([]); }
  }
  useEffect(() => { if (status.state === 'connected') void loadSessions().catch((e) => setError(friendlyError(e))); }, [status.state]);
  useEffect(() => {
    if (!activeId || status.state !== 'connected') return;
    let live = true;
    request('session.get', { sessionId: activeId }).then((r) => { if (live) setMessages(r.session.messages); }).catch((e) => setError(friendlyError(e)));
    return () => { live = false; };
  }, [activeId, status.state]);
  useEffect(() => { const unsubscribe = subscribeEvents((frame) => {
    const data = frame.data as any;
    if (frame.event === 'session.updated') void loadSessions().catch(() => {});
    if (frame.event === 'session.deleted') { setSessions((items) => items.filter((s) => s.id !== data?.sessionId)); if (data?.sessionId === activeId) { setActiveId(''); setMessages([]); } }
    if ((frame.event === 'chat.user_message' || frame.event === 'chat.assistant_message') && data?.sessionId === activeId && data.message) {
      setMessages((items) => [...items, data.message]);
      if (frame.event === 'chat.user_message' && Array.isArray(data.attachments) && data.attachments.length) setMessageAttachments((items) => ({ ...items, [`${data.sessionId}:${data.message.ts}`]: data.attachments }));
    }
    if (frame.event === 'persona.changed' && view === 'persona') void request('persona.get', {}).then(setPersona).catch(() => {});
  }); return () => { unsubscribe(); }; }, [activeId, view]);
  useEffect(() => { const el = scrollRef.current; if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [messages, sending]);

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault(); const text = draft.trim(); if (!text || sending) return;
    setDraft(''); setError(''); setSending(true);
    const queued = pendingAttachments;
    try { const result = await request('chat.send', { ...(activeId ? { sessionId: activeId } : {}), text, ...(queued.length ? { attachments: queued.map((item) => item.handle) } : {}) }); setActiveId(result.session.id); if (queued.length) { setMessageAttachments((items) => ({ ...items, [`${result.session.id}:${result.userMessage.ts}`]: result.attachments ?? queued })); setPendingAttachments([]); } await loadSessions(result.session.id); const latest = await request('session.get', { sessionId: result.session.id }); setMessages(latest.session.messages); }
    catch (e) { setDraft(text); setError(friendlyError(e)); } finally { setSending(false); }
  }
  async function uploadChatFiles(files: FileList | null) {
    if (!files?.length) return;
    const selected = Array.from(files);
    const remaining = Math.max(0, 10 - pendingAttachments.length);
    const accepted = selected.slice(0, remaining);
    const skipped = selected.length - accepted.length;
    if (!accepted.length) { setError('一条消息最多附带 10 个附件，请先移除待发送附件。'); return; }
    setUploading(true); setError('');
    const added: QueuedAttachment[] = [];
    let uploadError = '';
    try { for (const file of accepted) added.push(await uploadAttachmentFile(file)); }
    catch (e) { uploadError = friendlyError(e); }
    finally {
      setPendingAttachments((items) => [...items, ...added].slice(0, 10));
      const notices = [uploadError, skipped ? `已达 10 个附件上限，${skipped} 个文件未上传。` : ''].filter(Boolean);
      if (notices.length) setError(notices.join(' '));
      setUploading(false); if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function openMessageImage(attachment: QueuedAttachment) {
    try { const result = await request('blob.get', { ref: attachment.handle }); setImagePreview({ src: `data:${result.meta.mime};base64,${result.dataBase64}`, name: attachment.name }); }
    catch (e) { setError(friendlyError(e)); }
  }
  async function newChat() { try { const s = await request('session.create', {}); setSessions((items) => [s, ...items]); setActiveId(s.id); setMessages([]); setView('chat'); setError(''); } catch (e) { setError(friendlyError(e)); } }
  async function refreshPersona() { const snapshot = await request('persona.get', {}); setPersona(snapshot); setPersonaDraft(Object.fromEntries(snapshot.sections.map((s: any) => [s.key, s.content]))); }
  async function openView(next: View) { setView(next); setError(''); try { if (next === 'persona') { await refreshPersona(); const h = await request('persona.history', { limit: 20 }); setPersonaHistory(h.revisions); } if (next === 'settings') setConfig(await request('config.get', {})); } catch (e) { setError(friendlyError(e)); } }
  async function savePersona() { if (!persona) return; const changes = Object.fromEntries(Object.entries(personaDraft).filter(([key, value]) => value !== persona.sections.find((s: any) => s.key === key)?.content)); if (!Object.keys(changes).length) { setPersonaEditing(false); return; } setPersonaSaving(true); setError(''); try { await request('persona.patch', { sections: changes, reason: '通过 pet-ui 编辑', expectedVersion: persona.version }); await refreshPersona(); setPersonaEditing(false); const h = await request('persona.history', { limit: 20 }); setPersonaHistory(h.revisions); } catch (e) { setError(friendlyError(e)); if ((e as any)?.code === 'E_CONFLICT') await refreshPersona().catch(() => {}); } finally { setPersonaSaving(false); } }
  async function toggleLock(section: any) { try { await request('persona.lock', { key: section.key, locked: !section.locked }); await refreshPersona(); } catch (e) { setError(friendlyError(e)); } }
  async function rollbackPersona(version: number) { try { await request('persona.rollback', { version }); await refreshPersona(); const h = await request('persona.history', { limit: 20 }); setPersonaHistory(h.revisions); setPersonaEditing(false); } catch (e) { setError(friendlyError(e)); } }
  const keySend = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(); } };

  return <main className="shell">
    <aside className="rail"><div className="brand"><PawPrint size={22}/></div><button className={`rail-button ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')} title="对话"><MessageCircle/></button><button className={`rail-button ${view === 'persona' ? 'active' : ''}`} onClick={() => void openView('persona')} title="人格"><Sparkles/></button><button className={`rail-button ${view === 'memory' ? 'active' : ''}`} onClick={() => setView('memory')} title="记忆"><BookOpen/></button><button className={`rail-button ${view === 'settings' ? 'active' : ''}`} onClick={() => void openView('settings')} title="设置"><Settings2/></button><div className="rail-bottom"><Bot/></div></aside>
    {view === 'memory' ? <MemoryPanel connected={status.state === 'connected'} onUseAttachment={(attachment) => { if (pendingAttachments.some((item) => item.handle === attachment.handle)) { setView('chat'); return true; } if (pendingAttachments.length >= 10) return false; setPendingAttachments((items) => [...items, attachment]); setView('chat'); return true; }} onRemoveAttachment={(handle) => setPendingAttachments((items) => items.filter((item) => item.handle !== handle))} /> : <>
    <section className="conversation-list"><div className="list-head"><div><span className="eyebrow">PET COMPANION</span><h1>{view === 'chat' ? '对话' : view === 'persona' ? '人格' : '设置'}</h1></div>{view === 'chat' && <button className="new-chat" onClick={() => void newChat()} title="新建对话"><Plus size={18}/></button>}</div>
      {view === 'chat' ? <><div className="search">⌕　最近的对话</div><div className="section-label">最近</div>{sessions.map((s) => <button key={s.id} className={`session ${s.id === activeId ? 'selected' : ''}`} onClick={() => { setActiveId(s.id); setError(''); }}><span className="session-dot">✦</span><div><strong>{s.title || '新的对话'}</strong><small>{new Date(s.updatedAt).toLocaleDateString()}　{s.messageCount} 条消息</small></div></button>)}{!sessions.length && <p className="empty-list">还没有对话，点击上方 ＋ 开始聊天。</p>}</> : <div className="sidebar-note"><span>✧</span><p>{view === 'persona' ? <>一起慢慢写下<br/>小鱼的样子。</> : <>让桌面伙伴<br/>住得舒服一点。</>}</p></div>}
    </section>
    <section className="chat"><header className="chat-header"><div className="pet-avatar"><video src={fishIdle} autoPlay loop muted playsInline aria-label="蓝色大肥鱼女仆"/><i/></div><div className="chat-title"><strong>{view === 'chat' ? '小鱼' : view === 'persona' ? '小鱼的人格' : '偏好设置'}</strong><span>{view === 'chat' ? '你的桌面伙伴' : view === 'persona' ? `人格版本 v${persona?.version ?? '—'}` : 'petd 连接配置'}</span></div><div className="header-actions"><button title="服务状态"><Activity size={17}/></button></div></header>
      {view === 'chat' ? <><div className="messages" ref={scrollRef}><div className="day-divider"><span>对话记录</span></div>{messages.length === 0 && <div className="welcome"><div className="welcome-orb">🐋</div><h2>嗨，回来啦</h2><p>今天想聊点什么？我一直都在。</p></div>}{messages.map((m, i) => <div className={`message-row ${m.role === 'user' ? 'mine' : ''}`} key={`${m.ts}-${i}`}>{m.role === 'assistant' && <div className="mini-avatar">🐟</div>}<div><div className={`bubble ${m.role}`}>{m.content}</div>{(messageAttachments[`${activeId}:${m.ts}`] ?? []).map((attachment) => <button className="message-attachment" key={attachment.handle} onClick={() => attachment.mime.startsWith('image/') ? void openMessageImage(attachment) : setView('memory')}><Paperclip size={12}/>{attachment.name}</button>)}<time>{m.role === 'assistant' ? '小鱼 · ' : ''}{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div></div>)}{sending && <div className="message-row"><div className="mini-avatar">🐟</div><div className="bubble assistant typing">小鱼正在想…</div></div>}</div>
        <div className="composer-wrap"><form className="composer" onSubmit={sendMessage}><textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={keySend} placeholder="和小鱼说说话…（Enter 发送，Shift+Enter 换行）" rows={2} disabled={status.state !== 'connected' || sending}/>{pendingAttachments.length > 0 && <div className="pending-attachments">{pendingAttachments.map((item) => <span key={item.handle}>{item.name}<button type="button" disabled={sending} onClick={() => setPendingAttachments((items) => items.filter((entry) => entry.handle !== item.handle))} aria-label={`移除 ${item.name}`}><X size={12}/></button></span>)}</div>}<div className="composer-tools"><span>{error && <span className="error-text">{error}</span>}</span><div className="composer-actions"><input ref={fileInput} type="file" multiple hidden onChange={(e) => void uploadChatFiles(e.target.files)}/><button type="button" className="attach-button" onClick={() => fileInput.current?.click()} disabled={uploading || sending || status.state !== 'connected'} title="添加附件"><Paperclip size={15}/></button><button className="send" type="submit" disabled={!draft.trim() || sending || status.state !== 'connected'} aria-label="发送"><Send size={15}/></button></div></div></form><div className="fine-print">{uploading ? '正在上传附件…' : '小鱼可能会犯错，请核对重要信息'}</div></div></> : <div className="messages detail-view">{error && <div className="notice">{error}</div>}{view === 'persona' && persona && <><div className="detail-intro"><div className="welcome-orb">✨</div><h2>{persona.title || '小鱼'}</h2><p>人格版本 v{persona.version} · {new Date(persona.updatedAt).toLocaleString()}</p><div className="persona-actions">{personaEditing ? <><button onClick={() => { setPersonaEditing(false); void refreshPersona(); }}>取消</button><button className="primary-action" disabled={personaSaving} onClick={() => void savePersona()}>{personaSaving ? '保存中…' : '保存修改'}</button></> : <button className="primary-action" onClick={() => setPersonaEditing(true)}>编辑人格</button>}</div></div><div className="persona-content">{persona.preamble && <p>{persona.preamble}</p>}{persona.sections.map((section: any) => <article key={section.key}><div className="section-heading"><h3>{section.heading}</h3><span>{section.locked ? '🔒 已锁定' : section.aiEditable ? '可随相处演化' : '用户专属'}</span></div>{personaEditing ? <textarea className="persona-editor" value={personaDraft[section.key] ?? ''} onChange={(e) => setPersonaDraft({ ...personaDraft, [section.key]: e.target.value })} /> : <p>{section.content || '（尚未填写）'}</p>}{section.aiEditable && <button className="lock-action" onClick={() => void toggleLock(section)}>{section.locked ? '解锁 AI 修改' : '锁定，禁止 AI 修改'}</button>}</article>)}{personaHistory.length > 0 && <article><h3>历史版本</h3>{personaHistory.map((item) => <div className="history-row" key={`${item.version}-${item.ts}`}><span>v{item.version} · {item.actor === 'agent' ? '小鱼演化' : '用户修改'} · {item.reason || '无备注'}</span>{item.version < persona.version && <button onClick={() => void rollbackPersona(item.version)}>回滚到此版本</button>}</div>)}</article>}</div></>}{view === 'settings' && config && <div className="persona-content"><article><div className="section-heading"><h3>petd 服务</h3><span>{status.state === 'connected' ? '● 在线' : '○ 离线'}</span></div><p>版本：{status.version ?? config.version ?? '—'}</p><p>监听地址：{config.gateway?.host ?? '127.0.0.1'}:{status.gatewayPort ?? (config.gateway?.port || '动态端口')}</p><p>日志等级：{config.log?.level ?? '—'}</p></article><article><h3>界面</h3><p>消息与人格数据保存在 petd。此处只展示非敏感配置，不读取或显示 API 密钥。</p></article></div>}{!persona && !config && !error && <div className="detail-intro">正在读取 petd…</div>}</div>}
    </section>
    </>}
    {imagePreview && <div className="memory-image-backdrop" onClick={() => setImagePreview(null)}><div className="memory-image-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}><button className="memory-image-close" onClick={() => setImagePreview(null)} aria-label="关闭"><X/></button><img src={imagePreview.src} alt={imagePreview.name}/><span>{imagePreview.name}</span></div></div>}
    <footer className="status"><span className={status.state === 'connected' ? 'online' : 'offline'}>{status.state === 'connected' ? <Wifi size={13}/> : <WifiOff size={13}/>} {status.state === 'connected' ? '已连接' : status.state === 'connecting' ? '正在连接…' : status.error ?? '离线'}</span>{status.version && <span>petd v{status.version} · {status.methodCount} 个方法</span>}<span className="status-spacer"/><span>{view === 'persona' ? `人格 v${persona?.version ?? '—'}` : view === 'memory' ? '工作区记忆' : '本地桌面伙伴'}</span></footer>
  </main>;
}

function PetOverlay() {
  return <div className="pet-overlay" onDoubleClick={() => void window.petdBootstrap?.showChat()} onContextMenu={(event) => { event.preventDefault(); void window.petdBootstrap?.showPetMenu(); }} title="双击打开聊天 · 右键菜单">
    <svg className="pet-alpha-filter" aria-hidden="true"><defs><filter id="pet-alpha-fix"><feComponentTransfer><feFuncA type="linear" slope="1" intercept="-0.0039215686"/></feComponentTransfer></filter></defs></svg>
    <div className="pet-float"><video src={fishIdle} autoPlay loop muted playsInline aria-label="蓝色大肥鱼女仆，待机呼吸动画"/></div><div className="pet-hint">双击打开聊天</div>
  </div>;
}

