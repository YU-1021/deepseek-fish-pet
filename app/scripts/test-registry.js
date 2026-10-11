/* registry.js 的单元测试 —— 纯 Node
 * 跑法：node app/scripts/test-registry.js
 */
const REG = require('../src/registry');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

console.log('=== registry.js 单元测试（纯 Node）===');

/* §1 注册与查询 */
{
  const r = REG.create();
  r.register('tool', 'click', { tier: 'full', needsArg: true });
  ok(r.has('tool', 'click'), '§1 注册后能查到');
  ok(r.get('tool', 'click').tier === 'full', '§1 元信息原样保留');
  ok(REG.create().has('tool', 'click') === false, '§1 不同实例互不干扰');
  ok(r.list('tool').length === 1, '§1 list 正常');
  let threw = false;
  try { r.register('', 'x', {}); } catch { threw = true; }
  ok(threw, '§1 缺 kind 时抛错（不静默）');
}

/* §2 ★ 两层：scoped 覆盖 global（近者覆盖，照 cordis ScopedLayers） */
{
  const r = REG.create();
  r.register('tool', 'click', { tier: 'read', note: '全局默认' });
  const sess = r.scoped();
  sess.register('tool', 'click', { tier: 'full', note: '本会话覆盖' });
  ok(sess.get('tool', 'click').tier === 'full', '★ §2 会话层覆盖全局层', sess.get('tool', 'click').note);
  ok(r.get('tool', 'click').tier === 'read', '§2 全局层本身没被改（根注册表只读 global 层）');
  const n = sess.dispose();
  ok(n === 1, '§2 会话 dispose 回收了 1 项', 'n=' + n);
  ok(r.get('tool', 'click').tier === 'read', '§2 回收后回到全局值（覆盖消失）');
  /* 会话层里"自己写的"那一条没了；但 getScoped 会落回 global（这是"近者覆盖"的正常语义，
     不是 bug —— 所以这里查的是 listScoped 里还有没有那一条覆盖） */
  ok(sess.count() === 0, '§2 会话层里自己注册的那一条已经没了', 'count=' + sess.count());
  ok(sess.get('tool', 'click').tier === 'read', '§2 覆盖消失后 sess.get 落回全局值（正常语义）');
}

/* §3 dispose：注册返回 disposer，可单独回收 */
{
  const r = REG.create();
  const d = r.register('tool', 'temp', { tier: 'read' });
  ok(r.has('tool', 'temp'), '§3 注册后存在');
  ok(d() === true, '§3 dispose 返回 true 表示确实删掉了');
  ok(d() === false, '§3 再 dispose 返回 false（幂等）');
  ok(!r.has('tool', 'temp'), '§3 已经不存在');
  const r2 = REG.create();
  r2.register('tool', 'a', {}); r2.register('tool', 'b', {});
  ok(r2.disposeAll() === 2, '§3 disposeAll 一次回收全部');
  ok(r2.list('tool').length === 0, '§3 回收后列表为空');
}

/* §4 on：纯通知 */
{
  const r = REG.create();
  const got = [];
  const off = r.on('turn', (p) => got.push(p));
  ok(r.emit('turn', 1) === 1, '§4 emit 通知到了 1 个监听者');
  ok(got.length === 1 && got[0] === 1, '§4 载荷正确');
  off();
  r.emit('turn', 2);
  ok(got.length === 1, '§4 取消监听后不再收到');
  /* 一个监听者抛错不该影响别人 */
  const got2 = [];
  r.on('x', () => { throw new Error('坏监听者'); });
  r.on('x', (p) => got2.push(p));
  ok(r.emit('x', 9) === 1 && got2[0] === 9, '★ §4 某个监听者抛错不影响其它监听者', 'n=' + r.emit('x', 9));
}

/* §5 waterfall：管道，可改值 */
{
  const r = REG.create();
  r.addWaterfall('prompt', (v) => v + ' A');
  r.addWaterfall('prompt', (v) => v + ' B');
  r.addWaterfall('prompt', () => undefined);        // 返回 undefined = 不改
  ok(r.waterfall('prompt', 'base') === 'base A B', '§5 依次改值，undefined 表示不改', r.waterfall('prompt', 'base'));
  const off = r.addWaterfall('prompt', (v) => v + ' C');
  ok(r.waterfall('prompt', 'x') === 'x A B C', '§5 新加的排在后面');
  off();
  ok(r.waterfall('prompt', 'x') === 'x A B', '§5 取消后不再生效');
}

