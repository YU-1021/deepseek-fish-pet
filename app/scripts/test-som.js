/* som.js 单元测试（全纯逻辑：合并/去重/提示词/解析/画框像素）
 * 跑法：node app/scripts/test-som.js
 */
const S = require('../src/som');
let pass = 0, fail = 0;
function ok(c, l, e) { if (c) { pass++; console.log('  ✅ ' + l + (e ? '   ' + e : '')); } else { fail++; console.log('  ❌ ' + l + (e ? '   ' + e : '')); } }

console.log('=== som.js 单元测试 ===');

/* §1 collectCandidates：把四类来源合并 */
{
  const c = S.collectCandidates({
    words: [{ t: '确认', x: 10, y: 20, w: 40, h: 16 }],
    templates: [{ name: '明日方舟-确认', x: 8, y: 18, w: 44, h: 20 }],
    uiaRects: [{ name: '确认按钮', automationId: 'okBtn', x: 9, y: 19, w: 42, h: 18 }],
    extra: [{ text: '手画的', x: 100, y: 100, w: 50, h: 20 }],
  });
  ok(c.length === 4, '§1 四类来源都收进来了');
  ok(c.map((x) => x.kind).join() === 'ocr,template,uia,extra', '§1 每类带自己的 kind', c.map((x) => x.kind).join());
  ok(S.collectCandidates({ words: [{ t: 'x', x: 0, y: 0, w: 0, h: 0 }] }).length === 0, '§1 尺寸为 0 的候选被丢掉（避免画不出框）');
}

/* §2 overlapRatio（OmniParser 口径：交集 ÷ 较小者面积） */
{
  const a = { x: 0, y: 0, w: 100, h: 100 };
  ok(S.overlapRatio(a, { x: 0, y: 0, w: 100, h: 100 }) === 1, '§2 完全重合 → 1');
  ok(S.overlapRatio(a, { x: 0, y: 0, w: 50, h: 50 }) === 1, '§2 小框完全在大框里 → 1（÷较小者）');
  ok(S.overlapRatio(a, { x: 100, y: 0, w: 50, h: 50 }) === 0, '§2 相邻不重叠 → 0');
  ok(S.overlapRatio(a, { x: 0, y: 0, w: 0, h: 0 }) === 0, '§2 零面积 → 0（不除零）');
}

/* §3 ★dedupe：重叠 >90% 只留一个，且优先级 uia > template > ocr★ */
{
  const same = (kind, conf) => ({ x: 10, y: 10, w: 40, h: 20, text: kind, kind, confidence: conf });
  const cands = [same('ocr', 0.99), same('uia', 0.9), same('template', 0.95), { x: 200, y: 10, w: 40, h: 20, text: '另一个', kind: 'ocr', confidence: 0.8 }];
  const kept = S.dedupe(cands);
  ok(kept.length === 2, '§3 三个重合的只留一个', '留下 ' + kept.length + ' 个');
  ok(kept[0].kind === 'uia' || kept[1].kind === 'uia', '§3 ★留下的那个是 UIA（优先级最高，哪怕 OCR 置信度更高）★', kept.map((k) => k.kind).join());
  ok(kept.every((k) => k.id >= 1), '§3 留下的都编了号');
  ok(kept[0].id === 1 && kept[1].id === 2, '§3 编号从 1 开始连续');
}

/* §4 编号顺序 = 阅读顺序（上到下、左到右）—— 模型才好对 */
{
  const cands = [
    { x: 500, y: 10, w: 40, h: 20, text: 'B', kind: 'ocr', confidence: 0.8 },
    { x: 10, y: 10, w: 40, h: 20, text: 'A', kind: 'ocr', confidence: 0.8 },
    { x: 10, y: 200, w: 40, h: 20, text: 'C', kind: 'ocr', confidence: 0.8 },
  ];
  const kept = S.dedupe(cands);
  ok(kept.map((k) => k.text).join() === 'A,B,C', '§4 先按行（y）再按列（x）排序编号', kept.map((k) => k.id + ':' + k.text).join(' '));
}

