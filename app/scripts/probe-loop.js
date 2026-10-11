const fs=require('fs'),path=require('path');
const T=path.join(process.env.APPDATA,'dayu-pet-looptest2');
fs.rmSync(T,{recursive:true,force:true}); fs.mkdirSync(T,{recursive:true});
const {app}=require('electron');
app.setPath('userData',T);
app.whenReady().then(async()=>{
  await new Promise(r=>setTimeout(r,500));
  const testlog=require('../src/testlog');
  testlog.log('loop','stop',{reason:'look-streak',ok:false});
  testlog.log('loop','stop',{reason:'completed',ok:true});
  const f=testlog.logFile();
  const lines=fs.readFileSync(f,'utf8').split('\n').filter(Boolean);
  console.log('  §A 写了两条，文件里 ' + lines.length + ' 条');
  const last=JSON.parse(lines[lines.length-1]);
  console.log('  §B 字段正确: mod=' + last.mod + '  ev=' + last.ev + '  reason=' + (last.d&&last.d.reason));
  console.log('  §C 没有垃圾字段: ' + (String(last.mod)!=='[object Object]' ? '✓' : '✗'));
  setTimeout(()=>app.exit(0),200);
});
