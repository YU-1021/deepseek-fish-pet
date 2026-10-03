'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-action-ipc');
const RESULT_FILE = path.join(TEST_UD, 'result.json');
fs.mkdirSync(TEST_UD, { recursive: true });
try { fs.unlinkSync(RESULT_FILE); } catch {}
app.setPath('userData', TEST_UD);
process.env.DAYU_TEST_HEADLESS = '1';

require('../main.js');

app.whenReady().then(async () => {
  const M = require('../main.js');
  let win;
  let pass = 0;
  let fail = 0;
  const lines = [];
  const ok = (value, label, detail) => {
    if (value) { pass++; lines.push('  ✅ ' + label + (detail ? '  ' + detail : '')); }
    else { fail++; lines.push('  ❌ ' + label + (detail ? '  ' + detail : '')); }
  };

  try {
    const cfg = M.config.load();
    M.config.save(Object.assign({}, cfg, { assistant: 'full' }));
    let runs = 0;
    M.assistant.run = async (tool, arg) => {
      runs++;
      return 'stub:' + tool + ':' + arg;
    };

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await win.loadURL('data:text/html,<html><body>ipc</body></html>');
    const call = (source) => win.webContents.executeJavaScript(source, true);

    const productionWindows = M.win();
    ok(productionWindows.petWin === null && productionWindows.chatWin === null,
      'IPC 测试模式不创建桌宠/聊天窗，也不启动屏幕捕获');

    const surface = await call(`({
      inspect: typeof window.petAPI.assistantInspect,
      approve: typeof window.petAPI.assistantApprove,
      run: typeof window.petAPI.assistantRun,
      nodeRequire: typeof window.require
    })`);
    ok(surface.inspect === 'function' && surface.approve === 'function' && surface.run === 'function',
      'preload 只暴露三个受控助手入口', JSON.stringify(surface));
    ok(surface.nodeRequire === 'undefined', '渲染进程仍不能直接 require Node');

    const unverified = await call(`window.petAPI.assistantInspect({tool:'click',arg:'100,200'})`);
    ok(unverified.decision === 'confirm' && unverified.reason === 'unverified-target',
      '裸坐标点击只返回确认要求，不执行', JSON.stringify(unverified));
    ok(runs === 0, 'inspect 没有执行工具');

    const epoch = M.userinput.state().userEpoch;
    const seeded = M.actionExecutor.recordTarget('find_text', {
      text: 'found', target: { x: 100, y: 200, source: 'find_text', label: '确认' },
    }, { userEpoch: epoch });
    ok(seeded.ok === true, '可信定位结果签发一次性目标凭证');
    const verified = await call(`window.petAPI.assistantInspect({tool:'click',arg:'100,200'})`);
    ok(verified.decision === 'allow' && verified.reason === 'verified-target',
      '精确匹配的点击被允许', JSON.stringify(verified));
    const firstClick = await call(`window.petAPI.assistantRun({action:{tool:'click',arg:'100,200'}})`);
    ok(firstClick.ok === true && firstClick.result === 'stub:click:100,200', '执行匹配点击并保留旧 result 字段');
    const replayClick = await call(`window.petAPI.assistantRun({action:{tool:'click',arg:'100,200'}})`);
    ok(replayClick.ok === false && replayClick.needsConfirmation === true, '目标凭证只能使用一次');

    const action = { tool: 'web_click', arg: '#checkout' };
    const approval = await call(`window.petAPI.assistantApprove(${JSON.stringify(action)})`);
    ok(approval.ok === true && typeof approval.token === 'string', '高风险动作签发绑定动作的确认令牌');
    const once = await call(`window.petAPI.assistantRun({action:${JSON.stringify(action)},approvalToken:${JSON.stringify(approval.token)}})`);
    ok(once.ok === true && once.result === 'stub:web_click:#checkout', '确认令牌可执行一次');
    const replay = await call(`window.petAPI.assistantRun({action:${JSON.stringify(action)},approvalToken:${JSON.stringify(approval.token)}})`);
    ok(replay.ok === false && replay.reason === 'approval-not-found', '确认令牌不可重放');
    ok(runs === 2, '只有两次已授权动作到达底层执行器', 'runs=' + runs);
  } catch (error) {
    fail++;
    lines.push('  ❌ 测试异常  ' + ((error && error.stack) || error));
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
  }

  const result = { pass, fail, total: pass + fail, lines };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), 'utf8');
  console.log('=== action IPC 集成测试 ===');
  console.log(lines.join('\n'));
  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  setTimeout(() => app.exit(fail ? 1 : 0), 200);
});
