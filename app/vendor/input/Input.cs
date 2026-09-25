// OS 级键鼠输入（Windows）
// 编译：C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /out:input.exe Input.cs
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
            default:
                if (n.Length == 1) return (ushort)char.ToUpper(n[0]);
                int f;
                if (n.Length >= 2 && n[0] == 'f' && int.TryParse(n.Substring(1), out f) && f >= 1 && f <= 24) return (ushort)(0x6F + f);
                throw new Exception("unknown key: " + n);
        }
    }

    static int Main(string[] args)
    {
        if (args.Length == 0) { Console.Error.WriteLine("no args"); return 1; }
        try
        {
            string a = args[0].ToLower();
            double x, y, x2, y2; int delta;
            switch (a)
            {
                case "move":
                    Move(double.Parse(args[1]), double.Parse(args[2])); break;
                case "click":
                    Move(double.Parse(args[1]), double.Parse(args[2]));
                    mouse_event(LEFTDOWN, 0, 0, 0, 0); Sleep(45); mouse_event(LEFTUP, 0, 0, 0, 0); break;
                case "rclick":
                    Move(double.Parse(args[1]), double.Parse(args[2]));
                    mouse_event(RIGHTDOWN, 0, 0, 0, 0); Sleep(45); mouse_event(RIGHTUP, 0, 0, 0, 0); break;
                case "dclick":
                    x = double.Parse(args[1]); y = double.Parse(args[2]);
                    Move(x, y); mouse_event(LEFTDOWN, 0, 0, 0, 0); mouse_event(LEFTUP, 0, 0, 0, 0);
                    Sleep(60);
                    mouse_event(LEFTDOWN, 0, 0, 0, 0); mouse_event(LEFTUP, 0, 0, 0, 0); break;
                case "drag":
                    x = double.Parse(args[1]); y = double.Parse(args[2]);
                    x2 = double.Parse(args[3]); y2 = double.Parse(args[4]);
                    Move(x, y); Sleep(50); mouse_event(LEFTDOWN, 0, 0, 0, 0); Sleep(50);
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
                        var parts = new List<string>(args[1].ToLower().Split('+'));
                        var mods = new List<ushort>();
                        for (int i = 0; i < parts.Count - 1; i++) mods.Add(Vk(parts[i].Trim()));
                        foreach (var m in mods) Keybd(m, 0);
                        Press(Vk(parts[parts.Count - 1].Trim()));
                        foreach (var m in mods) Keybd(m, KEYEVENTF_KEYUP);
                        break;
                    }
                default:
                    throw new Exception("unknown action: " + a);
            }
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }
}
