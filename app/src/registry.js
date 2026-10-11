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
  /* ★ 剪贴板（A3）：5 行 API 就能做，不必接 MCP ✓ ★ */
  { name: 'clipboard_read', tier: 'normal', needsArg: false, timeoutMs: 15000, desc: '读系统剪贴板里的文本。★主人说"复制了…"、"我刚复制的那个"时用它★；剪贴板为空或不是文本会说明。' },
  { name: 'clipboard_write', tier: 'normal', needsArg: true, timeoutMs: 15000, desc: '把一段文本写进系统剪贴板（支持多行、中文）。参数就是文本本身。★写完要提醒主人"已经复制好了，去 Ctrl+V"★。' },
  /* ★ 轮询等条件（A4）：治"没验证就重试"的顽疾 ✓ ★ */
  { name: 'wait_for', tier: 'full', needsArg: true, timeoutMs: 130000, desc: '轮询等一个条件成立（比"固定睡 N 秒"可靠）。格式 wait_for|<类型>|<目标>|<超时秒>：window|<标题片段>|8 / element|<窗口标题>|<控件名>|8 / text|<画面上的文字>|8 / change|8（等画面变化）。★超时会告诉你最后一次检查到什么★。' },
  { name: 'kill_app', tier: 'full', needsArg: true, timeoutMs: 20000, desc: '结束同名进程的【多余实例】（UWP 僵尸：反复开关应用会攒出多个实例，导致窗口托不出来）' },
  { name: 'uia_find', tier: 'full', needsArg: true, timeoutMs: 45000, desc: 'UIA 控件树：按元素名字/AutomationId 精确拿坐标（非游戏应用，零识别）' },
  { name: 'uia_snapshot', tier: 'full', needsArg: true, timeoutMs: 45000, desc: '把一个窗口里【所有可交互控件】列成编号清单（按钮/输入框/下拉/勾选/列表项…），带控件名和中心坐标。★这是"不知道控件叫什么"时的入口★：先 uia_snapshot 看清单，再用 uia_find|<窗口>|<控件名> 拿精确坐标去点。★中文界面的控件名也是中文（数字键 5 的名字是「五」）★，所以别猜名字，看清单。' },
  { name: 'uia_dump', tier: 'full', needsArg: true, timeoutMs: 45000, desc: 'UIA 控件树：列出某窗口的所有元素及其坐标' },
  /* 定位（老表都是 full） */
  { name: 'find_template', tier: 'full', needsArg: true, timeoutMs: 40000, desc: '按模板图精确定位' },
  { name: 'find_template_scroll', tier: 'full', needsArg: true, timeoutMs: 150000, desc: '在滚动列表里找模板' },
  { name: 'find_text', tier: 'full', needsArg: true, timeoutMs: 60000, desc: '按文字定位（OCR）' },
  { name: 'make_template', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '从当前画面裁一个模板' },
  { name: 'template_list', tier: 'read', needsArg: false, timeoutMs: 10000, desc: '列出已有模板' },
  { name: 'template_del', tier: 'normal', needsArg: true, timeoutMs: 10000, desc: '删掉一个模板' },
  /* 键鼠 */
  { name: 'click', tier: 'full', needsArg: true, timeoutMs: 15000, desc: '在屏幕坐标点一下左键。参数 <x>,<y>（整屏像素，左上原点）。★要按按钮/控件时优先用 uia_find 拿精确坐标再点，比看图猜准得多★。执行前后有安全断言（目标是否被遮挡、前台对不对）。' },
  { name: 'rclick', tier: 'full', needsArg: true, timeoutMs: 15000, desc: '在屏幕坐标点一下右键（弹出上下文菜单）。参数 <x>,<y>。' },
  { name: 'dclick', tier: 'full', needsArg: true, timeoutMs: 15000, desc: '在屏幕坐标双击左键（打开文件/进目录常用）。参数 <x>,<y>。' },
  { name: 'clickz', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '放大后精确点击' },
  { name: 'rclickz', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '放大后精确右键' },
  { name: 'dclickz', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '放大后精确双击' },
  { name: 'move', tier: 'full', needsArg: true, timeoutMs: 15000, desc: '把光标移到 <x>,<y>，不点击。用来悬停看 tooltip，或试探某位置能不能到。' },
  { name: 'movez', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '放大后精确移动' },
  { name: 'drag', tier: 'full', needsArg: true, timeoutMs: 25000, desc: '从 <x1>,<y1> 拖到 <x2>,<y2>（按住左键移动后松开）。★拖完要用 screen_look 确认结果变了没有★。' },
  { name: 'scroll', tier: 'full', needsArg: true, timeoutMs: 15000, desc: '在某点滚轮。参数 <x>,<y>,<方向>，方向写 up 或 down，可带次数如 scroll|960,540|down|5。★别用正负号★。' },
  { name: 'key', tier: 'full', needsArg: true, timeoutMs: 15000, desc: '按一个键。参数是键名：enter / esc / tab / space / backspace / delete / up / down / left / right / home / end / pageup / pagedown / f1~f12；组合键用 + 连（如 ctrl+c、alt+tab）。★键盘只发给前台窗口 —— 目标不在前台就先 focus_window；UWP 应用抢不到前台时改用 click★。' },
  { name: 'type', tier: 'full', needsArg: true, timeoutMs: 60000, desc: '输入一段文字（按字符发，不受键盘布局影响，中文和符号都能打）。参数是文本。★只发给前台窗口。要回车请另外用 key|enter★。' },
  /* 流程（确定性回放） */
  { name: 'flow_run', tier: 'full', needsArg: true, timeoutMs: 300000, desc: '跑一个确定性流程' },
  { name: 'flow_save', tier: 'full', needsArg: true, timeoutMs: 10000, desc: '把刚跑通的一串动作存成命名流程，以后能一键重放。参数 <名字>。★重复性任务（每日签到之类）值得存★。' },
  { name: 'flow_list', tier: 'read', needsArg: false, timeoutMs: 10000, desc: '列出已保存的确定性流程。' },
  { name: 'flow_del', tier: 'full', needsArg: true, timeoutMs: 10000, desc: '删掉一个已保存的流程。参数 <名字>。' },
  /* 文件（tier 照老表） */
  /* ★ 常驻 shell 会话（B1）：补上她最大的结构性缺口 ★
     proj_run 是一次性 spawn —— cd 不留、环境不留、后台进程留不下，
     于是"进目录 → 装依赖 → 编译 → 看报错 → 改"这条链是断的。 */
  { name: 'shell_run', tier: 'full', needsArg: true, timeoutMs: 300000, desc: '在【常驻】PowerShell 会话里跑一条命令。★和 proj_run 的区别：cd、环境变量、会话变量全都保留★，所以"进目录→装依赖→编译→看报错→改"可以连续做。参数就是命令本身（中文/多行都行，走 base64 通道不会乱码）。超时会明确告诉你"没跑完"而不是假装成功。' },
  { name: 'shell_status', tier: 'read', needsArg: false, timeoutMs: 10000, desc: '看常驻 shell 会话的状态：还活着吗、现在在哪个目录、上一条命令跑完多久了。' },
  { name: 'shell_close', tier: 'read', needsArg: false, timeoutMs: 10000, desc: '关掉常驻 shell 会话（会丢掉 cwd 和会话变量）。★一般不用手动关，空闲 10 分钟会自动回收★。' },
  { name: 'check_code', tier: 'read', needsArg: true, timeoutMs: 200000, desc: '★改完代码后先检查这一个文件★：JS 走 node --check（语法）、TS 走 npx tsc --noEmit（类型，需 tsconfig）、Python 走 py_compile、JSON 直接解析。★参数是文件路径★。注意它**只查这一个文件**，语法过了不等于整个项目能跑（那要用 shell_run 跑项目的 lint/test）。检查器不存在时会明说"检查不了"，不会假报通过。' },
  { name: 'sys_info', tier: 'read', needsArg: false, timeoutMs: 20000, desc: '查这台电脑的系统信息：内存 / CPU / 开机时长 / 电池 / 磁盘剩余 / 网络。参数可选，写 battery、disk、net、mem 就只查那一项（★快得多★：全量约 3.7 秒，单项几百毫秒）。★主人问"还剩多少电""C 盘还有空间吗"时用它，别去截图里 OCR 那些小字★。' },
  { name: 'remind_in', tier: 'normal', needsArg: true, timeoutMs: 10000, desc: '★设置一个提醒★ —— 过 N 分钟后提醒主人做某件事。参数 <分钟>|<要提醒的内容>，例：remind_in|30|去喝水。' },
  { name: 'remind_at', tier: 'normal', needsArg: true, timeoutMs: 10000, desc: '★设置一个定时提醒★（今天的某个钟点；已经过了就是明天）。参数 <HH:MM>|<内容>，例：remind_at|14:30|开会。' },
  { name: 'remind_list', tier: 'read', needsArg: false, timeoutMs: 10000, desc: '列出还没响的提醒（带编号、还有多少分钟）。' },
  { name: 'remind_cancel', tier: 'normal', needsArg: true, timeoutMs: 10000, desc: '取消一个提醒。参数是编号（先用 remind_list 看）。' },
  { name: 'search_code', tier: 'read', needsArg: true, timeoutMs: 60000, desc: '在目录里搜索**文件内容**（正则或普通文字），返回 文件:行号:那一行。★这是找"哪个文件里有这个函数/这个配置"的正确工具★ —— list_dir 只能看名字，read_file 要一个个试。用法 search_code|<模式>|<目录>|<扩展名开关，如 js,ts>。自动跳过 node_modules/.git/dist/浏览器缓存等，跳过二进制和 >2MB 的文件；有 15 秒预算和 60 条命中上限，★没搜完会明确说"截断了"而不是假装没有★。' },
  { name: 'doc_read', tier: 'read', needsArg: true, timeoutMs: 60000, desc: '★读文档内容★：Word(.docx) 抽正文、Excel(.xlsx) 还原成表格（支持多工作表，可选表名）、CSV/TXT/MD/JSON 当文本读。用法 doc_read|<文件路径>|<可选的工作表名>。★PDF 和老版 .doc/.xls 读不了，会明确告诉你并给替代方案（不会返回乱码）★。★主人发来一个文件说"看看这个"时用它，别去猜内容★。' },
  { name: 'read_file', tier: 'read', needsArg: true, timeoutMs: 30000, desc: '读一个文本文件的内容（大文件会截断）。参数是路径。★改文件之前先读，别凭记忆改★。' },
  { name: 'write_file', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '写入/覆盖一个文本文件。参数 <路径>||<内容>（注意是**两个竖线**分隔）。★会覆盖原文件 —— 改之前先 read_file 看清★。主人指定别的目录时用它，别用 proj_write。' },
  { name: 'list_dir', tier: 'read', needsArg: true, timeoutMs: 20000, desc: '列出一个目录下的文件和子目录。参数是路径。★想知道某个目录里有什么时用它★。' },
  { name: 'run_file', tier: 'full', needsArg: true, timeoutMs: 120000, desc: '用默认程序打开/运行一个文件（按扩展名交给对应程序）。参数是绝对路径。' },
  { name: 'open_path', tier: 'normal', needsArg: true, timeoutMs: 20000, desc: '用默认程序打开一个路径' },
  { name: 'open_url', tier: 'normal', needsArg: true, timeoutMs: 20000, desc: '用浏览器打开一个网址' },
  { name: 'proj_read', tier: 'read', needsArg: true, timeoutMs: 20000, desc: '读项目脚本（她自己的脚本目录）。参数 <文件名>。' },
  { name: 'proj_write', tier: 'normal', needsArg: true, timeoutMs: 20000, desc: '写入/覆盖一个项目脚本。参数 <文件名>||<内容>。★写小工具给自己用就放这里★。' },
  { name: 'proj_ls', tier: 'read', needsArg: false, timeoutMs: 10000, desc: '列出项目脚本目录里有哪些脚本。' },
  { name: 'proj_run', tier: 'normal', needsArg: true, timeoutMs: 120000, desc: '跑一个项目脚本并拿到输出。参数 <文件名> [参数…]。★这是她执行自己写的代码的地方；★一次性执行，进程不保留★——要连续会话请分步做★。' },
  { name: 'proj_rm', tier: 'normal', needsArg: true, timeoutMs: 10000, desc: '删掉一个项目脚本。参数 <文件名>。' },
  { name: 'proj_open', tier: 'normal', needsArg: true, timeoutMs: 20000, desc: '用默认编辑器打开一个项目脚本，方便主人自己看/改。参数 <文件名>。' },
  /* 技能 */
  { name: 'use_skill', tier: 'read', needsArg: true, timeoutMs: 20000, desc: '★按名字加载一个技能的完整说明书到上下文★。参数 <技能名>。★★做事之前先 use_skill 看有没有现成的套路，比瞎试快得多★。' },
  { name: 'skill_read', tier: 'read', needsArg: true, timeoutMs: 20000, desc: '读一个技能文件的内容（只看，不加载进上下文）。参数 <路径>。' },
  { name: 'skill_ls', tier: 'read', needsArg: false, timeoutMs: 10000, desc: '列出已有的技能（名字 + 一句话说明）。★不确定有没有相关技能时先列一遍★。' },
  { name: 'skill_write', tier: 'normal', needsArg: true, timeoutMs: 30000, desc: '写入/更新一个技能文件，把学到的套路固化下来。参数 <路径>||<内容>。★一次任务成功后值得沉淀成技能，下次直接 use_skill★。' },
  { name: 'skill_rm', tier: 'normal', needsArg: true, timeoutMs: 10000, desc: '删掉一个技能。参数 <名字>。' },
  /* 人格词条 */
  { name: 'tag_list', tier: 'read', needsArg: false, timeoutMs: 10000, desc: '列出人格词条（性格/口头禅这类可调的小设定）。' },
  { name: 'tag_set', tier: 'normal', needsArg: true, timeoutMs: 10000, desc: '设置一个人格词条。参数 <键>||<值>。' },
  { name: 'tag_rm', tier: 'normal', needsArg: true, timeoutMs: 10000, desc: '删掉一个人格词条。参数 <键>。' },
  /* 网页（老表是 web） */
  { name: 'web_open', tier: 'web', needsArg: true, timeoutMs: 60000, desc: '在内置浏览器窗口打开一个网址，之后可以用 web_read / web_click 操作它。参数是 URL。★比"开系统浏览器再截屏操作"可靠得多，因为它能直接读页面内容★。' },
  { name: 'web_read', tier: 'web', needsArg: false, timeoutMs: 60000, desc: '读当前内置浏览器页面的文本内容。★查资料优先用它，而不是 screen_look 看浏览器画面★。' },
  { name: 'web_click', tier: 'web', needsArg: true, timeoutMs: 30000, desc: '点击内置浏览器页面里的元素。参数 <CSS 选择器 或 元素文字>。' },
  { name: 'web_type', tier: 'web', needsArg: true, timeoutMs: 30000, desc: '在内置浏览器页面的输入框里输入文字（可带回车）。参数 <CSS 选择器>||<文字>。' },
  /* 窗口（老表 full） */
  { name: 'focus_window', tier: 'full', needsArg: true, timeoutMs: 25000, desc: '把某个窗口置到前台。参数是窗口标题片段，如 focus_window|计算器。★键盘输入要生效就必须先置前台★。★它会在同名窗口里自动挑真正显示着的那个；UWP 应用可能回"显示出来了但抢不到前台"——那是部分成功，接着用 click 点它，别用键盘；若一直托不出来，先 kill_app 清僵尸实例★。' },
  { name: 'windows_list', tier: 'full', needsArg: false, timeoutMs: 25000, desc: '列出当前所有窗口（含最小化/隐藏的），并标出哪些是"隐藏窗口、不在屏幕上、不算遮挡"。★不知道目标窗口叫什么、或怀疑窗口托不出来时先用它★。' },
  /* 游戏托管（老表 game_stop/game_status 是 read） */
  { name: 'game_start', tier: 'full', needsArg: true, timeoutMs: 300000, desc: '★启动游戏托管助手：它会持续盯屏 + 自己决策 + 操作，替主人打一段游戏★。参数是任务描述，如 game_start|帮我打这次活动图。★启动时桌宠会自动收起，结束时放回来★。' },
  { name: 'game_stop', tier: 'read', needsArg: false, timeoutMs: 30000, desc: '停止游戏托管助手，把桌宠放回屏幕。' },
  { name: 'game_status', tier: 'read', needsArg: false, timeoutMs: 15000, desc: '查看游戏托管助手现在在干什么（是否在跑、跑了多久、最近的动作）。' },
];

