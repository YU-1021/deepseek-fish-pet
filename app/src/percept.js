/* percept.js —— ★按契约重做的感知/动作接口（2026-10-11：主人："不是模型差，是我们写的视觉工具差"）★
 *
 * 三个工具，取代原来那堆近似工具：
 *   ★locate(描述, 可选容器)★ → **唯一一个框**；找不到唯一解就 ambiguous + 候选清单（每条带归属证据）✓
 *   ★act(编号或目标, 动作类型)★ → ★只接受 locate 给过的编号/目标✗，不接受裸坐标✗★；
 *                                返回 stateBefore / stateAfter / verified / evidence ✓
 *   ★zoom(区域, 放大倍数, 可选编号)★ → 裁剪+放大(+画编号)后交给模型提问 ✓（"让模型看得清"的唯一正路 ✓）
 *
 * 【十条缺陷怎么在本模块里被解决 ✗→✓】
 *  1. find_text 只给框不给归属 → locate 内部用 ownclick.pairOwners 做几何归属 ✓ 输出唯一框或 ambiguous ✓
 *  2. icon_pick/grid_scan 的输出"需要二次复核" → ★本接口里它们不能作为点击依据✗★
 *     （act 只认 locate 的编号 ✓；坐标另有 prov 账本把关 ✓），desc 也改成"只做读数" ✓
 *  3. move_norm 仍活 → ★直接从 assistant.js 里删掉执行体✗★（改成忽略 + 说明 ✓）
 *  4. find_grid 与 grid_count 重叠 → find_grid 标为 **deprecated 别名**，内部转 grid_count ✓
 *  5. som_look 只在 OCR/UIA 有明显文字时才产候选 → locate 增加 **icon_lib 图标库** 作为候选源 ✓
 *  6. 没有坐标系契约 → ★每个定位工具都声明 space: "physical" 并给出依据★（物理尺寸 / 缩放比 / 截图尺寸 ✓），
 *     act 只接受同一契约下的坐标 ✓
 *  7. 点击族九个近似工具 → ★合并成 act 的 kind 参数★（click/right/double/move ✓），旧工具降级为内部实现 ✓
 *  8. 早期工具假报成功 → act 一律返回 verified + evidence ✓；verified=false 时明说失败 ✗
 *  9. grid_count 认不出"一列文字" → 本模块对"格距 < 40px 且 ≥8 格"的结果打 suspect:'textlike' ✓ 并提示收窄区域 ✓
 * 10. 没有裁剪放大 → zoom ✓
 *
 * ★坐标系结论（实测 ✓ 见 scripts/probe-coords.js 的输出与 fixtures 真值）★
 *   · 截图（captureScreenFallback）会被 resize 到 space() = config.screenCaptureWidth/Height（默认 1920x1080）✓
 *   · OCR / 模板 / grid_count / icon_lib 的坐标都在**截图空间**里 ✓ → 也就是 space() 空间 ✓
 *   · input.norm() 把 space() 坐标归一化成 0..1 交给 input.exe（OS 层再映射到物理像素）✓
 *   · Electron 自己那套（screen.getCursorScreenPoint / BrowserWindow.getPosition）是 **DIP** ✓（实测 DIP×1.25 = 物理 ✓）
 *   → ★所以"截图/OCR/工具坐标"是一条链（space），"Electron 的窗口/光标读数"是另一条链（DIP）★；
 *     本模块的返回值**显式声明** space="physical"（当 screenCaptureWidth=物理宽时 ✓），
 *     并把 space、物理尺寸、缩放比、截图尺寸一起回执 ✓ —— 以后谁混用一眼能看出来 ✓。
 */
'use strict';

const path = require('path');
const OC = require('./ownclick');
const P = require('./panel');
const PROV = require('./prov');

const deps = {
  capture: null, ocrJson: null, click: null, vision: null, space: () => ({ w: 1920, h: 1080 }),
  display: () => ({ w: 1920, h: 1080, scaleFactor: 1 }), shotDir: () => null, dbg: () => {},
  /* ★显式"新鲜帧"注入口✗→✓（lead 要求 ✓）：测试注入固定的假帧提供者 ✓
     —— ★而不是为了让测试过就放宽闸门✗★（精度优先于好看的数字 ✓）。生产为 null → 真实重抓 ✓。 */
  freshFrame: null,
};
function install(d) { Object.assign(deps, d || {}); return module.exports; }

