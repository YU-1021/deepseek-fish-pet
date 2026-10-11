/* 滚动工具回归验证（方向 / 幅度 / 焦点条件 / 新的 up-down 写法）
 * electron.exe app\scripts\test-scroll-dir.js
 *
 * 背景（用户报："她说滚动工具反了，不能自由滚动"）：
 *   实测查明：滚轮本身**没坏、方向也没反**（+120 确实是向上，和 Windows 约定一致），
 *   但有两件事让她做不成：
 *     1) 原来只收裸数字，而"正数向上"和网页 scrollTop 的直觉相反 → 她会用反
 *     2) 注入的滚轮事件只作用于**光标下/有焦点**的窗口 —— 目标被别的窗口
 *        （包括 alwaysOnTop 的桌宠窗自己）挡住时**毫无反应**，表现得就像"工具坏了"
 *   所以：① 加了 up/down 词写法消除歧义；② 三处提示词都写清方向与焦点条件；
 *        ③ 本测试把这两种情况都固定下来。
 */
const path = require('path');
const fs = require('fs');
const { app, screen } = require('electron');
const REAL_UD = path.join(process.env.APPDATA, 'dayu-pet');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-scrolltest');
fs.mkdirSync(TEST_UD, { recursive: true });
try {
  fs.copyFileSync(path.join(REAL_UD, 'config.json'), path.join(TEST_UD, 'config.json'));
  fs.copyFileSync(path.join(REAL_UD, 'persona.json'), path.join(TEST_UD, 'persona.json'));
} catch {}
try { fs.unlinkSync(path.join(TEST_UD, 'clock-offset.json')); } catch {}
app.setPath('userData', TEST_UD);
require('../main.js');

