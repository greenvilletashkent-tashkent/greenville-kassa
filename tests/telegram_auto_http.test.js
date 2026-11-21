'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
test('confirmed sales, corrections and expenses create separate idempotent notifications',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-auto-http-')),capture=path.join(dir,'out.jsonl');
 fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({products:[{id:'p',name:'Тест',stock:10,cost:50}],sales:[],customers:[],operations:{},counter:1001,bonusPct:0,cashRegister:{openingBalance:1000,openedAt:'2026-01-01T00:00:00Z'}}));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only',TELEGRAM_BOT_TOKEN:'fake',TELEGRAM_CHAT_ID:'fake',TELEGRAM_ENABLED:'1',TELEGRAM_TEST_CAPTURE:capture};delete env.TELEGRAM_OWNER_IDS;
 const proc=spawn(process.execPath,['--require',path.join(__dirname,'telegram_fetch_stub.js'),'server.js'],{cwd:path.join(__dirname,'..'),env,windowsHide:true,stdio:'ignore'}),base='http://127.0.0.1:'+port;
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
  const post=async(p,body,token)=>{const r=await fetch(base+p,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json()}};
  const a=(await post('/api/login',{login:'admin',pass:'synthetic-only'})).data;
  const sale={operationId:crypto.randomUUID(),cashierId:a.id,items:[{productId:'p',quantity:1,price:100}],discount:0,total:100,payments:{cash:100}};
  const sold=await post('/api/experimental/receipt',{receipt:sale},a.token);assert.equal(sold.status,200);assert.equal((await post('/api/experimental/receipt',{receipt:sale},a.token)).data.duplicate,true);
  const refund={operationId:crypto.randomUUID(),cashierId:a.id,saleId:sold.data.saleId,expectedRevision:1,reason:'Тестовый возврат',amounts:{cash:10}};assert.equal((await post('/api/experimental/refund',{receipt:refund},a.token)).status,200);assert.equal((await post('/api/experimental/refund',{receipt:refund},a.token)).data.duplicate,true);
  const expense={operationId:crypto.randomUUID(),cashierId:a.id,action:'create',amount:20,purpose:'Тест'};assert.equal((await post('/api/experimental/expense',{receipt:expense},a.token)).status,200);
  const edit={operationId:crypto.randomUUID(),cashierId:a.id,action:'edit',expenseId:expense.operationId,expectedRevision:1,amount:30,purpose:'Изменено'};assert.equal((await post('/api/experimental/expense',{receipt:edit},a.token)).status,200);assert.equal((await post('/api/experimental/expense',{receipt:edit},a.token)).data.duplicate,true);
  const data=JSON.parse(fs.readFileSync(path.join(dir,'db.json')));for(const id of ['sale:'+sale.operationId,'refund:'+refund.operationId,'expense:'+expense.operationId,'expense_change:'+edit.operationId])assert.equal(data.telegramOutbox.filter(e=>e.eventId===id).length,1,id);
  assert.equal(data.products[0].stock,9);assert.equal(data.sales.length,1);
 }finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
});
