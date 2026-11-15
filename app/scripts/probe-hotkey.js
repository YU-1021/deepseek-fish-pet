/* probe-hotkey.js —— ★全局停止快捷键：能不能注册 + 能不能被"真实按键"触发★
 *
 * 跑法：Remove-Item env:ELECTRON_RUN_AS_NODE ; node_modules\electron\dist\electron.exe app\scripts\probe-hotkey.js
 *
 * ★不开任何窗口 ✓（globalShortcut 在 ready 之后就能用 ✓）跑完 process.exit(0) ✓★
 *
 * 【它要自证的问题（主人两次真按键都没停住任务 ✗）】
 *   真机日志里 `Control+Alt+X` **注册成功了** ✓，但**从来没有任何一次 `停止请求`** ✓ ——
 *   也就是说那个回调**一次都没触发过** ✗。到底是：
 *     (A) 按键注入（SendKeys / keybd_event）根本触发不了 Electron 的 globalShortcut ✗，还是
 *     (B) 当时进程里注册的**不是**他按的那个键 ✗ ★（真机日志里就是这样：15:26:52 那次注册的是
 *         `Control+Alt+Shift+S` ✓，15:27:36 才换成 `Control+Alt+X` ✓ ——
 *         ★如果他按的时候进程拿的是另一个键，那按了当然没反应 ✗）★
 *   → 本探针把 (A) 判掉：在一个**干净进程**里注册、再分别用三种方式注入同一个键，看回调响不响 ✓。
 *   ★都响 → 结论是 (B)：键不匹配（而"键每次都可能变"本身就是必须修的问题 ✓）；
 *     都不响 → 结论是 (A)：注入输入触发不了 globalShortcut → 那就**如实说"没验到"**✗★。
 *
 * 【顺带验一件事】注册成功之后 `globalShortcut.isRegistered(k)` 是不是 true ✓ ——
 *   以后真机日志里会带这一项 ✓（"注册说成功、其实没生效"是最难查的那种 ✗）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, globalShortcut } = require('electron');

const out = [];
function L(s) { out.push(s); console.log(s); }
const fired = [];
const PS = path.join(__dirname, 'inject-key.ps1');
const OUT = 'C:/deepseek/probe-hotkey.out.txt';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 候选键：★不能用主人的桌宠可能占着的键✗★（它现在很可能拿着 Control+Alt+X ✓） */
const CANDS = [
  { label: 'Control+Alt+F9', vks: [17, 18, 120] },
  { label: 'Control+Alt+F10', vks: [17, 18, 121] },
  { label: 'Control+Shift+F9', vks: [17, 16, 120] },
];

function inject(method, vks) {
  /* ★参数用**空格分隔的单个字符串**传 ✓（第一版用 `-Vks 17,18,120` 被 PowerShell 当成一个数 1718120 ✗
     → 实验"看起来做了"、其实什么都没按 ✗ —— 这是"打印 ✓ ≠ 生效"的又一个例子 ✓） */
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS, '-Method', method, '-Vk', vks.join(' ')];
  return execFileSync('powershell.exe', args, { encoding: 'utf8', timeout: 20000 }).trim();
}

app.whenReady().then(async () => {
  L('=== probe-hotkey（全局停止快捷键：注册 + 真实按键注入）===');
  L('Electron ' + process.versions.electron + ' / node ' + process.versions.node);

  /* ① 挑一个能注册的键 + 断言 isRegistered ✓ */
  let pick = null;
  for (const c of CANDS) {
    let okReg = false;
    try { okReg = globalShortcut.register(c.label, () => { fired.push({ key: c.label, at: Date.now() }); }); } catch (e) { okReg = false; }
    const isReg = globalShortcut.isRegistered(c.label);
    L('  注册 ' + c.label + ' → register()=' + okReg + ' isRegistered()=' + isReg);
    if (okReg && isReg) { pick = c; break; }
  }
  if (!pick) {
    L('❌ 三个候选键都注册不上 ✗ —— 这台机器上"干净进程"都拿不到键，');
    L('   → 那真机上"注册成功"的那次也得怀疑 ✓（先把结论记下来 ✓）');
  } else {
    L('① ★能注册★：' + pick.label + '，且 isRegistered() 为真 ✓（以后真机日志里也会带这一项 ✓）');
  }

  if (pick) {
    /* ② 三种注入方式各试一次（每种都重新注册同一个键，避免互相干扰 ✓） */
    const methods = [
      ['sendinput', 'SendInput + wVk（现代 API ✓）'],
      ['keybd', 'keybd_event + 扫描码（老 API ✓）'],
      ['sendkeys', 'System.Windows.Forms.SendKeys（主人试过的那种 ✓）'],
    ];
    for (const [m, desc] of methods) {
      const before = fired.length;
      let inj = '';
      try { inj = inject(m, pick.vks); } catch (e) { inj = 'ERR ' + (e && e.message); }
      let waited = 0;
      while (fired.length === before && waited < 2500) { await sleep(100); waited += 100; }
      const hit = fired.length > before;
      L('  ' + (hit ? '✅ 触发了' : '❌ 没触发') + '  ' + desc + '   （' + inj + '，等 ' + waited + 'ms）');
    }
    L('');
    L('★★ 结论 ★★');
    if (fired.length > 0) {
      L('★ 注入的按键**能够**触发 Electron globalShortcut ✓（共 ' + fired.length + ' 次回调 ✓）→');
      L('  ★ 所以主人那两次"按了没反应"**不是**注入不生效 ✗，而是**当时进程里注册的不是他按的那个键** ✗★');
      L('  （真机日志证据：15:26:52 那次注册的是 Control+Alt+Shift+S ✓，15:27:36 才换成 Control+Alt+X ✓；');
      L('    ★而"同一个功能每次启动可能是不同的键"这件事本身就是 bug ✓ → 已改成"把生效的键记住"✓）');
    } else {
      L('✗ 三种注入方式**都触发不了** globalShortcut → ★注入输入这条路验不了这个功能 ✗★');
      L('  → 只能靠**真人按一次**来验 ✓；不许假装验过 ✗。');
    }
  }

  try { globalShortcut.unregisterAll(); } catch (e) {}
  fs.writeFileSync(OUT, out.join('\n'), 'utf8');
  L('');
  L('写出 ' + OUT);
  process.exit(0);
});
