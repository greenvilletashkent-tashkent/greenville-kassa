'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
test('uncertain notification review is admin-only, audited and idempotent',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-telegram-review-'));fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({products:[],sales:[],customers:[],operations:{},telegramOutbox:[{id:'sale:x',status:'uncertain',type:'sale',createdAt:'2026-01-01T00:00:00Z',text:'Синтетическая продажа'}]}));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only',TELEGRAM_ENABLED:'0'};delete env.TELEGRAM_BOT_TOKEN;delete env.TELEGRAM_CHAT_ID;
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env,windowsHide:true,stdio:'ignore'}),base='http://127.0.0.1:'+port;
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert.ok(ready);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'admin',pass:'synthetic-only'})}).then(r=>r.json()),headers={authorization:'Bearer '+login.token};
  const staff=(await fetch(base+'/api/staff',{headers}).then(r=>r.json())).staff;staff.push({id:'cashier',login:'cashier',name:'Тест',role:'cashier',active:true,pass:login.serverHash});assert.equal((await fetch(base+'/api/staff',{method:'PUT',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({staff})})).status,200);
  const cashier=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'cashier',pass:'synthetic-only'})}).then(r=>r.json());
  assert.equal((await fetch(base+'/api/experimental/telegram-review',{headers:{authorization:'Bearer '+cashier.token}})).status,403);
  const list=await fetch(base+'/api/experimental/telegram-review',{headers}).then(r=>r.json());assert.equal(list.notifications.length,1);assert.equal(list.notifications[0].text,'Синтетическая продажа');
  const body={id:'sale:x',decision:'delivered',decisionId:crypto.randomUUID()},post=()=>fetch(base+'/api/experimental/telegram-review',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  assert.equal((await post()).duplicate,false);assert.equal((await post()).duplicate,true);const d=JSON.parse(fs.readFileSync(path.join(dir,'db.json')));assert.equal(d.telegramOutbox[0].status,'sent');assert.equal(d.telegramOutbox[0].reviewHistory.length,1);
 }finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
});
