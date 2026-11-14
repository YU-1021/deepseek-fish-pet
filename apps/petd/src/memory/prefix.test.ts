/**
 * 记忆前缀测试：清单折叠、PARTNER 注入、截断、常驻文件判定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceMemory } from './store.js';
import { buildChatSystemPrompt, buildWorkspaceListing, isResident, LISTING_DIR_CAP, PARTNER_MAX_CHARS, SEED_DIRS, SEED_FILES } from './prefix.js';

function makeMemory(): WorkspaceMemory {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-prefix-'));
  const memory = new WorkspaceMemory({ dir });
  memory.ensureDirs(SEED_DIRS);
  memory.seed(SEED_FILES);
  return memory;
}

test('清单：根文件逐个列，折叠目录只留份数', () => {
  const memory = makeMemory();
  memory.writeFileAtomic('handoffs/2026-11-15T10-00-00Z.md', '交接一');
  memory.writeFileAtomic('handoffs/2026-11-15T11-00-00Z.md', '交接二');
  const listing = buildWorkspaceListing(memory);
  assert.match(listing, /^PARTNER\.md$/m);
  assert.match(listing, /^MEMORY\.md$/m);
  assert.match(listing, /handoffs\/ （2 份）/);
  assert.doesNotMatch(listing, /交接一/);
});

test('清单：直属文件超上限的普通目录也折叠', () => {
  const memory = makeMemory();
  for (let i = 0; i < LISTING_DIR_CAP + 2; i += 1) memory.writeFileAtomic(`notes/笔记-${i}.md`, `第 ${i} 份`);
  assert.match(buildWorkspaceListing(memory), /notes\/ （12 份）/);
});

test('清单：超字符上限退化成顶层目录 + 份数', () => {
  const memory = makeMemory();
  for (let i = 0; i < 8; i += 1) memory.writeFileAtomic(`notes/不太重要的笔记-${i}.md`, `内容 ${i}`);
  const listing = buildWorkspaceListing(memory, { maxChars: 40 });
  assert.match(listing, /notes\/ （8 份）/);
  assert.doesNotMatch(listing, /不太重要/);
});

test('系统提示词：人格 + 关于主人 + 约定 + 清单', () => {
  const memory = makeMemory();
  memory.writeFileAtomic('PARTNER.md', '# 坐在电脑前的人\n\n称呼：master\n作息：凌晨一点睡\n');
  const prompt = buildChatSystemPrompt(memory, '我是大肥鱼，蓝发鲸鱼女仆。');
  assert.match(prompt, /我是大肥鱼/);
  assert.match(prompt, /## 关于主人/);
  assert.match(prompt, /称呼：master/);
  assert.match(prompt, /记忆维护约定/);
  assert.match(prompt, /## 工作区文件/);
});

test('PARTNER.md 太长时截断并留下提示', () => {
  const memory = makeMemory();
  memory.writeFileAtomic('PARTNER.md', `# 很长的画像\n\n${'细节'.repeat(PARTNER_MAX_CHARS)}`);
  const prompt = buildChatSystemPrompt(memory, '人格');
  assert.match(prompt, /PARTNER\.md 太长，后面已截断/);
  assert.ok(prompt.length < PARTNER_MAX_CHARS * 3);
});

test('常驻文件判定', () => {
  assert.equal(isResident('PARTNER.md'), true);
  assert.equal(isResident('partner/PARTNER.md'), false);
  assert.equal(isResident('MEMORY.md'), false);
});
