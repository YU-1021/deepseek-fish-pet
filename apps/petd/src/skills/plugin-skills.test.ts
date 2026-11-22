/**
 * 插件技能接入 SkillStore 的集成测试：
 * - 插件 skills/ 下的技能可以按 `pluginId/name` 列出来、能读正文；
 * - 技能身份 = 目录名，目录名必须是 ASCII 安全字符（中文目录会被跳过并警告）；
 * - 插件禁用后技能立即不可见（extraRoots 每次扫描现取）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PluginStore } from '../plugins/store.js';
import { SkillStore, buildSkillMarkdown, isSafeSkillName } from './store.js';

function tempHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function quietLogger(): { info(): void; warn(): void } {
  return { info() {}, warn() {} };
}

function writePlugin(home: string, skills: Array<{ dir: string; name: string }>): PluginStore {
  const pluginDir = path.join(home, 'plugins', 'aknight-gmaer');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(
      {
        id: 'aknight-gmaer',
        name: 'Aknight.gmaer',
        version: '0.1.0',
        description: '明日方舟游戏助手',
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(path.join(pluginDir, 'prompt.md'), '玩明日方舟时，先看屏再动手。\n', 'utf8');
  for (const skill of skills) {
    const dir = path.join(pluginDir, 'skills', skill.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      buildSkillMarkdown({
        name: skill.name,
        description: `${skill.name} 的说明`,
        keywords: ['游戏'],
        always: false,
        body: `# ${skill.name}\n\n先看屏幕再动手。\n`,
      }),
      'utf8',
    );
  }
  const store = new PluginStore({
    dir: path.join(home, 'plugins'),
    stateFile: path.join(home, 'state', 'plugins.json'),
    logger: quietLogger(),
  });
  store.ensure();
  return store;
}

function makeSkills(home: string, plugins: PluginStore): SkillStore {
  const store = new SkillStore({
    dir: path.join(home, 'skills'),
    promptMaxChars: 2000,
    logger: quietLogger(),
    extraRoots: () => plugins.enabledSkillRoots(),
  });
  store.ensure();
  return store;
}

test('插件技能按 pluginId/目录名 列出，且能读到正文', () => {
  const home = tempHome('petd-plugin-skills-');
  try {
    const plugins = writePlugin(home, [{ dir: 'look-screen', name: '看游戏界面' }]);
    const skills = makeSkills(home, plugins);

    const all = skills.list();
    const keys = all.map((s) => s.key);
    assert.deepEqual(keys, ['aknight-gmaer/look-screen']);
    const info = all[0]!;
    assert.equal(info.source, 'plugin');
    assert.equal(info.pluginId, 'aknight-gmaer');
    assert.equal(info.description, '看游戏界面 的说明');

    const content = skills.get('aknight-gmaer/look-screen');
    assert.equal(content.key, 'aknight-gmaer/look-screen');
    assert.equal(content.source, 'plugin');
    assert.match(content.body, /先看屏幕再动手/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('中文目录名不是合法技能名，会被跳过（技能身份=目录名，需 ASCII）', () => {
  assert.equal(isSafeSkillName('look-screen'), true);
  assert.equal(isSafeSkillName('看游戏界面'), false);

  const home = tempHome('petd-plugin-skills-zh-');
  try {
    const plugins = writePlugin(home, [
      { dir: 'look-screen', name: '看游戏界面' },
      { dir: '看游戏界面', name: '看游戏界面' },
    ]);
    const skills = makeSkills(home, plugins);
    const keys = skills.list().map((s) => s.key);
    assert.deepEqual(keys, ['aknight-gmaer/look-screen']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('插件禁用后它的技能立即不可见', () => {
  const home = tempHome('petd-plugin-skills-off-');
  try {
    const plugins = writePlugin(home, [{ dir: 'look-screen', name: '看游戏界面' }]);
    const skills = makeSkills(home, plugins);
    assert.equal(skills.list().length, 1);

    plugins.disable('aknight-gmaer');
    assert.equal(skills.list().length, 0);
    assert.throws(() => skills.get('aknight-gmaer/look-screen'), /没有这个技能/);

    plugins.enable('aknight-gmaer');
    assert.equal(skills.list().length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
