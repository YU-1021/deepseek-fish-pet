/* uia.js —— UI Automation 通道：拿"元素身份"而不是"像素位置"
 *
 * ============================ 为什么要有这条路 ============================
 * 调研结论 + 实测（2026-10-02）：
 *   · 对**非游戏**应用，控件树返回的是**应用自己报告的**元素名/Id/矩形 —— 没有"识别"这一步，
 *     天然抗 DPI、抗主题、抗缩放。实测计算器：num3Button (1652,662)、equalButton (1750,724)，
 *     与截图空间**逐字一致**；而 OCR 给的是 (1647,655) —— 差 5~8px。
 *   · 对**游戏**基本无效（树是空的或只有视觉节点）→ 要跳过，别浪费一次调用。
 *   · 它还能当**交叉验证**：UIA 的矩形 vs OCR 的框对不上 → 说明识别错了。
 *
 * 调研提到 Node 没有成熟的 UIA 绑定，建议复用 C# 侧。
 * 这里用 **PowerShell + UIAutomationClient**（系统自带、零依赖）—— 实测可用。
 *
 * ============================ 用法 ============================
 *   node src/uia.js list "<窗口标题片段>"                 列出该窗口的元素
 *   node src/uia.js find "<窗口标题片段>" "<元素名或Id>"   按名字/AutomationId 找元素
 */
'use strict';

const { execFile } = require('child_process');

/* ⚠️ 这段 PS 保持【纯 ASCII】，中文标题/元素名通过 -Command 里的单引号字符串传入
 *    （用 psQuote 转义单引号）。不要用模板字符串把中文拼进脚本 —— 会踩编码坑。 */
function psQuote(s) {
  return "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
}

const PS_HEAD = [
  /* 前两行是"按窗口句柄直接取元素树"的入口：$hwnd 非 0 时完全绕开标题匹配。
     为什么必须有它：实测同一台机器上有 3 个标题都是「计算器」的顶层窗口
     （其中一个是 visible=false 的 UWP 宿主窗，而它居然是"前台窗口"），
     按标题在 UIA 根节点里找会一个都找不到（NOTFOUND）。
     用 AutomationElement.FromHandle(hwnd) 就能精确拿到那个窗口的树。 */
  /* ⚠️ 每个数组元素都必须是【单行 JS 字符串】—— 注释只能写在数组外面。
     我上一版把 /* … *\/ 写进了字符串里，字符串跨行未闭合 → 整个文件语法错误。
     ⚠️ 另外：有些元素（虚拟化列表项、离屏容器）的 BoundingRectangle 是【无穷大或 NaN】，
        直接 [int] 转换会抛"无法将值 ∞ 转换为 Int32"并让整次查询失败（实测），
        所以下面必须先把非有限值和越界值挡掉。 */
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes',
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $root = [System.Windows.Automation.AutomationElement]::RootElement',
  '  $want = ' + '__WANT__',
  '  $wantHwnd = ' + '__HWND__',
  '  $found = $null',
  '  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)',
  '  foreach ($w in $all) {',
  '    $n = $w.Current.Name',
  '    if ($n -and $n.IndexOf($want) -ge 0) { $found = $w; break }',
  '  }',
  '  if ($wantHwnd -ne 0) {',
  '    $found = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$wantHwnd)',
  '  }',
  '  if (-not $found) { Write-Output "NOTFOUND"; exit 0 }',
  '  $r = $found.Current.BoundingRectangle',
  '  $rx = 0; $ry = 0; $rw = 0; $rh = 0',
  '  if (-not [double]::IsNaN($r.X) -and -not [double]::IsInfinity($r.X)) { $rx = [int]$r.X }',
  '  if (-not [double]::IsNaN($r.Y) -and -not [double]::IsInfinity($r.Y)) { $ry = [int]$r.Y }',
  '  if (-not [double]::IsNaN($r.Width) -and -not [double]::IsInfinity($r.Width)) { $rw = [int]$r.Width }',
  '  if (-not [double]::IsNaN($r.Height) -and -not [double]::IsInfinity($r.Height)) { $rh = [int]$r.Height }',
  '  Write-Output ("WINDOW|" + $rx + "|" + $ry + "|" + $rw + "|" + $rh + "|" + $found.Current.Name)',
  '  $els = $found.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)',
  '  $needle = ' + '__NEEDLE__',
  '  $mode = ' + '__MODE__',
  '  $count = 0',
  '  foreach ($e in $els) {',
  '    try {',
  '    $c = $e.Current',
  '    $br = $c.BoundingRectangle',
  '    if ($br.Width -le 1 -or $br.Height -le 1) { continue }',
  '    if ([double]::IsNaN($br.X) -or [double]::IsNaN($br.Y) -or [double]::IsNaN($br.Width) -or [double]::IsNaN($br.Height)) { continue }',
  '    if ([double]::IsInfinity($br.X) -or [double]::IsInfinity($br.Y) -or [double]::IsInfinity($br.Width) -or [double]::IsInfinity($br.Height)) { continue }',
  '    if ($br.Width -gt 20000 -or $br.Height -gt 20000) { continue }',
  '    if ($br.X -lt -30000 -or $br.Y -lt -30000) { continue }',
  '    $nm = $c.Name; $id = $c.AutomationId; $ct = $c.ControlType.ProgrammaticName.Replace("ControlType.","")',
  '    $hx = [int]($br.X + $br.Width / 2); $hy = [int]($br.Y + $br.Height / 2)',
  '    $line = "EL|" + $ct + "|" + $id + "|" + $nm + "|" + [int]$br.X + "|" + [int]$br.Y + "|" + [int]$br.Width + "|" + [int]$br.Height + "|" + $hx + "|" + $hy',
  '    if ($mode -eq "find") {',
  '      if ($needle -and (($nm -and $nm.IndexOf($needle) -ge 0) -or ($id -and $id.IndexOf($needle) -ge 0))) {',
  '        Write-Output $line; $count++',
  '      }',
  '    } else {',
  '      if ($count -lt 80) { Write-Output $line }',
  '      $count++',
  '    }',
  '    } catch { }   # 单个元素出问题就跳过，绝不让它毁掉整次查询',
  '  }',
  '  Write-Output ("COUNT|" + $count)',
  '} catch { Write-Output ("ERR|" + $_.Exception.Message) }',
].join('\n');

