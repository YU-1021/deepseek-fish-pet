'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createActionAudit } = require('../src/action-audit');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dayu-action-audit-'));
let clock = 1_700_000_000_000;
let seq = 0;

let passed = 0;
let total = 0;
function test(name, fn) {
  total++;
  fn();
  passed++;
  console.log('  ✅ ' + name);
}

console.log('Action audit contract');

try {
  const audit = createActionAudit({ dir: root, now: () => clock++, randomId: () => 'action-' + (++seq) });

  test('writes versioned lifecycle rows with a stable action id', () => {
    const first = audit.append({ phase: 'decision', tool: 'click', tier: 'full', risk: 'screen-input', decision: 'allow', reason: 'verified-target' });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.id, 'action-1');
    for (const phase of ['approved', 'started', 'finished', 'failed', 'denied']) {
      assert.strictEqual(audit.append({ id: first.id, phase, tool: 'click', ok: phase === 'finished' }).ok, true);
    }
    const rows = audit.readRecent(20);
    assert.deepStrictEqual(rows.map((x) => x.phase), ['decision', 'approved', 'started', 'finished', 'failed', 'denied']);
    assert(rows.every((x) => x.version === 1 && x.id === 'action-1'));
  });

  test('safe metadata survives while raw arguments and secrets never reach disk', () => {
    const secret = 'sk-fixtureTOPSECRET123';
    const approvalToken = 'approval-token-fixture';
    const typed = 'my password is Swordfish!';
    const result = audit.append({
      phase: 'started', tool: 'web_type', tier: 'web', risk: 'web-mutation', reason: 'user-approved',
      targetSource: 'uia_find', durationMs: 17, ok: true,
      action: { tool: 'web_type', arg: '#password||' + typed + ' ' + secret },
      password: typed, token: secret, approvalToken,
    });
    assert.strictEqual(result.ok, true);
    const raw = fs.readFileSync(audit.file(), 'utf8');
    for (const forbidden of [secret, approvalToken, typed, 'Swordfish', '#password||']) assert(!raw.includes(forbidden), forbidden);
    const row = audit.readRecent(1)[0];
    assert.strictEqual(row.tool, 'web_type');
    assert.strictEqual(row.tier, 'web');
    assert.strictEqual(row.risk, 'web-mutation');
    assert.strictEqual(row.reason, 'user-approved');
    assert.strictEqual(row.targetSource, 'uia_find');
    assert.strictEqual(row.durationMs, 17);
    assert.strictEqual(row.ok, true);
    assert.strictEqual(row.action.argLength, ('#password||' + typed + ' ' + secret).length);
    assert.match(row.action.argSha256, /^[a-f0-9]{64}$/);
  });

  test('write content is hidden while normalized destination path remains auditable', () => {
    audit.append({ phase: 'decision', action: { tool: 'write_file', arg: 'C:\\work\\..\\work\\note.txt||PRIVATE BODY' } });
    const row = audit.readRecent(1)[0];
    assert.strictEqual(row.action.path, 'C:\\work\\note.txt');
    assert.strictEqual(JSON.stringify(row).includes('PRIVATE BODY'), false);
  });

  test('readRecent skips malformed historical lines', () => {
    fs.appendFileSync(audit.file(), '{broken json\n', 'utf8');
    fs.appendFileSync(audit.file(), JSON.stringify({ version: 1, id: 'manual', phase: 'finished' }) + '\n', 'utf8');
    const rows = audit.readRecent(2);
    assert.strictEqual(rows.some((x) => x.id === 'manual'), true);
    assert.strictEqual(rows.every((x) => x && typeof x === 'object'), true);
  });

  test('custom size limit rotates one generation before appending', () => {
    const dir = path.join(root, 'small');
    const small = createActionAudit({ dir, maxBytes: 120, now: () => clock++, randomId: () => 'small-' + (++seq) });
    small.append({ phase: 'decision', tool: 'read_file', action: { tool: 'read_file', arg: 'C:\\a.txt' } });
    small.append({ phase: 'finished', tool: 'read_file', action: { tool: 'read_file', arg: 'C:\\a.txt' } });
    assert.strictEqual(fs.existsSync(small.file() + '.1'), true);
    assert.strictEqual(small.readRecent(10).length, 1);
  });

  test('default 10 MiB limit rotates without loading the old file', () => {
    const dir = path.join(root, 'default-limit');
    const normal = createActionAudit({ dir, now: () => clock++, randomId: () => 'default-' + (++seq) });
    fs.mkdirSync(dir, { recursive: true });
    fs.closeSync(fs.openSync(normal.file(), 'w'));
    fs.truncateSync(normal.file(), 10 * 1024 * 1024 + 1);
    assert.strictEqual(normal.append({ phase: 'decision', tool: 'screen_shot' }).ok, true);
    assert.strictEqual(fs.statSync(normal.file() + '.1').size, 10 * 1024 * 1024 + 1);
  });

  test('filesystem failure is fail-soft and never throws', () => {
    const blocked = path.join(root, 'not-a-directory');
    fs.writeFileSync(blocked, 'file');
    const broken = createActionAudit({ dir: blocked, randomId: () => 'broken' });
    assert.deepStrictEqual(broken.append({ phase: 'decision', tool: 'click' }), { ok: false, error: 'audit-write-failed' });
    assert.deepStrictEqual(broken.readRecent(10), []);
  });

  console.log('\n通过 ' + passed + ' / ' + total);
  if (passed !== total) process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