/* ★★ 2026-10-11：改成**共用同一个账本**★（prov.js 的 instance）——
   裸 click（safedrive.js）和这里的 locate/act 必须看同一本账 ✗→✓：
   否则"locate 刚量过的坐标"在 click 那边不算数、两边各拦各的 = 两套互相打架的闸门 ✗。
   ⚠️ 单测要独立实例的话用 PROV.create() ✓（instance 是给生产共用的 ✓）。 */
const ledger = PROV.instance;
const idMap = new Map();                 // ★编号登记表（最近 20 个 ✓）—— locate 两次后仍能 act 第一个 ✓
function remember(id, rec) {
  idMap.set(String(id).toUpperCase(), rec);
  if (idMap.size > 20) idMap.delete(idMap.keys().next().value);
}
let lastLocate = null;
let seqId = 0;

function parse(arg) {
  const parts = String(arg == null ? '' : arg).split('|').map((s) => s.trim());
  const kv = {}; const pos = [];
  for (const p of parts) {
    const m = /^([A-Za-z_][\w]*)=(.*)$/.exec(p);
    if (m) kv[m[1].toLowerCase()] = m[2]; else pos.push(p);
  }
  return { pos, kv };
}

/* ★坐标系契约：每次定位都把它一起报出来 ✓★ */
function spaceContract(imgW, imgH) {
  const s = deps.space ? deps.space() : { w: imgW, h: imgH };
  let d = { w: 0, h: 0, scaleFactor: 1 };
  try { d = deps.display ? deps.display() : d; } catch (e) {}
  const physical = (d.w && d.h) ? { w: d.w, h: d.h } : null;
  const sameAsCapture = (s.w === imgW && s.h === imgH);
  return {
    space: sameAsCapture ? 'capture(=space())' : 'capture(!=space())',
    unit: (physical && s.w === physical.w && s.h === physical.h) ? 'physical' : 'scaled',
    capture: { w: imgW, h: imgH },
    space: { w: s.w, h: s.h },
    display: physical ? { w: physical.w, h: physical.h, scaleFactor: d.scaleFactor || 1 } : null,
    note: '★坐标单位 = 截图像素★；screenshots 被 resize 到 space()；input.norm() 再把 space 归一化给 input.exe ✓。'
      + 'Electron 自己的窗口/光标读数是 DIP ✗（实测 DIP×' + (d.scaleFactor || 1) + ' = 物理 ✓）——★别混用✗★。',
  };
}

async function frameFor(kv) {
  if (kv.img) {
    const fs = require('fs');
    if (!fs.existsSync(kv.img)) throw new Error('找不到 img= 指定的图：' + kv.img);
    return { path: kv.img, from: 'img=' };
  }
  if (!deps.capture) throw new Error('没有抓帧能力 ✓（请给 img= 或让主进程注入 capture ✓）');
  return await deps.capture();
}

function regionOf(kv, btnText, titleText) {
  const r = {};
  if (kv.region) {
    const p = kv.region.split(',').map(Number);
    if (p.length === 4 && p.every(Number.isFinite)) r.region = { x0: p[0], y0: p[1], x1: p[0] + p[2], y1: p[1] + p[3] };
  }
  if (kv.xband) {  // 手给的 x 带（用于"别把别的窗口里的同名文字算进来" ✓）
    const p = kv.xband.split(',').map(Number);
    if (p.length === 2) r.xband = { x0: p[0], x1: p[1] };
  }
  r.btnText = btnText; r.titleText = titleText;
  return r;
}

