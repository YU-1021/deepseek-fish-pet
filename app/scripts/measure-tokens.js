/* 临时测量脚本：用应用**自己的代码**实测提示词各部分的 token 占用。
 * 用法（不要带 ELECTRON_RUN_AS_NODE）：
 *   electron.exe app\scripts\measure-tokens.js > report.json
 * 只读，不写任何记忆数据（job 用 stub llm，不会落盘）。
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

app.setPath('userData', path.join(process.env.APPDATA, 'dayu-pet'));

function jlog(o) { process.stdout.write(JSON.stringify(o, null, 1) + '\n'); }

app.whenReady().then(async () => {
  const R = { error: null };
  try {
    const config = require('../src/config');
    const persona = require('../src/persona');
    const mood = require('../src/mood');
    const stats = require('../src/stats');
    const skills = require('../src/skills');
    const memory = require('../src/memory');
    const llm = require('../src/llm');
    const tokens = require('../src/tokens');
    const assistant = require('../src/assistant');
    const jobs = memory.jobs;

    const cfg = config.load();
    memory.init({ llm, config, persona, skillCatalog: () => skills.catalog() });
    try { memory.session.restore(); } catch (e) { R.restoreErr = String((e && e.message) || e); }

    /* --- 从 main.js 抠出 buildSystemPrompt（函数以行首 '}' 结束） --- */
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const start = src.indexOf('function buildSystemPrompt(cfg)');
    const end = src.indexOf('\n}\n', start);
    const fnSrc = src.slice(start, end + 2);
    const VOCAB = {
      high_school: 'high-school level (simple, common words)',
      cet4: 'CET-4 level',
      cet6: 'CET-6 level',
    };
    const buildSystemPrompt = new Function(
      'loadPersona', 'mood', 'stats', 'skills', 'memory', 'VOCAB', 'assistant', 'personatags',
      fnSrc + '\nreturn buildSystemPrompt;'
    )(() => persona.load(), mood, stats, skills, memory, VOCAB, assistant, require('../src/personatags'));

    /* 多步任务用的续跑提示词（同样从 main.js 里抠） */
    const cStart = src.indexOf('function buildContinuePrompt(cfg)');
    const cEnd = src.indexOf('\n}\n', cStart);
    const buildContinuePrompt = new Function(
      'loadPersona', 'assistant',
      src.slice(cStart, cEnd + 2) + '\nreturn buildContinuePrompt;'
    )(() => persona.load(), assistant);

    /* 技能归档系统提示词（常量模板） */
    const aStart = src.indexOf('const ARCHIVE_SYS = `');
    const aEnd = src.indexOf('`;', aStart);
    const ARCHIVE_SYS = src.slice(aStart, aEnd + 2);

    const t = (s) => ({ chars: String(s == null ? '' : s).length, tokens: tokens.est(s) });

    /* --- 1. 系统提示词（各权限档） --- */
    R.systemPrompt = {};
    for (const tier of ['off', 'read', 'normal', 'web', 'full']) {
      const s = buildSystemPrompt({ ...cfg, assistant: tier });
      R.systemPrompt[tier] = { chars: s.length, tokens: tokens.est(s) };
    }
    R.systemPromptText = { offHead: buildSystemPrompt({ ...cfg, assistant: 'off' }).slice(0, 160) };

    /* 续跑提示词（多步任务每步都带） */
    R.continuePrompt = {};
    for (const tier of ['off', 'read', 'normal', 'web', 'full']) {
      const s = buildContinuePrompt({ ...cfg, assistant: tier });
      R.continuePrompt[tier] = { chars: s.length, tokens: tokens.est(s) };
    }
    R.archiveSys = { chars: ARCHIVE_SYS.length, tokens: tokens.est(ARCHIVE_SYS) };

    /* 前缀缓存断点：mood 每轮都变，提示词从这里往后全部算「未命中」 */
    R.cacheBreak = {};
    for (const tier of ['off', 'full']) {
      const s = buildSystemPrompt({ ...cfg, assistant: tier });
      const moodAt = s.indexOf('- Your current mood:');
      const affAt = s.indexOf('- Affection toward the user:');
      const statAt = s.indexOf('# 你的内在状态');
      R.cacheBreak[tier] = {
        totalChars: s.length,
        affectionLineAt: affAt,
        moodLineAt: moodAt,
        statSpecAt: statAt,
        cacheableChars: moodAt,
        cacheableTokens: tokens.est(s.slice(0, moodAt)),
        volatileTailTokens: tokens.est(s.slice(moodAt)),
      };
    }

    /* --- 2. 记忆上下文 / 技能目录 --- */
    R.memoryContext = Object.assign(t(memory.buildContext()), { head: memory.buildContext().slice(0, 120) });
    R.skillCatalog = Object.assign(t(skills.catalog()), { head: skills.catalog().slice(0, 120) });

    /* --- 3. 历史（真实会话按预算裁剪后） --- */
    const sess = memory.session.all();
    const hist = memory.pickHistory();
    R.sessionRaw = {
      messages: sess.length,
      chars: sess.reduce((n, m) => n + String(m.content || '').length, 0),
    };
    R.history = {
      messages: hist.length,
      chars: hist.reduce((n, m) => n + String(m.content || '').length, 0),
      tokensEst: tokens.estMessages(hist),
      budgetTokens: (cfg.memory || {}).historyTokens,
    };
    R.historyParts = hist.map((m) => ({ role: m.role, chars: String(m.content || '').length, tokens: tokens.est(m.content) }));

    /* 会话里助手回复的真实长度（推输出 token） */
    const asst = sess.filter((m) => m.role === 'assistant');
    const usr = sess.filter((m) => m.role === 'user');
    R.realLens = {
      assistantCount: asst.length,
      assistantAvgChars: asst.length ? Math.round(asst.reduce((n, m) => n + String(m.content || '').length, 0) / asst.length) : 0,
      assistantAvgTokens: asst.length ? Math.round(asst.reduce((n, m) => n + tokens.est(m.content), 0) / asst.length) : 0,
      userCount: usr.length,
      userAvgChars: usr.length ? Math.round(usr.reduce((n, m) => n + String(m.content || '').length, 0) / usr.length) : 0,
    };

    /* --- 4. 背景任务：用 stub llm 捕获真实提示词（不落盘） --- */
    const captured = [];
    const stub = {
      request: async (_c, messages) => {
        captured.push(messages.map((m) => ({ role: m.role, chars: String(m.content || '').length, tokens: tokens.est(m.content) })));
        return '';
      },
      stream: async () => '',
    };
    const msgs = sess.slice(0, 60);   // 一次典型会话的量
    const cat = skills.catalog();
    const curAll = Object.assign({}, mood.load(), stats.all());
    try { await jobs.summarize(stub, cfg, msgs); } catch (e) { R.jobErr1 = String(e.message); }
    try { await jobs.extractFacts(stub, cfg, msgs); } catch (e) { R.jobErr2 = String(e.message); }
    try { await jobs.extractExperiences(stub, cfg, msgs, cat); } catch (e) { R.jobErr3 = String(e.message); }
    try { await jobs.judgeStats(stub, cfg, msgs, persona.load(), curAll); } catch (e) { R.jobErr4 = String(e.message); }
    try { await jobs.diary(stub, cfg, persona.load(), '2026-09-30', ['聊了拖拽修复', '讲了 token 预算']); } catch (e) { R.jobErr5 = String(e.message); }
    try {
      await jobs.evolvePersona(stub, cfg, {
        persona: persona.load(), diary: '（示例日记）', facts: '（示例要点）',
        affection: curAll.affection, mood: curAll.mood, lockNote: '（无）',
      });
    } catch (e) { R.jobErr6 = String(e.message); }

    R.jobs = captured.map((ms, i) => ({
      idx: i,
      msgs: ms,
      totalChars: ms.reduce((n, m) => n + m.chars, 0),
      totalTokens: ms.reduce((n, m) => n + m.tokens, 0),
    }));

    R.convoForJobs = t(jobs.convoToText(msgs, 6000));

    /* --- 5. 静态常量 --- */
    R.consts = {
      historyTokens: (cfg.memory || {}).historyTokens,
      fullTurns: (cfg.memory || {}).fullTurns,
      toolResultChars: (cfg.memory || {}).toolResultChars,
      inject: (cfg.memory || {}).inject,
      model: cfg.model,
      assistantTier: cfg.assistant,
      visionEnabled: cfg.visionEnabled,
    };
  } catch (e) {
    R.error = String((e && e.stack) || e);
  }
  jlog(R);
  app.exit(0);
});
