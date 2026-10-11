/* 会话格式版本与迁移 —— 抄自 DSH 的 dsh-session-format
 *
 * 【为什么需要】用户的数据（对话草稿、记忆）是**最不能丢**的东西，而格式一定会变：
 *   加字段、改结构、修一个"当时图省事"的形状。没有版本号时，格式一变就是**静默读不回来**
 *   或者**读出半截** —— 而用户只会看到"桌宠失忆了"。
 *
 * 【DSH 的做法（dsh-session-format/lib/index.js）】
 *   · :96 迁移必须**相邻**：`toVersion === fromVersion + 1`（不允许"从 0 直接跳到 3"这种捷径）；
 *   · :124 启动时把 0..current 的**整条链编译出来**，**缺边直接抛错**（宁可启动就炸，也不要静默丢数据）；
 *   · :134 存储里的版本**比当前程序还新** → **拒绝加载**并提示升级（别用旧代码去猜新格式）；
 *   · :464 文件名带上代号 `session(.vN).jsonl`；
 *   · dsh-session-persistence-jsonl:2894 `truncateTornTail` —— 崩在写入中途时修掉半截尾行。
 *
 * 【桌宠现状】`session.json` 没有版本号；而且已经有一个**内联的临时迁移**：
 *   restore() 里就地修 `compact` 以 "EN:" 开头的旧草稿（那种形状看起来像正常回复，会把模型教坏）。
 *   这个模块就是把那个补丁**形式化**成 v0→v1，并建立以后能一直用的机制。
 */
'use strict';

const CURRENT = 2;

/* 迁移链：必须**相邻**（from 必须等于上一条的 to）。 */
const MIGRATIONS = [
  {
    from: 0, to: 1,
    /* v0 = 没有 version 字段的老形状 {id, startedAt, savedAt, messages}
       v1 = 加上 version 字段，并把当年那个内联补丁正式收进来：
            旧草稿的 compact 以 "EN:" 开头 → 看起来像正常回复、会把模型教坏 → 改成历史标记。 */
    up(d) {
      const out = Object.assign({}, d, { version: 1 });
      if (Array.isArray(out.messages)) {
        out.messages = out.messages.map((m) => {
          if (m && typeof m.compact === 'string' && /^EN\s*[:：]/.test(m.compact)) {
            return Object.assign({}, m, { compact: '(earlier reply, abridged) ' + m.compact.replace(/^EN\s*[:：]\s*/, '') });
          }
          return m;
        });
      }
      return out;
    },
  },
  {
    from: 1, to: 2,
    /* v1 = { messages: [{role, content|compact}] }  —— 直接存"模型看到的东西"
       v2 = { events: [{kind:'msg', role, content|compact}] } —— 存**只追加的事件日志**（真相），
            "模型看到什么"由 src/surface.js 的投影算出来。
       为什么换：v1 是就地保存的，一旦截断/改写就再也查不回原文；v2 只追加，投影可重算、可回放。
       （见 C5 的说明：把真相和投影分开。） */
    up(d) {
      /* ★ 防御：如果这个文件里**已经有 events**（说明它其实是 v2 的形状，只是版本号被写坏了 ——
         实测发生过：store 层多包了一层，把 session 的 version:2 覆盖成 1，于是这里按 v1 的约定
         去找 messages、找不到，**把 213 条 events 清成了空**）。有 events 就直接保留，绝不清空。 */
      if (Array.isArray(d.events) && !Array.isArray(d.messages)) {
        return { version: 2, id: d.id, startedAt: d.startedAt, savedAt: d.savedAt, events: d.events };
      }
      const events = (Array.isArray(d.messages) ? d.messages : []).map((m) => {
        const e = { kind: 'msg', role: (m && m.role) || 'user' };
        if (m && m.compact != null) e.compact = m.compact;
        else e.content = (m && m.content) != null ? m.content : '';
        return e;
      });
      return { version: 2, id: d.id, startedAt: d.startedAt, savedAt: d.savedAt, events };
    },
  },
];

/* 启动时自检：链子必须相邻且从 0 连到 CURRENT，否则**立刻抛错**（照 DSH :124）。
   宁可启动就炸，也不要静默丢用户的记忆。 */
function selfCheck() {
  let v = 0;
  for (const m of MIGRATIONS) {
    if (m.from !== v) throw new Error('会话迁移链断了：期望从版本 ' + v + ' 开始，却拿到 ' + m.from);
    if (m.to !== m.from + 1) throw new Error('会话迁移必须相邻：' + m.from + ' → ' + m.to);
    v = m.to;
  }
  if (v !== CURRENT) throw new Error('会话迁移链不完整：只连到版本 ' + v + '，而当前版本是 ' + CURRENT);
  return true;
}
selfCheck();

function detectVersion(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
  const v = Number(raw.version);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/* 把任意形状的数据迁移到当前版本。
 * 返回 { ok, data, from, error? }
 *   · ok:false 时**不要**用 data 覆盖磁盘（调用方应当保留原文件、把错误暴露出来） */
function migrate(raw) {
  if (raw == null) return { ok: true, data: null, from: 0, note: '空数据' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, from: 0, error: '会话数据不是对象（读到的是 ' + (Array.isArray(raw) ? '数组' : typeof raw) + '），拒绝加载以免覆盖成空' };
  }
  const from = detectVersion(raw);
  if (from > CURRENT) {
    /* 照 DSH :134：比程序还新的格式 → 拒绝加载，明确提示 */
    return { ok: false, from, error: '这个会话文件是**更新版本**的桌宠写的（文件版本 ' + from + '，本程序只到 ' + CURRENT + '）。'
      + '为避免把数据读坏，已拒绝加载 —— 请升级桌宠，或者把该文件备份后手动处理。' };
  }
  let cur = raw;
  let v = from;
  while (v < CURRENT) {
    const step = MIGRATIONS.find((m) => m.from === v);
    if (!step) return { ok: false, from, error: '缺少从版本 ' + v + ' 开始的迁移步骤（链子断了）' };
    try { cur = step.up(cur); } catch (e) { return { ok: false, from, error: '迁移 ' + step.from + '→' + step.to + ' 失败：' + ((e && e.message) || e) }; }
    v = step.to;
  }
  return { ok: true, data: cur, from, migrated: from !== CURRENT };
}

/* 写盘前包一层：保证带当前版本号 */
function wrap(data) {
  if (data == null) return null;
  return Object.assign({}, data, { version: CURRENT });
}

module.exports = { CURRENT, MIGRATIONS, migrate, wrap, detectVersion, selfCheck };
