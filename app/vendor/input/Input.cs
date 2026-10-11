// OS 级键鼠输入（Windows）
// 编译：C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /out:input.exe Input.cs
// ★D1 常驻模式★：input.exe serve
//   stdin 逐行读 "<action> <arg...>"，执行完回一行 "OK" 或 "ERR <msg>"；type 的文本用 base64 传 ✓.cs
// 用法（坐标一律是归一化 0..1，相对主屏）：
//   input.exe move    fx fy
//   input.exe click   fx fy
//   input.exe rclick  fx fy
//   input.exe dclick  fx fy
//   input.exe drag    fx1 fy1 fx2 fy2
//   input.exe fdrag   fx1 fy1 fx2 fy2 [steps] [delayms]   （高速拖拽，默认 200 步 / 1ms）
//   input.exe fcircle cx cy r [steps] [delayms]           （高速画圆拖拽，默认 180 步 / 1ms）
//   input.exe press                 （按下左键不放）
//   input.exe release               （松开左键）
//   input.exe scroll  fx fy delta
//   input.exe type    <文本>
//   input.exe key     <按键名或组合，如 enter / esc / f5 / ctrl+c>
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

class Program
{
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, int data, int extra);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inps, int size);

    const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004,
        RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040,
        WHEEL = 0x0800, ABS = 0x8000;
    const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public U u; }

    static uint Norm(double v) { return (uint)Math.Round(Math.Max(0, Math.Min(1, v)) * 65535); }
    static void Move(double x, double y) { mouse_event(MOVE | ABS, Norm(x), Norm(y), 0, 0); }
    static void Sleep(int ms) { System.Threading.Thread.Sleep(ms); }

    /* ---------- 点之前先激活光标下的窗口 ----------
     * 为什么必需：Windows 对**非活动窗口**的第一次点击只用它来激活窗口，
     * **不会把点击传给控件** —— 用户感受就是"点了没反应，得再点一次"。
     * 桌宠窗是 alwaysOnTop，它一盖到目标上，目标窗口就失活了；等她让开后再点，
     * 那一次点击又只用来激活，于是"她点不了开始游戏的按钮"（实测复现过）。
     * 这里先自己把光标下的顶层窗口激活，真正的点击就不会被吞掉。
     *
     * 坐标怎么拿：先把光标移到目标点，再 GetCursorPos 读回**系统真实像素坐标**，
     * 这样完全绕开 DPI 缩放换算（本进程不是 DPI-aware，自己换算容易差一截）。 */
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x; public int y; }

    static void ActivateUnderCursor()
    {
        try
        {
            POINT p;
            if (!GetCursorPos(out p)) return;
            IntPtr h = WindowFromPoint(p);
            if (h == IntPtr.Zero) return;
            IntPtr root = GetAncestor(h, 2 /* GA_ROOT */);
            if (root == IntPtr.Zero) root = h;
            if (root == GetForegroundWindow()) return;      // 已经是前台，别多此一举
            SetForegroundWindow(root);
            Sleep(120);                                     // 给窗口一点时间真正拿到前台
        }
        catch { }
    }

    /* ---------- 点之前先检查：目标窗口是不是"管理员权限"的 ----------
     * 【用户报的"她点不了开始游戏的按钮"的真正根因】
     * 鹰角启动器（进程名 Games）**以管理员身份运行**，而桌宠是普通权限。
     * Windows 的 UIPI（用户界面特权隔离）会**拦掉普通进程发给高完整性窗口的模拟输入** ——
     * 于是我们发的点击"成功返回"、光标也确实压在按钮上，但**那个窗口根本收不到**，
     * 表现得就像"这个按钮不响应自动点击"（真实鼠标点击不受影响，所以手动点就能进）。
     *
     * 怎么判断：以 PROCESS_QUERY_INFORMATION(0x400) 打开对方进程，
     * 如果失败且错误号是 5（ACCESS_DENIED），就是对方级别更高。
     * 实测：Games → err=5（打不开）；explorer / msedge / powershell → 都能打开。
     * ⚠️ 别用 PROCESS_QUERY_LIMITED_INFORMATION(0x1000)：那个**对高完整性进程是放行的**
     * （我第一次就写错了，结果检查永远返回"没问题"），0x400 才是被 UIPI 拦的那个。
     *
     * 为什么不"照样点一下"：反正送不到，还会让模型以为点了、接着反复重试
     * （她之前就是这样点了十几次）。**直接报清楚原因，让人去处理权限**才对。 */
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    static string BlockedByElevation()
    {
        try
        {
            POINT p;
            if (!GetCursorPos(out p)) return null;
            IntPtr h = WindowFromPoint(p);
            if (h == IntPtr.Zero) return null;
            IntPtr root = GetAncestor(h, 2 /* GA_ROOT */);
            if (root == IntPtr.Zero) root = h;
            uint pid;
            GetWindowThreadProcessId(root, out pid);
            if (pid == 0) return null;
            IntPtr ph = OpenProcess(0x0400 /* PROCESS_QUERY_INFORMATION */, false, pid);
            if (ph == IntPtr.Zero)
            {
                int err = Marshal.GetLastWin32Error();
                if (err == 5)
                    return "目标窗口（进程 pid=" + pid + "）以**管理员身份**运行，"
                         + "Windows 会拦截普通程序发出的模拟点击（UIPI 安全边界），所以点了它收不到。"
                         + "解决办法二选一：① 用管理员身份重新启动桌宠；"
                         + "② 把那个程序改成普通权限启动（右键属性→兼容性→取消“以管理员身份运行”）。";
                return null;
            }
            CloseHandle(ph);
            return null;
        }
        catch { return null; }
    }

    /* 移动 + 激活 + 点击，合成一个动作（click/rclick/dclick/drag 都用它） */
    static void ClickAt(double x, double y, uint down, uint up, int gapMs)
    {
        Move(x, y);
        Sleep(60);
        string blocked = BlockedByElevation();
        if (blocked != null) throw new Exception(blocked);
        ActivateUnderCursor();
        mouse_event(down, 0, 0, 0, 0);
        Sleep(gapMs);
        mouse_event(up, 0, 0, 0, 0);
    }

    static void Keybd(ushort vk, uint flags)
    {
        var i = new INPUT[1]; i[0].type = 1; i[0].u.ki.wVk = vk; i[0].u.ki.dwFlags = flags;
        SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
    }
    static void Uni(char c)
    {
        var i = new INPUT[2];
        i[0].type = 1; i[0].u.ki.wScan = (ushort)c; i[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
        i[1].type = 1; i[1].u.ki.wScan = (ushort)c; i[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        SendInput(2, i, Marshal.SizeOf(typeof(INPUT)));
    }
    static void Press(ushort vk) { Keybd(vk, 0); Sleep(35); Keybd(vk, KEYEVENTF_KEYUP); }

    static ushort Vk(string n)
    {
        switch (n.ToLower())
        {
            case "enter": return 0x0D;
            case "esc": case "escape": return 0x1B;
            case "tab": return 0x09;
            case "space": return 0x20;
            case "backspace": return 0x08;
            case "delete": case "del": return 0x2E;
            case "insert": case "ins": return 0x2D;
            case "up": return 0x26;
            case "down": return 0x28;
            case "left": return 0x25;
            case "right": return 0x27;
            case "home": return 0x24;
            case "end": return 0x23;
            case "pageup": return 0x21;
            case "pagedown": return 0x22;
            case "ctrl": case "control": return 0x11;
            case "alt": return 0x12;
            case "shift": return 0x10;
            case "win": return 0x5B;
            /* 符号键名（模型会写 key|ctrl+plus 这种）。
               注意 "+" 本身在 VK 层面就是 shift+"="，所以 plus 由 Node 侧翻成 shift+equal，
               这里只管把名字映射到 VK。 */
            case "equal": return 0xBB;
            case "minus": return 0xBD;
            case "comma": return 0xBC;
            case "period": case "dot": return 0xBE;
            case "slash": return 0xBF;
            case "backslash": return 0xDC;
            case "semicolon": return 0xBA;
            case "quote": case "apostrophe": return 0xDE;
            case "backtick": case "grave": return 0xC0;
            case "bracketleft": case "lbracket": return 0xDB;
            case "bracketright": case "rbracket": return 0xDD;
            case "add": case "numpadplus": return 0x6B;
            case "subtract": case "numpadminus": return 0x6D;
            default:
                if (n.Length == 1)
                {
                    char c = char.ToUpper(n[0]);
                    if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return (ushort)c;
                    /* ⚠️ 符号不能拿 ASCII 当 VK：',' 是 44，而它的 VK 是 0xBC(188)。
                       以前一律 `return (ushort)char.ToUpper(n[0])` —— 对字母数字成立，
                       对符号就是发了个不存在的键，**静默无效**（用户/模型都看不出原因）。
                       实测模型会写 key|+ 想按加号。 */
                    switch (n[0])
                    {
                        case '=': case '+': return 0xBB;
                        case '-': case '_': return 0xBD;
                        case ',': case '<': return 0xBC;
                        case '.': case '>': return 0xBE;
                        case '/': case '?': return 0xBF;
                        case '\\': case '|': return 0xDC;
                        case ';': case ':': return 0xBA;
                        case '\'': case '"': return 0xDE;
                        case '`': case '~': return 0xC0;
                        case '[': case '{': return 0xDB;
                        case ']': case '}': return 0xDD;
                    }
                    return (ushort)c;
                }
                int f;
                if (n.Length >= 2 && n[0] == 'f' && int.TryParse(n.Substring(1), out f) && f >= 1 && f <= 24) return (ushort)(0x6F + f);
                throw new Exception("unknown key: " + n);
        }
    }

    static int Main(string[] args)
    {
        if (args.Length == 0) { Console.Error.WriteLine("no args"); return 1; }
        /* ★ serve = 常驻模式（D1）★
           为什么加：原来每次动作都要重新启动一次本程序 —— 实测 ★49ms/次★ ✗。
           打游戏/连续操作时这个开销直接决定了能不能用（要 5~10ms 才够）。
           常驻之后省掉进程启动，动作本身只剩 API 调用 + 少量 Sleep ✓
           ⚠️ 一次性调用这条路**保留** ✓ —— 万一常驻版出问题，input.js 能立刻切回来。 */
        if (args[0].ToLower() == "serve") return Serve();
        try { Exec(args); return 0; }
        catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }

    /* ★ 常驻服务：从 stdin 逐行读命令，执行完回一行 OK / ERR <msg> ★
       协议故意做成"一行一条 + 一行结果"，不用二进制 —— 好调试、好抓错 ✓
       ★type 的文本走 base64★：协议按空格切，带空格/换行/中文的文本会被切碎 ✓
       ★stdin/stdout 都设 UTF-8★：控制台默认 GBK，中文会乱码（今天在别处踩过多次）✓ */
    static int Serve()
    {
        try
        {
            Console.InputEncoding = System.Text.Encoding.UTF8;
            Console.OutputEncoding = System.Text.Encoding.UTF8;
        }
        catch (Exception) { }
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            if (line == "quit") break;
            /* ★ 默认按空格全切开 ★
               ⚠️ 第一版这里写的是 Split(new char[]{' '}, 2)（限制 2 段）✗ ——
               于是 move 0.5 0.5 变成 ["move", "0.5 0.5"]，args[2] 不存在 → double.Parse 报
               "输入字符串的格式不正确" ✓（实测编译后第一次跑就抓到了）。
               限制 2 段**只有 type 需要**（它的文本可能含空格）✓ */
            string[] parts = line.Split(' ');
            if (parts.Length >= 2 && parts[0].ToLower() == "type")
            {
                int sp = line.IndexOf(' ');
                string rest = (sp >= 0) ? line.Substring(sp + 1).Trim() : "";
                try
                {
                    rest = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(rest));
                }
                catch (Exception) { /* 不是合法 base64 就按原文用 */ }
                parts = new string[] { parts[0], rest };
            }
            try
            {
                Exec(parts);
                Console.WriteLine("OK");
            }
            catch (Exception e)
            {
                string msg = (e.Message == null) ? "error" : e.Message.Replace("\r", " ").Replace("\n", " ");
                Console.WriteLine("ERR " + msg);
            }
            Console.Out.Flush();
        }
        return 0;
    }

    /* 一次执行一条命令（serve 模式和一次性调用都走这里）*/
    static void Exec(string[] args)
    {
            string a = args[0].ToLower();
            double x, y, x2, y2; int delta;
            switch (a)
            {
                case "move":
                    Move(double.Parse(args[1]), double.Parse(args[2])); break;
                case "click":
                    /* 走 ClickAt：移动 → **先激活光标下的窗口** → 再点。
                       不先激活的话，点在失活窗口上的第一次会被系统吞掉
                       （只用来激活窗口），用户就会觉得"点了没反应" ——
                       这正是"她点不了开始游戏的按钮"的第二个原因。 */
                    ClickAt(double.Parse(args[1]), double.Parse(args[2]), LEFTDOWN, LEFTUP, 45); break;
                case "rclick":
                    ClickAt(double.Parse(args[1]), double.Parse(args[2]), RIGHTDOWN, RIGHTUP, 45); break;
                case "dclick":
                    x = double.Parse(args[1]); y = double.Parse(args[2]);
                    Move(x, y); Sleep(60); ActivateUnderCursor();
                    mouse_event(LEFTDOWN, 0, 0, 0, 0); mouse_event(LEFTUP, 0, 0, 0, 0);
                    Sleep(60);
                    mouse_event(LEFTDOWN, 0, 0, 0, 0); mouse_event(LEFTUP, 0, 0, 0, 0); break;
                case "drag":
                    x = double.Parse(args[1]); y = double.Parse(args[2]);
                    x2 = double.Parse(args[3]); y2 = double.Parse(args[4]);
                    /* 拖拽起点也要先激活：从失活窗口上起拖同样会被吞掉（拖不动窗口/元素）。 */
                    Move(x, y); Sleep(50); ActivateUnderCursor();
                    mouse_event(LEFTDOWN, 0, 0, 0, 0); Sleep(50);
                    for (int i = 1; i <= 24; i++) { Move(x + (x2 - x) * i / 24, y + (y2 - y) * i / 24); Sleep(10); }
                    mouse_event(LEFTUP, 0, 0, 0, 0); break;
                case "press":
                    mouse_event(LEFTDOWN, 0, 0, 0, 0); break;
                case "release":
                    mouse_event(LEFTUP, 0, 0, 0, 0); break;
                case "fdrag":
                    x = double.Parse(args[1]); y = double.Parse(args[2]);
                    x2 = double.Parse(args[3]); y2 = double.Parse(args[4]);
                    int fsteps = args.Length > 5 ? int.Parse(args[5]) : 200;
                    int fdelay = args.Length > 6 ? int.Parse(args[6]) : 1;
                    Move(x, y); Sleep(30); mouse_event(LEFTDOWN, 0, 0, 0, 0); Sleep(20);
                    for (int i = 1; i <= fsteps; i++) { Move(x + (x2 - x) * i / fsteps, y + (y2 - y) * i / fsteps); if (fdelay > 0) Sleep(fdelay); }
                    mouse_event(LEFTUP, 0, 0, 0, 0); break;
                case "fcircle":
                    {
                        double ccx = double.Parse(args[1]), ccy = double.Parse(args[2]), rr = double.Parse(args[3]);
                        int csteps = args.Length > 4 ? int.Parse(args[4]) : 180;
                        int cdelay = args.Length > 5 ? int.Parse(args[5]) : 1;
                        Move(ccx + rr, ccy); Sleep(30); mouse_event(LEFTDOWN, 0, 0, 0, 0); Sleep(20);
                        for (int i = 1; i <= csteps; i++)
                        {
                            double ang = 2 * Math.PI * i / csteps;
                            Move(ccx + rr * Math.Cos(ang), ccy + rr * Math.Sin(ang));
                            if (cdelay > 0) Sleep(cdelay);
                        }
                        mouse_event(LEFTUP, 0, 0, 0, 0); break;
                    }
                case "scroll":
                    Move(double.Parse(args[1]), double.Parse(args[2]));
                    delta = int.Parse(args[3]);
                    mouse_event(WHEEL, 0, 0, delta, 0); break;
                case "type":
                    foreach (char c in args[1]) Uni(c); break;
                case "key":
                    {
                        /* ⚠️ 这个顺序是**安全缺陷修出来的**：必须**先把所有键名解析完**再动键盘。
                         * 旧写法是一边解析修饰键一边按下、最后才解析主键 —— 只要主键名不认识
                         * （`key ctrl+` 这种尾部加号、`key ctrl+cmd` 把 win 写错、模型偶尔会犯），
                         * Vk() 抛异常就直接跳出函数，**已经按下的 Ctrl 再也没人松开**。
                         * 表现：用户整个键盘变成"每个键都是 Ctrl+快捷键"，输入不了东西，只能重启。
                         * 现在任何键名问题都在**动手之前**抛出，一个键都不会按下去。
                         * 另外 try/finally 保证正常路径下修饰键一定被松开。 */
                        var parts = new List<string>(args[1].ToLower().Split('+'));
                        var mods = new List<ushort>();
                        for (int i = 0; i < parts.Count - 1; i++)
                        {
                            var nm = parts[i].Trim();
                            if (nm == "") throw new Exception("按键名写错了（多了个 + ？）: " + args[1]);
                            mods.Add(Vk(nm));
                        }
                        var last = parts[parts.Count - 1].Trim();
                        if (last == "") throw new Exception("按键名写错了（结尾多了个 + ？）: " + args[1]);
                        ushort mainKey = Vk(last);          // ← 全部解析成功之后才开始按
                        foreach (var m in mods) Keybd(m, 0);
                        try { Press(mainKey); }
                        finally { foreach (var m in mods) Keybd(m, KEYEVENTF_KEYUP); }
                        break;
                    }
                case "releaseall":
                    {
                        /* 兜底：把所有可能卡住的键统统松开。
                         * 什么时候用：应用启动时（救上一次崩溃/被杀留下的卡键）、
                         * 游戏助手收手时、退出之前。
                         * 为什么包含 0xA0~0xA5：Shift/Ctrl/Alt 除了通用码（0x10/0x11/0x12）
                         * 还有左右各自的码，卡住时可能只反映在其中一边，全都发一遍最稳。
                         * Win 键（0x5B/0x5C）同理 —— 它卡住会把所有快捷键吃掉。 */
                        ushort[] stuck = { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
                        foreach (var v in stuck) Keybd(v, KEYEVENTF_KEYUP);
                        mouse_event(LEFTUP, 0, 0, 0, 0);
                        mouse_event(RIGHTUP, 0, 0, 0, 0);
                        mouse_event(MIDDLEUP, 0, 0, 0, 0);
                        break;
                    }
                default:
                    throw new Exception("unknown action: " + a);
            }
    }
}
