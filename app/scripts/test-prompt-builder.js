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
    read: '189d6951de96c519bce82f0d140fc8ae4a76235a57c769ec8444acfa77ef1326',
    normal: '189d6951de96c519bce82f0d140fc8ae4a76235a57c769ec8444acfa77ef1326',
    web: 'c2a42efcf6805a5bcc0ba6fdf3631914294b3f9aa1fb4d21d08c28dd0570e10b',
    full: '65d4729b9982a31d2623167b5157a141ce4efe624633e2a327567bf904e9e2a4',
  },
  continuation: {
    off: '8e94f86bc44d7fd4116f8021488df2e2204ee73ff4b8060d9664d1561eeef009',
    read: '8e94f86bc44d7fd4116f8021488df2e2204ee73ff4b8060d9664d1561eeef009',
    normal: '8e94f86bc44d7fd4116f8021488df2e2204ee73ff4b8060d9664d1561eeef009',
    web: '2961371d643990e4d6034baf8aeb1e7282baa59da65fdab277be80198c3e5c7d',
    full: '4a0fa884e1b91de102bc3e8f2bdfefd04e6a8d77c24945bab4662d8717e5ca20',
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
  getScreenSpace: () => ({ w: 1920, h: 1080 }),
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

test('full prompt preserves latest deterministic vision tools', () => {
  const value = builder.buildSystemPrompt({ assistant: 'full', vocabLevel: 'cet4' });
  assert(value.includes('screen_diff|<秒数>'));
  assert(value.includes('uia_find|<窗口标题片段>|<控件名字或AutomationId>'));
  assert(value.includes('uia_dump|<窗口标题片段>'));
});

test('full continuation keeps deterministic desktop tools after the first action', () => {
  const value = builder.buildContinuePrompt({ assistant: 'full', vocabLevel: 'cet4' });
  assert(value.includes('screen_diff|<秒数>'));
  assert(value.includes('find_text|<文字>'));
  assert(value.includes('uia_find|<窗口标题片段>|<控件名字或AutomationId>'));
  assert(value.includes('uia_dump|<窗口标题片段>'));
});

test('continuation prefers verified keyboard entry over clicking an on-screen keyboard', () => {
  const value = builder.buildContinuePrompt({ assistant: 'full', vocabLevel: 'cet4' })
    + '\n' + builder.buildContinueUserPrompt();
  assert(value.includes('focus_window|<标题片段>'));
  assert(value.includes('普通文本框用 type'));
  assert(value.includes('计算器等只响应真实按键的应用用 key'));
  assert(value.includes('不要逐个定位和点击屏幕键盘'));
  assert(value.includes('OCR 必须限定在目标窗口'));
  assert(value.includes('key|<按键1,按键2,...>'));
  assert(value.includes('CalculatorResults'));
});

test('continuation requires fresh window evidence before claiming an app is absent', () => {
  const value = builder.buildContinuePrompt({ assistant: 'full', vocabLevel: 'cet4' })
    + '\n' + builder.buildContinueUserPrompt();
  assert(value.includes('本轮新的工具结果'));
  assert(value.includes('先调用 windows_list'));
  assert(value.includes('使用 windows_list 返回的真实标题'));
  assert(value.includes('screen_look 看不到某个窗口，不代表它没有打开'));
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

test('computer-action prompts use the configured screenshot coordinate space', () => {
  const custom = withDeps({ getScreenSpace: () => ({ w: 1600, h: 900 }) });
  for (const value of [
    custom.buildSystemPrompt({ assistant: 'full', vocabLevel: 'cet4' }),
    custom.buildContinuePrompt({ assistant: 'full', vocabLevel: 'cet4' }),
  ]) {
    assert(value.includes('1600x900'), 'prompt should name the configured screenshot space');
    assert(!value.includes('1280x720'), 'prompt must not advertise the retired 1280x720 space');
    assert(!value.includes('1920x1080'), 'prompt must not hard-code the default space');
  }
});

test('continue task instructions require verified targets instead of coordinate guessing', () => {
  const full = builder.buildSystemPrompt({ assistant: 'full', vocabLevel: 'cet4' });
  const value = full + '\n' + builder.buildContinuePrompt({ assistant: 'full', vocabLevel: 'cet4' })
    + '\n' + builder.buildContinueUserPrompt();
  assert(value.includes('find_text|<文字>'));
  assert(value.includes('find_template|<模板名>'));
  assert(value.includes('不要根据截图描述猜坐标'));
  assert(value.includes('图标没有现成模板'));
  assert(value.includes('不要自动点击'));
  assert(value.includes('执行后必须验证'));
  assert(full.includes('Never guess a coordinate from a screenshot'));
  assert(!value.includes('±30~60px'));
  assert(!value.includes('4~5 次'));
  assert(!value.includes('shift by about 30-50px'));
  assert(!value.includes('try ~30-60px around it'));
  assert(!value.includes('IMPORTANT - COORDINATE DRIFT'));
});

test('missing dependency error names the dependency', () => {
  const deps = Object.assign({}, baseDeps);
  delete deps.loadPersona;
  assert.throws(() => createPromptBuilder(deps), /loadPersona/);
});

console.log('\n通过 ' + pass + ' / ' + pass);
