/* ownclick.js —— ★点击的两道保险：①点前确认归属 ②点后核对结果★（纯函数可单测 ✓ 几何配对 ✓ 不靠模型给坐标 ✓）
 *
 * 【为什么需要它 ✗→✓（2026-10-10 真实事故）】
 *   主人看到的事：她点「编辑队列」时点到了 **制造站1** 的按钮 ✗，然后因为"屏幕有变化"就以为成功了 ✓，
 *   接着在一个根本不存在的"确认"按钮上反复找 ✓✓。
 *   两个根因（正好对应两道保险）：
 *     ① ★点前没确认归属✗★：屏幕上「编辑队列」出现了**四处**（真实 OCR 框 ✓）：
 *          (893,337) = 会客室卡片上的 —— ★这才是正确目标★
 *          (893,605) = 制造站1 的　(893,820) = 制造站2 的
 *          (322,791) = ★在聊天窗口里，是主人的字，根本不是按钮★
 *        她只按"同名文字取第一个 / 就近取"✗ → 没有归属概念 ✓。
 *     ② ★点后没有判据✗★：只有"屏幕变了"✗ —— 点错房间也会变 ✓（会客室面板变成制造站1 面板 ✓）。
 *   本模块的对策：
 *     ① 候选由**确定性工具**产出（find_text / find_template / grid_count / icon_lib ✓），
 *        再用**几何**把每个候选归属到容器（房间标题 ✓）—— ★全程不许模型给坐标✗★；
 *        归属**确定不了就报"不确定"并列出候选清单** ✗ 绝不硬选一个 ✓。
 *     ② 调用方**点之前必须声明"什么叫成功"**（判据 = 点后必须 OCR 出的关键词 ✓），
 *        点后抓帧核对 ＋ 同时记 before/after 的像素差 ✓ —— ★"屏幕有变化"永远不能单独当成功证据✗★。
 *
 * 【★配对规则（本案实测出来的，不是拍脑袋）★】
 *   真实数据（OCR 词组框，物理像素 1920x1080 ✓）：
 *     标题：会客室 (835,160)｜制造站 (836,429)｜制造站1 (837,495)｜制造站2 (837,710)｜制造站弓 (837,925)
 *           全部落在 x≈787~885
 *     候选：编辑队列 (893,337)｜(893,605)｜(893,820)　＋　(322,791)【聊天窗】
 *   ★规则 A（同列 + "卡片向下堆叠"）★：
 *     · 先按 x 带过滤：候选中心 x 必须落在标题列（787~885 ± 容差）里 → ★(322,791) 直接被排除✓★
 *       （它就是"聊天窗口里的那处"✓ —— 实测它 x=287~356 ✓，与标题列差 400+px ✓）
 *     · 再把候选配给**它上方最近的那个标题** ✓ —— 因为卡片是**从上往下**排的：
 *       标题在上、按钮在该卡片内偏下 ✓。实测：
 *         (893,337) → 上方最近 = 会客室(160) ✓★正确答案★
 *         (893,605) → 上方最近 = 制造站(429) ✓（★这就是她点错的那一格✓★）
 *         (893,820) → 上方最近 = 制造站2(710) ✓
 *     ★为什么不是"y 最近的标题"✗★：(893,337) 离制造站(429) 只有 92px ✓，
 *       离会客室(160) 有 177px ✗ → 按"最近"会配给制造站 ✗✗（正好就是那个事故 ✓）。
 *       所以必须用「**上方**最近」而不是「最近」✓。
 *     ★为什么不是"1 对 1 按 y 排序配对"✗★：标题有 5 个（会客室/制造站/制造站1/制造站2/制造站弓 ✓）
 *       而候选只有 3 个在列内 ✗ → 数目不等 ✓，硬做 1 对 1 会整体错位 ✓。
 *   ★规则 B（容器包含）★：如果调用方**能给卡片矩形**（未来接 UIA / 卡片检测 ✓），
 *     就按"候选中心落在哪个卡片矩形内"来配 ✓ —— 它比规则 A 更强（不受"上方最近"假设影响 ✓）。
 *     本案没有卡片检测器 ✗ → 默认走规则 A ✓；给了矩形就走 B ✓，并在回执里写明用了哪条 ✓。
 *   ★不确定条件（任一命中就报"不确定"✓ 不硬选 ✗）★：
 *     · 候选与"上方最近标题"的距离 > 上限（默认 = 标题间距中位数 × 1.6 ✓）
 *     · 有两个标题与候选的 y 距离几乎一样（差 < 12px ✓）
 *     · 目标标题在清单里找不到 / 有多个同名标题（无法唯一定位 ✓）
 *     · 候选在列内一个都没有（那就没什么可点的 ✓）
 */
'use strict';

/* ───────────────── 纯函数区（不依赖屏幕 ✓ 可单测 ✓）───────────────── */

function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ''); }

/* 从 OCR JSON 里找**词组**的包围盒（和 find_text 一样：词首尾相连 → 命中区间映射回词框 → 求并集 ✓）
 * ocr 结构（真实数据 ✓）：{ok,imgW,imgH,text,lines:[{text,words:[{t,x,y,w,h}]}]} —— ★坐标在 x/y/w/h ✓ */
