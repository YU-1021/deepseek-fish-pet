/* 轻量能力注册表（capability registry）—— 抄 DSH/cordis 的"纪律"，不抄它的"容器"
 *
 * 【判断】DSH 的底座是 cordis（~250 个微包）。它的价值在三件事：
 *   ① `ScopedLayers`：全局层 + 会话层，**近者覆盖**（项目级能覆盖用户级）；
 *   ② `ctx.effect()` 返回 disposer —— 注册的东西有**明确的生命周期**，不会泄漏；
 *   ③ 三档钩子：`on()`（通知）／`waterfall()`（可改值的管道）／`guard()`（单调否决）。
 *   成本在 DI 反射代理、`isolate()`/`intercept()`、HMR —— 那些是**多产品/多租户**才需要的。
 *   对一个单人项目，抄上面三件事就够（本文件约 120 行），**不引入 cordis**。
 *
 * 【为什么非做不可（今天真踩过）】工具的元信息散在**三张手写表**里：
 *   TOOL_TIER（权限档）、NOARG（哪些工具不需要参数）、以及给模型看的工具清单字符串。
 *   今天我给助手加了 windows_list / template_list，**忘了登记进 NOARG** ——
 *   于是它们**不带参数调用必然抛「操作参数为空」**，她能用的原因仅仅是
 *   ACTION 里恰好带了个空格（空格是 truthy）—— 侥幸而已。
 *   正确做法：**每个工具自己声明**自己的元信息（名字/权限档/是否需要参数/超时/说明），
 *   三张表都从注册表读。这样"新加一个工具"只在一个地方发生。
 */
'use strict';

function create() {
  /* 两层：global（进程级）与 scoped（会话级）。查的时候先 scoped 再 global —— 近者覆盖。 */
  const layers = { global: new Map(), scoped: new Map() };
  const disposers = [];
  const hooks = { on: new Map(), waterfall: new Map(), guard: [] };

  function bucket(layer, kind) {
    const k = (layer || 'global') + '::' + String(kind || '');
    if (!layers[layer || 'global']) layers[layer || 'global'] = new Map();
    const m = layers[layer || 'global'];
    if (!m.has(k)) m.set(k, new Map());
    return m.get(k);
  }

  /* 注册一个能力。def 会与来源信息合并存起来。
   * 返回一个 **dispose 函数**（照 cordis ctx.effect 的语义：谁注册谁负责回收）。 */
  function register(kind, name, def, opts) {
    const layer = (opts && opts.layer) === 'scoped' ? 'scoped' : 'global';
    const k = String(name);
    if (!kind || !k) throw new Error('register 需要 kind 和 name（收到 ' + kind + '/' + k + '）');
    const rec = Object.assign({ name: k, kind: String(kind) }, def || {});
    bucket(layer, kind).set(k, rec);
    let alive = true;
    const dispose = () => {
      if (!alive) return false;
      alive = false;
      const b = bucket(layer, kind);
      if (b.get(k) === rec) b.delete(k);
      return true;
    };
    disposers.push(dispose);
    return dispose;
  }

  /* 查：**根注册表只读 global 层**（会话层的覆盖不该泄漏到根上 —— 第一版让它共享同一个查询函数，
     于是 r.get() 会看到 scoped 的覆盖，§2 就抓到了这个泄漏）。 */
  function getGlobal(kind, name) {
    const k = String(name);
    return bucket('global', kind).get(k) || null;
  }
  /* 带作用域的查：scoped 优先，其次 global（照 cordis ScopedLayers 的"近者覆盖"） */
  function getScoped(kind, name) {
    const k = String(name);
    const s = bucket('scoped', kind).get(k);
    if (s) return s;
    return bucket('global', kind).get(k) || null;
  }

  function listGlobal(kind) {
    return Array.from(bucket('global', kind).values());
  }
  function listScoped(kind) {
    const out = new Map();
    for (const [k, v] of bucket('global', kind)) out.set(k, v);
    for (const [k, v] of bucket('scoped', kind)) out.set(k, v);
    return Array.from(out.values());
  }

  const get = getGlobal;
  const list = listGlobal;
  function has(kind, name) { return !!getGlobal(kind, name); }

  /* ① on：纯通知（谁想听谁听，互不影响） */
  function on(ev, fn) {
    const k = String(ev);
    if (!hooks.on.has(k)) hooks.on.set(k, []);
    hooks.on.get(k).push(fn);
    const off = () => {
      const arr = hooks.on.get(k) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) { arr.splice(i, 1); return true; }
      return false;
    };
    disposers.push(off);
    return off;
  }

  function emit(ev, payload) {
    let n = 0;
    for (const fn of (hooks.on.get(String(ev)) || []).slice()) {
      try { fn(payload); n++; } catch {}
    }
    return n;
  }

  /* ② waterfall：管道，每个处理器可以改值；返回最终值。
   *    处理器签名 (value, payload) => newValue | undefined（返回 undefined 表示不改） */
  function waterfall(ev, value, payload) {
    let v = value;
    for (const fn of (hooks.waterfall.get(String(ev)) || []).slice()) {
      try {
        const r = fn(v, payload);
        if (r !== undefined) v = r;
      } catch {}
    }
    return v;
  }

  function addWaterfall(ev, fn) {
    const k = String(ev);
    if (!hooks.waterfall.has(k)) hooks.waterfall.set(k, []);
    hooks.waterfall.get(k).push(fn);
    const off = () => {
      const arr = hooks.waterfall.get(k) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) { arr.splice(i, 1); return true; }
      return false;
    };
    disposers.push(off);
    return off;
  }

  /* ③ guard：单调否决 —— 任何一个 guard 返回 false 就是 false（不能把 false 变回 true）。
   *    适合"这件事能不能做"这类判定（权限、越界、冷却）。 */
  function guard(fn) {
    hooks.guard.push(fn);
    const off = () => {
      const i = hooks.guard.indexOf(fn);
      if (i >= 0) { hooks.guard.splice(i, 1); return true; }
      return false;
    };
    disposers.push(off);
    return off;
  }

  function allow(payload) {
    for (const fn of hooks.guard.slice()) {
      try { if (fn(payload) === false) return false; } catch { return false; }
    }
    return true;
  }

  /* 会话级作用域：一个子注册表，共享 global 层，但自己写的东西进 scoped 层。
     会话结束时调 dispose() 一次性回收（照 cordis ctx.effect）。 */
  function scoped() {
    const own = [];
    return {
      register: (kind, name, def) => { const d = register(kind, name, def, { layer: 'scoped' }); own.push(d); return d; },
      get: getScoped, list: listScoped,
      has: (kind, name) => !!getScoped(kind, name),
      on, emit, waterfall, addWaterfall, guard, allow,
      dispose: () => { let n = 0; for (const d of own.splice(0)) if (d()) n++; return n; },
      count: () => own.length,
    };
  }

  function disposeAll() {
    let n = 0;
    for (const d of disposers.splice(0)) { try { if (d()) n++; } catch {} }
    return n;
  }

  function stats() {
    const kinds = new Set();
    for (const layer of ['global', 'scoped']) for (const k of layers[layer].keys()) kinds.add(String(k).split('::')[1]);
    const byKind = {};
    for (const k of kinds) byKind[k] = list(k).length;
    return { kinds: Array.from(kinds), byKind, hooks: { on: hooks.on.size, waterfall: hooks.waterfall.size, guard: hooks.guard.length } };
  }

  return {
    register, get, list, has, on, emit, waterfall, addWaterfall, guard, allow,
    scoped, disposeAll, stats,
  };
}

