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
  /* ★★★ 2026-10-10 语义重做：screen_look 降级为【只描述，不定位】★★★
     它原来是"视觉模型 + 归一化坐标 + move_norm 移动光标"这条链的入口 ✗ ——
     而实测结论是它"看得见但说不准"（同一列四次问出四种顺序 ✗）。
     现在这条链被拆掉了：★它的返回值里不会再有可用坐标★，
     要位置请看"定位"那一组（uia_* / find_text / find_template / find_grid / som_look）✓ */
  { name: 'screen_look', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '【看屏幕·只描述】截屏并让视觉模型**描述**看到了什么（什么界面 / 有哪些字 / 在干什么 / 有什么不寻常）。★它只回答"是什么"，不回答"在哪"★ —— 原来"让模型给归一化坐标 + 按它移动光标"的那条协议已废除（实测它"看得见但说不准"：四次问同一列得到四种顺序、问最右列答的却是别的东西）。★要点某个东西★：非游戏应用优先 uia_snapshot + uia_find（应用自报坐标）；文字用 find_text；图标模板用 find_template；网页用 web_* 。' },
  /* ★ 视觉增强三件套（2026-10-10 职业列事故催生）★
     ★ 都走视觉模型 → tier 与 screen_look 一致（full）✓
     ① icon_pick：同一格问 N 次取多数（治「单次判断会抖」✗）
     ② grid_scan：程序切格逐格问（治「一次问一整列会自相矛盾」✗）
     ③ find_grid：像素分析测出真实位置与间距（治「拿估的间距去裁会漂移」✗） */
  { name: 'icon_pick', tier: 'full', needsArg: true, timeoutMs: 90000, desc: '【认图标·抗抖】把一小块区域问视觉模型 N 次、★取多数票★，返回结论 + 票数 + 格中心归一化坐标。用法 icon_pick|<候选1,候选2,...>|<x,y,w,h>|<问几次，默认3>。★候选项要写你的目标词（如「近卫」），别让它描述图案✗（它答「双剑」你还得自己翻译 ✓）。并列/未识别 = 结论不可靠，别拿它下结论 ✗。★2026-10-10 语义★：它返回的坐标是【程序按你给的范围/格距算的】✓，但"这一格是什么"是【模型判的】✗ —— 所以坐标只能当**线索**：要点击，先用 uia_find / find_text / find_template / find_grid 复核那个位置 ✓。' },
  { name: 'grid_scan', tier: 'full', needsArg: true, timeoutMs: 180000, desc: '【逐格认】把一块区域按格子切开，★一格一格★问视觉模型（每格问多次取多数），返回编号清单 + 每格归一化坐标。用法 grid_scan|<候选1,候选2,...>|<x,y,w,h>|<格子大小，默认60>|<每格问几次，默认2>|<v竖排或h横排>。★要认「一排/一列里每个是什么」时用它，不要一次问一整列✗（实测会得到自相矛盾的顺序 ✓）。★2026-10-10 语义★：格坐标是【程序按你给的格距算的】✓、"第几格是什么"是【模型判的】✗ —— 坐标只能当线索，要点击先用 find_grid 量准几何或 uia_find / find_text 复核 ✓。' },
  { name: 'find_grid', tier: 'full', needsArg: true, timeoutMs: 45000, desc: '【量位置】像素亮度分析，测出这块里「东西在哪、间距多少」（等距会给平均间距）。用法 find_grid|<x,y,w,h>|<v竖排或h横排>|<最小段高，默认6>。★要按等距推算坐标时先量准间距，不要拿估的间距去裁✗（实测：按估的60px裁→逐格漂移→把第3、4格认成第1、2格 ✓）。⚠️细线/低对比图案测不出来（会明确说测不到 ✓），那时改用 grid_scan ✓。⚠️段数≠目标个数✗（立绘/文字也算 ✓）。' },
  { name: 'tile_read', tier: 'full', needsArg: true, timeoutMs: 180000, desc: '【重叠切块读图】把一块区域切成**带重叠**的小块（默认每块 512px、重叠 20%），逐块放大后问视觉模型同一个问题，返回每块在整屏的坐标 + 回答。用法 tile_read|<问题>|<x,y,w,h>|<格子边长,默认512>|<重叠比例,默认0.2>。★为什么不是 grid_scan★：grid_scan 是**硬切**的，格子边界会把文字切断（两边各看到半个字）；tile_read 靠重叠避免这件事。★要读一整块密集小字（表格/列表/说明）用它★。⚠️ 上限 12 块；每块只问 1 次（要抗抖动用 icon_pick）。★坐标是程序算的、内容是模型读的 → 坐标只能当线索，要点击先复核 ✓★。' },
  /* ★ ⑤ som_look（Set-of-Marks）—— 2026-10-10 接上：★改的是"回答的协议"★
     前四个治的是"把问题问准"✓；这一个治"别让模型碰坐标"✓：
     程序先框出候选并编号 ✓ → 模型只回编号 ✓ → 坐标从候选框里取（本来就有的）✓。
     参考 OmniParser v2 / Set-of-Marks / Playwright MCP 的 ref / UIA 控件树（同一条思路 ✓）。
     ⚠️ som.js 其实早就是一份完整实现（纯逻辑 + 单测 ✓），但**从来没被注册成工具**✗ ——
        所以她在对话里永远调不到它 ✓。这一行就是那个"接线"✓。 */
  { name: 'som_look', tier: 'full', needsArg: true, timeoutMs: 120000, desc: '【选编号·不估坐标】把屏幕上的候选元素（OCR 文字行 + 前台窗口的 UIA 控件）★全部画成红框并编号★，连同你的问题一起给视觉模型，★只让它回答编号★，再按编号取那个候选**本来就带的**坐标。用法 som_look|<问题> 或 som_look|<问题>||<x,y,w,h>（只在那块区域里选，坐标写法与 screen_look 的放大区域一致）。★什么时候用★：要「点哪一个」「这一排里哪个是X」时用它。★和 screen_look 的区别★：screen_look 是开放式提问（返回一段描述，或放大看细节）；som_look 返回的是「编号 → 元素身份 → 可点坐标」。★为什么比报坐标可靠★：同一个模型直接估坐标 ScreenSpot 只有 16.2%，改成「在编号框里选」是 70.5%，框里再写上框内的字（我们天然有：OCR 行文本/UIA 控件名）是 93.8% —— 实测她四次问同一列图标拿到四种顺序，就是因为开放式提问没有候选集合去锚定。⚠️ 候选只有 OCR 文字行 + UIA 控件，★没有图标检测器，所以纯图形无文字的图标（游戏职业图标）不会成为候选★，那种目标用 icon_pick / grid_scan。⚠️ 候选上限 60，超了会报错并要求缩小区域。' },
  /* ★ ⑥ strip_read —— 2026-10-10 接上：补的是「细长区域整条一起看」这一格 ✗→✓
     前五个里 tile_read 会★切块✗★（丢整条视野 ✓），screen_look 的放大★按宽度算倍数✗★，
     find_grid 只量几何不认内容 ✓ —— 三种缺都不是它 ✗，所以单开一个 ✓。 */
  { name: 'strip_read', tier: 'full', needsArg: true, timeoutMs: 60000, desc: '【细长条·整条一起读】把一条★细长区域★（一列图标 / 一列文字 / 一条列表 / 一条竖排按钮）当作**一整张图**裁出来、放大，然后**只问一次**视觉模型，返回：真实区域坐标 + 放大倍数 + 输出图尺寸 + 模型的回答。用法 strip_read|<问题>|<x,y,w,h>|<放大倍数，默认自动>|<最长边上限，默认2000>，例：strip_read|这一条里从上到下有什么|1800,60,120,1030。★什么时候用它★：目标是**细长**的、且要「整条一起看」才能排出相对顺序时（哪一列的第几个是什么）。★和 tile_read 的区别★：tile_read 会把区域**切成多块分别问**，适合读一大块密集小字，但**丢掉了整条一起看的视野**；strip_read **不切块**，整条在一张图里、一次问完，所以同一列/同一行的相对顺序是可信的。★和 screen_look 放大的区别★：那个是**固定 3 倍、只按宽度算**（100x1030 的竖条会变成 300x3090：倍数不可调、高度随长度爆掉、没有像素上限），strip_read **宽高分别算预算、但保持比例**，倍数可给可不给，并且有像素总量上限保护。⚠️ ★读得清不等于坐标准★：整条一起看 → 相对顺序可信；但**像素级坐标不可信**，要精确位置仍须用 find_grid（量间距）/ find_template / uia_find（控件树）。⚠️ 只问一次，要抗单次抖动用 icon_pick；放大后像素总量超上限会自动降倍数并说明。★它返回的区域坐标和倍数是程序算的 ✓，但"这一条里从上到下是什么"是模型读的 ✗ → 要精确位置仍须 find_grid / 模板 / uia_find ✓★。' },
  { name: 'screen_shot', tier: 'full', needsArg: false, timeoutMs: 30000, desc: '截一张全屏图' },
  /* ★★★ 2026-10-10：按 DSH 的架构约定补的两件（主人："你就不能老老实实根据 DSH 来搞吗！"）★★★
     ★DSH 的视觉真相（对照文档 DSH-对照.md §1.5，行号证据 ✓）：它**完全没有**视觉/截图/计算机操作 ✗
     （`computerUse` 只在 api-catalog.js:604-606 作为**能力接口声明**出现 ✓，全仓库无 provider ✓）。
     → 所以"照 DSH 改视觉"**没有可抄的实现**✗，能抄的是它的**架构约定**✓：
        ★模型只做"选择"，永不产出坐标 ✗→✓；工具失败要结构化、不炸步 ✓★。
     这两件就是按这个约定补的：①按进程截窗口（拿到 windowBounds ✓）
     ②用**确定性像素算法**数格子（模型完全不参与"在哪" ✗）。 */
  { name: 'win_shot', tier: 'full', needsArg: true, timeoutMs: 120000, desc: '【按进程截那一个窗口】调 MCP desktop-auto 的 bot_screenshot：★只给那一个窗口的图 + 精确 windowBounds★（图落盘可复查 ✓）。用法 win_shot|<进程名，如 Arknights>|<activate，可选>。★拿到 windowBounds 的意义★：窗口内坐标 ↔ 整屏坐标 ↔ 你的坐标空间全变成算术 ✓，还能直接出"窗口内 bbox 0~1000"喂给 bot_click ✓。★★真机实测的两条实话✗★：①这台机器上它返回的其实是**整屏图**（实测 1920×1080 vs 窗口 1536×864，与整屏截图逐像素平均差 1.7/255 ✓）→ 本工具**自己按 windowBounds 裁**（裁完尺寸会断言 ✓）；②★它挡不住遮挡★（走的是"抓屏幕再按窗口矩形裁"✓，别的窗口盖在上面照样拍进去 ✓）→ ★要干净画面必须 win_shot|<进程>|activate★（先把那个窗口提到最前 ✓）。⚠️ 返回的是 **JPEG（q100）**★，不是无损 ✗。' },
  { name: 'grid_count', tier: 'full', needsArg: true, timeoutMs: 120000, desc: '【数格子·确定性】★一列/一行上有几个等距格子、各自中心在哪★ —— 纯像素计算，★模型不参与定位✗★。用法 grid_count|<图片路径 或 进程名>|<v竖|h横>|<x,y,w,h 可省>|<期望个数 可省>。★它和 find_grid 的区别（真机实测）★：find_grid 用"整行平均亮度 + 全局阈值"✗，在**深色图标压深色背景**上量不出东西（实测职业列只测到 1 段 ✗）；本工具用 ★局部对比度能量（对深色压深色一视同仁 ✓）+ 抗异常值阈值（中位数+MAD ✓）+ 谐波投票估格距 + 残差判定 ✓★ —— 实测明日方舟右侧职业列 ★9 格、格距 115.6px、残差 5.8% ✓★。★输出★：每格中心（标注"测到的/推算补的/不在主格距上的"✓ 三种都如实标 ✗不混）+ 格距/残差 + 可信度结论（不可信会明说 ✗）。给进程名时还会顺带把每格换算成 ★你的坐标空间坐标★ 和 ★bot_click 用的 bbox 0~1000★ ✓。⚠️ **只给几何**✗："第几格是哪个职业"是外部知识 ✓（顺序见技能 ✓）；它不猜含义、不给建议 ✗。⚠️ 期望个数凑不出来时会**明说凑不出来**✓，不会编 ✗。' },
  /* ★★★ icon_lib（2026-10-10）：★认图标 = 几何(grid_count) + 模板库(iconlib)★ ✗→✓ ★★★
     为什么需要它：游戏里那列职业图标是**纯图形、没文字、不在控件树里**✗ → find_text / uia 都看不见 ✓；
     grid_count 只说"格子在哪"（实测 9 格 / 115.7px / 残差 4.6% ✓）；find_template 一遇亮度/缩放/JPEG 变化就掉分 ✗。
     → 本工具：★切格 → 每格和模板库比 → 得到名字 + 分数 ✓，位置和名字都不经过模型 ✗✓★
       （模型只负责给"名字那一串"这个外部知识 ✓）。 */
  { name: 'icon_lib', tier: 'full', needsArg: true, timeoutMs: 120000, desc: '【图标模板库·认图标】★把纯图形图标变成"可复用的模板库"，以后认图标=切格+比模板★（★位置由几何给 ✓、名字由模板库给 ✓，模型不需要报坐标✗★）。三种用法：① icon_lib|save|<图或进程名>|<库名>|<v|h>|<x,y,w,h 可省>|<期望格数 可省>|<名字按从上到下的顺序、逗号分隔> —— ★截一次、切 N 格、每格存一个模板★（名字可给人给的 ✓，不给就是 #序号 ✓）；② icon_lib|match|<图或进程名>|<库名>|<v|h>|<x,y,w,h 可省>|<期望格数 可省> —— ★逐格报告"匹配到哪个模板 + 分数 + 领先第二名多少"★，★匹配不到就如实说"没匹配上" ✗ 不硬凑 ✓★；③ icon_lib|list|<库名> 看库里有什么。★模板文件名**带位置序号**（t03_狙击.png ✓）★：序号是几何给的 ✓、名字是人给的 ✓，分开存 —— 免得再出现"名字写着狙击、其实是近卫那一格"✗（今天真出过 ✓）。★抗变化★：灰度 z-score 归一化（对整体亮度/对比度免疫 ✓）+ 多尺度（0.85~1.15 ✓）+ NCC 打分 + dHash 粗筛 ✓，纯 Node 零编译 ✓。⚠️ ★名字只有你给的那串里有✗★：它**不猜含义** ✓（"第几格是哪个职业"是外部知识 ✓，顺序见技能 ✓）。⚠️ 库存在 userData/iconlib/<库名>/ ✓。' },
  /* ★★★ 2026-10-10：点击的两道保险（find_owned / click_checked）★★★
     主人亲眼看到的两个根因 ✗：① 屏幕上有**四处**「编辑队列」（(893,337) 会客室的 ✓ / (893,605) 制造站1 的 ✗ /
     (893,820) 制造站2 的 ✗ / (322,791) **聊天窗口里主人的字** ✗）→ 她"取第一个/就近取"✗ →
     点到了制造站1 的按钮 ✓；② 点完只凭"屏幕变了"就算成功 ✗ → 接着在一个不存在的"确认"按钮上反复找 ✓。
     → ① find_owned：候选由确定性工具给（find_text / find_template / grid_count / icon_lib ✓），
       再用**几何**把候选归属到房间标题（同列 + 卡片向下堆叠 = "上方最近标题" ✓；有卡片矩形时用包含关系 ✓）；
       归属**确定不了就报"不确定"并列出候选清单** ✗ 绝不硬选 ✓；模型不许给坐标 ✗。
      ② click_checked：★调用方必须先声明"什么叫成功"★（点后必须出现的文字 ✓），
       它做"点前检查 → 点 → 点后抓帧核对判据 + 记 before/after 像素差"✓；
       ★判据不满足就如实报失败 ✗ 不许在附近反复试 ✓；"屏幕有变化"永远不能单独当成功证据 ✗★。 */
  { name: 'panel_state', tier: 'read', needsArg: false, timeoutMs: 60000, desc: '【我现在在哪个面板】★用"只在某个面板出现"的指纹词判定当前面板★（词是真机实测出来的 ✓）—— ★这是"卡在一个根本不存在的按钮上反复找"的根治✗→✓★：先确认面板 ✓ 再在这个面板里找按钮 ✓。用法 panel_state|expect=<面板名，可省>|img=<图，可省>。面板名：base（基地视图：编辑队列/进驻上限/干员信息/控制中枢/队列轮换 ✓）、select（选人面板：清空选择/确认/进驻状态/信赖值/收起> ✓）、queue（进驻队列面板：当前进驻/房间2/12 ✓）、dsh（★桌宠自己的窗口，不是游戏✗★：对话/轨迹/深度求索 ✓）。★证据不足（命中 <2 个词）就报 unknown ✗ 不瞎猜 ✓★；给了 expect 会明说"和你要的面板不一致 ✗ → 先切过去再来 ✓"。' },
  { name: 'find_owned', tier: 'full', needsArg: true, timeoutMs: 90000, desc: '【点前·确认归属】★要点的文字在屏幕上出现了好几处时，先用**几何**算出它属于哪个容器★（例如「编辑队列」属于「会客室」卡片 ✓）—— ★不许模型给坐标✗★。用法 find_owned|<要点的文字，如 编辑队列>|<容器/标题关键词，如 会客室>|img=<图，可省>|region=x,y,w,h（可省）。★判据（实测调出来的）★：候选先按**标题列 x 带**过滤（不在这一列的 → 多半在别的窗口里 ✗，例如主人聊天窗那处 ✓），再配给**它上方最近的标题** ✓（卡片从上往下排 ✓；★不能用"最近"✗——(893,337) 离制造站更近，那样就会配错 ✓）。输出：候选清单（每个的中心/框）+ 归属结论 + ★点击坐标★ + 被排除的及其理由 ✓；★归属不唯一/太远/有歧义时明确报"不确定" ✗ 绝不硬选 ✓★（那时请把 region 收窄、或换更明确的容器关键词 ✓）。⚠️ 它**只报告不动鼠标** ✓。⚠️ 空间：坐标已换算成她的坐标空间 ✓。' },
  { name: 'click_checked', tier: 'full', needsArg: true, timeoutMs: 120000, desc: '【带判据的点击·推荐用这个】★点前确认归属 + 点击 + 点后核对"调用方声明的成功判据"★ —— ★两道保险齐全✓★。用法 click_checked|<要点的文字>|<容器/标题关键词>|<成功判据，逗号分隔（点后画面里**全部**要出现）>|dry=1（只算不点 ✓）|expect=<面板名，强烈建议给 ✓>|img=<点前图>|after=<点后图>|region=x,y,w,h。★★两道新闸门（2026-10-11 真机失败模式催生的）★★：⓪ **expect 面板闸门**：先判当前面板 ✓，★不是你要的面板就一个都不点✗★（她现在会卡在"这个面板里根本没有的按钮"上反复找 ✓ —— 那是"不知道自己在哪个面板"造成的 ✓）；① **判据自检**：★判据词如果**点之前**就出现在画面里 → 直接拒绝点击✗★并给建议判据 ✓（实测「会客室」点前就有 before=3 ✓ 用它=点错了也判成功 ✗；而「当前进驻」before=0/after=1 ✓ 才是合格判据 ✓）。★必须给判据✗★。执行：⓪面板 → ①判据自检 → ②归属检查（不唯一→★一个都不点✗★）→ ③点 → ④抓帧核对判据 + 记 before/after 像素差 ✓。★判据不满足 → 如实报失败 ✗ 不要在附近反复试 ✓；屏幕"变了"不算成功 ✗（点错房间也会变 ✓）★。' },
  { name: 'icon_scan', tier: 'read', needsArg: true, timeoutMs: 120000, desc: '【切图标·给每格中心】★把画面上每个图标切出来，逐格给出中心坐标★。两模式自动选并在回执里说明依据 ✓：★A 规则排列★（格距+相位+**质心细化** ✓，一列等距图标走这条 ✓）／★B 不规则摆放★（连通域+尺寸/长宽比过滤+重叠合并 ✓）。用法 icon_scan|<图或进程名>|region=x,y,w,h|mode=auto|expect=格数|ocr=1（逐格裁剪放大 3 倍再 OCR ✓）|max=列几个。★输出清单★：id / 中心 cx,cy / w,h / ★space（physical|dip + 依据）★ / source（lattice|blob）/ text / textConf（★近似值：Windows OCR 不给逐词概率 ✓ 已如实标注 ✓★）。★坐标只由几何与像素算出✗——模型不参与任何坐标 ✓★。⚠️ 文字：认得就给文本、"没读出"就如实说没读出 ✗ 绝不瞎编 ✓。⚠️ 它**只给清单不点击** ✓ —— 要点击请用 locate → act ✓。★★路由结论（2026-10-11 真机实测 ✓ **定性结论**，★精度数字待补✗★）：**遇到"规则图标列"（如游戏右侧职业列）走格距/相位（模式 A / lattice）✓，不要走连通域（模式 B / blob）✗** —— 真机职业列实测：A 给出**干净 9 格、格距 113.8px** ✓（格数与已知 9 一致 ✓），B **碎成 26 块** ✗（碎片化 ✓）。★这只是"哪条路给干净分割"的定性对照✗：两路在 ≤2px / ≤6px 下的通过率**还没有可引用数字**（真值闸门未过 + 原帧该列被窗口遮挡 75.5% ✓ 均已如实记录 ✓）★。' },
  { name: 'watch_screen', tier: 'full', needsArg: true, timeoutMs: 180000, desc: '连续看屏幕并给逐帧时间线' },
  { name: 'screen_diff', tier: 'full', needsArg: true, timeoutMs: 30000, desc: '抓两帧做像素比对：界面到底变没变（确定性，不靠视觉模型）' },
  /* ★ 剪贴板（A3）：5 行 API 就能做，不必接 MCP ✓ ★ */
  { name: 'clipboard_read', tier: 'normal', needsArg: false, timeoutMs: 15000, desc: '读系统剪贴板里的文本。★主人说"复制了…"、"我刚复制的那个"时用它★；剪贴板为空或不是文本会说明。' },
  { name: 'clipboard_write', tier: 'normal', needsArg: true, timeoutMs: 15000, desc: '把一段文本写进系统剪贴板（支持多行、中文）。参数就是文本本身。★写完要提醒主人"已经复制好了，去 Ctrl+V"★。' },
  /* ★ 轮询等条件（A4）：治"没验证就重试"的顽疾 ✓ ★ */
  { name: 'wait_for', tier: 'full', needsArg: true, timeoutMs: 130000, desc: '轮询等一个条件成立（比"固定睡 N 秒"可靠）。格式 wait_for|<类型>|<目标>|<超时秒>：window|<标题片段>|8 / element|<窗口标题>|<控件名>|8 / text|<画面上的文字>|8 / change|8（等画面变化）。★超时会告诉你最后一次检查到什么★。' },
  { name: 'kill_app', tier: 'full', needsArg: true, timeoutMs: 20000, desc: '结束同名进程的【多余实例】（UWP 僵尸：反复开关应用会攒出多个实例，导致窗口托不出来）' },
  { name: 'uia_find', tier: 'full', needsArg: true, timeoutMs: 45000, desc: 'UIA 控件树：按元素名字/AutomationId 精确拿坐标（非游戏应用，零识别）' },
  { name: 'mcp_list', tier: 'normal', needsArg: false, timeoutMs: 120000, desc: '【MCP】列出配好的 MCP 服务器；给服务器名就列出它的工具（★会顺手把它启动起来✗★，首次要下载包可能 1~3 分钟 ✓）。用法 mcp_list 或 mcp_list|<服务器名>。★实测 @playwright/mcp 有 25 个工具，含 browser_find（在可访问性快照里搜文字，点元素不需要坐标）★。⚠️ 本机只能跑 Node 写的 server（python 是商店占位符、没有 uvx/go）✓。' },
  { name: 'mcp_call', tier: 'normal', needsArg: true, timeoutMs: 180000, desc: '【MCP】调用某个 MCP server 的工具。用法 mcp_call|<服务器名>|<工具名>|<JSON参数>。★网页任务优先用它★：例如 mcp_call|playwright|browser_navigate|{"url":"..."} 然后 browser_find 找元素 —— ★比看像素猜坐标可靠得多★。⚠️ 参数必须是合法 JSON ✓。' },
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
  { name: 'click', tier: 'full', needsArg: true, timeoutMs: 15000, desc: '在屏幕坐标点一下左键。参数 <x>,<y>（整屏像素，左上原点）。★要按按钮/控件时优先用 uia_find 拿精确坐标再点，比看图猜准得多★。★点击前请先 find_owned 确认这个坐标**属于谁**（屏幕上有多个同名文字时最容易点错 ✓），或直接用 click_checked（带归属检查+点后判据 ✓）★。执行前后有安全断言（目标是否被遮挡、前台对不对）。' },
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
  /* ★★★ 2026-10-10 分组重做：把"看图"和"定位"**彻底分开** ★★★
     原因（主人的原话是"把视觉模型删掉重做"）：实测视觉模型**不能参与定位** ——
       四次问同一列得到四种顺序 ✗、问最右列答的却是别的东西 ✗、报坐标同处两次差上千像素 ✗。
     → 所以「定位」这一组★只放确定性来源★（控件树 / OCR 包围盒 / 像素模板 / 像素量距 / 模板）；
       "看图"那组明确写着★只描述、不产生"该点哪"★。
     ★这一条比提示词管用★：她读的工具清单直接从这张表生成（见 buildToolList ✓），
       组名和组内导航语就是她的行动规则 ✓。 */
  { name: '看屏幕 / 感知（★模型只"描述"，不给位置★）',
    hint: '看整屏、放大看小字、确认动作生效、列窗口、★按进程截那一个窗口（win_shot，遮挡时加 activate ✓）★；★要"在哪/点哪"请去下一组（那组全是确定性来源）★',
    re: /^(screen_look|screen_shot|screen_diff|watch_screen|windows_list|win_shot|icon_pick|grid_scan|tile_read|strip_read|som_look)$/,
    order: 'screen_look win_shot screen_shot screen_diff watch_screen windows_list som_look strip_read icon_pick grid_scan tile_read' },
  { name: '定位（★只有确定性来源 —— "在哪"的答案只许从这一组来★）',
    hint: '★非游戏应用优先 uia_snapshot + uia_find：应用自己报的坐标，零识别误差★；其次是模板 / OCR / 像素量距（find_text / find_template / grid_count 数格子 / icon_lib 认图标 / find_grid）；★要点击时先 find_owned 确认归属、或用 click_checked 连判据一起做 ✓★',
    re: /^(uia_snapshot|uia_find|uia_dump|find_template|find_template_scroll|find_text|make_template|template_list|template_del|find_grid|grid_count|icon_lib|find_owned|click_checked|search_code)$/, order: 'uia_snapshot uia_find uia_dump find_text find_template find_template_scroll grid_count icon_lib find_grid find_owned click_checked make_template template_list template_del search_code' },
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
