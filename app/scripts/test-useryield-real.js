/* 让位机制的**真实光标**验证（需要机器上没人碰鼠标）
 * 逻辑本身的确定性验证在 test-useryield.js（注入假光标）；这个文件测的是"真实光标那一层"。
 * electron.exe app\scripts\test-useryield-real.js
 */
const path = require('path');
const fs = require('fs');
const { app, screen } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-yieldtest');
fs.mkdirSync(TEST_UD, { recursive: true });
app.setPath('userData', TEST_UD);

app.whenReady().then(async () => {
  const userinput = require('../src/userinput');
  const input = require('../src/input');
  const { spawnSync } = require('child_process');
  const out = [];
  const L = (s) => out.push(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  const disp = screen.getPrimaryDisplay();
  const toModel = (p) => [Math.round(p.x / disp.size.width * 1280), Math.round(p.y / disp.size.height * 720)];
  /* "主人"的移动：直接调 exe 绕过 input.js 的落点登记，否则每次都算"她自己动的" */
  const rawMove = (mx, my) => { try { spawnSync(input.exePath(), ['move', (mx / 1280).toFixed(4), (my / 720).toFixed(4)], { timeout: 8000, windowsHide: true }); } catch {} };
  const orig = screen.getCursorScreenPoint();
  const CALM = 900;

  try {
    L('显示器 ' + disp.size.width + 'x' + disp.size.height + '  scale=' + disp.scaleFactor + '  光标原位 ' + orig.x + ',' + orig.y);
    userinput.setCursorSource(null);            // 用真实光标
    userinput.setParams({ enabled: true, calmMs: CALM, movePx: 6, pollMs: 40 });
    userinput.resetStats();
    userinput.start();
    await wait(250);

    /* 1. 静止 */
    L('');
    L('--- 1. 光标静止 ---');
    userinput.resetStats();
    await wait(300);
    check('静止时 userActive=false', userinput.isUserActive() === false, JSON.stringify(userinput.state().stats));

    /* 2. 她自己移（input.move 会登记落点）→ 不该算主人动的 */
    L('');
    L('--- 2. 她自己移过去（真实光标）---');
    const [mx, my] = toModel({ x: Math.min(disp.size.width - 80, orig.x + 90), y: Math.max(40, orig.y - 60) });
    input.move(mx, my);
    await wait(250);
    const s2 = userinput.state().stats;
    check('没被误判成主人动的', s2.userMoves === 0, 'userMoves=' + s2.userMoves + ' petMoves=' + s2.petMoves);
    check('userActive=false', userinput.isUserActive() === false);

    /* 3. 主人接管（rawMove 不登记）→ 立刻判定为活动，并一直等到松手 */
    L('');
    L('--- 3. 主人接管 → 让位 → 松手继续 ---');
    const cur = screen.getCursorScreenPoint();
    const [ux, uy] = toModel({ x: Math.min(disp.size.width - 60, cur.x + 140), y: Math.min(disp.size.height - 60, cur.y + 90) });
    rawMove(ux, uy);
    await wait(120);
    const active = userinput.isUserActive();
    check('userActive=true', active === true, JSON.stringify(userinput.state().stats));
    if (active) {
      const t0 = Date.now();
      const waited = await userinput.waitUntilFree(6000);
      const real = Date.now() - t0;
      check('等到松手才放行', waited >= CALM / 2 && real < 4000, ' waited=' + waited + 'ms real=' + real + 'ms');
      check('放行后 userActive=false', userinput.isUserActive() === false);
    } else {
      check('等到松手才放行', false, '（没判定成活动，跳过）');
    }

    /* 4. 持续动 → 等待被不断延长 */
    L('');
    L('--- 4. 主人持续动 → 她一直等 ---');
    const c2 = screen.getCursorScreenPoint();
    const [vx, vy] = toModel({ x: Math.min(disp.size.width - 140, c2.x + 60), y: c2.y });
    let stop = false;
    const mover = (async () => { for (let i = 0; i < 14 && !stop; i++) { rawMove(vx + i * 5, vy + i * 4); await wait(110); } })();
    await wait(150);
    const t1 = Date.now();
    const w2 = await userinput.waitUntilFree(8000);
    const real2 = Date.now() - t1;
    stop = true; await mover;
    check('持续动时等待被延长（>1s）', w2 > 1000, ' waited=' + w2 + 'ms real=' + real2 + 'ms');

    L('');
    L('  通过 ' + pass + ' / ' + total);
    L('  统计: ' + JSON.stringify(userinput.state().stats));
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  } finally {
    try { const [rx, ry] = toModel(orig); input.move(rx, ry); } catch {}
    userinput.stop();
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 300);
});