/* ★★★ 权限档排序 + 从注册表动态生成【给模型看的工具清单】★★★
   2026-10-03 补完最后一张手写表。本文件开头的注释早就写了这件事：
     "工具的元信息散在**三张手写表**里：TOOL_TIER、NOARG、★以及给模型看的工具清单字符串★"
   前两张当时已经迁进注册表了，**第三张一直没迁** —— 后果今天被数据抓了个正着：
     · registry 里有 58 个工具（名字/权限/参数/超时/说明都全）
     · main.js 的 buildContinuePrompt 却手写了一份 39 个的字符串，
       ★漏掉了 uia_find / uia_dump / find_text / screen_diff / kill_app / flow_* /
         clickz / movez / watch_screen 等一大堆★ —— 其中 uia_find 恰恰是实测最好用的那个
     · assistant.js 给视觉模型的清单更窄，只有 move_norm / find_text / find_template 三个
   结果：**统计她 57 条动作记录，58 个工具她只碰过 9 个** ✗。
   那不是模型笨，是**没人告诉她有这些东西**。
   → 所以清单必须从注册表生成：以后加一个工具只改 TOOL_DEFS 一行，
     权限档、参数要求、超时、给模型的说明**四处同时生效**，不会再各说各话。 */
const RANK = { off: 0, read: 1, normal: 2, web: 3, full: 4 };