/* §5 buildPrompt：必须包含候选清单的 id→文字，且明确禁止坐标 */
{
  const cands = [{ id: 1, x: 0, y: 0, w: 10, h: 10, text: '确认', kind: 'ocr' }, { id: 2, x: 0, y: 20, w: 10, h: 10, text: '', kind: 'template' }];
  const p = S.buildPrompt(cands, '确认按钮');
  ok(/1\. 「确认」/.test(p), '§5 清单里带 id 和框内的文字（=局部语义，调研说这一步把 70.5% 提到 93.8%）');
  ok(/2\. \(无文字\)/.test(p), '§5 没有文字的候选也列出来（标"无文字"）');
  ok(/确认按钮/.test(p), '§5 带上目标描述（我给的是"确认按钮"，所以不该再断言默认词）');
  ok(/目标/.test(S.buildPrompt(cands, '')), '§5 没给目标描述时回落到默认词');
  ok(/只输出一行 JSON/.test(p) && /"confidence"/.test(p), '§5 明确要求只回 JSON');
  ok(/绝对不要输出坐标/.test(p), '§5 ★明确禁止模型输出坐标★');
}

/* §6 parseAnswer：容忍解释文字、```json ``` 包裹、单引号 */
{
  ok(S.parseAnswer('{"id": 3, "confidence": 0.9}').id === 3, '§6 标准 JSON');
  ok(S.parseAnswer('好的，我选\n```json\n{"id": 5, "confidence": 0.7}\n```').id === 5, '§6 被代码块包裹也能解析', 'id=5');
  ok(S.parseAnswer("{'id': 2, 'confidence': 0.5}").id === 2, '§6 单引号 JSON 也能解析');
  ok(S.parseAnswer('id: 7').id === 7, '§6 只有 id 也能解析');
  const neg = S.parseAnswer('{"id": -1, "confidence": 0}');
  ok(neg.ok === false && neg.id === -1, '§6 -1 = 清单里没有 → ok=false（不能拿去点）');
  const bad = S.parseAnswer('我找不到');
  ok(bad.ok === false && bad.reason === 'no-id-in-answer', '§6 没有 id → 明确报 no-id-in-answer');
}

/* §7 ★drawMarks：纯像素操作，能验证"框真的画上去了"★ */
{
  const W = 200, H = 100;
  const buf = Buffer.alloc(W * H * 4);
  const cands = [{ id: 1, x: 20, y: 30, w: 40, h: 20, text: 'a' }, { id: 2, x: 100, y: 30, w: 40, h: 20, text: 'b' }];
  const r = S.drawMarks(buf, W, H, cands);
  ok(r.drawn === 2, '§7 画了 2 个框');
  /* 检查编号 1 的框线像素被改成了红色（BGRA: R=255 在 p+2） */
  const p = (30 * W + 20) * 4;
  ok(buf[p + 2] === 255 && buf[p + 3] === 255, '§7 ★框线像素真的被写成红色且不透明了★', 'B=' + buf[p] + ' G=' + buf[p + 1] + ' R=' + buf[p + 2] + ' A=' + buf[p + 3]);
  /* 远离框的地方应该没被改 */
  const q = (90 * W + 90) * 4;
  ok(buf[q + 2] === 0 && buf[q + 3] === 0, '§7 没画到的地方保持原样（没越界乱涂）');
  /* 越界的框不该崩 */
  const r2 = S.drawMarks(buf, W, H, [{ id: 9, x: -50, y: -50, w: 40, h: 20 }]);
  ok(r2.drawn === 1, '§7 越界的框不崩（setPx 内部有边界检查）');
}

/* §8 点阵字：0-9 都有，且能画出来 */
{
  let all = true;
  for (let d = 0; d <= 9; d++) {
    const g = S.FONT5x7[d];
    if (!g || g.length !== 7 || g.some((row) => row.length !== 5)) all = false;
  }
  ok(all, '§8 0-9 十个数字都有完整的 5x7 点阵');
  const W = 60, H = 30;
  const buf = Buffer.alloc(W * H * 4);
  const end = S.drawDigits(buf, W, H, '12', 2, 2, [255, 255, 255], 2);
  let lit = 0;
  for (let i = 0; i < W * H; i++) if (buf[i * 4 + 3] === 255) lit++;
  ok(lit > 10, '§8 画数字确实点亮了若干像素', '点亮 ' + lit + ' 个');
  ok(end > 2, '§8 返回了结尾 x（方便连续画多个数字）', 'end=' + end);
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
