/* occlusion.js 的单元测试（纯逻辑部分；scene() 需要真实窗口枚举，放在 live 探针里验）
 * 跑法：node app/scripts/test-occlusion.js
 */
const OC = require('../src/occlusion');

let pass = 0, fail = 0;
function ok(c, label, extra) {
  if (c) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

console.log('=== occlusion.js 单元测试（纯逻辑）===');

/* §1 intersects */
{
  const A = { x: 100, y: 100, w: 200, h: 200 };
  ok(OC.intersects(A, { x: 150, y: 150, w: 50, h: 50 }) === true, '§1 完全包含 → 相交');
  ok(OC.intersects(A, { x: 250, y: 250, w: 200, h: 200 }) === true, '§1 部分重叠 → 相交');
  ok(OC.intersects(A, { x: 400, y: 100, w: 50, h: 50 }) === false, '§1 右侧分离 → 不相交');
  ok(OC.intersects(A, { x: 100, y: 400, w: 50, h: 50 }) === false, '§1 下方分离 → 不相交');
  ok(OC.intersects(null, A) === false, '§1 缺参数 → 不相交（不抛）');
}

/* §2 pointCovered */
{
  const rects = [{ x: 10, y: 10, w: 100, h: 100, title: 'A' }, { x: 200, y: 200, w: 50, h: 50, title: 'B' }];
  ok(OC.pointCovered(50, 50, rects).title === 'A', '§2 落在 A 内 → 返回 A');
  ok(OC.pointCovered(210, 210, rects).title === 'B', '§2 落在 B 内 → 返回 B');
  ok(OC.pointCovered(150, 150, rects) === null, '§2 都不在 → null');
  ok(OC.pointCovered(50, 50, []) === null, '§2 空列表 → null');
}

/* §3 ★核心：filterWords 必须把"落在遮挡者区域内的词"丢掉★
 *    实测事故：我自己窗口里的"水月/阿/温蒂"被当成了页面卡片名 */
{
  const covered = [{ x: 1100, y: 0, w: 800, h: 1080, title: '我自己的窗口' }];
  const words = [
    { t: '阿', x: 600, y: 500, w: 20, h: 20 },          // 页面里 → 保留
    { t: '水月', x: 1500, y: 300, w: 40, h: 20 },       // 我自己窗口里 → 丢弃
    { t: '温蒂', x: 900, y: 700, w: 40, h: 20 },        // 页面里 → 保留
    { t: '傀影', x: 1180, y: 900, w: 40, h: 20 },       // 压线落在遮挡区 → 丢弃
  ];
  const r = OC.filterWords(words, covered);
  ok(r.kept.length === 2 && r.kept.map((w) => w.t).join() === '阿,温蒂', '§3 只保留页面里的词', JSON.stringify(r.kept.map((w) => w.t)));
  ok(r.dropped.length === 2, '§3 丢弃了两个被遮挡的词');
  ok(r.dropped[0].coveredBy === '我自己的窗口', '§3 丢弃时注明"被谁挡的"', r.dropped[0].coveredBy);
  const r2 = OC.filterWords(words, []);
  ok(r2.kept.length === 4 && r2.dropped.length === 0, '§3 没有遮挡者时全部保留（不误杀）');
}

/* §4 ★核心：computeCovered 必须看 z 序★
 *    "只按矩形重叠"会把压在目标【下面】的自己也算成遮挡者（我第一版就错） */
{
  const target = { hwnd: 100, x: 0, y: 0, w: 1000, h: 800, z: 5, topmost: false };
  const others = [
    { hwnd: 200, x: 500, y: 100, w: 400, h: 400, z: 2, topmost: false, title: '压在上面的普通窗' },  // z 更小 → 算
    { hwnd: 300, x: 500, y: 100, w: 400, h: 400, z: 9, topmost: false, title: '压在下面的窗' },      // z 更大 → 不算
    { hwnd: 400, x: 500, y: 100, w: 400, h: 400, z: 9, topmost: true, title: '置顶窗' },             // topmost → 算
    { hwnd: 500, x: 2000, y: 0, w: 100, h: 100, z: 1, topmost: false, title: '不相交' },             // 不相交 → 不算
    { hwnd: 100, x: 0, y: 0, w: 1000, h: 800, z: 1, topmost: false, title: '目标自己' },             // 自己 → 不算
    { hwnd: 600, x: 10, y: 10, w: 10, h: 10, z: 1, topmost: false, title: '太小的托盘窗' },           // 太小 → 不算
  ];
  const cov = OC.computeCovered(target, others, []);
  const titles = cov.map((c) => c.title).sort();
  ok(cov.length === 2, '§4 只算"z 更小 或 置顶"且相交的窗口', '得到 ' + cov.length + ' 个: ' + titles.join(' / '));
  ok(titles.indexOf('压在上面的普通窗') >= 0 && titles.indexOf('置顶窗') >= 0, '§4 上面那两个被算进来');
  ok(titles.indexOf('压在下面的窗') < 0, '§4 ★压在目标下面的窗口【不算】遮挡者（这条我第一版错过）★');
  /* ★ 这条是实测补的：任务切换/Codex 这类 visible=false 的隐藏帮手窗口
     曾被误判成"遮盖 100%"，害我拒绝了一个其实完全可见的计算器。 */
  const hidden = OC.computeCovered(target, [{ hwnd: 700, x: 0, y: 0, w: 1000, h: 800, z: 1, topmost: true, visible: false, title: '隐藏的置顶窗' }], []);
  ok(hidden.length === 0, '§4 ★visible=false 的窗口不算遮挡者（实测误报过 100% 遮盖）★', JSON.stringify(hidden.map((h) => h.title)));
  ok(titles.indexOf('目标自己') < 0 && titles.indexOf('不相交') < 0 && titles.indexOf('太小的托盘窗') < 0, '§4 自己/不相交/微小窗口都不算');
}

/* §5 extraRects（自己进程的窗口，z 序未知时也要算进去） */
{
  const target = { hwnd: 100, x: 0, y: 0, w: 1000, h: 800, z: 5 };
  const cov = OC.computeCovered(target, [], [{ x: 900, y: 0, w: 800, h: 1080, title: '(自己的窗口)' }]);
  ok(cov.length === 1 && cov[0].title === '(自己的窗口)', '§5 显式传入的自己窗口矩形会被算作遮挡者');
  const cov2 = OC.computeCovered(target, [], [{ x: 3000, y: 0, w: 100, h: 100 }]);
  ok(cov2.length === 0, '§5 不相交的自己窗口不算');
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