function phrasesFromOcr(ocr, needle) {
  const nd = norm(needle);
  const out = [];
  if (!ocr || !nd) return out;
  (ocr.lines || []).forEach((L, li) => {
    const words = (L.words || []).map((w) => ({ t: norm(w.t), x: w.x, y: w.y, w: w.w, h: w.h })).filter((w) => w.t);
    let joined = '';
    const map = [];
    words.forEach((w, wi) => { for (const _c of w.t) { map.push(wi); joined += _c; } });
    let from = 0;
    for (;;) {
      const at = joined.indexOf(nd, from);
      if (at < 0) break;
      const ids = [];
      for (let k = at; k < at + nd.length; k++) if (map[k] != null && ids.indexOf(map[k]) < 0) ids.push(map[k]);
      const ws = ids.map((i) => words[i]).filter(Boolean);
      if (ws.length) {
        const x0 = Math.min.apply(null, ws.map((w) => w.x)), y0 = Math.min.apply(null, ws.map((w) => w.y));
        const x1 = Math.max.apply(null, ws.map((w) => w.x + w.w)), y1 = Math.max.apply(null, ws.map((w) => w.y + w.h));
        out.push({ text: nd, lineText: norm(L.text), line: li, x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: Math.round((x0 + x1) / 2), cy: Math.round((y0 + y1) / 2) });
      }
      from = at + 1;
    }
  });
  return out;
}

function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ★★★ 容错词组匹配 ✗→✓（2026-10-11：lead 指出"精确匹配诚实但不可用"）★★★
 * 【为什么】真机实测：OCR 把「编辑队列」读成「编 辑 队 歹 刂」（"列"被拆成两半 ✗）→ 精确匹配只能
 *   如实报 not-found ✗（42 个 text 用例全挂 ✓）→ ★诚实但不可用✗★。
 * 【度量：LCS 覆盖率】（★不用编辑距离✗★：拆字会被罚两次 ✓ 把好匹配也压下去 ✓）
 *   coverage = LCS(目标, 候选窗口) / len(目标) ✓。
 * 【阈值：用**真机数据**标定 ✓ 不是拍脑袋✗】
 *   正样本（live 帧真读到的那条）：目标「编辑队列」 vs 读到「编辑队歹刂」 → **0.75** ✓
 *   负样本（同帧别的按钮/形近词）：vs「编辑」0.50 ✓｜vs「编辑信息」0.50 ✓｜vs「确认」0.00 ✓｜vs「取消」0.00 ✓
 *   → 阈值 **0.75**：正样本刚好过 ✓、负样本隔 0.25 ✓（两侧都有余量 ✓）。
 * 【护栏】① 唯一性：最佳 ≥阈值 且 与次佳差 < 0.02 → ★ambiguous✗ 不挑一个 ✓★；
 *         ② 回执自证：★目标文字 / 页面实际读到的文字 / 分数 / 用了哪条归一化 ✓★（一眼看出真匹配还是硬凑 ✓）。
 */
function normTxt(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[·・．.。,，、；;：:！!？?（）()【】\[\]《》<>「」“”"']/g, '')
    .toLowerCase();
}
function lcsLen(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    const t = prev; prev = cur; cur = t; cur.fill(0);
  }
  return prev[m];
}
function coverage(needle, cand) { return needle ? lcsLen(needle, cand) / needle.length : 0; }

function fuzzyFromOcr(ocr, needle, opt) {
  const o = opt || {};
  const nd = normTxt(needle);
  const out = [];
  if (!ocr || nd.length < 2) return { min: 0.75, best: null, all: [], ambiguous: false, notes: 0 };
  (ocr.lines || []).forEach((L, li) => {
    const words = (L.words || []).map((w) => ({ t: normTxt(w.t), x: w.x, y: w.y, w: w.w, h: w.h })).filter((w) => w.t);
    if (!words.length) return;
    let joined = '';
    const map = [];
    words.forEach((w, wi) => { for (const _c of w.t) { map.push(wi); joined += _c; } });
    let best = { score: 0, from: 0, to: 0, cand: '' };
    for (const win of [nd.length - 1, nd.length, nd.length + 1, nd.length + 2]) {
      if (win < 2) continue;
      for (let s = 0; s + win <= joined.length; s++) {
        const cand = joined.slice(s, s + win);
        const sc = coverage(nd, cand);
        if (sc > best.score) best = { score: sc, from: s, to: s + win, cand };
      }
    }
    if (!best.cand) return;
    const ids = [];
    for (let k = best.from; k < best.to; k++) if (map[k] != null && ids.indexOf(map[k]) < 0) ids.push(map[k]);
    const ws = ids.map((i) => words[i]).filter(Boolean);
    if (!ws.length) return;
    const x0 = Math.min.apply(null, ws.map((w) => w.x)), y0 = Math.min.apply(null, ws.map((w) => w.y));
    const x1 = Math.max.apply(null, ws.map((w) => w.x + w.w)), y1 = Math.max.apply(null, ws.map((w) => w.y + w.h));
    out.push({
      text: needle, lineText: normTxt(L.text), read: best.cand, score: Number(best.score.toFixed(4)),
      norm: 'LCS覆盖 + 去空白/全角半角/去标点', line: li,
      x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: Math.round((x0 + x1) / 2), cy: Math.round((y0 + y1) / 2),
    });
  });
  const min = o.minScore == null ? 0.75 : Number(o.minScore);
  const pass = out.filter((r) => r.score >= min).sort((a, b) => b.score - a.score);
  const amb = pass.length > 1 && (pass[0].score - pass[1].score) < (o.tie == null ? 0.02 : Number(o.tie));
  return { min, best: pass[0] || null, all: pass, ambiguous: amb, notes: out.length };
}

