/**
 * GameAssistant：子进程桥调用、超时、dry-run 点击、allowClick 门、目录探测。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { GameAssistant } from './assistant.js';
import type { PetdConfig } from '../kernel/config.js';

const ECHO_BRIDGE = [
  "let s='';",
  "process.stdin.on('data',(d)=>{s+=d});",
  "process.stdin.on('end',()=>{",
  '  const req=JSON.parse(s||"{}");',
  '  process.stdout.write(JSON.stringify({ok:true,op:req.op,params:req})+"\\n");',
  '});',
].join('\n');

function makeDir(bridgeSource: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-game-'));
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'petd-bridge.js'), bridgeSource, 'utf8');
  return dir;
}

function configOf(over: Partial<PetdConfig['game']> = {}): PetdConfig['game'] {
  return {
    enabled: true,
    assistantDir: '',
    nodePath: '',
    timeoutMs: 5000,
    allowClick: false,
    gameHint: '明日方舟',
    ...over,
  };
}

function makeAssistant(dir: string, over: Partial<PetdConfig['game']> = {}): GameAssistant {
  return new GameAssistant({
    config: () => configOf({ assistantDir: dir, ...over }),
    home: dir,
    logger: {},
  });
}

test('enabled=false 时调用直接拒绝，status 里也标未启用', async () => {
  const dir = makeDir(ECHO_BRIDGE);
  const game = makeAssistant(dir, { enabled: false });
  assert.equal(game.status().enabled, false);
  await assert.rejects(() => game.look(), /游戏助手没开启/);
});

test('找不到桥时报 E_UNAVAILABLE', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petd-game-empty-'));
  const game = makeAssistant(dir);
  await assert.rejects(() => game.look(), /没有桥/);
});

test('look 透传 op=look 与 find/ocrEngine，返回桥的 JSON', async () => {
  const dir = makeDir(ECHO_BRIDGE);
  const game = makeAssistant(dir);
  const res = await game.look({ find: ['开始行动'], ocrEngine: 'paddle' });
  assert.equal(res['ok'], true);
  assert.equal(res['op'], 'look');
  const params = res['params'] as Record<string, unknown>;
  assert.deepEqual(params['find'], ['开始行动']);
  assert.equal(params['ocrEngine'], 'paddle');
});

test('find/template/operators 各自带对参数', async () => {
  const dir = makeDir(ECHO_BRIDGE);
  const game = makeAssistant(dir);
  const found = await game.find('代理指挥', 0.8);
  assert.equal(found['op'], 'find');
  assert.equal((found['params'] as Record<string, unknown>)['text'], '代理指挥');
  assert.equal((found['params'] as Record<string, unknown>)['minCoverage'], 0.8);

  const tpl = await game.template(['Return.png']);
  assert.equal(tpl['op'], 'template');
  assert.deepEqual((tpl['params'] as Record<string, unknown>)['names'], ['Return.png']);

  const ops = await game.operators(['char_002_amiya'], [{ x: 0, y: 0, w: 10, h: 10 }]);
  assert.equal(ops['op'], 'operators');
  assert.deepEqual((ops['params'] as Record<string, unknown>)['ids'], ['char_002_amiya']);
});

test('超时会杀掉桥并报中文错误', async () => {
  const dir = makeDir('process.stdin.resume();\nsetTimeout(() => {}, 60000);\n');
  const game = makeAssistant(dir, { timeoutMs: 800 });
  await assert.rejects(() => game.look(), /超时/);
  assert.equal(game.status().counters.errors, 1);
});

test('默认只 dry-run：click 不带 allowReal', async () => {
  const dir = makeDir(ECHO_BRIDGE);
  const game = makeAssistant(dir);
  const plan = await game.click(100, 200);
  assert.equal(plan['dryRun'], true);
  assert.equal((plan['params'] as Record<string, unknown>)['allowReal'], false);
});

test('allowClick=false 时真点被拒；true 时带 allowReal=true', async () => {
  const dir = makeDir(ECHO_BRIDGE);
  const blocked = makeAssistant(dir);
  await assert.rejects(() => blocked.click(1, 2, { real: true }), /没打开真点开关/);

  const allowed = makeAssistant(dir, { allowClick: true });
  const res = await allowed.click(1, 2, { real: true });
  assert.equal((res['params'] as Record<string, unknown>)['allowReal'], true);
});
