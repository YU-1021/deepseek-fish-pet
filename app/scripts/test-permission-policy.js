'use strict';

const assert = require('assert');
const {
  normalizeAction, classifyAction,
  POINTER_TOOLS, KEYBOARD_TOOLS, DELETE_TOOLS, EXECUTE_TOOLS, WEB_MUTATION_TOOLS,
} = require('../src/permission-policy');

let passed = 0;
let total = 0;
function test(name, fn) {
  total++;
  fn();
  passed++;
  console.log('  ✅ ' + name);
}

function decide(tool, facts, arg, tier) {
  return classifyAction({
    tier: tier || 'full',
    tool,
    arg: arg == null ? '' : arg,
    facts: Object.assign({
      toolAllowed: true,
      destinationExists: false,
      hasTargetGrant: false,
      focusVerified: false,
      userActive: false,
    }, facts || {}),
  });
}

console.log('Permission policy contract');

test('malformed action is denied before tool execution', () => {
  assert.deepStrictEqual(normalizeAction(null), { ok: false, reason: 'invalid-action' });
  assert.strictEqual(classifyAction({ tier: 'full', tool: '', arg: '', facts: { toolAllowed: true } }).decision, 'deny');
  assert.strictEqual(classifyAction({ tier: 'full', tool: 'click', arg: { x: 1 }, facts: { toolAllowed: true } }).reason, 'invalid-argument');
});

test('tool names are canonicalized without rewriting argument content', () => {
  assert.deepStrictEqual(normalizeAction({ tool: '  FIND_TEXT ', arg: '  Save As  ' }), {
    ok: true,
    action: { tool: 'find_text', arg: '  Save As  ' },
  });
});

test('unknown or insufficient-permission tool is denied', () => {
  const result = decide('unknown_tool', { toolAllowed: false }, '', 'full');
  assert.deepStrictEqual([result.decision, result.reason], ['deny', 'permission-denied']);
});

test('read-only tool allowed by existing tier remains automatic', () => {
  const result = decide('read_file', {}, 'C:\\notes.txt', 'read');
  assert.deepStrictEqual([result.decision, result.risk], ['allow', 'read']);
});

for (const tool of ['proj_rm', 'skill_rm', 'template_del', 'flow_del', 'tag_rm']) {
  test(tool + ' always requires confirmation, including full tier', () => {
    const result = decide(tool, {}, 'target', 'full');
    assert.deepStrictEqual([result.decision, result.reason, result.risk], ['confirm', 'destructive-action', 'destructive']);
  });
}

test('overwriting an existing destination requires confirmation', () => {
  const result = decide('write_file', { destinationExists: true }, 'C:\\notes.txt||new', 'full');
  assert.deepStrictEqual([result.decision, result.reason], ['confirm', 'overwrite-existing']);
});

test('creating a new destination follows existing tier without extra confirmation', () => {
  const result = decide('write_file', { destinationExists: false }, 'C:\\new.txt||new', 'full');
  assert.strictEqual(result.decision, 'allow');
});

for (const tool of ['run_file', 'proj_run', 'open_path']) {
  test(tool + ' always requires confirmation', () => {
    assert.deepStrictEqual([decide(tool).decision, decide(tool).risk], ['confirm', 'local-exec']);
  });
}

for (const tool of ['web_click', 'web_type']) {
  test(tool + ' always requires confirmation', () => {
    assert.deepStrictEqual([decide(tool).decision, decide(tool).risk], ['confirm', 'web-mutation']);
  });
}

test('verified pointer target is allowed and requires target authority', () => {
  const result = decide('click', { hasTargetGrant: true }, '100,200');
  assert.deepStrictEqual([result.decision, result.reason, result.risk], ['allow', 'verified-target', 'screen-input']);
  assert.deepStrictEqual(result.requirements, ['target-grant']);
});

test('unverified pointer target requires confirmation instead of automatic click', () => {
  const result = decide('click', { hasTargetGrant: false }, '100,200');
  assert.deepStrictEqual([result.decision, result.reason], ['confirm', 'unverified-target']);
});

test('keyboard action requires verified foreground focus', () => {
  assert.deepStrictEqual([decide('type').decision, decide('type').reason], ['deny', 'focus-not-verified']);
  assert.strictEqual(decide('type', { focusVerified: true }).decision, 'allow');
});

test('active user blocks pointer and keyboard actions but not reads', () => {
  assert.strictEqual(decide('click', { hasTargetGrant: true, userActive: true }).reason, 'user-active');
  assert.strictEqual(decide('key', { focusVerified: true, userActive: true }).reason, 'user-active');
  assert.strictEqual(decide('read_file', { userActive: true }).decision, 'allow');
});

test('exported tool groups are immutable and contain their policy members', () => {
  assert(Object.isFrozen(POINTER_TOOLS));
  assert(Object.isFrozen(KEYBOARD_TOOLS));
  assert(Object.isFrozen(DELETE_TOOLS));
  assert(Object.isFrozen(EXECUTE_TOOLS));
  assert(Object.isFrozen(WEB_MUTATION_TOOLS));
  assert(POINTER_TOOLS.includes('drag'));
  assert(KEYBOARD_TOOLS.includes('type'));
  assert(DELETE_TOOLS.includes('proj_rm'));
  assert(EXECUTE_TOOLS.includes('run_file'));
  assert(EXECUTE_TOOLS.includes('open_path'));
  assert(WEB_MUTATION_TOOLS.includes('web_click'));
});

console.log('\n通过 ' + passed + ' / ' + total);
if (passed !== total) process.exitCode = 1;
