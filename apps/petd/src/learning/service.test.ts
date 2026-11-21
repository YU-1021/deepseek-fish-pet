import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PetdError } from '@petd/protocol';
import type { PetdConfig } from '../kernel/config.js';
import type { AgentAuditLog } from '../kernel/agent-audit.js';
import { LearningService, type LearningServiceOptions } from './service.js';

type LearningConfig = PetdConfig['learning'];

const BASE_CONFIG: LearningConfig = {
  enabled: true,
  requireApproval: true,
  grayPercent: 10,
  grayDays: 3,
  maxPending: 20,
  promptMaxChars: 2000,
};

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-learning-'));
}

interface AuditCall {
  path: string;
  actor: string;
  action: string;
  afterText: string | null;
}

function makeService(
  over: Partial<LearningConfig> = {},
  extra: { random?: () => number } = {}
): { svc: LearningService; home: string; audits: AuditCall[] } {
  const home = makeHome();
  const audits: AuditCall[] = [];
  const audit = {
    append(input: { path: string; actor: string; action: string; afterText: string | null }) {
      audits.push(input);
      return input;
    },
  } as unknown as AgentAuditLog;
  const opts: LearningServiceOptions = {
    home,
    config: () => ({ ...BASE_CONFIG, ...over }),
    audit,
    ...(extra.random === undefined ? {} : { random: extra.random }),
  };
  const svc = new LearningService(opts);
  svc.ensure();
  return { svc, home, audits };
}

test('propose：写候选文件（proposals）+ frontmatter + 待审状态 + 审计', () => {
  const { svc, home, audits } = makeService();
  const item = svc.propose({ kind: 'preference', name: 'reply_style', content: '回答尽量短一点。', reason: '主人多次要求简短' });
  assert.equal(item.status, 'pending');
  assert.equal(item.kind, 'preference');
  assert.equal(item.name, 'reply_style');
  assert.equal(item.path.startsWith('proposals/'), true);
  const abs = path.join(home, item.path);
  assert.equal(fs.existsSync(abs), true);
  const text = fs.readFileSync(abs, 'utf8');
  assert.match(text, /kind: preference/);
  assert.match(text, /reason: 主人多次要求简短/);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.actor, 'agent');
  assert.equal(audits[0]!.action, 'write');
  // get 能拿回正文
  const detail = svc.get(item.id);
  assert.equal(detail.body, '回答尽量短一点。');
});

test('propose：技能候选写到 skills/staging', () => {
  const { svc, home } = makeService();
  const item = svc.propose({ kind: 'skill', name: 'daily_report', content: '# 日报\n\n每天 20:00 汇总今天的记忆。', reason: '主人每天要日报' });
  assert.equal(item.path, path.posix.join('skills', 'staging', `${item.id}.agent.md`));
  assert.equal(fs.existsSync(path.join(home, item.path)), true);
  assert.equal(svc.list({ status: 'pending' }).length, 1);
});

