'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
test('two simultaneous cash openings allow one and replay remains idempotent',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-open-http-'));fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({products:[],sales:[],customers:[],operations:{}}));
 const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only'},windowsHide:true,stdio:'ignore'}),base='http://127.0.0.1:'+port;
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert.ok(ready);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'admin',pass:'synthetic-only'})}).then(r=>r.json());
  const headers={authorization:'Bearer '+login.token};const staff=(await fetch(base+'/api/staff',{headers}).then(r=>r.json())).staff;
  staff.push({id:'cashier',login:'cashier',name:'Тест',role:'cashier',active:true,pass:login.serverHash});
  assert.equal((await fetch(base+'/api/staff',{method:'PUT',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({staff})})).status,200);
  const cashier=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'cashier',pass:'synthetic-only'})}).then(r=>r.json());
  const denied=await fetch(base+'/api/experimental/cash-open',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+cashier.token},body:JSON.stringify({receipt:{operationId:crypto.randomUUID(),cashierId:cashier.id,openingBalance:1}})});assert.equal(denied.status,403);
  const a={operationId:crypto.randomUUID(),cashierId:login.id,kind:'cash_open',action:'open',openingBalance:10500},b={...a,operationId:crypto.randomUUID(),openingBalance:500};
  const post=x=>fetch(base+'/api/experimental/cash-open',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+login.token},body:JSON.stringify({receipt:x})});
  const [x,y]=await Promise.all([post(a),post(b)]);assert.deepEqual([x.status,y.status].sort(),[200,409]);const accepted=x.status===200?a:b;
  const retry=await post(accepted);assert.equal(retry.status,200);assert.equal((await retry.json()).duplicate,true);
  const db=JSON.parse(fs.readFileSync(path.join(dir,'db.json')));assert.equal(db.cashRegister.openingBalance,accepted.openingBalance);assert.equal(Object.keys(db.operations).length,1);
 }finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
});
