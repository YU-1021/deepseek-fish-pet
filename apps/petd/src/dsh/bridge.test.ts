/**
 * DshBridge：状态/路径、ask 等待回合结束、默认拒绝审批、ask 策略下人工放行、开关与关闭。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DshBridge, type DshBridgeOptions } from './bridge.js';
import { asChildProcess, FakeChild, makeRuntimeFiles, standardHandler, type FakeFrame } from './testing.js';
import type { PetdConfig } from '../kernel/config.js';

type DshCfg = PetdConfig['dsh'];

interface Scenario {
  bridge: DshBridge;
  child: FakeChild;
  events: Array<{ event: string; data: Record<string, unknown> }>;
  cfg: DshCfg;
  files: { dir: string; exePath: string; cliPath: string; cwd: string };
}

function makeScenario(
  handler: (frame: FakeFrame, child: FakeChild) => void,
  overrides: Partial<DshCfg> = {},
  options: { observe?: boolean } = {}
): Scenario {
  const files = makeRuntimeFiles();
  const dshHome = path.join(files.dir, '.dsh');
  const cfg: DshCfg = {
    enabled: true,
    observe: options.observe ?? false,
    exePath: files.exePath,
    cliPath: files.cliPath,
    cwd: files.cwd,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
    maxTokens: 16000,
    approvalPolicy: 'reject',
    askTimeoutMs: 5000,
    observeIntervalMs: 1500,
    activeMs: 15000,
    ...overrides,
  };
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const child = new FakeChild(handler);
  const bridgeOptions: DshBridgeOptions = {
    config: () => cfg,
    home: path.join(files.dir, 'home'),
    dshHome,
    logger: {},
    armTimers: false,
    publish: (event, data) => events.push({ event, data }),
    spawnImpl: () => asChildProcess(child),
  };
  return { bridge: new DshBridge(bridgeOptions), child, events, cfg, files };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('status：路径/观察目录默认值，未启动时 runtime 为 null', () => {
  const { bridge, files } = makeScenario(() => {});
  const status = bridge.status();
  assert.equal(status.enabled, true);
  assert.equal(status.observe, false);
  assert.equal(status.started, false);
  assert.equal(status.runtime, null);
  assert.equal(status.paths.exePath, files.exePath);
  assert.equal(status.paths.cliPath, files.cliPath);
  assert.equal(status.paths.cwd, files.cwd);
  assert.equal(status.paths.sessionsDir, path.join(files.dir, '.dsh', 'sessions'));
  assert.equal(status.counters.asks, 0);
});

test('ask：发任务、等 turn/end，拿到回答与 turn；事件广播', async () => {
  const scenario = makeScenario(standardHandler({ pollText: '收到，开始干活' }), {}, { observe: true });
  const result = await scenario.bridge.ask('把这活干了');
  assert.equal(result.text, '收到，开始干活');
  assert.equal(result.turn, 1);
  assert.equal(result.sessionId, 'petd-bridge');
  assert.ok(result.durationMs >= 0);
  const eventNames = scenario.events.map((e) => e.event);
  assert.ok(eventNames.includes('dsh.event'));
  assert.ok(eventNames.includes('dsh.status'));
  assert.ok(scenario.events.some((e) => e.event === 'dsh.event' && e.data['type'] === 'turn/end'));
  const status = scenario.bridge.status();
  assert.equal(status.runtime?.running, true);
  assert.equal(status.counters.prompts, 1);
  assert.equal(status.counters.asks, 1);
  await scenario.bridge.stop();
  assert.equal(scenario.bridge.status().runtime, null);
});

test('审批默认策略 reject：不发 dsh.approval，直接回 rejected', async () => {
  let approvalResponse: Record<string, unknown> | null = null;
  const handler = (frame: FakeFrame, child: FakeChild): void => {
    if (frame.method === 'initialize') {
      child.respond(frame.id ?? 0, { serverInfo: { name: 'fake', version: '1' } });
      return;
    }
    if (frame.method === 'session/prompt') {
      child.respond(frame.id ?? 0, { messageId: 'm' });
      setImmediate(() => {
        child.request(9, 'approval/request', { sessionId: 'petd-bridge', toolName: 'bash', reason: '要跑命令' });
        child.notify('session.event', { sessionId: 'petd-bridge', event: { type: 'turn/start', turn: 1 } });
        child.notify('session.event', { sessionId: 'petd-bridge', event: { type: 'turn/end', turn: 1 } });
      });
      return;
    }
    if (frame.id === 9 && frame.method === undefined && frame.result !== undefined) {
      approvalResponse = frame.result as Record<string, unknown>;
    }
  };
  const scenario = makeScenario(handler);
  await scenario.bridge.ask('跑个命令');
  assert.deepEqual(approvalResponse, { outcome: 'rejected' });
  assert.equal(scenario.events.filter((e) => e.event === 'dsh.approval').length, 0);
  await scenario.bridge.stop();
});

test('审批策略 ask：广播 dsh.approval，人工放行后 DSH 继续并结束回合并返回文字', async () => {
  let approvalAnswered = false;
  const handler = (frame: FakeFrame, child: FakeChild): void => {
    if (frame.method === 'initialize') {
      child.respond(frame.id ?? 0, { serverInfo: { name: 'fake', version: '1' } });
      return;
    }
    if (frame.method === 'session/prompt') {
      child.respond(frame.id ?? 0, { messageId: 'm' });
      setImmediate(() => child.request(11, 'approval/request', { sessionId: 'petd-bridge', toolName: 'write_file', reason: '要写文件' }));
      return;
    }
    if (frame.id === 11 && frame.method === undefined && frame.result !== undefined) {
      const outcome = (frame.result as Record<string, unknown>)['outcome'];
      if (outcome === 'allowed-once' && !approvalAnswered) {
        approvalAnswered = true;
        setImmediate(() => {
          child.notify('session.event', { sessionId: 'petd-bridge', event: { type: 'turn/start', turn: 2 } });
          child.notify('session.event', {
            sessionId: 'petd-bridge',
            event: {
              type: 'assistant/message',
              turn: 2,
              message: { role: 'assistant', content: [{ type: 'text', text: '写好了' }] },
            },
          });
          child.notify('session.event', { sessionId: 'petd-bridge', event: { type: 'turn/end', turn: 2 } });
        });
      }
    }
  };
  const scenario = makeScenario(handler, { approvalPolicy: 'ask' });
  const asking = scenario.bridge.ask('帮我写文件');
  const approvalEvent = await waitFor(() => scenario.events.find((e) => e.event === 'dsh.approval'));
  assert.equal(approvalEvent.data['toolName'], 'write_file');
  assert.equal(approvalEvent.data['reason'], '要写文件');
  const id = String(approvalEvent.data['id']);
  assert.equal(scenario.bridge.status().pendingApprovals, 1);
  assert.equal(scenario.bridge.answerApproval('不存在的 id', 'rejected'), false);
  assert.equal(scenario.bridge.answerApproval(id, 'allowed-once'), true);
  const result = await asking;
  assert.equal(result.text, '写好了');
  assert.equal(result.turn, 2);
  assert.ok(scenario.events.some((e) => e.event === 'dsh.approval.resolved' && e.data['outcome'] === 'allowed-once'));
  await scenario.bridge.stop();
});

test('enabled=false：ask 报中文错误 E_UNAVAILABLE，不 spawn', async () => {
  const scenario = makeScenario(() => {}, { enabled: false });
  await assert.rejects(scenario.bridge.ask('你好'), /DSH 桥已关闭/);
  assert.equal(scenario.child.written.length, 0);
});

test('start/stop：开观察、stop 后观察关闭；warmup 拉起 runtime', async () => {
  const scenario = makeScenario(standardHandler(), {}, { observe: true });
  scenario.bridge.start();
  assert.equal(scenario.bridge.status().started, true);
  assert.equal(scenario.bridge.status().observer.enabled, true);
  await scenario.bridge.warmup();
  assert.equal(scenario.bridge.status().runtime?.running, true);
  await scenario.bridge.stop();
  const status = scenario.bridge.status();
  assert.equal(status.started, false);
  assert.equal(status.observer.enabled, false);
  assert.equal(status.runtime, null);
});

test('真实 envelope 事件（字段在 data 下）：ask 仍能拿到文字与 turn', async () => {
  // 实测桌面 DSH 的事件是 {type, seq, time, data:{turn,step,message}}，不是扁平形状。
  const handler = (frame: FakeFrame, child: FakeChild): void => {
    if (frame.method === 'initialize') {
      child.respond(frame.id ?? 0, { serverInfo: { name: 'fake', version: '1' } });
      return;
    }
    if (frame.method === 'session/prompt') {
      child.respond(frame.id ?? 0, { messageId: 'm-env' });
      setImmediate(() => {
        child.notify('session.event', { sessionId: 'petd-bridge', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 5 } } });
        child.notify('session.event', {
          sessionId: 'petd-bridge',
          event: {
            type: 'assistant/message',
            seq: 2,
            time: 2,
            data: { turn: 5, step: 3, message: { role: 'assistant', content: [{ type: 'text', text: '包在 data 里' }] } },
          },
        });
        child.notify('session.event', { sessionId: 'petd-bridge', event: { type: 'turn/end', seq: 3, time: 3, data: { turn: 5 } } });
      });
    }
  };
  const scenario = makeScenario(handler);
  const result = await scenario.bridge.ask('你好');
  assert.equal(result.text, '包在 data 里');
  assert.equal(result.turn, 5);
  const assistantEvent = scenario.events.find((e) => e.event === 'dsh.event' && e.data['type'] === 'assistant/message');
  assert.equal(assistantEvent?.data['text'], '包在 data 里');
  await scenario.bridge.stop();
});

test('session 已存在：先 session/resume 再重试，prompt 成功', async () => {
  let promptCalls = 0;
  let resumed = false;
  const handler = (frame: FakeFrame, child: FakeChild): void => {
    if (frame.method === 'initialize') {
      child.respond(frame.id ?? 0, { serverInfo: { name: 'fake', version: '1' } });
      return;
    }
    if (frame.method === 'session/resume') {
      resumed = true;
      child.respond(frame.id ?? 0, {});
      return;
    }
    if (frame.method === 'session/prompt') {
      promptCalls += 1;
      if (promptCalls === 1) {
        child.respondError(frame.id ?? 0, 'session "petd-bridge" already exists');
        return;
      }
      child.respond(frame.id ?? 0, { messageId: 'm-retry' });
    }
  };
  const scenario = makeScenario(handler);
  const result = await scenario.bridge.prompt('你好');
  assert.equal(resumed, true);
  assert.equal(promptCalls, 2);
  assert.equal(result.messageId, 'm-retry');
  await scenario.bridge.stop();
});
