import { useCallback, useEffect, useRef, useState } from 'react';
import type { ElementType, ReactNode } from 'react';
import { Archive, ChevronDown, ChevronRight, FileText, Folder, History, Paperclip, RefreshCw, Save, Upload, X } from 'lucide-react';
import { request, subscribeEvents } from './petd';
import './memory-panel.css';

type MemoryEntry = { name: string; path: string; type: 'file' | 'dir'; size: number; mtimeMs: number };
type MemoryCommit = { hash: string; fullHash: string; author: string; date: string; message: string };
type BlobMeta = { handle: string; path: string; name: string; mime: string; size: number; sha256: string; createdAt: string };
export type QueuedAttachment = BlobMeta;
type MemoryPanelProps = { connected: boolean; onUseAttachment: (attachment: QueuedAttachment) => boolean; onRemoveAttachment: (handle: string) => void };
type ConflictState = { latest: string; latestHash: string };

const residentPaths = new Set(['PARTNER.md']);
const formatBytes = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
const errorText = (error: any) => error?.code === 'E_UNKNOWN_METHOD'
  ? '当前 petd 还没有这个方法，更新 petd 后即可使用。'
  : error?.code === 'E_FORBIDDEN' ? (error.message || '这是常驻文件，不能删除或移动。')
    : error?.message || '操作失败，请重试。';

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function uploadAttachmentFile(file: File): Promise<QueuedAttachment> {
  if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} 超过 8 MiB 上限`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return request('blob.put', { dataBase64: btoa(binary), name: file.name, mime: file.type || undefined }) as Promise<QueuedAttachment>;
}

function classify(meta: BlobMeta): 'image' | 'text' | 'audio' | 'video' | 'file' {
  if (meta.mime.startsWith('image/')) return 'image';
  if (meta.mime.startsWith('audio/')) return 'audio';
  if (meta.mime.startsWith('video/')) return 'video';
  if (meta.mime.startsWith('text/') || /json|yaml|javascript|typescript|xml/.test(meta.mime)) return 'text';
  return 'file';
}

function inlineMarkdown(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    return part;
  });
}

function MarkdownPreview({ content }: { content: string }) {
  const lines = content.split('\n');
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]?.startsWith('```')) code.push(lines[i++] ?? '');
      i += 1;
      blocks.push(<pre key={`code-${i}`}><code>{code.join('\n')}</code></pre>);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)?.[0].length ?? 1;
      const text = line.replace(/^#{1,6}\s+/, '');
      const Heading = `h${level}` as ElementType;
      blocks.push(<Heading key={`heading-${i}`}>{inlineMarkdown(text)}</Heading>);
      i += 1;
    } else if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i] ?? '')) items.push((lines[i++] ?? '').replace(/^\s*[-*+]\s+/, ''));
      blocks.push(<ul key={`list-${i}`}>{items.map((item, index) => <li key={index}>{inlineMarkdown(item)}</li>)}</ul>);
    } else if (/^>\s?/.test(line)) {
      blocks.push(<blockquote key={`quote-${i}`}>{inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>);
      i += 1;
    } else if (!line.trim()) i += 1;
    else {
      const paragraph = [line];
      i += 1;
      while (i < lines.length && lines[i]?.trim() && !/^#{1,6}\s|^\s*[-*+]\s+|^>|^```/.test(lines[i] ?? '')) paragraph.push(lines[i++] ?? '');
      blocks.push(<p key={`p-${i}`}>{inlineMarkdown(paragraph.join(' '))}</p>);
    }
  }
  return <div className="markdown-preview">{blocks.length ? blocks : <p className="memory-muted">空文件</p>}</div>;
}

