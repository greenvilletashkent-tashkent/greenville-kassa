'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
test('old write routes refuse mutations while protected protocol is active',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-old-routes-'));
 const original={products:[{id:'p',name:'synthetic',sku:'S',price:100,cost:50,stock:10}],sales:[{id:'1',total:100}],customers:[],counter:1001};
 const file=path.join(dir,'db.json');fs.writeFileSync(file,JSON.stringify(original));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only'};delete env.GREENVILLE_EXPERIMENTAL_V3;
 const p=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env,windowsHide:true,stdio:'ignore'}),base='http://127.0.0.1:'+port;
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,50))}assert.ok(ready);
  const login=await (await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login:'admin',pass:'synthetic-only'})})).json();
  for(const [method,route] of [['PUT','/api/data'],['POST','/api/sale'],['POST','/api/push'],['POST','/api/edit'],['POST','/api/meta'],['POST','/api/nextid'],['POST','/api/product/save'],['POST','/api/product/delete']]){
   const r=await fetch(base+route,{method,headers:{'content-type':'application/json',authorization:'Bearer '+login.token},body:JSON.stringify({db:{products:[],sales:[]},sale:{id:'2'},meta:{products:[]}})});assert.equal(r.status,409,route);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),original);
 }finally{p.kill();await new Promise(r=>p.once('exit',r));fs.rmSync(dir,{recursive:true,force:true})}
});
