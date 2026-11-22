import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { request, subscribeEvents, usePetdStatus } from './petd';
import './skills-panel.css';

type Skill = { key: string; name: string; description: string; keywords: string[]; always: boolean; source: 'workspace' | 'plugin'; pluginId?: string; bodyChars: number; updatedAt: string; body?: string };
type Plugin = { id: string; name: string; version: string; description: string; author?: string; dir: string; enabled: boolean; skillCount: number; hasPrompt: boolean };
const errorText = (error: any) => error?.code === 'E_UNAVAILABLE' ? '技能或插件功能已关闭，请在 config.json 查看总开关。' : error?.code === 'E_FORBIDDEN' ? '插件提供的技能是只读内容。' : error?.code === 'E_CONFLICT' ? '技能名称已存在，请换一个名称。' : error?.code === 'E_NOT_FOUND' ? '项目已不存在，列表已刷新。' : error?.message ?? '操作失败，请重试。';

export function SkillsSettingsPanel({ config }: { config: any }) {
  const connection = usePetdStatus();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [selected, setSelected] = useState<Skill | null>(null);
  const [pluginDetail, setPluginDetail] = useState<Plugin | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords] = useState('');
  const [body, setBody] = useState('');
  const [always, setAlways] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function refresh() {
    if (connection.state !== 'connected') return;
    try { const [skillResult, pluginResult] = await Promise.all([request('skill.list', {}), request('plugin.list', {})]); setSkills(skillResult.skills ?? []); setPlugins(pluginResult.plugins ?? []); setError(''); }
    catch (cause) { setError(errorText(cause)); }
  }
  useEffect(() => { void refresh(); }, [connection.state]);
  useEffect(() => {
    const unsubscribe = subscribeEvents((frame) => { if (frame.event === 'plugin.changed') void refresh(); });
    return () => { unsubscribe(); };
  }, [connection.state]);
  function resetEditor() { setSelected(null); setName(''); setDescription(''); setKeywords(''); setBody(''); setAlways(false); setEditing(false); }
  async function openSkill(skill: Skill) {
    setError('');
    try { const detail = await request('skill.get', { key: skill.key }); setSelected(detail); setName(detail.name); setDescription(detail.description); setKeywords(detail.keywords.join(', ')); setBody(detail.body); setAlways(detail.always); setEditing(false); }
    catch (cause) { setError(errorText(cause)); }
  }
  function newSkill() { resetEditor(); setEditing(true); }
  async function saveSkill(event: FormEvent) {
    event.preventDefault(); if (!name.trim() || !body.trim()) { setError('请填写技能名称与正文。'); return; }
    setBusy(true); setError('');
    const payload = { name: name.trim(), description: description.trim(), body: body.trim(), keywords: keywords.split(',').map((word) => word.trim()).filter(Boolean).slice(0, 8), always };
    try {
      if (selected) await request('skill.update', payload);
      else await request('skill.create', payload);
      setNotice(selected ? `已保存技能：${name}` : `已创建技能：${name}`); resetEditor(); await refresh();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  async function removeSkill(skill: Skill) {
    if (skill.source !== 'workspace' || !window.confirm(`删除技能“${skill.name}”？会删除整个技能目录，聊天里将不再使用它。`)) return;
    try { await request('skill.delete', { name: skill.name }); if (selected?.key === skill.key) resetEditor(); setNotice(`已删除技能：${skill.name}`); await refresh(); }
    catch (cause) { setError(errorText(cause)); }
  }
  async function togglePlugin(plugin: Plugin) {
    setBusy(true); setError('');
    try { const updated = await request(plugin.enabled ? 'plugin.disable' : 'plugin.enable', { id: plugin.id }); setNotice(`${updated.enabled ? '已启用' : '已停用'}插件：${plugin.name}`); await refresh(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  async function showPlugin(plugin: Plugin) {
    try { setPluginDetail(await request('plugin.get', { id: plugin.id })); }
    catch (cause) { setError(errorText(cause)); }
  }
  const workspaceSkills = skills.filter((skill) => skill.source === 'workspace');
  const pluginSkills = skills.filter((skill) => skill.source === 'plugin');
  return <section className="skills-panel">
    <div className="skills-heading"><div><span className="eyebrow">SKILLS & PLUGINS</span><h3>技能与插件</h3></div><div><span>技能 {config?.skills?.enabled === false ? '关闭' : '开启'}</span><span>插件 {config?.plugins?.enabled === false ? '关闭' : '开启'}</span></div></div>
    <p className="skills-note">技能和插件会进入系统提示词；常驻技能会额外注入正文。技能越多提示词越长，需要时也可以在聊天里让小鱼按需加载。</p>
    {error && <p className="skills-error" role="alert">{error}</p>}{notice && <p className="skills-notice" role="status">{notice}</p>}
    <div className="skills-section-head"><strong>我的技能</strong><button disabled={config?.skills?.enabled === false || connection.state !== 'connected'} onClick={newSkill}>新建技能</button></div>
    {!workspaceSkills.length && <p className="skills-empty">还没有工作区技能。</p>}
    {workspaceSkills.map((skill) => <article className={`skill-row ${selected?.key === skill.key ? 'selected' : ''}`} key={skill.key}><button className="skill-open" onClick={() => void openSkill(skill)}><strong>{skill.name}</strong><span>{skill.description || '暂无说明'}</span><small>{skill.keywords.join(' · ')}{skill.keywords.length ? ' · ' : ''}{skill.bodyChars} 字</small></button><div><span className="skill-badge">工作区</span>{skill.always && <span className="skill-badge always">常驻</span>}<button onClick={() => void removeSkill(skill)} disabled={config?.skills?.enabled === false}>删除</button></div></article>)}
    {!!pluginSkills.length && <><div className="skills-section-head"><strong>插件提供的技能</strong><span>{pluginSkills.length} 条 · 只读</span></div>{pluginSkills.map((skill) => <article className="skill-row" key={skill.key}><button className="skill-open" onClick={() => void openSkill(skill)}><strong>{skill.name}</strong><span>{skill.description || '暂无说明'}</span><small>{skill.keywords.join(' · ')} · {skill.bodyChars} 字</small></button><div><span className="skill-badge readonly">随插件提供 · 只读</span>{skill.always && <span className="skill-badge always">常驻</span>}</div></article>)}</>}
    {(editing || selected) && <form className="skill-editor" onSubmit={(event) => void saveSkill(event)}><div className="skill-editor-head"><h4>{selected ? `技能：${selected.name}` : '新建技能'}</h4><button type="button" onClick={resetEditor}>关闭</button></div>{selected?.source === 'plugin' ? <><p className="skills-note">由插件「{selected.pluginId}」提供，只读。</p><pre>{selected.body}</pre></> : <><label>名称<input value={name} maxLength={64} pattern="[A-Za-z0-9_-]+" onChange={(event) => setName(event.target.value)} disabled={!editing || config?.skills?.enabled === false}/></label><label>说明<input value={description} maxLength={200} onChange={(event) => setDescription(event.target.value)} disabled={!editing || config?.skills?.enabled === false}/></label><label>关键词（逗号分隔，最多 8 个）<input value={keywords} onChange={(event) => setKeywords(event.target.value)} disabled={!editing || config?.skills?.enabled === false}/></label><label className="skill-always"><input type="checkbox" checked={always} onChange={(event) => setAlways(event.target.checked)} disabled={!editing || config?.skills?.enabled === false}/>常驻注入正文（会增加每轮提示词长度）</label><label>正文<textarea rows={9} maxLength={20000} value={body} onChange={(event) => setBody(event.target.value)} disabled={!editing || config?.skills?.enabled === false}/></label><div className="skill-form-actions">{selected && !editing && <button type="button" onClick={() => setEditing(true)} disabled={config?.skills?.enabled === false}>编辑技能</button>}{editing && <button className="skill-primary" disabled={busy || config?.skills?.enabled === false}>{busy ? '保存中…' : selected ? '保存修改' : '创建技能'}</button>}</div></>}</form>}
    <div className="skills-section-head"><strong>插件</strong><span>{plugins.length} 个 · 本地声明式插件</span></div>
    {!plugins.length && <p className="skills-empty">没有已安装的插件目录。</p>}
    {plugins.map((plugin) => <article className="plugin-row" key={plugin.id}><button onClick={() => void showPlugin(plugin)}><strong>{plugin.name}</strong><span>{plugin.description}</span><small>v{plugin.version} · {plugin.author || '未知作者'} · {plugin.skillCount} 个技能{plugin.hasPrompt ? ' · 含额外提示词' : ''}</small></button><label><input type="checkbox" checked={plugin.enabled} onChange={() => void togglePlugin(plugin)} disabled={busy || config?.plugins?.enabled === false}/> {plugin.enabled ? '已启用' : '已停用'}</label></article>)}
    {pluginDetail && <div className="plugin-detail-backdrop" onClick={() => setPluginDetail(null)}><div className="plugin-detail" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><button onClick={() => setPluginDetail(null)}>关闭</button><h4>{pluginDetail.name} · v{pluginDetail.version}</h4><p>{pluginDetail.description}</p><small>{pluginDetail.dir}</small><p>{pluginDetail.skillCount} 个技能 · {pluginDetail.hasPrompt ? '包含 prompt.md' : '没有额外提示词'} · {pluginDetail.enabled ? '启用中' : '已停用'}</p></div></div>}
  </section>;
}
