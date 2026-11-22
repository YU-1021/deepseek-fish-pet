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

function handleMessage(socket, message) {
  const input = JSON.parse(message);
  if (input.type === 'connect') {
    send(socket, { type: 'hello', server: { name: 'petd', version: '0.1.0-mock', protocol: 1, pid: process.pid }, sessionId: 'mock-session' });
    if (process.env.MOCK_APPROVAL_REQUEST === 'true') setTimeout(() => {
      const pending = { id: `mock-approval-${Date.now()}`, kind: 'method', name: 'memory.delete', ruleId: 'builtin-file-delete', title: '删除工作区记忆文件', detail: '删除 memory/notes/draft.md，此操作不可恢复。', risk: 'high', riskReason: '操作将永久移除工作区文件，且没有可用的自动回滚。', requestedAt: Date.now(), deadlineAt: Date.now() + hooksConfig.approvalTimeoutMs, sessionId: 'mock-session' };
      pendingApprovals.unshift(pending);
      publishEvent('approval.requested', pending);
    }, 800);
    return;
  }
  if (input.type !== 'req') return;

  let data = { pong: true };
  if (input.method === 'health.status') {
    data = { server: { version: '0.1.0-mock' }, methods: ['health.ping', 'health.status', 'config.get', 'session.list', 'session.get', 'chat.send', 'mood.status', 'mood.history', 'mood.adjust', 'mood.poke', 'mood.evaluate', 'hooks.status', 'hooks.list', 'hooks.get', 'hooks.create', 'hooks.update', 'hooks.delete', 'hooks.toggle', 'hooks.assess', 'approval.list', 'approval.answer', 'presence.status', 'presence.list', 'presence.run_once'] };
  } else if (input.method === 'config.get') {
    data = { version: '0.1.0-mock', gateway: { host: '127.0.0.1', port }, log: { level: 'info' }, mood: { enabled: moodEnabled, chatInjection: true, chatNudge: true, moodDecayPerHour: 2, energyRecoverPerHour: 8 }, hooks: { ...hooksConfig, risk: { enabled: hooksConfig.riskEnabled } }, presence: { ...presenceConfig } };
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
