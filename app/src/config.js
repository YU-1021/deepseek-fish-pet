const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const file = () => path.join(app.getPath('userData'), 'config.json');

/* 记忆系统参数（全部可在 config.json 里覆盖，改参数不用改代码） */
const MEMORY_DEFAULTS = {
  mediumKeep: 20,        // 中期记忆保留条数
  longKeepDays: 20,      // 日记保留天数
  promoteWeight: 7,      // 权重达到多少就晋升为「永久记忆」
  candDays: 14,          // 候选多少天没再出现就开始衰减
  candDecay: 0.8,        // 衰减系数
  candFloor: 1,          // 权重低于此值从候选池清掉
  historyTokens: 6000,   // 历史按 token 预算保留（不是按条数）
  fullTurns: 3,          // 最近几轮助手回复保留完整格式（格式锚）
  toolResultChars: 500,  // AI 助手执行结果入库时的截断长度
  inject: {              // 每轮注入上下文的数量/长度
    permanentFacts: 40,
    longDays: 3,
    mediumCount: 6,
    longChars: 300,
    mediumChars: 200,
  },
};

const DEFAULTS = {
  apiBase: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  ttsEnabled: true,
  ttsVoice: '',
  ttsStyle: 'tsundere',
  ttsRate: 1.02,
  ttsPitch: 1.18,
  vocabLevel: 'high_school',
  assistant: 'off',
  asrEngine: 'auto',     // auto | whisper | webspeech
  asrModel: 'tiny.en',   // tiny.en | base.en | small.en
  memory: MEMORY_DEFAULTS,
};

const deepMerge = (base, over) => {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]))
      ? deepMerge(base[k], v) : v;
  }
  return out;
};

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^\uFEFF/, '')) || {}; } catch {}
  const merged = deepMerge(DEFAULTS, saved);
  merged.memory = deepMerge(MEMORY_DEFAULTS, saved.memory || {});   // 旧配置没有 memory 字段也能补齐
  merged.memory.inject = deepMerge(MEMORY_DEFAULTS.inject, (saved.memory && saved.memory.inject) || {});
  return merged;
}

function save(patch) {
  const next = deepMerge(load(), patch || {});
  try { fs.writeFileSync(file(), JSON.stringify(next, null, 2)); } catch {}
  return next;
}

module.exports = { load, save, DEFAULTS, MEMORY_DEFAULTS, file };

