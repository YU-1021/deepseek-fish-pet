'use strict';

const { withTarget } = require('../src/locator-result');

let pass = 0;
let fail = 0;
function ok(value, label, detail) {
  if (value) { pass++; console.log('  ✅ ' + label + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  ❌ ' + label + (detail ? '  ' + detail : '')); }
}

console.log('=== locator-result.js 单元测试 ===');

const text = '找到目标，可直接点击。';
const result = withTarget(text, { x: 120, y: 340, source: 'find_text', label: '确认' });
ok(result && result.text === text, '保留原来给模型看的文字');
ok(result && result.target && result.target.x === 120 && result.target.y === 340, '附带有限数值坐标');
ok(result.target.source === 'find_text' && result.target.label === '确认', '附带定位来源与标签');
ok(Object.isFrozen(result) && Object.isFrozen(result.target), '结果不可被后续代码偷偷改写');

for (const source of ['find_text', 'find_template', 'find_template_scroll', 'uia_find']) {
  const got = withTarget('ok', { x: 1, y: 2, source, label: source });
  ok(got.target.source === source, '接受可信定位来源 ' + source);
}

for (const bad of [
  { x: NaN, y: 2, source: 'find_text' },
  { x: 1, y: Infinity, source: 'find_text' },
  { x: 1, y: 2, source: 'screen_look' },
  null,
]) {
  let threw = false;
  try { withTarget('bad', bad); } catch (error) { threw = error instanceof TypeError; }
  ok(threw, '拒绝无效或不可信目标 ' + JSON.stringify(bad));
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
