/* 工具可用性实机核查（独立 userData）
 *   ① 静态：TOOL_TIER 里每个工具是否都能过 runInner 的"未知操作"闸门；
 *   ② 点出"还在老表、没并进注册表"的那几个（回落仍然能用，但没被统一声明）；
 *   ③ 实机：调一批**安全**工具（读/看/列），确认它们真的返回内容而不是"未知操作"。
 * 跑法：electron app/scripts/probe-toolhealth.js
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const T = path.join(process.env.APPDATA, 'dayu-pet-toolhealth');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
app.setPath('userData', T);

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 400));
  const A = require('../src/assistant');
  const REG = require('../src/registry');
  const TO = require('../src/timeout');

  const tier = A.TOOL_TIER || {};
  const names = Object.keys(tier).sort();
  const reg = REG.withTools();

  /* ① 闸门检查：每个工具都要能被认出来（这是 runInner 里那一行的同一个判定） */
  const unknown = names.filter((t) => !reg.get('tool', t) && !tier[t]);
  console.log('  §A TOOL_TIER 里 ' + names.length + ' 个工具，过不了闸门的: ' + (unknown.length ? unknown.join(', ') : '（无）✅'));

  /* ② 没并进注册表的（回落仍可用，但没统一声明） */
  const notInReg = names.filter((t) => !reg.get('tool', t));
  console.log('  §B 还没并进注册表的 ' + notInReg.length + ' 个: ' + (notInReg.length ? notInReg.join(', ') : '（无）'));
  if (notInReg.length) {
    console.log('      它们仍然可用（闸门与权限判定都有回落），只是超时/参数声明还没统一。');
  }

  /* ③ 一个工具都没有超时/权限档的缺失 */
  const noTimeout = names.filter((t) => !Number.isFinite(TO.timeoutFor(t)));
  console.log('  §C 没有超时的: ' + (noTimeout.length ? noTimeout.join(', ') : '（无）✅'));

  /* ④ 实机调用一批安全工具 */
  const projPath = path.join(T, 'sample.txt');
  fs.writeFileSync(projPath, '这是给工具健康检查用的样例文件\n', 'utf8');
  const calls = [
    ['windows_list', ''],
    ['template_list', ''],
    ['flow_list', ''],
    ['list_dir', T],
    ['read_file', projPath],
    ['screen_shot', ''],
    ['find_text', '样例'],
    ['skill_ls', ''],
  ];
  let bad = 0;
  for (const [tool, arg] of calls) {
    let out;
    try { out = await A.run(tool, arg); } catch (e) { out = 'ERR: ' + e.message; }
    const s = String(out === undefined ? '(undefined)' : (typeof out === 'object' ? JSON.stringify(out).slice(0, 60) : out)).replace(/\n/g, ' ');
    const isUnknown = /未知操作/.test(s);
    const isMissing = /^\s*$/.test(s) || s === '(undefined)';
    if (isUnknown || isMissing) bad++;
    console.log('  §D [' + tool.padEnd(14) + '] ' + (isUnknown ? '❌ 未知操作' : isMissing ? '❌ 空返回' : '✅ ') + s.slice(0, 62));
  }

  console.log('  === 结论: ' + (unknown.length === 0 && bad === 0 ? '工具全部可用，没丢 ✅' : '有问题，见上面 ❌') + ' ===');
  setTimeout(() => app.exit(unknown.length === 0 && bad === 0 ? 0 : 1), 200);
});
