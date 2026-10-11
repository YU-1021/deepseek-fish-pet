const fs=require('fs'),path=require('path');
const T=path.join(process.env.APPDATA,'dayu-pet-reptest');
fs.mkdirSync(T,{recursive:true});
const {app}=require('electron');
app.setPath('userData',T);
app.whenReady().then(async()=>{
  await new Promise(r=>setTimeout(r,400));
  const A=require('../src/assistant');
  const W=(t,a)=>A.__repeatNote(t,a);
  console.log('  §A 查询类工具（windows_list）不参与计数: ' + JSON.stringify(W('windows_list','')));
  const r1=W('click','100,200'), r2=W('click','100,200'), r3=W('click','100,200');
  console.log('  §B click 第1/2/3 次: ' + [r1.count,r2.count,r3.count].join('/') + '  第3次有提醒=' + (!!r3.advice));
  const r4=W('click','150,200');
  console.log('  §C 换坐标 → 新动作 count=' + r4.count + '（应为 1）');
  A.__repeatReset();
  console.log('  §D reset 后 count=' + W('click','100,200').count + '（应为 1）');
  console.log('  §E 状态: ' + JSON.stringify(A.__repeatState().size) + ' 条记录');
  setTimeout(()=>app.exit(0),200);
});
