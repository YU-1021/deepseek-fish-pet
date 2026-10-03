'use strict';

const crypto = require('crypto');
const { normalizeAction } = require('./permission-policy');

const TARGET_SOURCES = Object.freeze(['find_text', 'find_template', 'find_template_scroll', 'uia_find']);
const CLICK_TOOLS = Object.freeze(['click', 'rclick', 'dclick', 'clickz', 'rclickz', 'dclickz']);

function createActionAuthority(options) {
  const opts = options || {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const randomBytes = typeof opts.randomBytes === 'function' ? opts.randomBytes : crypto.randomBytes;
  const targetTtlMs = Number(opts.targetTtlMs) > 0 ? Number(opts.targetTtlMs) : 120000;
  const approvalTtlMs = Number(opts.approvalTtlMs) > 0 ? Number(opts.approvalTtlMs) : 120000;
  const targets = [];
  const approvals = new Map();
  let targetSeq = 0;

  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

  function actionDigest(action) {
    const normalized = normalizeAction(action);
    if (!normalized.ok) return null;
    return digest(normalized.action.tool + '\0' + normalized.action.arg);
  }

  function issueTarget(input) {
    const value = input || {};
    const x = Number(value.x);
    const y = Number(value.y);
    const source = String(value.source || '');
    const userEpoch = Number(value.userEpoch);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'invalid-target' };
    if (!TARGET_SOURCES.includes(source)) return { ok: false, reason: 'untrusted-target-source' };
    if (!Number.isInteger(userEpoch) || userEpoch < 0) return { ok: false, reason: 'invalid-user-epoch' };
    const grant = {
      id: 'target-' + (++targetSeq),
      x, y, source,
      label: String(value.label || '').slice(0, 160),
      userEpoch,
      issuedAt: Number.isFinite(Number(value.issuedAt)) ? Number(value.issuedAt) : now(),
    };
    targets.push(grant);
    return { ok: true, grant: Object.assign({}, grant) };
  }

  function parsePoint(raw) {
    const m = String(raw == null ? '' : raw).match(/^\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return null;
    return { x: Number(m[1]), y: Number(m[2]) };
  }

  function parseDrag(raw) {
    const parts = String(raw == null ? '' : raw).split('|');
    if (parts.length !== 2) return null;
    const from = parsePoint(parts[0]);
    const to = parsePoint(parts[1]);
    return from && to ? [from, to] : null;
  }

  function inspectPoint(point, userEpoch, excludedIds) {
    let sawExpired = false;
    let sawEpochMismatch = false;
    for (const grant of targets) {
      if (excludedIds && excludedIds.has(grant.id)) continue;
      if (Math.abs(grant.x - point.x) > 2 || Math.abs(grant.y - point.y) > 2) continue;
      if (now() - grant.issuedAt > targetTtlMs) { sawExpired = true; continue; }
      if (grant.userEpoch !== userEpoch) { sawEpochMismatch = true; continue; }
      return { ok: true, grant };
    }
    if (sawEpochMismatch) return { ok: false, reason: 'user-took-over' };
    if (sawExpired) return { ok: false, reason: 'target-expired' };
    return { ok: false, reason: 'target-mismatch' };
  }

  function consumeIds(ids) {
    const set = new Set(ids);
    for (let i = targets.length - 1; i >= 0; i--) if (set.has(targets[i].id)) targets.splice(i, 1);
  }

  function inspectOrConsumeTarget(input, consume) {
    const value = input || {};
    const tool = String(value.tool || '').trim().toLowerCase();
    const userEpoch = Number(value.userEpoch);
    if (!Number.isInteger(userEpoch) || userEpoch < 0) return { ok: false, reason: 'invalid-user-epoch' };

    if (tool === 'drag') {
      const points = parseDrag(value.arg);
      if (!points) return { ok: false, reason: 'invalid-target-argument' };
      const first = inspectPoint(points[0], userEpoch);
      if (!first.ok) return first;
      const second = inspectPoint(points[1], userEpoch, new Set([first.grant.id]));
      if (!second.ok) return second;
      if (consume) consumeIds([first.grant.id, second.grant.id]);
      return { ok: true, grants: [Object.assign({}, first.grant), Object.assign({}, second.grant)] };
    }

    if (!CLICK_TOOLS.includes(tool)) return { ok: false, reason: 'invalid-target-tool' };
    const point = parsePoint(value.arg);
    if (!point) return { ok: false, reason: 'invalid-target-argument' };
    const found = inspectPoint(point, userEpoch);
    if (!found.ok) return found;
    if (consume) consumeIds([found.grant.id]);
    return { ok: true, grant: Object.assign({}, found.grant) };
  }

  function inspectTarget(input) { return inspectOrConsumeTarget(input, false); }
  function matchAndConsumeTarget(input) { return inspectOrConsumeTarget(input, true); }

  function invalidateTargets() {
    const count = targets.length;
    targets.length = 0;
    return count;
  }

  function issueApproval(action) {
    const actionHash = actionDigest(action);
    if (!actionHash) return { ok: false, reason: 'invalid-action' };
    const token = Buffer.from(randomBytes(32)).toString('hex');
    approvals.set(digest(token), { actionHash, issuedAt: now() });
    return { ok: true, token };
  }

  function consumeApproval(input) {
    const value = input || {};
    const token = typeof value.token === 'string' ? value.token : '';
    if (!token) return { ok: false, reason: 'approval-not-found' };
    const tokenHash = digest(token);
    const record = approvals.get(tokenHash);
    if (!record) return { ok: false, reason: 'approval-not-found' };
    if (now() - record.issuedAt > approvalTtlMs) {
      approvals.delete(tokenHash);
      return { ok: false, reason: 'approval-expired' };
    }
    const actionHash = actionDigest({ tool: value.tool, arg: value.arg });
    if (!actionHash || actionHash !== record.actionHash) return { ok: false, reason: 'approval-action-mismatch' };
    approvals.delete(tokenHash);
    return { ok: true };
  }

  function stats() {
    return { targets: targets.length, approvals: approvals.size };
  }

  return {
    issueTarget,
    inspectTarget,
    matchAndConsumeTarget,
    invalidateTargets,
    issueApproval,
    consumeApproval,
    stats,
  };
}

module.exports = { createActionAuthority, TARGET_SOURCES };

