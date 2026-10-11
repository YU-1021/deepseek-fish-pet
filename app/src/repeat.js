/* 重复调用提醒（repeat-tool-reminder）—— 抄自 DSH 的 dsh-repeat-tool-reminder
 *
 * 【为什么要换成它的算法】
 *   我们原来的做法（assistant.js 的 noProgressWarning）有三个问题：
 *     ① 判定键是 `slice(0,160)` 的字符串指纹 —— 参数顺序一变、多一个空格就算"不同动作"，
 *        而同一动作换个措辞又可能被误判成"重复"；
 *     ② 阈值固定 3 次，且**直接阻止执行** —— 她辛辛苦苦想出的一步被吞掉，体验很差；
 *     ③ 没有"真用户说话就重置"的概念 —— 主人插一句新要求，计数还接着算。
 *
 * 【DSH 的做法（dsh-repeat-tool-reminder/lib/index.js）】
 *   · :1557 判定键 = `[exec.name, canonicalize(args)]`；
 *   · :1481 参数做**深度排序**（key 排序 → 同样的参数不管书写顺序都算同一个动作）；
 *   · :1448 阈值 `[3,5,8]`，**首次温和、其后详细**；
 *   · :1577 挂在 tools/post-execute，**只往结果里前置 additionalContexts** ——
 *     **从不否决调用**（在工具调用框架里，否决会让"已经发出的调用"和会话状态对不上）；
 *   · :1592 **真用户消息一到就重置**计数；
 *   · :1541 未登记的工具是「透明」的：不计数、也不清零。
 *
 * 【本模块的取舍】
 *   · 默认**只提醒不阻止**（跟随 DSH）；但保留一条**安全阀**：同一动作累计到 `blockAt`
 *     （默认 8，正好是 DSH 阈值的最后一档）时返回 block —— 因为我们这边工具预算有限，
 *     而 DSH 那边没有步数预算这回事。
 *   · 判定纯逻辑、可以用假时钟测，因此能纯 Node 跑。
 */
'use strict';

const DEFAULTS = {
  thresholds: [3, 5, 8],   // 第 3/5/8 次时各提醒一次（对应 DSH 的 [3,5,8]）
  blockAt: 8,              // 安全阀：到这一档就真的不让执行了（0 = 永不阻止，纯提醒）
  window: 60,              // 只保留最近这么多条记录
};

/* 深度排序后再序列化：{a:1,b:2} 与 {b:2,a:1} 得到同一个键（照 DSH 的 canonicalize）
 * ⚠️ 值为 undefined 的键要**跳过**（而不是转成 null）—— JSON 序列化本来就丢 undefined，
 *    所以 {a:undefined} 必须等于 {}，否则"同一个动作"会因为一个没赋值的字段被判成两个。
 *    （§1 那条测试就是抓这个的。） */
function canonicalize(v) {
  if (v === undefined || v === null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}

function makeKey(tool, args) { return String(tool) + '|' + canonicalize(args); }

/* 创建一个计数器。registry 决定"哪些工具参与计数"：
 *   · 传 null/undefined → 所有工具都参与
 *   · 传 { include:[...] } → 只有列出的参与，其余**透明**
 *   · 传 { exclude:[...] } → 除了列出的都参与
 * 透明 = 不计数、也不影响已有计数（照 DSH :1541 的语义）。 */
function create(opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const registry = cfg.registry || null;
  const counts = new Map();

  function isTracked(tool) {
    const t = String(tool);
    if (!registry) return true;
    if (Array.isArray(registry.include)) return registry.include.indexOf(t) >= 0;
    if (Array.isArray(registry.exclude)) return registry.exclude.indexOf(t) < 0;
    return true;
  }

  /* 记一次调用，返回 { count, advice, block } */
  function note(tool, args) {
    if (!isTracked(tool)) return { count: 0, advice: '', block: false, transparent: true };
    const key = makeKey(tool, args);
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (counts.size > cfg.window) {
      /* 简单的滑窗：超了就把最早的丢掉（Map 保持插入顺序） */
      const first = counts.keys().next();
      if (!first.done) counts.delete(first.value);
    }
    const idx = cfg.thresholds.indexOf(n);
    let advice = '';
    if (idx === 0) {
      advice = '（这已经是你第 ' + n + ' 次用同样的参数做同样的动作了。如果结果没变化，说明这条路走不通 —— 换一种做法，别在原地重复。）';
    } else if (idx > 0) {
      advice = '（**第 ' + n + ' 次**同样的动作、同样的参数了。**再做一次不会有新结果**：'
        + '要么换个坐标/换种工具/退回上一层，要么如实上报卡在哪一步、需要主人做什么。）';
    }
    const block = cfg.blockAt > 0 && n >= cfg.blockAt;
    if (block) {
      advice = '⚠️ **同一个动作已经重复 ' + n + ' 次，这次不再执行**（避免把预算烧在空转上）。'
        + '请换一种完全不同的办法，或者如实上报卡在哪一步。';
    }
    return { count: n, advice, block, transparent: false };
  }

  /* 真用户消息到达 → 全部重置（照 DSH :1592） */
  function reset() { counts.clear(); }

  return {
    note, reset,
    count: (tool, args) => counts.get(makeKey(tool, args)) || 0,
    size: () => counts.size,
    config: cfg,
  };
}

module.exports = { create, canonicalize, makeKey, DEFAULTS };
