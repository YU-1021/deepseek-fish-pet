/* flow.js 的单元测试 —— **纯 Node，不需要 Electron、不需要屏幕**
 *
 * 这是 flow.js 用"依赖注入"换来的最大好处：喂它一套**假的**键鼠/抓帧/找图实现，
 * 就能在命令行里把失败链（找不到目标 / 断言不过 / 重试 / 交回 LLM / 不假装成功）
 * 全部验证掉。真机上那些"点了没反应"的坑，在这里就能先暴露。
 *
 * 跑法：node app/scripts/test-flow.js
 */
const F = require('../src/flow');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

/* ---------- 假世界 ---------- */
/* 用一个字符串当"屏幕内容"，任何动作都可能改它；capture() 把它当帧返回。 */
function makeWorld(initial) {
  const w = {
    screen: initial || 'base',
    clicks: [], keys: [], types: [], scrolls: [], moves: [],
    /* 每个 step 编号 → 想让第几次到达这个屏幕时才成功 */
    failTargets: {},          // 形如 { '按钮A': 前几次报找不到 }
    hitCount: {},
    deps: null,
  };
  w.deps = {
    async capture() { return { dataUrl: 'screen:' + w.screen, width: 1920, height: 1080 }; },
    async findTemplate(name, dataUrl, roi) {
      w.hitCount[name] = (w.hitCount[name] || 0) + 1;
      const limit = w.failTargets[name] || 0;
      if (w.hitCount[name] <= limit) return { ok: false, low: true, score: 0.2 };
      /* 约定：名字包含在 screen 里就算找得到，例如 screen='base+entry' 时 'entry' 可见 */
      if (String(dataUrl).indexOf(name) >= 0) return { ok: true, x: 100, y: 200, score: 0.99 };
      return { ok: false, low: true, score: 0.25 };
    },
    async findText(text, dataUrl) {
      if (String(dataUrl).indexOf(text) >= 0) return { ok: true, x: 300, y: 400 };
      return { ok: false };
    },
    async click(x, y) { w.clicks.push([x, y]); },
    async rclick(x, y) { w.clicks.push(['r', x, y]); },
    async move(x, y) { w.moves.push([x, y]); },
    async key(n) { w.keys.push(n); },
    async type(t) { w.types.push(t); },
    async scroll(x, y, d) { w.scrolls.push([d]); },
    log() {},
  };
  return w;
}

