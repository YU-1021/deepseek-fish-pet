'use strict';

const { normalizeAction, POINTER_TOOLS } = require('./permission-policy');

const LOCATOR_TOOLS = Object.freeze(['find_text', 'find_template', 'find_template_scroll', 'uia_find']);

function createActionExecutor(deps) {
  const d = deps || {};
  for (const name of ['allowed', 'classifyAction', 'getFacts', 'waitUntilFree', 'runTool', 'now']) {
    if (typeof d[name] !== 'function') throw new TypeError('action-executor missing dependency: ' + name);
  }
  if (!d.authority || !d.audit) throw new TypeError('action-executor requires authority and audit');

  function unpack(request) {
    if (request && typeof request === 'object' && request.action && typeof request.action === 'object') {
      return { action: request.action, approvalToken: typeof request.approvalToken === 'string' ? request.approvalToken : '' };
    }
    return { action: request, approvalToken: '' };
  }

  async function evaluate(action, context) {
    const normalized = normalizeAction(action);
    if (!normalized.ok) {
      return {
        action: null,
        facts: {},
        policy: { decision: 'deny', reason: normalized.reason, risk: 'invalid', requirements: [] },
      };
    }
    const value = normalized.action;
    const ctx = context || {};
    const facts = Object.assign({}, await d.getFacts(value, ctx));
    facts.toolAllowed = !!d.allowed(ctx.tier || 'off', value.tool);
    const userEpoch = Number.isInteger(facts.userEpoch) ? facts.userEpoch : 0;
    if (POINTER_TOOLS.includes(value.tool)) {
      const target = d.authority.inspectTarget({ tool: value.tool, arg: value.arg, userEpoch });
      facts.hasTargetGrant = !!target.ok;
      facts.targetSource = target.ok
        ? String((target.grant && target.grant.source) || (target.grants && target.grants[0] && target.grants[0].source) || '')
        : '';
    }
    return {
      action: value,
      facts,
      policy: d.classifyAction({ tier: ctx.tier || 'off', tool: value.tool, arg: value.arg, facts }),
    };
  }

  async function inspect(action, context) {
    const checked = await evaluate(action, context);
    return Object.assign({ ok: checked.policy.decision !== 'deny' }, checked.policy);
  }

  async function approve(action, context) {
    const checked = await evaluate(action, context);
    if (checked.policy.decision === 'deny') return Object.assign({ ok: false }, checked.policy);
    if (checked.policy.decision !== 'confirm') return Object.assign({ ok: true, notRequired: true }, checked.policy);
    const issued = d.authority.issueApproval(checked.action);
    if (!issued.ok) return { ok: false, decision: 'deny', reason: issued.reason, risk: checked.policy.risk };
    return Object.assign({ ok: true, token: issued.token }, checked.policy);
  }

  function appendAudit(event) {
    try { return d.audit.append(event) || { ok: false }; } catch { return { ok: false }; }
  }

  function denial(policy, extra) {
    return Object.assign({
      ok: false,
      denied: policy.decision === 'deny',
      needsConfirmation: policy.decision === 'confirm',
      decision: policy.decision,
      reason: policy.reason,
      risk: policy.risk,
    }, extra || {});
  }

  function recordTarget(tool, result, context) {
    if (!LOCATOR_TOOLS.includes(String(tool || ''))) return { ok: false, reason: 'not-a-locator' };
    if (!result || typeof result !== 'object' || !result.target) return { ok: false, reason: 'no-target' };
    const target = result.target;
    if (String(target.source || '') !== String(tool)) return { ok: false, reason: 'target-source-mismatch' };
    const ctx = context || {};
    return d.authority.issueTarget({
      x: target.x,
      y: target.y,
      source: target.source,
      label: target.label,
      userEpoch: Number.isInteger(ctx.userEpoch) ? ctx.userEpoch : 0,
      issuedAt: d.now(),
    });
  }

  async function execute(request, context) {
    const envelope = unpack(request);
    const ctx = context || {};
    let checked = await evaluate(envelope.action, ctx);
    const action = checked.action;
    const decisionEvent = {
      phase: 'decision',
      tool: action && action.tool,
      tier: ctx.tier || 'off',
      risk: checked.policy.risk,
      decision: checked.policy.decision,
      reason: checked.policy.reason,
      targetSource: checked.facts.targetSource,
      action,
    };
    const auditStart = appendAudit(decisionEvent);
    const actionId = auditStart.id || ('gateway-' + d.now());

    if (checked.policy.decision === 'deny') {
      appendAudit(Object.assign({}, decisionEvent, { id: actionId, phase: 'denied', ok: false }));
      return denial(checked.policy, { actionId });
    }

    if (checked.policy.risk === 'screen-input') {
      await d.waitUntilFree(30000, action, ctx);
      checked = await evaluate(action, ctx);
      if (checked.policy.decision === 'deny') {
        appendAudit(Object.assign({}, decisionEvent, {
          id: actionId, phase: 'denied', ok: false,
          reason: checked.policy.reason, decision: checked.policy.decision,
        }));
        return denial(checked.policy, { actionId });
      }
    }

    if (checked.policy.decision === 'confirm') {
      if (!envelope.approvalToken) {
        appendAudit(Object.assign({}, decisionEvent, { id: actionId, phase: 'denied', ok: false, reason: 'confirmation-required' }));
        return denial(checked.policy, { actionId });
      }
      const approved = d.authority.consumeApproval({
        token: envelope.approvalToken,
        tool: action.tool,
        arg: action.arg,
      });
      if (!approved.ok) {
        appendAudit(Object.assign({}, decisionEvent, { id: actionId, phase: 'denied', ok: false, reason: approved.reason }));
        return denial({ decision: 'deny', reason: approved.reason, risk: checked.policy.risk }, { actionId });
      }
      appendAudit(Object.assign({}, decisionEvent, { id: actionId, phase: 'approved', ok: true, reason: 'user-approved' }));
    } else if (POINTER_TOOLS.includes(action.tool)) {
      const target = d.authority.matchAndConsumeTarget({
        tool: action.tool,
        arg: action.arg,
        userEpoch: Number.isInteger(checked.facts.userEpoch) ? checked.facts.userEpoch : 0,
      });
      if (!target.ok) {
        appendAudit(Object.assign({}, decisionEvent, { id: actionId, phase: 'denied', ok: false, reason: target.reason }));
        return denial({ decision: 'deny', reason: target.reason, risk: checked.policy.risk }, { actionId });
      }
    }

    const startedAt = d.now();
    appendAudit(Object.assign({}, decisionEvent, { id: actionId, phase: 'started' }));
    try {
      const value = await d.runTool(action, ctx);
      const latestFacts = Object.assign({}, await d.getFacts(action, ctx));
      recordTarget(action.tool, value, { userEpoch: Number.isInteger(latestFacts.userEpoch) ? latestFacts.userEpoch : 0 });
      if (checked.policy.risk === 'screen-input') d.authority.invalidateTargets();
      appendAudit(Object.assign({}, decisionEvent, {
        id: actionId,
        phase: 'finished',
        durationMs: Math.max(0, d.now() - startedAt),
        ok: true,
      }));
      return { ok: true, value, decision: checked.policy.decision, reason: checked.policy.reason, risk: checked.policy.risk, actionId };
    } catch (error) {
      appendAudit(Object.assign({}, decisionEvent, {
        id: actionId,
        phase: 'failed',
        durationMs: Math.max(0, d.now() - startedAt),
        ok: false,
        errorCode: String((error && error.code) || (error && error.name) || 'tool-error'),
      }));
      throw error;
    }
  }

  return { inspect, approve, execute, recordTarget };
}

module.exports = { createActionExecutor, LOCATOR_TOOLS };

