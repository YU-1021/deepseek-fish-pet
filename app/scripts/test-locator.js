/* locator.js 单元测试（全纯逻辑 + 注入假定位器）
 * 跑法：node app/scripts/test-locator.js */
const L = require('../src/locator');
let pass = 0, fail = 0;
function ok(c, l, e) { if (c) { pass++; console.log('  ✅ ' + l + (e ? '   ' + e : '')); } else { fail++; console.log('  ❌ ' + l + (e ? '   ' + e : '')); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== locator.js 单元测试 ===');

  /* §1 缓存键与顺序 */
  {
    ok(L.cacheKey({ window: 'A', desc: '确认' }) === 'A::确认', '§1 缓存键 = 窗口::描述', L.cacheKey({ window: 'A', desc: '确认' }));
    ok(L.cacheKey({ key: 'fixed-1' }) === 'fixed-1', '§1 显式 key 优先');
    ok(L.cacheKey(null) === '', '§1 空目标 → 空键');
    const ord = L.orderLocators(null, {});
    ok(ord[0] === 'cache' && ord[1] === 'uia' && ord.indexOf('uia') < ord.indexOf('text'), '§1 默认顺序：缓存在最前、UIA 在 OCR 之前');
    ok(L.orderLocators(null, { skip: ['uia'] }).indexOf('uia') < 0, '§1 skip 能禁用某个定位器（游戏里跳过 UIA）');
    ok(L.orderLocators(null, { only: ['text'] }).join() === 'text', '§1 only 能只留一个');
  }

  /* §2 置信度判定 */
  {
    ok(L.shouldAccept('uia', { ok: true, x: 1, y: 2, confidence: 0.95 }) === true, '§2 UIA 高置信 → 接受');
    ok(L.shouldAccept('uia', { ok: true, x: 1, y: 2, confidence: 0.5 }) === false, '§2 UIA 低置信 → 拒绝（继续降级）');
    ok(L.shouldAccept('template', { ok: true, x: 1, y: 2 }) === true, '§2 不写置信度默认 1 → 接受');
    ok(L.shouldAccept('text', { ok: false, reason: 'not-found' }) === false, '§2 ok=false → 拒绝');
    ok(L.shouldAccept('text', { ok: true, x: 'a', y: 2 }) === false, '§2 坐标不是数字 → 拒绝');
    ok(L.shouldAccept('som', { ok: true, x: 1, y: 2, confidence: 0.6 }, { minConf: { som: 0.9 } }) === false, '§2 minConf 可覆盖默认阈值');
  }

  /* §3 ★核心：失败要换【定位器】，不是换坐标★ */
  {
    const tried = [];
    const loc = L.createLocator({
      resolvers: {
        template: async () => { tried.push('template'); return { ok: false, reason: 'no-template' }; },
        text: async () => { tried.push('text'); return { ok: false, reason: 'ocr-miss' }; },
        geometry: async () => { tried.push('geometry'); return { ok: true, x: 111, y: 222, confidence: 0.8 }; },
      },
    });
    const r = await loc.locate({ window: 'W', desc: '确认' }, {});
    ok(r.ok === true && r.how === 'geometry' && r.x === 111, '§3 依次降级，几何定位器命中', JSON.stringify({ how: r.how, x: r.x }));
    ok(tried.join() === 'template,text,geometry', '§3 按顺序尝试过 模板→OCR→几何', tried.join(' → '));
    /* ⚠️ attempts 会包含【所有】阶段，包括没配的 cache/uia（reason=not-configured）——
       这是有意的：解释"为什么最后用了它"时要能看到完整链条。所以索引不是从 template 开始。 */
    const names = r.attempts.map((a) => a.name + (a.ok ? '✓' : '✗')).join(',');
    ok(r.attempts.length === 5 && names === 'cache✗,uia✗,template✗,text✗,geometry✓',
      '§3 记录完整链条：缓存缺→UIA 缺→模板失败→OCR 失败→几何成功', names);
    ok(r.attempts[4].ok === true && r.attempts[4].name === 'geometry', '§3 成功那一次也在链里（可解释"为什么最后用了它"）');
    ok(r.attempts[2].reason === 'no-template' && r.attempts[3].reason === 'ocr-miss', '§3 每次失败都记下原因', r.attempts[2].reason + ' / ' + r.attempts[3].reason);
  }

  /* §4 全部失败时的报错必须明确制止"换坐标重试" */
  {
    const loc = L.createLocator({ resolvers: { text: async () => ({ ok: false, reason: 'miss' }) } });
    const r = await loc.locate({ window: 'W', desc: 'X' }, {});
    ok(r.ok === false && r.reason === 'all-locators-failed', '§4 全失败 → all-locators-failed');
    ok(/不要再换坐标重试/.test(r.message), '§4 ★报错里明确写了"不要再换坐标重试"★', r.message.slice(0, 34));
  }

  /* §5 缓存：第二次同目标直接命中，且不再调定位器 */
  {
    const mem = new Map();
    const store = {
      get: async (k) => (mem.has(k) ? mem.get(k) : null),
      set: async (k, v) => { mem.set(k, v); },
      del: async (k) => { mem.delete(k); },
    };
    let calls = 0;
    const loc = L.createLocator({
      store,
      resolvers: { text: async () => { calls++; return { ok: true, x: 50, y: 60, confidence: 0.9 }; } },
    });
    const t = { window: 'W', desc: '确认' };
    const r1 = await loc.locate(t, {});
    const r2 = await loc.locate(t, {});
    ok(r1.ok && r1.how === 'text' && calls === 1, '§5 第一次走真实定位器');
    ok(r2.ok && r2.how === 'cache' && r2.cached === true, '§5 ★第二次直接命中缓存★', JSON.stringify({ how: r2.how, x: r2.x }));
    ok(calls === 1, '§5 缓存命中时没有再调定位器（零成本）');
    ok(loc.stats().cacheHits === 1, '§5 stats 记录了缓存命中次数');
    await loc.forget(L.cacheKey(t));
    const r3 = await loc.locate(t, {});
    ok(r3.how === 'text' && calls === 2, '§5 forget 之后重新走真实定位器');
  }

  /* §6 裸坐标不该被缓存（要人工确认过才值得记） */
  {
    const mem = new Map();
    const store = { get: async (k) => mem.get(k) || null, set: async (k, v) => { mem.set(k, v); }, del: async (k) => { mem.delete(k); } };
    const loc = L.createLocator({ store, resolvers: { coord: async () => ({ ok: true, x: 7, y: 8, confidence: 1 }) } });
    const t = { window: 'W', desc: '随便点的' };
    await loc.locate(t, { only: ['coord'] });
    ok(!mem.has(L.cacheKey(t)), '§6 ★裸坐标成功也不写缓存★（避免把"猜中的一次"固化下来）');
  }

  /* §7 定位器抛异常不该让整条链崩 */
  {
    const loc = L.createLocator({
      resolvers: {
        template: async () => { throw new Error('match.exe 挂了'); },
        text: async () => ({ ok: true, x: 9, y: 9, confidence: 0.9 }),
      },
    });
    const r = await loc.locate({ window: 'W', desc: 'Z' }, {});
    ok(r.ok && r.how === 'text', '§7 前一个定位器抛异常 → 继续降级（不崩）');
    const threw = r.attempts.find((a) => String(a.reason).indexOf('threw') >= 0);
    ok(!!threw, '§7 异常被记进 attempts', threw ? threw.reason.slice(0, 34) : '(没找到)');
  }

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
