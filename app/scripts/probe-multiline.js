/* 验证：带 || 的写入类 ACTION 必须保留换行（否则多行文件写不进去）
 * electron.exe app\scripts\probe-multiline.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const T = path.join(process.env.APPDATA, 'dayu-pet-mlprobe');
fs.mkdirSync(T, { recursive: true });
try { fs.copyFileSync(path.join(process.env.APPDATA, 'dayu-pet', 'config.json'), path.join(T, 'config.json')); } catch {}
app.setPath('userData', T);

app.whenReady().then(() => {
  const llm = require('../src/llm');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  let pass = 0, total = 0;
  const ck = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };
  try {
    const multi = 'EN: ok\nZH: 好\nACTION: write_file|C:\\x\\a.py||line1\nline2\nline3';
    const r1 = llm.parseReply(multi);
    L('=== 多行写入 ACTION ===');
    L('  解析出的 action = ' + JSON.stringify(r1.action));
    ck('识别为 write_file', r1.action && r1.action.tool === 'write_file', JSON.stringify(r1.action && r1.action.tool));
    ck('★ 参数里保留了换行（3 行都在）', r1.action && (r1.action.arg.match(/\n/g) || []).length === 2,
      JSON.stringify(r1.action && r1.action.arg));
    ck('内容和原文一致', r1.action && r1.action.arg === 'C:\\x\\a.py||line1\nline2\nline3',
      JSON.stringify(r1.action && r1.action.arg));
    ck('en/zh 没被污染', r1.en === 'ok' && r1.zh === '好', JSON.stringify({ en: r1.en, zh: r1.zh }));

    L('');
    L('=== 普通（不带 ||）ACTION 不能被吞掉后面的闲聊 ===');
    const r2 = llm.parseReply('EN: ok\nZH: 好\nACTION: click|100,200\n记得看看效果');
    ck('click 的参数只是 100,200', r2.action && r2.action.arg === '100,200', JSON.stringify(r2.action));
    ck('后面的闲聊仍算进 en 或忽略（不混进参数）', !/记得/.test(r2.action ? r2.action.arg : ''), JSON.stringify(r2.action));

    L('');
    L('=== proj_write 的 \\n 转义仍可用 ===');
    const r3 = llm.parseReply('EN: ok\nZH: 好\nACTION: proj_write|a.py||print(1)\\nprint(2)');
    ck('识别为 proj_write', r3.action && r3.action.tool === 'proj_write', JSON.stringify(r3.action));
    ck('参数里是字面 \\n（由 handler 还原）', r3.action && /\\n/.test(r3.action.arg), JSON.stringify(r3.action && r3.action.arg));

    L('');
    L('=== 回归：多行 ACTION 不能把 en 也吃掉 ===');
    const r4 = llm.parseReply('EN: hello there\nZH: 你好\nACTION: write_file|C:\\y\\b.txt||x\ny');
    ck('en 正常', r4.en === 'hello there', JSON.stringify(r4.en));
    ck('zh 正常', r4.zh === '你好', JSON.stringify(r4.zh));
    ck('action 正常', r4.action && r4.action.tool === 'write_file', JSON.stringify(r4.action && r4.action.tool));

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit(pass === total ? 0 : 1), 200);
});
