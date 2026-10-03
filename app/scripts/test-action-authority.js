'use strict';

const assert = require('assert');
const { createActionAuthority } = require('../src/action-authority');

let clock = 1_000_000;
let randomSeq = 0;
const authority = createActionAuthority({
  now: () => clock,
  randomBytes: () => Buffer.from(('token-' + (++randomSeq)).padEnd(32, '_')),
});

let passed = 0;
let total = 0;
function test(name, fn) {
  total++;
  fn();
  passed++;
  console.log('  ✅ ' + name);
}

function issue(x, y, epoch, source) {
  return authority.issueTarget({ x, y, source: source || 'find_text', label: 'fixture', userEpoch: epoch == null ? 4 : epoch });
}

console.log('Action authority contract');

test('target source allowlist rejects visual guesses', () => {
  assert.strictEqual(authority.issueTarget({ x: 10, y: 20, source: 'screen_look', userEpoch: 4 }).ok, false);
  assert.strictEqual(issue(10, 20, 4, 'find_text').ok, true);
  assert.strictEqual(issue(30, 40, 4, 'find_template').ok, true);
  assert.strictEqual(issue(50, 60, 4, 'find_template_scroll').ok, true);
  assert.strictEqual(issue(70, 80, 4, 'uia_find').ok, true);
  authority.invalidateTargets();
});

test('click accepts at most two pixels of integer rounding drift', () => {
  issue(100, 200);
  const hit = authority.matchAndConsumeTarget({ tool: 'click', arg: '102,198', userEpoch: 4 });
  assert.strictEqual(hit.ok, true);
  assert.strictEqual(hit.grant.source, 'find_text');
});

test('click rejects coordinates outside the two-pixel boundary', () => {
  issue(100, 200);
  const miss = authority.matchAndConsumeTarget({ tool: 'click', arg: '103,200', userEpoch: 4 });
  assert.deepStrictEqual([miss.ok, miss.reason], [false, 'target-mismatch']);
  authority.invalidateTargets();
});

test('Chinese comma coordinates normalize without broad matching', () => {
  issue(321, 654);
  assert.strictEqual(authority.matchAndConsumeTarget({ tool: 'dclick', arg: '321，654', userEpoch: 4 }).ok, true);
  issue(321, 654);
  assert.strictEqual(authority.matchAndConsumeTarget({ tool: 'dclick', arg: '321，654，99', userEpoch: 4 }).ok, false);
  authority.invalidateTargets();
});

test('drag requires two distinct valid target grants and consumes both atomically', () => {
  issue(10, 20);
  let result = authority.matchAndConsumeTarget({ tool: 'drag', arg: '10,20|300,400', userEpoch: 4 });
  assert.deepStrictEqual([result.ok, result.reason], [false, 'target-mismatch']);
  assert.strictEqual(authority.stats().targets, 1, 'failed drag must not consume its matching start grant');
  issue(300, 400);
  result = authority.matchAndConsumeTarget({ tool: 'drag', arg: '10,20|300,400', userEpoch: 4 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.grants.length, 2);
  assert.strictEqual(authority.stats().targets, 0);
});

test('target expires after 120 seconds', () => {
  issue(10, 20);
  clock += 120001;
  const result = authority.matchAndConsumeTarget({ tool: 'click', arg: '10,20', userEpoch: 4 });
  assert.deepStrictEqual([result.ok, result.reason], [false, 'target-expired']);
  clock = 1_000_000;
  authority.invalidateTargets();
});

test('target is one-use and replay is rejected', () => {
  issue(10, 20);
  assert.strictEqual(authority.matchAndConsumeTarget({ tool: 'click', arg: '10,20', userEpoch: 4 }).ok, true);
  assert.strictEqual(authority.matchAndConsumeTarget({ tool: 'click', arg: '10,20', userEpoch: 4 }).reason, 'target-mismatch');
});

test('changed user epoch invalidates an otherwise matching target', () => {
  issue(10, 20, 4);
  const result = authority.matchAndConsumeTarget({ tool: 'click', arg: '10,20', userEpoch: 5 });
  assert.deepStrictEqual([result.ok, result.reason], [false, 'user-took-over']);
  authority.invalidateTargets();
});

test('approval token is bound to normalized tool and exact argument', () => {
  const issued = authority.issueApproval({ tool: 'WEB_CLICK', arg: '#send' });
  assert.strictEqual(issued.ok, true);
  assert.strictEqual(authority.consumeApproval({ token: issued.token, tool: 'web_click', arg: '#other' }).reason, 'approval-action-mismatch');
  assert.strictEqual(authority.consumeApproval({ token: issued.token, tool: 'web_click', arg: '#send' }).ok, true);
});

test('approval token expires after 120 seconds', () => {
  const issued = authority.issueApproval({ tool: 'run_file', arg: 'C:\\job.js' });
  clock += 120001;
  const result = authority.consumeApproval({ token: issued.token, tool: 'run_file', arg: 'C:\\job.js' });
  assert.deepStrictEqual([result.ok, result.reason], [false, 'approval-expired']);
  clock = 1_000_000;
});

test('approval token is one-use and replay is rejected', () => {
  const issued = authority.issueApproval({ tool: 'proj_rm', arg: 'old.txt' });
  assert.strictEqual(authority.consumeApproval({ token: issued.token, tool: 'proj_rm', arg: 'old.txt' }).ok, true);
  assert.strictEqual(authority.consumeApproval({ token: issued.token, tool: 'proj_rm', arg: 'old.txt' }).reason, 'approval-not-found');
});

test('stats expose counts only and never approval tokens', () => {
  const issued = authority.issueApproval({ tool: 'web_type', arg: '#message||secret' });
  const stats = authority.stats();
  assert.strictEqual(stats.approvals, 1);
  assert.strictEqual(JSON.stringify(stats).includes(issued.token), false);
  authority.consumeApproval({ token: issued.token, tool: 'web_type', arg: '#message||secret' });
});

console.log('\n通过 ' + passed + ' / ' + total);
if (passed !== total) process.exitCode = 1;

