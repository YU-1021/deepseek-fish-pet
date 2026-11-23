import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 8765);
const moodEnabled = process.env.MOCK_MOOD_ENABLED !== 'false';
const clients = new Set();
let sequence = 0;
const mood = { mood: 70, affection: 30, energy: 80, pokes: 0, updatedAt: Date.now(), tiers: { mood: '心情不错', affection: '逐渐熟悉', energy: '正常' } };
const moodHistory = [];
const hooksConfig = { enabled: true, mode: 'smart', approvalEnabled: true, approvalTimeoutMs: 30000, riskEnabled: true };
let hookRules = [
  { id: 'builtin-file-delete', description: '删除文件需要确认', enabled: true, kind: 'tool', names: ['file_delete', 'memory_delete'], action: 'ask', priority: 100, builtin: true },
  { id: 'user-demo-deny', description: '拒绝危险终端参数', enabled: true, kind: 'tool', names: ['cua_type'], action: 'deny', argContains: 'rm -rf /', message: '危险终端命令已拦截。', priority: 10 },
];
let pendingApprovals = [];
const presenceConfig = { enabled: true, quiet: true, intervalMinutes: 45, idleMinutes: 10, maxPerDay: 12, nightQuiet: { enabled: true, start: '23:00', end: '07:00' } };
let presenceActivities = [];
const voiceConfig = { enabled: true, engine: 'edge', voice: 'zh-CN-XiaoxiaoNeural', rate: 1, pitch: 1, autoSpeak: false };
const asrConfig = { enabled: true, engine: 'whisper.cpp', model: 'tiny', language: 'auto', wakeEnabled: true, wakeWords: ['你好大肥鱼'], autoChat: false };
const asrModels = [
  { name: 'tiny', ready: true, current: true, sizeBytes: 75_000_000 },
  { name: 'base', ready: false, current: false, sizeBytes: 148_000_000 },
  { name: 'small', ready: false, current: false, sizeBytes: 488_000_000 },
];
let mockAsrStream = '';
let mockAsrFeedCount = 0;
const remindersConfig = { enabled: true, maxPending: 50, catchUpHours: 24, keepFiredDays: 7 };
let reminders = [];
const reminderTimers = new Map();
const automationConfig = { enabled: process.env.MOCK_AUTOMATION_ENABLED === 'true', tickSeconds: 30, catchUpMinutes: 60, maxJobs: 50, maxRunsKept: 100, runTimeoutMs: 240000 };
let automationJobs = [];
let automationRuns = [];
const skillsConfig = { enabled: true, dir: 'mock://skills', promptMaxChars: 12000 };
const pluginsConfig = { enabled: true, dir: 'mock://plugins' };
let mockSkills = [
  { key: 'workspace:daily-review', name: 'daily-review', description: '整理每日计划', keywords: ['计划', '复盘'], always: false, source: 'workspace', bodyChars: 34, updatedAt: new Date().toISOString(), body: '先总结今天完成的事，再列出明天最重要的三项。' },
  { key: 'plugin:demo-companion:gentle-planner', name: 'gentle-planner', description: '把计划拆成小步骤。', keywords: ['计划'], always: false, source: 'plugin', pluginId: 'demo-companion', bodyChars: 20, updatedAt: new Date().toISOString(), body: '将复杂任务拆成轻松可开始的步骤。' },
];
let mockPlugins = [{ id: 'demo-companion', name: '伙伴小工具', version: '1.0.0', description: '示例插件，提供一个轻量规划技能。', author: 'mock', dir: 'mock://plugins/demo-companion', enabled: true, skillCount: 1, hasPrompt: true }];
const cuaConfig = { enabled: process.env.MOCK_CUA_ENABLED === 'true', control: true, permission: 'ask-once', grantMinutes: 30, skipTerminalAsk: false, screenshot: { maxWidth: 1280, maxHeight: 800, quality: 75, afterAction: true }, includeImages: false };
let runPaused = false;
const dshConfig = { enabled: true, observe: true, exePath: 'mock://DeepSeek Harness.exe', cliPath: '', cwd: '', provider: 'mock', model: 'mock-model', reasoningEffort: 'medium', maxTokens: 4096, approvalPolicy: 'reject', askTimeoutMs: 120000, observeIntervalMs: 1500, activeMs: 15000 };
let dshRuntimeRunning = false;
let dshMockState = { sessionId: 'mock-dsh-session', workspace: 'F:\\DSH\\demo', workspaceRaw: '--F-DSH-demo--', file: 'mock-session.v4.jsonl.zstd', mtimeMs: Date.now(), size: 1024, state: 'idle', active: false, turn: null, step: null, tool: null, lastText: null, lastEventType: null, updatedAt: Date.now(), events: 5 };
const mockAuditScope = { scope: 'AI 只写 home/skills 与 memory 中允许的动态内容（模拟）', memoryZone: 'memory', zones: ['*.agent.md', '*.agent.json', 'memory/'], auditFile: 'mock://state/agent-audit.jsonl' };
let mockAuditEntries = [{ id: 'mock-audit-1', ts: new Date().toISOString(), actor: 'agent', action: 'write', path: 'SOUL.agent.md', zone: 'agent-file', reason: '根据最近相处经历微调表达方式', before: { hash: 'before-hash', bytes: 20, text: '## 说话方式\n简洁温柔。' }, after: { hash: 'after-hash', bytes: 25, text: '## 说话方式\n简洁温柔，偶尔俏皮。' }, diff: ' ## 说话方式\n-简洁温柔。\n+简洁温柔，偶尔俏皮。', diffChars: 5 }];
const learningConfig = { enabled: true, requireApproval: true, grayPercent: 20, grayDays: 7, maxPending: 20, promptMaxChars: 12000 };
let learningItems = [{ id: 'mock-learning-1', kind: 'preference', name: '简短解释偏好', reason: '近期多次要求先给结论，再展开细节。', path: 'mock://learning/proposals/short-answer.json', createdAt: Date.now() - 3600000, status: 'pending', diff: '+ 回复先给一句简短结论。', contentChars: 95, body: '{\n  "content": "回复先给简短结论，再按需补充细节。"\n}' }];

