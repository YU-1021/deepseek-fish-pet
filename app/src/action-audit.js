'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const FILE_NAME = 'assistant-audit.v1.jsonl';
const PATH_TOOLS = new Set(['read_file', 'write_file', 'run_file', 'open_path', 'list_dir']);

function createActionAudit(options) {
  const opts = options || {};
  const dir = String(opts.dir || '');
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const randomId = typeof opts.randomId === 'function'
    ? opts.randomId
    : () => crypto.randomBytes(12).toString('hex');
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;
  const filePath = path.join(dir, FILE_NAME);

  const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

  function summarizeAction(action) {
    if (!action || typeof action !== 'object') return null;
    const tool = String(action.tool || '').trim().toLowerCase();
    const arg = typeof action.arg === 'string' ? action.arg : '';
    const summary = { tool, argLength: arg.length, argSha256: sha256(arg) };
    if (PATH_TOOLS.has(tool)) {
      const rawPath = tool === 'write_file' ? arg.split('||')[0] : arg;
      if (rawPath) summary.path = path.win32.normalize(rawPath.trim());
    }
    return summary;
  }

  function rotateIfNeeded() {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return; }
    if (stat.size < maxBytes) return;
    const previous = filePath + '.1';
    try { fs.unlinkSync(previous); } catch {}
    fs.renameSync(filePath, previous);
  }

  function append(event) {
    const value = event || {};
    try {
      fs.mkdirSync(dir, { recursive: true });
      rotateIfNeeded();
      const row = {
        version: 1,
        id: String(value.id || randomId()).slice(0, 160),
        time: now(),
        phase: String(value.phase || 'decision').slice(0, 40),
      };
      for (const key of ['tool', 'tier', 'risk', 'decision', 'reason', 'targetSource', 'errorCode']) {
        if (value[key] != null && value[key] !== '') row[key] = String(value[key]).slice(0, 160);
      }
      if (Number.isFinite(Number(value.durationMs))) row.durationMs = Math.max(0, Math.round(Number(value.durationMs)));
      if (typeof value.ok === 'boolean') row.ok = value.ok;
      const action = summarizeAction(value.action);
      if (action) {
        row.action = action;
        if (!row.tool && action.tool) row.tool = action.tool;
      }
      fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
      return { ok: true, id: row.id };
    } catch {
      return { ok: false, error: 'audit-write-failed' };
    }
  }

  function readRecent(limit) {
    try {
      const rows = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
      const parsed = [];
      for (const line of rows) {
        try {
          const value = JSON.parse(line);
          if (value && typeof value === 'object') parsed.push(value);
        } catch {}
      }
      return parsed.slice(-Math.max(0, Number(limit) || 50));
    } catch { return []; }
  }

  return {
    append,
    summarizeAction,
    file: () => filePath,
    readRecent,
  };
}

module.exports = { createActionAudit, DEFAULT_MAX_BYTES, FILE_NAME };
