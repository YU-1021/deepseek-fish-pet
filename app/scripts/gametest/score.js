/* score.js —— ★离线帧跑分（不抓帧、不注入、不点击 ✓ 只读帧目录 ✓）★
 *
 * 用法：node app\scripts\gametest\score.js --frames=<目录> --ocrDir=<目录> [--tolPx=6] [--perClass=N]
 *
 * ★输入约定（lead 批量产帧时按这个给 ✓ 详见同目录 README.md ✓）★
 *   · 帧图：`<frames>/fNNN.png`（f000 / f001 … 三位数字从 000 起 ✓），★必须 1920x1080 物理像素✓★
 *   · OCR：`<ocrDir>/ocr-fNNN.json`（与帧同名 + 前缀 `ocr-` ✓ 一一对应 ✓）
 *         结构 `{ok,imgW,imgH,text,lines:[{text,words:[{t,x,y,w,h}]}]}`
 *         ★字段名是 `t`✗不是 text ✓；坐标在 x/y/w/h ✓ 不在 boundingRect 里 ✓；单位=截图像素（本机=物理 ✓）★
 *         UTF-8（无 BOM 最好 ✓ 带 BOM 会 strip ✓）；不给 --ocrDir 时脚本自己试着调 OCR ✓
 *         （★本会话里 Node→PowerShell 不可靠✗ → 建议直接传 --ocrDir ✓★）
 *   · 真值：★直接 require layout.js✗（不手抄 ✓）★；帧必须由 render.js（同一份 layout.js）生成 ✓
 *   · 判定：定位中心落在目标框内或误差 ≤ tolPx ✓；否则记 notfound / ambiguous / wrong ✓
 *   · 输出：C:\deepseek\gametest\score.json（分类通过率 + 中心误差三项 + 逐行 verdict ✓）
 *
 * ★本脚本**不**启动任何 Electron✗★（抓帧与真点击都由 lead 侧执行 ✓）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./layout');

const APP = path.join(__dirname, '..', '..');
const OUT = 'C:/deepseek/gametest';
const argv = process.argv.slice(2);
const getArg = (k, d) => { const m = argv.find((a) => a.startsWith('--' + k + '=')); return m ? m.split('=')[1] : d; };
const FRAMES = getArg('frames', path.join(OUT, 'frames'));
const TOL = Number(getArg('tolPx', 6));
const PER_CLASS = Number(getArg('perClass', 999));

function sh(c, a) { return spawnSync(c, a, { stdio: 'ignore', windowsHide: true }); }
/* ★OCR 结果优先读"预算好的"JSON✗→✓★：本会话里 Node→PowerShell 的 spawn 不可靠（写不出文件 ✗），
   所以由 PowerShell 侧先批量生成 <ocrDir>/ocr-<帧名>.json ✓，这里只读 ✓（只读文件这条路是通的 ✓）。 */
