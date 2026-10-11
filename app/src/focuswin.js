/* focuswin.js —— 窗口真值 + 真·置前台（带回读校验）
 *
 * ============================ 为什么重写 ============================
 * 旧版做的是 `SetWindowPos(HWND_TOPMOST)` —— **它只是把窗口"视觉上"抬到最上层**，
 * 从来没有调用 `SetForegroundWindow`。后果（2026-10-02 实测）：
 *   · 截图能看到目标窗口 ✓
 *   · 但 `GetForegroundWindow()` **一个字都没变** ✗
 *   · 而 Windows 把键盘输入发给【前台窗口】而不是"最上层窗口"
 *   → 于是 `key|ctrl+f` / `type|数据目录` 全部打到了别的窗口上 ✗
 *   → 而它们都返回 `true`，没人知道错了。这是今天一大半事故的根。
 *
 * 旧版 `listWindows` 还有第二个 bug：注释里写着"返回前必须乘回 scaleFactor"，
 * 但代码里**根本没乘** → 每个窗口的坐标都偏 25%（实测 UIA 说 1394，它说 1115 ✓ 1394/1115=1.2500）。
 *
 * ============================ 这一版怎么做 ============================
 * 1) **PS 子进程声明 DPI 感知**（DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2）
 *    → 它拿到的窗口矩形就是**物理像素**，和截图空间一致，**不需要再乘任何系数**。
 *    （如果系统拒绝声明，就把实际 scale 报出来，让调用方自己判断 —— 不猜。）
 * 2) **真·置前台**：分层尝试 4 种手段，每一步都回读校验：
 *      ① 直接 SetForegroundWindow
 *      ② 空按一下 Alt 解锁（Windows 只允许"前台进程"改前台，模拟用户输入可解锁）
 *      ③ AttachThreadInput 挂到当前前台线程再设
 *      ④ 最小化→恢复强制改变 z 序，再设
 *    最后 **回读 GetForegroundWindow()**，不是目标就返回 FAIL（绝不假成功）。
 * 3) 不再使用 HWND_TOPMOST —— 它造成过"游戏被永久置顶、用户没法跟我对话"的事故。
 * 4) 自带 CLI，方便外部直接驱动（不经桌宠主进程）：
 *      node focuswin.js list
 *      node focuswin.js fg
 *      node focuswin.js focus "<标题片段>"
 *      node focuswin.js rect "<标题片段>"
 */
const { execFile } = require('child_process');

/* ⚠️ 这段 PS 保持**纯 ASCII**：execFile 传 -Command 时的编码行为不可控，
 *    中文注释会让脚本在某些代码页下直接语法错误（今天踩过两次）。
 *    所有中文说明放在本文件的 JS 注释里。 */
