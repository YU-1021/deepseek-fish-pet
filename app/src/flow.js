/* 确定性流程执行器（flow）—— "录制回放"里的"回放"那一半
 *
 * 【为什么要它（调研结论，有据）】
 *   对"每天做同样一套点击"这种**重复任务**，业界公认的最佳架构是
 *   **确定性回放为主 + LLM 只做异常兜底** —— Power Automate Desktop 的自愈链、
 *   browser-use/workflow-use、Skyvern 的 code caching，三家都是这个组织方式：
 *     命中所录步骤（模板 / UIA / OCR 断言）→ **不走 LLM**（毫秒级、确定、可审计）
 *     找不到目标 / 断言失败重试 N 次 / 从没见过的界面 → **才调 LLM**
 *     LLM 兜底成功后 → **回写成确定性步骤**（越用越快）
 *   我们原来的做法是"每一步都问模型" ✗ —— 于是慢（1~3 秒/步）、坐标飘（±20~120px）、会打转。
 *
 * 【设计：依赖注入，不 require 具体实现】
 *   这个模块**故意不 require** input / matcher / screenstream ——
 *   它们由调用方注入。好处：
 *     ① 可以用**假的依赖**做纯 Node 单元测试（不需要 Electron、不需要屏幕）——
 *        这是它能在 CI/命令行里被验证的前提；
 *     ② 不会和 assistant.js（975 行的热点）互相 require 造成循环依赖；
 *     ③ 换实现（比如以后把模板匹配换成 UIAutomation）不用动这里。
 *   依赖形状：
 *     deps = {
 *       click(x,y), rclick(x,y), move(x,y), key(name), type(text), scroll(x,y,dir),
 *       capture() -> { dataUrl, width, height },        // 抓当前帧（不画网格、不画光标）
 *       findTemplate(name, dataUrl, roi) -> { ok, x, y, score } | { ok:false, low:true },
 *       findText(text, dataUrl) -> { ok, x, y } | { ok:false },
 *       log(msg),                                       // 可选
 *     }
 *
 * 【步骤格式】一个流程 = { name, steps: [...] }，每步：
 *   {
 *     action: 'click' | 'rclick' | 'move' | 'key' | 'type' | 'scroll' | 'wait',
 *     arg:    '随便什么'                       // key/type/scroll 的参数
 *     target: { template:'名字', roi?:[x,y,w,h] } | { text:'文字' } | { xy:[x,y] },
 *     wait:   { ms:1500 } | { template:'X', timeout:8000 } | { change:true, timeout:8000 },
 *     assert: { template:'X' } | { text:'文字' } | { change:true, timeout:3000 },
 *     note:   '人看的说明'
 *   }
 *
 * 【失败链】每一步失败时（找不到目标 / 断言没过）：
 *   重试 onFail.retry 次（默认 1）→ 仍失败则**中止流程并如实报告卡在哪一步**，
 *   并把 onFail.llm（默认 true）标出来 —— 由上层决定是否交回 LLM 兜底。
 *   **绝不"假装成功"继续往下走** —— 那是今天最难查的一类 bug。
 */
'use strict';

const DEFAULT_WAIT_MS = 1200;
const DEFAULT_ASSERT_TIMEOUT = 3000;

/* 认识的动作。**先校验动作名，再解析目标** ——
   实测（§7）如果不先校验，一个拼错的动作名会被"这一步没有 target"抢先报出来，
   错误信息就把人引到错的方向去了（以为缺坐标，其实是动作名不认识）。 */
