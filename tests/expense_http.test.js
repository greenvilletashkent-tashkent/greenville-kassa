'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
test('expense HTTP retry writes one event without changing sale or stock',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-expense-'));
 fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({products:[{id:'p',stock:10}],sales:[],customers:[],operations:{},cashRegister:{openingBalance:10500,openedAt:'2026-01-01T00:00:00Z'}}));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const spawnServer=()=>spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only'},windowsHide:true,stdio:'ignore'});let proc=spawnServer();const base='http://127.0.0.1:'+port;
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert.ok(ready);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'admin',pass:'synthetic-only'})}).then(r=>r.json());
  const op={operationId:crypto.randomUUID(),cashierId:login.id,action:'create',amount:500,purpose:'Тестовые расходы'};
  const call=()=>fetch(base+'/api/experimental/expense',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+login.token},body:JSON.stringify({receipt:op})}).then(r=>r.json());
  const [a,b]=await Promise.all([call(),call()]);assert.deepEqual([a.duplicate,b.duplicate].sort(),[false,true]);
  const data=JSON.parse(fs.readFileSync(path.join(dir,'db.json')));assert.equal(data.expenses.length,1);assert.equal(data.products[0].stock,10);assert.equal(data.sales.length,0);
  const headers={authorization:'Bearer '+login.token};const staff=(await fetch(base+'/api/staff',{headers}).then(r=>r.json())).staff;staff.push({id:'cashier',login:'cashier',name:'Продавец',role:'cashier',active:true,pass:login.serverHash});
  assert.equal((await fetch(base+'/api/staff',{method:'PUT',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({staff})})).status,200);
  const cashier=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'cashier',pass:'synthetic-only'})}).then(r=>r.json());
  const independent=user=>fetch(base+'/api/experimental/expense',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+user.token},body:JSON.stringify({receipt:{...op,cashierId:user.id,operationId:crypto.randomUUID()}})}).then(r=>r.json());
  const both=await Promise.all([independent(login),independent(cashier)]);assert.ok(both.every(x=>x.ok&&!x.duplicate));
  const cash=await fetch(base+'/api/experimental/cash',{headers:{authorization:'Bearer '+login.token}}).then(r=>r.json());assert.equal(cash.balance,9000);assert.equal(cash.movements.filter(x=>x.kind==='expense_create').length,3);
  proc.kill();await new Promise(r=>proc.once('exit',r));proc=spawnServer();let restarted=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){restarted=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert.ok(restarted);
  const auth2=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'admin',pass:'synthetic-only'})}).then(r=>r.json());
  const after=await fetch(base+'/api/experimental/cash',{headers:{authorization:'Bearer '+auth2.token}}).then(r=>r.json());assert.equal(after.balance,9000);assert.equal(after.movements.filter(x=>x.kind==='expense_create').length,3);
 }finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
});
