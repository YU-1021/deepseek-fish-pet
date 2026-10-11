/* safedrive.js 的单元测试（纯逻辑部分，不碰键鼠、不需要 electron）
 * 跑法：node app/scripts/test-safedrive.js
 */
const SD = require('../src/safedrive');
const FD = require('../src/framediff');

let pass = 0, fail = 0;
function ok(c, label, extra) {
  if (c) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

console.log('=== safedrive.js 单元测试（纯逻辑）===');

/* §1 pointInRect：这是"防点到别的窗口上"的判据 */
{
  const R = { x: 100, y: 200, w: 400, h: 300 };
  ok(SD.pointInRect(300, 350, R).ok === true, '§1 正中心的点 → 在窗口内');
  ok(SD.pointInRect(103, 203, R).ok === true, '§1 左上角内侧(越过 margin) → 在窗口内');
  ok(SD.pointInRect(101, 201, R).ok === false, '§1 贴边界 1px → 默认 margin 判 false（我第一版这里写错了期望）');
  ok(SD.pointInRect(99, 350, R).ok === false, '§1 左边界外 1px → 不在窗口内');
  ok(SD.pointInRect(300, 501, R).ok === false, '§1 下边界外 → 不在窗口内');
  ok(SD.pointInRect(500, 350, R).ok === false, '§1 右边界外 → 不在窗口内');
  /* 边界：默认 margin=2，所以正好贴在边上（x=100）应判 false */
  ok(SD.pointInRect(100, 350, R).ok === false, '§1 正好压左边界 → 默认 margin 判 false（防误点边框）');
  ok(SD.pointInRect(100, 350, R, 0).ok === true, '§1 margin=0 时压边界算通过（可调）');
  ok(SD.pointInRect(300, 350, null).ok === false, '§1 没有矩形 → 直接 false（宁可不点）');
}

/* §2 diffRegion：只比目标区域，别被全屏噪声干扰 */
{
  const W = 100, H = 80;
  const mk = () => { const b = Buffer.alloc(W * H * 4); for (let i = 0; i < W * H; i++) { const p = i * 4; b[p] = b[p + 1] = b[p + 2] = 30; b[p + 3] = 255; } return b; };
  const a = mk(), b = mk();
  /* 在窗口【内】改一大块 */
  for (let y = 30; y < 60; y++) for (let x = 20; x < 60; x++) { const p = (y * W + x) * 4; b[p] = b[p + 1] = b[p + 2] = 220; }
  const rect = { x: 10, y: 20, w: 70, h: 60 };
  const rIn = SD.diffRegion(FD, a, b, W, H, rect);
  ok(rIn.ok && rIn.changed === true, '§2 区域内变了 → 判"变了"', 'ratio=' + rIn.ratio);
  ok(rIn.region && rIn.region.w === 70 && rIn.region.h === 60, '§2 报出实际比对的区域', JSON.stringify(rIn.region));
  /* 同一对图，但换了【不含变化】的区域 → 应判没变（这正是"只看该看的地方"的价值） */
  const rect2 = { x: 0, y: 0, w: 15, h: 20 };
  const rOut = SD.diffRegion(FD, a, b, W, H, rect2);
  ok(rOut.ok && rOut.changed === false, '§2 变化在区域外 → 判"没变"（不被别处噪声骗）', 'ratio=' + rOut.ratio);
  /* 越界矩形要被夹住而不是崩 */
  const rClamp = SD.diffRegion(FD, a, b, W, H, { x: 90, y: 70, w: 500, h: 500 });
  ok(rClamp.ok === true && rClamp.region.w <= 10 && rClamp.region.h <= 10, '§2 越界矩形被夹到图内', JSON.stringify(rClamp.region));
}

/* §4 cursorMatches：动作【效果断言】的判据
 *    实测事故：input.move() 返回 true，而 Win32 GetCursorPos 一查差 551px ——
 *    工具层把"命令发出去了"当成了"光标到了"。这个判据就是用来抓它的。 */
{
  ok(SD.cursorMatches({ x: 100, y: 200 }, { x: 100, y: 200 }).ok === true, '§4 完全一致 → 通过');
  ok(SD.cursorMatches({ x: 100, y: 200 }, { x: 104, y: 202 }).ok === true, '§4 差 4/2 像素 → 默认 6px 容差内通过');
  ok(SD.cursorMatches({ x: 100, y: 200 }, { x: 107, y: 200 }).ok === false, '§4 差 7 像素 → 超容差 → 判失败');
  ok(SD.cursorMatches({ x: 100, y: 200 }, { x: 100, y: 200 }, 0).ok === true, '§4 容差可调（0 表示必须精确）');
  ok(SD.cursorMatches({ x: 100, y: 200 }, null).ok === false, '§4 没读到光标 → 判失败（宁可不认，不假装成功）');
  ok(SD.cursorMatches(null, { x: 1, y: 1 }).ok === false, '§4 没有目标 → 判失败');
  const r = SD.cursorMatches({ x: 100, y: 200 }, { x: 651, y: 200 });
  ok(r.dx === 551 && r.ok === false, '§4 ★能把当年那次"差 551 像素"如实报出来★', 'dx=' + r.dx);
}

/* §3 断言的语义：assertForeground 在没有 electron 环境时也要能返回结构（失败要显式） */
{
  const p = SD._internals.pointInRect;
  ok(typeof p === 'function', '§3 内部判据已导出（可被测试覆盖）');
}

console.log('');
console.log('通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