const KNOWN_ACTIONS = ['click', 'rclick', 'move', 'key', 'type', 'scroll', 'wait'];
const NEEDS_TARGET = ['click', 'rclick', 'move', 'scroll'];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 把 target 解析成屏幕坐标 */
async function resolveTarget(deps, target, log) {
  if (!target) return { ok: false, error: '这一步没有 target（不知道要点哪里）' };
  if (Array.isArray(target.xy)) {
    const [x, y] = target.xy;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'xy 不是数字' };
    return { ok: true, x: Math.round(x), y: Math.round(y), how: 'xy' };
  }
  if (target.template) {
    const cap = await deps.capture();
    if (!cap || !cap.dataUrl) return { ok: false, error: '抓帧失败' };
    const r = await deps.findTemplate(target.template, cap.dataUrl, target.roi);
    if (r && r.ok) return { ok: true, x: r.x, y: r.y, score: r.score, scale: r.scale, how: 'template:' + target.template };
    return { ok: false, error: '模板「' + target.template + '」没找到' + (r && r.score != null ? '（最高分 ' + Number(r.score).toFixed(3) + '）' : ''), low: true };
  }
  if (target.text) {
    const cap = await deps.capture();
    if (!cap || !cap.dataUrl) return { ok: false, error: '抓帧失败' };
    const r = await deps.findText(target.text, cap.dataUrl);
    if (r && r.ok) return { ok: true, x: r.x, y: r.y, how: 'text:' + target.text };
    return { ok: false, error: '文字「' + target.text + '」没找到', low: true };
  }
  return { ok: false, error: 'target 既没有 xy / template / text' };
}

/* 等一个条件成立 */
async function waitFor(deps, wait, log) {
  if (!wait) { await sleep(DEFAULT_WAIT_MS); return true; }
  if (typeof wait.ms === 'number') { await sleep(wait.ms); return true; }
  const timeout = Number(wait.timeout) || 8000;
  const t0 = Date.now();
  let first = null;
  while (Date.now() - t0 < timeout) {
    const cap = await deps.capture();
    if (cap && cap.dataUrl) {
      if (wait.template) {
        const r = await deps.findTemplate(wait.template, cap.dataUrl, wait.roi);
        if (r && r.ok) return true;
      } else if (wait.text) {
        const r = await deps.findText(wait.text, cap.dataUrl);
        if (r && r.ok) return true;
      } else if (wait.change) {
        if (first == null) first = cap.dataUrl;
        else if (cap.dataUrl !== first) return true;
      } else return true;
    }
    await sleep(250);
  }
  return false;
}

/* 断言（比 wait 短，而且失败要算"这一步没生效"） */
async function checkAssert(deps, assert, log) {
  if (!assert) return { ok: true };
  const timeout = Number(assert.timeout) || DEFAULT_ASSERT_TIMEOUT;
  const t0 = Date.now();
  let first = null;
  while (Date.now() - t0 < timeout) {
    const cap = await deps.capture();
    if (cap && cap.dataUrl) {
      if (assert.template) {
        const r = await deps.findTemplate(assert.template, cap.dataUrl, assert.roi);
        if (r && r.ok) return { ok: true };
      } else if (assert.text) {
        const r = await deps.findText(assert.text, cap.dataUrl);
        if (r && r.ok) return { ok: true };
      } else if (assert.change) {
        if (first == null) first = cap.dataUrl;
        else if (cap.dataUrl !== first) return { ok: true };
      } else return { ok: true };
    }
    await sleep(250);
  }
  return { ok: false, error: '断言没通过（' + (assert.template ? '模板「' + assert.template + '」没出现' : assert.text ? '文字「' + assert.text + '」没出现' : '画面没有变化') + '）' };
}

/* 执行一个动作 */
async function doAction(deps, step, pt) {
  const a = step.action;
  if (a === 'wait') return { ok: true };
  if (a === 'click' || a === 'rclick' || a === 'move') {
    if (!pt) return { ok: false, error: '要点击但没有解析出坐标' };
    if (a === 'click') await deps.click(pt.x, pt.y);
    else if (a === 'rclick') await deps.rclick(pt.x, pt.y);
    else await deps.move(pt.x, pt.y);
    return { ok: true };
  }
  if (a === 'key') { await deps.key(step.arg || ''); return { ok: true }; }
  if (a === 'type') { await deps.type(step.arg || ''); return { ok: true }; }
  if (a === 'scroll') {
    if (!pt) return { ok: false, error: '要滚动但没有解析出坐标' };
    await deps.scroll(pt.x, pt.y, step.arg || 'down');
    return { ok: true };
  }
  return { ok: false, error: '不认识的动作：' + a };
}

