const fs=require('fs'),path=require('path');
const T=path.join(process.env.APPDATA,'dayu-pet-totest');
fs.mkdirSync(T,{recursive:true});
const {app}=require('electron');
app.setPath('userData',T);
app.whenReady().then(async()=>{
  await new Promise(r=>setTimeout(r,400));
  const A=require('../src/assistant');
  for (const [tool,arg] of [['windows_list',''],['template_list','']]) {
    try {
      const r = await A.run(tool, arg);
      console.log('  §B [' + tool + '] 正常跑通 ✓ → ' + String(r).replace(/\n/g,' ').slice(0, 90));
    } catch (e) { console.log('  §B [' + tool + '] 抛错: ' + String(e.message).slice(0,70)); }
  }
  setTimeout(()=>app.exit(0),200);
});
