'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-action-confirmation-ui');
const RESULT_FILE = path.join(TEST_UD, 'result.json');
fs.mkdirSync(TEST_UD, { recursive: true });
try { fs.unlinkSync(RESULT_FILE); } catch {}
app.setPath('userData', TEST_UD);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 430, height: 780, show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: false,
      nodeIntegration: false,
      preload: path.join(__dirname, 'stub-preload.js'),
    },
  });
  const checks = [];
  const check = (label, value, detail) => checks.push({ label, value: !!value, detail: detail || '' });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'chat.html'));
  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const result = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const host = () => { const d = document.createElement('div'); document.body.appendChild(d); return d; };
        const calls = (name) => window.__assistantStub.calls.filter((x) => x.method === name);
        const out = {};

        window.__assistantStub.reset('confirm');
        let confirmed = 0;
        const h1 = host();
        renderAction(h1, {tool:'proj_rm',arg:'old.txt'}, async (token) => {
          confirmed++;
          await execAction({tool:'proj_rm',arg:'old.txt'}, token);
        }, () => {});
        await wait(40);
        out.fullStillConfirms = !!h1.querySelector('.actionbar .allow') && calls('run').length === 0;
        const allow = h1.querySelector('.allow');
        allow.click(); allow.click();
        await wait(60);
        out.doubleClickOnce = confirmed === 1 && calls('approve').length === 1 && calls('run').length === 1;
        out.tokenEnvelope = calls('run')[0] && calls('run')[0].value.approvalToken === 'one-use-test-token'
          && calls('run')[0].value.action.tool === 'proj_rm';

        window.__assistantStub.reset('deny');
        let denied = null;
        const h2 = host();
        renderAction(h2, {tool:'click',arg:'1,2'}, () => {}, (r) => { denied = r; });
        await wait(40);
        out.denyNoExecution = denied && denied.reason === 'permission-denied'
          && calls('approve').length === 0 && calls('run').length === 0;

        window.__assistantStub.reset('confirm');
        let rejected = null;
        const h3 = host();
        renderAction(h3, {tool:'web_click',arg:'#pay'}, () => {}, (r) => { rejected = r; });
        await wait(40);
        h3.querySelector('.deny').click();
        await wait(20);
        out.rejectRecorded = rejected && rejected.reason === 'user-rejected'
          && calls('approve').length === 0 && calls('run').length === 0
          && document.getElementById('msgs').textContent.includes('已拒绝该操作');

        window.__assistantStub.reset('allow');
        let allowed = 0;
        const h4 = host();
        renderAction(h4, {tool:'read_file',arg:'C:/safe.txt'}, () => { allowed++; }, () => {});
        await wait(40);
        out.allowRunsDirectly = allowed === 1 && calls('approve').length === 0;
        return out;
      })()`, true);
      check('full 权限也不能跳过 confirm', result.fullStillConfirms);
      check('允许按钮双击只审批并执行一次', result.doubleClickOnce);
      check('令牌只放进执行 envelope', result.tokenEnvelope);
      check('deny 不调用 approve/run', result.denyNoExecution);
      check('用户拒绝会记录并且不执行', result.rejectRecorded);
      check('allow 决策直接继续执行', result.allowRunsDirectly);
    } catch (error) {
      check('测试脚本无异常', false, (error && error.stack) || String(error));
    }
    const pass = checks.filter((x) => x.value).length;
    const result = { pass, fail: checks.length - pass, total: checks.length, checks };
    fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), 'utf8');
    console.log('=== action confirmation UI ===');
    for (const row of checks) console.log('  ' + (row.value ? '✅ ' : '❌ ') + row.label + (row.detail ? '  ' + row.detail : ''));
    console.log('\n通过 ' + pass + ' / ' + checks.length);
    app.exit(result.fail ? 1 : 0);
  });
});
