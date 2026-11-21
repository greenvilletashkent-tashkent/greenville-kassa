'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
test('admin direct test performs one request with no database writes',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-single-test-')),capture=path.join(dir,'transport.jsonl');fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({products:[],sales:[],customers:[],operations:{}}));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only',TELEGRAM_BOT_TOKEN:'not-a-real-token',TELEGRAM_CHAT_ID:'-1',TELEGRAM_ENABLED:'0',TELEGRAM_TEST_DIRECT:'1',TELEGRAM_TEST_CAPTURE:capture};
 const proc=spawn(process.execPath,['--require',path.join(__dirname,'telegram_fetch_stub.js'),'server.js'],{cwd:path.join(__dirname,'..'),env,windowsHide:true,stdio:'ignore'}),base='http://127.0.0.1:'+port;
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert.ok(ready);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'admin',pass:'synthetic-only'})}).then(r=>r.json()),headers={authorization:'Bearer '+login.token,'content-type':'application/json'};
  const staff=(await fetch(base+'/api/staff',{headers}).then(r=>r.json())).staff;staff.push({id:'c',login:'cashier',name:'Тест',role:'cashier',active:true,pass:login.serverHash});assert.equal((await fetch(base+'/api/staff',{method:'PUT',headers,body:JSON.stringify({staff})})).status,200);
  const cashier=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'cashier',pass:'synthetic-only'})}).then(r=>r.json());
  const payload={confirm:true,operationId:crypto.randomUUID()},send=h=>fetch(base+'/api/experimental/telegram-test',{method:'POST',headers:h,body:JSON.stringify(payload)});
  assert.equal((await send({'content-type':'application/json'})).status,401);assert.equal((await send({'content-type':'application/json',authorization:'Bearer '+cashier.token})).status,403);
  const dbBefore=fs.readFileSync(path.join(dir,'db.json')),staffBefore=fs.readFileSync(path.join(dir,'staff.json'));
  const [a,b]=await Promise.all([send(headers),send(headers)]);assert.deepEqual((await a.json()).status,'delivered');assert.deepEqual((await b.json()).status,'delivered');
  const second=await fetch(base+'/api/experimental/telegram-test',{method:'POST',headers,body:JSON.stringify({confirm:true,operationId:crypto.randomUUID()})});assert.equal(second.status,409);
  const messages=fs.readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse);assert.equal(messages.length,1);assert.equal(messages[0].text,'✅ GREENVILLE Kassa — Telegram подключён. Тестовое сообщение, не является продажей');
  assert.deepEqual(fs.readFileSync(path.join(dir,'db.json')),dbBefore);assert.deepEqual(fs.readFileSync(path.join(dir,'staff.json')),staffBefore);
 }finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
});
