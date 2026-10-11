/* 滚轮为什么没生效：先排除"焦点没拿到"
 * electron.exe app\scripts\probe-scroll.js
 */
const path = require('path');
const fs = require('fs');
const { app, screen } = require('electron');
const REAL_UD = path.join(process.env.APPDATA, 'dayu-pet');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-scrollprobe');
fs.mkdirSync(TEST_UD, { recursive: true });
try {
  fs.copyFileSync(path.join(REAL_UD, 'config.json'), path.join(TEST_UD, 'config.json'));
  fs.copyFileSync(path.join(REAL_UD, 'persona.json'), path.join(TEST_UD, 'persona.json'));
} catch {}
app.setPath('userData', TEST_UD);
require('../main.js');

app.whenReady().then(async () => {
  const M = require('../main.js');
  const input = require('../src/input');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    await wait(4000);
    M.createChat();
    await wait(6000);
    const w = M.win().chatWin;
    const pet = M.win().petWin;
    L('=== 窗口焦点排查 ===');
    L('  chatWin isFocused=' + w.isFocused() + '  isVisible=' + w.isVisible());
    L('  petWin  isFocused=' + (pet && !pet.isDestroyed() ? pet.isFocused() : 'n/a'));

    /* 撑满消息区 */
    await w.webContents.executeJavaScript(`(() => {
      const box = document.getElementById('msgs'); box.innerHTML = '';
      for (let i = 0; i < 80; i++) { const d = document.createElement('div'); d.className='msg pet'; d.style.padding='10px'; d.textContent='行 '+i+' 内容内容内容内容内容内容'; box.appendChild(d); }
      box.scrollTop = 400; return box.scrollHeight - box.clientHeight;
    })()`);

    /* 把宠物窗藏掉（它 alwaysOnTop，可能抢焦点/盖住） */
    try { pet.hide(); } catch {}
    await wait(500);
    w.show(); w.focus(); w.moveTop();
    await wait(1200);
    L('  藏掉宠物窗并 focus 之后: chatWin isFocused=' + w.isFocused() + '  isAlwaysOnTop=' + w.isAlwaysOnTop());
    /* 用 Electron 自己确认"操作系统层面"谁是前台窗口 */
    const fg = await w.webContents.executeJavaScript('document.hasFocus()');
    L('  渲染层 document.hasFocus() = ' + fg);

    const readTop = () => w.webContents.executeJavaScript('document.getElementById("msgs").scrollTop');
    const setTop = (v) => w.webContents.executeJavaScript('document.getElementById("msgs").scrollTop=' + v);

    /* 光标放到消息区中心 */
    const r = await w.webContents.executeJavaScript('(() => { const b=document.getElementById("msgs").getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height}; })()');
    const disp = screen.getPrimaryDisplay();
    const sp = input.space();
    const winPos = w.getPosition();       // 屏幕 DIP
    const cssX = r.x + r.w / 2, cssY = r.y + r.h / 2;
    const dipX = winPos[0] + cssX, dipY = winPos[1] + cssY;
    const mx = Math.round(dipX / disp.size.width * sp.w), my = Math.round(dipY / disp.size.height * sp.h);
    L('  光标目标: 窗口' + JSON.stringify(winPos) + ' CSS(' + Math.round(cssX) + ',' + Math.round(cssY) + ') → DIP(' + Math.round(dipX) + ',' + Math.round(dipY) + ') → 模型(' + mx + ',' + my + ')');
    input.move(mx, my);
    await wait(400);

    L('');
    L('=== 三轮尝试 ===');
    for (const [name, fn] of [
      ['input.scroll(+120)', () => input.scroll(mx, my, 120)],
      ['input.scroll(-120)', () => input.scroll(mx, my, -120)],
      ['input.scroll(+600)', () => input.scroll(mx, my, 600)],
    ]) {
      await setTop(400); await wait(250);
      const b = await readTop();
      try { fn(); } catch (e) { L('  ' + name + ' 抛错: ' + e.message); continue; }
      await wait(600);
      const a = await readTop();
      L('  ' + name.padEnd(22) + ' scrollTop ' + b + ' → ' + a + '  (' + (a - b) + ')' + (a === b ? '   ❌ 毫无反应' : '   ✅ 动了'));
    }

    L('');
    L('=== 对照：把焦点给渲染层自己（webContents.focus）再试 ===');
    w.webContents.focus();
    await wait(600);
    await setTop(400); await wait(250);
    const b2 = await readTop();
    input.scroll(mx, my, -600);
    await wait(600);
    const a2 = await readTop();
    L('  webContents.focus 后: ' + b2 + ' → ' + a2 + '  (' + (a2 - b2) + ')');
  } catch (e) {
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit(0), 300);
});