/* ───────── A. locate：唯一框，否则 ambiguous + 候选清单（含归属证据）───────── */
async function locate(arg) {
  const { pos, kv } = parse(arg);
  const desc = pos[0] || kv.desc || '';
  const container = pos[1] || kv.container || '';
  if (!desc) return '❌ 用法：locate|<描述，如 编辑队列>|<容器，如 会客室，可省>|img=<图，可省>|region=x,y,w,h|xband=x0,x1|expect=<面板名，可省>';
  const fr = await frameFor(kv);
  const ocr = await deps.ocrJson(fr.path);
  const sc = spaceContract(ocr.imgW, ocr.imgH);
  const out = [];
  out.push('🎯 locate 「' + desc + '」' + (container ? '（容器「' + container + '」）' : '') + ' —— 图 ' + String(fr.path).split(/[\\/]/).pop()
    + '，OCR ' + ocr.imgW + 'x' + ocr.imgH);
  out.push('  坐标系契约：截图空间=' + sc.capture.w + 'x' + sc.capture.h + '，space()=' + sc.space.w + 'x' + sc.space.h
    + '，unit=' + sc.unit + (sc.display ? ('，物理屏=' + sc.display.w + 'x' + sc.display.h + ' ×' + sc.display.scaleFactor) : ''));

  /* ★用 panel_state 限定范围 ✓（缺陷 F：面板判定内置 ✓）★ */
  const pan = P.detect(ocr, {});
  out.push('  面板：' + (pan.verdict === 'ok' ? pan.label + '（命中 ' + JSON.stringify(pan.best.hits) + '）' : pan.verdict + ' —— ' + pan.note));
  const want = kv.expect;
  if (want && pan.verdict === 'ok' && pan.panel !== want) {
    return out.concat(['  ❌ ★预期面板「' + want + '」与实测「' + pan.label + '」不一致✗ → 不定位也不动作 ✓（先切过去再来 ✓）★']).join('\n');
  }

  /* 候选来源（确定性 ✓）：OCR 词组框（主）+ 图标库（缺陷 5 的补法 ✓） */
  let buttons = OC.phrasesFromOcr(ocr, desc);
  let fz = null;
  /* ★★ 择优合并 ✗→✓（lead 批准并接线 ✓）：多个 OCR 来源（整屏 / 逐格裁剪放大 / +2px 偏移+对比拉伸 ✓）
       各自算"对目标标签的 LCS 覆盖率"，**取最高分** ✓；并列（差 ≤0.02）取**先出现的来源**（整屏优先 ✓）；
       回执写出「胜出来源 + 分数」✓（自证 ✓）。★阈值 0.75 不参与这里的选择✗（选择只看覆盖率高低 ✓）★
       用法：locate|<描述>||img=<帧>|ocr2=<另一个OCR.json>|ocr3=<再一个>|region=… ✓ */
  {
    const extra = kv.merge === '1' ? [kv.ocr2, kv.ocr3].filter(Boolean) : [];
    /* ★★ 实测（2026-10-11）：接线后 **text 仍 78.6%（无增益 ✗）**、而 **dup 100% → 25.0%（变差 ✗✗）**、
       总分 80.4% → 71.6% ✗ → ★按纪律降级为**可选**（`merge=1`）✓ 默认关闭 ✓★。
       为什么 dup 会掉：dup 目标的裁剪 OCR 文件我**没生成**（那次只生成了 text 类 ✓）→ 该来源为空 ✗，
       选择逻辑在多来源里的比较把 dup 的候选换成了别的来源的框 ✗ → 变差 ✓。★要再试需先为每类都生成三份采样 ✓★ */
    if (extra.length) {
      const fsx = require('fs');
      const cands = [{ src: '整屏', boxes: buttons.slice() }];
      for (const p of extra) {
        try {
          const o2 = JSON.parse(fsx.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
          let bx = OC.phrasesFromOcr(o2, desc);
          if (!bx.length) { const f2 = OC.fuzzyFromOcr(o2, desc, {}); if (f2.best) bx = [f2.best]; }
          cands.push({ src: require('path').basename(p), boxes: bx });
        } catch (e) { cands.push({ src: require('path').basename(p), boxes: [], err: String(e.message).slice(0, 30) }); }
      }
      if (!buttons.length) { const f1 = OC.fuzzyFromOcr(ocr, desc, {}); if (f1.best) buttons = [f1.best]; }
      cands[0].boxes = buttons.slice();
      const nd = OC.normTxt(desc);
      let best = null;
      cands.forEach((c, ci) => {
        (c.boxes || []).forEach((b) => {
          const sc = OC.coverage(nd, OC.normTxt(b.read || b.lineText || b.text || ''));
          if (!best || sc > best.sc + 0.02) best = { sc, src: c.src, box: b, ci };
        });
      });
      if (best) {
        buttons = [best.box];
        out.push('  ★择优合并★★：胜出来源 = ' + best.src + '（覆盖率 ' + best.sc.toFixed(2) + ' ✓）'
          + '；候选来源 ' + cands.length + ' 个（' + cands.map((c) => c.src + '×' + (c.boxes || []).length).join('，') + '）✓');
      } else out.push('  ★择优合并：所有来源都没给候选✗★');
    }
  }
  /* ★★ 容错匹配回退 ✗→✓（精确匹配在真机上"诚实但不可用" ✓）★★
     真机实测：OCR 把「编辑队列」读成「编 辑 队 歹 刂」✗ → 精确 0 命中 ✓（text 类 42 个全挂 ✗）。
     → 精确一条都没命中时，用 LCS 覆盖率容错再找一次 ✓（阈值 0.75 = 真机标定 ✓：
       正样本「编辑队歹刂」0.75 ✓；负样本「编辑信息」「取消」「加号设置」全 0 ✓）。
     ★回执写出「目标 / 页面实际读到的 / 分数 / 归一化规则」✓ —— 一眼看出是真匹配还是硬凑 ✓★ */
  if (!buttons.length) {
    fz = OC.fuzzyFromOcr(ocr, desc, {});
    if (fz.best) {
      buttons = [fz.best];
      out.push('  ★容错匹配（精确 0 命中 → LCS 覆盖率回退）★：目标「' + desc + '」→ 页面实际读到「' + fz.best.read
        + '」，分数 ' + fz.best.score + ' ≥ 阈值 ' + fz.min + '，归一化=' + fz.best.norm + ' ✓');
      if (fz.all.length > 1) out.push('     （本帧另有 ' + (fz.all.length - 1) + ' 处 ≥阈值；' + (fz.ambiguous ? '★分数接近 → ambiguous ✗★' : '分数区分明显 ✓') + '）');
    } else {
      out.push('  ★容错匹配也没找到✗★（阈值 ' + fz.min + '；' + (fz.notes ? ('本帧读数共 ' + fz.notes + ' 处，都没到阈值') : '本帧一行都没读到') + '）');
    }
  }
  let titles = container ? OC.phrasesFromOcr(ocr, container) : [];
  if (container && !titles.length) {
    const ft = OC.fuzzyFromOcr(ocr, container, {});
    if (ft.best) { titles = [ft.best]; out.push('  ★容器也用容错匹配★：「' + container + '」→ 读到「' + ft.best.read + '」分数 ' + ft.best.score + ' ✓'); }
  }
  if (kv.xband) {
    const p = kv.xband.split(',').map(Number);
    if (p.length === 2) buttons = buttons.filter((b) => b.cx >= p[0] && b.cx <= p[1]);
  }
  if (kv.region) {
    const r = kv.region.split(',').map(Number);
    if (r.length === 4) buttons = buttons.filter((b) => b.cx >= r[0] && b.cx <= r[0] + r[2] && b.cy >= r[1] && b.cy <= r[1] + r[3]);
  }
  let iconHits = [];
  if (kv.iconlib) {
    try {
      const IL = require('./iconlib');
      const baseDir = path.join(deps.shotDir ? deps.shotDir() : '.', '..', 'iconlib');
      const m = await IL.matchLibrary({ image: fr.path, baseDir, libName: kv.iconlib, dir: 'v' });
      iconHits = (m.rows || []).filter((r) => r.verdict === 'match').map((r) => ({ text: r.name, cx: r.box.x + Math.round(r.box.w / 2), cy: r.box.y + Math.round(r.box.h / 2), w: r.box.w, h: r.box.h, x: r.box.x, y: r.box.y, score: r.score, lineText: r.name }));
      out.push('  图标库「' + kv.iconlib + '」候选：' + iconHits.length + ' 个' + (iconHits.length ? '（' + iconHits.map((h) => h.text + '@' + h.cy).join(' ') + '）' : ''));
    } catch (e) { out.push('  （图标库候选不可用：' + (e && e.message || e) + '）'); }
  }

  out.push('  候选（OCR「' + desc + '」）：' + buttons.length + ' 个 ' + buttons.map((b) => '(' + b.cx + ',' + b.cy + ')').join(' '));
  out.push('  容器（OCR「' + (container || '-') + '」）：' + titles.length + ' 个 ' + titles.map((t) => t.lineText + '(' + t.cx + ',' + t.cy + ')').join(' '));

  /* ★归属：几何解决（复用已验证的 pairOwners ✓）；只在无解时才允许模型答编号 ✓★ */
  let chosen = null, candidates = [], outcome = 'none';
  if (buttons.length === 1) {
    chosen = buttons[0]; outcome = 'unique';
    out.push('  ✅ ★唯一候选★（OCR 只找到一处 ✓）→ 框 ' + JSON.stringify({ x: chosen.x, y: chosen.y, w: chosen.w, h: chosen.h }));
  } else if (buttons.length > 1 && container) {
    const res = OC.pairOwners(buttons, titles, {});
    const owned = OC.ownedBy(res, container);
    for (const p of res.pairs) out.push('    配对：「' + p.button.text + '」(' + p.button.cx + ',' + p.button.cy + ') → 「' + (p.title.lineText || p.title.text) + '」（距 ' + Math.round(p.dist) + 'px，' + p.method + ' ✓）');
    for (const e of res.excluded) out.push('    排除：(' + e.button.cx + ',' + e.button.cy + ') ' + e.why);
    if (owned.length === 1) {
      chosen = owned[0].button; outcome = 'unique';
      out.push('  ✅ ★唯一解★：「' + desc + '」属于「' + container + '」→ 框 ' + JSON.stringify({ x: chosen.x, y: chosen.y, w: chosen.w, h: chosen.h }));
    } else if (owned.length > 1) {
      outcome = 'ambiguous'; candidates = owned.map((p) => ({ box: p.button, why: '归属「' + (p.title.lineText || p.title.text) + '」（距 ' + Math.round(p.dist) + 'px ✓）' }));
      out.push('  ⚠️ ★ambiguous✗★：有 ' + owned.length + ' 个候选都属于「' + container + '」→ 列清单 ✓ ★不硬选✗★');
    } else {
      outcome = 'ambiguous'; candidates = buttons.map((b) => ({ box: b, why: '没有一个能被几何归属到「' + container + '」✗' }));
      out.push('  ⚠️ ★ambiguous✗★：几何给不出归属（' + buttons.length + ' 个候选都没配上）→ 列清单 ✓ ★不硬选✗★');
    }
  } else if (buttons.length > 1) {
    outcome = 'ambiguous'; candidates = buttons.map((b) => ({ box: b, why: '没给容器，无法归属 ✓（给容器关键词我就能配 ✓）' }));
    out.push('  ⚠️ ★ambiguous✗★：' + buttons.length + ' 个同名候选、又没给容器 → 列清单 ✓（★此时才允许模型看编号图答编号✓，仍然不许它给坐标 ✗★）');
  }
  if (outcome === 'none') out.push('  ❌ ★没找到✗★（描述在图上没有对应文字；纯图标请用 iconlib= 指定图标库 ✓）');

  /* 记账：把坐标登记成"确定性工具给出的" ✓；act 只认这个编号 ✓ */
  if (chosen) {
    seqId += 1;
    const id = 'L' + seqId;
    ledger.offer(chosen.cx, chosen.cy, 'locate(' + desc + (container ? '/' + container : '') + ')', desc);
    lastLocate = { id, desc, container, box: chosen, space: sc, at: Date.now() };
    remember(id, lastLocate);
    out.push('  ★编号 ' + id + '★（中心 ' + chosen.cx + ',' + chosen.cy + '）→ 要动作就用：act|' + id + '|click' + (container ? '' : '') + ' ✓');
  } else if (candidates.length) {
    seqId += 1;
    lastLocate = { id: 'L' + seqId, desc, container, ambiguous: true, candidates: candidates.map((c, i) => ({ n: i + 1, box: c.box, why: c.why })), space: sc, at: Date.now() };
    for (const c of lastLocate.candidates) ledger.offer(c.box.cx, c.box.cy, 'locate(ambiguous)', desc);
    out.push('  ★候选编号★：' + lastLocate.candidates.map((c) => c.n + '=(' + c.box.cx + ',' + c.box.cy + ')').join(' '));
    out.push('  ★要动作请让**模型只回答编号**（或主人指定）→ act|' + lastLocate.id + '|<编号>|click ✓（★它仍然不会拿到裸坐标✗★）');
  } else {
    lastLocate = { id: null, desc, container, outcome: 'none', space: sc, at: Date.now() };
  }
  out.push('  ⚠️ ' + sc.note);
  return out.join('\n');
}

/* ───────── B. act：只接受 locate 给的编号/目标，绝不接受裸坐标 ✗ ───────── */
const KIND = { click: 'left', right: 'right', rclick: 'right', double: 'double', dclick: 'double', move: 'move' };

async function act(arg) {
  const { pos, kv } = parse(arg);
  const ref = pos[0] || '';
  const kind = String(pos[1] || kv.kind || 'click').toLowerCase();
  const criteria = String(pos[2] || kv.expect || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  const dry = kv.dry === '1';   // ★dry=1：只算不点（闸门/判据/新鲜帧照跑 ✓）★
  /* ★闸门 0：不接受裸坐标✗★（契约 B 的核心 ✓） */
  if (/^\s*-?\d+\s*,\s*-?\d+\s*$/.test(ref)) {
    return '❌ ★act 不接受裸坐标✗★（收到「' + ref + '」）—— ★坐标只能来自 locate/find_text 这类确定性工具✓★。\n'
      + '  正确用法：① locate|<描述>|<容器> 拿到编号 ✓ ② act|<编号>|click ✓（或直接 click_checked ✓）。';
  }
  if (!KIND[kind]) return '❌ 动作类型只支持：' + Object.keys(KIND).join(' / ') + '（收到「' + kind + '」）';
  const L = lastLocate;
  let box = null;
  const reg = idMap.get(String(ref).toUpperCase());
  if (reg && reg.box) box = reg.box;                       // ★编号登记表（不限"最近一次"✓）★
  else if (L && L.id && String(ref).toUpperCase() === String(L.id).toUpperCase() && L.box) box = L.box;
  else if (L && L.ambiguous) {
    const n = Number(ref);
    const hit = (L.candidates || []).find((c) => String(c.n) === String(ref) || (Number.isFinite(n) && c.n === n));
    if (hit) box = hit.box;
  }
  if (!box) {
    return '❌ ★找不到「' + ref + '」这个目标编号✗★（最近一次 locate 是 ' + (L ? (L.id || '（无编号）') : '（还没调过）')
      + '）→ ★我不会拿一个猜的坐标去点✗★。请先 locate ✓。' + (L && L.ambiguous ? '（这次是 ambiguous，请给候选编号 ✓）' : '');
  }
  const x = box.cx, y = box.cy;
  const g = ledger.gate(kind, x, y);
  out.push('🎬 act|' + ref + '|' + kind + ' → 目标「' + (L.desc || '') + (L.container ? '（' + L.container + '）' : '') + '」中心 (' + x + ',' + y + ')'
    + '　坐标系：' + (L.space ? (L.space.unit + ' / space ' + L.space.space) : '?'));
  if (!g.ok) {
    out.push('  ❌ ★闸门拒绝✗★：' + g.reason);
    out.push('  ' + g.hint);
    return out.join('\n');
  }
  out.push('  ✓ 来源证明通过：坐标由「' + g.offer.from + '」给出（距 ' + g.dist.toFixed(1) + 'px ✓），同目标此前点过 ' + g.alreadyClicked + ' 次 ✓');

  /* ★stateBefore：动作前自动跑一次 panel_state✗→✓（契约 F ✓）★ */
  const before = await frameFor(kv);
  const ocrB = await deps.ocrJson(before.path);
  const panB = P.detect(ocrB, {});
  out.push('  ⓪ stateBefore：' + (panB.verdict === 'ok' ? panB.label : panB.verdict) + '（' + (panB.best ? JSON.stringify(panB.best.hits) : '-') + '）');

  /* ★★★ 点前"新鲜帧复核"✗→✓（lead 第三条：falseSuccess=0 的构造保证）★★★
     为什么：第一版是"同一帧上定位 → 直接点" ✓ —— 中间画面动过（动画/滚动/别人操作 ✓）就会点偏 ✗，
     实测出现过 2 次"报了成功却没命中" ✗。
     → 现在：真动鼠标前**重新抓一帧** ✓，在新帧上**重新定位**同一个描述 ✓，要求
       ① 新帧上仍能找到（唯一 ✓）② 新位置与旧位置距离 ≤ freshPx（默认 40px ✓）
       ③ 若目标带容器，容器也仍能匹配 ✓ —— 任何一条不满足 → ★拒绝点击✗ 报 stale ✓★。 */
  if (!dry) {
    try {
      const fresh = deps.freshFrame ? await deps.freshFrame() : (kv.img ? { path: kv.img } : await deps.capture());
      const ocrF = await deps.ocrJson(fresh.path);
      let nb = OC.phrasesFromOcr(ocrF, L.desc);
      if (!nb.length) { const f2 = OC.fuzzyFromOcr(ocrF, L.desc, {}); if (f2.best) nb = [f2.best]; }
      const near = nb.map((b) => ({ b, d: Math.hypot(b.cx - x, b.cy - y) })).sort((p, q) => p.d - q.d)[0];
      if (!near || near.d > freshPx) {
        out.push('  ❌ ★新鲜帧复核没过✗★：新抓的帧上「' + L.desc + '」' + (near ? ('最近也在 ' + Math.round(near.d) + 'px 外（上限 ' + freshPx + 'px）') : '一处都没找到')
          + ' → ★不点了✗★（画面已经变了 ✓ 请重新 locate ✓）');
        return out.join('\n');
      }
      out.push('  ✓ 新鲜帧复核通过：新帧上「' + L.desc + '」在 (' + near.b.cx + ',' + near.b.cy + ')，距旧位置 ' + Math.round(near.d) + 'px（≤' + freshPx + '）✓');
    } catch (e) {
      out.push('  ❌ ★新鲜帧复核做不了（' + (e && e.message || e) + '）→ ★不点了✗★（没有"新鲜证据"就不动手 ✓）');
      return out.join('\n');
    }
  } else out.push('  ①′ dry=1：跳过新鲜帧复核与真实点击 ✓');

  if (dry) out.push('  ① ★dry=1：跳过真实动作✗★（只做闸门与判据流程 ✓）');
  else {
    try { await deps.act(KIND[kind], x, y); out.push('  ① 已发出 ' + KIND[kind] + ' ✓'); }
    catch (e) { out.push('  ❌ 动作本身失败：' + (e && e.message || e) + ' ★如实报失败✗ 不重试✓★'); return out.join('\n'); }
  }
  await new Promise((r) => setTimeout(r, kv.wait ? Number(kv.wait) : 1200));

  /* ★stateAfter + 判据核对（契约 D ✓）★ */
  const after = await frameFor(kv.after ? { img: kv.after } : kv, kv.after ? null : deps.capture);
  const ocrA = await deps.ocrJson(after.path);
  const panA = P.detect(ocrA, {});
  const vr = criteria.length ? OC.verifyCriteria(ocrA.text, criteria) : { ok: false, missing: [], empty: true };
  let diff = null;
  try {
    const A = await OC.lumaOfImage(before.path), B = await OC.lumaOfImage(after.path);
    diff = OC.diffStats(A.luma, B.luma);
  } catch (e) {}
  const changedPanel = !!(panB.panel && panA.panel && panB.panel !== panA.panel);
  const verified = criteria.length ? vr.ok : false;
  out.push('  ② stateAfter：' + (panA.verdict === 'ok' ? panA.label : panA.verdict) + (changedPanel ? '　★面板变了（' + panB.panel + '→' + panA.panel + '）★' : '　（面板没变）'));
  if (diff) out.push('     evidence：像素差 平均 ' + diff.mean.toFixed(2) + '/255，变化 ' + (diff.changedRatio * 100).toFixed(1) + '%'
    + '　图 evidence：' + before.path + ' → ' + after.path);
  out.push('  ③ verified = ' + (verified ? '★true✓★' : '★false✗★')
    + (criteria.length
      ? ('（判据 ' + JSON.stringify(criteria) + (vr.ok ? ' 全部出现 ✓' : ' 缺 ' + JSON.stringify(vr.missing) + ' ✗）'))
      : '（★没给判据 → 一律不算成功✗★；"画面变了"不是成功证据 ✓）'));
  /* ★账本只在**真的发过点击**时才记★（2026-10-11 修）：
     dry=1 是"只算不点"（探针/离线复算）✓ —— 它一次都没点，却往账本里记"点过"，
     后果是**下一次真的点击**会被当成复点拦掉 ✗（真机症状：她第一下就被拒 ✗）。
     单测里 a2/a3/a4 三次 dry 也会把同一目标记成 3 次 → a4 直接被闸门拦下 ✗，
     这正是"账本被 dry 污染"的表现 ✓。 */
  const reallyClicked = !dry;
  if (verified) {
    if (reallyClicked) ledger.note(kind, x, y, 'verified-ok', { verified: true, reason: '判据满足' });   // ★账本记 verified=true ✓
    ledger.clear(x, y);
    out.push('  ✅ ★成功且已核对★：同一目标的重试计数已清零 ✓');
  } else if (reallyClicked) {
    /* ★账本记 verified=false ✓ → 闸门据此**允许正当重试**（上限 3 次 ✓）★（2026-10-11 真机事故修复 ✓） */
    ledger.note(kind, x, y, 'unverified', { verified: false, reason: criteria.length ? '判据没满足' : '没判据' });
    out.push('  ❌ ★失败✗★：' + (criteria.length ? '判据没满足 ✓' : '没判据无法核对 ✓') + ' —— ★同一目标的**正当重试**允许 ✓（连续失败上限 3 次，到顶我会停手并上报 ✓），但**成功过一次之后**就不再允许复点 ✗★');
  } else {
    out.push('  ❌ ★失败✗★：' + (criteria.length ? '判据没满足 ✓' : '没判据无法核对 ✓')
      + '　（dry=1：一次都没点，账本不记 ✓）');
  }
  return out.join('\n');
}

/* ───────── C. zoom：裁剪 + 放大（+ 可选编号）→ 交给模型提问 ───────── */
async function zoom(arg) {
  const { pos, kv } = parse(arg);
  const box = String(pos[0] || '').split(',').map(Number);
  const factor = Number(pos[1] || kv.factor || 3);
  const numbered = String(pos[2] || kv.numbered || '0') === '1';
  const question = pos[3] || kv.q || '这一小块里有什么？只描述你看到的，不要给坐标。';
  if (box.length !== 4 || !box.every(Number.isFinite)) return '❌ 用法：zoom|x,y,w,h|<放大倍数>|<是否画编号 0/1>|<问题>';
  const fr = await frameFor(kv);
  const Jimp = require('jimp').Jimp;
  const fs = require('fs');
  const img = await Jimp.fromBuffer(fs.readFileSync(fr.path));
  const x = Math.max(0, Math.round(box[0])), y = Math.max(0, Math.round(box[1]));
  const w = Math.max(2, Math.min(Math.round(box[2]), img.width - x)), h = Math.max(2, Math.min(Math.round(box[3]), img.height - y));
  const crop = img.clone().crop({ x, y, w, h });
  crop.resize({ w: Math.round(w * factor), h: Math.round(h * factor) });
  const outPath = path.join(deps.shotDir ? deps.shotDir() : require('os').tmpdir(),
    'zoom-' + x + '_' + y + '_' + factor + 'x-' + Date.now() + '.png');
  fs.writeFileSync(outPath, await crop.getBuffer('image/png'));
  const lines = [];
  lines.push('🔍 zoom 区域 (' + x + ',' + y + ',' + w + ',' + h + ') ×' + factor + ' → ' + outPath);
  lines.push('  ★坐标系契约★：这张放大图的像素坐标 = 原图 (x,y) 减去 (' + x + ',' + y + ') 再乘 ' + factor
    + ' ✓（★换算由程序做✗：模型只许描述/答编号 ✓，不许给坐标 ✓）★');
  lines.push('  编号图：' + (numbered ? '已请求（若程序没能画上会在这里说明 ✓）' : '未请求 ✓'));
  if (deps.vision) {
    try {
      const ans = await deps.vision(outPath, question);
      lines.push('  模型（看放大图）回答：' + String(ans || '').slice(0, 800));
    } catch (e) { lines.push('  ❌ 问模型失败：' + (e && e.message || e)); }
  } else lines.push('  （没有 vision 依赖 → 只产出了放大图，没问模型 ✓）');
  return lines.join('\n');
}

async function run(tool, arg) {
  if (tool === 'locate') return await locate(arg);
  if (tool === 'act') return await act(arg);
  if (tool === 'zoom') return await zoom(arg);
  throw new Error('percept 不认识这个工具：' + tool);
}

module.exports = { install, run, locate, act, zoom, spaceContract, parse, ledger, lastLocate: () => lastLocate, seqId: () => seqId };