/* ★核心：把候选归属到标题（规则 A / B ✓）★
 * buttons: [{x,y,w,h,cx,cy,text}]　titles: [{...,text}]　opts: {xTol, maxDistK, cards:[{x,y,w,h,text}]}
 * 返回 {verdict:'ok'|'uncertain'|'none', pairs:[{button,title,dist,dx}], excluded:[{button,why}], notes:[], method} ✓ */
function pairOwners(buttons, titles, opts) {
  const o = opts || {};
  const B = (buttons || []).slice();
  const T = (titles || []).slice().sort((a, b) => a.cy - b.cy);
  const notes = [];
  if (!B.length) return { verdict: 'none', pairs: [], excluded: [], notes: ['没有任何候选 ✓（那就没什么可点的 ✓）'], method: 'none' };
  if (!T.length) {
    return {
      verdict: 'uncertain', pairs: [], method: (o.cards && o.cards.length) ? 'container' : 'column',
      excluded: B.map((b) => ({ button: b, why: '★找不到归属容器（没有标题候选 ✓）→ 不确定，不硬选 ✗★' })),
      notes: ['调用方至少要给一个"容器/标题"的文字 ✓（例如房间名 ✓）'],
    };
  }

  /* —— 规则 B：有卡片矩形就按包含关系配（更强 ✓）—— */
  if (o.cards && o.cards.length) {
    const pairs = [], excluded = [];
    for (const b of B) {
      const hit = o.cards.filter((c) => b.cx >= c.x && b.cx <= c.x + c.w && b.cy >= c.y && b.cy <= c.y + c.h);
      if (hit.length === 1) pairs.push({ button: b, title: hit[0], dist: 0, method: 'container' });
      else if (hit.length === 0) excluded.push({ button: b, why: '不在任何卡片矩形里 ✓' });
      else excluded.push({ button: b, why: '★同时落在 ' + hit.length + ' 个卡片里 → 不确定 ✗★' });
    }
    return { verdict: pairs.length ? (excluded.length ? 'uncertain' : 'ok') : 'none', pairs, excluded, notes, method: 'container' };
  }

  /* —— 规则 A：同列 + 卡片向下堆叠（"上方最近标题"✓）—— */
  /* ★★ 先做"列聚类"✗→✓（2026-10-10 单测当场抓到的坑）★★
     第一版直接把**所有**标题的 x 范围当列宽 ✗ —— 可是同一个词在别的窗口里也会出现 ✓：
     真实数据里「会客室」有 3 处 ✓，其中 (321,565) 是**聊天窗口里的主人文字** ✗ →
     列宽被撑成 295~884 ✗ → 结果连聊天窗那个候选 (322,791) 也被判"在列内"✗✗（本该被排除 ✓）。
     → 现在：把标题按 cx **聚类**（间距 ≤ columnTol ✓），★取最大的一簇当"这一列"✓★，
       簇外的标题单独报出来（"不在同一列 ✓ 多半在别的窗口 ✓"）✓。 */
  const columnTol = o.columnTol == null ? 60 : Number(o.columnTol);
  const sortedT = T.slice().sort((a, b) => a.cx - b.cx);
  const clusters = [];
  for (const t of sortedT) {
    const last = clusters[clusters.length - 1];
    if (last && t.cx - last.maxCx <= columnTol) { last.items.push(t); last.maxCx = Math.max(last.maxCx, t.cx); }
    else clusters.push({ items: [t], maxCx: t.cx });
  }
  let main = clusters[0] || { items: T };
  for (const c of clusters) if (c.items.length > main.items.length) main = c;
  const colT = main.items.slice().sort((a, b) => a.cy - b.cy);
  const offCol = T.filter((t) => main.items.indexOf(t) < 0);
  if (offCol.length) notes.push('★列聚类★：主列 x≈' + Math.round(median(main.items.map((t) => t.cx)))
    + '（' + main.items.length + ' 个标题 ✓），另有 ' + offCol.length + ' 个同名标题**不在这一列** ✗（多半在别的窗口 ✓）：'
    + offCol.map((t) => t.lineText + '(' + t.cx + ',' + t.cy + ')').join(' '));
  const x0 = Math.min.apply(null, colT.map((t) => t.x)), x1 = Math.max.apply(null, colT.map((t) => t.x + t.w));
  const xTol = o.xTol == null ? 45 : Number(o.xTol);        // 标题列左右容差 ✓（实测按钮 846~940 vs 标题 787~885 ✓ 差 55 ✓）
  const gaps = [];
  for (let i = 1; i < colT.length; i++) gaps.push(colT[i].cy - colT[i - 1].cy);
  const medGap = median(gaps) || 0;
  const maxDistK = o.maxDistK == null ? 1.3 : Number(o.maxDistK);
  /* ★距离上限要用**两个**尺度里更大的那个 ✗→✓（单测当场抓到的第二个坑）★
     第一版只用"标题间距中位数"✗ —— 可真机上「会客室」这个标题在 OCR 里出现了**两次**（y=160 和 y=227 ✓），
     两者只差 67px ✓ → 中位数 67 ✓ → 上限 107px ✗ → 而正确目标 (893,337) 离标题 110px ✓
     → ★正确答案被"太远"这条否决了 ✗✗（差 3px ✗！）★。
     修法：上限 = max(标题间距中位数, **候选自身间距中位数**) × 1.3 ✓ ——
       多个候选本来就是"每张卡片一个" ✓（本案 337/605/820 ✓ 间距 268/215 ✓），
       它们的间距就是**卡片节拍** ✓，比标题间距更可信 ✓；再兜一个下限 90px ✓
       （一个卡片再矮也有 ~90px ✓；实测房间卡片间距 215~268px ✓）。
     实测新上限：max(67,241)×1.3 ≈ 313px ✓ → 正确目标 110px ✓ 通过 ✓；
       而"离上方标题 2773px"这种照样被拦 ✓。 */
  const inBand = B.filter((b) => b.cx >= x0 - xTol && b.cx <= x1 + xTol).sort((a, b) => a.cy - b.cy);
  const candGaps = [];
  for (let i = 1; i < inBand.length; i++) candGaps.push(inBand[i].cy - inBand[i - 1].cy);
  const medCandGap = median(candGaps) || 0;
  const maxDist = Math.max(90, Math.max(medGap, medCandGap) * maxDistK);
  const tiePx = o.tiePx == null ? 12 : Number(o.tiePx);
  const T2 = colT;                                          // 只用主列标题配对 ✓

  const pairs = [], excluded = [];
  for (const b of B) {
    /* ① x 带过滤（★聊天窗那处就是这样被排除的★） */
    if (b.cx < x0 - xTol || b.cx > x1 + xTol) {
      excluded.push({ button: b, why: '★不在标题列（x 带 ' + Math.round(x0 - xTol) + '~' + Math.round(x1 + xTol) + '）里 ✓ —— 它多半在别的窗口里 ✗★' });
      continue;
    }
    /* ② 上方最近标题（取 y 在候选之上的那些 ✓）
       ★★ 上方一个标题都没有 → **不猜**✗→✓（真机探针当场抓到的第三个坑）★★
       第一版：上方为空就退化成"整列里最近"✗ —— 结果容器选「制造站1」时，
       ★(893,337) 这个**在所有标题之上**的候选也被硬配给了制造站1✗★（距离 158px ✓）→
       变成"2 个候选都属于制造站1"✗ → 归属不确定 ✓（虽然最终没点错 ✓，但语义是错的 ✗：
       卡片是"标题在上、按钮在下"✓，一个按钮**不可能属于它上方的卡片**✓）。
       → 现在：上方没有标题 → ★直接报"它在所有标题之上，没有卡片能包含它"✓ 不确定 ✗ 不硬选 ✓★。 */
    const above = T2.filter((t) => t.cy <= b.cy);
    if (!above.length) {
      excluded.push({ button: b, why: '★它在所有标题之上 ✗ —— 卡片是"标题在上、按钮在下"✓，没有卡片能包含它 → 不确定 ✓ 不硬选 ✗★' });
      continue;
    }
    const pool = above;
    let best = null, bestDist = Infinity, secondDist = Infinity;
    for (const t of pool) {
      const d = Math.abs(b.cy - t.cy);
      if (d < bestDist) { secondDist = bestDist; bestDist = d; best = t; }
      else if (d < secondDist) secondDist = d;
    }
    if (!best) { excluded.push({ button: b, why: '找不到任何标题 ✓' }); continue; }
    if (secondDist - bestDist < tiePx) {
      excluded.push({ button: b, why: '★有两个标题离它一样近（差 ' + Math.round(secondDist - bestDist) + 'px）→ 不确定 ✗ 不硬选 ★' });
      continue;
    }
    if (bestDist > maxDist) {
      excluded.push({ button: b, why: '★离上方最近的「' + best.lineText + '」都差了 ' + Math.round(bestDist) + 'px（上限 ' + Math.round(maxDist) + 'px）→ 不确定 ✗★' });
      continue;
    }
    pairs.push({ button: b, title: best, dist: bestDist, method: 'column-above' });
  }
  /* ★verdict 语义✗→✓★：none = **一个候选都没有** ✓；
     有候选但一个都没配上（或配上有剩）→ ★uncertain✓（"没把握"就是没把握 ✓，不能伪装成"没有"✗）★ */
  const verdict = !B.length ? 'none' : ((pairs.length && !excluded.length) ? 'ok' : 'uncertain');
  notes.push('规则 A：主列 x=' + Math.round(x0) + '~' + Math.round(x1) + '（容差 ±' + xTol + '），标题间距中位数 '
    + Math.round(medGap) + 'px → 距离上限 ' + (maxDist === Infinity ? '∞' : Math.round(maxDist) + 'px'));
  return { verdict, pairs, excluded, notes, method: 'column-above', column: { x0, x1, xTol, medGap, maxDist, clusters: clusters.length, offColumn: offCol } };
}