test('propose 校验：kind/name/content/reason/关闭/maxPending', () => {
  const { svc } = makeService();
  assert.throws(() => svc.propose({ kind: 'nope' as never, name: 'x', content: 'y', reason: 'z' }), (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS');
  assert.throws(() => svc.propose({ kind: 'preference', name: '../etc', content: 'y', reason: 'z' }), (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS');
  assert.throws(() => svc.propose({ kind: 'preference', name: 'ok', content: '   ', reason: 'z' }), (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS');
  assert.throws(() => svc.propose({ kind: 'preference', name: 'ok', content: 'y', reason: '' }), (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS');

  const closed = makeService({ enabled: false });
  assert.throws(() => closed.svc.propose({ kind: 'preference', name: 'ok', content: 'y', reason: 'z' }), (e: unknown) => e instanceof PetdError && e.code === 'E_UNAVAILABLE');

  const tight = makeService({ maxPending: 1 });
  tight.svc.propose({ kind: 'preference', name: 'a', content: 'y', reason: 'z' });
  assert.throws(() => tight.svc.propose({ kind: 'preference', name: 'b', content: 'y', reason: 'z' }), (e: unknown) => e instanceof PetdError && e.code === 'E_UNAVAILABLE');
});

test('approve 技能：转正成 skills/<name>/SKILL.md，状态 approved', () => {
  const { svc, home, audits } = makeService();
  const item = svc.propose({ kind: 'skill', name: 'daily_report', content: '# 日报\n\n每天 20:00 汇总今天的记忆。', reason: '每天要日报' });
  const approved = svc.approve(item.id);
  assert.equal(approved.status, 'approved');
  const target = path.join(home, 'skills', 'daily_report', 'SKILL.md');
  assert.equal(fs.existsSync(target), true);
  const text = fs.readFileSync(target, 'utf8');
  assert.match(text, /name: daily_report/);
  assert.match(text, /每天 20:00 汇总今天的记忆。/);
  assert.equal(audits.some((a) => a.actor === 'user' && a.path.includes('skills/daily_report/SKILL.md')), true);
});

test('approve 技能：同名已存在要 E_CONFLICT，force 才覆盖', () => {
  const { svc, home } = makeService();
  const first = svc.propose({ kind: 'skill', name: 'daily_report', content: '第一版', reason: 'r' });
  svc.approve(first.id);
  const second = svc.propose({ kind: 'skill', name: 'daily_report', content: '第二版', reason: 'r' });
  assert.throws(() => svc.approve(second.id), (e: unknown) => e instanceof PetdError && e.code === 'E_CONFLICT');
  const approved = svc.approve(second.id, { force: true });
  assert.equal(approved.status, 'approved');
  assert.match(fs.readFileSync(path.join(home, 'skills', 'daily_report', 'SKILL.md'), 'utf8'), /第二版/);
});

test('approve 偏好：写 learning/<name>.agent.json；gray 标记状态与比例', () => {
  const { svc, home } = makeService({ grayPercent: 25, grayDays: 5 });
  const item = svc.propose({ kind: 'preference', name: 'reply_style', content: '回答尽量短一点。', reason: 'r' });
  const gray = svc.approve(item.id, { gray: true });
  assert.equal(gray.status, 'gray');
  assert.deepEqual(gray.gray, { percent: 25, startedAt: gray.gray?.startedAt, rollbackAfterDays: 5 });
  const file = path.join(home, 'learning', 'reply_style.agent.json');
  assert.equal(fs.existsSync(file), true);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal(parsed['content'], '回答尽量短一点。');
  assert.equal(parsed['kind'], 'preference');
});

test('approve 状态不对：非 pending 报 E_CONFLICT', () => {
  const { svc } = makeService();
  const item = svc.propose({ kind: 'preference', name: 'a', content: 'b', reason: 'c' });
  svc.approve(item.id);
  assert.throws(() => svc.approve(item.id), (e: unknown) => e instanceof PetdError && e.code === 'E_CONFLICT');
  assert.throws(() => svc.get('nope'), (e: unknown) => e instanceof PetdError && e.code === 'E_NOT_FOUND');
});

test('reject：只改状态、文件保留', () => {
  const { svc, home } = makeService();
  const item = svc.propose({ kind: 'preference', name: 'a', content: 'b', reason: 'c' });
  const rejected = svc.reject(item.id, '不需要');
  assert.equal(rejected.status, 'rejected');
  assert.equal(fs.existsSync(path.join(home, item.path)), true);
});

test('rollback：删技能/学习结果并记审计；非生效状态拒绝', () => {
  const { svc, home, audits } = makeService();
  const skill = svc.propose({ kind: 'skill', name: 'tmp_skill', content: '正文', reason: 'r' });
  svc.approve(skill.id);
  const target = path.join(home, 'skills', 'tmp_skill', 'SKILL.md');
  assert.equal(fs.existsSync(target), true);
  const rolled = svc.rollback(skill.id);
  assert.equal(rolled.status, 'rolledback');
  assert.equal(fs.existsSync(target), false);
  assert.equal(audits.some((a) => a.actor === 'user' && a.action === 'delete'), true);

  const pref = svc.propose({ kind: 'preference', name: 'p1', content: 'x', reason: 'r' });
  svc.approve(pref.id, { gray: true });
  assert.equal(fs.existsSync(path.join(home, 'learning', 'p1.agent.json')), true);
  svc.rollback(pref.id);
  assert.equal(fs.existsSync(path.join(home, 'learning', 'p1.agent.json')), false);
});

test('promptAdditions：只拼已批准/灰度；灰度按比例抽样；超长截断', () => {
  const { svc } = makeService({ grayPercent: 100, promptMaxChars: 2000 }, { random: () => 0 });
  const a = svc.propose({ kind: 'preference', name: 'short', content: '说话短一点。', reason: 'r' });
  svc.approve(a.id);
  const b = svc.propose({ kind: 'prompt', name: 'style', content: '多用语气词。', reason: 'r' });
  svc.approve(b.id, { gray: true });
  const text = svc.promptAdditions();
  assert.match(text, /学习到的偏好与经验/);
  assert.match(text, /说话短一点。/);
  assert.match(text, /多用语气词。/);

  const missAll = makeService({ grayPercent: 0 }, { random: () => 0.99 });
  const c = missAll.svc.propose({ kind: 'preference', name: 'x', content: 'y', reason: 'r' });
  missAll.svc.approve(c.id, { gray: true });
  assert.equal(missAll.svc.promptAdditions(), '');

  const tiny = makeService({ promptMaxChars: 10 });
  const d = tiny.svc.propose({ kind: 'preference', name: 'x', content: '很长的内容不要超过十个字', reason: 'r' });
  tiny.svc.approve(d.id);
  const shortText = tiny.svc.promptAdditions();
  assert.equal(shortText.endsWith('…'), true);
  assert.equal(shortText.length, 11);
});

test('status：数量统计与待审列表', () => {
  const { svc } = makeService();
  const p = svc.propose({ kind: 'preference', name: 'a', content: 'b', reason: 'c' });
  svc.approve(p.id);
  svc.propose({ kind: 'preference', name: 'b', content: 'c', reason: 'd' });
  const status = svc.status();
  assert.equal(status.enabled, true);
  assert.equal(status.counts.pending, 1);
  assert.equal(status.counts.approved, 1);
  assert.equal(status.pending.length, 1);
  assert.equal(status.maxPending, 20);
});
