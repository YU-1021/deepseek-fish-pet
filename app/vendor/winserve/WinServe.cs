// WinServe.cs -- persistent native helper: windows / cursor / UIA (serve mode)
// Build: app\scripts\build-winserve.ps1  (csc, .NET Framework 4 + UIAutomation references)
// Protocol: stdin lines -> stdout one JSON line per command.
//   list                              -> {ok,dpi,dpiOk,windows:[...],fg:{title,hwnd}}
//   cursor                            -> {ok,x,y}
//   uia <hwnd>|<b64 title>|<b64 needle> -> {ok,window:{x,y,w,h,title},count,elements:[...]} | {ok:false,notFound:true}
//   ping                              -> {ok}
//   quit                              -> {ok} then exit
// NOTE: keep this file ASCII-only.
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
using System.Windows.Automation;

class WinServe
{
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern uint GetDpiForSystem();
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    static bool dpiOk = false;

    static string TitleOf(IntPtr h)
    {
        var sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        return sb.ToString();
    }
    static bool Cloaked(IntPtr h)
    {
        int v = 0;
        try { DwmGetWindowAttribute(h, 14, out v, 4); } catch { }
        return v != 0;
    }
    static string Esc(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default: if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4")); else sb.Append(c); break;
            }
        }
        return sb.ToString();
    }
    static string B64Dec(string s)
    {
        try { return Encoding.UTF8.GetString(Convert.FromBase64String(s)); } catch { return ""; }
    }

    static List<string> rows;
    static int z;

    static string CmdList()
    {
        rows = new List<string>();
        z = 0;
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            string t = TitleOf(h);
            if (t.Length > 0)
            {
                RECT r; GetWindowRect(h, out r);
                uint pid; GetWindowThreadProcessId(h, out pid);
                int w = r.R - r.L, hh = r.B - r.T;
                bool topmost = (GetWindowLong(h, -20) & 0x8) != 0;
                rows.Add("{\"title\":\"" + Esc(t) + "\",\"x\":" + r.L + ",\"y\":" + r.T + ",\"w\":" + w + ",\"h\":" + hh
                    + ",\"hwnd\":" + h.ToInt64() + ",\"pid\":" + pid
                    + ",\"iconic\":" + (IsIconic(h) ? "true" : "false")
                    + ",\"visible\":" + (IsWindowVisible(h) ? "true" : "false")
                    + ",\"topmost\":" + (topmost ? "true" : "false")
                    + ",\"cloaked\":" + (Cloaked(h) ? "true" : "false")
                    + ",\"z\":" + (z++) + "}");
            }
            return true;
        }, IntPtr.Zero);

        IntPtr fg = GetForegroundWindow();
        string fgTitle = fg == IntPtr.Zero ? "" : TitleOf(fg);
        var sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"dpi\":").Append(GetDpiForSystem())
          .Append(",\"dpiOk\":").Append(dpiOk ? "true" : "false")
          .Append(",\"windows\":[").Append(string.Join(",", rows.ToArray())).Append("]")
          .Append(",\"fg\":{\"title\":\"").Append(Esc(fgTitle)).Append("\",\"hwnd\":").Append(fg.ToInt64()).Append("}}");
        return sb.ToString();
    }

    static string CmdCursor()
    {
        POINT p; GetCursorPos(out p);
        return "{\"ok\":true,\"x\":" + p.X + ",\"y\":" + p.Y + "}";
    }

    /* uia <hwnd>|<b64 title>|<b64 needle>
       hwnd != 0 -> AutomationElement.FromHandle (exact window)
       hwnd == 0 -> find top-level element whose Name contains title
       needle != "" -> find mode (only matching elements, count = matched)
       needle == "" -> list mode (up to 80 elements, count = total processed) */
    static string CmdUia(string rest)
    {
        string[] parts = rest.Split('|');
        long hwndVal = 0;
        if (parts.Length > 0) long.TryParse(parts[0], out hwndVal);
        string title = parts.Length > 1 ? B64Dec(parts[1]) : "";
        string needle = parts.Length > 2 ? B64Dec(parts[2]) : "";

        AutomationElement found = null;
        try
        {
            if (hwndVal != 0) found = AutomationElement.FromHandle(new IntPtr(hwndVal));
            else if (title.Length > 0)
            {
                var all = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
                foreach (AutomationElement w in all)
                {
                    string n = "";
                    try { n = w.Current.Name ?? ""; } catch { }
                    if (n.Length > 0 && n.IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) { found = w; break; }
                }
            }
        }
        catch (Exception e) { return "{\"ok\":false,\"error\":\"" + Esc(e.Message) + "\"}"; }
        if (found == null) return "{\"ok\":false,\"notFound\":true}";

        string winJson = "{\"x\":0,\"y\":0,\"w\":0,\"h\":0,\"title\":\"\"}";
        try
        {
            var r = found.Current.BoundingRectangle;
            int rx = 0, ry = 0, rw = 0, rh = 0;
            if (!double.IsNaN(r.X) && !double.IsInfinity(r.X)) rx = (int)Math.Round(r.X);
            if (!double.IsNaN(r.Y) && !double.IsInfinity(r.Y)) ry = (int)Math.Round(r.Y);
            if (!double.IsNaN(r.Width) && !double.IsInfinity(r.Width)) rw = (int)Math.Round(r.Width);
            if (!double.IsNaN(r.Height) && !double.IsInfinity(r.Height)) rh = (int)Math.Round(r.Height);
            winJson = "{\"x\":" + rx + ",\"y\":" + ry + ",\"w\":" + rw + ",\"h\":" + rh + ",\"title\":\"" + Esc(found.Current.Name ?? "") + "\"}";
        }
        catch { }

        var els = new List<string>();
        int count = 0;
        bool findMode = needle.Length > 0;
        AutomationElementCollection coll = null;
        try { coll = found.FindAll(TreeScope.Descendants, Condition.TrueCondition); } catch { }
        if (coll != null)
        {
            foreach (AutomationElement e in coll)
            {
                try
                {
                    var c = e.Current;
                    var br = c.BoundingRectangle;
                    if (br.Width <= 1 || br.Height <= 1) continue;
                    if (double.IsNaN(br.X) || double.IsNaN(br.Y) || double.IsNaN(br.Width) || double.IsNaN(br.Height)) continue;
                    if (double.IsInfinity(br.X) || double.IsInfinity(br.Y) || double.IsInfinity(br.Width) || double.IsInfinity(br.Height)) continue;
                    if (br.Width > 20000 || br.Height > 20000) continue;
                    if (br.X < -30000 || br.Y < -30000) continue;
                    string nm = c.Name ?? "";
                    string id = c.AutomationId ?? "";
                    string ct = "";
                    try { ct = c.ControlType.ProgrammaticName.Replace("ControlType.", ""); } catch { }
                    int bx = (int)Math.Round(br.X), by = (int)Math.Round(br.Y);
                    int bw = (int)Math.Round(br.Width), bh = (int)Math.Round(br.Height);
                    bool match = false;
                    if (findMode)
                    {
                        match = (nm.Length > 0 && nm.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
                             || (id.Length > 0 && id.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0);
                    }
                    if (findMode)
                    {
                        if (!match) continue;
                    }
                    else if (els.Count >= 80) { count++; continue; }
                    els.Add("{\"controlType\":\"" + Esc(ct) + "\",\"automationId\":\"" + Esc(id) + "\",\"name\":\"" + Esc(nm)
                        + "\",\"x\":" + bx + ",\"y\":" + by + ",\"w\":" + bw + ",\"h\":" + bh
                        + ",\"cx\":" + (bx + bw / 2) + ",\"cy\":" + (by + bh / 2) + "}");
                    count++;
                }
                catch { }
            }
        }
        return "{\"ok\":true,\"window\":" + winJson + ",\"count\":" + count + ",\"elements\":[" + string.Join(",", els.ToArray()) + "]}";
    }

    [STAThread]
    static void Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = Encoding.UTF8;
        dpiOk = SetProcessDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero;
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            string cmd = line.Trim();
            string resp;
            try
            {
                if (cmd == "list") resp = CmdList();
                else if (cmd == "cursor") resp = CmdCursor();
                else if (cmd == "ping") resp = "{\"ok\":true}";
                else if (cmd.StartsWith("uia ")) resp = CmdUia(cmd.Substring(4));
                else if (cmd == "quit") { resp = "{\"ok\":true}"; Console.Out.WriteLine(resp); Console.Out.Flush(); return; }
                else resp = "{\"ok\":false,\"error\":\"unknown cmd\"}";
            }
            catch (Exception e)
            {
                resp = "{\"ok\":false,\"error\":\"" + Esc(e.Message) + "\"}";
            }
            Console.Out.WriteLine(resp);
            Console.Out.Flush();
        }
    }
}
