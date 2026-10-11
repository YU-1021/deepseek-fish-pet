const path=require('path'),fs=require('fs');const{app}=require('electron');
const T=path.join(process.env.APPDATA,'dayu-pet-keyalias');fs.mkdirSync(T,{recursive:true});
app.setPath('userData',T);
app.whenReady().then(()=>{
  const input=require('../src/input');
  const out=[];const L=s=>{out.push(s);process.stdout.write(s+'\n');};
  let pass=0,total=0;
  const ck=(n,ok,d)=>{total++;if(ok)pass++;L((ok?'  ✅ ':'  ❌ ')+n+(d?'  '+d:''));};
  try{
    L('=== 她实际踩到的那个：ctrl+plus / ctrl+equal ===');
    ck('ctrl+plus 现在能通过', input.validateKey('ctrl+plus')==='ctrl+shift+equal', input.validateKey('ctrl+plus'));
    ck('ctrl+equal 通过', input.validateKey('ctrl+equal')==='ctrl+equal', input.validateKey('ctrl+equal'));
    ck('★ ctrl+plus 真的按得下去（能 spawn 且退出码 0）', (()=>{ try{ input.key('ctrl+plus'); return true; }catch(e){ L('     '+e.message); return false; } })());
    L('');
    L('=== 各种符号写法 ===');
    for(const [k,want] of [['plus','shift+equal'],['+','shift+equal'],['minus','minus'],['-','minus'],
      ['equal','equal'],['=','equal'],['comma','comma'],[',','comma'],['period','period'],['.','period'],
      ['slash','slash'],['/','slash'],['backslash','backslash'],['semicolon','semicolon'],['quote','quote'],
      ['bracketleft','bracketleft'],['[' ,'bracketleft'],['bracketright','bracketright'],[']','bracketright'],
      ['add','add'],['subtract','subtract'],['underscore','shift+minus'],['_','shift+minus'],
      ['question','shift+slash'],['?','shift+slash'],['tilde','shift+backtick'],['~','shift+backtick']]) {
      let got=''; try{ got=input.validateKey(k); }catch(e){ got='ERR '+e.message.slice(0,30); }
      ck("validateKey('"+k+"') → "+want, got===want, got===want?'':('得到 '+got));
    }
    L('');
    L('=== 以前会被静默按错键的单字符符号（现在映射到正确 VK）===');
    for(const k of [',','.','/',';','-','=','[',']','+','?','~']){
      let ok=true,got=''; try{ got=input.validateKey(k); }catch(e){ ok=false; got=e.message.slice(0,40); }
      ck("'"+k+"' 可用", ok, got);
    }
    L('');
    L('=== 坏键名仍然被拒（安全底线）===');
    for(const b of ['ctrl+', '+c', 'ctrl++c', 'ctrl+cmd', 'foobar', '', null, 'ctrl+不存在']){
      let err=''; try{ input.validateKey(b); }catch(e){ err=e.message; }
      ck('拒绝 '+JSON.stringify(String(b)).slice(0,18), !!err, err.slice(0,45));
    }
    L('');
    L('  通过 '+pass+' / '+total);
  }catch(e){ L('ERROR: '+e.stack); }
  console.log(out.join('\n'));
  setTimeout(()=>app.exit(pass===total?0:1),200);
});
