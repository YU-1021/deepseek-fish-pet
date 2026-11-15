/**
 * 技能（SKILL.md）存储测试：frontmatter 解析、增删改查、提示词拼装、插件技能来源。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import { buildSkillMarkdown, isSafeSkillName, parseSkillMarkdown, SkillStore } from './store.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Harness {
  store: SkillStore;
  dir: string;
  warnings: string[];
}

function harness(opts?: { promptMaxChars?: number; extraRoots?: () => Array<{ pluginId: string; dir: string }> }): Harness {
  const dir = tmpDir('petd-skills-');
  const warnings: string[] = [];
  const store = new SkillStore({
    dir,
    promptMaxChars: opts?.promptMaxChars ?? 4000,
    logger: {
      info() {},
      warn(msg: string, data?: Record<string, unknown>) {
        warnings.push(`${msg} ${JSON.stringify(data ?? {})}`);
      },
    },
    ...(opts?.extraRoots === undefined ? {} : { extraRoots: opts.extraRoots }),
  });
  store.ensure();
  return { store, dir, warnings };
}

test('parseSkillMarkdown：frontmatter 各字段、关键词列表、正文', () => {
  const text = [
    '---',
    'name: 早安',
    'description: "主人早上第一次说话时，用更有精神的方式打招呼"',
    'keywords: [早上, 早安, 起床]',
    'always: false',
    '---',
    '',
    '第一段。',
    '',
    '第二段。',
    '',
  ].join('\n');
  const parsed = parseSkillMarkdown(text);
  assert.equal(parsed.meta.name, '早安');
  assert.equal(parsed.meta.description, '主人早上第一次说话时，用更有精神的方式打招呼');
  assert.deepEqual(parsed.meta.keywords, ['早上', '早安', '起床']);
  assert.equal(parsed.meta.always, false);
  assert.equal(parsed.body, '第一段。\n\n第二段。');
  assert.deepEqual(parsed.warnings, []);
});

test('parseSkillMarkdown：缺 frontmatter / 未闭合都退化为正文并记 warning', () => {
  const plain = parseSkillMarkdown('就是一段普通说明');
  assert.equal(plain.body, '就是一段普通说明');
  assert.equal(plain.meta.name, undefined);
  assert.equal(plain.warnings.length, 1);

  const broken = parseSkillMarkdown('---\nname: x\n正文没闭合');
  assert.match(broken.body, /正文没闭合/);
  assert.equal(broken.warnings.length, 1);
});

test('isSafeSkillName / buildSkillMarkdown 往返', () => {
  assert.equal(isSafeSkillName('morning-greeting'), true);
  assert.equal(isSafeSkillName('../escape'), false);
  assert.equal(isSafeSkillName(''), false);
  assert.equal(isSafeSkillName('中文名'), false);

  const text = buildSkillMarkdown({
    name: 'focus',
    description: '专注工作',
    keywords: ['专注', '番茄钟'],
    always: true,
    body: '每 25 分钟提醒休息。',
  });
  const parsed = parseSkillMarkdown(text);
  assert.equal(parsed.meta.name, 'focus');
  assert.equal(parsed.meta.always, true);
  assert.deepEqual(parsed.meta.keywords, ['专注', '番茄钟']);
  assert.equal(parsed.body, '每 25 分钟提醒休息。');
});

test('create / list / get / update / delete 全流程', () => {
  const h = harness();
  const created = h.store.create({
    name: 'morning',
    description: '早上第一个问候',
    body: '主人早上说话时，先说早安，再问今天计划。',
    keywords: ['早上'],
  });
  assert.equal(created.key, 'morning');
  assert.equal(created.bodyChars, '主人早上说话时，先说早安，再问今天计划。'.length);

  const listed = h.store.list();
  assert.deepEqual(listed.map((s) => s.key), ['morning']);

  const got = h.store.get('morning');
  assert.match(got.body, /先说早安/);

  const updated = h.store.update('morning', { always: true, body: '每天早上主动说早安。' });
  assert.equal(updated.always, true);
  assert.match(h.store.get('morning').body, /每天早上主动说早安/);

  h.store.remove('morning');
  assert.equal(h.store.list().length, 0);
  assert.throws(() => h.store.get('morning'), (e: unknown) => e instanceof PetdError && e.code === 'E_NOT_FOUND');
});

test('create 参数校验：重名 / 非法名 / 空正文', () => {
  const h = harness();
  h.store.create({ name: 'a', body: '正文' });
  assert.throws(
    () => h.store.create({ name: 'a', body: '再建一次' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_CONFLICT'
  );
  assert.throws(
    () => h.store.create({ name: '../evil', body: 'x' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
  assert.throws(
    () => h.store.create({ name: 'empty', body: '   ' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS'
  );
});

test('prompt：清单 + 常驻技能正文 + 预算截断提示', () => {
  const h = harness({ promptMaxChars: 700 });
  assert.equal(h.store.prompt(), '');

  h.store.create({ name: 'one', description: '普通技能一', body: '正文一' });
  h.store.create({ name: 'two', description: '普通技能二', body: '正文二' });
  h.store.create({ name: 'always-long', description: '常驻技能', always: true, body: '常驻正文'.repeat(100) });

  const prompt = h.store.prompt();
  assert.match(prompt, /## 可用技能/);
  assert.match(prompt, /load_skill/);
  assert.match(prompt, /- one：普通技能一/);
  assert.match(prompt, /- two：普通技能二/);
  // 非 always 技能不进正文
  assert.doesNotMatch(prompt, /正文一/);
  assert.match(prompt, /常驻技能/);
  assert.ok(prompt.length <= 800, `提示词应在预算附近，实际 ${prompt.length}`);
});

test('插件技能：带前缀、只读、可进清单', () => {
  const pluginDir = tmpDir('petd-plugin-skills-');
  fs.mkdirSync(path.join(pluginDir, 's1'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 's1', 'SKILL.md'),
    buildSkillMarkdown({ name: 'p1skill', description: '插件技能', keywords: [], always: false, body: '插件正文' }),
    'utf8'
  );
  const h = harness({ extraRoots: () => [{ pluginId: 'p1', dir: pluginDir }] });
  h.store.create({ name: 'workspace-one', description: '工作区技能', body: '工作区正文' });

  const keys = h.store.list().map((s) => s.key);
  assert.deepEqual(keys, ['p1/s1', 'workspace-one']);
  const pluginSkill = h.store.get('p1/s1');
  assert.equal(pluginSkill.source, 'plugin');
  assert.equal(pluginSkill.pluginId, 'p1');
  assert.match(pluginSkill.body, /插件正文/);
  assert.throws(
    () => h.store.update('p1/s1', { body: '改掉' }),
    (e: unknown) => e instanceof PetdError && e.code === 'E_FORBIDDEN'
  );
  assert.throws(
    () => h.store.remove('p1/s1'),
    (e: unknown) => e instanceof PetdError && e.code === 'E_FORBIDDEN'
  );
  assert.match(h.store.prompt(), /p1\/s1：插件技能/);
});

test('坏技能文件：能读目录但跳过非法名，并记 warning', () => {
  const h = harness();
  fs.mkdirSync(path.join(h.dir, 'bad name', ''), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'bad name', 'SKILL.md'), buildSkillMarkdown({
    name: 'bad name',
    description: '',
    keywords: [],
    always: false,
    body: 'x',
  }), 'utf8');
  fs.mkdirSync(path.join(h.dir, 'good'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'good', 'SKILL.md'), '---\nname: good\ndescription: ok\n---\n正文', 'utf8');

  const names = h.store.list().map((s) => s.key);
  assert.deepEqual(names, ['good']);
  assert.match(h.warnings.join('\n'), /非法/);
});