/* 从配对结果里挑"目标容器"的那些候选 ✓（按容器关键词匹配：搜索词或那一行原文都算 ✓） */
function ownedBy(res, containerText) {
  const want = norm(containerText);
  return (res.pairs || []).filter((p) => norm(p.title.text).indexOf(want) >= 0 || norm(p.title.lineText).indexOf(want) >= 0);
}

/* ★② 判据核对：OCR 文本里必须**全部**出现 required 关键词 ✓（"屏幕变了"不算 ✓）★ */
function verifyCriteria(ocrText, required) {
  const hay = norm(ocrText);
  const req = (required || []).map(norm).filter(Boolean);
  const missing = req.filter((r) => hay.indexOf(r) < 0);
  return { ok: req.length > 0 && missing.length === 0, missing, required: req, empty: req.length === 0 };
}

/* ★★★ 判据自检（直接针对今晚"判据选错"这个失败模式 ✓ 2026-10-11 新增）★★★
 * 【为什么要它 ✗→✓】今晚实测：她拿「会客室」当判据 ✓ —— 可★"会客室"在点前就有✗★
 *   （房间列表里 ✓ 真实计数 before=3 / after=1 ✓）→ ★点错了也会"判成功"✗★；
 *   而她又拿"screen_diff 说没变化"当失败 ✗ —— 两个方向都错 ✓。
 *   → 判据必须★只在成功后出现★（实测「当前进驻」before=0 / after=1 ✓ 才是合格判据 ✓）。
 * 做法：拿**点前那一帧的 OCR**查每个判据词 ✓：★点前就有的 → 不合格✗★（给出实测依据 ✓），
 *       并给出**建议判据**（目标面板的指纹词里、点前没有的那些 ✓）。 */