/* ★ 工具分组表（C4）★
   按"她要做的事"分组，每组一句导航语。
   ★为什么不只注入相关组的工具★：调研发现 token 开销不是瓶颈（full 档约 1543 tokens），
   真问题是"72 个里挑一个"太难 ✗。分组把 72 选 1 变成"先选组、再组内挑" ✓，
   而且一个工具都不少 —— 能力不丢 ✓。
   顺序即优先级：越靠前越常用（实测她用得最多的 screen_look / focus_window / click 在 1~3 组）✓ */
/* ★ 她实测用过的工具与次数（来自 chatlog 的 step 记录）—— 用来给组内排序 ★
   screen_look 44 / focus_window 34 / key 24 / type 18 / windows_list 12 /
   find_text 10 / click 9 / screen_shot 2 / find_template 2 / uia_find 2
   越是她已经会用的，越排在前面 —— 让"熟悉的东西在手边"，新的工具紧跟其后 ✓ */
const TOOL_GROUPS = [
  { name: '看屏幕 / 感知（想知道屏幕上有什么，先看这组）',
    hint: '看整屏、放大看小字、确认动作生效、列窗口、连续观察',
    re: /^(screen_look|screen_shot|screen_diff|watch_screen|windows_list)$/, order: 'screen_look screen_shot screen_diff watch_screen windows_list' },
  { name: '定位（要点某个东西之前，先用这组拿到精确坐标）',
    hint: '★非游戏应用优先用 uia_snapshot + uia_find：应用自己报的坐标，零识别误差★；其次是模板/OCR；再不行才截图看',
    re: /^(uia_snapshot|uia_find|uia_dump|find_template|find_template_scroll|find_text|make_template|template_list|template_del|search_code)$/, order: 'uia_snapshot uia_find uia_dump find_text find_template find_template_scroll make_template template_list template_del search_code' },
  { name: '操作（点 / 打 / 滚 / 拖）',
    hint: '★键盘只发给前台窗口 —— 目标不在前台就先 focus_window；UWP 抢不到前台时改用 click★',
    re: /^(click|clickz|rclick|rclickz|dclick|dclickz|move|movez|drag|scroll|type|key)$/, order: 'click clickz dclick rclick move drag scroll type key movez rclickz dclickz' },
  { name: '窗口 / 焦点 / 清理',
    hint: '把窗口弄到前面、或怀疑「窗口托不出来」（多半是 UWP 僵尸实例）时用',
    re: /^(focus_window|kill_app|wait_for)$/, order: 'focus_window wait_for kill_app' },
  { name: '文件 / 项目 / 代码',
    hint: '读改写文件、跑脚本、搜代码、检查代码；★shell_run 是常驻会话（cd/环境会保留）★',
    re: /^(read_file|write_file|list_dir|run_file|proj_ls|proj_read|proj_write|proj_run|proj_rm|proj_open|shell_run|shell_status|shell_close|check_code|open_path)$/, order: 'read_file write_file list_dir shell_run shell_status shell_close check_code search_code run_file proj_ls proj_read proj_write proj_run proj_rm proj_open open_path' },
  { name: '技能 / 记忆 / 人设',
    hint: '★做事之前先 use_skill 看有没有现成套路，比瞎试快★；把学到的沉淀成技能',
    re: /^(use_skill|skill_ls|skill_read|skill_write|skill_rm|tag_list|tag_set|tag_rm)$/, order: 'use_skill skill_ls skill_read skill_write skill_rm tag_list tag_set tag_rm' },
  { name: '提醒 / 系统 / 剪贴板 / 打开',
    hint: '定时提醒；查电量磁盘内存（单项更快）；读写剪贴板；打开网址或文件',
    re: /^(remind_in|remind_at|remind_list|remind_cancel|sys_info|clipboard_read|clipboard_write|open_url|open_path)$/, order: 'remind_in remind_at remind_list remind_cancel sys_info clipboard_read clipboard_write open_url open_path' },
  { name: '网络（受控浏览器里操作网页）',
    hint: '查资料 / 填表单：能直接读页面内容，比截屏看浏览器可靠得多',
    re: /^web_/, order: 'web_open web_read web_click web_type' },
  { name: '确定性流程 / 游戏托管',
    hint: '把跑通的动作序列存成流程重放；或让游戏助手接管（★只在主人明确要求时用★）',
    re: /^(flow_run|flow_save|flow_list|flow_del|game_start|game_stop|game_status)$/, order: 'flow_run flow_save flow_list flow_del game_start game_stop game_status' },
];

