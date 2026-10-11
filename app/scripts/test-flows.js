/* flows.js 的单元测试 —— **纯 Node，不需要 Electron、不需要屏幕**
 *
 * flows.js 用依赖注入换来的好处：喂它一个临时目录 + 一套假的键鼠/抓帧/找图实现，
 * 就能把"存取流程""名字校验""干跑不动键鼠""流程失败时的报告"全部验证掉。
 *
 * 跑法：node app/scripts/test-flows.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const FL = require('../src/flows');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flows-test-'));
const sent = { clicks: [], keys: [], types: [], scrolls: [] };
const deps = {
  capture: async () => ({ dataUrl: 'fake-screen:' + (global.__screen || 'base'), width: 1920, height: 1080 }),
  findTemplate: async (name, dataUrl) => (String(dataUrl).indexOf(name) >= 0 ? { ok: true, x: 10, y: 20, score: 0.99 } : { ok: false, low: true, score: 0.2 }),
  findText: async (text, dataUrl) => (String(dataUrl).indexOf(text) >= 0 ? { ok: true, x: 30, y: 40 } : { ok: false }),
  input: {
    click: async (x, y) => sent.clicks.push([x, y]),
    rclick: async (x, y) => sent.clicks.push(['r', x, y]),
    move: async (x, y) => {},
    key: async (k) => sent.keys.push(k),
    type: async (t) => sent.types.push(t),
    scroll: async (x, y, d) => sent.scrolls.push([d]),
  },
  log: () => {},
};

(async () => {
  console.log('=== flows.js 单元测试（纯 Node）===');
  global.__screen = 'base+确认+入口';

  /* §1 存取 */
  const flow = { title: '测试流程', steps: [
    { action: 'click', target: { template: '入口' }, wait: { ms: 5 }, assert: { text: '确认' }, note: '点入口' },
    { action: 'click', target: { text: '确认' }, wait: { ms: 5 }, note: '确认' },
  ] };
  let r = FL.save(TMP, '测试-流程', flow);
  ok(r.ok, '§1 存流程成功', r.path || r.error);
  ok(fs.existsSync(path.join(TMP, 'flows', '测试-流程.json')), '§1 文件落盘（中文名可以）');
  const ls = FL.list(TMP);
  ok(ls.length === 1 && ls[0].name === '测试-流程' && ls[0].steps === 2, '§1 列表正确', JSON.stringify(ls));
  const ld = FL.load(TMP, '测试-流程');
  ok(ld && ld.steps.length === 2 && ld.title === '测试流程', '§1 读取正确');

  /* §2 名字校验（防越界） */
  ok(!FL.save(TMP, '', flow).ok, '§2 空名字被拒');
  ok(!FL.save(TMP, '../逃出去', flow).ok, '§2 含路径分隔符的名字被拒');
  ok(!FL.save(TMP, 'a/b', flow).ok, '§2 含 / 的名字被拒');
  ok(!FL.save(TMP, '..', flow).ok, '§2 ".." 被拒');
  ok(!FL.save(TMP, 'ok', { steps: [] }).ok, '§2 空步骤的流程被拒');
  ok(FL.load(TMP, '不存在的流程') === null, '§2 读不存在的流程返回 null');
  ok(FL.del(TMP, '不存在的流程') === false, '§2 删不存在的流程返回 false');

  /* §3 真实跑（会动键鼠） */
  sent.clicks.length = 0;
  r = await FL.run(TMP, '测试-流程', deps);
  ok(r.ok, '§3 流程跑通', JSON.stringify(r.steps.map((s) => [s.i, s.ok])));
  ok(sent.clicks.length === 2, '§3 真的点了两次', JSON.stringify(sent.clicks));

  /* §4 干跑（dry）：**一步都不许动键鼠**，但目标照样要解析 */
  sent.clicks.length = 0;
  r = await FL.run(TMP, '测试-流程', Object.assign({}, deps, { dry: true }));
  ok(r.ok && r.dry === true, '§4 干跑成功且标记 dry');
  ok(sent.clicks.length === 0, '§4 **干跑没有动键鼠**（这是它的全部意义）', 'clicks=' + sent.clicks.length);
  ok(r.steps[0].target && r.steps[0].target.x === 10, '§4 干跑仍然解析出了坐标', JSON.stringify(r.steps[0].target));

  /* §5 干跑也能发现"目标找不到"（这才是干跑的用处：先验证再真跑） */
  global.__screen = 'base';                       // 现在屏幕上没有"入口"和"确认"了
  sent.clicks.length = 0;
  r = await FL.run(TMP, '测试-流程', Object.assign({}, deps, { dry: true }));
  ok(!r.ok && r.failedAt === 1, '§5 干跑发现第 1 步目标找不到', r.error);
  ok(r.needLlm === true, '§5 标出可交回 LLM');
  ok(sent.clicks.length === 0, '§5 失败时也没动键鼠');

  /* §6 不存在的流程 → 可读错误 */
  r = await FL.run(TMP, '没有这个流程', deps);
  ok(!r.ok && /没有名为/.test(r.error), '§6 不存在的流程给可读错误', r.error);

  /* §7 回执压缩 */
  global.__screen = 'base+确认+入口';
  r = await FL.run(TMP, '测试-流程', Object.assign({}, deps, { dry: true }));
  const s = FL.summarize(r);
  ok(s.indexOf('全部跑完') >= 0 && s.split('\n').length === 3, '§7 回执是"一行头 + 每步一行"', s.split('\n').length + ' 行');

  /* §8 增删改查的完整生命周期 */
  ok(FL.del(TMP, '测试-流程') === true, '§8 删除成功');
  ok(FL.list(TMP).length === 0, '§8 删完列表为空');

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
