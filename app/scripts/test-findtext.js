/* find_text 的测试：文字的模板匹配
 *
 * §A 纯逻辑（不碰屏幕/OCR 引擎）：用**手工构造的 OCR JSON** 测匹配与定位，
 *    覆盖：整行命中 / 行内子串命中（中心必须偏移正确）/ 汉字间空格归一化 /
 *         跨词命中（"进驻" + "总览" 被拆成两个词）/ 找不到时必须老实说没有 / 空输入。
 * §B 真实链路（要 OCR 引擎）：Node 写 UTF-8 文本 → PowerShell 画图 → ocr.ps1 -Json → 匹配。
 *    ⚠️ 画图的 ps1 必须带 UTF-8 BOM，否则 Windows PowerShell 5.1 会按 GBK 读脚本、
 *       中文全乱（这个坑今天踩了两次）。测试里会顺带检查所有项目 ps1 的 BOM。
 *
 * 跑法：electron.exe app\scripts\test-findtext.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');
const { execFileSync } = require('child_process');

const T = path.join(process.env.APPDATA, 'dayu-pet-findtext');
fs.mkdirSync(T, { recursive: true });
app.setPath('userData', T);

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅ ' + label + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '   ' + extra : '')); }
}

/* 构造一份和 Windows OCR 输出同形状的 JSON 帮助函数 */
function L(text, words) { return { text, words }; }
function W(t, x, y, w, h) { return { t, x, y, w, h }; }

