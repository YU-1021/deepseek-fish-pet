/**
 * 蒸馏记忆注入测试：事实表格解析/渲染、日记与摘要读取、注入顺序与预算裁剪。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceMemory } from './store.js';
import { SEED_DIRS } from './prefix.js';
import {
  buildDistilledContext,
  compareFacts,
  DIARY_DIR,
  FACTS_FILE,
  MEDIUM_DIR,
  normalizeInjectOptions,
  parseFacts,
  renderFacts,
  type FactEntry,
} from './distill.js';

function makeMemory(): WorkspaceMemory {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-distill-'));
  const memory = new WorkspaceMemory({ dir });
  memory.ensureDirs(SEED_DIRS);
  return memory;
}

const SAMPLE_FACTS = [
  '# 记住的事',
  '',
  '| 事实 | 权重 | 标签 | 出现 | 最近 |',
  '| --- | --- | --- | --- | --- |',
  '| 主人喜欢安静 | 8 | 偏好、环境 | 3 | 2026-11-20 |',
  '| 主人在写桌宠项目 | 6 | 项目 | 2 | 2026-11-18 |',
  '| 主人讨厌被一直说话 | 9 | 禁忌 | 1 | 2026-11-21 |',
].join('\n');

test('normalizeInjectOptions：越界值收敛到合法区间', () => {
  const opts = normalizeInjectOptions({ budgetChars: 99999, facts: -1, diaryDays: 999, diaryChars: 1, mediumChars: 99999 });
  assert.equal(opts.budgetChars, 8000);
  assert.equal(opts.facts, 0);
  assert.equal(opts.diaryDays, 60);
  assert.equal(opts.diaryChars, 40);
  assert.equal(opts.mediumChars, 2000);
  assert.equal(opts.enabled, true);
  assert.equal(normalizeInjectOptions({ enabled: false }).enabled, false);
});

test('parseFacts：只认表格行，权重夹到 1–10，标签拆开', () => {
  const entries = parseFacts(SAMPLE_FACTS);
  assert.equal(entries.length, 3);
  const quiet = entries.find((e) => e.text === '主人喜欢安静');
  assert.ok(quiet);
  assert.equal(quiet!.weight, 8);
  assert.deepEqual(quiet!.tags, ['偏好', '环境']);
  assert.equal(quiet!.hits, 3);
  assert.equal(entries.find((e) => e.text === '主人讨厌被一直说话')!.weight, 9);
});

test('parseFacts：坏行与表头不产生条目', () => {
  const entries = parseFacts(['| 事实 | 权重 |', '| --- | --- |', '| 只有一列 |', '', '不是表格'].join('\n'));
  assert.equal(entries.length, 0);
});

test('renderFacts：按权重排序、竖线转全角、可回头解析', () => {
  const entries: FactEntry[] = [
    { text: '低权重 | 带竖线', weight: 3, tags: ['a'], hits: 1, lastSeen: '2026-11-01' },
    { text: '高权重', weight: 9, tags: ['b', 'c'], hits: 2, lastSeen: '2026-11-20' },
  ];
  const markdown = renderFacts(entries);
  assert.match(markdown, /高权重/);
  assert.doesNotMatch(markdown, /\| 低权重 \|/);
  assert.match(markdown, /低权重 ｜ 带竖线/);
  const roundtrip = parseFacts(markdown);
  assert.equal(roundtrip.length, 2);
  assert.equal(roundtrip[0]?.text, '高权重');
  assert.deepEqual(roundtrip[0]?.tags, ['b', 'c']);
});

test('compareFacts：权重降序，同权重按最近时间降序', () => {
  const a: FactEntry = { text: 'a', weight: 5, tags: [], hits: 0, lastSeen: '2026-11-01' };
  const b: FactEntry = { text: 'b', weight: 5, tags: [], hits: 0, lastSeen: '2026-11-02' };
  const c: FactEntry = { text: 'c', weight: 7, tags: [], hits: 0, lastSeen: '2026-10-01' };
  const byWeight = [a, b, c].sort(compareFacts);
  assert.equal(byWeight.at(0)?.text, 'c');
  const sameWeight = [a, b].sort(compareFacts);
  assert.equal(sameWeight.at(0)?.text, 'b');
});

test('buildDistilledContext：三层顺序固定 事实→日记→摘要', () => {
  const memory = makeMemory();
  memory.writeFileAtomic(FACTS_FILE, SAMPLE_FACTS);
  memory.writeFileAtomic(path.posix.join(DIARY_DIR, '2026-11-20.md'), '# 2026-11-20\n\n今天主人一直在写代码。');
  memory.writeFileAtomic(path.posix.join(DIARY_DIR, '2026-11-21.md'), '# 2026-11-21\n\n主人说桌宠要更懂他。');
  memory.writeFileAtomic(
    path.posix.join(MEDIUM_DIR, '2026-11-21-s1.md'),
    ['---', 'date: 2026-11-21', 'session: s1', 'turns: 12', '---', '', '聊了记忆系统怎么嵌合。'].join('\n')
  );
  const result = buildDistilledContext(memory, { enabled: true, budgetChars: 7000 });
  assert.equal(result.enabled, true);
  assert.deepEqual(result.used, { facts: 3, diary: 2, medium: 1 });
  const factsAt = result.text.indexOf('## 记住的事');
  const diaryAt = result.text.indexOf('## 最近的日记');
  const mediumAt = result.text.indexOf('## 最近的会话摘要');
  assert.ok(factsAt >= 0 && diaryAt > factsAt && mediumAt > diaryAt);
  assert.match(result.text, /2026-11-21：/);
  assert.match(result.text, /12 轮/);
  assert.match(result.text, /主人讨厌被一直说话/);
  // 权重最高的事实排在最前
  assert.ok(result.text.indexOf('主人讨厌被一直说话') < result.text.indexOf('主人喜欢安静'));
});

test('buildDistilledContext：enabled=false 返回空', () => {
  const memory = makeMemory();
  memory.writeFileAtomic(FACTS_FILE, SAMPLE_FACTS);
  const result = buildDistilledContext(memory, { enabled: false });
  assert.equal(result.text, '');
  assert.equal(result.enabled, false);
});

test('buildDistilledContext：空工作区返回空串，坏文件不炸', () => {
  const memory = makeMemory();
  const empty = buildDistilledContext(memory, { enabled: true });
  assert.equal(empty.text, '');
  memory.writeFileAtomic(FACTS_FILE, '不是表格\n随便写');
  const garbage = buildDistilledContext(memory, { enabled: true });
  assert.equal(garbage.text, '');
});

test('buildDistilledContext：预算不够先丢摘要、再丢日记、最后丢事实', () => {
  const memory = makeMemory();
  memory.writeFileAtomic(FACTS_FILE, SAMPLE_FACTS);
  const long = '主人今天在忙一个很长的项目。'.repeat(12);
  for (let i = 1; i <= 5; i += 1) {
    memory.writeFileAtomic(path.posix.join(DIARY_DIR, `2026-11-0${i}.md`), `日记 ${i}：${long}`);
  }
  for (let i = 1; i <= 3; i += 1) {
    memory.writeFileAtomic(path.posix.join(MEDIUM_DIR, `2026-11-0${i}-s${i}.md`), `摘要 ${i}：${long}`);
  }
  const full = buildDistilledContext(memory, { enabled: true, budgetChars: 8000 });
  assert.ok(full.used.medium > 0 && full.used.diary > 0);
  const tight = buildDistilledContext(memory, { enabled: true, budgetChars: 500, facts: 3, diaryDays: 5, medium: 3 });
  assert.ok(tight.text.length <= 500);
  assert.ok(tight.dropped.medium > 0, '预算不够时先丢会话摘要');
  assert.ok(tight.used.medium < 3);
  assert.ok(tight.used.facts > 0, '事实层应尽量保留');
});

test('buildDistilledContext：单条过长按条截断', () => {
  const memory = makeMemory();
  memory.writeFileAtomic(
    FACTS_FILE,
    ['| 事实 | 权重 | 标签 | 出现 | 最近 |', '| --- | --- | --- | --- | --- |', `| ${'很长的事实'.repeat(100)} | 9 |  | 1 | 2026-11-20 |`].join('\n')
  );
  const result = buildDistilledContext(memory, { enabled: true, factChars: 40 });
  assert.match(result.text, /…/);
  assert.ok(result.text.includes('很长的事实'));
});
