'use strict';

const TRUSTED_SOURCES = Object.freeze([
  'find_text',
  'find_template',
  'find_template_scroll',
  'uia_find',
]);

function withTarget(text, target) {
  if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw new TypeError('locator target requires finite x/y');
  }
  const source = String(target.source || '');
  if (!TRUSTED_SOURCES.includes(source)) throw new TypeError('untrusted locator source');
  const safeTarget = Object.freeze({
    x: Number(target.x),
    y: Number(target.y),
    source,
    label: String(target.label || ''),
  });
  return Object.freeze({ text: String(text || ''), target: safeTarget });
}

module.exports = { withTarget, TRUSTED_SOURCES };
