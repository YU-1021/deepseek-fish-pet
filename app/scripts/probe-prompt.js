const { app } = require('electron');
const path = require('path'); const fs = require('fs');
const T = path.join(process.env.APPDATA, 'dayu-pet-promptcheck');
fs.mkdirSync(T, { recursive: true });
try { fs.copyFileSync(path.join(process.env.APPDATA,'dayu-pet','config.json'), path.join(T,'config.json')); } catch {}
app.setPath('userData', T);
app.whenReady().then(() => {
  const M = require('../main.js');
  const out = [];
  const sys = M.buildSystemPrompt(M.config.load());
  for (const ln of sys.split('\n')) {
    if (/坐标|CAPW|CAPH|截图/.test(ln)) out.push('  [首轮] ' + ln.slice(0, 190));
  }
  const cont = M.buildContinuePrompt(M.config.load());
  for (const ln of cont.split('\n')) if (/坐标|CAPW|CAPH/.test(ln)) out.push('  [续跑] ' + ln.slice(0, 190));
  console.log(out.join('\n'));
  setTimeout(() => app.exit(0), 200);
});