const PS = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class FW2 {
  public delegate bool EP(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  /* ★ DWM 的 CLOAKED 属性 —— 判断窗口"到底有没有真的显示在屏幕上" ★
     实测事故：浏览器明明已经关掉了，桌面上只剩它的一条 URL 残影，
     而 Win32 的 IsWindowVisible() 仍返回 true，于是 target() 报 ok、
     后续所有 OCR/定位/点击全建在一个并不存在的窗口上 ✗。
     Windows 对"被 DWM 隐藏的窗口"（UWP 挂起、其他虚拟桌面、刚关闭的 Edge）会置这个标志。 */
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint f, IntPtr extra);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr ctx);
  /* ★ 光标真值 ★ 实测事故：input.move() 返回 true，而 Win32 GetCursorPos 一查差了 551px ——
     工具层把"命令发出去了"当成了"光标到了"。move/click 的效果断言必须回读它。 */
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT pt);
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern uint GetDpiForSystem();
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Rr,B; }

  public static string Want = "";
  public static List<string> All = new List<string>();
  public static IntPtr Hit = IntPtr.Zero;
  public static string HitTitle = "";
  public static bool DpiOk = false;

  public static void Init() {
    /* -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2.
       After this, GetWindowRect returns PHYSICAL pixels, matching the screenshot space (1920x1080).
       This kills the old 1.25x coordinate bug at the root.
       NOTE: keep this whole C# block ASCII-only (see the JS comment above). */
    DpiOk = SetProcessDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero;
  }
  public static uint Dpi() { return GetDpiForSystem(); }
  public static string Cursor() { PT pt; GetCursorPos(out pt); return pt.X + "," + pt.Y; }
  /* ★ 按一下 ESC：用来收掉"空按 Alt"可能打开的开始菜单/菜单栏 ★
     ⚠️ 这里必须写全 System.Threading.Thread —— 这个 C# 类没有 using System.Threading;，
        写成 Thread.Sleep 会让 Add-Type 编译失败（当前上下文中不存在名称 Thread），
        而失败之后 listWindows **静默返回 0 个窗口**、一点都不报错 ✗。
        （实测连踩两次：先是 UIntPtr/IntPtr 类型不符，然后是 Thread 找不到。）
     ⚠️ 另外：这段注释里**不能出现反引号** —— 整个 PS 脚本是 JS 的模板串（反引号），
        注释里再写一对反引号会把 JS 串截断，直接语法错误（刚踩过）。 */
  public static void SendEsc() { keybd_event(0x1B, 0, 0, IntPtr.Zero); System.Threading.Thread.Sleep(20); keybd_event(0x1B, 0, 2, IntPtr.Zero); }
  public static bool Cloaked(IntPtr h) { int v = 0; try { DwmGetWindowAttribute(h, 14, out v, 4); } catch {} return v != 0; }
  public static string TitleOf(IntPtr h) { var sb = new StringBuilder(400); GetWindowTextW(h, sb, 400); return sb.ToString(); }
  public static IntPtr Fg() { return GetForegroundWindow(); }

  public static void Scan() {
    All.Clear(); Hit = IntPtr.Zero; HitTitle = "";
    EnumWindows((h, p) => {
      string t = TitleOf(h);
      /* 不再用 IsWindowVisible 过滤：实测浏览器（Edge）可能处于 IsWindowVisible=false 的状态，
         但它照样是【前台窗口】—— 用可见性当过滤条件就会把它整个漏掉，
         于是 target() 报"找不到窗口"（2026-10-03 白跑一轮）。改成把它当**标志**报出来。 */
      if (t.Length > 0) {
        R r; GetWindowRect(h, out r);
        uint pid; GetWindowThreadProcessId(h, out pid);
        All.Add(t + " [" + r.L + "," + r.T + " " + (r.Rr - r.L) + "x" + (r.B - r.T) + "] hwnd=" + h + " pid=" + pid
                + " iconic=" + IsIconic(h) + " visible=" + IsWindowVisible(h)
                + " topmost=" + ((GetWindowLong(h, -20) & 0x8) != 0)
                + " cloaked=" + Cloaked(h) + " z=" + All.Count);
      }
      if (Want.Length > 0 && t.IndexOf(Want, StringComparison.OrdinalIgnoreCase) >= 0) {
        Hit = h; HitTitle = t; return false;
      }
      return true;
    }, IntPtr.Zero);
  }

  /* ★★★ 成功返回前的统一收尾：补一次显示 + 回读可见性 ★★★
     2026-10-03 抓到的铁证（对一个**本来可见**的 Windows 计算器窗口调 Focus）：
       调用前  hwnd=196736 visible=是      ← 窗口本来是好好显示着的
       返回    "OK step1 show5,"           ← 它报告成功了
       调用后  hwnd=196736 ★visible=否★    ← ★这套操作反而把它弄成不可见了★
     于是她读到"已置前台/回读确认"、截图上却只有壁纸，只能一次次重试然后放弃 ✗。
     根因是原代码只看 Fg() == Hit 就 return —— **Windows 允许把一个隐藏窗口设成"前台"**，
     所以 Fg()==Hit 根本不能证明"看得见" ✗。
     ⚠️ 注意：这段 C# 是写在 JS 模板串里的，**注释里绝对不能出现反引号** ——
        今天早些时候就因为这个把模板串提前结束过（编译报 SyntaxError），刚又踩了一次。
     → 所有成功路径都必须经过这里：先补一次 SW_SHOW，再回读 IsWindowVisible；
       看不见就降级成 step-showonly（部分成功 + 明确指引），绝不谎报成功。 */
  static string Finish(string tag, string tried) {
    ShowWindow(Hit, 5);                              /* SW_SHOW：补一次显示 */
    if (!IsWindowVisible(Hit)) {
      return "OK step-showonly fg-is=" + TitleOf(Fg()) + " tried=" + tried + ",finish-hidden"
        + " || 置前动作执行完了，但回读发现这个窗口**不可见**（visible=否）——UWP 应用常见，不是你的错。"
        + "接下来**用 click 直接点它的按钮**（点击不需要它在前台），别用键盘；"
        + "如果它一直不可见，先用 kill_app|<进程名> 清掉僵尸实例，再重新打开它。";
    }
    return "OK " + tag + " " + tried;
  }

  /* 真·置前台：分层尝试，每步回读校验 */
  public static string Focus() {
    if (Hit == IntPtr.Zero) return "NOTFOUND";
    string tried = "";
    if (IsIconic(Hit)) { ShowWindow(Hit, 9); tried += "restore1,"; }   /* SW_RESTORE */
    ShowWindow(Hit, 5); tried += "show5,";                             /* SW_SHOW */
    if (SetForegroundWindow(Hit) && Fg() == Hit) return Finish("step1", tried);
    /* Unlock: tap a modifier key. Windows only lets the foreground process set the
       foreground; injecting one real user input releases that lock.
       ★ 用 Shift(0x10) 而不是 Alt(0x12) ★
       实测事故（2026-10-03）：原来这里按的是 Alt —— 空按 Alt 会**打开开始菜单 / 菜单栏** ✗。
       我对着 11 个同名候选窗口连续聚焦之后，屏幕上多了一个开始菜单，
       把浏览器和桌宠窗口都盖住了（现场更难收拾）。
       Shift 同样被 Windows 算作"真实用户输入"，但不触发任何菜单，没有副作用。 */
    keybd_event(0x10, 0, 0, IntPtr.Zero);
    keybd_event(0x10, 0, 2, IntPtr.Zero);
    if (SetForegroundWindow(Hit) && Fg() == Hit) return Finish("step2-shift", tried);
    /* 万一还是被菜单之类的挡了，补一下 ESC 收尾（只关菜单，不动前台） */
    SendEsc();
    /* Attach to the current foreground thread's input queue (classic trick). */
    IntPtr fg = Fg();
    uint tidFg = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint tidMe = GetCurrentThreadId();
    AttachThreadInput(tidFg, tidMe, true);
    BringWindowToTop(Hit);
    bool ok3 = SetForegroundWindow(Hit);
    AttachThreadInput(tidFg, tidMe, false);
    if (ok3 && Fg() == Hit) return Finish("step3-attach", tried);
    /* Last resort: minimize then restore to force a z-order change, then set again. */
    ShowWindow(Hit, 6);                                                /* SW_MINIMIZE */
    ShowWindow(Hit, 9);                                                /* SW_RESTORE */
    SetForegroundWindow(Hit);
    if (Fg() == Hit) return Finish("step4-minimize", tried);
    /* ★★★ 抢不到前台 ≠ 失败（2026-10-03 实测，针对 UWP 应用）★★★
       现场：Windows 计算器被"隐藏"（visible=否 iconic=否）之后，
         ShowWindow(SW_SHOW) 能把它**显示出来**（实测 visible 立刻变 True ✓），
         但 SetForegroundWindow 怎么也抢不到前台 ✗ ——
         因为 Windows 只允许**前台进程**改前台，而计算器是 UWP，
         它的窗口属于 ApplicationFrameHost.exe，跟我们的进程不在同一个"前台锁"体系里。
       旧代码这时直接返回 FAIL ✗，于是她以为"窗口没弄出来"，
       在日志里说 "Calculator is minimized and won't come front"，然后反复重试、最终放弃 ✗。
       但那其实是**部分成功**：窗口已经可见了，只是当前台不是它。
       对这类目标正确做法是**别依赖键盘**（键盘只发给前台 ✗），
       改用 click 直接点它的按钮 ✓ —— 那就必须先让她知道"窗口已经出来了" ✓。
       所以这里判一下可见性：只要它现在是可见的，就报 OK step-showonly ✓，
       并附一句明确指引，让她接着用点击而不是继续跟前台较劲。 */
    bool shownNow = IsWindowVisible(Hit);
    if (shownNow) {
      return "OK step-showonly fg-is=" + TitleOf(Fg()) + " tried=" + tried
        + " || 窗口已经显示出来了，但抢不到前台（UWP 应用常见，不是你的错）。"
        + "接下来不要用键盘输入（键盘只会发给前台窗口），改用 click 直接点它的按钮/区域。";
    }
    return "FAIL fg-is=" + TitleOf(Fg()) + " visible=" + shownNow + " tried=" + tried;
  }
}
'@
[FW2]::Init()
[FW2]::Want = '__WANT__'
[FW2]::Scan()
$mode = '__MODE__'
if ($mode -eq 'list') {
  Write-Output ('DPI=' + [FW2]::Dpi() + ' dpiCtxOk=' + [FW2]::DpiOk)
  foreach ($w in [FW2]::All) { Write-Output ('WIN ' + $w) }
  Write-Output ('FG ' + [FW2]::TitleOf([FW2]::Fg()) + ' hwnd=' + [FW2]::Fg())
} elseif ($mode -eq 'focus') {
  Write-Output ([FW2]::Focus())
  Write-Output ('FGTITLE ' + [FW2]::TitleOf([FW2]::Fg()))
} elseif ($mode -eq 'rect') {
  if ([FW2]::Hit -eq [IntPtr]::Zero) { Write-Output 'NOTFOUND' }
  else {
    $line = 'HIT ' + [FW2]::HitTitle + ' hwnd=' + [FW2]::Hit + ' iconic=' + [FW2]::IsIconic([FW2]::Hit) + ' fg=' + ([FW2]::Fg() -eq [FW2]::Hit)
    Write-Output $line
  }
} elseif ($mode -eq 'fg') {
  Write-Output ('FG ' + [FW2]::TitleOf([FW2]::Fg()) + ' hwnd=' + [FW2]::Fg())
} elseif ($mode -eq 'cursor') {
  Write-Output ('CURSOR ' + [FW2]::Cursor())
}
`;

function buildScript(want, mode) {
  return PS.replace('__WANT__', String(want == null ? '' : want).replace(/'/g, "''"))
           .replace('__MODE__', String(mode || 'list'));
}

function runPs(want, mode, timeoutMs) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', buildScript(want, mode)],
      { timeout: timeoutMs || 30000, windowsHide: true },
      (e, so) => resolve({ out: String(so || ''), err: e ? String(e.message || e) : '' }));
  });
}

/* ★ 从一组同名窗口里挑出"真的显示在屏幕上"的那一个 ★
   实测（2026-10-03）：Windows 计算器（UWP）同时存在两个标题都是「计算器」、位置尺寸都一样的顶层窗：
     hwnd=1312000  visible=否  ← 隐藏的那个
     hwnd=461342   visible=是  ← 真正在屏幕上的那个
   而旧的 focusWindow 靠 PS 里"第一个标题匹配"来挑，随手拿到了隐藏的那个 ✗，
   于是她 focus 之后截图里看不到计算器（她自己的气泡就说："Calculator window is frontmost
   but the s..."）。visible / cloaked / iconic 这三个标志是准的，问题是**没人看它们**。
   优先级：真显示的 → 非最小化的 → 有真实矩形的 → 第一个。 */
function pickShown(cands) {
  const list = (cands || []).slice();
  if (!list.length) return { win: null, shown: 0, total: 0, note: 'no-candidates' };
  const byArea = (a, b) => b.w * b.h - a.w * a.h;
  /* ★★★ 分级挑选 —— 关键是【绝不挑 visible=否 的僵尸】★★★
     2026-10-03 实测事故（用户报"她托不出计算器，我也打不开，有两个计算器在跑"）：
       UWP 应用被反复开关会攒出**多个实例** ✗，共享同一个 ApplicationFrameHost，
       老实例变成僵尸：visible=否 / cloaked=是 / 停在 -32000,-32000 ✗。
       当时的兜底是"取 list[0]"，恰好挑中那个 visible=否 的僵尸 ✗ →
       focus_window 反复对它操作 → 一直"显示了但抢不到前台" → 她以为窗口弄不出来 → 放弃。
     ★分水岭就是 visible：僵尸是 visible=否，活着的窗口是 visible=是 ★
     所以按这个顺序挑，任何一级命中就返回，绝不再无条件退到 list[0]。 */
  const levels = [
    { note: 'shown', f: (w) => w.visible !== false && !w.cloaked && !w.iconic },
    { note: 'visible-not-cloaked', f: (w) => w.visible !== false && !w.cloaked },
    { note: 'visible', f: (w) => w.visible !== false },
    { note: 'has-real-rect', f: (w) => !w.cloaked && !w.iconic && w.w > 1 && w.h > 1 },
    { note: 'last-resort', f: () => true },
  ];
  for (const lv of levels) {
    const hit = list.filter(lv.f);
    if (hit.length) {
      return { win: hit.slice().sort(byArea)[0], shown: list.filter(levels[0].f).length, total: list.length, note: lv.note };
    }
  }
  return { win: null, shown: 0, total: list.length, note: 'nothing' };
}

/* 列窗口。坐标已是物理像素（PS 声明了 DPI 感知）；同时把 DPI 报出来便于核对。 */
async function listWindows() {
  const { out, err } = await runPs('', 'list');
  const rows = [];
  let dpi = 0, dpiOk = null;
  for (const line of out.split(/\r?\n/)) {
    let m = line.match(/^DPI=(\d+)\s+dpiCtxOk=(\w+)/);
    if (m) { dpi = Number(m[1]); dpiOk = m[2] === 'True'; continue; }
    m = line.match(/^WIN (.*?)\s*\[(-?\d+),(-?\d+)\s+(\d+)x(\d+)\]\s*hwnd=(\d+)\s*pid=(\d+)\s*iconic=(\w+)\s*visible=(\w+)\s*topmost=(\w+)\s*cloaked=(\w+)\s*z=(\d+)/);
    if (m) {
      rows.push({
        title: m[1].trim(), x: +m[2], y: +m[3], w: +m[4], h: +m[5],
        hwnd: Number(m[6]), pid: Number(m[7]), iconic: m[8] === 'True', visible: m[9] === 'True',
        topmost: m[10] === 'True', cloaked: m[11] === 'True', z: Number(m[12]),
      });
    }
  }
  /* 顺便把前台标题也带回来：调用方常需要"同名窗口里哪个才是当前那个" */
  let foregroundTitle = '', foregroundHwnd = 0;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^FG (.*?) hwnd=(-?\d+)/);
    if (m) { foregroundTitle = m[1]; foregroundHwnd = Number(m[2]); break; }
  }
  /* ★★★ 失败必须响亮，绝不能默默返回"0 个窗口" ★★★
     实测事故（2026-10-03）：我给这段 PS 的 C# 加 cloaked 检测时写错了三处
     （UIntPtr 应为 IntPtr、Thread 少了 System.Threading.、注释里放了反引号截断了模板串），
     每一次都让 Add-Type 编译失败 —— 而这里只取了 out、**把 err 丢掉了** ✗，
     于是 listWindows 返回 { windows: [] }，看起来就像"屏幕上没有窗口"。
     我追着这个假象排查了两轮，还差点以为系统坏了。
     现在：有 err 就显式报出来；此外"既没有 DPI 行也没有任何 WIN 行"也判为异常
     （正常的 Windows 上至少会有桌面窗口 Program Manager）。 */
  const ok = !err && (dpi > 0 || rows.length > 0);
  const result = {
    windows: rows, dpi, scale: dpi ? Math.round((dpi / 96) * 100) / 100 : null,
    dpiContextOk: dpiOk, foregroundTitle, foregroundHwnd, ok,
  };
  if (!ok) {
    result.error = err || 'PowerShell 返回了空结果（既没有 DPI 行也没有任何 WIN 行）—— '
      + '通常是 PS 侧的 C# 编译失败或被安全软件拦了，请检查 focuswin 里那段 PS 脚本。';
    result.rawOut = String(out).slice(0, 400);
  }
  /* ★ 必须带 hwnd ★：实测 Edge 为同一页面暴露多个顶层窗口，**标题逐字相同**，
     只靠标题根本分不出哪个是当前可见的那个 —— 只有前台 HWND 是唯一的。 */
  return result;
}

/* 当前前台窗口 */
async function foreground() {
  const { out } = await runPs('', 'fg');
  const m = out.match(/^FG (.*?)\s*hwnd=(-?\d+)/);
  return m ? { title: m[1], hwnd: Number(m[2]) } : { title: out.trim(), hwnd: 0 };
}

/* 真·置前台：返回字符串（兼容旧调用方），以 OK/FAIL/NOTFOUND 开头。
 * ★ 只有在【回读确认前台就是目标】时才返回 OK。 */
async function focusWindow(title) {
  const want = String(title || '').trim();
  if (!want) return '（没给窗口名）';
  const { out } = await runPs(want, 'focus');
  const first = out.split(/\r?\n/)[0] || '';
  const fg = (out.match(/^FGTITLE (.*)$/m) || [])[1] || '';
  /* ★ step-showonly：窗口显示了但抢不到前台 —— 不能再说"前台已回读确认" ✗ ★
     那是假成功：她读到的会是"已置前台 ✓"，于是接着用 type 打字 ✗，
     而键盘只发给前台窗口 ✗ → 字打到别处 ✗ → 她以为窗口坏了 ✓。 */
  if (/step-showonly/.test(first)) {
    const tip = (first.split('||')[1] || '').trim();
    return '🪟 ' + (tip || '窗口已经显示出来了，但抢不到前台（UWP 应用常见）。改用 click 直接点它，别用键盘。')
      + '\n（回读到的前台是：「' + fg + '」）';
  }
  if (first.startsWith('OK')) return first + '  [前台已回读确认]';
  if (first === 'NOTFOUND') {
    const { windows } = await listWindows();
    return 'NOTFOUND（没有标题包含「' + want + '」的可见窗口）\n可见窗口：\n' +
      windows.map((w) => '  · ' + w.title + '  [' + w.x + ',' + w.y + ' ' + w.w + 'x' + w.h + ']').join('\n');
  }
  return first + '\n（回读到的前台是：「' + fg + '」）';
}

/* 结构化版：给需要判断成败的调用方 */
async function focusWindowEx(title) {
  const want = String(title || '').trim();
  if (!want) return { ok: false, reason: 'no-title' };
  const { out } = await runPs(want, 'focus');
  const first = out.split(/\r?\n/)[0] || '';
  const fgTitle = (out.match(/^FGTITLE (.*)$/m) || [])[1] || '';
  /* ★ step-showonly = "窗口显示了，但抢不到前台"（UWP 常见）★
     这算**部分成功**：窗口已经可见，她可以接着用 click 点它（不需要它当前台）。
     把 PS 附的那句指引也带出去，让 assistant.js 能原样转达。 */
  const shownOnly = /step-showonly/.test(first);
  const tip = (first.split('||')[1] || '').trim();
  return {
    ok: first.startsWith('OK'), raw: first, shownOnly, tip,
    step: first.replace(/^OK /, '').split(' ')[0], foreground: fgTitle,
  };
}

/* 光标真值（物理像素，PS 已声明 DPI 感知）—— 动作的效果断言要用它回读 */
async function cursorPos() {
  const { out } = await runPs('', 'cursor');
  const m = out.match(/^CURSOR\s+(-?\d+)\s*,\s*(-?\d+)/m);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

/* 查某个标题的窗口矩形 + 是不是前台（不做任何修改） */
async function windowRect(title) {
  const want = String(title || '').trim();
  if (!want) return null;
  const { out } = await runPs(want, 'rect');
  const m = out.match(/^HIT (.*?)\s*hwnd=(\d+)\s*iconic=(\w+)\s*fg=(\w+)/);
  if (!m) return null;
  const { windows } = await listWindows();
  const w = windows.find((x) => x.hwnd === Number(m[2]));
  return w ? Object.assign({}, w, { isForeground: m[4] === 'True' }) : { title: m[1], hwnd: Number(m[2]), isForeground: m[4] === 'True' };
}

/* 把所有【别的进程】的窗口取消置顶 —— 启动时清一次，救"某个窗口被卡成永久置顶"的情况
 * （用户报过"我的游戏一直顶窗口，导致我很难和桌宠对话"）。
 *
 * ⚠️⚠️ 必须排除**自己的 pid**：用户报过"我一切到别的界面，桌宠就不见了、退到后台了"——
 *   根因就是这里把桌宠自己的 WS_EX_TOPMOST 也抹掉了，而 Electron 并不知道这个位被 Win32 抹过，
 *   不会重新置顶。所以自带 pid 的窗口一律跳过。
 *
 * ⚠️ 2026-10-02 重写时我一度把这个函数改成空操作（以为"置前台"取代了它）—— 那是错的：
 *   两者是不同的事。**置前台 = 让输入到达目标；取消置顶 = 收拾视觉上永久压着别人的窗口。**
 *   现在用新的 DPI 感知枚举重新实现，语义和旧版一致。
 */
const PS_CLEARTOP = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class FW3 {
  public delegate bool EP(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EP cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr ctx);
  public static IntPtr NOTOP = new IntPtr(-2);
  public static uint NOMOVE = 0x2, NOSIZE = 0x1;
  public static List<string> Done = new List<string>();
  public static void Run(uint ownPid) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    EnumWindows((h, p) => {
      var sb = new StringBuilder(300); GetWindowTextW(h, sb, 300);
      string t = sb.ToString();
      if (t.Length > 0 && IsWindowVisible(h)) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (ownPid != 0 && pid == ownPid) return true;   /* 自己的窗口不碰 */
        SetWindowPos(h, NOTOP, 0, 0, 0, 0, NOMOVE | NOSIZE);
        Done.Add(t);
      }
      return true;
    }, IntPtr.Zero);
  }
}
'@
[FW3]::Run(__OWNPID__)
Write-Output ('UNTOP ' + [FW3]::Done.Count + ' windows')
`;