/* §6 guard：单调否决（不能把 false 变回 true） */
{
  const r = REG.create();
  r.guard((p) => p.tool !== 'rm_rf');
  r.guard((p) => p.tier !== 'full');
  ok(r.allow({ tool: 'click', tier: 'read' }) === true, '§6 都通过时允许');
  ok(r.allow({ tool: 'rm_rf', tier: 'read' }) === false, '§6 被第一个 guard 否决');
  ok(r.allow({ tool: 'click', tier: 'full' }) === false, '§6 被第二个 guard 否决');
  /* ★ 单调性：再加一个"永远返回 true"的 guard，也翻不回 false */
  r.guard(() => true);
  ok(r.allow({ tool: 'rm_rf', tier: 'read' }) === false, '★ §6 guard 是单调否决（true 翻不回 false）');
  /* 抛错的 guard 视为否决（fail closed，照 DSH 的 approval policy） */
  const r2 = REG.create();
  r2.guard(() => { throw new Error('坏了'); });
  ok(r2.allow({}) === false, '★ §6 guard 抛错时按否决处理（fail closed）');
}

/* §7 withTools：全部工具都装好了，而且元信息齐全 */
{
  const r = REG.withTools();
  const tools = r.list('tool');
  ok(tools.length === REG.TOOL_DEFS.length && tools.length > 30, '§7 工具定义全部装好', tools.length + ' 个');
  ok(tools.every((t) => typeof t.tier === 'string' && t.tier), '§7 每个工具都有权限档');
  ok(tools.every((t) => typeof t.needsArg === 'boolean'), '§7 每个工具都声明了是否需要参数');
  ok(tools.every((t) => Number.isFinite(t.timeoutMs)), '§7 每个工具都有超时');
  /* ★ 今天踩过的那个坑：这两个必须是 needsArg:false */
  ok(r.get('tool', 'windows_list').needsArg === false, '★ §7 windows_list 声明"不需要参数"（今天它漏登记导致必报错）');
  ok(r.get('tool', 'template_list').needsArg === false, '★ §7 template_list 同理');
  ok(r.get('tool', 'skill_ls').needsArg === false && r.get('tool', 'proj_ls').needsArg === false, '§7 其它无参工具也都声明了');
  /* 一致性：不该有"需要参数却声明 false"或反之的明显矛盾 */
  const bad = tools.filter((t) => t.needsArg === true && /_ls$|_list$/.test(t.name));
  ok(bad.length === 0, '§7 没有"名字像列表却要求参数"的矛盾声明', bad.map((x) => x.name).join(','));
}

/* §8 同一份定义可以喂给别处（超时表、权限表都从它读） */
{
  const r = REG.withTools();
  const click = r.get('tool', 'click');
  const watch = r.get('tool', 'watch_screen');
  ok(click.timeoutMs === 15000 && watch.timeoutMs === 180000, '§8 超时值就在定义里（timeout.js 可直接读它）', 'click=' + click.timeoutMs + ' watch=' + watch.timeoutMs);
  ok(r.get('tool', 'never_heard_of_it') === null, '§8 没注册过的工具返回 null（调用方自己决定默认值）');
}

/* §9 stats 能看清装了什么 */
{
  const r = REG.withTools();
  const st = r.stats();
  ok(st.kinds.indexOf('tool') >= 0 && st.byKind.tool === REG.TOOL_DEFS.length, '§9 stats 报出种类与数量', JSON.stringify(st.byKind));
}

