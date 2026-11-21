/**
 * DshRuntime：握手、请求/响应、事件转发、审批往返、错误与退出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshRuntime } from './runtime.js';
import { asChildProcess, FakeChild, makeRuntimeFiles, standardHandler } from './testing.js';

function makeRuntime(handler: (frame: import('./testing.js').FakeFrame, child: FakeChild) => void, overrides: Partial<Record<string, unknown>> = {}) {
  const files = makeRuntimeFiles();
  const events: Array<{ sessionId: string; type: string }> = [];
  const statuses: Array<{ sessionId: string; status: string }> = [];
  const approvals: string[] = [];
  const child = new FakeChild(handler);
  const runtime = new DshRuntime({
    exePath: files.exePath,
    cliPath: files.cliPath,
    cwd: files.cwd,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    ...overrides,
    spawnImpl: () => asChildProcess(child),
    handlers: {
      onEvent: (e) => events.push({ sessionId: e.sessionId, type: typeof e.event['type'] === 'string' ? (e.event['type'] as string) : '' }),
      onStatus: (s) => statuses.push({ sessionId: s.sessionId, status: s.status }),
      onApproval: (p) => {
        approvals.push(p.toolName ?? '');
        return overrides['approvalOutcome'] === 'rejected' ? 'rejected' : 'allowed-once';
      },
    },
  });
  return { runtime, child, events, statuses, approvals };
}

test('start：握手成功，status 带 serverInfo 与 pid', async () => {
  const { runtime } = makeRuntime(standardHandler());
  await runtime.start();
  const status = runtime.status();
  assert.equal(status.running, true);
  assert.equal(status.pid, 4242);
  assert.deepEqual(status.serverInfo, { name: 'fake-sdk', version: '0.0.0' });
  assert.equal(status.provider, 'deepseek-official');
  await runtime.stop();
});

test('prompt：返回 messageId，事件/状态回调转发', async () => {
  const { runtime, events, statuses } = makeRuntime(standardHandler({ pollText: '好的' }));
  await runtime.start();
  const result = await runtime.prompt('petd-bridge', '你好', 5000);
  assert.equal(result.messageId, 'm-1');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events.map((e) => e.type), ['turn/start', 'assistant/message', 'turn/end']);
  assert.equal(events[0]?.sessionId, 'petd-bridge');
  await runtime.stop();
  assert.equal(statuses.length, 0); // 这轮脚本没发 session.status
});

test('prompt：DSH 回错误时以中文错误 reject', async () => {
  const { runtime } = makeRuntime((frame, child) => {
    if (frame.method === 'initialize') child.respond(frame.id ?? 0, { serverInfo: { name: 'fake-sdk', version: '0.0.0' } });
    else if (frame.method === 'session/prompt') child.respondError(frame.id ?? 0, '模型不可用');
  });
  await runtime.start();
  await assert.rejects(runtime.prompt('s', 'x', 5000), /模型不可用/);
  await runtime.stop();
});

test('审批：服务器发 approval/request，客户端回 outcome', async () => {
  const { runtime, approvals } = makeRuntime((frame, child) => {
    if (frame.method === 'initialize') child.respond(frame.id ?? 0, { serverInfo: { name: 'fake-sdk', version: '0.0.0' } });
    else if (frame.method === 'session/prompt') {
      child.respond(frame.id ?? 0, { messageId: 'm-2' });
      child.request(77, 'approval/request', { sessionId: 's', toolName: 'bash', reason: '要跑命令' });
    }
  });
  await runtime.start();
  await runtime.prompt('s', '跑个命令', 5000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(approvals, ['bash']);
  const response = (await new Promise((resolve) => setTimeout(() => resolve(undefined), 10))) as undefined;
  assert.equal(response, undefined);
  await runtime.stop();
});

test('缺少可执行文件：start 抛 E_UNAVAILABLE 中文错误', async () => {
  const runtime = new DshRuntime({
    exePath: 'Z:\\不存在的路径\\DeepSeek Harness.exe',
    cliPath: 'Z:\\不存在的路径\\cli.js',
    cwd: 'Z:\\不存在的路径',
    provider: 'x',
    model: 'y',
  });
  await assert.rejects(runtime.start(), /找不到 DeepSeek Harness 可执行文件/);
});

test('stop：发 shutdown、进程退出、running=false', async () => {
  const { runtime } = makeRuntime(standardHandler());
  await runtime.start();
  await runtime.stop();
  assert.equal(runtime.status().running, false);
  assert.equal(runtime.status().lastExitCode, 0);
});
