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
  skillCandDays: 21,     // 技能经验候选多少天没出现开始衰减
  skillPoolMax: 200,     // 共有技能经验池最多留多少条（超了按权重低的淘汰）
  skillFileWeight: 4,    // 技能经验权重到多少就归档进技能文件夹
  skillArchiveMax: 2,    // 每次最多归档几条经验（防启动时一口气烧太多 token）
  skillArchiveCalls: 10, // 一次归档总共最多几次模型调用（硬上限）
  skillAutoArchive: true,// 启动时自动把攒够权重的经验归档进技能
  projRunTimeout: 60000,  // 执行脚本的超时（毫秒），到点强制结束
  screenWarm: true,      // 启动时预热屏幕流（首帧更快；不想让系统一直显示"正在捕获"就设 false）
  historyTokens: 3000,   // 历史按 token 预算保留（省 token：老回合本来就会压缩成 EN: 一行，砍短体感无损）
  fullTurns: 3,          // 最近几轮助手回复保留完整格式（格式锚）
  toolResultChars: 250,  // AI 助手执行结果入库时的截断长度（太长会把真实对话挤出历史）
  inject: {              // 每轮注入上下文的数量/长度
    permanentFacts: 20,
    longDays: 3,
    mediumCount: 4,
    longChars: 200,
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
  // 视觉模型（可选）：用于"看懂屏幕"，会花 token。默认关闭，关闭时退回本地 OCR（免费）。
  visionEnabled: false,
  visionBase: '',
  visionKey: '',
  visionModel: 'deepseek-flash',
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