function validateCriteria(beforeOcr, criteria, suggest) {
  const hay = norm((beforeOcr && beforeOcr.text) || '') + '|'
    + (((beforeOcr && beforeOcr.lines) || []).map((L) => norm(L.text)).join('|'));
  const req = (criteria || []).map(norm).filter(Boolean);
  const already = req.filter((r) => hay.indexOf(r) >= 0);
  const fresh = req.filter((r) => hay.indexOf(r) < 0);
  return {
    ok: req.length > 0 && already.length === 0,
    required: req,
    alreadyPresent: already,     // ★点前就有 → 不能当判据 ✗★
    fresh,                       // 点前没有 ✓（还要点后真的出现才算成功 ✓）
    suggestion: (suggest || []).map(norm).filter((w) => w && hay.indexOf(w) < 0).slice(0, 5),
  };
}

/* 像素差（纯数组 ✓）：平均绝对差 + 变化像素比例 ✓ —— 只当**参考信息**报 ✓ 不当成功证据 ✗ */
function diffStats(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return { mean: 0, changedRatio: 0, n: 0 };
  let sum = 0, changed = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > 12) changed++;
  }
  return { mean: sum / n, changedRatio: changed / n, n };
}

/* ───────────────── 工具层（依赖注入 ✓ 这样纯 Node 也能整套跑 ✓）───────────────── */
/* 依赖：capture()（抓帧 → {path,dataUrl,w,h}）/ ocrJson(path)（→ {imgW,imgH,text,lines}）/
 *       click(x,y)（她坐标空间 ✓）/ space()（{w,h}）/ dbg() ✓
 * ★dry=1 时**一次都不点**✓★（只算归属 + 只核对判据 ✓）—— 验证/离线复算就靠它 ✓。 */
const deps = { capture: null, ocrJson: null, click: null, space: () => ({ w: 1920, h: 1080 }), dbg: () => {} };
function install(d) { Object.assign(deps, d || {}); return module.exports; }

function parseArg(arg) {
  const parts = String(arg == null ? '' : arg).split('|').map((s) => s.trim());
  const kv = {};
  const pos = [];
  for (const p of parts) {
    const m = /^([A-Za-z_][\w]*)=(.*)$/.exec(p);
    if (m) kv[m[1].toLowerCase()] = m[2]; else pos.push(p);
  }
  return { pos, kv };
}

async function lumaOfImage(file) {
  const fs = require('fs');
  const Jimp = require('jimp').Jimp;
  const img = await Jimp.fromBuffer(fs.readFileSync(file));
  const d = img.bitmap.data;
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) out[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return { luma: out, w: img.width, h: img.height };
}

/* 图从哪来：img= 给了就用它 ✓（离线/验证 ✓）；否则现场抓一帧 ✓ */
async function frame(kv, fallbackCapture) {
  if (kv.img) {
    const fs = require('fs');
    if (!fs.existsSync(kv.img)) throw new Error('找不到 img= 指定的图：' + kv.img);
    return { path: kv.img, from: 'img=' };
  }
  if (fallbackCapture) return await fallbackCapture();
  if (!deps.capture) throw new Error('没有抓帧能力 ✓（请用 img=<图片路径> 或让主进程注入 capture ✓）');
  return await deps.capture();
}

function toSpace(cx, cy, imgW, imgH) {
  const s = deps.space ? deps.space() : { w: imgW, h: imgH };
  const kx = imgW ? s.w / imgW : 1, ky = imgH ? s.h / imgH : 1;
  /* ★这张图是不是"整屏"★（2026-10-11 坐标系排查）：只有**整屏图**，按比例缩放才等于"屏幕坐标" ✓。
     窗口裁图（img= 传进来的那种）按整屏比例缩放**得不到屏幕坐标** ✗ ——
     原来无条件写「坐标已换算成她的坐标空间 ✓」是**假保证** ✗：图不对时那句话是错的。
     现在如实标 fullscreen，回执里也照实说 ✓（正常路径 = 主进程抓帧，一定是整屏 ✓）。 */
  const fullscreen = !!(imgW && imgH && imgW === s.w && imgH === s.h);
  return { x: Math.round(cx * kx), y: Math.round(cy * ky), space: s, applied: { kx, ky }, fullscreen };
}

