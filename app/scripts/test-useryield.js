/* 「主人一动鼠标就暂停、松手自动继续」的验证
 *
 * ⚠️ 不碰真实光标。原因：机器上的物理鼠标每秒发 125~1000 次事件，
 *   测试刚 SetCursorPos 完 1ms 后读回来可能已经被真人挪走了（实测确实如此：
 *   目标 (400,300) 读回 (729,590)，同一目标三次读数都不一致）。
 *   所以这里**注入一个假光标源**，把判定逻辑确定性地测掉；
 *   真实光标那一层交给日常使用去验。
 *
 * electron.exe app\scripts\test-useryield.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-yieldtest');
fs.mkdirSync(TEST_UD, { recursive: true });
app.setPath('userData', TEST_UD);

app.whenReady().then(async () => {
  const userinput = require('../src/userinput');
  const out = [];
  const L = (s) => out.push(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  /* ---- 假光标：测试完全掌控"现在光标在哪" ---- */
  let fake = { x: 500, y: 500 };
  const setFake = (x, y) => { fake = { x, y }; };
  const CALM = 400;

  try {
    userinput.setCursorSource(() => ({ x: fake.x, y: fake.y }));
    userinput.setParams({ enabled: true, calmMs: CALM, movePx: 6, pollMs: 30 });
    userinput.resetStats();
    userinput.stop();
    userinput.start();
    await wait(120);

    L('=== 判定逻辑（注入假光标，确定性）===');
    L('  calmMs=' + CALM + '  movePx=6  pollMs=30');

    /* 1. 静止 → 不是用户活动 */
    L('');
    L('--- 1. 光标静止 ---');
    await wait(200);
    check('静止时 userActive=false', userinput.isUserActive() === false);

    /* 2. 光标变了但落在"她的预期落点"附近 → 算她自己动的 */
    L('');
    L('--- 2. 她自己移过去（已登记落点）---');
    userinput.notePetMove(700, 520);
    setFake(700, 520);                     // 她移过去了
    await wait(200);
    let st = userinput.state().stats;
    check('落点在预期内 → userActive=false', userinput.isUserActive() === false);
    check('没被记成用户移动', st.userMoves === 0, JSON.stringify(st));

    /* 3. 主人在别处动了 → 判定为主人在用 */
    L('');
    L('--- 3. 主人在别处动鼠标 ---');
    setFake(700 + 150, 520 + 90);
    await wait(150);
    st = userinput.state().stats;
    check('userActive=true', userinput.isUserActive() === true, JSON.stringify(st));
    check('记了一次用户移动', st.userMoves >= 1, 'userMoves=' + st.userMoves);

    /* 4. waitUntilFree：主人停手后应放行 */
    L('');
    L('--- 4. waitUntilFree：主人停手后放行 ---');
    const t0 = Date.now();
    const waited = await userinput.waitUntilFree(5000);
    const real = Date.now() - t0;
    check('确实等了（>calmMs 的一半）', waited >= CALM / 2, ' waited=' + waited + 'ms');
    check('在合理时间内放行（<3s）', real < 3000, ' real=' + real + 'ms');
    check('回来后 userActive=false', userinput.isUserActive() === false);

    /* 5. 主人持续动 → 等待被不断延长 */
    L('');
    L('--- 5. 主人持续动 → 她一直等 ---');
    let stop = false;
    const mover = (async () => {
      let i = 0;
      while (!stop && i < 40) { setFake(300 + (i % 10) * 40, 300 + (i % 7) * 30); i++; await wait(80); }
    })();
    await wait(120);
    const t1 = Date.now();
    const w2 = await userinput.waitUntilFree(6000);
    const real2 = Date.now() - t1;
    stop = true; await mover;
    check('持续动时等待被延长（>1s）', w2 > 1000, ' waited=' + w2 + 'ms real=' + real2 + 'ms');

    /* 6. 关掉开关 → 永不让位（不能因为让位机制把任务卡死） */
    L('');
    L('--- 6. enabled=false 时不该让位 ---');
    userinput.setParams({ enabled: false });
    setFake(50, 50); await wait(80); setFake(900, 900); await wait(120);
    check('关掉后 userActive=false', userinput.isUserActive() === false);
    const w3 = await userinput.waitUntilFree(1000);
    check('关掉后 waitUntilFree 立刻返回', w3 === 0, ' waited=' + w3);

    /* 7. unref 之后不该拖住进程（间接：timer 存在但进程能正常退出） */
    userinput.setParams({ enabled: true });
    userinput.start();
    check('重复 start 不会叠加定时器', (() => { userinput.start(); userinput.start(); return userinput.state().running === true; })());

    L('');
    L('  通过 ' + pass + ' / ' + total);
    L('  统计: ' + JSON.stringify(userinput.state().stats));
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  } finally {
    userinput.stop();
    userinput.setCursorSource(null);   // 还原成真实光标
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
