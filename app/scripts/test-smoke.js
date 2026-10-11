/* 冒烟测试：真的去调那些依赖 PowerShell / 子进程的路径。
 *
 * ============================ 为什么单独一套 ============================
 * 这一场（2026-10-03）我在 focuswin 的 PS 里连写错三处 C#（UIntPtr 应为 IntPtr、
 * Thread 少了 System.Threading.、注释里的反引号把模板串截断），每一次都让 Add-Type
 * 编译失败 —— 而 listWindows 只默默返回 0 个窗口、一点不报错 ✗。
 * **全部 461 项纯逻辑单元测试一个都没抓到**，因为它们根本不碰子进程。
 *
 * 所以这套测试的判据刻意很弱但很关键：**不是空、不是错**（而不是断言具体值，
 * 因为屏幕内容每次都不同）。它守的是"这条路还活着"。
 *
 * 跑法：node app/scripts/test-smoke.js
 */
const fw = require('../src/focuswin');
const uia = require('../src/uia');

let pass = 0, fail = 0;
function ok(c, l, e) { if (c) { pass++; console.log('  ✅ ' + l + (e ? '   ' + e : '')); } else { fail++; console.log('  ❌ ' + l + (e ? '   ' + e : '')); } }

(async () => {
  console.log('=== 冒烟测试（真调 PowerShell / 子进程）===');

  /* §1 listWindows：这是被静默失败坑得最惨的一条 */
  let list = null;
  try { list = await fw.listWindows(); } catch (e) { list = { ok: false, error: 'threw: ' + e.message }; }
  ok(list && list.ok !== false, '§1 listWindows 没有报失败', list && list.error ? list.error : '');
  ok(Array.isArray(list.windows), '§1 返回了 windows 数组');
  ok(list.windows.length > 0, '§1 ★真的读到了窗口★（不是静默的 0 个）', list.windows.length + ' 个');
  ok(list.dpi > 0, '§1 读到了 DPI（PS 侧真的跑起来了）', 'dpi=' + list.dpi);
  ok(typeof list.foregroundHwnd === 'number', '§1 带回了前台 hwnd');

  /* §2 cursorPos：动作效果断言的输入源，一定要能读到 */
  let cur = null;
  try { cur = await fw.cursorPos(); } catch (e) { cur = null; }
  ok(cur && Number.isFinite(cur.x) && Number.isFinite(cur.y), '§2 cursorPos 读到了真实光标', cur ? cur.x + ',' + cur.y : 'null');

  /* §3 foreground：前台回读 */
  let fg = null;
  try { fg = await fw.foreground(); } catch (e) { fg = null; }
  ok(fg && (fg.title !== undefined || fg.hwnd !== undefined), '§3 foreground 有返回', fg ? JSON.stringify(String(fg.title || '').slice(0, 24)) : 'null');

  /* §4 UIA 通道：拿一个已知窗口（前台那个）的控件树 */
  const hwnd = list.foregroundHwnd || (list.windows[0] && list.windows[0].hwnd);
  if (hwnd) {
    let r = null;
    try { r = await uia.listElements('', hwnd); } catch (e) { r = { error: 'threw: ' + e.message }; }
    /* 有的窗口（UWP/最小化）确实没有子元素 —— 但**不能有 error** */
    ok(!r.error, '§4 UIA 查询没有报错', r.error || '');
    ok(typeof r.count === 'number', '§4 UIA 返回了元素计数', 'count=' + r.count + '（0 也可能是正常的，UWP/最小化窗口没有控件树）');
  } else {
    ok(false, '§4 拿不到 hwnd，跳过 UIA 冒烟');
  }

  /* §5 OCR 通道：这条必须真跑（它依赖 ocr.ps1）
     ⚠️ 这条只能在 electron 里跑（需要抓屏），纯 node 下 captureScreen 不可用 ——
        所以这里只断言"模块能导出 __lastOcrError"，真跑留给 electron 探针。 */
  let A = null;
  try { A = require('../src/assistant'); } catch (e) { A = null; }
  ok(!!A, '§5 assistant 模块能加载（纯 node 下不抓屏也应能加载）');
  ok(!A || typeof A.__lastOcrError === 'function', '§5 ★导出了 __lastOcrError（OCR 失败不再无迹可寻）★');

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})();
