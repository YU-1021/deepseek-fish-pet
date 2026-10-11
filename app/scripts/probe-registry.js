const fs=require('fs'),path=require('path');
const T=path.join(process.env.APPDATA,'dayu-pet-regtest');
fs.rmSync(T,{recursive:true,force:true}); fs.mkdirSync(T,{recursive:true});
const {app}=require('electron');
app.setPath('userData',T);
app.whenReady().then(async()=>{
  await new Promise(r=>setTimeout(r,400));
  const A=require('../src/assistant');
  const TO=require('../src/timeout');
  const R=require('../src/registry').withTools();
  console.log('  §A 注册表工具数: ' + R.list('tool').length + '（TOOL_DEFS ' + require('../src/registry').TOOL_DEFS.length + '）');
  /* ★ 一致性：注册表的 timeoutMs 必须和 timeout.js 的结果一致（防两张表漂移） */
  let drift=[];
  for (const d of R.list('tool')) { if (TO.timeoutFor(d.name) !== d.timeoutMs) drift.push(d.name + ':' + TO.timeoutFor(d.name) + '≠' + d.timeoutMs); }
  console.log('  §B ★注册表与超时表一致: ' + (drift.length===0 ? '✅ 无漂移' : '❌ ' + drift.join(', ')));
  /* §C 权限档一致性 */
  const ti=require('../src/assistant');
  let pdrift=[];
  for (const d of R.list('tool')) { if (!R.get('tool',d.name).tier) pdrift.push(d.name); }
  console.log('  §C 每个工具都有权限档: ' + (pdrift.length===0?'✅':'❌ '+pdrift.join(',')));
  /* §D 实际调用：无参工具 + 有参工具 */
  for (const [tool,arg] of [['windows_list',''],['template_list',''],['flow_list',''],['template_list','']]) {
    try { const r = await A.run(tool, arg); console.log('  §D [' + tool + '] → ' + String(r).replace(/\n/g,' ').slice(0,55)); }
    catch(e){ console.log('  §D [' + tool + '] ❌ ' + e.message); }
  }
  /* §E 权限判定仍按档位生效 */
  console.log('  §E allowed(read, read_file)=' + A.allowed('read','read_file') + '（应 true）');
  console.log('  §E allowed(read, click)=' + A.allowed('read','click') + '（应 false）');
  console.log('  §E allowed(full, click)=' + A.allowed('full','click') + '（应 true）');
  console.log('  §E allowed(off, game_stop)=' + A.allowed('off','game_stop') + '（应 true：永远允许停手）');
  setTimeout(()=>app.exit(drift.length? 1:0),200);
});