/* §10 ★★ 冻结的期望表：照**重构前的老 TOOL_TIER** 逐条抄下来。
   为什么需要它：重构时我"凭印象"给几个工具写了权限档，结果
     · screen_look / screen_shot / watch_screen 写成 `look`（`look` 根本不在 RANK 里）
       → allowed() 永远是 false → **看屏幕在任何权限档都被拒绝**；
     · find_template / find_text / find_template_scroll / make_template / windows_list 写成 `read`（老表是 full）
       → **read 档就能调用，权限被放宽**。
   两处都是"重写常量时不小心改了语义"。这张表把老语义**冻住**，以后改一处就会红。 */
{
  const FROZEN_TIERS = {
    list_dir: 'read', read_file: 'read', use_skill: 'read', skill_ls: 'read', skill_read: 'read',
    write_file: 'full', run_file: 'full', focus_window: 'full', windows_list: 'full',
    make_template: 'full', find_template: 'full', template_list: 'read', template_del: 'normal',
    find_text: 'full', find_template_scroll: 'full', watch_screen: 'full',
    proj_ls: 'read', proj_read: 'read', tag_list: 'read',
    open_path: 'normal', open_url: 'normal', skill_write: 'normal', skill_rm: 'normal',
    proj_rm: 'normal', proj_open: 'normal', proj_run: 'normal', proj_write: 'normal',
    tag_set: 'normal', tag_rm: 'normal',
    web_open: 'web', web_click: 'web', web_type: 'web', web_read: 'web',
    screen_shot: 'full', screen_look: 'full',
    screen_diff: 'full',   // 新增：像素级帧比对（用户要求的那条）
    uia_find: 'full', uia_dump: 'full',   // 新增：UIA 控件树通道（非游戏应用零识别定位）
    click: 'full', rclick: 'full', dclick: 'full', move: 'full', drag: 'full', scroll: 'full', type: 'full', key: 'full',
    clickz: 'full', movez: 'full', rclickz: 'full', dclickz: 'full',
    game_start: 'full', game_stop: 'read', game_status: 'read',
  };
  const r = REG.withTools();
  const wrong = [];
  for (const [name, tier] of Object.entries(FROZEN_TIERS)) {
    const d = r.get('tool', name);
    if (!d) wrong.push(name + '(注册表里没有)');
    else if (d.tier !== tier) wrong.push(name + ':' + d.tier + '≠' + tier);
  }
  ok(wrong.length === 0, '★ §10 注册表权限档与冻结的老语义**逐条一致**', wrong.length ? wrong.join(', ') : '共核对 ' + Object.keys(FROZEN_TIERS).length + ' 个');
  /* 反向：注册表里不该有冻结表之外、又不在新工具白名单里的（防止乱加） */
  const NEW_OK = ['flow_run', 'flow_save', 'flow_list', 'flow_del'];
  const extra = r.list('tool').map((t) => t.name).filter((n) => !FROZEN_TIERS[n] && NEW_OK.indexOf(n) < 0);
  ok(extra.length === 0, '★ §10 注册表里没有"来历不明"的工具', extra.join(', ') || '（干净）');
  /* §11 ★ tier 必须是 RANK 认得的取值（`look` 这种拼错会让 allowed() 永远 false） */
  const VALID = ['read', 'normal', 'web', 'full'];
  const badTier = r.list('tool').filter((t) => VALID.indexOf(t.tier) < 0).map((t) => t.name + ':' + t.tier);
  ok(badTier.length === 0, '★ §11 每个 tier 都是 RANK 认得的取值（read/normal/web/full）', badTier.join(', ') || '（全部合法）');
}

/* §13 ★★ 视觉模型给的动作白名单：裸坐标点击必须被拒（她"点自己人取消选中"的根因） */
{
  const ALLOWED = ['find_text', 'find_template', 'find_template_scroll', 'focus_window', 'windows_list', 'key'];
  const BARE = ['click', 'rclick', 'dclick', 'move', 'clickz', 'rclickz', 'dclickz', 'movez', 'drag', 'scroll', 'screen_look'];
  const r = REG.withTools();
  /* 白名单里的必须是真工具 */
  const badAllowed = ALLOWED.filter((t) => !r.get('tool', t));
  ok(badAllowed.length === 0, '★ §13 白名单里的工具都真实存在', badAllowed.join(',') || '（全部存在）');
  /* 裸坐标的必须**不在**白名单里 */
  const leaked = BARE.filter((t) => ALLOWED.indexOf(t) >= 0);
  ok(leaked.length === 0, '★★ §13 裸坐标类动作（click/move/clickz/drag/scroll…）**全部**不在视觉白名单里', leaked.join(',') || '（一个都没漏）');
  /* screen_look 也不能在 —— 否则"看→又想看"的自转闸门会被绕过 */
  ok(ALLOWED.indexOf('screen_look') < 0, '★ §13 screen_look 也不在白名单里（防自转）');
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
