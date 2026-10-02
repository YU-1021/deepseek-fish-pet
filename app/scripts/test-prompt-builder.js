const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');

let createPromptBuilder;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') throw new Error('prompt-builder must not load Electron');
  return originalLoad.call(this, request, parent, isMain);
};
try {
  ({ createPromptBuilder } = require('../src/prompt-builder'));
} finally {
  Module._load = originalLoad;
}

const TIERS = ['off', 'read', 'normal', 'web', 'full'];
const GOLDEN = {
  system: {
    off: '6b6705cbe18654f8b6e6e5da0ab0d1e976723851f0af65909116ebaba4083167',
    read: '1d20f99b82f0dab702f28ab8d5be45aa20b6140a2c9a6d0ef3b49a05230157b2',
    normal: '1d20f99b82f0dab702f28ab8d5be45aa20b6140a2c9a6d0ef3b49a05230157b2',
    web: '8537bae31a0300466d0f9498668de443c26ca29b6ed29ee532f4f4f709c98284',
    full: '92bc4e6dc9a6a00db5abfa3527ba7775652755cafc0f9e8348f8cf2be05a7ea6',
  },
  continuation: {
    off: '996158aa6c8e055ed237fdac940360dc897dccbd386818ff7174e8d88ecc67e7',
    read: '996158aa6c8e055ed237fdac940360dc897dccbd386818ff7174e8d88ecc67e7',
    normal: '996158aa6c8e055ed237fdac940360dc897dccbd386818ff7174e8d88ecc67e7',
    web: 'f7f9fe5beecd31668efdf75e98a59b7ba6f7bc85dc2a730090c4d45441b7c7ae',
    full: 'ac2d50e400703f1d667645bf691dbc9960b307f386cdede0c60c65f9b403ea3c',
  },
};

const persona = {
  name: 'Fixture Fish', world_setting: 'Fixture World', character_setting: 'Fixture Character',
  personality: 'Fixture Personality', catchphrase: 'Fixture Catchphrase', hidden_setting: 'Fixture Secret',
};
const practice = [
  { w: 'whale', ipa: '/weɪl/', zh: '鲸鱼', review: 2, good: 1 },
  { w: 'gentle', ipa: '', zh: '', review: 0, good: 0 },
];
const baseDeps = {
  loadPersona: () => persona,
  loadMood: () => ({ affection: 73, mood: 41 }),
  getTone: () => 'FIXTURE_TONE',
  getBehaviorSpec: () => 'FIXTURE_BEHAVIOR',
  buildMemoryContext: () => '\nFIXTURE_MEMORY\n',
  getPracticeWords: (limit) => limit === 8 ? practice : [],
  getSkillCatalog: () => 'fixture-skill — fixture description',
  isToolAllowed: (_tier, tool) => tool === 'proj_open',
  readPromptOverride: () => 'FIXTURE_OVERRIDE',
  log: () => {},
};
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const withDeps = (changes) => createPromptBuilder(Object.assign({}, baseDeps, changes || {}));
let pass = 0;
function test(name, fn) {
  fn();
  pass++;
  console.log('  ✅ ' + name);
}

console.log('Prompt Builder contract');
const builder = withDeps();

for (const tier of TIERS) {
  test('system prompt golden: ' + tier, () => {
    assert.strictEqual(sha(builder.buildSystemPrompt({ assistant: tier, vocabLevel: 'cet4' })), GOLDEN.system[tier]);
  });
  test('continue prompt golden: ' + tier, () => {
    assert.strictEqual(sha(builder.buildContinuePrompt({ assistant: tier, vocabLevel: 'cet4' })), GOLDEN.continuation[tier]);
  });
}

test('full prompt preserves section order and terminal override', () => {
  const value = builder.buildSystemPrompt({ assistant: 'full', vocabLevel: 'cet4' });
  const markers = [
    'FIXTURE_TONE', 'Fixture Secret', '# 主人正在练的词',
    '# Current relationship state', 'FIXTURE_BEHAVIOR', 'FIXTURE_MEMORY',
    '# Skills (load on demand)', '# Project folder', '# Computer actions (AI assistant)',
    '# Output format', '# 主人手写的补充规则', 'FIXTURE_OVERRIDE',
  ];
  let previous = -1;
  for (const marker of markers) {
    const index = value.indexOf(marker);
    assert(index > previous, marker + ' should appear after the previous section');
    previous = index;
  }
  assert(value.endsWith('FIXTURE_OVERRIDE\n'));
});

test('off omits assistant-only sections', () => {
  const value = builder.buildSystemPrompt({ assistant: 'off', vocabLevel: 'cet4' });
  assert(!value.includes('# Skills (load on demand)'));
  assert(!value.includes('# Project folder'));
  assert(!value.includes('# Computer actions (AI assistant)'));
});

test('empty vocabulary and skill catalog omit their sections', () => {
  const value = withDeps({ getPracticeWords: () => [], getSkillCatalog: () => '' })
    .buildSystemPrompt({ assistant: 'read', vocabLevel: 'cet4' });
  assert(!value.includes('# 主人正在练的词'));
  assert(!value.includes('# Skills (load on demand)'));
});

for (const [name, dep, marker] of [
  ['tone', 'getTone', '# 你的人格基调'],
  ['vocabulary', 'getPracticeWords', '# 主人正在练的词'],
  ['override', 'readPromptOverride', '# 主人手写的补充规则'],
]) {
  test(name + ' adapter failure is fail-soft', () => {
    const value = withDeps({ [dep]: () => { throw new Error(name + ' boom'); } })
      .buildSystemPrompt({ assistant: 'read', vocabLevel: 'cet4' });
    assert(!value.includes(marker));
    assert(value.includes('# Output format'));
  });
}

for (const [name, dep, tier] of [
  ['memory', 'buildMemoryContext', 'off'],
  ['behavior', 'getBehaviorSpec', 'off'],
  ['skills', 'getSkillCatalog', 'read'],
]) {
  test(name + ' adapter failure propagates', () => {
    const failing = withDeps({ [dep]: () => { throw new Error(name + ' boom'); } });
    assert.throws(() => failing.buildSystemPrompt({ assistant: tier, vocabLevel: 'cet4' }), new RegExp(name + ' boom'));
  });
}

test('unknown vocabulary level uses high-school fallback', () => {
  const value = builder.buildSystemPrompt({ assistant: 'off', vocabLevel: 'unknown' });
  assert(value.includes('- Vocabulary level: high-school level (simple, common words).'));
});

test('missing dependency error names the dependency', () => {
  const deps = Object.assign({}, baseDeps);
  delete deps.loadPersona;
  assert.throws(() => createPromptBuilder(deps), /loadPersona/);
});

console.log('\n通过 ' + pass + ' / ' + pass);
