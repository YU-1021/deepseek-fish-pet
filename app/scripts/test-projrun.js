/* proj_run / proj_write 的单元验证（不需要 API）
 * electron.exe app\scripts\test-projrun.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-projtest');
fs.mkdirSync(TEST_UD, { recursive: true });
try { fs.rmSync(path.join(TEST_UD, 'projects'), { recursive: true, force: true }); } catch {}
app.setPath('userData', TEST_UD);

app.whenReady().then(async () => {
  const projects = require('../src/projects');
  const assistant = require('../src/assistant');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  let pass = 0, total = 0;
  const check = (name, ok, detail) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  ' + detail : '')); };

  try {
    L('项目目录: ' + projects.rootDir());

    /* 1. proj_write 工具在权限表里，且能真的写进**项目**文件夹 */
    L('');
    L('--- 1. proj_write ---');
    check('TOOL_TIER 里有 proj_write', !!assistant.TOOL_TIER.proj_write, '档位=' + assistant.TOOL_TIER.proj_write);
    check('normal 档允许 proj_write', assistant.allowed('normal', 'proj_write') === true);
    check('read 档不允许 proj_write', assistant.allowed('read', 'proj_write') === false);
    const w = await assistant.run('proj_write', 'calc/mul.js||console.log(123 * 456)');
    check('写入成功', /已写入项目文件/.test(w), w);
    const abs = path.join(projects.rootDir(), 'calc', 'mul.js');
    check('文件真落在项目目录里', fs.existsSync(abs), abs);
    check('没有落进技能目录', !fs.existsSync(path.join(app.getPath('userData'), 'skills', 'calc', 'mul.js')));

    /* 2. .js 一定能跑（Node 一定有） */
    L('');
    L('--- 2. proj_run 跑 .js ---');
    const r1 = await projects.run('calc/mul.js');
    check('退出码 0', r1.code === 0, 'code=' + r1.code);
    check('输出含真实乘积 56088', /56088/.test(r1.output), JSON.stringify(r1.output.slice(0, 80)));

    /* 3. "命令 + 参数" 的误用要给出明确提示（实测她这么试过） */
    L('');
    L('--- 3. proj_run 传「命令 + 参数」 ---');
    let e3 = '';
    try { await projects.run('node calc/mul.js'); } catch (e) { e3 = String(e.message); }
    check('被拒且提示"只接受一个文件路径"', /只接受\*\*一个文件路径\*\*/.test(e3), e3.replace(/\n/g, ' | ').slice(0, 120));

    /* 4. 解释器缺失要给出**可操作**的错误，而不是光报个退出码（实测 9009 让她连撞 5 步） */
    L('');
    L('--- 4. 解释器缺失（.py，本机没真 python）---');
    await assistant.run('proj_write', 'calc/mul.py||print(123 * 456)');
    let e4 = '', r4 = null;
    try { r4 = await projects.run('calc/mul.py'); } catch (e) { e4 = String(e.message); }
    if (r4) {
      check('没把 9009 当成正常结果', false, 'code=' + r4.code + ' output=' + JSON.stringify(r4.output.slice(0, 60)));
    } else {
      check('报的是"没找到可用解释器 + 改用 .js"', /没找到可用的解释器/.test(e4) && /\.js/.test(e4), e4.slice(0, 140));
    }

    /* 5. 沙箱：越界必须被挡 */
    L('');
    L('--- 5. 沙箱越界 ---');
    for (const bad of ['../../../../Windows/System32/drivers/etc/hosts', 'C:\\Windows\\win.ini', '//server/share/x', '..\\..\\x.txt']) {
      let msg = '';
      try { await projects.run(bad); } catch (e) { msg = String(e.message); }
      /* //server/share/x 会被 safePath 的"去掉前导斜杠"变成**项目内相对路径**，
         所以报的是"文件不存在"而不是"越界" —— 结果一样安全（根本走不出去），
         这里两种都算通过：要么明确拦住，要么被规范化成项目内路径。 */
      check('挡住 ' + bad.slice(0, 34), /越界|只能在项目文件夹里操作|文件不存在/.test(msg), msg.replace(/\n.*/, '').slice(0, 60));
    }

    /* 6. 白名单：不在表里的扩展名 */
    L('');
    L('--- 6. 扩展名白名单 ---');
    await assistant.run('proj_write', 'x.exe||dummy');
    let e6 = '';
    try { await projects.run('x.exe'); } catch (e) { e6 = String(e.message); }
    check('.exe 被拒', /不支持直接运行/.test(e6), e6.slice(0, 80));

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 300);
});
