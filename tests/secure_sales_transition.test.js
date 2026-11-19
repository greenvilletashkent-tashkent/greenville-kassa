'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
test('two sales with the same old display number keep prior server history and debit only once each',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-transition-'));
 const prior={id:'1001',date:'2020-01-01T00:00:00Z',paid:true,total:33,items:[{id:'old',qty:1,price:33}]};
 fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({products:[{id:'p',stock:10,cost:40}],sales:[prior],customers:[],counter:1001}));
 const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only'};delete env.GREENVILLE_EXPERIMENTAL_V3;
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env,windowsHide:true,stdio:'ignore'});
 const base='http://127.0.0.1:'+port;
 const post=async(route,body,token)=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert.ok(ready);
  const login=await post('/api/login',{login:'admin',pass:'synthetic-only'});const token=login.data.token;
  const create=()=>({operationId:crypto.randomUUID(),cashierId:'u1',clientNumber:'1001',items:[{productId:'p',quantity:1,price:100}],discount:0,total:100});
  const a=create(),b=create();const both=await Promise.all([post('/api/experimental/receipt',{receipt:a},token),post('/api/experimental/receipt',{receipt:b},token)]);
  assert.deepEqual(both.map(x=>x.status),[200,200]);assert.notEqual(both[0].data.saleId,both[1].data.saleId);assert.ok(both.every(x=>x.data.saleId!=='1001'));
  const replay=await post('/api/experimental/receipt',{receipt:a},token);assert.equal(replay.data.duplicate,true);
  const blocked=await post('/api/sale',{sale:{...prior,total:999}},token);assert.equal(blocked.status,409);
  const state=JSON.parse(fs.readFileSync(path.join(dir,'db.json')));assert.deepEqual(state.sales.find(s=>s.id==='1001'),prior);assert.equal(state.sales.length,3);assert.equal(state.products[0].stock,8);
 }finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
});