async function clearAllTop() {
  const script = PS_CLEARTOP.replace('__OWNPID__', String(process.pid));
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 30000, windowsHide: true },
      (e, so) => resolve(String(so || '').trim() || (e ? 'ERR ' + e.message : 'done')));
  });
}

module.exports = { listWindows, foreground, focusWindow, focusWindowEx, windowRect, clearAllTop, cursorPos, pickShown };

/* ============================ CLI（方便外部直接驱动）============================ */
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = rest.join(' ');
  (async () => {
    if (cmd === 'list') {
      const r = await listWindows();
      console.log('DPI=' + r.dpi + '  scale=' + r.scale + '  dpiContextOk=' + r.dpiContextOk);
      for (const w of r.windows) console.log('  ' + (w.iconic ? '[最小化]' : '        ') + ' ' + w.x + ',' + w.y + ' ' + w.w + 'x' + w.h + '  ' + w.title);
      const fg = await foreground();
      console.log('前台: ' + fg.title);
    } else if (cmd === 'fg') {
      console.log(JSON.stringify(await foreground()));
    } else if (cmd === 'focus') {
      console.log(await focusWindow(arg));
    } else if (cmd === 'rect') {
      console.log(JSON.stringify(await windowRect(arg)));
    } else {
      console.log('用法: node focuswin.js list | fg | focus "<标题片段>" | rect "<标题片段>"');
    }
    process.exit(0);
  })();
}