function mockWavBase64(durationMs = 450) {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * durationMs / 1000);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  return wav.toString('base64');
}

function frame(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function consumeFrame(buffer) {
  if (buffer.length < 2) return null;
  const lengthCode = buffer[1] & 0x7f;
  const masked = (buffer[1] & 0x80) !== 0;
  let headerLength = 2;
  let length = lengthCode;
  if (lengthCode === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2); headerLength = 4;
  } else if (lengthCode === 127) {
    if (buffer.length < 10) return null;
    const largeLength = buffer.readBigUInt64BE(2);
    if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('mock WebSocket frame is too large');
    length = Number(largeLength); headerLength = 10;
  }
  const maskLength = masked ? 4 : 0;
  const end = headerLength + maskLength + length;
  if (buffer.length < end) return null;
  const payload = Buffer.from(buffer.subarray(headerLength + maskLength, end));
  if (masked) {
    const mask = buffer.subarray(headerLength, headerLength + 4);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { opcode: buffer[0] & 0x0f, payload, remaining: buffer.subarray(end) };
}

function send(socket, value) {
  if (!socket.destroyed) socket.write(frame(JSON.stringify(value)));
}

function publishMood(applied, source, reason) {
  const event = { type: 'event', event: 'mood.changed', seq: ++sequence, ts: Date.now(), data: { state: { ...mood }, applied, source, reason } };
  for (const socket of clients) send(socket, event);
}

function publishEvent(event, data) {
  const payload = { type: 'event', event, seq: ++sequence, ts: Date.now(), data };
  for (const socket of clients) send(socket, payload);
}

function armReminder(item) {
  const old = reminderTimers.get(item.id);
  if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    if (Date.now() < item.at) { armReminder(item); return; }
    reminders = reminders.filter((entry) => entry.id !== item.id);
    reminderTimers.delete(item.id);
    publishEvent('reminder.due', { item, firedLateMs: Math.max(0, Date.now() - item.at) });
  }, Math.max(1, Math.min(2_147_000_000, item.at - Date.now())));
  timer.unref?.(); reminderTimers.set(item.id, timer);
}