/* ① 点前确认归属（只报告 ✓ 不动鼠标 ✓） */
async function findOwned(arg) {
  const { pos, kv } = parseArg(arg);
  const buttonText = pos[0], containerText = pos[1];
  if (!buttonText || !containerText) return '❌ 用法：find_owned|<要点的文字，如 编辑队列>|<容器/标题关键词，如 会客室>|img=<图，可省>|<region=x,y,w,h，可省>';
  const fr = await frame(kv, null);
  const ocr = await deps.ocrJson(fr.path);
  const buttons = phrasesFromOcr(ocr, buttonText);
  const titles = phrasesFromOcr(ocr, containerText);
  if (kv.region) {
    const r = kv.region.split(',').map(Number);
    if (r.length === 4 && r.every(Number.isFinite)) {
      const inside = (b) => b.cx >= r[0] && b.cx <= r[0] + r[2] && b.cy >= r[1] && b.cy <= r[1] + r[3];
      for (const arr of [buttons, titles]) { for (let i = arr.length - 1; i >= 0; i--) if (!inside(arr[i])) arr.splice(i, 1); }
    }
  }
  const res = pairOwners(buttons, titles, {});
  const owned = ownedBy(res, containerText);
  const lines = [];
  lines.push('🔎 归属查询：要点的「' + buttonText + '」，归属容器「' + containerText + '」（用 ' + fr.from + fr.path.split(/[\\/]/).pop() + ' 的 OCR ✓）');
  lines.push('  ★候选清单（' + buttons.length + ' 个「' + buttonText + '」）★：');
  buttons.forEach((b, i) => lines.push('    ' + (i + 1) + '. 中心 (' + b.cx + ',' + b.cy + ')　框 x=' + b.x + ' y=' + b.y + ' w=' + b.w + ' h=' + b.h));
  lines.push('  ★容器清单（' + titles.length + ' 个「' + containerText + '」）★：' + titles.map((t) => t.text + '(' + t.cx + ',' + t.cy + ')').join(' ') || '（无）');
  lines.push('  ' + res.notes.join('；'));
  if (res.pairs.length) {
    lines.push('  ★配对结果★：');
    for (const p of res.pairs) lines.push('    「' + p.button.text + '」(' + p.button.cx + ',' + p.button.cy + ') → 归属「' + p.title.text + '」'
      + '（纵向距离 ' + Math.round(p.dist) + 'px，依据 ' + p.method + ' ✓）');
  }
  if (res.excluded.length) {
    lines.push('  ★被排除/存疑★：');
    for (const e of res.excluded) lines.push('    「' + e.button.text + '」(' + e.button.cx + ',' + e.button.cy + ') → ' + e.why);
  }
  if (owned.length === 1) {
    const t = toSpace(owned[0].button.cx, owned[0].button.cy, ocr.imgW, ocr.imgH);
    /* ★把这次定位记进账本★（2026-10-11）：find_owned 本来就是"点之前确认归属"那一步 ✓ ——
       裸 click 的"不许复点"闸门认它当**新证据**（复点前必须重新定位过一次 ✓）。
       ⚠️ 只在**整屏图**时记（t.fullscreen）：窗口裁图的坐标不是屏幕坐标 ✗ 记进去会授权一次错点 ✗ */
    if (t.fullscreen) { try { require('./prov').instance.offer(t.x, t.y, 'find_owned', buttonText + '@' + containerText); } catch (e) {} }
    lines.push('  ✅ ★归属确定★：「' + buttonText + '」属于「' + owned[0].title.text + '」（★唯一 ✓★）→ 点击坐标 ' + t.x + ',' + t.y
      + '（物理像素 ' + owned[0].button.cx + ',' + owned[0].button.cy + ' ✓）'
      + (t.fullscreen ? '　★坐标空间=你的坐标空间（图就是整屏 ' + t.space.w + 'x' + t.space.h + '）✓★'
        : '　⚠️★这张图不是整屏（' + ocr.imgW + 'x' + ocr.imgH + ' ≠ ' + t.space.w + 'x' + t.space.h
          + '）→ 上面的"点击坐标"只在图正好是整屏时才等于屏幕坐标 ✗：请先用现场抓帧（不带 img=）重跑一次 ✗★'));
  } else if (owned.length === 0) {
    lines.push('  ⚠️ ★归属不确定✗★：没有任何候选被配对到「' + containerText + '」→ ★不点✗：请把区域收窄、或换个更明确的容器关键词 ✓★');
  } else {
    lines.push('  ⚠️ ★归属不确定✗★：有 ' + owned.length + ' 个候选都属于「' + containerText + '」→ ★不硬选✗：请把区域收窄或用 click_checked 让人工给判据 ✓★');
  }
  lines.push('  ⚠️ 全程只用**几何**归属 ✓ —— ★没有让模型给坐标✗★；模型最多只能在"几何无解"时回答**候选编号** ✓。');
  return lines.join('\n');
}

