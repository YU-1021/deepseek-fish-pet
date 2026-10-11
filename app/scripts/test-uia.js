/* uia.js 单元测试（只测纯逻辑：parse / crossCheck / buildScript；
 * 真正的控件树查询是 live 的，放在探针里验）
 * 跑法：node app/scripts/test-uia.js */
const U = require('../src/uia');
let pass = 0, fail = 0;
function ok(c, l, e) { if (c) { pass++; console.log('  ✅ ' + l + (e ? '   ' + e : '')); } else { fail++; console.log('  ❌ ' + l + (e ? '   ' + e : '')); } }

console.log('=== uia.js 单元测试（纯逻辑）===');

/* §1 parse：把 PowerShell 的输出解析成结构 */
{
  const out = [
    'WINDOW|100|200|400|300|计算器',
    'EL|Button|num3Button|三|1640|650|24|24|1652|662',
    'EL|Button|equalButton|等于|1702|712|96|24|1750|724',
    'COUNT|2',
  ].join('\r\n');
  const r = U.parse(out);
  ok(r.window && r.window.x === 100 && r.window.w === 400, '§1 解析出窗口矩形', JSON.stringify(r.window));
  ok(r.elements.length === 2, '§1 解析出 2 个元素');
  ok(r.elements[0].automationId === 'num3Button' && r.elements[0].name === '三', '§1 元素带 AutomationId 和名字');
  ok(r.elements[0].cx === 1652 && r.elements[0].cy === 662, '§1 元素带中心点（可直接点击）', r.elements[0].cx + ',' + r.elements[0].cy);
  ok(r.elements[1].controlType === 'Button', '§1 元素带控件类型');
  ok(r.count === 2, '§1 解析出总数');
}
{
  ok(U.parse('NOTFOUND').notFound === true, '§1 识别 NOTFOUND');
  const e = U.parse('ERR|无法将值 ∞ 转换为 System.Int32');
  ok(e.error && e.error.indexOf('∞') >= 0, '§1 识别并保留错误信息', e.error);
  ok(U.parse('').elements.length === 0 && U.parse('').window === null, '§1 空输入不崩');
}

/* §2 ★crossCheck：用 UIA 的真值去验证 OCR 的框★
 *    这是"交叉验证"的落点：UIA 和应用自己报告的矩形是准的，OCR 是识别出来的 */
{
  const uiaRect = { x: 1640, y: 650, w: 24, h: 24 };     // 中心 (1652,662)
  ok(U.crossCheck(uiaRect, { x: 1640, y: 650, w: 24, h: 24 }).ok === true, '§2 完全一致 → 通过');
  ok(U.crossCheck(uiaRect, { x: 1636, y: 648, w: 24, h: 24 }).ok === true, '§2 差几像素 → 默认 24px 容差内通过');
  const bad = U.crossCheck(uiaRect, { x: 1200, y: 600, w: 24, h: 24 });
  ok(bad.ok === false, '§2 ★差得远 → 判"识别错了"★', 'dx=' + bad.dx + ' dy=' + bad.dy);
  ok(U.crossCheck(null, { x: 1, y: 1, w: 1, h: 1 }).ok === false, '§2 缺 UIA 数据 → 不通过（不假装）');
  ok(U.crossCheck({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }, 0).ok === true, '§2 容差可调为 0');
}

/* §3 buildScript：占位符必须被替换干净（历史教训：漏替换会把字面量送进 PowerShell） */
{
  const s = U.buildScript('find', "计算器", "等于'带单引号");
  ok(s.indexOf('__WANT__') < 0 && s.indexOf('__NEEDLE__') < 0 && s.indexOf('__MODE__') < 0, '§3 三个占位符都被替换');
  ok(s.indexOf("''带单引号") >= 0, '§3 ★单引号被正确转义（防注入/防语法错）★');
  ok(s.indexOf('IsInfinity') >= 0 && s.indexOf('IsNaN') >= 0, '§3 脚本里带了非有限值保护（实测 ∞ 会让查询整体失败）');
  ok(s.indexOf('catch') >= 0, '§3 脚本有整体 try/catch');
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
