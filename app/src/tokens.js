/* 粗略 token 估算（只用于"按预算裁剪历史"，不追求精确）
 * 中日韩字符 ≈ 1 token/字；其他（英文/符号）≈ 4 字符/token。
 * 单独成模块，方便后续所有系统共用同一套预算口径。
 */
const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F]/;

function est(text) {
  const s = text === null || text === undefined ? '' : String(text);
  let n = 0;
  for (let i = 0; i < s.length; i++) n += CJK.test(s[i]) ? 1 : 0.25;
  return Math.ceil(n) + 2;
}

function estMessages(list) {
  let n = 0;
  for (const m of list || []) n += est(m && m.content) + 4;
  return n;
}

function clip(text, maxChars) {
  const s = text === null || text === undefined ? '' : String(text);
  return s.length <= maxChars ? s : s.slice(0, maxChars) + '…';
}

module.exports = { est, estMessages, clip };