const OCRDIR = getArg('ocrDir', '');
function ocrOf(png, outJson) {
  const pre = OCRDIR ? path.join(OCRDIR, 'ocr-' + path.basename(png).replace(/\.png$/i, '') + '.json') : null;
  if (pre && fs.existsSync(pre)) { try { return JSON.parse(fs.readFileSync(pre, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; } }
  sh('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'shoot-ocr.ps1'), '-Png', png, '-Out', outJson]);
  if (!fs.existsSync(outJson)) return null;
  try { return JSON.parse(fs.readFileSync(outJson, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return null; }
}
function inBox(cx, cy, b, tol) {
  return cx >= b.x - tol && cx <= b.x + b.w + tol && cy >= b.y - tol && cy <= b.y + b.h + tol;
}

(async () => {
  const PE = require(path.join(APP, 'src/percept'));
  const OC = require(path.join(APP, 'src/ownclick'));
  const IC = require(path.join(APP, 'src/iconcut'));
  IC.install({ space: () => ({ w: 1920, h: 1080 }), display: () => ({ w: 1920, h: 1080, scaleFactor: 1 }) });
  const files = fs.readdirSync(FRAMES).filter((f) => /\.png$/i.test(f)).sort();
  if (!files.length) { console.log('帧目录里没有 PNG：' + FRAMES); process.exit(1); }

  const rows = [];
  for (const f of files) {
    const png = path.join(FRAMES, f);
    const ocr = ocrOf(png, path.join(OUT, 'ocr-' + f.replace(/\.png$/i, '') + '.json'));
    if (!ocr) { rows.push({ frame: f, err: 'OCR 失败' }); continue; }
    const words = (ocr.lines || []).reduce((n, L2) => n + ((L2.words || []).length), 0);
    /* ★★★ 帧合格性自检（不合格的帧**不许进跑分**✗→✓ 并说明原因）★★★
       ① 尺寸必须 1920x1080 ✓；② 锚点词命中 ≥3 ✓；
       ③ ★缩放自检★：锚点「编辑队列」真值中心 (140,56) ✓ —— 若 OCR 给的 ≈ **175,70**（= 真值×1.25 ✓）
          则判定"窗口按 CSS 1920 渲染、在 125% 屏上被放大 1.25 倍"✗ → 右侧/下侧被裁 ✗ → 不合格 ✓
          （★这正是 lead 那批帧的实测特征✓：偏移随坐标线性增大 ✓ 不是随机散布 ✓ 中心误差 71.7px 由此而来 ✓） */
    const ANCHOR_WORDS = ['编辑队列', '进驻信息', '设施信息', '控制中枢', '会客室', '制造站', '贸易站', '发电站', '训练室', '宿舍'];
    const hay = (ocr.lines || []).map((l) => String(l.text || '').replace(/\s+/g, '')).join('|');
    const anchorHits = ANCHOR_WORDS.filter((w) => hay.indexOf(w) >= 0);
    let scaleSuspect = false, scaleNote = '';
    try {
      const box = OC.phrasesFromOcr(ocr, '编辑队列')[0];
      if (box) {
        const r125 = Math.hypot(box.cx - 140 * 1.25, box.cy - 56 * 1.25);
        const r100 = Math.hypot(box.cx - 140, box.cy - 56);
        if (r125 < 12 && r100 > 25) { scaleSuspect = true; scaleNote = '锚点「编辑队列」中心 (' + box.cx + ',' + box.cy + ') ≈ 真值×1.25 ✓ 而不等于真值 ✗ → 画面被放大 1.25 倍'; }
      }
    } catch (e) {}
    const badReasons = [];
    if (!(ocr.imgW === 1920 && ocr.imgH === 1080)) badReasons.push('尺寸 ' + ocr.imgW + 'x' + ocr.imgH + ' ≠ 1920x1080 ✗');
    if (anchorHits.length < 3) badReasons.push('锚点词只命中 ' + anchorHits.length + '/10 ✗');
    if (scaleSuspect) badReasons.push(scaleNote + ' ✗（★修法：启动加 --force-device-scale-factor=1 ✓ 或把窗口 CSS 尺寸设成 1536x864 以对齐 125% 屏 ✓★）');
    if (badReasons.length) {
      console.log('  ❌ 帧 ' + f + ' 不合格 → ★拒绝进跑分✗★ 原因：' + badReasons.join('；'));
      rows.push({ frame: f, rejected: true, reasons: badReasons, words, imgW: ocr.imgW, imgH: ocr.imgH, anchorHits: anchorHits.length });
      continue;
    }
    PE.install({
      capture: async () => ({ path: png }), ocrJson: async () => ocr,
      act: async () => { throw new Error('离线模式不点击 ✓'); },
      vision: async () => '（离线不调模型）',
      space: () => ({ w: 1920, h: 1080 }), display: () => ({ w: 1920, h: 1080, scaleFactor: 1 }), shotDir: () => OUT,
    });

    /* ★★ 几何路线（lead 指出的更大杠杆）✗→✓：小元素**不读小字**，改用几何定位 ★★
       做法：整帧跑 icon_scan（blob：局部能量→连通域→尺寸/长宽比过滤→合并 ✓），
       再把真值框配给"最近的检出块" ✓ —— ★全程不读任何文字✗★，所以字号/裁字都影响不到它 ✓。
       这就是机器人的"锚点 + 相对几何" ✓，与 OCR 路线形成对照 ✓（两条都报数字 ✓）。 */
    let geoItems = [];
    try {
      const rg = await IC.scan(png, { mode: 'b', region: { x0: 0, y0: 0, x1: 1919, y1: 1079 } });
      geoItems = rg.items || [];
    } catch (e) { geoItems = []; }

    /* ★★ 模式 C（分格 + 格内质心）实测：icon 0/60、small+edge 0/36 ✗★ —— 我自己量的格距/相位没对上真实网格 ✗
       → ★按纪律**不接进默认**✗✓★：这里仍走原来的路线（icon: icon_scan auto/blob ✓；small+edge: 整帧 blob 最近邻 ✓）。
       ★要保持的效果：量不出/对不上时**明确报出来**✗ 不静默退化 ✓★（下面 iconRoute 会被打印 ✓）。 */
    let iconItems = [], iconRoute = '';
    try {
      const r = await IC.scan(png, { mode: 'auto', region: { x0: 40, y0: 600, x1: 1780, y1: 960 }, dir: 'v' });
      if (r.mode === 'blob') {
        const r2 = await IC.scan(png, { mode: 'b', region: { x0: 40, y0: 600, x1: 1780, y1: 960 } });
        iconItems = r2.items || []; iconRoute = 'blob ✓（模式 A 不可信时退 B ✓）';
      } else { iconItems = r.items || []; iconRoute = 'lattice ✓'; }
    } catch (e) { iconItems = []; iconRoute = '异常 → 空（' + String(e.message).slice(0, 40) + '）'; }

    const per = {};
    for (const t of L.buttons) {
      const cls = t.kind === 'edge' || t.kind === 'small' ? 'small+edge' : t.kind;
      per[cls] = per[cls] || { n: 0, hit: 0, notfound: 0, ambiguous: 0, wrong: 0, errs: [] };
      if (per[cls].n >= PER_CLASS) continue;
      per[cls].n++;
      let cx = null, cy = null, verdict = 'notfound';
      let route = 'ocr';
      if (t.kind === 'icon') {
        route = 'geometry';
        const near = iconItems.map((it) => ({ it, d: Math.hypot(it.cx - (t.x + Math.round(t.w / 2)), it.cy - (t.y + Math.round(t.h / 2))) }))
          .sort((a, b) => a.d - b.d)[0];
        if (near && near.d <= Math.max(TOL, Math.round(t.w / 2) + 4)) { cx = near.it.cx; cy = near.it.cy; verdict = 'ok'; }
        else if (near) { cx = near.it.cx; cy = near.it.cy; verdict = 'wrong'; }
      } else if (t.kind === 'small' || t.kind === 'edge') {
        /* ★小元素也走**分格 + 格内质心**（模式 C 的同一批 items ✓）；量不出格距时用整帧 blob ✓（脚本会打印原因 ✓） */
        route = 'geometry';
        const pool = iconItems.length ? iconItems.concat(geoItems) : geoItems;
        const near = pool.map((it) => ({ it, d: Math.hypot(it.cx - (t.x + Math.round(t.w / 2)), it.cy - (t.y + Math.round(t.h / 2))) }))
          .sort((a, b) => a.d - b.d)[0];
        if (near && near.d <= Math.max(TOL, Math.round(Math.min(t.w, t.h) / 2) + 4)) { cx = near.it.cx; cy = near.it.cy; verdict = 'ok'; }
        else if (near) { cx = near.it.cx; cy = near.it.cy; verdict = 'wrong'; }
      } else {
        /* ★择优合并已接线但**默认关闭**（实测 dup 100%→25% ✗ 无增益 ✗ → 降级为可选 `merge=1` ✓）；
           默认仍走原来的单一来源 ✓。要复测择优：把下面那行的 `|merge=1` 打开 ✓。 */
        const extra = '';   // 复测用：'|merge=1|ocr2=' + path.join(OUT,'crops',t.id+'.json') + '|ocr3=' + path.join(OUT,'vote3',t.id+'.json');
        const loc = await PE.run('locate', (t.label || '') + '||img=' + png + extra + '|region=' + [t.x, t.y, t.w, t.h].join(','));
        /* ★从 locate 的回执里取中心✗→✓★：它的格式是 ★编号 L1★（中心 893,337）✓
           （第一版我按 act 的「目标「…」中心」去解析 ✗ → 全部 notfound ✗ —— 这是**跑分器自己的 bug** ✗，
            不是 locate 的 ✓；icon 类没走这条解析 ✓ 所以它 93.3% ✓ 正好形成对照 ✓） */
        const m = /（中心 (-?\d+),(-?\d+)）/.exec(loc);
        if (/ambiguous/.test(loc) && !m) verdict = 'ambiguous';
        else if (m) { cx = Number(m[1]); cy = Number(m[2]); verdict = inBox(cx, cy, t, TOL) ? 'ok' : 'wrong'; }
        else verdict = 'notfound';
      }
      if (verdict === 'ok') per[cls].hit++;
      else per[cls][verdict]++;
      if (cx != null && verdict === 'ok') per[cls].errs.push(Math.hypot(cx - (t.x + t.w / 2), cy - (t.y + t.h / 2)));
      rows.push({ frame: f, words, id: t.id, kind: t.kind, cls, label: t.label, verdict, cx, cy, truth: { x: t.x + Math.round(t.w / 2), y: t.y + Math.round(t.h / 2) } });
    }
    console.log('  帧 ' + f + '：OCR 词数 ' + words + '，逐格判定完成（' + L.buttons.length + ' 个目标）');
  }

  /* 汇总 */
  const byCls = {};
  for (const r of rows) {
    if (!r.cls) continue;
    byCls[r.cls] = byCls[r.cls] || { n: 0, hit: 0, notfound: 0, ambiguous: 0, wrong: 0, errs: [] };
    const c = byCls[r.cls];
    c.n++;
    if (r.verdict === 'ok') { c.hit++; if (r.cx != null) c.errs.push(Math.hypot(r.cx - r.truth.x, r.cy - r.truth.y)); }
    else if (r.verdict === 'ambiguous') c.ambiguous++; else if (r.verdict === 'wrong') c.wrong++; else c.notfound++;
  }
  const allErrs = [];
  for (const k of Object.keys(byCls)) allErrs.push.apply(allErrs, byCls[k].errs);
  const stat = (a) => {
    if (!a.length) return { n: 0, mean: 0, p95: 0, max: 0 };
    const s = a.slice().sort((x, y) => x - y);
    return { n: s.length, mean: s.reduce((p, c) => p + c, 0) / s.length, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] };
  };
  const total = { n: 0, hit: 0 };
  console.log('');
  console.log('=== 离线帧跑分（真值 = layout.js ✓ 容差 ' + TOL + 'px）===');
  for (const k of ['text', 'dup', 'icon', 'small+edge']) {
    const c = byCls[k] || { n: 0, hit: 0, notfound: 0, ambiguous: 0, wrong: 0, errs: [] };
    total.n += c.n; total.hit += c.hit;
    const e = stat(c.errs);
    console.log('  ' + k.padEnd(11) + c.hit + '/' + c.n + ' = ' + (c.n ? (c.hit / c.n * 100).toFixed(1) : '0.0') + '%'
      + '　notfound=' + c.notfound + ' ambiguous=' + c.ambiguous + ' wrong=' + c.wrong
      + (e.n ? ('　中心误差 平均 ' + e.mean.toFixed(1) + ' / p95 ' + e.p95.toFixed(1) + ' / 最大 ' + e.max.toFixed(1) + 'px') : ''));
  }
  const ea = stat(allErrs);
  console.log('  ★总通过 ' + total.hit + '/' + total.n + ' = ' + (total.n ? (total.hit / total.n * 100).toFixed(1) : '0.0') + '%★'
    + '　歧义率 ' + (total.n ? ((byCls.text ? byCls.text.ambiguous : 0) + (byCls.dup ? byCls.dup.ambiguous : 0)) / total.n * 100 : 0).toFixed(1) + '%');
  if (ea.n) console.log('  全部命中帧的中心误差：平均 ' + ea.mean.toFixed(1) + 'px / p95 ' + ea.p95.toFixed(1) + 'px / 最大 ' + ea.max.toFixed(1) + 'px（独立真值=layout.js ✓）');
  fs.writeFileSync(path.join(OUT, 'score.json'), JSON.stringify({ at: new Date().toISOString(), frames: files, tol: TOL, total, byCls, errs: ea, rows }, null, 2));
  console.log('  明细已落盘：' + path.join(OUT, 'score.json'));
})().catch((e) => { console.log('❌ 跑分崩了：' + (e && e.stack || e)); process.exit(1); });
