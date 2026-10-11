/* 键盘卡死修复 + 步数预算 的验证
 * electron.exe app\scripts\test-input-safety.js
 *
 * 背景（用户报的故障）：她按了一次键之后，用户的键盘"输入不了东西、像错位了，只能重启"。
 * 根因：vendor/input/Input.cs 的 key 分支一边解析修饰键一边按下，主键名不认识就抛异常，
 *       已经按下的 Ctrl 再也没人松开。用 GetAsyncKeyState 已复现（旧 exe 卡 Ctrl、新 exe 不卡）。
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-inputtest');
fs.mkdirSync(TEST_UD, { recursive: true });
app.setPath('userData', TEST_UD);

app.whenReady().then(() => {
  const input = require('../src/input');
  const stats = require('../src/stats');
  const config = require('../src/config');
  const out = [];
  const L = (s) => out.push(s);
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  try {
    L('=== 1. 键名白名单：坏键名必须在**碰到键盘之前**就被拒绝 ===');
    const bad = ['ctrl+', '+c', 'ctrl++c', 'ctrl+cmd', 'ctrl+', 'foobar', 'ctrl+不存在的键', '', '   ', null, undefined, 'ctrl+ +c'];
    for (const b of bad) {
      let err = '';
      try { input.validateKey(b); } catch (e) { err = String(e.message); }
      check('拒绝 ' + JSON.stringify(String(b)).slice(0, 22), !!err, err.slice(0, 60));
    }
    L('');
    L('=== 2. 正常键名要放行 ===');
    const good = ['enter', 'esc', 'tab', 'space', 'backspace', 'delete', 'up', 'down', 'left', 'right',
      'home', 'end', 'pageup', 'pagedown', 'f1', 'f12', 'f24', 'a', 'z', '0', '9',
      'ctrl+c', 'ctrl+v', 'alt+f4', 'shift+tab', 'ctrl+shift+esc', 'win', 'ctrl', 'shift', 'alt'];
    let okAll = true; const failed = [];
    for (const g of good) {
      try { input.validateKey(g); } catch (e) { okAll = false; failed.push(g + '(' + e.message.slice(0, 30) + ')'); }
    }
    check('全部放行', okAll, failed.join(' ') || good.length + ' 个键名全部通过');
    check('f25 这种超范围的要被拒', (() => { try { input.validateKey('f25'); return false; } catch { return true; } })());
    check('KEY_NAMES 里有修饰键', ['ctrl', 'alt', 'shift', 'win'].every((k) => input.KEY_NAMES.includes(k)));

    L('');
    L('=== 3. 真正的按键/松开（会用 GetAsyncKeyState 复核，见外层脚本） ===');
    let e1 = '';
    try { input.key('ctrl+'); } catch (e) { e1 = String(e.message); }
    check('★ key("ctrl+") 立刻抛错（不会去 spawn input.exe）', /按键名写错/.test(e1), e1.slice(0, 70));
    let okKey = true;
    try { input.key('ctrl+c'); } catch (e) { okKey = false; L('    真实按键失败: ' + e.message); }
    check('正常组合键 ctrl+c 能执行', okKey);
    check('releaseAll 能执行', input.releaseAll() === true);

    L('');
    L('=== 4. 步数预算（用户反馈"步骤太少完不成任务"）===');
    const cfg = config.load();
    L('  配置: stepBudgetBase=' + cfg.stepBudgetBase + '  stepBudgetMax=' + cfg.stepBudgetMax);
    const rows = [];
    for (const iq of [20, 35, 54, 65, 80, 95]) {
      const v = stats.load();
      v.iq = iq; stats.save(v);
      rows.push(iq + '→' + stats.stepBudget());
    }
    L('  IQ → 步数: ' + rows.join('  '));
    const v = stats.load(); v.iq = 54; stats.save(v);
    const at54 = stats.stepBudget();
    check('★ IQ 54 至少给 12 步（原来只有 6）', at54 >= 12, '现在 ' + at54 + ' 步');
    check('IQ 越高步数越多（单调不减）', (() => {
      let last = 0;
      for (let iq = 20; iq <= 95; iq += 5) { const vv = stats.load(); vv.iq = iq; stats.save(vv); const b = stats.stepBudget(); if (b < last) return false; last = b; }
      return true;
    })());
    check('最低也有 base 步', (() => { const vv = stats.load(); vv.iq = 20; stats.save(vv); return stats.stepBudget() >= (cfg.stepBudgetBase || 8); })(), String(stats.stepBudget()));
    check('最高不超过 max', (() => { const vv = stats.load(); vv.iq = 95; stats.save(vv); return stats.stepBudget() <= (cfg.stepBudgetMax || 30); })(), String(stats.stepBudget()));
    check('可配置：改 base 立即生效', (() => {
      config.save({ stepBudgetBase: 15, stepBudgetMax: 15 });
      const vv = stats.load(); vv.iq = 30; stats.save(vv);
      const r = stats.stepBudget();
      config.save({ stepBudgetBase: cfg.stepBudgetBase, stepBudgetMax: cfg.stepBudgetMax });
      return r === 15;
    })());

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    var crashed = String((e && e.stack) || e);
    L('ERROR: ' + crashed);
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