app.whenReady().then(async () => {
  const M = require('../main.js');
  const input = require('../src/input');
  const assistant = require('../src/assistant');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  try {
    await wait(4000);
    M.createChat();
    await wait(6000);
    const w = M.win().chatWin, pet = M.win().petWin;
    if (!w || w.isDestroyed()) throw new Error('对话窗没起来');

    /* 撑满并让目标窗口获得焦点（这一步是关键：滚轮只作用于焦点/光标下的窗口） */
    const max = await w.webContents.executeJavaScript(`(() => {
      const box = document.getElementById('msgs'); box.innerHTML = '';
      for (let i = 0; i < 80; i++) { const d = document.createElement('div'); d.className='msg pet'; d.style.padding='10px'; d.textContent='行 '+i+' 内容内容内容内容内容内容内容'; box.appendChild(d); }
      box.scrollTop = 400; return box.scrollHeight - box.clientHeight;
    })()`);
    try { pet.hide(); } catch {}
    await wait(400);
    w.show(); w.focus(); w.moveTop();
    await wait(1200);
    L('=== 靶子准备 ===');
    L('  可滚范围 0~' + max + '   焦点: chatWin=' + w.isFocused() + ' document.hasFocus=' + (await w.webContents.executeJavaScript('document.hasFocus()')));
    check('目标窗口拿到了焦点（滚轮的前提）', w.isFocused() && (await w.webContents.executeJavaScript('document.hasFocus()')));
    check('对话窗确实可滚动', max > 500, '可滚 ' + Math.round(max) + 'px');

    /* 光标放进消息区中心 */
    const r = await w.webContents.executeJavaScript('(() => { const b=document.getElementById("msgs").getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height}; })()');
    const disp = screen.getPrimaryDisplay(), sp = input.space(), wp = w.getPosition();
    const dipX = wp[0] + r.x + r.w / 2, dipY = wp[1] + r.y + r.h / 2;
    const mx = Math.round(dipX / disp.size.width * sp.w), my = Math.round(dipY / disp.size.height * sp.h);
    input.move(mx, my);
    await wait(400);

    const readTop = () => w.webContents.executeJavaScript('document.getElementById("msgs").scrollTop');
    const setTop = (v) => w.webContents.executeJavaScript('document.getElementById("msgs").scrollTop=' + v);
    const tryScroll = async (arg) => {
      await setTop(800); await wait(250);
      const b = await readTop();
      let ret = '';
      try { ret = await assistant.run('scroll', arg); } catch (e) { ret = 'ERR ' + e.message; }
      await wait(500);
      return { b, a: await readTop(), ret };
    };

    L('');
    L('=== 1. 新的词写法：down / up ===');
    const d1 = await tryScroll(mx + ',' + my + '|down');
    L('  down      → scrollTop ' + d1.b + ' → ' + d1.a + '  (' + Math.round(d1.a - d1.b) + ')');
    check('★ down 是向下（内容下移、scrollTop 变大）', d1.a > d1.b, '走了 ' + Math.round(d1.a - d1.b) + 'px');
    check('返回值文案说"向下"', /向下/.test(d1.ret), d1.ret.split('\n')[0]);

    const u1 = await tryScroll(mx + ',' + my + '|up');
    L('  up        → scrollTop ' + u1.b + ' → ' + u1.a + '  (' + Math.round(u1.a - u1.b) + ')');
    check('★ up 是向上（内容上移、scrollTop 变小）', u1.a < u1.b, '走了 ' + Math.round(u1.a - u1.b) + 'px');
    check('返回值文案说"向上"', /向上/.test(u1.ret), u1.ret.split('\n')[0]);

    L('');
    L('=== 2. 格数：一次能滚多少（"不能自由滚动"的正面回答）===');
    const n1 = await tryScroll(mx + ',' + my + '|down|1');
    const n5 = await tryScroll(mx + ',' + my + '|down|5');
    const n10 = await tryScroll(mx + ',' + my + '|down|10');
    L('  1 格 → ' + Math.round(n1.a - n1.b) + 'px   5 格 → ' + Math.round(n5.a - n5.b) + 'px   10 格 → ' + Math.round(n10.a - n10.b) + 'px');
    check('★ 格数越多滚得越远（单调）',
      (n10.a - n10.b) >= (n5.a - n5.b) && (n5.a - n5.b) >= (n1.a - n1.b),
      [n1, n5, n10].map((x) => Math.round(x.a - x.b)).join(' ≤ '));
    check('默认（不给格数）至少滚一屏量级（>=300px）', Math.abs(d1.a - d1.b) >= 300, Math.round(Math.abs(d1.a - d1.b)) + 'px');
    check('返回值写明格数', /格/.test(n10.ret), n10.ret.split('\n')[0]);

    L('');
    L('=== 3. 裸数字仍然兼容（Windows 原生约定：正数=向上）===');
    const p1 = await tryScroll(mx + ',' + my + '|600');
    check('正数 600 → 向上（scrollTop 变小）', p1.a < p1.b, '走了 ' + Math.round(p1.a - p1.b) + 'px');
    const m1 = await tryScroll(mx + ',' + my + '|-600');
    check('负数 -600 → 向下（scrollTop 变大）', m1.a > m1.b, '走了 ' + Math.round(m1.a - m1.b) + 'px');

    L('');
    L('=== 4. 封顶：不许一滚到底 ===');
    const big = await tryScroll(mx + ',' + my + '|999999');
    check('超大值被夹到 6000（50 格）以内', Math.abs(big.a - big.b) <= max + 1, '实际 ' + Math.round(Math.abs(big.a - big.b)) + 'px');
    check('返回值里的格数不超过 50', (() => { const m = String(big.ret).match(/(\d+) 格/); return !m || Number(m[1]) <= 50; })(), (String(big.ret).match(/\d+ 格/) || [''])[0]);

    L('');
    L('=== 5. 容错 ===');
    const none = await tryScroll(mx + ',' + my);            // 完全不给方向
    check('不给方向也能跑（默认向下）', none.a > none.b, '走了 ' + Math.round(none.a - none.b) + 'px');
    let e = '';
    try { await assistant.run('scroll', 'x,y|down'); } catch (err) { e = String(err.message); }
    check('坐标乱写给出可读报错', /坐标格式/.test(e), e.slice(0, 50));
    const junk = await tryScroll(mx + ',' + my + '|sideways');
    check('方向词不认识时退回默认（不崩）', typeof junk.ret === 'string' && !/ERR/.test(junk.ret), String(junk.ret).split('\n')[0]);

    L('');
    L('=== 6. 提示词里都写清了方向与焦点条件 ===');
    const sysPrompt = M.buildSystemPrompt(M.config.load());
    const contPrompt = M.buildContinuePrompt(M.config.load());
    check('首轮提示词含 up/down 写法', /scroll\|x,y\|down/.test(sysPrompt) && /up/.test(sysPrompt));
    check('首轮提示词说明了"正数=向上"这个反直觉点', /POSITIVE = UP|正数.*向上/i.test(sysPrompt));
    check('首轮提示词说明了焦点/遮挡条件', /focus|covered|挡住/i.test(sysPrompt));
    check('续跑提示词含 up/down 写法', /scroll\|x,y\|down/.test(contPrompt));
    check('返回值提醒了焦点条件', /焦点|挡住/.test(d1.ret), '');

    M.win().petWin && M.win().petWin.show && M.win().petWin.show();
    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    var crashed = String((e && e.stack) || e);
    L('ERROR: ' + crashed);
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 300);
});
