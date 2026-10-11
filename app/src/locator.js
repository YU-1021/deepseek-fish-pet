/* locator.js —— 定位器链 + 缓存
 *
 * ============================ 为什么必须有它 ============================
 * 实测事故（2026-10-03）：目标找不到时，她（和我）会【换一个坐标再点一次】✗ ——
 * 同一天里同一个按钮试三四个坐标、滚十几次列表，全是这个模式。
 * 正确做法：**失败要换【定位器】，不是换坐标**：
 *   模板不行 → 换 OCR；OCR 不行 → 换几何；几何不行 → 换 UIA；都不行 → 显式失败（说清卡在哪）。
 *
 * 而且：**成功一次就该记住**（第二次走缓存，零成本零风险）——
 * 实测同一个界面反复出现，每次都从头识别是纯浪费。
 *
 * ============================ 设计 ============================
 * · 本模块只负责【调度】：按可靠性排序依次调用各定位器，第一个成功且置信度达标的就用
 * · 各定位器用依赖注入传进来（便于单测，也不把本模块绑死在 electron/键鼠上）
 * · 缓存也用注入的 store（get/set/del），不直接碰文件系统
 * · 纯逻辑部分（排序 / 置信度判定 / 缓存键 / 记录与失效）全部可单测
 */
'use strict';

/* 默认可靠性顺序（来自调研：缓存最前、UIA 在 OCR 之前、SoM 在裸坐标之前） */
const DEFAULT_ORDER = ['cache', 'uia', 'template', 'text', 'geometry', 'som', 'coord'];

/* 各定位器的默认最低置信度 —— 低于它就不认，继续往下降级 */
const DEFAULT_MIN_CONF = {
  cache: 0.5, uia: 0.9, template: 0.75, text: 0.7, geometry: 0.6, som: 0.5, coord: 0.99,
};

function cacheKey(target) {
  if (!target) return '';
  if (target.key) return String(target.key);
  const win = target.window || '';
  const desc = String(target.desc || target.text || '').trim();
  return (win ? win + '::' : '') + desc;
}

function shouldAccept(name, result, opts) {
  const o = opts || {};
  if (!result || result.ok === false) return false;
  if (typeof result.x !== 'number' || typeof result.y !== 'number') return false;
  const conf = typeof result.confidence === 'number' ? result.confidence : 1;
  const min = (o.minConf && o.minConf[name] != null) ? o.minConf[name]
    : (DEFAULT_MIN_CONF[name] != null ? DEFAULT_MIN_CONF[name] : 0.5);
  return conf >= min;
}

function orderLocators(preferred, opts) {
  const o = opts || {};
  const base = DEFAULT_ORDER.slice();
  const list = (preferred && preferred.length) ? preferred.slice() : base;
  /* 允许把某些定位器禁用（比如"这次别用缓存"、"游戏里跳过 UIA"） */
  const skip = o.skip || [];
  const only = o.only || null;
  return list.filter((n) => skip.indexOf(n) < 0 && (!only || only.indexOf(n) >= 0));
}

function createLocator(opts) {
  const o = opts || {};
  const resolvers = o.resolvers || {};
  const store = o.store || null;
  const log = o.log || (() => {});
  const stats = { calls: 0, byLocator: {}, cacheHits: 0, failures: 0 };

  async function locate(target, ctx) {
    stats.calls++;
    const key = cacheKey(target);
    const order = orderLocators(o.order, Object.assign({}, ctx, o));
    const attempts = [];

    for (const name of order) {
      /* ① 缓存：先查 */
      if (name === 'cache') {
        if (!store || !key || (ctx && ctx.noCache)) { attempts.push({ name, ok: false, reason: 'no-store-or-disabled' }); continue; }
        let hit = null;
        try { hit = await store.get(key); } catch (e) { hit = null; }
        if (hit && typeof hit.x === 'number' && typeof hit.y === 'number') {
          stats.cacheHits++;
          stats.byLocator.cache = (stats.byLocator.cache || 0) + 1;
          return { ok: true, x: hit.x, y: hit.y, how: 'cache', confidence: 1, cached: true, attempts };
        }
        attempts.push({ name, ok: false, reason: 'miss' });
        continue;
      }
      /* ② 其余定位器 */
      const fn = resolvers[name];
      if (typeof fn !== 'function') { attempts.push({ name, ok: false, reason: 'not-configured' }); continue; }
      let r = null;
      try { r = await fn(target, ctx); } catch (e) { r = { ok: false, reason: 'threw: ' + ((e && e.message) || e) }; }
      if (shouldAccept(name, r, o)) {
        stats.byLocator[name] = (stats.byLocator[name] || 0) + 1;
        /* 成功那一次也要记进 attempts —— 否则"为什么最后用了它"这段解释是残缺的 */
        attempts.push({ name, ok: true, x: r.x, y: r.y, confidence: r.confidence == null ? 1 : r.confidence });
        log('[locator] ' + name + ' 命中 (' + r.x + ',' + r.y + ') conf=' + (r.confidence == null ? 1 : r.confidence));
        /* 不缓存 cache 自己；其余成功都写回（除 coord —— 裸坐标要人工确认过才值得记） */
        if (store && key && name !== 'coord' && !(ctx && ctx.noRemember)) {
          try { await store.set(key, { x: r.x, y: r.y, how: name, at: Date.now() }); } catch (e) {}
        }
        return { ok: true, x: r.x, y: r.y, how: name, confidence: r.confidence == null ? 1 : r.confidence, extra: r.extra, attempts };
      }
      attempts.push({ name, ok: false, reason: (r && r.reason) || 'low-confidence', confidence: r && r.confidence });
    }
    stats.failures++;
    return { ok: false, reason: 'all-locators-failed', key, attempts,
      message: '所有定位器都没找到目标。**不要再换坐标重试** —— 要么换一个定位器（比如先 screen_look 裁小图确认，'
        + '或者先滚动/切窗口让目标进入视野），要么如实说"找不到"。' };
  }

  async function forget(key) { if (store) { try { await store.del(key); } catch (e) {} } }
  /* stats 做成【方法】返回副本：调用方拿到快照，改不到内部状态 */
  const statsSnapshot = () => Object.assign({}, stats, { byLocator: Object.assign({}, stats.byLocator) });
  return { locate, forget, stats: statsSnapshot, cacheKey };
}

module.exports = { createLocator, cacheKey, shouldAccept, orderLocators, DEFAULT_ORDER, DEFAULT_MIN_CONF };
