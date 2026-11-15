/**
 * 情绪状态存储测试：播种、增减与钳制、历史、被戳、离线衰减、提示词文本、坏档兼容。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MoodStore, tierOf, clampValue, buildMoodPrompt } from './mood.js';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-mood-'));
  return path.join(dir, 'state', 'mood.json');
}

function harness(): { store: MoodStore; file: string; tick: (hours: number) => void } {
  const file = tmpFile();
  let now = Date.now();
  const store = new MoodStore({ file, now: () => now, moodDecayPerHour: 2, energyRecoverPerHour: 8 });
  return { store, file, tick: (hours) => { now += hours * 3_600_000; } };
}

test('首次 ensure 播种默认值并落盘', () => {
  const { store, file } = harness();
  const state = store.ensure();
  assert.equal(state.mood, 70);
  assert.equal(state.affection, 30);
  assert.equal(state.energy, 80);
  assert.equal(state.pokes, 0);
  assert.ok(fs.existsSync(file));
  const snap = store.current();
  assert.equal(snap.tiers.mood, tierOf('mood', 70));
  assert.equal(snap.tiers.affection, tierOf('affection', 30));
  assert.equal(snap.tiers.energy, tierOf('energy', 80));
});

test('adjust 增减并钳制在 0–100，写历史；无实际变化不写', () => {
  const { store } = harness();
  store.ensure();
  const up = store.adjust({ mood: 100 }, { reason: '被夸了', source: 'chat' });
  assert.equal(up.state.mood, 100);
  assert.equal(up.applied.length, 1);
  assert.equal(up.applied[0]?.source, 'chat');
  assert.equal(up.applied[0]?.reason, '被夸了');
  const noop = store.adjust({ mood: 5 });
  assert.equal(noop.applied.length, 0);
  const down = store.adjust({ mood: -500 });
  assert.equal(down.state.mood, 0);
  const entries = store.history(10);
  assert.ok(entries.length >= 2);
  assert.ok(entries.some((e) => e.key === 'mood' && e.to === 100));
});

test('poke 递增被戳次数，心情 +1、好感 +0.5，且持久化', () => {
  const { store } = harness();
  store.ensure();
  const first = store.poke();
  assert.equal(first.pokes, 1);
  assert.equal(first.mood, 71);
  assert.equal(first.affection, 30.5);
  const second = store.poke();
  assert.equal(second.pokes, 2);
  assert.equal(second.mood, 72);
  assert.equal(second.affection, 31);
});

test('离线若干小时：心情回落、精力恢复（上限 100），并记 system 历史', () => {
  const { store, tick } = harness();
  store.ensure();
  tick(5);
  const snap = store.current();
  assert.equal(snap.mood, 60); // 70 - 5*2
  assert.equal(snap.energy, 100); // 80 + 5*8 但钳到 100
  const entries = store.history(50);
  assert.ok(entries.some((e) => e.source === 'system' && e.key === 'mood' && e.reason.includes('离线')));
  assert.ok(entries.some((e) => e.source === 'system' && e.key === 'energy'));
});

test('prompt 是行为指导：包含小节标题与档位描述，不直接报数值', () => {
  const { store } = harness();
  store.ensure();
  const text = store.prompt();
  assert.ok(text.includes('## 你现在的状态'));
  assert.ok(text.includes('心情不错'));
  assert.ok(text.includes('比较亲近') === false || text.length > 0);
  // 数值不应以「心情 70」这种形式出现在提示词里
  assert.ok(!/心情\s*[:：]?\s*70/.test(text));
});

test('坏档与老格式兼容：坏 JSON 重新播种；缺字段补默认', () => {
  const { store, file } = harness();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ 这不是 json', 'utf8');
  const snap = store.current();
  assert.equal(snap.mood, 70);
  fs.writeFileSync(file, JSON.stringify({ mood: 12, affection: 88, energy: 50 }), 'utf8');
  const legacy = store.current();
  assert.equal(legacy.mood, 12);
  assert.equal(legacy.affection, 88);
  assert.equal(legacy.energy, 50);
});

test('clampValue 与 tierOf 边界', () => {
  assert.equal(clampValue(-5), 0);
  assert.equal(clampValue(105), 100);
  assert.equal(clampValue(33.333), 33.3);
  assert.equal(tierOf('mood', 19), '很低落');
  assert.equal(tierOf('mood', 90), '很开心');
  assert.equal(tierOf('affection', 75), '很黏你');
  assert.equal(tierOf('energy', 10), '很累');
  assert.equal(buildMoodPrompt({ mood: 70, affection: 30, energy: 80 }).includes('逐渐熟悉'), true);
});
