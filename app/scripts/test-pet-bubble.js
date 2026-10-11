/* 「对话窗最小化时立绘要弹气泡」验证
 * electron.exe app\scripts\test-pet-bubble.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const REAL_UD = path.join(process.env.APPDATA, 'dayu-pet');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-bubbletest');
fs.mkdirSync(TEST_UD, { recursive: true });
for (const f of ['config.json', 'persona.json']) {
  try { fs.copyFileSync(path.join(REAL_UD, f), path.join(TEST_UD, f)); } catch {}
}
try { fs.unlinkSync(path.join(TEST_UD, 'clock-offset.json')); } catch {}
app.setPath('userData', TEST_UD);
require('../main.js');

app.whenReady().then(async () => {
  const M = require('../main.js');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  /* 读桌宠立绘那边的气泡 DOM */
  const readBubble = async (pet) => pet.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('bubble');
    if (!b) return { err: 'no #bubble' };
    return { show: b.classList.contains('show'), text: (b.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 90) };
  })()`);

  try {
    await wait(4000);
    const pet = M.win().petWin;
    M.createChat();
    await wait(6000);
    const chat = M.win().chatWin;
    if (!pet || pet.isDestroyed()) throw new Error('桌宠窗没起来');
    if (!chat || chat.isDestroyed()) throw new Error('对话窗没起来');

    L('=== 准备 ===');
    L('  chatWin visible=' + chat.isVisible() + ' minimized=' + chat.isMinimized());
    const b0 = await readBubble(pet);
    L('  立绘当前气泡: ' + JSON.stringify(b0));
    check('起的来、能读立绘气泡 DOM', !b0.err, JSON.stringify(b0).slice(0, 60));

    L('');
    L('=== 1. 对话窗**看得见**时不该重复弹气泡 ===');
    chat.show(); chat.focus();
    await wait(800);
    const sent1 = M.bubbleOnPetIfChatHidden({ en: 'this should not bubble', zh: '不该弹' });
    await wait(600);
    const b1 = await readBubble(pet);
    check('返回 false（没发）', sent1 === false, String(sent1));
    check('立绘气泡没被这条内容污染', !/should not bubble/.test(b1.text), JSON.stringify(b1).slice(0, 80));

    L('');
    L('=== 2. 对话窗**最小化**时要弹气泡 ===');
    chat.minimize();
    await wait(900);
    L('  最小化后: visible=' + chat.isVisible() + ' minimized=' + chat.isMinimized());
    check('对话窗确实最小化了', chat.isMinimized(), 'visible=' + chat.isVisible());
    const sent2 = M.bubbleOnPetIfChatHidden({ en: 'Task step one done, moving on.', zh: '第一步做完了，继续。' });
    await wait(900);
    const b2 = await readBubble(pet);
    L('  立绘气泡: ' + JSON.stringify(b2));
    check('★ 返回 true（发出了）', sent2 === true, String(sent2));
    check('★ 立绘气泡显示了（.show）', b2.show === true, JSON.stringify(b2).slice(0, 60));
    check('★ 气泡内容是刚推的那句', /Task step one done/.test(b2.text), b2.text);
    check('气泡里带中文翻译', /第一步做完了/.test(b2.text), b2.text);

    L('');
    L('=== 3. 对话窗隐藏（不是最小化）也要弹 ===');
    chat.hide();
    await wait(800);
    const sent3 = M.bubbleOnPetIfChatHidden({ en: 'Second step is running now.', zh: '第二步进行中。' });
    await wait(800);
    const b3 = await readBubble(pet);
    check('★ 隐藏时也弹（返回 true）', sent3 === true, String(sent3));
    check('★ 气泡更新成新的那句', /Second step is running/.test(b3.text), b3.text);

    L('');
    L('=== 4. 没有 en 的空回复不该乱弹 ===');
    chat.minimize(); await wait(500);
    const before = (await readBubble(pet)).text;
    const sent4 = M.bubbleOnPetIfChatHidden({ en: '', zh: '只有中文' });
    const sent5 = M.bubbleOnPetIfChatHidden(null);
    await wait(500);
    const after = (await readBubble(pet)).text;
    check('空 en 不弹（返回 false）', sent4 === false, String(sent4));
    check('null 不崩（返回 false）', sent5 === false, String(sent5));
    check('气泡内容没变', before === after, before.slice(0, 40));

    L('');
    L('=== 5. 对话窗恢复可见后不再弹（避免双重显示）===');
    chat.restore(); chat.show(); await wait(900);
    const sent6 = M.bubbleOnPetIfChatHidden({ en: 'third step', zh: '第三步' });
    check('恢复可见后返回 false', sent6 === false, 'visible=' + chat.isVisible() + ' minimized=' + chat.isMinimized());

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    var crashed = String((e && e.stack) || e);
    L('ERROR: ' + crashed);
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 300);
});
