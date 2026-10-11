const assert = require('assert');
const input = require('../src/input');

let pass = 0;
function test(name, fn) {
  fn();
  pass++;
  console.log('  ✅ ' + name);
}

console.log('Key sequence contract');

test('calculator expression becomes validated virtual-key chords', () => {
  assert.deepStrictEqual(
    input.parseKeySequence('1,0,0,multiply,1,9,9,enter'),
    ['1', '0', '0', 'shift+8', '1', '9', '9', 'enter'],
  );
});

test('single chord remains backward compatible', () => {
  assert.deepStrictEqual(input.parseKeySequence('ctrl+f'), ['ctrl+f']);
});

test('empty sequence members are rejected before any input can run', () => {
  assert.throws(() => input.parseKeySequence('1,,2'), /空按键|写错/);
});

test('sequence length is bounded', () => {
  assert.throws(() => input.parseKeySequence(Array(66).fill('1').join(',')), /过长/);
});

console.log('\n通过 ' + pass + ' / ' + pass);