/* ---------------- 桌宠的工具元信息（**唯一声明处**） ---------------- */
/* 每个工具在这里声明一次：权限档 / 是否需要参数 / 超时 / 给模型看的一句话。
 * 三处读它：assistant 的权限判定、参数检查、timeout.js 的超时表。
 *
 * ⚠️⚠️ tier 必须与老的 TOOL_TIER **逐字一致** —— 第一版我凭印象写了几个，结果：
 *   · screen_look / screen_shot / watch_screen 我写成 `look`，而 `look` 不在 RANK 里
 *     （RANK = off/read/normal/web/full），于是 RANK['look'] 是 undefined →
 *     `allowed()` 算出来永远是 false → **看屏幕在任何权限档都被拒绝**；
 *   · find_template / find_text / find_template_scroll / make_template / windows_list
 *     我写成 `read`，而老表是 `full` → **read 档就能调用，权限被放宽**。
 *   两处都是"重构时凭印象重写常量"的典型事故。现在 test-registry.js 里有一张
 *   **冻结的期望表**（照老表抄的），逐条断言，不允许再漂移。
 * tier 取值只有：read / normal / web / full（外加 off = 全禁）。 */
const TOOL_DEFS = [
  /* 看屏幕（老表都是 full） */
  { name: 'screen_look', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '看屏幕并回答问题' },
  { name: 'screen_shot', tier: 'full', needsArg: false, timeoutMs: 30000, desc: '截一张全屏图' },
  { name: 'watch_screen', tier: 'full', needsArg: true, timeoutMs: 180000, desc: '连续看屏幕并给逐帧时间线' },
  { name: 'screen_diff', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '抓两帧做像素比对：界面到底变没变（确定性，不靠视觉模型）' },
  { name: 'uia_find', tier: 'full', needsArg: true, timeoutMs: 45000, desc: 'UIA 控件树：按元素名字/AutomationId 精确拿坐标（非游戏应用，零识别）' },
  { name: 'uia_dump', tier: 'full', needsArg: true, timeoutMs: 45000, desc: 'UIA 控件树：列出某窗口的所有元素及其坐标' },
  /* 定位（老表都是 full） */
  { name: 'find_template', tier: 'full', needsArg: true, timeoutMs: 40000, desc: '按模板图精确定位' },
  { name: 'find_template_scroll', tier: 'full', needsArg: true, timeoutMs: 150000, desc: '在滚动列表里找模板' },
  { name: 'find_text', tier: 'full', needsArg: true, timeoutMs: 60000, desc: '按文字定位（OCR）' },
  { name: 'make_template', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '从当前画面裁一个模板' },
  { name: 'template_list', tier: 'read', needsArg: false, timeoutMs: 10000, desc: '列出已有模板' },
  { name: 'template_del', tier: 'normal', needsArg: true, timeoutMs: 10000, desc: '删掉一个模板' },
  /* 键鼠 */
  { name: 'click', tier: 'full', needsArg: true, timeoutMs: 15000 },
  { name: 'rclick', tier: 'full', needsArg: true, timeoutMs: 15000 },
  { name: 'dclick', tier: 'full', needsArg: true, timeoutMs: 15000 },
  { name: 'clickz', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '放大后精确点击' },
  { name: 'rclickz', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '放大后精确右键' },
  { name: 'dclickz', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '放大后精确双击' },
  { name: 'move', tier: 'full', needsArg: true, timeoutMs: 15000 },
  { name: 'movez', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '放大后精确移动' },
  { name: 'drag', tier: 'full', needsArg: true, timeoutMs: 25000 },
  { name: 'scroll', tier: 'full', needsArg: true, timeoutMs: 15000 },
  { name: 'key', tier: 'full', needsArg: true, timeoutMs: 15000 },
  { name: 'type', tier: 'full', needsArg: true, timeoutMs: 60000 },
  /* 流程（确定性回放） */
  { name: 'flow_run', tier: 'full', needsArg: true, timeoutMs: 300000, desc: '跑一个确定性流程' },
  { name: 'flow_save', tier: 'full', needsArg: true, timeoutMs: 10000 },
  { name: 'flow_list', tier: 'read', needsArg: false, timeoutMs: 10000 },
  { name: 'flow_del', tier: 'full', needsArg: true, timeoutMs: 10000 },
  /* 文件（tier 照老表） */
  { name: 'read_file', tier: 'read', needsArg: true, timeoutMs: 30000 },
  { name: 'write_file', tier: 'full', needsArg: true, timeoutMs: 30000 },
  { name: 'list_dir', tier: 'read', needsArg: true, timeoutMs: 20000 },
  { name: 'run_file', tier: 'full', needsArg: true, timeoutMs: 120000 },
  { name: 'open_path', tier: 'normal', needsArg: true, timeoutMs: 20000, desc: '用默认程序打开一个路径' },
  { name: 'open_url', tier: 'normal', needsArg: true, timeoutMs: 20000, desc: '用浏览器打开一个网址' },
  { name: 'proj_read', tier: 'read', needsArg: true, timeoutMs: 20000 },
  { name: 'proj_write', tier: 'normal', needsArg: true, timeoutMs: 20000 },
  { name: 'proj_ls', tier: 'read', needsArg: false, timeoutMs: 10000 },
  { name: 'proj_run', tier: 'normal', needsArg: true, timeoutMs: 120000 },
  { name: 'proj_rm', tier: 'normal', needsArg: true, timeoutMs: 10000 },
  { name: 'proj_open', tier: 'normal', needsArg: true, timeoutMs: 20000 },
  /* 技能 */
  { name: 'use_skill', tier: 'read', needsArg: true, timeoutMs: 20000 },
  { name: 'skill_read', tier: 'read', needsArg: true, timeoutMs: 20000 },
  { name: 'skill_ls', tier: 'read', needsArg: false, timeoutMs: 10000 },
  { name: 'skill_write', tier: 'normal', needsArg: true, timeoutMs: 30000 },
  { name: 'skill_rm', tier: 'normal', needsArg: true, timeoutMs: 10000 },
  /* 人格词条 */
  { name: 'tag_list', tier: 'read', needsArg: false, timeoutMs: 10000 },
  { name: 'tag_set', tier: 'normal', needsArg: true, timeoutMs: 10000 },
  { name: 'tag_rm', tier: 'normal', needsArg: true, timeoutMs: 10000 },
  /* 网页（老表是 web） */
  { name: 'web_open', tier: 'web', needsArg: true, timeoutMs: 60000 },
  { name: 'web_read', tier: 'web', needsArg: false, timeoutMs: 60000 },
  { name: 'web_click', tier: 'web', needsArg: true, timeoutMs: 30000 },
  { name: 'web_type', tier: 'web', needsArg: true, timeoutMs: 30000 },
  /* 窗口（老表 full） */
  { name: 'focus_window', tier: 'full', needsArg: true, timeoutMs: 25000 },
  { name: 'windows_list', tier: 'full', needsArg: false, timeoutMs: 25000 },
  /* 游戏托管（老表 game_stop/game_status 是 read） */
  { name: 'game_start', tier: 'full', needsArg: true, timeoutMs: 300000 },
  { name: 'game_stop', tier: 'read', needsArg: false, timeoutMs: 30000 },
  { name: 'game_status', tier: 'read', needsArg: false, timeoutMs: 15000 },
];

/* 建一个已经装好全部工具定义的注册表 */
function withTools(base) {
  const reg = base || create();
  for (const d of TOOL_DEFS) reg.register('tool', d.name, d);
  return reg;
}

module.exports = { create, withTools, TOOL_DEFS };
