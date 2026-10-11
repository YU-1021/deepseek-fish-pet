const path=require('path'),fs=require('fs');const{app}=require('electron');
const REAL=path.join(process.env.APPDATA,'dayu-pet'), T=path.join(process.env.APPDATA,'dayu-pet-cost2');
fs.mkdirSync(T,{recursive:true});
const c=JSON.parse(fs.readFileSync(path.join(REAL,'config.json'),'utf8'));
// 用真实默认（1920x1080）跑
fs.writeFileSync(path.join(T,'config.json'),JSON.stringify(c,null,2));
app.setPath('userData',T);
app.whenReady().then(async()=>{
  const out=[];const L=s=>{out.push(s);process.stdout.write(s+'\n');};
  try{
    const cfg=require('../src/config').load();
    const ss=require('../src/screenstream');
    const base=String(cfg.apiBase).replace(/\/+$/,'');
    L('  实际配置: '+cfg.screenCaptureWidth+'x'+cfg.screenCaptureHeight);
    const f=await ss.grabFrame();
    if(!f){L('  抓帧失败');}else{
      const kb=Math.round(Buffer.from(f.dataUrl.split(',')[1],'base64').length/1024);
      for(const d of ['low','high']){
        for(let i=0;i<2;i++){
          const t=Date.now();
          const body={model:cfg.visionModel||'deepseek-flash',temperature:0.2,thinking:{type:'disabled'},
            messages:[{role:'user',content:[{type:'text',text:'屏幕上是什么？一句话。'},{type:'image_url',image_url:{url:f.dataUrl,detail:d}}]}]};
          try{
            const r=await fetch(base+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.apiKey},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
            const j=await r.json(); const u=j.usage||{};
            L('  '+f.width+'x'+f.height+' ('+kb+'KB)  detail='+d+'  第'+(i+1)+'次: '+(Date.now()-t)+'ms  in='+u.prompt_tokens+' out='+u.completion_tokens);
          }catch(e){L('  '+d+' 错误 '+e.message.slice(0,50));}
        }
      }
    }
  }catch(e){L('ERROR: '+e.stack);}
  console.log(out.join('\n'));
  setTimeout(()=>app.exit(0),200);
});
