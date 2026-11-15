/**
 * 插件（plugin.json）存储测试：清单校验、技能贡献、启用状态持久化、提示词贡献。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PetdError } from '@petd/protocol';
import { buildSkillMarkdown } from '../skills/store.js';
import { parsePluginManifest, PluginStore } from './store.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface Harness {
  store: PluginStore;
  dir: string;
  stateFile: string;
  events: Array<{ event: string; data?: unknown }>;
}

function harness(): Harness {
  const root = tmpDir('petd-plugins-');
  const dir = path.join(root, 'plugins');
  const stateFile = path.join(root, 'state', 'plugins.json');
  const events: Array<{ event: string; data?: unknown }> = [];
  const store = new PluginStore({
    dir,
    stateFile,
    logger: { info() {}, warn() {} },
    publish: (event, data) => events.push({ event, data }),
  });
  fs.mkdirSync(dir, { recursive: true });
  store.ensure();
  return { store, dir, stateFile, events };
}

function installPlugin(
  h: Harness,
  id: string,
  manifest: Record<string, unknown>,
  opts?: { skills?: Array<{ name: string; description: string; body: string }>; prompt?: string }
): void {
  const dir = path.join(h.dir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id, ...manifest }, null, 2), 'utf8');
  if (opts?.prompt !== undefined) fs.writeFileSync(path.join(dir, 'prompt.md'), opts.prompt, 'utf8');
  for (const skill of opts?.skills ?? []) {
    const skillDir = path.join(dir, 'skills', skill.name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      buildSkillMarkdown({
        name: skill.name,
        description: skill.description,
        keywords: [],
        always: false,
        body: skill.body,
      }),
      'utf8'
    );
  }
}

test('parsePluginManifest：合法 / 缺字段 / id 不一致 / 坏 JSON', () => {
  const ok = parsePluginManifest(
    JSON.stringify({ name: '示例插件', version: '0.1.0', description: '演示' }),
    'demo'
  );
  assert.equal(ok.manifest?.id, 'demo');
  assert.equal(ok.manifest?.name, '示例插件');
  assert.equal(ok.error, undefined);

  assert.match(parsePluginManifest(JSON.stringify({ version: '1' }), 'x').error ?? '', /name/);
  assert.match(parsePluginManifest(JSON.stringify({ name: 'n', version: '1' }), 'x').error ?? '', /description/);
  assert.match(parsePluginManifest(JSON.stringify({ id: 'other', name: 'n', version: '1', description: 'd' }), 'x').error ?? '', /必须和目录名/);
  assert.match(parsePluginManifest('{bad json', 'x').error ?? '', /JSON/);
  assert.match(parsePluginManifest(JSON.stringify({ id: '../evil', name: 'n', version: '1', description: 'd' }), 'x').error ?? '', /非法/);
});

test('list / get：读取清单、技能数、prompt.md 检测，默认启用', () => {
  const h = harness();
  installPlugin(h, 'alpha', { name: 'Alpha', version: '1.0.0', description: '插件 A' }, {
    skills: [
      { name: 'a1', description: '技能一', body: '正文一' },
      { name: 'a2', description: '技能二', body: '正文二' },
    ],
    prompt: '你是 Alpha 插件，说话简短。',
  });
  installPlugin(h, 'beta', { name: 'Beta', version: '0.2.0', description: '插件 B', author: 'someone' });

  const list = h.store.list();
  assert.deepEqual(list.map((p) => p.id), ['alpha', 'beta']);
  const alpha = h.store.get('alpha');
  assert.equal(alpha.enabled, true);
  assert.equal(alpha.skillCount, 2);
  assert.equal(alpha.hasPrompt, true);
  const beta = h.store.get('beta');
  assert.equal(beta.skillCount, 0);
  assert.equal(beta.hasPrompt, false);
  assert.equal(beta.author, 'someone');

  assert.throws(() => h.store.get('nope'), (e: unknown) => e instanceof PetdError && e.code === 'E_NOT_FOUND');
  assert.throws(() => h.store.get('../evil'), (e: unknown) => e instanceof PetdError && e.code === 'E_BAD_PARAMS');
});

test('disable / enable：状态持久化、事件、技能根与提示词开关', () => {
  const h = harness();
  installPlugin(h, 'alpha', { name: 'Alpha', version: '1.0.0', description: '插件 A' }, {
    skills: [{ name: 'a1', description: '技能一', body: '正文一' }],
    prompt: '插件提示词',
  });

  assert.equal(h.store.enabledSkillRoots().length, 1);
  assert.match(h.store.prompt(), /插件提示词/);

  const disabled = h.store.disable('alpha');
  assert.equal(disabled.enabled, false);
  assert.equal(h.store.enabledSkillRoots().length, 0);
  assert.equal(h.store.prompt(), '');
  assert.equal(h.events.length, 1);
  assert.deepEqual(h.events[0]?.data, { id: 'alpha', enabled: false });

  // 新建一个 store 实例读同一个状态文件：仍是停用
  const again = new PluginStore({ dir: h.dir, stateFile: h.stateFile, logger: { info() {}, warn() {} } });
  again.ensure();
  assert.equal(again.get('alpha').enabled, false);

  assert.equal(h.store.enable('alpha').enabled, true);
  assert.equal(h.events.length, 2);
  assert.equal(h.store.enabledSkillRoots().length, 1);
});

test('坏清单的插件被跳过并记日志，不影响其他插件', () => {
  const root = tmpDir('petd-plugins-bad-');
  const dir = path.join(root, 'plugins');
  const stateFile = path.join(root, 'state', 'plugins.json');
  const warnings: string[] = [];
  const store = new PluginStore({
    dir,
    stateFile,
    logger: { info() {}, warn: (msg: string) => warnings.push(msg) },
  });
  fs.mkdirSync(dir, { recursive: true });
  store.ensure();

  fs.mkdirSync(path.join(dir, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken', 'plugin.json'), '{not json', 'utf8');
  fs.mkdirSync(path.join(dir, 'valid'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'valid', 'plugin.json'),
    JSON.stringify({ name: 'V', version: '1', description: 'ok' }),
    'utf8'
  );

  assert.deepEqual(store.list().map((p) => p.id), ['valid']);
  assert.ok(warnings.some((w) => w.includes('插件清单非法')));
});