function buildScript(mode, windowTitle, needle, hwnd) {
  return PS_HEAD
    .replace('__WANT__', psQuote(windowTitle))
    .replace('__NEEDLE__', psQuote(needle))
    .replace('__MODE__', psQuote(mode))
    .replace('__HWND__', String(Number(hwnd) || 0));
}

function parse(out) {
  const r = { window: null, elements: [], count: 0 };
  for (const line of String(out || '').split(/\r?\n/)) {
    let m = line.match(/^WINDOW\|(-?\d+)\|(-?\d+)\|(\d+)\|(\d+)\|(.*)$/);
    if (m) { r.window = { x: +m[1], y: +m[2], w: +m[3], h: +m[4], title: m[5] }; continue; }
    m = line.match(/^EL\|([^|]*)\|([^|]*)\|([^|]*)\|(-?\d+)\|(-?\d+)\|(\d+)\|(\d+)\|(-?\d+)\|(-?\d+)$/);
    if (m) {
      r.elements.push({
        controlType: m[1], automationId: m[2], name: m[3],
        x: +m[4], y: +m[5], w: +m[6], h: +m[7], cx: +m[8], cy: +m[9],
      });
      continue;
    }
    m = line.match(/^COUNT\|(\d+)$/);
    if (m) { r.count = +m[1]; continue; }
    if (line.trim() === 'NOTFOUND') r.notFound = true;
    if (/^ERR\|/.test(line)) r.error = line.slice(4);
  }
  return r;
}

function run(mode, windowTitle, needle, timeoutMs, hwnd) {
  const script = buildScript(mode, windowTitle, needle, hwnd);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs || 40000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (e, so, se) => {
        const r = parse(so);
        if (!r.window && !r.elements.length) {
          r.raw = String(so || '').slice(0, 300) + (se ? ' | ' + String(se).slice(0, 300) : '');
          if (e && !r.error) r.error = String(e.message || e).slice(0, 200);
        }
        resolve(r);
      });
  });
}

