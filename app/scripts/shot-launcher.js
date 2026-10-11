// 把鹰角启动器调到前台并截图，方便定位「开始游戏」按钮
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PS_FIND = `
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public class F {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,Rr,B; }
  public static IntPtr Found = IntPtr.Zero;
  public static string Want = "";
  public static string Info = "";
  public static void Go(string want) {
    Want = want; Found = IntPtr.Zero;
    EnumWindows((h,p) => {
      var sb = new StringBuilder(300); GetWindowText(h, sb, 300);
      string t = sb.ToString();
      if (t.Contains(want)) { Found = h; Info = t; return false; }
      return true;
    }, IntPtr.Zero);
    if (Found != IntPtr.Zero) {
      if (IsIconic(Found)) ShowWindow(Found, 9);   // SW_RESTORE
      ShowWindow(Found, 5);                        // SW_SHOW
      SetForegroundWindow(Found);
    }
  }
  public static string Rect() {
    if (Found == IntPtr.Zero) return "";
    R r; GetWindowRect(Found, out r);
    return r.L + "," + r.T + "," + (r.Rr-r.L) + "x" + (r.B-r.T);
  }
}
'@
[F]::Go("$WANT")
Start-Sleep -Milliseconds 900
"FOUND=" + [F]::Found + "  INFO=" + [F]::Info + "  RECT=" + [F]::Rect()
`;

const want = process.argv[2] || '鹰角启动器';
const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', PS_FIND.replace('$WANT', want)], { encoding: 'utf8', timeout: 30000, windowsHide: true });
console.log(String(r.stdout || '').trim());
console.log(String(r.stderr || '').trim().slice(0, 400));

// 截图
const PS_SHOT = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$bmp.Save("$OUT", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"OK"
`;
const out = path.join(process.env.TEMP, 'launcher.png');
const r2 = spawnSync('powershell.exe', ['-NoProfile', '-Command', PS_SHOT.replace('$OUT', out)], { encoding: 'utf8', timeout: 30000, windowsHide: true });
console.log('截图: ' + out + '  ' + Math.round(fs.statSync(out).size / 1024) + 'KB');
