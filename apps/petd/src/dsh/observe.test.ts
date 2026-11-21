/**
 * DshObserver：只读尾读 v4 会话日志，归纳空闲/思考中/working。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { DshObserver, decodeWorkspaceName } from './observe.js';

const NOW = 1_700_000_000_000;
const zstd = zlib as unknown as { zstdCompressSync?: (input: Buffer) => Buffer };

function makeSessionsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'petd-dshobs-'));
}

/** 一条 zstd 帧 = 一个 JSON 事件（与 DSH 的追加格式一致：多个 zstd 帧拼接） */
function writeSession(sessionsDir: string, frames: Array<Record<string, unknown>>, mtimeMs: number): string {
  const sessionDir = path.join(sessionsDir, '--C-deepseek--', 'session-abc');
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd');
  const chunks: Buffer[] = [];
  for (const frame of frames) {
    const json = Buffer.from(JSON.stringify(frame) + '\n', 'utf8');
    if (typeof zstd.zstdCompressSync !== 'function') throw new Error('当前 Node 没有 zstdCompressSync');
    chunks.push(zstd.zstdCompressSync(json));
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

function makeObserver(sessionsDir: string, overrides: { activeMs?: number; publishEvents?: Array<string> } = {}) {
  const events: Array<Record<string, unknown>> = [];
  const eventsByName: string[] = overrides.publishEvents ?? [];
  const observer = new DshObserver({
    sessionsDir,
    activeMs: overrides.activeMs ?? 15_000,
    now: () => NOW,
    armTimers: false,
    publish: (event, data) => {
      eventsByName.push(event);
      events.push(data);
    },
  });
  return { observer, eventsByName, events };
}

test('decodeWorkspaceName：--C-deepseek-- → C:\\deepseek', () => {
  assert.equal(decodeWorkspaceName('--C-deepseek--'), 'C:\\deepseek');
  assert.equal(decodeWorkspaceName('--C-Users-64616-Desktop--'), 'C:\\Users\\64616\\Desktop');
  assert.equal(decodeWorkspaceName('plain'), 'plain');
});

test('没有 sessions 目录时 scan 返回 null', () => {
  const { observer } = makeObserver(path.join(makeSessionsDir(), '不存在'));
  assert.equal(observer.scan(), null);
  assert.equal(observer.status().session, null);
});

test('tool/call → working，带工具名与 turn', () => {
  const sessionsDir = makeSessionsDir();
  writeSession(
    sessionsDir,
    [
      { type: 'turn/start', turn: 3 },
      { type: 'step/start', turn: 3, step: 1 },
      { type: 'tool/call', turn: 3, step: 1, name: 'bash', callId: 'c1' },
    ],
    NOW - 2000
  );
  const { observer } = makeObserver(sessionsDir);
  const snapshot = observer.scan();
  assert.ok(snapshot);
  assert.equal(snapshot!.state, 'working');
  assert.equal(snapshot!.tool, 'bash');
  assert.equal(snapshot!.turn, 3);
  assert.equal(snapshot!.step, 1);
  assert.equal(snapshot!.active, true); // 2s 前更新过
  assert.equal(snapshot!.workspace, 'C:\\deepseek');
  assert.equal(snapshot!.sessionId, 'session-abc');
});

test('turn/end → idle，并取到最后一条 assistant 文本', () => {
  const sessionsDir = makeSessionsDir();
  writeSession(
    sessionsDir,
    [
      { type: 'turn/start', turn: 1 },
      { type: 'tool/call', turn: 1, step: 1, name: 'read' },
      { type: 'tool/result', turn: 1, step: 1 },
      {
        type: 'assistant/message',
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '都读完了，没事。' }] },
      },
      { type: 'turn/end', turn: 1, reason: { kind: 'completed' } },
    ],
    NOW - 60_000
  );
  const { observer } = makeObserver(sessionsDir);
  const snapshot = observer.scan();
  assert.ok(snapshot);
  assert.equal(snapshot!.state, 'idle');
  assert.equal(snapshot!.tool, null);
  assert.equal(snapshot!.lastText, '都读完了，没事。');
  assert.equal(snapshot!.lastEventType, 'turn/end');
  assert.equal(snapshot!.events, 5);
  assert.equal(snapshot!.active, false); // 60s 前，超过 15s 阈值
});

test('文件不变时复用缓存、不重复广播；变了才广播 dsh.activity', () => {
  const sessionsDir = makeSessionsDir();
  writeSession(sessionsDir, [{ type: 'turn/start', turn: 1 }, { type: 'step/start', turn: 1, step: 1 }], NOW - 1000);
  const { observer, eventsByName, events } = makeObserver(sessionsDir);
  const first = observer.scan();
  assert.equal(eventsByName.filter((e) => e === 'dsh.activity').length, 1);
  assert.equal(events[0]?.['state'], 'thinking');
  const second = observer.scan();
  assert.deepEqual(second, first);
  assert.equal(eventsByName.filter((e) => e === 'dsh.activity').length, 1);

  writeSession(sessionsDir, [{ type: 'turn/start', turn: 1 }, { type: 'turn/end', turn: 1 }], NOW - 500);
  const third = observer.scan();
  assert.equal(third?.state, 'idle');
  assert.equal(eventsByName.filter((e) => e === 'dsh.activity').length, 2);
});

test('start/stop 控制定时器与 status.enabled', async () => {
  const sessionsDir = makeSessionsDir();
  writeSession(sessionsDir, [{ type: 'turn/start', turn: 1 }], NOW);
  const { observer } = makeObserver(sessionsDir);
  assert.equal(observer.status().enabled, false);
  observer.start();
  assert.equal(observer.status().enabled, true);
  observer.stop();
  assert.equal(observer.status().enabled, false);
});

test('真实 envelope 形状（字段在 data 下）也能归纳状态', () => {
  const sessionsDir = makeSessionsDir();
  writeSession(
    sessionsDir,
    [
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 7 } },
      { type: 'step/start', seq: 2, time: 2, data: { turn: 7, step: 2 } },
      {
        type: 'assistant/message',
        seq: 3,
        time: 3,
        data: {
          turn: 7,
          step: 2,
          message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'edit', arguments: '{}' }] },
        },
      },
      {
        type: 'assistant/message',
        seq: 4,
        time: 4,
        data: { turn: 7, step: 3, message: { role: 'assistant', content: [{ type: 'text', text: '改好了。' }] } },
      },
    ],
    NOW - 10_000
  );
  const { observer } = makeObserver(sessionsDir);
  const snapshot = observer.scan();
  assert.ok(snapshot);
  assert.equal(snapshot!.turn, 7);
  assert.equal(snapshot!.step, 3);
  assert.equal(snapshot!.tool, 'edit');
  assert.equal(snapshot!.lastText, '改好了。');
  assert.equal(snapshot!.state, 'thinking');
});