app.whenReady().then(async () => {
  console.log('=== find_text 测试 ===');
  await new Promise((r) => setTimeout(r, 400));
  const A = require('../src/assistant');
  const findTextInOcr = A.__findTextInOcr;
  ok(typeof findTextInOcr === 'function', '§0 __findTextInOcr 已导出');

  /* ---------- §A 纯逻辑 ---------- */
  const j = {
    ok: true, imgW: 1920, imgH: 1080,
    lines: [
      L('进 驻 总 览', [W('进', 100, 50, 20, 20), W('驻', 122, 50, 20, 20), W('总', 144, 50, 20, 20), W('览', 166, 50, 20, 20)]),
      L('编 辑 队 列', [W('编', 100, 100, 20, 20), W('辑', 122, 100, 20, 20), W('队', 144, 100, 20, 20), W('列', 166, 100, 20, 20)]),
      L('控 制 中 枢 进 驻 干 员', [
        W('控', 100, 200, 20, 20), W('制', 122, 200, 20, 20), W('中', 144, 200, 20, 20), W('枢', 166, 200, 20, 20),
        W('进', 200, 200, 20, 20), W('驻', 222, 200, 20, 20), W('干', 244, 200, 20, 20), W('员', 266, 200, 20, 20)]),
      L('龙门商法', [W('龙门商法', 500, 300, 96, 24)]),
    ],
  };
  let r = findTextInOcr(j, '进驻总览');
  ok(!!r, '§A 整行命中「进驻总览」', r ? '(' + r.x + ',' + r.y + ')' : '');
  ok(r && r.x === 143 && r.y === 60, '§A 整行中心正确（进100..览186 → 143）', r ? '(' + r.x + ',' + r.y + ')' : '');

  r = findTextInOcr(j, '控制中枢');
  ok(r && r.x === 143, '§A 行首子串中心正确（' + (r && r.x) + '）');
  r = findTextInOcr(j, '进驻干员');
  /* 进@200 宽20（200..220）、员@266 宽20（266..286）→ 并集 200..286 → 中心 243。
     （我第一版把期望写成 253，是我心算错了 —— 实际 243 才对。） */
  ok(r && r.x === 243, '§A **行尾子串**中心正确（进200..员286 → 243）', r ? '(' + r.x + ',' + r.y + ')' : '');

  r = findTextInOcr(j, '进 驻 总 览');
  ok(!!r, '§A 目标里带空格也能命中（归一化）', r ? '(' + r.x + ',' + r.y + ')' : '');

  /* 跨"词"命中：OCR 把连续的汉字拆成两个词的情况 */
  const j2 = { ok: true, lines: [L('进驻 总览', [W('进驻', 10, 10, 40, 20), W('总览', 52, 10, 40, 20)])] };
  r = findTextInOcr(j2, '进驻总览');
  ok(!!r && r.x === 51, '§A 跨词命中（两词并集中心 10..92 → 51）', r ? '(' + r.x + ',' + r.y + ')' : '');

  ok(!findTextInOcr(j, '排班'), '§A 「排班」不在画面上 → 老实返回没找到');
  ok(!findTextInOcr(j, '换人'), '§A 「换人」不在画面上 → 老实返回没找到');
  ok(!findTextInOcr(j, ''), '§A 空目标 → 返回没找到（不匹配任何东西）');
  ok(!findTextInOcr({ ok: true, lines: [] }, '进驻'), '§A 空 OCR 结果 → 不崩、返回没找到');
  ok(!findTextInOcr(null, '进驻'), '§A OCR 为 null → 不崩、返回没找到');

  /* ---------- §B 所有项目 ps1 必须有 UTF-8 BOM ---------- */
  const scriptDir = path.join(__dirname);
  const ps1 = fs.readdirSync(scriptDir).filter((f) => f.endsWith('.ps1'));
  let noBom = [];
  for (const f of ps1) {
    const b = fs.readFileSync(path.join(scriptDir, f));
    if (!(b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF)) noBom.push(f);
  }
  ok(noBom.length === 0, '§B scripts/ 下所有 .ps1 都有 UTF-8 BOM（防 PowerShell 按 GBK 读中文注释而语法出错）',
    noBom.length ? '缺 BOM: ' + noBom.join(', ') : ps1.length + ' 个文件全都有');

  /* ---------- §C 真实 OCR 链路 ---------- */
  const linesFile = path.join(os.tmpdir(), 'ft-lines.txt');
  const fixture = path.join(os.tmpdir(), 'ft-fixture.png');
  const want = ['进驻总览', '编辑队列', '角色', '制造站 龙门商法', '确认 取消'];
  fs.writeFileSync(linesFile, want.join('\n'), 'utf8');   // Node 写文件永远是 UTF-8
  const drawPs = path.join(os.tmpdir(), 'ft-draw.ps1');
  fs.writeFileSync(drawPs, [
    'param([string]$Out,[string]$Lines)',
    'Add-Type -AssemblyName System.Drawing',
    '$text = Get-Content -LiteralPath $Lines -Encoding UTF8',
    '$w = 1000; $h = 80 + ($text.Count * 56)',
    '$bmp = New-Object System.Drawing.Bitmap($w, $h)',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.Clear([System.Drawing.Color]::FromArgb(24, 26, 32))',
    '$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit',
    '$font = New-Object System.Drawing.Font("Microsoft YaHei", 32, [System.Drawing.FontStyle]::Regular)',
    '$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 235, 240))',
    '$y = 24',
    'foreach ($t in $text) { $g.DrawString($t, $font, $brush, 30, $y); $y += 56 }',
    '$g.Dispose()',
    '$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)',
    '$bmp.Dispose()',
    'Write-Output "SAVED"',
  ].join('\n'), 'utf8');   // 纯 ASCII，无编码风险
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', drawPs, '-Out', fixture, '-Lines', linesFile], { timeout: 60000 });
    const so = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(scriptDir, 'ocr.ps1'), '-Path', fixture, '-Json'], { encoding: 'buffer', timeout: 60000 });
    const ocrJson = JSON.parse(so.toString('utf8').trim());
    ok(ocrJson.ok === true, '§C ocr.ps1 -Json 返回 ok');
    ok(ocrJson.imgW === 1000, '§C 图片尺寸正确', ocrJson.imgW + 'x' + ocrJson.imgH);
    let hitAll = 0;
    for (const t of want) { if (findTextInOcr(ocrJson, t.replace(/\s+/g, ''))) hitAll++; }
    ok(hitAll === want.length, '§C 真实 OCR：' + want.length + ' 条全部定位成功', hitAll + '/' + want.length);
    const miss = findTextInOcr(ocrJson, '排班');
    ok(!miss, '§C 真实 OCR：画面上没有的词老实返回没找到');
  } catch (e) {
    ok(false, '§C 真实 OCR 链路', e.message);
  }

  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  setTimeout(() => app.exit(fail ? 1 : 0), 200);
});
