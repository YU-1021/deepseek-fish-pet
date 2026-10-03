/*
 * 真实键鼠输入闭环：模型坐标点击本地输入框，再由 input.exe 输入中英文并读回校验。
 *
 * 用法：
 *   electron.exe app\scripts\test-type-target.js
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, screen } = require('electron');

const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-type-target-test');
const RESULT_FILE = path.join(TEST_UD, 'result.json');
fs.mkdirSync(TEST_UD, { recursive: true });
try { fs.unlinkSync(RESULT_FILE); } catch {}
app.setPath('userData', TEST_UD);

app.whenReady().then(async () => {
  const input = require('../src/input');
  const rows = [];
  let passed = 0;
  let total = 0;
  const check = (name, ok, detail) => {
    total++;
    if (ok) passed++;
    rows.push((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  ' + detail : ''));
  };

  const win = new BrowserWindow({
    width: 640,
    height: 360,
    show: false,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const chat = new BrowserWindow({
    width: 360,
    height: 220,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
      <html><head><meta charset="utf-8"><style>
        body { margin: 0; display: grid; place-items: center; height: 100vh; background: #eef4ff; }
        textarea { width: 440px; height: 120px; padding: 16px; font: 22px sans-serif; }
      </style></head><body><textarea id="editor" aria-label="测试输入框"></textarea></body></html>`));
    win.show();
    win.focus();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const bounds = win.getBounds();
    const display = screen.getPrimaryDisplay();
    const targetDip = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const space = input.space();
    const targetModel = {
      x: Math.round(targetDip.x / display.size.width * space.w),
      y: Math.round(targetDip.y / display.size.height * space.h),
    };
    const expected = 'Hello, Master! 鲸鱼 7391.';

    input.click(targetModel.x, targetModel.y);
    await new Promise((resolve) => setTimeout(resolve, 250));
    input.type(expected);
    await new Promise((resolve) => setTimeout(resolve, 350));

    const actual = await win.webContents.executeJavaScript(`({
      value: document.getElementById('editor').value,
      focused: document.activeElement && document.activeElement.id
    })`);
    check('模型坐标点击后焦点落在目标输入框', actual.focused === 'editor', 'focused=' + actual.focused);
    check('英文、中文、数字和标点完整输入', actual.value === expected, JSON.stringify(actual.value));
    check('测试窗口保持 contextIsolation=true / nodeIntegration=false',
      win.webContents.getLastWebPreferences().contextIsolation === true
        && win.webContents.getLastWebPreferences().nodeIntegration === false);

    input.key('ctrl+a');
    input.key('backspace');
    await chat.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<h1>模拟助手聊天窗</h1>'));
    chat.show();
    chat.focus();
    await new Promise((resolve) => setTimeout(resolve, 200));
    chat.hide();
    await new Promise((resolve) => setTimeout(resolve, 150));
    input.click(targetModel.x, targetModel.y);
    await new Promise((resolve) => setTimeout(resolve, 180));
    chat.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 120));
    chat.hide();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const secondExpected = 'Second round 输入仍然正确。';
    input.type(secondExpected);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterWindowCycle = await win.webContents.executeJavaScript(`({
      value: document.getElementById('editor').value,
      focused: document.activeElement && document.activeElement.id
    })`);
    check('聊天窗跨轮隐藏/恢复后，文字仍进入刚点击的目标框',
      afterWindowCycle.focused === 'editor' && afterWindowCycle.value === secondExpected,
      JSON.stringify(afterWindowCycle));
  } catch (error) {
    rows.push('ERROR: ' + String((error && error.stack) || error));
  } finally {
    try { input.releaseAll(); } catch {}
    try { chat.destroy(); } catch {}
    try { win.destroy(); } catch {}
  }

  console.log('真实输入目标测试');
  console.log(rows.join('\n'));
  console.log('\n通过 ' + passed + ' / ' + total);
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ passed, total, rows }, null, 2));
  setTimeout(() => app.exit(passed === total && total === 4 ? 0 : 1), 100);
});