/* 生成某权限档下、给模型看的工具清单（一行一个工具） */
function buildToolList(tier, opts) {
  const o = opts || {};
  const limit = RANK[o.rank !== undefined ? o.rank : tier];
  if (limit === undefined) return '';
  const taken = new Set();
  const lines = [];
  const fmt = (d) =>
    '- ' + d.name + (d.needsArg ? '|<参数>' : '') + '  ' + (d.desc || '');
  const eligible = (d) => {
    const need = RANK[d.tier];
    if (need === undefined || limit < need) return false;
    if (o.only && !o.only.test(d.name)) return false;
    if (o.skip && o.skip.test(d.name)) return false;
    return true;
  };
  /* ★ 组内排序：按 g.order 给的常用度列表；不在列表里的排后面（保持注册表顺序）★ */
  const sortByOrder = (arr, order) => {
    const idx = String(order || '').split(/\s+/).filter(Boolean);
    return arr.slice().sort((a, b) => {
      const ia = idx.indexOf(a.name), ib = idx.indexOf(b.name);
      if (ia < 0 && ib < 0) return 0;
      if (ia < 0) return 1;
      if (ib < 0) return -1;
      return ia - ib;
    });
  };
  for (const g of TOOL_GROUPS) {
    const inGroup = TOOL_DEFS.filter((d) => eligible(d) && !taken.has(d.name) && g.re.test(d.name));
    if (!inGroup.length) continue;
    inGroup.forEach((d) => taken.add(d.name));
    lines.push('## ' + g.name);
    lines.push('#   ' + g.hint);
    for (const d of sortByOrder(inGroup, g.order)) lines.push(fmt(d));
    lines.push('');
  }
  const rest = TOOL_DEFS.filter((d) => eligible(d) && !taken.has(d.name));
  if (rest.length) {
    lines.push('## 其它工具');
    for (const d of rest) lines.push(fmt(d));
  }
  return lines.join('\n').trim();
}

/* 建一个已经装好全部工具定义的注册表 */
function withTools(base) {
  const reg = base || create();
  for (const d of TOOL_DEFS) reg.register('tool', d.name, d);
  return reg;
}

module.exports = { create, withTools, TOOL_DEFS, TOOL_GROUPS, RANK, buildToolList };