function handleMessage(socket, message) {
  const input = JSON.parse(message);
  if (input.type === 'connect') {
    send(socket, { type: 'hello', server: { name: 'petd', version: '0.1.0-mock', protocol: 1, pid: process.pid }, sessionId: 'mock-session' });
    if (process.env.MOCK_APPROVAL_REQUEST === 'true') setTimeout(() => {
      const pending = { id: `mock-approval-${Date.now()}`, kind: 'method', name: 'memory.delete', ruleId: 'builtin-file-delete', title: '删除工作区记忆文件', detail: '删除 memory/notes/draft.md，此操作不可恢复。', risk: 'high', riskReason: '操作将永久移除工作区文件，且没有可用的自动回滚。', requestedAt: Date.now(), deadlineAt: Date.now() + hooksConfig.approvalTimeoutMs, sessionId: 'mock-session' };
      pendingApprovals.unshift(pending);
      publishEvent('approval.requested', pending);
    }, 800);
    if (process.env.MOCK_CUA_PERMISSION === 'true') setTimeout(() => publishEvent('cua.permission', { id: `mock-permission-${Date.now()}`, kind: 'act', question: '示例任务请求在当前窗口中点击一个按钮。', deadlineAt: Date.now() + 60000 }), 1200);
    if (process.env.MOCK_DSH_APPROVAL === 'true') setTimeout(() => publishEvent('dsh.approval', { id: `mock-dsh-approval-${Date.now()}`, sessionId: 'mock-private-session', toolName: 'Bash', reason: '该命令会修改工作区文件。', at: Date.now() }), 1600);
    return;
  }
  if (input.type !== 'req') return;

  let data = { pong: true };
  if (input.method === 'health.status') {
    data = { server: { version: '0.1.0-mock' }, methods: ['health.ping', 'health.status', 'config.get', 'session.list', 'session.get', 'chat.send', 'mood.status', 'mood.history', 'mood.adjust', 'mood.poke', 'mood.evaluate', 'hooks.status', 'hooks.list', 'hooks.get', 'hooks.create', 'hooks.update', 'hooks.delete', 'hooks.toggle', 'hooks.assess', 'approval.list', 'approval.answer', 'presence.status', 'presence.list', 'presence.run_once', 'voice.status', 'voice.voices', 'voice.speak', 'asr.status', 'asr.models', 'asr.download', 'asr.transcribe', 'asr.listen.start', 'asr.listen.feed', 'asr.listen.stop', 'reminder.status', 'reminder.list', 'reminder.create', 'reminder.cancel', 'reminder.snooze', 'automation.status', 'automation.list', 'automation.get', 'automation.create', 'automation.update', 'automation.delete', 'automation.pause', 'automation.resume', 'automation.run', 'automation.runs', 'skill.list', 'skill.get', 'skill.create', 'skill.update', 'skill.delete', 'plugin.list', 'plugin.get', 'plugin.enable', 'plugin.disable', 'cua.status', 'cua.screenshot', 'cua.answer', 'run.status', 'run.pause', 'run.resume', 'agent.scope', 'agent.audit.list', 'agent.audit.get', 'agent.rollback', 'dsh.status', 'dsh.observe', 'dsh.start', 'dsh.stop', 'dsh.prompt', 'dsh.ask', 'dsh.approval.answer', 'learning.status', 'learning.list', 'learning.get', 'learning.propose', 'learning.approve', 'learning.reject', 'learning.rollback'] };
  } else if (input.method === 'config.get') {
    data = { version: '0.1.0-mock', gateway: { host: '127.0.0.1', port }, log: { level: 'info' }, mood: { enabled: moodEnabled, chatInjection: true, chatNudge: true, moodDecayPerHour: 2, energyRecoverPerHour: 8 }, hooks: { ...hooksConfig, risk: { enabled: hooksConfig.riskEnabled } }, presence: { ...presenceConfig }, voice: { ...voiceConfig }, asr: { ...asrConfig, autoChat: asrConfig.autoChat }, reminders: { ...remindersConfig }, automation: { ...automationConfig }, skills: { ...skillsConfig }, plugins: { ...pluginsConfig }, cua: { ...cuaConfig }, dsh: { ...dshConfig }, learning: { ...learningConfig } };
  } else if (input.method === 'mood.status') {
    data = { enabled: moodEnabled, state: { ...mood } };
  } else if (input.method === 'hooks.status') {
    data = { ...hooksConfig, ruleCount: hookRules.length, pendingCount: pendingApprovals.length, sessionAllowedCount: 1 };
  } else if (input.method === 'hooks.list') {
    data = { rules: hookRules.map((rule) => ({ ...rule })) };
  } else if (input.method === 'hooks.get') {
    data = hookRules.find((rule) => rule.id === input.params?.id) ?? {};
  } else if (input.method === 'hooks.create') {
    const rule = { ...input.params, id: input.params?.id ?? `mock-rule-${Date.now()}`, enabled: input.params?.enabled ?? true, priority: input.params?.priority ?? 10 };
    hookRules.push(rule); data = rule; publishEvent('hooks.changed', { action: 'created', rule });
  } else if (input.method === 'hooks.update') {
    const index = hookRules.findIndex((rule) => rule.id === input.params?.id);
    if (index < 0) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '规则不存在' } }); return; }
    hookRules[index] = { ...hookRules[index], ...input.params }; data = hookRules[index]; publishEvent('hooks.changed', { action: 'updated', rule: data });
  } else if (input.method === 'hooks.toggle') {
    const rule = hookRules.find((entry) => entry.id === input.params?.id);
    if (!rule) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '规则不存在' } }); return; }
    rule.enabled = input.params.enabled === true; data = rule; publishEvent('hooks.changed', { action: 'updated', rule });
  } else if (input.method === 'hooks.delete') {
    const rule = hookRules.find((entry) => entry.id === input.params?.id);
    if (rule?.builtin) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_FORBIDDEN', message: '内置规则不能删除' } }); return; }
    hookRules = hookRules.filter((entry) => entry.id !== input.params?.id); data = { deleted: !!rule }; publishEvent('hooks.changed', { action: 'deleted', rule });
  } else if (input.method === 'hooks.assess') {
    const name = String(input.params?.name ?? '');
    const level = /delete|remove|exec|terminal|write/i.test(name) ? 'high' : 'medium';
    data = { level, reason: level === 'high' ? '模拟评审：该操作可能造成不可逆修改。' : '模拟评审：该操作有一定影响，仍需遵守规则。', cached: false, fallback: false };
  } else if (input.method === 'approval.list') {
    data = { pending: pendingApprovals.map((item) => ({ ...item })) };
  } else if (input.method === 'approval.answer') {
    const index = pendingApprovals.findIndex((item) => item.id === input.params?.id);
    if (index < 0) { data = { found: false }; }
    else {
      const [item] = pendingApprovals.splice(index, 1);
      data = { found: true };
      publishEvent('approval.resolved', { id: item.id, accepted: input.params.accepted === true, reason: 'answered', remember: input.params.remember === true });
    }
  } else if (input.method === 'presence.status') {
    data = { ...presenceConfig, countToday: presenceActivities.length, total: presenceActivities.length, last: presenceActivities[0] ?? null, nextAt: null };
  } else if (input.method === 'presence.list') {
    data = { activities: presenceActivities.slice(0, input.params?.limit ?? 50) };
  } else if (input.method === 'presence.run_once') {
    if (!presenceConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: '静默活动已关闭' } }); return; }
    const kinds = ['groom', 'stretch', 'window', 'nap', 'tidy', 'idle'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const labels = { groom: '整理羽毛', stretch: '伸懒腰', window: '看窗外', nap: '打盹', tidy: '归置东西', idle: '发呆' };
    const activity = { id: `mock-presence-${Date.now()}`, kind, label: labels[kind], at: Date.now(), quiet: true };
    presenceActivities.unshift(activity); data = activity; publishEvent('presence.activity', activity);
  } else if (input.method === 'voice.status') {
    data = { ...voiceConfig, cacheDir: 'mock://voice-cache', cacheFiles: 3, cacheBytes: 128000 };
  } else if (input.method === 'voice.voices') {
    data = { voices: [{ id: 'zh-CN-XiaoxiaoNeural', label: '晓晓', lang: 'zh-CN', engine: 'edge' }, { id: 'Microsoft Huihui Desktop', label: 'Huihui', lang: 'zh-CN', engine: 'sapi' }] };
  } else if (input.method === 'voice.speak') {
    if (!voiceConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: '语音功能已关闭' } }); return; }
    if (typeof input.params?.text !== 'string' || !input.params.text.trim() || input.params.text.length > 4000) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_BAD_PARAMS', message: '语音文本为空或超长' } }); return; }
    const speech = { id: `mock-speech-${Date.now()}`, file: 'mock.wav', mime: 'audio/wav', bytes: 0, durationMs: 450, cached: false, engine: voiceConfig.engine, voice: input.params.voice ?? voiceConfig.voice, rate: input.params.rate ?? voiceConfig.rate, pitch: input.params.pitch ?? voiceConfig.pitch, text: input.params.text, audioBase64: mockWavBase64(), elapsedMs: 5 };
    data = speech; publishEvent('voice.speech', { ...speech, audioBase64: undefined });
  } else if (input.method === 'asr.status') {
    data = { ...asrConfig, binary: { found: true, path: 'mock://whisper.cpp' }, models: asrModels.map((model) => model.name), listening: !!mockAsrStream, autoChat: asrConfig.autoChat };
  } else if (input.method === 'asr.models') {
    data = { models: asrModels.map((model) => ({ ...model })), active: asrConfig.model };
  } else if (input.method === 'asr.download') {
    const model = asrModels.find((entry) => entry.name === input.params?.model);
    if (!model) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_BAD_PARAMS', message: '未知模型' } }); return; }
    model.ready = true;
    for (const [got, total] of [[1, 4], [2, 4], [4, 4]]) setTimeout(() => publishEvent('asr.download', { model: model.name, got: got * (model.sizeBytes / 4), total: model.sizeBytes, url: 'mock://model-download' }), got === 1 ? 80 : got === 2 ? 180 : 300);
    data = { model: model.name, ready: true };
  } else if (input.method === 'asr.listen.start') {
    if (!asrConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: 'ASR 已关闭' } }); return; }
    mockAsrStream = `mock-asr-${Date.now()}`; mockAsrFeedCount = 0;
    data = { streamId: mockAsrStream, sampleRate: 16000, vad: { energyThreshold: 0.01, minSpeechMs: 240, silenceMs: 600, maxSegmentMs: 8000, preRollMs: 200 }, model: asrConfig.model, wakeWords: asrConfig.wakeWords };
  } else if (input.method === 'asr.listen.feed') {
    if (input.params?.streamId !== mockAsrStream) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '监听流已过期' } }); return; }
    mockAsrFeedCount += 1;
    const segments = mockAsrFeedCount % 4 === 0 ? [{ streamId: mockAsrStream, index: mockAsrFeedCount / 4, text: '这是本地识别的模拟字幕。', language: 'zh', durationMs: 960, tookMs: 120, wake: null }] : [];
    data = { segments };
    for (const segment of segments) publishEvent('asr.segment', segment);
  } else if (input.method === 'asr.listen.stop') {
    if (input.params?.streamId !== mockAsrStream) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '监听流已过期' } }); return; }
    mockAsrStream = ''; data = { segments: [] };
  } else if (input.method === 'asr.transcribe') {
    data = { text: '这是本地识别的模拟文本。', language: 'zh', durationMs: 1200, tookMs: 220, wake: null };
  } else if (input.method === 'reminder.status') {
    const sorted = [...reminders].sort((a, b) => a.at - b.at);
    data = { enabled: remindersConfig.enabled, pending: reminders.length, nextAt: sorted[0]?.at ?? null, armed: true };
  } else if (input.method === 'reminder.list') {
    data = { items: [...reminders].sort((a, b) => a.at - b.at) };
  } else if (input.method === 'reminder.create') {
    if (!remindersConfig.enabled || reminders.length >= remindersConfig.maxPending) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: '提醒功能已关闭或已达待响上限' } }); return; }
    const now = Date.now(); let at;
    if (Number.isFinite(input.params?.inMinutes)) at = now + input.params.inMinutes * 60000;
    else if (typeof input.params?.atClock === 'string') {
      const [hours, mins] = input.params.atClock.split(':').map(Number); const date = new Date(); date.setHours(hours, mins, 0, 0); if (date.getTime() <= now) date.setDate(date.getDate() + 1); at = date.getTime();
    } else at = typeof input.params?.at === 'number' ? input.params.at : Date.parse(input.params?.at);
    if (!Number.isFinite(at) || at <= now || !String(input.params?.text ?? '').trim()) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_BAD_PARAMS', message: '提醒时间或内容无效' } }); return; }
    const item = { id: `mock-reminder-${Date.now()}`, text: String(input.params.text).slice(0, 300), at: Math.floor(at), inMinutes: Math.max(0, Math.ceil((at - now) / 60000)), createdAt: now, snoozes: 0, source: 'user' };
    reminders.push(item); armReminder(item); data = item; publishEvent('reminder.created', { item });
  } else if (input.method === 'reminder.cancel') {
    const item = reminders.find((entry) => entry.id === input.params?.id);
    if (!item) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '提醒不存在' } }); return; }
    clearTimeout(reminderTimers.get(item.id)); reminderTimers.delete(item.id); reminders = reminders.filter((entry) => entry.id !== item.id); data = item; publishEvent('reminder.cancelled', { item });
  } else if (input.method === 'reminder.snooze') {
    const item = reminders.find((entry) => entry.id === input.params?.id);
    if (!item) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '提醒不存在' } }); return; }
    item.at = Date.now() + (input.params?.minutes ?? 5) * 60000; item.inMinutes = input.params?.minutes ?? 5; item.snoozes += 1; armReminder(item); data = item; publishEvent('reminder.snoozed', { item });
  } else if (input.method === 'automation.status') {
    const scheduled = automationJobs.filter((job) => job.enabled && job.nextRunAt).sort((a, b) => a.nextRunAt - b.nextRunAt);
    data = { enabled: automationConfig.enabled, jobs: automationJobs.length, enabledJobs: automationJobs.filter((job) => job.enabled).length, running: false, nextAt: scheduled[0]?.nextRunAt ?? null, lastRunAt: automationRuns[0]?.finishedAt ?? null };
  } else if (input.method === 'automation.list') {
    data = { jobs: [...automationJobs].sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)) };
  } else if (input.method === 'automation.get') {
    data = automationJobs.find((job) => job.id === input.params?.id) ?? {};
  } else if (input.method === 'automation.create') {
    if (!automationConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: '自动化已关闭' } }); return; }
    const schedule = input.params.schedule;
    const scheduleText = schedule.kind === 'manual' ? '只手动运行' : schedule.kind === 'interval' ? `每 ${schedule.everyMinutes} 分钟` : schedule.kind === 'daily' ? `每天 ${schedule.atClock}` : `一次性 · ${new Date(schedule.at).toLocaleString()}`;
    const nextRunAt = schedule.kind === 'manual' ? null : schedule.kind === 'interval' ? Date.now() + schedule.everyMinutes * 60000 : schedule.kind === 'daily' ? Date.now() + 86400000 : new Date(schedule.at).getTime();
    const job = { id: `mock-job-${Date.now()}`, name: String(input.params.name ?? '自主任务').slice(0, 40), prompt: input.params.prompt, schedule, scheduleText, enabled: true, createdAt: Date.now(), updatedAt: Date.now(), nextRunAt, nextInMinutes: nextRunAt ? Math.ceil((nextRunAt - Date.now()) / 60000) : null, lastRunAt: null, lastStatus: null, runCount: 0, sessionId: null };
    automationJobs.push(job); data = job; publishEvent('automation.job.created', { job });
  } else if (input.method === 'automation.update' || input.method === 'automation.pause' || input.method === 'automation.resume') {
    if (!automationConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: '自动化已关闭' } }); return; }
    const job = automationJobs.find((entry) => entry.id === input.params?.id);
    if (!job) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '任务不存在' } }); return; }
    if (input.method === 'automation.update') { Object.assign(job, input.params, { updatedAt: Date.now() }); if (input.params.schedule) job.scheduleText = input.params.schedule.kind; }
    if (input.method === 'automation.pause') job.enabled = false;
    if (input.method === 'automation.resume') job.enabled = true;
    data = job; publishEvent('automation.job.updated', { job });
  } else if (input.method === 'automation.delete') {
    if (!automationConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: '自动化已关闭' } }); return; }
    const before = automationJobs.length; automationJobs = automationJobs.filter((job) => job.id !== input.params?.id);
    if (before === automationJobs.length) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '任务不存在' } }); return; }
    data = { deleted: true, id: input.params.id }; publishEvent('automation.job.deleted', { id: input.params.id });
  } else if (input.method === 'automation.run') {
    if (!automationConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: '自动化已关闭' } }); return; }
    const job = automationJobs.find((entry) => entry.id === input.params?.id);
    if (!job) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '任务不存在' } }); return; }
    const startedAt = Date.now(); const run = { id: `mock-run-${startedAt}`, jobId: job.id, jobName: job.name, startedBy: 'user', status: 'running', startedAt, finishedAt: null, durationMs: null, output: null, error: null, usage: null };
    publishEvent('automation.run.started', { run }); run.status = 'succeeded'; run.finishedAt = Date.now(); run.durationMs = run.finishedAt - startedAt; run.output = `模拟完成：${job.prompt.slice(0, 120)}`; run.usage = { promptTokens: 120, completionTokens: 42, totalTokens: 162 }; job.runCount += 1; job.lastRunAt = run.finishedAt; job.lastStatus = run.status; automationRuns.unshift(run); data = run; publishEvent('automation.run.succeeded', { run });
  } else if (input.method === 'automation.runs') {
    const all = automationRuns.filter((run) => !input.params?.id || run.jobId === input.params.id);
    data = { runs: all.slice(0, input.params?.limit ?? 50) };
  } else if (input.method === 'skill.list') {
    data = { skills: mockSkills.filter((skill) => skill.source === 'workspace' || mockPlugins.some((plugin) => plugin.id === skill.pluginId && plugin.enabled)).map(({ body, ...info }) => info) };
  } else if (input.method === 'skill.get') {
    data = mockSkills.find((skill) => skill.key === input.params?.key) ?? {};
  } else if (input.method === 'skill.create') {
    if (!skillsConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: '技能已关闭' } }); return; }
    const p = input.params ?? {};
    if (mockSkills.some((skill) => skill.name === p.name)) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_CONFLICT', message: '技能名称已存在' } }); return; }
    const skill = { key: `workspace:${p.name}`, name: p.name, description: p.description ?? '', keywords: p.keywords ?? [], always: p.always ?? false, source: 'workspace', bodyChars: String(p.body).length, updatedAt: new Date().toISOString(), body: p.body };
    mockSkills.push(skill); const { body, ...info } = skill; data = info;
  } else if (input.method === 'skill.update') {
    if (!skillsConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: '技能已关闭' } }); return; }
    const skill = mockSkills.find((entry) => entry.name === input.params?.name && entry.source === 'workspace');
    if (!skill) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '技能不存在' } }); return; }
    Object.assign(skill, input.params, { bodyChars: input.params.body?.length ?? skill.bodyChars, updatedAt: new Date().toISOString() }); const { body, ...info } = skill; data = info;
  } else if (input.method === 'skill.delete') {
    if (!skillsConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: '技能已关闭' } }); return; }
    const existed = mockSkills.some((skill) => skill.name === input.params?.name && skill.source === 'workspace');
    mockSkills = mockSkills.filter((skill) => skill.name !== input.params?.name || skill.source !== 'workspace'); data = { deleted: existed, key: `workspace:${input.params?.name}` };
  } else if (input.method === 'plugin.list') {
    data = { plugins: mockPlugins.map((plugin) => ({ ...plugin })) };
  } else if (input.method === 'plugin.get') {
    data = mockPlugins.find((plugin) => plugin.id === input.params?.id) ?? {};
  } else if (input.method === 'plugin.enable' || input.method === 'plugin.disable') {
    if (!pluginsConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: '插件已关闭' } }); return; }
    const plugin = mockPlugins.find((entry) => entry.id === input.params?.id);
    if (!plugin) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '插件不存在' } }); return; }
    plugin.enabled = input.method === 'plugin.enable'; data = { ...plugin }; publishEvent('plugin.changed', { action: plugin.enabled ? 'enabled' : 'disabled', plugin: data });
  } else if (input.method === 'cua.status') {
    data = { enabled: cuaConfig.enabled, control: cuaConfig.control, permission: cuaConfig.permission, grantedUntil: 0, terminalGrantedUntil: 0, paused: runPaused, engine: 'mock', idleMs: 60000, foreground: { hwnd: 1, title: 'Mock Desktop', app: 'mock.exe', displayIndex: 0 }, displays: [{ index: 0, primary: true, width: 1280, height: 800, x: 0, y: 0, dpi: 96 }] };
  } else if (input.method === 'cua.screenshot') {
    if (!cuaConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: 'CUA 未启用' } }); return; }
    data = { text: 'Mock screen preview (no real screen is captured).', width: 1280, height: 800, displayIndex: 0, scale: 1, cursor: { x: 640, y: 400 }, cursorText: 'cursor', foreground: { hwnd: 1, title: 'Mock Desktop', app: 'mock.exe', displayIndex: 0 } };
  } else if (input.method === 'cua.answer') {
    data = { found: true };
  } else if (input.method === 'run.status') {
    data = { paused: runPaused, reason: runPaused ? '用户暂停了运行' : null, changedAt: Date.now() };
  } else if (input.method === 'run.pause' || input.method === 'run.resume') {
    runPaused = input.method === 'run.pause'; data = { paused: runPaused, reason: runPaused ? input.params?.reason ?? '用户暂停了运行' : null, changedAt: Date.now() }; publishEvent(runPaused ? 'run.paused' : 'run.resumed', data);
  } else if (input.method === 'agent.scope') {
    data = mockAuditScope;
  } else if (input.method === 'agent.audit.list') {
    const filtered = mockAuditEntries.filter((entry) => (!input.params?.path || entry.path.toLowerCase().includes(input.params.path.toLowerCase())) && (!input.params?.actor || entry.actor === input.params.actor));
    data = { entries: filtered.slice(0, input.params?.limit ?? 100).map(({ before, after, diff, ...entry }) => entry), total: filtered.length };
  } else if (input.method === 'agent.audit.get') {
    const entry = mockAuditEntries.find((item) => item.id === input.params?.id);
    if (!entry) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '记录不存在' } }); return; }
    data = { entry };
  } else if (input.method === 'agent.rollback') {
    if (process.env.MOCK_AUDIT_CONFLICT === 'true' && input.params?.force !== true) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_CONFLICT', message: '文件之后又被修改', details: { currentHash: 'current-hash', expectedHash: 'after-hash' } } }); return; }
    const target = mockAuditEntries.find((item) => item.id === input.params?.id);
    if (!target) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '记录不存在' } }); return; }
    const entry = { id: `mock-audit-${Date.now()}`, ts: new Date().toISOString(), actor: 'user', action: 'rollback', path: target.path, zone: target.zone, reason: '通过 pet-ui 回滚', before: target.after, after: target.before, diff: target.diff, diffChars: target.diffChars };
    mockAuditEntries.unshift(entry); data = { path: target.path, restored: target.before ? 'content' : 'deleted', entry: { ...entry, before: undefined, after: undefined, diff: undefined } }; publishEvent('agent.rollback', { id: entry.id, targetId: target.id, path: target.path, restored: data.restored });
  } else if (input.method === 'dsh.status' || input.method === 'dsh.observe') {
    const observer = { enabled: dshConfig.observe, sessionsDir: 'mock://sessions', scanning: false, scannedAt: Date.now(), session: dshMockState, error: null };
    if (input.method === 'dsh.observe') data = observer;
    else data = { enabled: dshConfig.enabled, observe: dshConfig.observe, started: dshRuntimeRunning, runtime: dshRuntimeRunning ? { running: true, pid: process.pid, provider: 'mock', model: dshConfig.model, cwd: dshConfig.cwd, serverInfo: { name: 'mock', version: '1' }, startedAt: Date.now(), lastExitCode: null } : null, observer, paths: { exePath: dshConfig.exePath, cliPath: dshConfig.cliPath, cwd: dshConfig.cwd, sessionsDir: observer.sessionsDir }, counters: { prompts: 0, asks: 0, errors: 0 }, lastError: null, lastPromptAt: null, pendingApprovals: 0 };
  } else if (input.method === 'dsh.start') {
    if (!dshConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: 'DSH 桥已关闭' } }); return; }
    dshRuntimeRunning = true; data = { started: true, runtime: { running: true, pid: process.pid, provider: 'mock', model: dshConfig.model, cwd: dshConfig.cwd, serverInfo: { name: 'mock', version: '1' }, startedAt: Date.now(), lastExitCode: null } }; publishEvent('dsh.status', { runtime: 'started', at: Date.now() });
  } else if (input.method === 'dsh.stop') {
    dshRuntimeRunning = false; data = { stopped: true }; publishEvent('dsh.status', { runtime: 'exited', at: Date.now() });
  } else if (input.method === 'dsh.ask' || input.method === 'dsh.prompt') {
    if (!dshConfig.enabled) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_UNAVAILABLE', message: 'DSH 桥已关闭' } }); return; }
    dshRuntimeRunning = true; const task = String(input.params?.text ?? '');
    if (input.method === 'dsh.ask') { dshMockState = { ...dshMockState, state: 'thinking', active: true, updatedAt: Date.now(), lastText: task.slice(0, 120) }; publishEvent('dsh.activity', dshMockState); data = { text: `模拟 DSH 回答：已处理“${task.slice(0, 120)}”`, sessionId: 'mock-private-session', turn: 1, durationMs: 900 }; dshMockState = { ...dshMockState, state: 'idle', active: false, updatedAt: Date.now() }; publishEvent('dsh.activity', dshMockState); }
    else data = { sessionId: 'mock-private-session', messageId: `mock-message-${Date.now()}` };
  } else if (input.method === 'dsh.approval.answer') {
    data = { resolved: true }; publishEvent('dsh.approval.resolved', { id: input.params?.id, outcome: input.params?.outcome });
  } else if (input.method === 'learning.status') {
    const counts = Object.fromEntries(['pending', 'approved', 'gray', 'rejected', 'rolledback'].map((key) => [key, learningItems.filter((item) => item.status === key).length]));
    data = { enabled: learningConfig.enabled, requireApproval: learningConfig.requireApproval, grayPercent: learningConfig.grayPercent, grayDays: learningConfig.grayDays, counts, pending: learningItems.filter((item) => item.status === 'pending').map(({ body, ...item }) => item), activeGray: learningItems.filter((item) => item.status === 'gray').map(({ id, name, kind, gray }) => ({ id, name, kind, gray })), dirs: { proposals: 'mock://learning/proposals', staging: 'mock://skills/staging', approved: 'mock://learning' }, maxPending: learningConfig.maxPending };
  } else if (input.method === 'learning.list') {
    data = { items: learningItems.filter((item) => (!input.params?.kind || item.kind === input.params.kind) && (!input.params?.status || item.status === input.params.status)).map(({ body, ...item }) => item) };
  } else if (input.method === 'learning.get') {
    const item = learningItems.find((entry) => entry.id === input.params?.id);
    if (!item) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '提案不存在' } }); return; }
    data = { item };
  } else if (input.method === 'learning.approve' || input.method === 'learning.reject' || input.method === 'learning.rollback') {
    const item = learningItems.find((entry) => entry.id === input.params?.id);
    if (!item) { send(socket, { type: 'res', id: input.id, ok: false, error: { code: 'E_NOT_FOUND', message: '提案不存在' } }); return; }
    const previous = item.status;
    if (input.method === 'learning.approve') { item.status = input.params?.gray === false ? 'approved' : 'gray'; if (item.status === 'gray') item.gray = { percent: learningConfig.grayPercent, startedAt: Date.now(), rollbackAfterDays: learningConfig.grayDays }; if (item.kind === 'skill') { const skillName = item.name; if (!mockSkills.some((skill) => skill.name === skillName)) mockSkills.push({ key: `workspace:${skillName}`, name: skillName, description: item.reason, keywords: [], always: false, source: 'workspace', bodyChars: item.body.length, updatedAt: new Date().toISOString(), body: item.body }); } publishEvent('learning.approved', { item: { ...item }, gray: item.status === 'gray' }); }
    if (input.method === 'learning.reject') { item.status = 'rejected'; publishEvent('learning.rejected', { item: { ...item }, reason: input.params?.reason ?? '' }); }
    if (input.method === 'learning.rollback') { item.status = 'rolledback'; publishEvent('learning.rolledback', { item: { ...item }, removed: true }); }
    data = { item }; if (previous === 'pending' && item.status === 'gray') publishEvent('learning.proposed', { id: item.id, kind: item.kind, name: item.name, status: item.status });
  } else if (input.method === 'mood.history') {
    data = { entries: moodHistory.slice(0, input.params?.limit ?? 20) };
  } else if (['mood.adjust', 'mood.poke', 'mood.evaluate'].includes(input.method)) {
    const deltas = input.method === 'mood.poke' ? { mood: 1, affection: 0.5 } : input.method === 'mood.evaluate' ? { mood: 1, affection: 1 } : input.params ?? {};
    const applied = [];
    for (const key of ['mood', 'affection', 'energy']) {
      if (typeof deltas[key] !== 'number' || deltas[key] === 0) continue;
      const from = mood[key]; mood[key] = Math.max(0, Math.min(100, mood[key] + deltas[key]));
      const entry = { ts: Date.now(), key, from, to: mood[key], delta: mood[key] - from, reason: input.params?.reason ?? 'mock interaction', source: input.method === 'mood.poke' ? 'poke' : input.method === 'mood.evaluate' ? 'llm' : 'user' };
      applied.push(entry); moodHistory.unshift(entry);
    }
    if (input.method === 'mood.poke') mood.pokes += 1;
    mood.updatedAt = Date.now();
    const source = input.method === 'mood.poke' ? 'poke' : input.method === 'mood.evaluate' ? 'llm' : 'user';
    publishMood(input.method === 'mood.poke' ? [] : applied, source, 'mock interaction');
    data = input.method === 'mood.poke' ? { ...mood } : { state: { mood: mood.mood, affection: mood.affection, energy: mood.energy }, applied };
  }
  send(socket, { type: 'res', id: input.id, ok: true, data });
}

const server = createServer();
server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') { socket.destroy(); return; }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(socket);
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    try {
      let next;
      while ((next = consumeFrame(buffered))) {
        buffered = next.remaining;
        if (next.opcode === 8) { socket.end(frame(Buffer.alloc(0), 8)); return; }
        if (next.opcode === 9) { socket.write(frame(next.payload, 10)); continue; }
        if (next.opcode === 1) handleMessage(socket, next.payload.toString('utf8'));
      }
    } catch { socket.destroy(); }
  });
  socket.on('close', () => clients.delete(socket));
});
server.listen(port, '127.0.0.1', () => console.log(`Mock gateway listening on ws://127.0.0.1:${port}`));