(async () => {
  console.log('=== flow.js 单元测试（纯 Node）===');

  /* §1 顺利跑完 */
  {
    const w = makeWorld('base+entry+list');
    const flow = { name: '顺利', steps: [
      { action: 'click', target: { template: 'entry' }, wait: { ms: 10 }, assert: { template: 'list' }, note: '点进设施' },
      { action: 'key', arg: 'esc', wait: { ms: 10 }, note: '返回' },
      { action: 'wait', wait: { ms: 10 }, note: '等一下' },
    ] };
    const r = await F.runFlow(w.deps, flow, {});
    ok(r.ok, '§1 三步全部成功', 'failedAt=' + r.failedAt);
    ok(w.clicks.length === 1 && w.keys.length === 1, '§1 动作真的发出去了', 'click=' + w.clicks.length + ' key=' + w.keys.length);
    ok(F.summarize(r).indexOf('全部跑完') >= 0, '§1 回执说"全部跑完"');
  }

  /* §2 找不到目标 → 必须中止，且不许继续往下走 */
  {
    const w = makeWorld('base+entry+list');
    const flow = { name: '找不到', steps: [
      { action: 'click', target: { template: '不存在的按钮' }, wait: { ms: 10 }, onFail: { retry: 1 } },
      { action: 'click', target: { template: 'entry' }, wait: { ms: 10 } },
    ] };
    const r = await F.runFlow(w.deps, flow, {});
    ok(!r.ok && r.failedAt === 1, '§2 卡在第 1 步', 'failedAt=' + r.failedAt);
    ok(w.clicks.length === 0, '§2 **第 2 步没有被执行**（不许假装成功继续走）', 'clicks=' + w.clicks.length);
    ok(r.needLlm === true, '§2 标出"可以交回 LLM 兜底"');
    ok(r.steps[0].tries === 2, '§2 retry:1 → 试了 2 次', 'tries=' + r.steps[0].tries);
  }

  /* §3 断言不过 = 这一步没生效 → 也要中止 */
  {
    const w = makeWorld('base');
    const flow = { name: '断言不过', steps: [
      { action: 'click', target: { template: 'base' }, wait: { ms: 10 }, assert: { template: '不该出现的界面', timeout: 300 }, onFail: { retry: 0 } },
    ] };
    const t0 = Date.now();
    const r = await F.runFlow(w.deps, flow, {});
    ok(!r.ok && r.failedAt === 1, '§3 断言不过 → 算这一步失败', r.error);
    ok(Date.now() - t0 >= 300, '§3 断言等了它该等的时间（' + (Date.now() - t0) + 'ms）');
    ok(r.steps[0].error.indexOf('断言') >= 0, '§3 错误信息说清是断言没过', r.steps[0].error);
  }

  /* §4 重试真的能救回来（第一次找不到，第二次找到） */
  {
    const w = makeWorld('base+entry');
    w.failTargets['entry'] = 1;                 // 第 1 次找 entry 故意失败
    const flow = { name: '重试救回', steps: [
      { action: 'click', target: { template: 'entry' }, wait: { ms: 10 }, onFail: { retry: 2 } },
    ] };
    const r = await F.runFlow(w.deps, flow, {});
    ok(r.ok, '§4 重试后成功', 'tries=' + r.steps[0].tries);
    ok(r.steps[0].tries === 2, '§4 正好第 2 次成功');
  }

  /* §5 wait:{change:true} —— 等画面变化 */
  {
    const w = makeWorld('a');
    const flow = { name: '等变化', steps: [
      { action: 'key', arg: 'esc', wait: { change: true, timeout: 1500 }, note: '等界面变' },
    ] };
    setTimeout(() => { w.screen = 'b'; }, 200);   // 250ms 后画面变了
    const r = await F.runFlow(w.deps, flow, {});
    ok(r.ok, '§5 画面变化后 wait 结束', r.error || '');
  }

  /* §6 onFail.llm=false → 不许交回 LLM */
  {
    const w = makeWorld('base');
    const flow = { name: '不准交回', steps: [
      { action: 'click', target: { template: '没有这个' }, wait: { ms: 10 }, onFail: { retry: 0, llm: false } },
    ] };
    const r = await F.runFlow(w.deps, flow, {});
    ok(!r.ok && r.needLlm === false, '§6 llm:false 时不标"可交回"');
    ok(F.summarize(r).indexOf('交回我兜底') < 0, '§6 回执里也不提兜底');
  }

  /* §7 空流程 / 不认识的动作 / 坏 target */
  {
    let r = await F.runFlow(makeWorld('x').deps, { name: '空', steps: [] }, {});
    ok(!r.ok && /空的/.test(r.error), '§7 空流程报可读错误', r.error);
    r = await F.runFlow(makeWorld('x').deps, { name: '怪动作', steps: [{ action: 'fly', wait: { ms: 10 } }] }, {});
    ok(!r.ok && /不认识的动作/.test(r.steps[0].error), '§7 不认识的动作报错', r.steps[0].error);
    r = await F.runFlow(makeWorld('x').deps, { name: '没target', steps: [{ action: 'click', wait: { ms: 10 } }] }, {});
    ok(!r.ok && /没有 target/.test(r.steps[0].error), '§7 缺 target 报错', r.steps[0].error);
    r = await F.runFlow(makeWorld('x').deps, { name: '坏xy', steps: [{ action: 'click', target: { xy: ['a', 1] }, wait: { ms: 10 } }] }, {});
    ok(!r.ok && /xy 不是数字/.test(r.steps[0].error), '§7 坏坐标报错', r.steps[0].error);
  }

  /* §8 文字目标（find_text 路径） */
  {
    const w = makeWorld('base+确认');
    const flow = { name: '找文字', steps: [
      { action: 'click', target: { text: '确认' }, wait: { ms: 10 }, assert: { text: '确认' } },
    ] };
    const r = await F.runFlow(w.deps, flow, {});
    ok(r.ok && w.clicks[0][0] === 300 && w.clicks[0][1] === 400, '§8 文字目标解析出坐标并点击', JSON.stringify(w.clicks));
  }

  /* §9 回执压缩（别把几百步都塞回上下文） */
  {
    const w = makeWorld('base');
    const steps = [];
    for (let i = 0; i < 20; i++) steps.push({ action: 'key', arg: 'k' + i, wait: { ms: 1 } });
    const r = await F.runFlow(w.deps, { name: '很多步', steps }, {});
    const s = F.summarize(r);
    ok(r.ok && s.split('\n').length === 21, '§9 20 步的回执 21 行（每步一行）', s.split('\n').length + ' 行');
  }

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
