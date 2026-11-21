'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
test('isolated server commits one notification with sale, expense and debt repayment',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-telegram-')),capture=path.join(dir,'transport.jsonl');
 fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({products:[{id:'p',name:'Тест',stock:10,cost:50}],sales:[],customers:[{id:'c',name:'Тест',visits:0,spent:0,bonus:0}],operations:{},counter:1001,bonusPct:0,cashRegister:{openingBalance:1000,openedAt:'2026-01-01T00:00:00Z'}}));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const start=()=>spawn(process.execPath,['--require',path.join(__dirname,'telegram_fetch_stub.js'),'server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only',TELEGRAM_BOT_TOKEN:'not-a-real-token',TELEGRAM_CHAT_ID:'synthetic-only',TELEGRAM_ENABLED:'1',TELEGRAM_TEST_CAPTURE:capture},windowsHide:true,stdio:'ignore'});let proc=start();const base='http://127.0.0.1:'+port;
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert.ok(ready);
  const post=async(p,body,token)=>{const r=await fetch(base+p,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const auth=(await post('/api/login',{login:'admin',pass:'synthetic-only'})).data;
  const sale={operationId:crypto.randomUUID(),cashierId:auth.id,customerId:'c',items:[{productId:'p',quantity:1,price:300}],discount:0,total:300,payments:{cash:100,terminal:150,debt:50}};
  const first=await post('/api/experimental/receipt',{receipt:sale},auth.token),retry=await post('/api/experimental/receipt',{receipt:sale},auth.token);assert.equal(first.status,200);assert.equal(retry.data.duplicate,true);
  const debt={operationId:crypto.randomUUID(),cashierId:auth.id,saleId:first.data.saleId,method:'cash',amount:50};assert.equal((await post('/api/experimental/debt-payment',{receipt:debt},auth.token)).status,200);
  const expense={operationId:crypto.randomUUID(),cashierId:auth.id,action:'create',amount:10,purpose:'Тест'};assert.equal((await post('/api/experimental/expense',{receipt:expense},auth.token)).status,200);
  const data=JSON.parse(fs.readFileSync(path.join(dir,'db.json'))),queue=data.telegramOutbox;
  assert.ok(!JSON.stringify(data).includes('not-a-real-token'));
  assert.equal(queue.filter(x=>x.eventId==='sale:'+sale.operationId).length,1);assert.equal(queue.filter(x=>x.eventId==='debt_payment:'+debt.operationId).length,1);assert.equal(queue.filter(x=>x.eventId==='expense:'+expense.operationId).length,1);assert.equal(data.products[0].stock,9);
  assert.ok(queue.find(x=>x.eventId==='sale:'+sale.operationId).text.includes('Новый долг: 50 сум'));
  proc.kill();await new Promise(r=>proc.once('exit',r));proc=start();
  let sent=false;for(let i=0;i<350;i++){const latest=JSON.parse(fs.readFileSync(path.join(dir,'db.json')));if(latest.telegramOutbox.find(x=>x.eventId==='sale:'+sale.operationId)?.status==='sent'){sent=true;break}await new Promise(r=>setTimeout(r,100));}assert.ok(sent,'sale notification not delivered after restart');
  const messages=fs.readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse);assert.equal(messages.filter(x=>x.text.includes('Продажа №'+first.data.saleId)).length,1);
 }finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
});
test('polling serves allowlisted owner only in private chat without external requests',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-telegram-owner-')),capture=path.join(dir,'transport.jsonl');fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({products:[],sales:[],customers:[],operations:{},counter:1001,bonusPct:0}));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const updates=[{update_id:1,message:{from:{id:123},chat:{id:123,type:'private'},text:'Сегодня'}},{update_id:2,message:{from:{id:999},chat:{id:999,type:'private'},text:'Сегодня'}},{update_id:3,message:{from:{id:123},chat:{id:-123,type:'group'},text:'Сегодня'}}];
 const proc=spawn(process.execPath,['--require',path.join(__dirname,'telegram_fetch_stub.js'),'server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only',TELEGRAM_BOT_TOKEN:'not-a-real-token',TELEGRAM_CHAT_ID:'-99',TELEGRAM_ENABLED:'1',TELEGRAM_OWNER_IDS:'123',TELEGRAM_TEST_CAPTURE:capture,TELEGRAM_TEST_UPDATES:JSON.stringify(updates)},windowsHide:true,stdio:'ignore'});
 try{
  let found=false;for(let i=0;i<350;i++){const d=JSON.parse(fs.readFileSync(path.join(dir,'db.json')));if(d.telegramUpdateOffset===4){assert.ok(d.telegramOutbox.some(e=>e.eventId==='telegram_update:1'&&e.destination==='123'));assert.ok(!d.telegramOutbox.some(e=>['telegram_update:2','telegram_update:3'].includes(e.eventId)));found=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(found);
 }finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
});
test('Telegram remains disabled by default even when configuration values exist',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-telegram-off-')),capture=path.join(dir,'transport.jsonl');fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({products:[],sales:[],customers:[],operations:{},counter:1001,bonusPct:0}));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only',TELEGRAM_BOT_TOKEN:'not-a-real-token',TELEGRAM_CHAT_ID:'synthetic',TELEGRAM_TEST_CAPTURE:capture};delete env.TELEGRAM_ENABLED;
 const proc=spawn(process.execPath,['--require',path.join(__dirname,'telegram_fetch_stub.js'),'server.js'],{cwd:path.join(__dirname,'..'),env,windowsHide:true,stdio:'ignore'}),base='http://127.0.0.1:'+port;
 try{let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert.ok(ready);await new Promise(r=>setTimeout(r,100));const db=JSON.parse(fs.readFileSync(path.join(dir,'db.json')));assert.equal(db.telegramOutbox,undefined);assert.equal(fs.existsSync(capture),false);}
 finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
});
test('private reports run alone without sending pending group notifications',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-private-only-')),capture=path.join(dir,'transport.jsonl');
 const seed={products:[],sales:[],customers:[],operations:{},counter:1001,bonusPct:0,telegramOutbox:[{id:'sale:old',type:'sale',text:'Групповая продажа',status:'pending',attempts:0}]};fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify(seed));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const updates=[{update_id:1,message:{from:{id:6718939119},chat:{id:6718939119,type:'private'},text:'/start'}},{update_id:2,message:{from:{id:999},chat:{id:999,type:'private'},text:'Сегодня'}},{update_id:3,message:{from:{id:6718939119},chat:{id:-5394232914,type:'group'},text:'Сегодня'}}];
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only',TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'-5394232914',TELEGRAM_ENABLED:'0',TELEGRAM_REPORTS_ENABLED:'1',TELEGRAM_OWNER_IDS:'6718939119',TELEGRAM_TEST_CAPTURE:capture,TELEGRAM_TEST_UPDATES:JSON.stringify(updates)};
 const proc=spawn(process.execPath,['--require',path.join(__dirname,'telegram_fetch_stub.js'),'server.js'],{cwd:path.join(__dirname,'..'),env,windowsHide:true,stdio:'ignore'});
 try{
  let delivered=false;for(let i=0;i<350;i++){const d=JSON.parse(fs.readFileSync(path.join(dir,'db.json'))),reply=(d.telegramOutbox||[]).find(e=>e.eventId==='telegram_update:1');if(reply?.status==='sent'){assert.equal(d.telegramUpdateOffset,4);assert.equal(d.telegramOutbox.find(e=>e.id==='sale:old').status,'pending');assert.ok(!d.telegramOutbox.some(e=>e.eventId==='telegram_update:2'||e.eventId==='telegram_update:3'||e.type==='daily'));delivered=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(delivered);
  const sent=fs.readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse);assert.equal(sent.length,1);assert.equal(sent[0].chat_id,'6718939119');assert.ok(!sent.some(m=>String(m.chat_id)==='-5394232914'));
 }finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
});
test('obsolete queue-based test mode cannot send a test message',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-telegram-testmode-')),capture=path.join(dir,'transport.jsonl');fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({products:[{id:'p',name:'Тест',stock:5,cost:5}],sales:[],customers:[],operations:{},counter:1001,bonusPct:0}));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only',TELEGRAM_BOT_TOKEN:'not-a-real-token',TELEGRAM_CHAT_ID:'synthetic',TELEGRAM_ENABLED:'1',TELEGRAM_TEST_ONLY:'1',TELEGRAM_TEST_CAPTURE:capture};
 const proc=spawn(process.execPath,['--require',path.join(__dirname,'telegram_fetch_stub.js'),'server.js'],{cwd:path.join(__dirname,'..'),env,windowsHide:true,stdio:'ignore'}),base='http://127.0.0.1:'+port;
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert.ok(ready);
  const post=async(p,body,token)=>{const r=await fetch(base+p,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const auth=(await post('/api/login',{login:'admin',pass:'synthetic-only'})).data;
  const sale={operationId:crypto.randomUUID(),cashierId:auth.id,items:[{productId:'p',quantity:1,price:10}],discount:0,total:10,payments:{cash:10}};assert.equal((await post('/api/experimental/receipt',{receipt:sale},auth.token)).status,200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'db.json'))).telegramOutbox,undefined);
  const operationId=crypto.randomUUID(),body={confirm:true,operationId};assert.equal((await post('/api/experimental/telegram-test',body,auth.token)).status,409);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'db.json'))).telegramOutbox,undefined);assert.equal(fs.existsSync(capture),false);
 }finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
});
