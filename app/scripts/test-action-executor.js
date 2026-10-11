'use strict';

const assert = require('assert');
const { createActionExecutor } = require('../src/action-executor');
const { classifyAction } = require('../src/permission-policy');
const { createActionAuthority } = require('../src/action-authority');

let passed = 0;
let total = 0;
async function test(name, fn) {
  total++;
  await fn();
  passed++;
  console.log('  ✅ ' + name);
}

function harness(changes) {
  let clock = 1000;
  let tokenSeq = 0;
  const events = [];
  const calls = [];
  const facts = {
    destinationExists: false,
    focusVerified: false,
    userActive: false,
    userEpoch: 0,
  };
  const authority = createActionAuthority({
    now: () => clock,
    randomBytes: () => Buffer.from(('exec-token-' + (++tokenSeq)).padEnd(32, '_')),
  });
  const audit = {
    append(event) {
      events.push(Object.assign({}, event));
      return { ok: true, id: event.id || 'audit-1' };
    },
  };
  const state = {
    runResult: 'done',
    runError: null,
    waitHook: null,
  };
  Object.assign(state, changes || {});
  const executor = createActionExecutor({
    allowed: (_tier, tool) => tool !== 'unknown_tool',
    classifyAction,
    authority,
    audit: state.audit || audit,
    getFacts: async () => Object.assign({}, facts),
    waitUntilFree: async () => {
      if (state.waitHook) state.waitHook(facts);
      return facts.userActive ? 30001 : 0;
    },
    runTool: async (action) => {
      calls.push(Object.assign({}, action));
      if (state.runError) throw state.runError;
      return state.runResult;
    },
    now: () => clock++,
  });
  return { executor, authority, audit, events, calls, facts, state, tick: (n) => { clock += n; } };
}

(async () => {
  console.log('Action executor contract');

  await test('malformed and unauthorized actions are denied without calling the tool', async () => {
    const h = harness();
    const malformed = await h.executor.execute(null, { tier: 'full' });
    const unknown = await h.executor.execute({ tool: 'unknown_tool', arg: '' }, { tier: 'full' });
    assert.deepStrictEqual([malformed.ok, malformed.reason], [false, 'invalid-action']);
    assert.deepStrictEqual([unknown.ok, unknown.reason], [false, 'permission-denied']);
    assert.strictEqual(h.calls.length, 0);
  });

  await test('confirmation decision without a token never calls the tool', async () => {
    const h = harness();
    const result = await h.executor.execute({ tool: 'web_click', arg: '#send' }, { tier: 'web' });
    assert.deepStrictEqual([result.ok, result.needsConfirmation, result.reason], [false, true, 'external-side-effect']);
    assert.strictEqual(h.calls.length, 0);
  });

  await test('valid approval executes exactly once and replay is rejected', async () => {
    const h = harness();
    const approved = await h.executor.approve({ tool: 'web_click', arg: '#send' }, { tier: 'web' });
    assert.strictEqual(approved.ok, true);
    const first = await h.executor.execute({ action: { tool: 'web_click', arg: '#send' }, approvalToken: approved.token }, { tier: 'web' });
    assert.strictEqual(first.ok, true);
    const replay = await h.executor.execute({ action: { tool: 'web_click', arg: '#send' }, approvalToken: approved.token }, { tier: 'web' });
    assert.deepStrictEqual([replay.ok, replay.reason], [false, 'approval-not-found']);
    assert.strictEqual(h.calls.length, 1);
  });

  await test('verified pointer target executes once and the consumed target cannot auto-run again', async () => {
    const h = harness();
    h.authority.issueTarget({ x: 100, y: 200, source: 'find_text', userEpoch: 0 });
    const first = await h.executor.execute({ tool: 'click', arg: '100,200' }, { tier: 'full' });
    assert.strictEqual(first.ok, true);
    const second = await h.executor.execute({ tool: 'click', arg: '100,200' }, { tier: 'full' });
    assert.deepStrictEqual([second.ok, second.needsConfirmation], [false, true]);
    assert.strictEqual(h.calls.length, 1);
  });

  await test('changed user epoch blocks a formerly verified target', async () => {
    const h = harness();
    h.authority.issueTarget({ x: 100, y: 200, source: 'uia_find', userEpoch: 0 });
    h.facts.userEpoch = 1;
    const result = await h.executor.execute({ tool: 'click', arg: '100,200' }, { tier: 'full' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.needsConfirmation, true);
    assert.strictEqual(h.calls.length, 0);
  });

  await test('successful execution writes decision, started, and finished in order', async () => {
    const h = harness();
    const result = await h.executor.execute({ tool: 'read_file', arg: 'C:\\notes.txt' }, { tier: 'read' });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(h.events.map((x) => x.phase), ['decision', 'started', 'finished']);
    assert(h.events.every((x) => x.id === 'audit-1' || x.phase === 'decision'));
  });

  await test('tool failure writes failed lifecycle and preserves the error', async () => {
    const h = harness({ runError: new Error('fixture failure') });
    await assert.rejects(() => h.executor.execute({ tool: 'read_file', arg: 'C:\\notes.txt' }, { tier: 'read' }), /fixture failure/);
    assert.deepStrictEqual(h.events.map((x) => x.phase), ['decision', 'started', 'failed']);
  });

  await test('locator result issues a target grant but ordinary tool result does not', async () => {
    const h = harness({ runResult: { text: 'found', target: { x: 44, y: 55, source: 'find_text', label: 'Save' } } });
    await h.executor.execute({ tool: 'find_text', arg: 'Save' }, { tier: 'full' });
    assert.strictEqual(h.authority.stats().targets, 1);
    h.state.runResult = { text: 'ordinary', target: { x: 9, y: 9, source: 'find_text' } };
    await h.executor.execute({ tool: 'read_file', arg: 'C:\\notes.txt' }, { tier: 'read' });
    assert.strictEqual(h.authority.stats().targets, 1);
  });

  await test('user becoming active while waiting cancels before keyboard input', async () => {
    const h = harness({ waitHook: (facts) => { facts.userActive = true; } });
    h.facts.focusVerified = true;
    const result = await h.executor.execute({ tool: 'type', arg: 'hello' }, { tier: 'full' });
    assert.deepStrictEqual([result.ok, result.reason], [false, 'user-active']);
    assert.strictEqual(h.calls.length, 0);
    assert.deepStrictEqual(h.events.map((x) => x.phase), ['decision', 'denied']);
  });

  await test('audit failure never changes an allow decision or tool outcome', async () => {
    const h = harness({ audit: { append: () => ({ ok: false, error: 'disk-full' }) } });
    const result = await h.executor.execute({ tool: 'read_file', arg: 'C:\\notes.txt' }, { tier: 'read' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(h.calls.length, 1);
  });

  console.log('\n通过 ' + passed + ' / ' + total);
  if (passed !== total) process.exitCode = 1;
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
