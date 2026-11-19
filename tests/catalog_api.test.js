'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
test('existing duplicate SKU remains editable; stale update and duplicate create fail safely',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-catalog-api-'));
 const p={id:'a',name:'Old A',sku:'DUP',price:100,cost:50,stock:8,cat:'',img:'',barcode:'',updatedAt:'2026-11-01T00:00:00Z'},q={...p,id:'b',name:'Old B',stock:4};
 fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({products:[p,q],customers:[],sales:[],counter:1001,bonusPct:5}));
 const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only',GREENVILLE_EXPERIMENTAL_V3:'0'},windowsHide:true,stdio:'ignore'});
 const base='http://127.0.0.1:'+port;
 const call=async(path,method,body,token)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert.ok(ready);
  const login=await call('/api/login','POST',{login:'admin',pass:'synthetic-only'}),token=login.body.token;
  const saved=await call('/api/product/save','POST',{expected:p,product:{...p,price:150}},token);assert.equal(saved.status,200);
  const retry=await call('/api/product/save','POST',{expected:p,product:{...p,price:150}},token);assert.equal(retry.status,200);
  const stale=await call('/api/product/save','POST',{expected:p,product:{...p,price:200}},token);assert.equal(stale.status,409);
  const duplicate=await call('/api/product/save','POST',{expected:null,product:{...p,id:'c'}},token);assert.equal(duplicate.status,409);
  const legacy=await call('/api/edit','POST',{meta:{products:[{...p,stock:999}]}},token);assert.equal(legacy.status,200);
  const db=await call('/api/data','GET',undefined,token);assert.equal(db.body.db.products.find(x=>x.id==='a').stock,8);assert.deepEqual(db.body.db.products.find(x=>x.id==='b'),q);
 }finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
});
