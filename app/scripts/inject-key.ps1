# inject-key.ps1 -- inject one REAL system-wide keystroke (used as "the hand that presses"
# for app/scripts/probe-hotkey.js).
#
# Why a separate .ps1 file (not a string built in JS):
#   iron rule 1 says JS string literals must not nest ASCII double quotes, while the
#   P/Invoke declarations below need "user32.dll" everywhere -> a file sidesteps all escaping.
#
# !! ASCII ONLY, ON PURPOSE !!
#   This machine's `powershell.exe` is Windows PowerShell 5.1, which decodes a .ps1 file
#   WITHOUT a BOM as ANSI -> the Chinese comments got shredded, a newline got swallowed,
#   and the script died with a bogus parse error ("invalid assignment expression" at a
#   param member). Keeping this file pure ASCII removes the whole class of problem.
#   (The Chinese explanation lives in the .js probe instead -- Node always reads UTF-8.)
#
# Three injection methods (all real system keyboard input, NOT a message to one window):
#   sendinput : SendInput + wVk                     <- modern API, closest to a human keypress
#   keybd     : keybd_event + MapVirtualKey scan    <- legacy API
#   sendkeys  : System.Windows.Forms.SendKeys       <- the one the user already tried
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File inject-key.ps1 -Method sendinput -Vk '17 18 120'
#   17=Ctrl 18=Alt 120=F9 (decimal)
#
# NOTE (a real trap we hit): the first version took `[int[]]$Vks` and was called with
#   `-Vks 17,18,120`; the command line collapsed it into ONE number (the script printed
#   `1718120`), so the experiment only LOOKED like it pressed Ctrl+Alt+F9. Now the keys
#   arrive as one space separated string and are split here -- no binding ambiguity.
param(
  [string]$Method = 'sendinput',
  [string]$Vk = '17 18 120'
)
$Vks = @($Vk -split '\s+' | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ })
if ($Vks.Count -lt 1) { Write-Output 'no vks'; exit 2 }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class KeyInjector {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);
  public static void Send(ushort vk, uint f) {
    INPUT[] a = new INPUT[1];
    a[0].type = 1;
    a[0].ki.wVk = vk;
    a[0].ki.dwFlags = f;
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Combo(int[] vks) {
    for (int i = 0; i < vks.Length; i++) Send((ushort)vks[i], 0);
    System.Threading.Thread.Sleep(120);
    for (int i = vks.Length - 1; i >= 0; i--) Send((ushort)vks[i], 2);
  }
  public static void ComboLegacy(int[] vks) {
    for (int i = 0; i < vks.Length; i++) keybd_event((byte)vks[i], (byte)MapVirtualKey((uint)vks[i], 0), 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(120);
    for (int i = vks.Length - 1; i >= 0; i--) keybd_event((byte)vks[i], (byte)MapVirtualKey((uint)vks[i], 0), 2, UIntPtr.Zero);
  }
}
'@

switch ($Method) {
  'sendinput' { [KeyInjector]::Combo($Vks) }
  'keybd'     { [KeyInjector]::ComboLegacy($Vks) }
  'sendkeys'  { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^%{F9}') }
  default     { Write-Output ('unknown method: ' + $Method); exit 2 }
}
Write-Output ('injected ' + $Method + ' vks=' + ($Vks -join ','))
