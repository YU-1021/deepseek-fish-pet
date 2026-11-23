import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Activity, BookOpen, Bot, MessageCircle, Package, Paperclip, PawPrint, Plus, Send, Settings2, Sparkles, Volume2, VolumeX, Wifi, WifiOff, X } from 'lucide-react';
import { request, subscribeEvents, usePetdStatus } from './petd';
import { MoodSettingsPanel } from './mood-panel';
import { ReminderCoordinator } from './reminder-panel';
import { CuaPermissionOverlay } from './cua-panel';
import { DshApprovalOverlay } from './dsh-panel';
import './voice-chat.css';
import { ApprovalCoordinator, ApprovalOverlay } from './hooks-panel';
import { useMoodNumberPreference, useMoodState } from './mood';
import { MemoryPanel, uploadAttachmentFile } from './memory-panel';
import type { QueuedAttachment } from './memory-panel';
import { t } from './i18n';
import { SkillsSettingsPanel } from './skills-panel';
import { SecondarySettingsPanels } from './secondary-settings';
import fishIdle from './assets/fish-idle.webm';
import clickDuck from './assets/click-duck.wav';

type Session = { id: string; title: string; updatedAt: string; messageCount: number };
type Message = { role: 'user' | 'assistant'; content: string; ts: string };
type ToolActivity = { sessionId: string; round: number; name: string; ok: boolean; args: string; preview: string; at: number };
type View = 'chat' | 'persona' | 'memory' | 'skills' | 'settings';
const MESSAGE_WINDOW_SIZE = 120;
const MESSAGE_WINDOW_STEP = 80;
const pokeReactions = [
  { en: 'Hmph! I am NOT a freeloader fat fish!', zh: '哼！我才不是吃白饭的大肥鱼！' },
  { en: 'H-hey, stop poking me...', zh: '喂、喂，别乱戳我……' },
  { en: 'W-what? I did not hear anything!', zh: '什么？我什么都没听见！' },
  { en: 'You worked hard today... n-not that I care.', zh: '你今天很努力……才、才不是关心你呢。' },
  { en: 'Poke me again and I will get angry!', zh: '再戳我我可要生气了！' },
];
const friendlyError = (error: any) => {
  const code = String(error?.code ?? '');
  const known: Record<string, string> = {
    E_CONFLICT: t('error.conflict'), E_UNAUTHORIZED: t('error.unauthorized'),
    E_TIMEOUT: t('error.timeout'), E_UNAVAILABLE: t('error.unavailable'), E_BAD_PARAMS: t('error.badParams'), E_FORBIDDEN: t('error.forbidden'), E_INTERNAL: t('error.internal'),
    E_NOT_FOUND: t('error.notFound'), E_LLM_AUTH: '模型服务鉴权失败，请检查 petd 的模型配置。',
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
  const [showMoodValues, setShowMoodValues] = useMoodNumberPreference();
  const [view, setView] = useState<View>('chat');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageWindowOffset, setMessageWindowOffset] = useState(0);
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([]);
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
  const [playingSpeechKey, setPlayingSpeechKey] = useState('');
  const [speechNotice, setSpeechNotice] = useState('');
  const [speechRetryReady, setSpeechRetryReady] = useState(false);
  const [speechActive, setSpeechActive] = useState(false);
  const currentSpeech = useRef<HTMLAudioElement | null>(null);
  const speechAnimationTimer = useRef<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageWindowJump = useRef<'older' | 'newer' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => {
    currentSpeech.current?.pause();
    if (speechAnimationTimer.current) window.clearTimeout(speechAnimationTimer.current);
  }, []);
  useEffect(() => {
    const unsubscribe = subscribeEvents((frame) => {
      if (frame.event !== 'voice.speech') return;
      setSpeechActive(true);
      if (speechAnimationTimer.current) window.clearTimeout(speechAnimationTimer.current);
      const duration = Number(frame.data?.durationMs) || 0;
      if (duration > 0) speechAnimationTimer.current = window.setTimeout(() => setSpeechActive(false), duration);
    });
    return () => { unsubscribe(); };
  }, []);
  if (new URLSearchParams(window.location.search).has('pet')) return <PetOverlay />;
  if (new URLSearchParams(window.location.search).has('approval')) return <div className="approval-window-root"><ApprovalOverlay/><CuaPermissionOverlay/><DshApprovalOverlay/></div>;

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
    if (frame.event === 'chat.tool' && data?.sessionId && (data.sessionId === activeId || sending)) setToolActivities((items) => [...items, { sessionId: data.sessionId, round: data.round ?? 0, name: data.name ?? 'tool', ok: data.ok === true, args: data.args ?? '', preview: data.preview ?? '', at: Date.now() }].slice(-20));
    if (frame.event === 'chat.failed' && (!activeId || data?.sessionId === activeId)) setError(friendlyError({ code: data?.code, message: data?.message }));
  }); return () => { unsubscribe(); }; }, [activeId, view, sending]);
  useEffect(() => {
    if (messageWindowOffset > 0) messageWindowJump.current = 'newer';
    setMessageWindowOffset(0);
    const el = scrollRef.current;
    if (el && typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);
  useLayoutEffect(() => {
    const direction = messageWindowJump.current;
    const el = scrollRef.current;
    if (!direction || !el) return;
    el.scrollTop = direction === 'older' ? 0 : el.scrollHeight;
    messageWindowJump.current = null;
  }, [messageWindowOffset]);

  const messageWindowEnd = Math.max(0, messages.length - messageWindowOffset);
  const messageWindowStart = Math.max(0, messageWindowEnd - MESSAGE_WINDOW_SIZE);
  const visibleMessages = messages.slice(messageWindowStart, messageWindowEnd);
  function showOlderMessages() {
    messageWindowJump.current = 'older';
    setMessageWindowOffset((offset) => Math.min(messages.length - MESSAGE_WINDOW_SIZE, offset + MESSAGE_WINDOW_STEP));
  }
  function showNewerMessages() {
    messageWindowJump.current = 'newer';
    setMessageWindowOffset((offset) => Math.max(0, offset - MESSAGE_WINDOW_STEP));
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault(); const text = draft.trim(); if (!text || sending) return;
    setDraft(''); setError(''); setToolActivities([]); setSending(true);
    const queued = pendingAttachments;
    try { const result = await request('chat.send', { ...(activeId ? { sessionId: activeId } : {}), text, ...(queued.length ? { attachments: queued.map((item) => item.handle) } : []) }); setActiveId(result.session.id); if (result.speech?.audioBase64) playSpeech(result.speech, `auto:${result.speech.id}`); if (queued.length) { setMessageAttachments((items) => ({ ...items, [`${result.session.id}:${result.userMessage.ts}`]: result.attachments ?? queued })); setPendingAttachments([]); } await loadSessions(result.session.id); const latest = await request('session.get', { sessionId: result.session.id }); setMessages(latest.session.messages); }
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
  function stopSpeech() {
    const audio = currentSpeech.current;
    currentSpeech.current = null;
    if (audio) { audio.pause(); audio.currentTime = 0; }
    if (speechAnimationTimer.current) window.clearTimeout(speechAnimationTimer.current);
    setPlayingSpeechKey(''); setSpeechActive(false); setSpeechRetryReady(false);
  }
  function playSpeech(speech: any, key: string) {
    stopSpeech();
    if (!speech?.audioBase64 || !speech?.mime) { setSpeechNotice('语音没有返回可播放音频。'); return; }
    const audio = new Audio(`data:${speech.mime};base64,${speech.audioBase64}`);
    currentSpeech.current = audio;
    setPlayingSpeechKey(key); setSpeechNotice(''); setSpeechRetryReady(false); setSpeechActive(true);
    if (Number(speech.durationMs) > 0) speechAnimationTimer.current = window.setTimeout(() => setSpeechActive(false), Number(speech.durationMs));
    audio.onended = () => { if (currentSpeech.current === audio) stopSpeech(); };
    audio.onerror = () => { if (currentSpeech.current === audio) { setSpeechNotice('音频播放失败，请重试。'); stopSpeech(); } };
    audio.play().catch(() => { if (currentSpeech.current === audio) { setSpeechNotice('自动播放被拦截，请点“继续播放”。'); setSpeechRetryReady(true); setSpeechActive(false); } });
  }
  async function readMessage(message: Message, key: string) {
    if (playingSpeechKey === key) { stopSpeech(); return; }
    setSpeechNotice('正在合成语音…');
    try {
      const voice = config?.voice ?? {};
      const speech = await request('voice.speak', { text: message.content, ...(voice.voice ? { voice: voice.voice } : {}), ...(voice.rate ? { rate: voice.rate } : {}), ...(voice.pitch ? { pitch: voice.pitch } : {}) }, 90_000);
      playSpeech(speech, key);
    } catch (cause) { setSpeechNotice(friendlyError(cause)); }
  }
  function retrySpeech() {
    const audio = currentSpeech.current;
    if (!audio) return;
    setSpeechNotice(''); setSpeechRetryReady(false); setSpeechActive(true);
    void audio.play().catch(() => { setSpeechNotice('播放仍被系统拦截，请再点一次。'); setSpeechRetryReady(true); setSpeechActive(false); });
  }
  async function newChat() { try { const s = await request('session.create', {}); setSessions((items) => [s, ...items]); setActiveId(s.id); setMessages([]); setToolActivities([]); setView('chat'); setError(''); } catch (e) { setError(friendlyError(e)); } }
  async function refreshPersona() { const snapshot = await request('persona.get', {}); setPersona(snapshot); setPersonaDraft(Object.fromEntries(snapshot.sections.map((s: any) => [s.key, s.content]))); }
  async function openView(next: View) { setView(next); setError(''); try { if (next === 'persona') { await refreshPersona(); const h = await request('persona.history', { limit: 20 }); setPersonaHistory(h.revisions); } if (next === 'settings' || next === 'skills') setConfig(await request('config.get', {})); } catch (e) { setError(friendlyError(e)); } }
  async function savePersona() { if (!persona) return; const changes = Object.fromEntries(Object.entries(personaDraft).filter(([key, value]) => value !== persona.sections.find((s: any) => s.key === key)?.content)); if (!Object.keys(changes).length) { setPersonaEditing(false); return; } setPersonaSaving(true); setError(''); try { await request('persona.patch', { sections: changes, reason: '通过 pet-ui 编辑', expectedVersion: persona.version }); await refreshPersona(); setPersonaEditing(false); const h = await request('persona.history', { limit: 20 }); setPersonaHistory(h.revisions); } catch (e) { setError(friendlyError(e)); if ((e as any)?.code === 'E_CONFLICT') await refreshPersona().catch(() => {}); } finally { setPersonaSaving(false); } }
  async function toggleLock(section: any) { try { await request('persona.lock', { key: section.key, locked: !section.locked }); await refreshPersona(); } catch (e) { setError(friendlyError(e)); } }
  async function rollbackPersona(version: number) { try { await request('persona.rollback', { version }); await refreshPersona(); const h = await request('persona.history', { limit: 20 }); setPersonaHistory(h.revisions); setPersonaEditing(false); } catch (e) { setError(friendlyError(e)); } }
  const keySend = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(); } };

  return <main className="shell">
    <ApprovalCoordinator/>
    <ReminderCoordinator/>
    <aside className="rail"><div className="brand"><PawPrint size={22}/></div><button className={`rail-button ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')} title="对话"><MessageCircle/></button><button className={`rail-button ${view === 'persona' ? 'active' : ''}`} onClick={() => void openView('persona')} title="人格"><Sparkles/></button><button className={`rail-button ${view === 'memory' ? 'active' : ''}`} onClick={() => setView('memory')} title="记忆"><BookOpen/></button><button className={`rail-button ${view === 'skills' ? 'active' : ''}`} onClick={() => void openView('skills')} title="技能与插件"><Package/></button><button className={`rail-button ${view === 'settings' ? 'active' : ''}`} onClick={() => void openView('settings')} title="设置"><Settings2/></button><div className="rail-bottom"><Bot/></div></aside>
    {view === 'memory' ? <MemoryPanel connected={status.state === 'connected'} onUseAttachment={(attachment) => { if (pendingAttachments.some((item) => item.handle === attachment.handle)) { setView('chat'); return true; } if (pendingAttachments.length >= 10) return false; setPendingAttachments((items) => [...items, attachment]); setView('chat'); return true; }} onRemoveAttachment={(handle) => setPendingAttachments((items) => items.filter((item) => item.handle !== handle))} /> : <>
    <section className="conversation-list"><div className="list-head"><div><span className="eyebrow">PET COMPANION</span><h1>{view === 'chat' ? '对话' : view === 'persona' ? '人格' : view === 'skills' ? '技能与插件' : '设置'}</h1></div>{view === 'chat' && <button className="new-chat" onClick={() => void newChat()} title="新建对话"><Plus size={18}/></button>}</div>
      {view === 'chat' ? <><div className="search">⌕　最近的对话</div><div className="section-label">最近</div>{sessions.map((s) => <button key={s.id} className={`session ${s.id === activeId ? 'selected' : ''}`} onClick={() => { setActiveId(s.id); setToolActivities([]); setError(''); }}><span className="session-dot">✦</span><div><strong>{s.title || '新的对话'}</strong><small>{new Date(s.updatedAt).toLocaleDateString()}　{s.messageCount} 条消息</small></div></button>)}{!sessions.length && <p className="empty-list">还没有对话，点击上方 ＋ 开始聊天。</p>}</> : <div className="sidebar-note"><span>✧</span><p>{view === 'persona' ? '一起慢慢写下，小鱼的样子。' : view === 'skills' ? '让小鱼掌握更多做事方法。' : '让桌面伙伴住得舒服一点。'}</p></div>}
    </section>
    <section className={`chat ${speechActive ? 'speaking' : ''}`}><header className="chat-header"><div className="pet-avatar"><video src={fishIdle} autoPlay loop muted playsInline aria-label="蓝色大肥鱼女仆"/><i/></div><div className="chat-title"><strong>{view === 'chat' ? '小鱼' : view === 'persona' ? '小鱼的人格' : view === 'skills' ? '技能与插件' : '偏好设置'}</strong><span>{view === 'chat' ? '你的桌面伙伴' : view === 'persona' ? `人格版本 v${persona?.version ?? '—'}` : view === 'skills' ? '管理可复用技能和本地插件' : 'petd 连接配置'}</span></div><div className="header-actions"><button title="服务状态"><Activity size={17}/></button></div></header>
      {view === 'chat' ? <><div className="messages" ref={scrollRef}><div className="day-divider"><span>对话记录</span></div>{speechNotice && <div className="voice-inline-notice" role="status">{speechNotice}{speechRetryReady && <button onClick={retrySpeech}>继续播放</button>}</div>}{messages.length === 0 && <div className="welcome"><div className="welcome-orb">🐋</div><h2>嗨，回来啦</h2><p>今天想聊点什么？我一直都在。</p></div>}{messageWindowStart > 0 && <button className="message-window-control" onClick={showOlderMessages}>再看前面的 {Math.min(MESSAGE_WINDOW_STEP, messageWindowStart)} 条</button>}{visibleMessages.map((m, localIndex) => { const i = messageWindowStart + localIndex; const speechKey = `${m.ts}-${i}`; return <div className={`message-row ${m.role === 'user' ? 'mine' : ''}`} key={`${m.ts}-${i}`}>{m.role === 'assistant' && <div className="mini-avatar">🐟</div>}<div><div className={`bubble ${m.role}`}>{m.content}</div>{(messageAttachments[`${activeId}:${m.ts}`] ?? []).map((attachment) => <button className="message-attachment" key={attachment.handle} onClick={() => attachment.mime.startsWith('image/') ? void openMessageImage(attachment) : setView('memory')}><Paperclip size={12}/>{attachment.name}</button>)}<div className="message-meta"><time>{m.role === 'assistant' ? '小鱼 · ' : ''}{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{m.role === 'assistant' && <button className="speech-button" onClick={() => playingSpeechKey === speechKey ? stopSpeech() : void readMessage(m, speechKey)} aria-label={playingSpeechKey === speechKey ? '停止朗读' : '朗读消息'} title={playingSpeechKey === speechKey ? '停止朗读' : '朗读'}>{playingSpeechKey === speechKey ? <VolumeX size={13}/> : <Volume2 size={13}/>} {playingSpeechKey === speechKey ? '停止' : '朗读'}</button>}</div></div></div>; })}{messageWindowEnd < messages.length && <button className="message-window-control newer" onClick={showNewerMessages}>查看较新的消息</button>}{toolActivities.filter((item) => !activeId || item.sessionId === activeId).length > 0 && <details className="tool-activity"><summary>{t('tools.title')} · {toolActivities.filter((item) => !activeId || item.sessionId === activeId).length}</summary>{toolActivities.filter((item) => !activeId || item.sessionId === activeId).map((item) => <article key={`${item.sessionId}:${item.round}:${item.name}:${item.at}`}><div><strong>{item.name === 'ask_dsh' ? t('tools.dsh') : item.name}</strong><span className={item.ok ? 'ok' : 'failed'}>{item.ok ? t('tools.succeeded') : t('tools.failed')}</span></div>{item.name === 'ask_dsh' && <p className="tool-dsh-summary">{item.args.slice(0, 180)} → {item.preview.slice(0, 220)}</p>}<small>第 {item.round} 轮 · {new Date(item.at).toLocaleTimeString()}</small>{item.name !== 'ask_dsh' && item.args && <pre>{item.args}</pre>}<p>{item.preview}</p></article>)}</details>}{sending && <div className="message-row"><div className="mini-avatar">🐟</div><div className="bubble assistant typing">小鱼正在想…</div></div>}</div>
      <div className="composer-wrap"><form className="composer" onSubmit={sendMessage}><textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={keySend} placeholder="和小鱼说说话…（Enter 发送，Shift+Enter 换行）" rows={2} disabled={status.state !== 'connected' || sending}/>{pendingAttachments.length > 0 && <div className="pending-attachments">{pendingAttachments.map((item) => <span key={item.handle}>{item.name}<button type="button" disabled={sending} onClick={() => setPendingAttachments((items) => items.filter((entry) => entry.handle !== item.handle))} aria-label={`移除 ${item.name}`}><X size={12}/></button></span>)}</div>}<div className="composer-tools"><span>{error && <span className="error-text">{error}</span>}</span><div className="composer-actions"><input ref={fileInput} type="file" multiple hidden onChange={(e) => void uploadChatFiles(e.target.files)}/><button type="button" className="attach-button" onClick={() => fileInput.current?.click()} disabled={uploading || sending || status.state !== 'connected'} title="添加附件"><Paperclip size={15}/></button><button className="send" type="submit" disabled={!draft.trim() || sending || status.state !== 'connected'} aria-label="发送"><Send size={15}/></button></div></div></form><div className="fine-print">{uploading ? '正在上传附件…' : '小鱼可能会犯错，请核对重要信息'}</div></div></> : <div className="messages detail-view">{error && <div className="notice">{error}</div>}{view === 'persona' && persona && <><div className="detail-intro"><div className="welcome-orb">✨</div><h2>{persona.title || '小鱼'}</h2><p>人格版本 v{persona.version} · {new Date(persona.updatedAt).toLocaleString()}</p><div className="persona-actions">{personaEditing ? <><button onClick={() => { setPersonaEditing(false); void refreshPersona(); }}>取消</button><button className="primary-action" disabled={personaSaving} onClick={() => void savePersona()}>{personaSaving ? '保存中…' : '保存修改'}</button></> : <button className="primary-action" onClick={() => setPersonaEditing(true)}>编辑人格</button>}</div></div><div className="persona-content">{persona.preamble && <p>{persona.preamble}</p>}{persona.sections.map((section: any) => <article key={section.key}><div className="section-heading"><h3>{section.heading}</h3><span>{section.locked ? '🔒 已锁定' : section.aiEditable ? '可随相处演化' : '用户专属'}</span></div>{personaEditing ? <textarea className="persona-editor" value={personaDraft[section.key] ?? ''} onChange={(e) => setPersonaDraft({ ...personaDraft, [section.key]: e.target.value })} /> : <p>{section.content || '（尚未填写）'}</p>}{section.aiEditable && <button className="lock-action" onClick={() => void toggleLock(section)}>{section.locked ? '解锁 AI 修改' : '锁定，禁止 AI 修改'}</button>}</article>)}{personaHistory.length > 0 && <article><h3>历史版本</h3>{personaHistory.map((item) => <div className="history-row" key={`${item.version}-${item.ts}`}><span>v{item.version} · {item.actor === 'agent' ? '小鱼演化' : '用户修改'} · {item.reason || '无备注'}</span>{item.version < persona.version && <button onClick={() => void rollbackPersona(item.version)}>回滚到此版本</button>}</div>)}</article>}</div></>}{view === 'skills' && config && <SkillsSettingsPanel config={config}/ >}{view === 'settings' && config && <div className="persona-content"><MoodSettingsPanel config={config} sessionId={activeId} showValues={showMoodValues} onShowValuesChange={setShowMoodValues}/><SecondarySettingsPanels config={config}/><article><div className="section-heading"><h3>petd 服务</h3><span>{status.state === 'connected' ? '● 在线' : '○ 离线'}</span></div><p>版本：{status.version ?? config.version ?? '—'}</p><p>监听地址：{config.gateway?.host ?? '127.0.0.1'}:{status.gatewayPort ?? (config.gateway?.port || '动态端口')}</p><p>日志等级：{config.log?.level ?? '—'}</p></article><article><h3>界面</h3><p>消息与人格数据保存在 petd。此处只展示非敏感配置，不读取或显示 API 密钥。</p></article></div>}{!persona && !config && !error && <div className="detail-intro">正在读取 petd…</div>}</div>}
    </section>
    </>}
    {imagePreview && <div className="memory-image-backdrop" onClick={() => setImagePreview(null)}><div className="memory-image-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}><button className="memory-image-close" onClick={() => setImagePreview(null)} aria-label="关闭"><X/></button><img src={imagePreview.src} alt={imagePreview.name}/><span>{imagePreview.name}</span></div></div>}
    <footer className="status"><span className={status.state === 'connected' ? 'online' : 'offline'}>{status.state === 'connected' ? <Wifi size={13}/> : <WifiOff size={13}/>} {status.state === 'connected' ? t('status.connected') : status.state === 'connecting' ? t('status.connecting') : status.error ?? t('status.offline')}</span>{status.version && <span>petd v{status.version} · {status.methodCount} 个方法</span>}<span className="status-spacer"/><span>{view === 'persona' ? `人格 v${persona?.version ?? '—'}` : view === 'memory' ? '工作区记忆' : '本地桌面伙伴'}</span></footer>
  </main>;
}

function PetOverlay() {
  const { enabled } = useMoodState();
  const bounceTimer = useRef<number | undefined>(undefined);
  const reactionTimer = useRef<number | undefined>(undefined);
  const petFloat = useRef<HTMLDivElement | null>(null);
  const clickAudio = useRef<HTMLAudioElement | null>(null);
  const petVideo = useRef<HTMLVideoElement | null>(null);
  const pointerStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const pointerMoved = useRef(false);
  const lastInteractionAt = useRef(0);
  const queuedPresence = useRef<{ id: string; kind: string } | null>(null);
  const presenceTimer = useRef<number | undefined>(undefined);
  const presenceAnimationTimer = useRef<number | undefined>(undefined);
  const [reaction, setReaction] = useState<{ en: string; zh: string } | null>(null);
  function syncPetHitRegions() {
    const overlay = document.querySelector('.pet-overlay');
    const video = petVideo.current;
    if (!overlay || !video) return;
    const overlayRect = overlay.getBoundingClientRect();
    const videoRect = video.getBoundingClientRect();
    let artRegion: { x: number; y: number; width: number; height: number };
    try {
      if (!video.videoWidth || !video.videoHeight) throw new Error('video frame not ready');
      const sampleScale = Math.min(1, 128 / Math.max(video.videoWidth, video.videoHeight));
      const sampleWidth = Math.max(1, Math.round(video.videoWidth * sampleScale));
      const sampleHeight = Math.max(1, Math.round(video.videoHeight * sampleScale));
      const canvas = document.createElement('canvas');
      canvas.width = sampleWidth;
      canvas.height = sampleHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('canvas unavailable');
      context.drawImage(video, 0, 0, sampleWidth, sampleHeight);
      const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight);
      let left = sampleWidth, top = sampleHeight, right = -1, bottom = -1;
      for (let y = 0; y < sampleHeight; y++) for (let x = 0; x < sampleWidth; x++) {
        if (data[(y * sampleWidth + x) * 4 + 3] <= 16) continue;
        left = Math.min(left, x); top = Math.min(top, y);
        right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
      if (right < left || bottom < top) throw new Error('empty alpha bounds');
      const fitScale = Math.min(videoRect.width / video.videoWidth, videoRect.height / video.videoHeight);
      const drawWidth = video.videoWidth * fitScale;
      const drawHeight = video.videoHeight * fitScale;
      const scaleX = drawWidth / sampleWidth;
      const scaleY = drawHeight / sampleHeight;
      const pad = 14;
      artRegion = {
        x: videoRect.left - overlayRect.left + (videoRect.width - drawWidth) / 2 + left * scaleX - pad,
        y: videoRect.top - overlayRect.top + (videoRect.height - drawHeight) / 2 + top * scaleY - pad,
        width: (right - left + 1) * scaleX + pad * 2,
        height: (bottom - top + 1) * scaleY + pad * 2,
      };
    } catch {
      artRegion = { x: overlayRect.width / 2 - 70, y: 20, width: 140, height: 140 };
    }
    const regions = [artRegion];
    const bubble = overlay.querySelector('.pet-reply-bubble');
    if (bubble) {
      const rect = bubble.getBoundingClientRect();
      regions.push({ x: rect.left - overlayRect.left, y: rect.top - overlayRect.top, width: rect.width, height: rect.height });
    }
    window.petdBootstrap?.updatePetHitRegions(regions);
  }
  useEffect(() => {
    const overlay = document.querySelector('.pet-overlay');
    if (!overlay) return;
    const resize = () => {
      void window.petdBootstrap?.resizePet?.(Math.ceil(overlay.getBoundingClientRect().height));
      syncPetHitRegions();
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
    observer?.observe(overlay);
    return () => {
      observer?.disconnect();
      if (reactionTimer.current) window.clearTimeout(reactionTimer.current);
      if (bounceTimer.current) window.clearTimeout(bounceTimer.current);
      void window.petdBootstrap?.resizePet?.(190);
      window.petdBootstrap?.updatePetHitRegions([]);
    };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(syncPetHitRegions, 0);
    return () => window.clearTimeout(timer);
  }, [reaction]);
  useEffect(() => {
    let live = true;
    const animateWhenQuiet = () => {
      if (!live || !queuedPresence.current) return;
      if (pointerStart.current || Date.now() - lastInteractionAt.current < 10_000) {
        presenceTimer.current = window.setTimeout(animateWhenQuiet, 1500);
        return;
      }
      const activity = queuedPresence.current;
      queuedPresence.current = null;
      const pet = petFloat.current;
      if (!pet) return;
      const classes = ['groom', 'stretch', 'window', 'nap', 'tidy', 'idle'].map((kind) => `pet-presence-${kind}`);
      pet.classList.remove(...classes);
      void pet.offsetWidth;
      pet.classList.add(`pet-presence-${activity.kind}`);
      if (presenceAnimationTimer.current) window.clearTimeout(presenceAnimationTimer.current);
      presenceAnimationTimer.current = window.setTimeout(() => pet.classList.remove(`pet-presence-${activity.kind}`), 2200);
    };
    const unsubscribe = subscribeEvents((frame) => {
      if (frame.event === 'chat.user_message' || frame.event === 'chat.assistant_message') lastInteractionAt.current = Date.now();
      if (frame.event !== 'presence.activity' || frame.data?.quiet !== true) return;
      const kind = String(frame.data.kind ?? 'idle');
      if (!['groom', 'stretch', 'window', 'nap', 'tidy', 'idle'].includes(kind)) return;
      queuedPresence.current = { id: String(frame.data.id ?? Date.now()), kind };
      if (presenceTimer.current) window.clearTimeout(presenceTimer.current);
      animateWhenQuiet();
    });
    return () => {
      live = false; unsubscribe();
      if (presenceTimer.current) window.clearTimeout(presenceTimer.current);
      if (presenceAnimationTimer.current) window.clearTimeout(presenceAnimationTimer.current);
    };
  }, []);
  async function poke() {
    if (enabled !== true) return;
    try {
      await request('mood.poke', {});
    } catch { /* pet window keeps the interaction quiet when petd is offline */ }
  }
  function playClickFeedback() {
    setReaction(pokeReactions[Math.floor(Math.random() * pokeReactions.length)]);
    if (reactionTimer.current) window.clearTimeout(reactionTimer.current);
    reactionTimer.current = window.setTimeout(() => setReaction(null), 6000);
    const pet = petFloat.current;
    if (pet) {
      pet.classList.remove('pet-bounce');
      void pet.offsetWidth;
      pet.classList.add('pet-bounce');
    }
    if (bounceTimer.current) window.clearTimeout(bounceTimer.current);
    bounceTimer.current = window.setTimeout(() => pet?.classList.remove('pet-bounce'), 600);
    try {
      clickAudio.current ??= new Audio(clickDuck);
      clickAudio.current.volume = 0.5;
      clickAudio.current.currentTime = 0;
      void clickAudio.current.play().catch(() => {});
    } catch { /* audio unavailable: keep the animation */ }
    if (enabled === true) void poke();
  }
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    lastInteractionAt.current = Date.now();
    pointerStart.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    pointerMoved.current = false;
    void window.petdBootstrap?.startDrag();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* capture is unavailable in some renderers */ }
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = pointerStart.current;
    if (start?.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.hypot(dx, dy) >= 6) {
      pointerMoved.current = true;
    }
  }
  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const start = pointerStart.current;
    if (start?.id !== event.pointerId) return;
    const moved = pointerMoved.current || Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 6;
    pointerStart.current = null;
    pointerMoved.current = false;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* capture may already be released */ }
    void window.petdBootstrap?.endDrag();
    if (!moved) playClickFeedback();
  }
  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointerStart.current?.id !== event.pointerId) return;
    pointerStart.current = null;
    pointerMoved.current = false;
    void window.petdBootstrap?.endDrag();
  }
  useEffect(() => {
    const releasePointer = () => {
      if (!pointerStart.current) return;
      pointerStart.current = null;
      pointerMoved.current = false;
      void window.petdBootstrap?.endDrag();
    };
    window.addEventListener('blur', releasePointer);
    return () => { window.removeEventListener('blur', releasePointer); releasePointer(); };
  }, []);
  return <div className="pet-overlay" onContextMenu={(event) => { event.preventDefault(); void window.petdBootstrap?.showPetMenu(); }} title="点一下戳戳 · 拖动移动 · 右键菜单">
    <svg className="pet-alpha-filter" aria-hidden="true"><defs><filter id="pet-alpha-fix"><feComponentTransfer><feFuncA type="linear" slope="1" intercept="-0.0039215686"/></feComponentTransfer></filter></defs></svg>
    <div className="pet-art-target" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
      <div ref={petFloat} className="pet-float"><video ref={petVideo} onLoadedData={syncPetHitRegions} src={fishIdle} autoPlay loop muted playsInline aria-label="蓝色大肥鱼女仆，待机呼吸动画"/></div>
    </div>
    {reaction && <div className="pet-reply-bubble" role="status" aria-live="polite"><div className="en">{reaction.en}</div><div className="zh">{reaction.zh}</div></div>}
  </div>;
}