/* 跑一个流程。返回 { ok, steps:[...], failedAt, error } */
async function runFlow(deps, flow, opts) {
  const log = (deps && deps.log) || (() => {});
  const options = opts || {};
  const steps = (flow && flow.steps) || [];
  const report = { ok: true, name: (flow && flow.name) || '(未命名)', steps: [], failedAt: -1, error: '', needLlm: false };
  if (!steps.length) { report.ok = false; report.error = '这个流程是空的'; return report; }

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i] || {};
    const retryMax = (st.onFail && Number(st.onFail.retry)) || 1;
    const rec = { i: i + 1, action: st.action, note: st.note || '', tries: 0, ok: false, error: '', target: null };
    let lastErr = '';
    for (let attempt = 0; attempt <= retryMax; attempt++) {
      rec.tries = attempt + 1;
      try {
        /* ① 先校验动作名（见 KNOWN_ACTIONS 的注释：不先校验会把错误引偏） */
        if (KNOWN_ACTIONS.indexOf(st.action) < 0) {
          lastErr = '不认识的动作：' + st.action + '（可用：' + KNOWN_ACTIONS.join(' / ') + '）';
        } else {
        const pt = NEEDS_TARGET.indexOf(st.action) < 0 ? null : await resolveTarget(deps, st.target, log);
        if (pt && !pt.ok) { lastErr = pt.error; rec.target = pt; }
        else {
          if (pt) rec.target = pt;
          const act = await doAction(deps, st, pt);
          if (!act.ok) lastErr = act.error;
          else {
            await waitFor(deps, st.wait, log);
            const as = await checkAssert(deps, st.assert, log);
            if (as.ok) { rec.ok = true; lastErr = ''; break; }
            lastErr = as.error;
          }
        }
        }
      } catch (e) { lastErr = '执行出错：' + ((e && e.message) || e); }
      if (attempt < retryMax) { log('第 ' + (i + 1) + ' 步第 ' + (attempt + 1) + ' 次失败（' + lastErr + '），重试'); await sleep(600); }
    }
    rec.error = lastErr;
    report.steps.push(rec);
    log('第 ' + (i + 1) + ' 步 ' + (rec.ok ? '✅ ' : '❌ ') + (st.action || '?') + (rec.note ? '（' + rec.note + '）' : '') + (rec.ok ? '' : ' → ' + lastErr));
    if (!rec.ok) {
      report.ok = false;
      report.failedAt = i + 1;
      report.error = '卡在第 ' + (i + 1) + ' 步：' + lastErr;
      /* 调研里的失败链：重试 → **LLM 兜底** → 报错。这里只标出"可以交回 LLM"，
         由上层决定怎么兜（上层有对话、有更多信息），本级不假装成功继续走。 */
      report.needLlm = !(st.onFail && st.onFail.llm === false);
      return report;
    }
  }
  return report;
}

/* 把执行报告压成一段给模型/用户看的话（回执别太长 —— 这也是 DSH 的 spill 思路） */
function summarize(report) {
  const lines = report.steps.map((r) => '  ' + (r.ok ? '✅' : '❌') + ' 第' + r.i + '步 ' + r.action + (r.note ? '（' + r.note + '）' : '') + (r.ok ? '' : ' → ' + r.error));
  /* ⚠️ report.error 本身已经写成"卡在第 N 步：…"，所以这里**不要再加一遍前缀** ——
     第一版直接拼，结果回执成了「卡在第 1 步：卡在第 1 步：…」（实测看到才发现）。 */
  let head = '流程「' + report.name + '」' + (report.ok ? '全部跑完 ✅（' + report.steps.length + ' 步）' : '❌ ' + report.error);
  if (!report.ok && report.needLlm) head += '\n（这一步可以交回我兜底：我来看看现在的屏幕、想办法点中它，成功后把这一步写回流程。）';
  return head + '\n' + lines.join('\n');
}

module.exports = { runFlow, summarize, resolveTarget, waitFor, checkAssert, DEFAULT_WAIT_MS, DEFAULT_ASSERT_TIMEOUT };