export function MemoryPanel({ connected, onUseAttachment, onRemoveAttachment }: MemoryPanelProps) {
  const [workspace, setWorkspace] = useState('');
  const [fileCount, setFileCount] = useState(0);
  const [entriesByDir, setEntriesByDir] = useState<Record<string, MemoryEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [selectedPath, setSelectedPath] = useState('');
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [baseHash, setBaseHash] = useState('');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedCommit, setSavedCommit] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [rightTab, setRightTab] = useState<'history' | 'attachments'>('history');
  const [commits, setCommits] = useState<MemoryCommit[]>([]);
  const [selectedCommit, setSelectedCommit] = useState('');
  const [diff, setDiff] = useState('');
  const [methods, setMethods] = useState<Set<string>>(new Set());
  const [blobs, setBlobs] = useState<BlobMeta[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [textPreviews, setTextPreviews] = useState<Record<string, string>>({});
  const [imagePreview, setImagePreview] = useState<{ src: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const dirty = draft !== content;
  const hasMethod = useCallback((name: string) => methods.has(name), [methods]);

  const loadDirectory = useCallback(async (dir: string) => {
    const result = await request('memory.list', dir ? { dir } : {});
    const entries = (result.entries as MemoryEntry[]).filter((entry) => entry.path !== 'blobs' && !entry.path.startsWith('blobs/'));
    setEntriesByDir((current) => ({ ...current, [dir]: entries }));
    return entries;
  }, []);

  const loadFile = useCallback(async (filePath: string) => {
    const result = await request('memory.read', { path: filePath });
    const nextContent = String(result.content ?? '');
    setSelectedPath(filePath);
    setContent(nextContent);
    setDraft(nextContent);
    setBaseHash(await sha256(nextContent));
    setSavedCommit('');
    setPreview(false);
    setConflict(null);
    setSelectedCommit('');
    setDiff('');
  }, []);

  const loadHistory = useCallback(async (filePath: string) => {
    if (!filePath) { setCommits([]); return; }
    try {
      const result = await request('memory.history', { path: filePath, limit: 40 });
      setCommits(result.commits as MemoryCommit[]);
    } catch (cause) { setError(errorText(cause)); }
  }, []);

  const refresh = useCallback(async () => {
    if (!connected) return;
    setError('');
    try {
      const [status, health] = await Promise.all([request('memory.status', {}), request('health.status', {})]);
      const root = String(status.workspace ?? status.dir ?? '');
      setWorkspace(root);
      setFileCount(Number(status.fileCount ?? 0));
      const names = (health.methods as Array<string | { name: string }>).map((item) => typeof item === 'string' ? item : item.name);
      setMethods(new Set(names));
      if (root) await window.petdBootstrap?.setMemoryWorkspace(root);
      await loadDirectory('');
      if (selectedPath) await loadHistory(selectedPath);
    } catch (cause) { setError(errorText(cause)); }
  }, [connected, loadDirectory, loadHistory, selectedPath]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!connected) return;
    const unsubscribe = subscribeEvents((frame) => {
      if (frame.event !== 'memory.changed') return;
      const data = (frame.data ?? {}) as { path?: string; from?: string; to?: string };
      const changedPaths = [data.path, data.from, data.to].filter((item): item is string => Boolean(item));
      const directories = new Set<string>();
      for (const changedPath of changedPaths) directories.add(changedPath.includes('/') ? changedPath.slice(0, changedPath.lastIndexOf('/')) : '');
      directories.forEach((dir) => { if (entriesByDir[dir] !== undefined) void loadDirectory(dir).catch(() => {}); });
      if (selectedPath && changedPaths.includes(selectedPath) && !savingRef.current) {
        void request('memory.read', { path: selectedPath }).then(async (result) => {
          const latest = String(result.content ?? '');
          const latestHash = await sha256(latest);
          if (latestHash === baseHash) return;
          if (dirty) setConflict({ latest, latestHash });
          else { setContent(latest); setDraft(latest); setBaseHash(latestHash); }
          void loadHistory(selectedPath);
        }).catch(() => {});
      }
    });
    return () => { unsubscribe(); };
  }, [connected, entriesByDir, loadDirectory, loadHistory, selectedPath, baseHash, dirty]);

  useEffect(() => {
    if (!connected || rightTab !== 'attachments') return;
    let active = true;
    request('blob.list', {}).then(async (result) => {
      if (!active) return;
      const list = result.blobs as BlobMeta[];
      setBlobs(list);
      const imageMetas = list.filter((meta) => classify(meta) === 'image');
      const imageResults = await Promise.all(imageMetas.map(async (meta) => {
        try { return [meta.sha256, (await window.petdBootstrap?.getBlobThumbnail({ name: meta.name, sha256: meta.sha256 })) ?? ''] as const; }
        catch { return [meta.sha256, ''] as const; }
      }));
      if (active) setThumbnails((current) => ({ ...current, ...Object.fromEntries(imageResults.filter(([, src]) => Boolean(src))) }));
      const mediaMetas = list.filter((meta) => ['audio', 'video'].includes(classify(meta)));
      const mediaResults = await Promise.all(mediaMetas.map(async (meta) => {
        try { return [meta.handle, (await window.petdBootstrap?.getBlobFileUrl({ name: meta.name })) ?? ''] as const; }
        catch { return [meta.handle, ''] as const; }
      }));
      if (active) setMediaUrls((current) => ({ ...current, ...Object.fromEntries(mediaResults.filter(([, src]) => Boolean(src))) }));
      if (hasMethod('blob.preview')) {
        const textMetas = list.filter((meta) => classify(meta) === 'text');
        const previews = await Promise.all(textMetas.map(async (meta) => {
          try { const item = await request('blob.preview', { ref: meta.handle, maxChars: 240 }); return [meta.handle, String(item.text ?? '')] as const; }
          catch { return [meta.handle, ''] as const; }
        }));
        if (active) setTextPreviews((current) => ({ ...current, ...Object.fromEntries(previews) }));
      }
    }).catch((cause) => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [connected, rightTab, hasMethod]);

  async function toggleDirectory(entry: MemoryEntry) {
    const next = new Set(expanded);
    if (next.has(entry.path)) next.delete(entry.path);
    else {
      next.add(entry.path);
      if (entriesByDir[entry.path] === undefined) {
        try { await loadDirectory(entry.path); } catch (cause) { setError(errorText(cause)); }
      }
    }
    setExpanded(next);
  }

  async function selectFile(entry: MemoryEntry) {
    if (dirty && !window.confirm('当前文件有未保存的修改，切换后会丢弃草稿。继续吗？')) return;
    setError('');
    try { await loadFile(entry.path); await loadHistory(entry.path); }
    catch (cause) { setError(errorText(cause)); }
  }

  async function writeDraft(force = false) {
    if (!selectedPath || saving) return;
    setSaving(true); savingRef.current = true; setError('');
    try {
      if (!force) {
        const latest = await request('memory.read', { path: selectedPath });
        const latestContent = String(latest.content ?? '');
        const latestHash = await sha256(latestContent);
        if (latestHash !== baseHash) { setConflict({ latest: latestContent, latestHash }); setSaving(false); savingRef.current = false; return; }
      }
      let result;
      try { result = await request('memory.write', { path: selectedPath, content: draft, expectedContentHash: baseHash, ...(force ? { force: true } : {}) }); }
      catch (cause: any) {
        if (cause?.code !== 'E_BAD_PARAMS') throw cause;
        result = await request('memory.write', { path: selectedPath, content: draft });
      }
      const nextHash = await sha256(draft);
      setContent(draft); setBaseHash(nextHash); setSavedCommit(String(result.commit ?? '')); setConflict(null);
      await Promise.all([loadDirectory(selectedPath.includes('/') ? selectedPath.slice(0, selectedPath.lastIndexOf('/')) : ''), loadHistory(selectedPath)]);
    } catch (cause: any) {
      if (cause?.code === 'E_CONFLICT') {
        try { const latest = await request('memory.read', { path: selectedPath }); const latestContent = String(latest.content ?? ''); setConflict({ latest: latestContent, latestHash: await sha256(latestContent) }); }
        catch (readError) { setError(errorText(readError)); }
      } else setError(errorText(cause));
    } finally { setSaving(false); savingRef.current = false; }
  }

  async function loadLatest() {
    if (!conflict) return;
    setContent(conflict.latest); setDraft(conflict.latest); setBaseHash(conflict.latestHash); setConflict(null);
  }

  async function overwriteConflict() {
    if (!window.confirm('这会覆盖其他来源刚写入的内容，并产生一个新提交。仍要覆盖吗？')) return;
    await writeDraft(true);
  }

  async function showDiff(commit: MemoryCommit) {
    setSelectedCommit(commit.hash); setDiff(''); setError('');
    try { const result = await request('memory.diff', { hash: commit.hash, path: selectedPath }); setDiff(String(result.diff ?? '')); }
    catch (cause) { setError(errorText(cause)); }
  }

  async function restoreCommit() {
    if (!selectedCommit || !selectedPath || !hasMethod('memory.restore')) return;
    if (!window.confirm('恢复会把这个版本的文件内容写回当前工作区，并新增一条提交，不会改写历史。继续吗？')) return;
    setError('');
    try { await request('memory.restore', { path: selectedPath, hash: selectedCommit, expectedContentHash: baseHash }); await loadFile(selectedPath); await loadHistory(selectedPath); setRightTab('history'); }
    catch (cause) { setError(errorText(cause)); }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setError('');
    let stored = false;
    try {
      try { for (const file of Array.from(files)) { await uploadAttachmentFile(file); stored = true; } }
      catch (cause) { setError(errorText(cause)); }
      if (stored) { try { const result = await request('blob.list', {}); setBlobs(result.blobs as BlobMeta[]); } catch (cause) { setError(errorText(cause)); } }
    } finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  }

  async function deleteBlob(meta: BlobMeta) {
    if (!window.confirm(`永久删除附件「${meta.name}」？`)) return;
    try { await request('blob.delete', { ref: meta.handle }); setBlobs((current) => current.filter((item) => item.handle !== meta.handle)); onRemoveAttachment(meta.handle); }
    catch (cause) { setError(errorText(cause)); }
  }

  function useAttachment(meta: BlobMeta) {
    if (!onUseAttachment(meta)) setError('一条消息最多附带 10 个附件，请先移除待发送附件。');
  }

  async function openImage(meta: BlobMeta) {
    try {
      const result = await request('blob.get', { ref: meta.handle });
      setImagePreview({ src: `data:${result.meta.mime};base64,${result.dataBase64}`, name: meta.name });
    } catch (cause) { setError(errorText(cause)); }
  }

  const tree = (() => {
    const render = (dir: string, depth: number): ReactNode => (entriesByDir[dir] ?? []).map((entry) => {
      const isResident = residentPaths.has(entry.path);
      const isExpanded = expanded.has(entry.path);
      return <div key={entry.path}>
        <button className={`memory-tree-row ${selectedPath === entry.path ? 'selected' : ''} ${isResident ? 'resident' : ''}`} style={{ paddingLeft: 10 + depth * 15 }} onClick={() => entry.type === 'dir' ? void toggleDirectory(entry) : void selectFile(entry)} disabled={!connected} title={`${entry.path} · ${formatBytes(entry.size)}`}>
          {entry.type === 'dir' ? (isExpanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>) : <span className="tree-indent"/>}
          {entry.type === 'dir' ? <Folder size={14}/> : <FileText size={14}/>}
          <span className="memory-tree-label"><strong>{entry.name}</strong><small>{formatBytes(entry.size)} · {new Date(entry.mtimeMs).toLocaleDateString()}</small></span>
          {isResident && <span className="resident-badge">常驻</span>}
        </button>
        {entry.type === 'dir' && isExpanded && render(entry.path, depth + 1)}
      </div>;
    });
    return render('', 0);
  })();

  return <section className="memory-screen">
    <aside className="memory-tree-panel">
      <div className="memory-tree-head"><div><span className="eyebrow">WORKSPACE</span><h2>记忆库</h2></div><button className="memory-icon-button" onClick={() => void refresh()} disabled={!connected} title="刷新"><RefreshCw size={15}/></button></div>
      <div className="memory-workspace-path" title={workspace}>{workspace || '正在读取工作区…'}</div>
      <div className="memory-tree-list">{tree}{entriesByDir['']?.length === 0 && <p className="memory-muted">工作区里还没有文件</p>}</div>
      <div className="memory-file-count">{fileCount} 个记忆文件</div>
    </aside>

    <section className="memory-editor-panel">
      <header className="memory-editor-header"><div className="memory-path-title"><span className="eyebrow">MEMORY</span><strong>{selectedPath || '选择一份记忆开始阅读'}</strong></div>{selectedPath && <div className="memory-editor-actions"><span className="memory-save-state">{saving ? '保存中…' : dirty ? '未保存' : savedCommit ? `已保存 · ${savedCommit.slice(0, 8)}` : '已同步'}</span><button className="memory-mode-button" onClick={() => setPreview((value) => !value)} disabled={!selectedPath}>{preview ? '编辑' : '预览'}</button><button className="primary-action" onClick={() => void writeDraft()} disabled={!dirty || saving || !selectedPath || !connected}><Save size={14}/>{saving ? '保存中' : '保存'}</button></div>}</header>
      <div className="memory-editor-content">
        {error && <div className="memory-error">{error}</div>}
        {selectedPath ? preview ? <MarkdownPreview content={draft}/> : <textarea className="memory-editor" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} aria-label="记忆文件编辑器"/> : <div className="memory-empty-state"><Archive size={30}/><h3>把重要的事留在这里</h3><p>从左侧选择记忆文件，编辑并保存后会留下 Git 历史。</p></div>}
        {conflict && <div className="memory-conflict-backdrop"><section className="memory-conflict" role="alertdialog" aria-modal="true" aria-label="记忆冲突"><h3>这份记忆已被更新</h3><p>磁盘内容和你打开时不同。载入最新内容，或确认覆盖其他来源的修改。</p><div className="memory-conflict-version"><strong>你的未保存草稿</strong><textarea className="memory-conflict-preview" readOnly value={draft}/></div><div className="memory-conflict-version"><strong>磁盘最新内容</strong><pre className="memory-conflict-preview">{conflict.latest.slice(0, 600)}{conflict.latest.length > 600 ? '…' : ''}</pre></div><div className="memory-conflict-actions"><button onClick={() => void loadLatest()}>载入最新</button><button className="danger-action" onClick={() => void overwriteConflict()}>覆盖</button></div></section></div>}
      </div>
    </section>

    <aside className="memory-aside-panel">
      <div className="memory-aside-tabs"><button className={rightTab === 'history' ? 'active' : ''} onClick={() => setRightTab('history')}><History size={14}/>历史</button><button className={rightTab === 'attachments' ? 'active' : ''} onClick={() => setRightTab('attachments')}><Paperclip size={14}/>附件</button></div>
      {rightTab === 'history' ? <div className="memory-history-panel">
        {!selectedPath ? <p className="memory-muted">选择文件后查看版本历史</p> : commits.length ? commits.map((commit) => <button key={commit.hash} className={`memory-commit ${selectedCommit === commit.hash ? 'selected' : ''}`} onClick={() => void showDiff(commit)} disabled={!connected}><strong>{commit.hash.slice(0, 8)}</strong><span>{commit.message}</span><small>{commit.author} · {new Date(commit.date).toLocaleString()}</small></button>) : <p className="memory-muted">还没有提交历史</p>}
        {selectedCommit && <section className="memory-diff"><div className="memory-diff-head"><strong>差异</strong><button disabled={!hasMethod('memory.restore')} onClick={() => void restoreCommit()} title={hasMethod('memory.restore') ? '恢复所选版本' : '等待 petd 实现 memory.restore'}>恢复此版本</button></div>{!hasMethod('memory.restore') && <p className="memory-pending">恢复接口待 petd 补齐</p>}<pre>{diff || '选择一个版本查看差异'}</pre></section>}
      </div> : <div className="memory-attachments-panel">
        <div className="memory-attachment-head"><span>{blobs.length} 个附件</span><button onClick={() => fileInput.current?.click()} disabled={uploading || !connected}><Upload size={14}/>{uploading ? '上传中…' : '上传'}</button><input ref={fileInput} type="file" multiple hidden onChange={(event) => void uploadFiles(event.target.files)}/></div>
        {blobs.length === 0 ? <p className="memory-muted">还没有附件</p> : blobs.map((meta) => {
          const kind = classify(meta);
          return <article className="memory-blob-card" key={meta.handle}>
            <div className="memory-blob-preview">
              {kind === 'image' ? thumbnails[meta.sha256] ? <button className="blob-thumbnail" onClick={() => void openImage(meta)} title="点击读取原图"><img src={thumbnails[meta.sha256]} alt={meta.name}/></button> : <span className="memory-pending">正在生成本地缩略图…</span>
                : kind === 'text' ? <pre>{textPreviews[meta.handle] || (hasMethod('blob.preview') ? '读取摘要…' : '等待 petd 实现 blob.preview')}</pre>
                  : kind === 'audio' && mediaUrls[meta.handle] ? <audio controls src={mediaUrls[meta.handle]}/>
                    : kind === 'video' && mediaUrls[meta.handle] ? <video controls src={mediaUrls[meta.handle]}/>
                      : <span className="blob-file-icon"><FileText size={22}/></span>}
            </div>
            <strong title={meta.name}>{meta.name}</strong><small>{meta.mime || '未知类型'} · {formatBytes(meta.size)}</small><code title={meta.handle}>{meta.handle}</code>
            <div className="memory-blob-actions"><button onClick={() => useAttachment(meta)} disabled={!connected}>用于聊天</button><button className="blob-delete" onClick={() => void deleteBlob(meta)} disabled={!connected} aria-label={`删除 ${meta.name}`}><X size={13}/></button></div>
          </article>;
        })}
      </div>}
    </aside>
    {imagePreview && <div className="memory-image-backdrop" role="presentation" onClick={() => setImagePreview(null)}><div className="memory-image-dialog" role="dialog" aria-modal="true" aria-label={imagePreview.name} onClick={(event) => event.stopPropagation()}><button className="memory-image-close" onClick={() => setImagePreview(null)} aria-label="关闭"><X/></button><img src={imagePreview.src} alt={imagePreview.name}/><span>{imagePreview.name}</span></div></div>}
  </section>;
}
