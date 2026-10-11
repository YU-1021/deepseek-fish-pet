const fs=require('fs'),path=require('path');
const T=path.join(process.env.APPDATA,'dayu-pet-permtest');
fs.mkdirSync(T,{recursive:true});
const {app}=require('electron');
app.setPath('userData',T);
app.whenReady().then(async()=>{
  await new Promise(r=>setTimeout(r,400));
  const A=require('../src/assistant');
  const cases=[
    ['full','screen_look',true],['normal','screen_look',false],['read','screen_look',false],
    ['full','find_template',true],['read','find_template',false],
    ['read','read_file',true],['full','read_file',true],
    ['full','click',true],['normal','click',false],
    ['off','game_stop',true],['off','game_status',true],
    ['web','web_open',true],['read','web_open',false],
    ['normal','proj_write',true],['read','proj_write',false],
    ['full','windows_list',true],['read','windows_list',false],
    ['full','flow_run',true],['read','flow_run',false],['read','flow_list',true],
  ];
  let bad=0;
  for (const [tier,tool,want] of cases) {
    const got=A.allowed(tier,tool);
    const okk = got===want;
    if(!okk) bad++;
    console.log('  ' + (okk?'✅':'❌') + ' allowed(' + tier.padEnd(6) + ', ' + tool.padEnd(16) + ') = ' + String(got).padEnd(5) + ' 期望 ' + want);
  }
  console.log('  === 权限判定: ' + (bad?('❌ ' + bad + ' 条不符'):'全部符合老语义 ✅') + ' ===');
  setTimeout(()=>app.exit(bad?1:0),200);
});