function listElements(windowTitle, hwnd) { return run('list', windowTitle, '', undefined, hwnd); }
function findElement(windowTitle, needle, hwnd) { return run('find', windowTitle, needle, undefined, hwnd); }

/* ★ 按 hwnd 直接定位 ★ —— 同名窗口多、或标题在 UIA 里读不到时，这是唯一可靠的路。
   实战：3 个「计算器」窗口，按标题 NOTFOUND；按 hwnd 一次拿到 num3Button/equalButton。 */
async function locateByHwnd(hwnd, needle) {
  const r = await findElement('', needle, hwnd);
  if (!r.window) return { ok: false, reason: r.notFound ? 'hwnd-not-found' : (r.error || 'uia-failed'), raw: r.raw };
  const exact = r.elements.find((e) => e.name === needle || e.automationId === needle);
  const hit = exact || r.elements[0];
  if (!hit) return { ok: false, reason: 'element-not-found', window: r.window, count: r.count };
  return {
    ok: true, x: hit.cx, y: hit.cy, confidence: exact ? 0.98 : 0.85,
    how: 'uia-hwnd' + (exact ? '-exact' : '-loose'),
    extra: { name: hit.name, automationId: hit.automationId, controlType: hit.controlType, rect: { x: hit.x, y: hit.y, w: hit.w, h: hit.h } },
  };
}

/* 便捷：找元素并返回可直接点击的中心点（含置信度和身份信息） */
async function locate(windowTitle, needle, hwnd) {
  const r = await findElement(windowTitle, needle, hwnd);
  if (!r.window) {
    return { ok: false, reason: r.notFound ? 'window-not-found' : (r.error || 'uia-failed'), raw: r.raw };
  }
  const exact = r.elements.find((e) => e.name === needle || e.automationId === needle);
  const hit = exact || r.elements[0];
  if (!hit) return { ok: false, reason: 'element-not-found', window: r.window, count: r.count };
  return {
    ok: true, x: hit.cx, y: hit.cy, confidence: exact ? 0.98 : 0.85,
    how: 'uia' + (exact ? '-exact' : '-loose'),
    extra: {
      name: hit.name, automationId: hit.automationId, controlType: hit.controlType,
      rect: { x: hit.x, y: hit.y, w: hit.w, h: hit.h },
    },
  };
}

/* 交叉验证：UIA 的矩形和 OCR 给的框是否指向同一个东西（用于发现"识别错了"） */
function crossCheck(uiaRect, ocrBox, tolerance) {
  if (!uiaRect || !ocrBox) return { ok: false, reason: 'no-data' };
  const tol = tolerance == null ? 24 : tolerance;
  const ax = uiaRect.x + uiaRect.w / 2, ay = uiaRect.y + uiaRect.h / 2;
  const bx = ocrBox.x + ocrBox.w / 2, by = ocrBox.y + ocrBox.h / 2;
  const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
  return { ok: dx <= tol && dy <= tol, dx: Math.round(dx), dy: Math.round(dy), tolerance: tol };
}

module.exports = { listElements, findElement, locate, locateByHwnd, crossCheck, parse, buildScript };

if (require.main === module) {
  const [cmd, win, needle] = process.argv.slice(2);
  (async () => {
    if (cmd === 'list') {
      const r = await listElements(win || '');
      if (r.window) console.log('WINDOW ' + r.window.title + '  ' + r.window.x + ',' + r.window.y + ' ' + r.window.w + 'x' + r.window.h);
      console.log('元素 ' + r.elements.length + ' / 共 ' + r.count);
      for (const e of r.elements.slice(0, 30)) {
        console.log('  [' + e.controlType + '] ' + (e.automationId || '-') + '  "' + e.name + '"  ' + e.cx + ',' + e.cy);
      }
      if (r.error) console.log('ERR ' + r.error);
      if (r.notFound) console.log('NOTFOUND');
    } else if (cmd === 'find') {
      console.log(JSON.stringify(await locate(win || '', needle || ''), null, 1));
    } else {
      console.log('用法: node src/uia.js list "<窗口标题片段>" | find "<窗口标题片段>" "<名字或Id>"');
    }
    process.exit(0);
  })();
}
