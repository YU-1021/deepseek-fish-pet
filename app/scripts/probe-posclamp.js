/* 验证「窗口位置夹取」：位置文件里的超界值必须被拉回屏幕内
 * electron.exe app\scripts\probe-posclamp.js
 *
 * 背景：用户实际遇到过 position.json = {"x":-107,...}，
 * 她的窗口有 107px 在屏幕左边外、立绘几乎看不见，而用户没法拖一个看不见的窗口。
 */
const path = require('path');
const fs = require('fs');
const { app, screen } = require('electron');
const REAL = path.join(process.env.APPDATA, 'dayu-pet');
const T = path.join(process.env.APPDATA, 'dayu-pet-posclamp');
fs.mkdirSync(T, { recursive: true });
try {
  fs.copyFileSync(path.join(REAL, 'config.json'), path.join(T, 'config.json'));
  fs.copyFileSync(path.join(REAL, 'persona.json'), path.join(T, 'persona.json'));
} catch {}
app.setPath('userData', T);

app.whenReady().then(() => {
  const M = require('../main.js');
  const out = [];
  const L = (s) => { out.push(s); try { process.stdout.write(s + '\n'); } catch {} };
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };
  try {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    L('  主显示器可用工作区: ' + wa.width + 'x' + wa.height + '（已去掉任务栏）');
    const f = M.posFile();
    L('  位置文件: ' + f);
    const cases = [
      [-107, 588, '用户实际遇到的：左边跑出屏幕'],
      [5000, 5000, '右下都超界'],
      [-9999, -9999, '左上都超界'],
      [400, 300, '正常值（不该被改）'],
      [0, 0, '边界 0,0'],
      [1300, 700, '正常偏右下'],
    ];
    for (const [x, y, why] of cases) {
      fs.writeFileSync(f, JSON.stringify({ x, y }));
      const r = M.loadPosition();
      const inArea = r && r.x >= 0 && r.x <= wa.width && r.y >= 0 && r.y <= wa.height;
      check('(' + x + ',' + y + ') → ' + (r ? r.x + ',' + r.y : 'null') + '  [' + why + ']', !!inArea,
        inArea ? (r.clampedFrom ? '已夹取（原 ' + r.clampedFrom.x + ',' + r.clampedFrom.y + '）' : '合理值，未改') : '❌ 仍在屏幕外');
    }
    fs.writeFileSync(f, JSON.stringify({ x: 400, y: 300 }));
    const r2 = M.loadPosition();
    check('正常位置不被篡改', r2.x === 400 && r2.y === 300, r2.x + ',' + r2.y);
    fs.writeFileSync(f, JSON.stringify({ x: -500, y: -500 }));
    M.loadPosition();
    const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
    check('夹取后的值写回了文件', saved.x >= 0 && saved.y >= 0, JSON.stringify(saved));
    for (const bad of ['{"x":"a","y":1}', '{}', 'null', 'nonsense']) {
      fs.writeFileSync(f, bad);
      let r = null, err = '';
      try { r = M.loadPosition(); } catch (e) { err = e.message; }
      check('脏数据 ' + bad + ' 不崩', !err, '返回 ' + JSON.stringify(r));
    }
    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    var crashed = String((e && e.stack) || e);
    L('ERROR: ' + crashed);
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 200);
});
