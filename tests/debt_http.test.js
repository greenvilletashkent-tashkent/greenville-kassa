'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
test('HTTP debt sale and simultaneous replay preserve stock and prior sales',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-debt-http-'));
 const old={id:'1',paid:true,total:10,items:[]};fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({products:[{id:'p',name:'Synthetic',stock:10,cost:40}],sales:[old],customers:[{id:'c',name:'Synthetic',visits:0,spent:0,bonus:0}],counter:1001,bonusPct:0}));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only'},windowsHide:true,stdio:'ignore'}),base='http://127.0.0.1:'+port;
 const call=async(route,body,token)=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert.ok(ready);
  const auth=await call('/api/login',{login:'admin',pass:'synthetic-only'}),token=auth.data.token,actor=auth.data.id;
  const receipt={operationId:crypto.randomUUID(),cashierId:actor,customerId:'c',items:[{productId:'p',quantity:1,price:300}],discount:0,total:300,payments:{cash:100,terminal:150,debt:50}};
  const [a,b]=await Promise.all([call('/api/experimental/receipt',{receipt},token),call('/api/experimental/receipt',{receipt},token)]);assert.equal(a.status,200);assert.equal(b.status,200);assert.deepEqual([a.data.duplicate,b.data.duplicate].sort(),[false,true]);
  const op={operationId:crypto.randomUUID(),cashierId:actor,saleId:a.data.saleId,method:'cash',amount:50};
  const [x,y]=await Promise.all([call('/api/experimental/debt-payment',{receipt:op},token),call('/api/experimental/debt-payment',{receipt:op},token)]);assert.equal(x.status,200);assert.equal(y.status,200);assert.deepEqual([x.data.duplicate,y.data.duplicate].sort(),[false,true]);
  const s=JSON.parse(fs.readFileSync(path.join(dir,'db.json')));assert.deepEqual(s.sales[0],old);assert.equal(s.sales.length,2);assert.equal(s.products[0].stock,9);assert.equal(s.sales[1].debtOutstanding,0);assert.equal(s.sales[1].debtPayments.length,1);
  const nextReceipt={...receipt,operationId:crypto.randomUUID()};const nextSale=await call('/api/experimental/receipt',{receipt:nextReceipt},token);assert.equal(nextSale.status,200);
  const repayment=()=>({operationId:crypto.randomUUID(),cashierId:actor,saleId:nextSale.data.saleId,method:'cash',amount:40});
  const attempts=await Promise.all([call('/api/experimental/debt-payment',{receipt:repayment()},token),call('/api/experimental/debt-payment',{receipt:repayment()},token)]);
  assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  const final=JSON.parse(fs.readFileSync(path.join(dir,'db.json')));assert.equal(final.sales[2].debtOutstanding,10);assert.equal(final.sales[2].debtPayments.length,1);assert.equal(final.products[0].stock,8);
 }finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
});
