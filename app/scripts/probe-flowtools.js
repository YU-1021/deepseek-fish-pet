const fs=require('fs'),path=require('path');
const T=path.join(process.env.APPDATA,'dayu-pet-regtest3');
fs.rmSync(T,{recursive:true,force:true}); fs.mkdirSync(T,{recursive:true});
const {app}=require('electron');
app.setPath('userData',T);
app.whenReady().then(async()=>{
  await new Promise(r=>setTimeout(r,400));
  const A=require('../src/assistant');
  for (const [tool,arg] of [['flow_list',''],['windows_list',''],['template_list',''],['flow_del','不存在的']]) {
    try { const r = await A.run(tool, arg); console.log('  § [' + tool + '] → ' + String(r).replace(/\n/g,' ').slice(0,80)); }
    catch(e){ console.log('  § [' + tool + '] ❌ ' + e.message); }
  }
  /* 存一个流程再列出来 —— 走完整链路 */
  const f={title:'测试流程',steps:[{action:'click',target:{text:'确认'},wait:{ms:10},note:'点确认'}]};
  try { const r=await A.run('flow_save','冒烟-流程||'+JSON.stringify(f)); console.log('  § [flow_save] → ' + String(r).slice(0,90)); } catch(e){ console.log('  § [flow_save] ❌ '+e.message); }
  try { const r=await A.run('flow_list',''); console.log('  § [flow_list] → ' + String(r).replace(/\n/g,' ').slice(0,100)); } catch(e){ console.log('  § [flow_list] ❌ '+e.message); }
  /* 干跑（屏幕上没有"确认"就该如实说卡在第 1 步） */
  try { const r=await A.run('flow_run','冒烟-流程|dry'); console.log('  § [flow_run dry] → ' + String(r).replace(/\n/g,' ').slice(0,150)); } catch(e){ console.log('  § [flow_run] ❌ '+e.message); }
  setTimeout(()=>app.exit(0),200);
});
