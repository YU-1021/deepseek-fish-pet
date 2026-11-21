/**
 * MemoryToolbox 测试：9 个记忆工具的执行、写配额、错误文本化、结果截断。
 * 不碰网络；Git 用本机 git（无 git 时 MemoryService 会退化为无提交）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceMemory } from '../memory/store.js';
import { WorkspaceGit } from '../memory/git.js';
import { MemoryService } from '../memory/service.js';
import { BlobStore } from '../memory/blob.js';
import { ReminderStore } from '../reminders/store.js';
import { AutomationStore } from '../automation/store.js';
import { SkillStore } from '../skills/store.js';
import { LearningService } from '../learning/service.js';
import { MemoryToolbox } from './tools.js';
import type { LlmToolCall } from '../llm/client.js';

function tmpService(): MemoryService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-toolbox-'));
  const memory = new WorkspaceMemory({ dir });
  const git = new WorkspaceGit(dir);
  const service = new MemoryService({ memory, git, version: 'test', logger: { info() {}, warn() {} } });
  service.ensure();
  return service;
}

function call(name: string, args: Record<string, unknown>, id = 'call-1'): LlmToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function makeToolbox(service: MemoryService, maxWrites = 3, maxResultChars = 4000, blobs?: BlobStore): MemoryToolbox {
  return new MemoryToolbox({ service, maxWrites, maxResultChars, ...(blobs === undefined ? {} : { blobs }) });
}

test('write_file 后 read_file / list_files 能读出，写入计入配额', async () => {
  const service = tmpService();
  const box = makeToolbox(service);
  const w = await box.execute(call('write_file', { path: 'notes/a.md', content: '第一行\n第二行' }));
  assert.equal(w.ok, true);
  assert.match(w.text, /已写入 notes\/a\.md/);
  assert.equal(box.writes, 1);

  const r = await box.execute(call('read_file', { path: 'notes/a.md' }));
  assert.equal(r.ok, true);
  assert.equal(r.text, '第一行\n第二行');

  const l = await box.execute(call('list_files', { dir: 'notes' }));
  assert.equal(l.ok, true);
  assert.match(l.text, /notes\/a\.md/);
  assert.equal(box.writes, 1, '读操作不计写配额');
});

test('append / edit / move / delete 全链路', async () => {
  const service = tmpService();
  const box = makeToolbox(service, 5);
  await box.execute(call('write_file', { path: 'todo.md', content: '- 买鱼\n' }));
  await box.execute(call('append_file', { path: 'todo.md', content: '- 喂鱼\n' }));
  const edited = await box.execute(call('edit_file', { path: 'todo.md', old_string: '买鱼', new_string: '买猫粮' }));
  assert.equal(edited.ok, true);
  assert.match(edited.text, /已编辑/);
  const moved = await box.execute(call('move_file', { from: 'todo.md', to: 'archive/todo-2026-11.md' }));
  assert.equal(moved.ok, true);
  const afterMove = await box.execute(call('read_file', { path: 'archive/todo-2026-11.md' }));
  assert.match(afterMove.text, /买猫粮/);
  const del = await box.execute(call('delete_file', { path: 'archive/todo-2026-11.md' }));
  assert.equal(del.ok, true);
  const gone = await box.execute(call('read_file', { path: 'archive/todo-2026-11.md' }));
  assert.equal(gone.ok, false);
  assert.match(gone.text, /错误（E_NOT_FOUND）/);
});

test('edit_file：原文不存在 / 出现多次都返回错误文本而不是抛错', async () => {
  const service = tmpService();
  const box = makeToolbox(service);
  await box.execute(call('write_file', { path: 'x.md', content: '一样\n一样\n' }));
  const missing = await box.execute(call('edit_file', { path: 'x.md', old_string: '没有这段', new_string: 'y' }));
  assert.equal(missing.ok, false);
  assert.match(missing.text, /找不到这段原文/);
  const dup = await box.execute(call('edit_file', { path: 'x.md', old_string: '一样', new_string: 'y' }));
  assert.equal(dup.ok, false);
  assert.match(dup.text, /出现不止一次/);
});

test('写配额：超过 maxWrites 后拒绝，且不再计入', async () => {
  const service = tmpService();
  const box = makeToolbox(service, 2);
  assert.equal((await box.execute(call('write_file', { path: 'a.md', content: '1' }))).ok, true);
  assert.equal((await box.execute(call('write_file', { path: 'b.md', content: '2' }))).ok, true);
  const third = await box.execute(call('write_file', { path: 'c.md', content: '3' }));
  assert.equal(third.ok, false);
  assert.match(third.text, /写操作已达上限/);
  assert.equal(box.writes, 2);
});

test('常量文件 PARTNER.md：可读可写，但 delete / move 被拒绝（E_FORBIDDEN）', async () => {
  const service = tmpService();
  const box = makeToolbox(service);
  const w = await box.execute(call('write_file', { path: 'PARTNER.md', content: '# 某个新的人\n' }));
  assert.equal(w.ok, true);
  const del = await box.execute(call('delete_file', { path: 'PARTNER.md' }));
  assert.equal(del.ok, false);
  assert.match(del.text, /E_FORBIDDEN/);
  const mv = await box.execute(call('move_file', { from: 'PARTNER.md', to: 'p.md' }));
  assert.equal(mv.ok, false);
  assert.match(mv.text, /E_FORBIDDEN/);
});

test('未知工具 / 坏 JSON 参数 / 缺参数都返回错误文本', async () => {
  const service = tmpService();
  const box = makeToolbox(service);
  const unknown = await box.execute({ id: 'c', name: 'rm_rf', arguments: '{}' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.text, /没有这个工具/);
  const badJson = await box.execute({ id: 'c', name: 'read_file', arguments: '{oops' });
  assert.equal(badJson.ok, false);
  assert.match(badJson.text, /不是合法 JSON/);
  const missing = await box.execute(call('read_file', {}));
  assert.equal(missing.ok, false);
  assert.match(missing.text, /缺少参数 path/);
});

test('glob_files / grep_files 可用，grep 支持 regex 标志', async () => {
  const service = tmpService();
  const box = makeToolbox(service);
  await box.execute(call('write_file', { path: 'partner/饮食.md', content: '主人喜欢吃鱼\n不吃香菜\n' }));
  await box.execute(call('write_file', { path: 'notes/随便.md', content: '今天天气不错\n' }));
  const g = await box.execute(call('glob_files', { pattern: 'partner/*.md' }));
  assert.equal(g.ok, true);
  assert.match(g.text, /partner\/饮食\.md/);
  const hits = await box.execute(call('grep_files', { query: '香菜' }));
  assert.equal(hits.ok, true);
  assert.match(hits.text, /partner\/饮食\.md:\d+/);
  const re = await box.execute(call('grep_files', { query: '鱼|香菜', regex: true }));
  assert.equal(re.ok, true);
  assert.ok((re.text.match(/partner\/饮食\.md:\d+/g) ?? []).length >= 2);
});

test('结果截断：超长文本按 maxResultChars 截断并附提示', async () => {
  const service = tmpService();
  await service.write('long.md', 'x'.repeat(300));
  const box = makeToolbox(service, 3, 100);
  const r = await box.execute(call('read_file', { path: 'long.md' }));
  assert.equal(r.ok, true);
  assert.ok(r.text.length < 300);
  assert.match(r.text, /已截断到 100 字符/);
});

function tmpBlobBox(): { box: MemoryToolbox; service: MemoryService } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-toolbox-blob-'));
  const memory = new WorkspaceMemory({ dir });
  const git = new WorkspaceGit(dir);
  const service = new MemoryService({ memory, git, version: 'test', logger: { info() {}, warn() {} } });
  service.ensure();
  const blobs = new BlobStore(memory);
  blobs.ensure();
  return { box: makeToolbox(service, 3, 4000, blobs), service };
}

test('save_blob / list_blobs / read_blob：句柄可用，save 计入写配额', async () => {
  const { box } = tmpBlobBox();
  const saved = await box.execute(call('save_blob', { text: '主人发来的文字附件', name: '留言.txt' }));
  assert.equal(saved.ok, true);
  assert.match(saved.text, /已保存附件 blob:[0-9a-f]{16}-留言\.txt/);
  assert.equal(box.writes, 1, 'save_blob 算写操作');

  const listed = await box.execute(call('list_blobs', {}));
  assert.equal(listed.ok, true);
  assert.match(listed.text, /留言\.txt/);

  const handle = (saved.text.match(/blob:[0-9a-f]{16}-留言\.txt/)?.[0] ?? '').trim();
  assert.ok(handle !== '');
  const read = await box.execute(call('read_blob', { ref: handle }));
  assert.equal(read.ok, true);
  assert.match(read.text, /主人发来的文字附件/);

  const missing = await box.execute(call('read_blob', { ref: 'blob:nope.txt' }));
  assert.equal(missing.ok, false);
  assert.match(missing.text, /E_NOT_FOUND/);
});

test('没配 BlobStore 时 blob 工具给出明确错误文本', async () => {
  const service = tmpService();
  const box = makeToolbox(service);
  const r = await box.execute(call('list_blobs', {}));
  assert.equal(r.ok, false);
  assert.match(r.text, /没有启用附件存储/);
});

test('remind_in / remind_at / remind_list / remind_cancel：模型能设提醒并看到列表', async () => {
  const service = tmpService();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-reminder-tool-'));
  const reminders = new ReminderStore({ file: path.join(dir, 'reminders.json'), armTimers: false });
  reminders.ensure();
  const box = new MemoryToolbox({ service, maxWrites: 3, maxResultChars: 4000, reminders });

  const created = await box.execute(call('remind_in', { minutes: 30, text: '喝水' }));
  assert.equal(created.ok, true);
  assert.match(created.text, /已设提醒 r1：喝水/);
  assert.match(created.text, /约 30 分钟后/);
  assert.equal(box.writes, 0, '设提醒不计记忆写配额');

  const at = await box.execute(call('remind_at', { at_clock: '18:30', text: '一小时后开会' }));
  assert.equal(at.ok, true);
  assert.match(at.text, /18:30/);

  const listed = await box.execute(call('remind_list', {}));
  assert.equal(listed.ok, true);
  assert.match(listed.text, /r1/);
  assert.match(listed.text, /r2/);

  const cancelled = await box.execute(call('remind_cancel', { id: 'r1' }));
  assert.equal(cancelled.ok, true);
  assert.match(cancelled.text, /取消/);
  assert.equal(reminders.list().length, 1);

  const bad = await box.execute(call('remind_cancel', { id: 'r999' }));
  assert.equal(bad.ok, false);
  assert.match(bad.text, /E_NOT_FOUND/);

  // 没配 ReminderStore 时给出明确说明
  const plain = makeToolbox(service);
  const off = await plain.execute(call('remind_in', { minutes: 5, text: 'x' }));
  assert.equal(off.ok, false);
  assert.match(off.text, /没有启用提醒/);
});

test('schedule_task / list_tasks / cancel_task：模型能建自动化任务', async () => {
  const service = tmpService();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-automation-tool-'));
  const automation = new AutomationStore({
    file: path.join(dir, 'automations.json'),
    armTimers: false,
    runJob: async () => ({ output: '跑完啦' }),
  });
  automation.ensure();
  const box = new MemoryToolbox({ service, maxWrites: 3, maxResultChars: 4000, automation });

  const created = await box.execute(call('schedule_task', { prompt: '每小时看看主人在做什么', every_minutes: 60 }));
  assert.equal(created.ok, true);
  assert.match(created.text, /已建自主任务 a1/);
  assert.match(created.text, /每 60 分钟/);
  assert.equal(box.writes, 1, 'schedule_task 算写操作');

  const listed = await box.execute(call('list_tasks', {}));
  assert.equal(listed.ok, true);
  assert.match(listed.text, /a1/);
  assert.match(listed.text, /每小时看看主人在做什么/);

  const cancelled = await box.execute(call('cancel_task', { id: 'a1' }));
  assert.equal(cancelled.ok, true);
  assert.match(cancelled.text, /已删除自主任务 a1/);
  assert.equal(automation.listJobs().length, 0);

  const empty = await box.execute(call('list_tasks', {}));
  assert.match(empty.text, /现在没有自主任务/);

  // 没配 AutomationStore 时给出明确说明
  const plain = makeToolbox(service);
  const off = await plain.execute(call('schedule_task', { prompt: 'x', every_minutes: 5 }));
  assert.equal(off.ok, false);
  assert.match(off.text, /没有启用自动化/);
});

test('load_skill / list_skills：模型能按需读取技能正文，不算写操作', async () => {
  const service = tmpService();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-skill-tool-'));
  const skills = new SkillStore({ dir, promptMaxChars: 2000, logger: { info() {}, warn() {} } });
  skills.ensure();
  skills.create({ name: 'morning', description: '早上问候', body: '先说早安，再问今天计划。' });
  const box = new MemoryToolbox({ service, maxWrites: 3, maxResultChars: 4000, skills });

  const list = await box.execute(call('list_skills', {}));
  assert.equal(list.ok, true);
  assert.match(list.text, /morning：早上问候/);

  const load = await box.execute(call('load_skill', { name: 'morning' }));
  assert.equal(load.ok, true);
  assert.match(load.text, /先说早安/);
  assert.equal(box.writes, 0, 'load_skill 不算写操作');

  const missing = await box.execute(call('load_skill', { name: 'nope' }));
  assert.equal(missing.ok, false);
  assert.match(missing.text, /没有这个技能/);

  // 没配 SkillStore 时给出明确说明
  const plain = makeToolbox(service);
  const off = await plain.execute(call('load_skill', { name: 'morning' }));
  assert.equal(off.ok, false);
  assert.match(off.text, /没有启用技能/);
});

test('propose_learning：模型能写学习提案（计入写配额，不直接生效）', async () => {
  const service = tmpService();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-learn-tool-'));
  const learning = new LearningService({
    home,
    config: () => ({ enabled: true, requireApproval: true, grayPercent: 10, grayDays: 3, maxPending: 20, promptMaxChars: 2000 }),
  });
  learning.ensure();
  const box = new MemoryToolbox({ service, maxWrites: 3, maxResultChars: 4000, learning });

  const defs = box.definitions().map((d) => d.function.name);
  assert.equal(defs.includes('propose_learning'), true);

  const res = await box.execute(
    call('propose_learning', {
      kind: 'preference',
      name: 'reply_style',
      content: '回答尽量短一点。',
      reason: '主人多次要求简短',
    })
  );
  assert.equal(res.ok, true);
  assert.match(res.text, /已写成学习提案/);
  assert.match(res.text, /待主人审批/);
  assert.equal(box.writes, 1, 'propose_learning 算写操作');
  assert.equal(learning.list({ status: 'pending' }).length, 1);
  // 未批准前不拼进提示词
  assert.equal(learning.promptAdditions(), '');

  const bad = await box.execute(call('propose_learning', { kind: 'nope', name: 'x', content: 'y', reason: 'z' }));
  assert.equal(bad.ok, false);
  assert.match(bad.text, /kind 只能是/);

  const off = await makeToolbox(service).execute(call('propose_learning', { kind: 'preference', name: 'x', content: 'y', reason: 'z' }));
  assert.equal(off.ok, false);
  assert.match(off.text, /没有启用学习闭环/);
});

test('审批门 guard：拒绝时工具不执行，放行时正常，异常变成错误文本', async () => {
  const service = tmpService();
  const seen: Array<Record<string, unknown>> = [];
  const denyBox = new MemoryToolbox({
    service,
    maxWrites: 3,
    maxResultChars: 4000,
    guard: async (ctx) => {
      seen.push({ kind: ctx.kind, name: ctx.name, args: ctx.args, sessionId: ctx.sessionId });
      if (ctx.name === 'delete_file') return { allowed: false, reason: '测试拒绝删除' };
      return { allowed: true };
    },
  });

  await denyBox.execute(call('write_file', { path: 'a.md', content: 'hi' }), { sessionId: 's1' });
  const denied = await denyBox.execute(call('delete_file', { path: 'a.md' }), { sessionId: 's1' });
  assert.equal(denied.ok, false);
  assert.match(denied.text, /错误（E_FORBIDDEN）：测试拒绝删除/);
  assert.equal(denyBox.writes, 1, '被拒绝的删除不计写配额');

  const guardCall = seen.find((e) => e['name'] === 'delete_file');
  assert.ok(guardCall);
  assert.equal(guardCall['kind'], 'tool');
  assert.equal(guardCall['sessionId'], 's1');
  assert.equal((guardCall['args'] as Record<string, unknown>)['path'], 'a.md');

  const allowBox = new MemoryToolbox({
    service,
    maxWrites: 3,
    maxResultChars: 4000,
    guard: async () => ({ allowed: true }),
  });
  const ok = await allowBox.execute(call('delete_file', { path: 'a.md' }));
  assert.equal(ok.ok, true);

  const brokenBox = new MemoryToolbox({
    service,
    maxWrites: 3,
    maxResultChars: 4000,
    guard: async () => {
      throw new Error('门坏了');
    },
  });
  const broken = await brokenBox.execute(call('write_file', { path: 'b.md', content: 'x' }));
  assert.equal(broken.ok, false);
  assert.match(broken.text, /错误（E_INTERNAL）：审批门出错/);
});
