'use strict';

const POINTER_TOOLS = Object.freeze([
  'click', 'rclick', 'dclick', 'drag', 'clickz', 'rclickz', 'dclickz',
]);
const KEYBOARD_TOOLS = Object.freeze(['type', 'key']);
const DELETE_TOOLS = Object.freeze(['proj_rm', 'skill_rm', 'template_del', 'flow_del', 'tag_rm']);
/* shell.openPath 会按系统关联直接启动 .exe/.bat/.vbs/.hta，安全语义等同本地执行。 */
const EXECUTE_TOOLS = Object.freeze(['run_file', 'proj_run', 'open_path']);
const WEB_MUTATION_TOOLS = Object.freeze(['web_click', 'web_type']);
const WRITE_TOOLS = Object.freeze(['write_file', 'proj_write', 'skill_write', 'flow_save']);

function normalizeAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return { ok: false, reason: 'invalid-action' };
  }
  if (typeof action.tool !== 'string') return { ok: false, reason: 'invalid-tool' };
  const tool = action.tool.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(tool)) return { ok: false, reason: 'invalid-tool' };
  if (action.arg != null && typeof action.arg !== 'string') {
    return { ok: false, reason: 'invalid-argument' };
  }
  return { ok: true, action: { tool, arg: action.arg == null ? '' : action.arg } };
}

function result(decision, reason, risk, requirements) {
  return { decision, reason, risk, requirements: requirements || [] };
}

function classifyAction(input) {
  const src = input || {};
  const normalized = normalizeAction({ tool: src.tool, arg: src.arg });
  if (!normalized.ok) return result('deny', normalized.reason, 'invalid');
  const tool = normalized.action.tool;
  const facts = src.facts || {};

  if (facts.toolAllowed !== true) return result('deny', 'permission-denied', 'forbidden');

  const isInput = POINTER_TOOLS.includes(tool) || KEYBOARD_TOOLS.includes(tool);
  if (isInput && facts.userActive === true) return result('deny', 'user-active', 'screen-input');

  if (DELETE_TOOLS.includes(tool)) return result('confirm', 'destructive-action', 'destructive', ['approval']);
  if (WRITE_TOOLS.includes(tool) && facts.destinationExists === true) {
    return result('confirm', 'overwrite-existing', 'local-write', ['approval']);
  }
  if (EXECUTE_TOOLS.includes(tool)) return result('confirm', 'execute-local-file', 'local-exec', ['approval']);
  if (WEB_MUTATION_TOOLS.includes(tool)) return result('confirm', 'external-side-effect', 'web-mutation', ['approval']);

  if (POINTER_TOOLS.includes(tool)) {
    if (facts.hasTargetGrant === true) return result('allow', 'verified-target', 'screen-input', ['target-grant']);
    return result('confirm', 'unverified-target', 'screen-input', ['approval']);
  }
  if (KEYBOARD_TOOLS.includes(tool)) {
    if (facts.focusVerified !== true) return result('deny', 'focus-not-verified', 'screen-input', ['verified-focus']);
    return result('allow', 'verified-focus', 'screen-input', ['verified-focus']);
  }

  const risk = WRITE_TOOLS.includes(tool) ? 'local-write' : 'read';
  return result('allow', 'tier-allowed', risk);
}

module.exports = {
  normalizeAction,
  classifyAction,
  POINTER_TOOLS,
  KEYBOARD_TOOLS,
  DELETE_TOOLS,
  EXECUTE_TOOLS,
  WEB_MUTATION_TOOLS,
};