/* ② 点前确认归属 + 点击 + 点后核对判据（★判据不满足就如实报失败 ✗ 不在附近反复试 ✓★） */
async function clickChecked(arg) {
  const { pos, kv } = parseArg(arg);
  const buttonText = pos[0], containerText = pos[1], criteria = String(pos[2] || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (!buttonText || !containerText || !criteria.length) {
    return '❌ 用法：click_checked|<要点的文字>|<容器/标题关键词>|<成功判据，逗号分隔（全部要出现）>|img=<点前图，可省>|after=<点后图，可省>|dry=1（只算不点）|region=x,y,w,h';
  }
  if (!kv.img && !deps.click && kv.dry !== '1') return '❌ 没有点击能力也没给 dry=1 ✓（我不猜 ✓）';
  const dry = kv.dry === '1';
  const before = await frame(kv, kv.img ? null : deps.capture);
  const ocrB = await deps.ocrJson(before.path);
  const out = [];
  out.push('🎯 click_checked：点「' + buttonText + '」+ 归属「' + containerText + '」+ 判据 [' + criteria.join(' 且 ') + ']' + (dry ? '（★dry：只算不点✗★）' : ''));

  /* ★闸门 0：面板状态（"我现在在哪个面板"✓）—— 直接针对"卡在不存在确认按钮上乱找"✗★ */
  let panel = null;
  try {
    const P = require('./panel');
    panel = P.detect(ocrB, {});
    out.push('  ⓪ 面板判定：' + (panel.verdict === 'ok' ? '★' + panel.label + '★（' + panel.note + '）' : '⚠️ ' + panel.verdict + ' —— ' + panel.note));
    if (kv.expect) {
      if (panel.verdict !== 'ok') { out.push('  ❌ ★点前检查没过：我叫你确认「' + kv.expect + '」面板，但我判不出当前面板 ✗★ → ★一个都不点✗★'); return out.join('\n'); }
      if (panel.panel !== kv.expect) { out.push('  ❌ ★点前检查没过：现在不在「' + kv.expect + '」面板（实测在「' + panel.label + '」✓）✗ → ★一个都不点✗★ —— 请先切到那个面板再叫我 ✓'); return out.join('\n'); }
      out.push('  ✓ 预期面板「' + kv.expect + '」与实测一致 ✓');
    }
  } catch (e) { out.push('  （面板判定不可用：' + (e && e.message || e) + '）'); }

  /* ★闸门 1：判据自检 —— ★点前就有的词不能当判据✗★（今晚「会客室」就是这种 ✓）★ */
  let suggest = [];
  try { suggest = require('./panel').criteriaFor(kv.expect || (panel && panel.panel) || 'queue'); } catch (e) {}
  const cv = validateCriteria(ocrB, criteria, suggest);
  if (!cv.ok && kv.force !== '1') {
    out.push('  ❌ ★判据不合格✗★：' + JSON.stringify(cv.alreadyPresent) + ' 在**点之前**就已经出现在画面里了 ✓'
      + ' → ★用它当成功判据 = "点错了也会判成功"✗★（今晚实测：「会客室」点前就有 ✓ before=3 / after=1 ✓）。');
    out.push('     建议判据（目标面板的指纹词里、点前**没有**的 ✓）：' + (cv.suggestion.length ? JSON.stringify(cv.suggestion) : '（没有可用的 ✓ 请换个目标面板）'));
    out.push('     ★我一个都没点✗★ —— 请你换一个"只在成功后出现"的词当判据再叫我 ✓（实在要用就加 force=1，但我会如实说这次判据不硬 ✓）。');
    return out.join('\n');
  }
  if (!cv.ok && kv.force === '1') out.push('  ⚠️ 判据不合格（' + JSON.stringify(cv.alreadyPresent) + ' 点前就有 ✓）但 force=1 → 继续 ✓，★这次结论不算硬✗★');
  else out.push('  ✓ 判据自检通过：' + JSON.stringify(cv.fresh) + ' 点前都没出现 ✓（合格判据 ✓）');

  const buttons = phrasesFromOcr(ocrB, buttonText);
  const titles = phrasesFromOcr(ocrB, containerText);
  const res = pairOwners(buttons, titles, {});
  const owned = ownedBy(res, containerText);
  out.push('  ① 候选 ' + buttons.length + ' 个，容器 ' + titles.length + ' 个；配对 ' + res.pairs.length + ' 对，排除 ' + res.excluded.length + ' 个 ✓');
  for (const e of res.excluded) out.push('    ✗ 排除：「' + buttonText + '」(' + e.button.cx + ',' + e.button.cy + ') → ' + e.why);
  if (owned.length !== 1) {
    out.push('  ❌ ★点前检查没过：归属' + (owned.length === 0 ? '不确定（没有候选属于「' + containerText + '」）' : '有 ' + owned.length + ' 个候选都属于「' + containerText + '」') + '✗★');
    out.push('  ★我一个都没点✗★（宁可不动手也不点错 ✓）—— 请把区域收窄，或明确告诉我要哪一个 ✓。');
    return out.join('\n');
  }
  const bx = owned[0].button.cx, by = owned[0].button.cy;
  const t = toSpace(bx, by, ocrB.imgW, ocrB.imgH);
  out.push('  ② 归属确定 ✓：「' + owned[0].title.text + '」（距离 ' + Math.round(owned[0].dist) + 'px）→ 点 (' + t.x + ',' + t.y + ')'
    + '（物理 ' + bx + ',' + by + '，她的坐标空间 ' + t.space.w + 'x' + t.space.h + ' ✓）');
  /* ★把这次"重新定位出来的坐标"记进账本★（2026-10-11）——
     裸 click 的"不许复点"闸门要求：复点必须有一次**上一次点击之后**重新定位出来的坐标 ✓，
     这里就是那个来源之一 ✓（账本共用 prov.js 的 instance ✓）。 */
  try { require('./prov').instance.offer(t.x, t.y, 'click_checked', buttonText + '@' + containerText); } catch (e) {}
  if (!dry) {
    try { await deps.click(t.x, t.y); out.push('  ③ 已发出点击 ✓'); }
    catch (e) { out.push('  ❌ 点击本身失败：' + (e && e.message || e) + ' ★如实报失败 ✗ 不重试 ✓★'); return out.join('\n'); }
  } else {
    out.push('  ③ dry=1：★跳过真实点击✗★（只做点前检查和点后判据 ✓）');
  }
  const after = await frame(kv.after ? { img: kv.after } : kv, null);
  const ocrA = await deps.ocrJson(after.path);
  const vr = verifyCriteria(ocrA.text, criteria);
  let diff = null;
  try {
    const A = await lumaOfImage(before.path), B = await lumaOfImage(after.path);
    diff = diffStats(A.luma, B.luma);
  } catch (e) { /* 图不可比就把 diff 留空 ✓ 不许拿它当成功证据 ✗ */ }
  out.push('  ④ 点后核对：抓帧 ' + String(after.path).split(/[\\/]/).pop() + '，OCR 里 ' + (vr.ok ? '★全部判据都出现了 ✓★' : '缺 ' + JSON.stringify(vr.missing) + ' ✗'));
  if (diff) out.push('     before/after 像素差：平均 ' + diff.mean.toFixed(2) + '/255，变化像素 ' + (diff.changedRatio * 100).toFixed(1) + '%'
    + '（★这只是参考信息 ✗——"屏幕有变化"永远不能单独当成功证据 ✓★）');
  const changedALot = diff && diff.changedRatio >= 0.1;
  /* ★判据满足 → **清账**★（"已经确认状态真的变了" → 同一目标可以重新开始 ✓）
     判据没满足 → 什么都不做：账本里"这个点已经点过"那一笔留着 ✓（第二次点就要求新证据了 ✓） */
  if (vr.ok) { try { require('./prov').instance.clear(t.x, t.y); } catch (e) {} }
  out.push(vr.ok
    ? '  ✅ ★判定成功★：判据 [' + criteria.join(' 且 ') + '] 满足了 ✓（而且 before/after 的差是"变化"的旁证 ✓，判据才是结论 ✓）'
    : '  ❌ ★判定失败✗★：点完之后画面里**没有**出现 [' + vr.missing.join('、') + '] ✓ —— ★如实报失败✗，不要在这附近反复试✓★'
      + (diff
        ? (changedALot
          ? '（注意：屏幕确实"变了" ' + (diff.changedRatio * 100).toFixed(1) + '% ✓ —— ★但变了不等于点对了✗★，这正是今晚那个坑 ✓）'
          : '（这两帧几乎没变：变化像素 ' + (diff.changedRatio * 100).toFixed(1) + '% ✓ —— 但★"没变化"也不能单独说明成败✗★，结论只看判据 ✓）')
        : ''));
  return out.join('\n');
}

/* ★③ 面板状态查询（"我现在在哪个面板"✓）—— 直接对应"卡在不存在确认按钮上乱找"那个失败模式 ✓
 * 用法：panel_state|img=<图，可省>|expect=<面板名，可省>
 * 面板名：base（基地视图）/ select（选人面板）/ queue（进驻队列面板）/ dsh（桌宠自己的窗口 ✗ 不是游戏 ✓）
 * ★指纹词都是"只在该面板出现"的词 ✓（真机实测出来的 ✓）★ */
async function panelState(arg) {
  const { kv } = parseArg(arg);
  const fr = await frame(kv, null);
  const ocr = await deps.ocrJson(fr.path);
  const P = require('./panel');
  const d = P.detect(ocr, {});
  const out = [];
  out.push('🧭 面板状态：' + (d.verdict === 'ok' ? '★' + d.label + '★' : '⚠️ ' + d.verdict));
  out.push('  ' + d.note);
  out.push('  所有面板的命中数：' + d.all.map((x) => x.name + '=' + x.score + (x.hits.length ? JSON.stringify(x.hits) : '')).join('　'));
  if (kv.expect) {
    if (d.verdict === 'ok' && d.panel === kv.expect) out.push('  ✅ 与你要的「' + kv.expect + '」一致 ✓ 可以在这个面板里找按钮 ✓');
    else out.push('  ❌ ★和你要的「' + kv.expect + '」不一致✗★ —— ★先切到那个面板再来✗，别在这个画面上找那个按钮（今晚她就是这么卡的 ✓）★');
  }
  out.push('  ⚠️ 只有指纹词足够（≥2 ✓）才下结论 ✓；证据不足就报 unknown ✓（★不瞎猜✗★）。');
  return out.join('\n');
}

async function run(tool, arg) {
  if (tool === 'find_owned') return await findOwned(arg);
  if (tool === 'click_checked') return await clickChecked(arg);
  if (tool === 'panel_state') return await panelState(arg);
  throw new Error('ownclick 不认识这个工具：' + tool);
}

module.exports = Object.assign(module.exports, {
  /* 纯函数（可单测 ✓ 不依赖屏幕 ✓） */
  norm, phrasesFromOcr, fuzzyFromOcr, normTxt, lcsLen, coverage, pairOwners, ownedBy, verifyCriteria, validateCriteria, diffStats, median,
  /* 工具层 */
  install, run, findOwned, clickChecked, panelState, parseArg, toSpace, lumaOfImage,
});

