'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
test('integration key reads filtered snapshot and never grants write access',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-ai-read-')),key='a'.repeat(64),db={products:[{id:'p',name:'Test',price:100,cost:40,stock:3,secret:'hide'}],sales:[{id:'s',date:'2026-11-26',paid:true,total:100,cost:40,profit:60,customerId:'private',items:[{id:'p',qty:1,price:100,cost:40}],financialEvents:[{kind:'void',at:'2026-11-27',snapshot:{total:100,cost:40,profit:60,items:[{id:'p',qty:1,price:100,cost:40}]}}]}],customers:[{name:'private'}]};
 fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify(db));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),GREENVILLE_AI_READ_KEY:key},windowsHide:true,stdio:'ignore'}),base='http://127.0.0.1:'+port;
 try{
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break}catch{}await new Promise(r=>setTimeout(r,50))}
  const names=['db.json','staff.json','sessions.json','changes.log','rate.json'];const before=Object.fromEntries(names.map(name=>[name,fs.existsSync(path.join(dir,name))?fs.readFileSync(path.join(dir,name),'utf8'):null]));
  assert.equal((await fetch(base+'/api/integration/ai/snapshot')).status,401);
  assert.equal((await fetch(base+'/api/integration/ai/snapshot',{headers:{authorization:'Bearer '+'b'.repeat(64)}})).status,401);
  const headers={authorization:'Bearer '+key};const r=await fetch(base+'/api/integration/ai/snapshot',{headers});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const data=await r.json();
  assert.equal(data.sales[0].financialEvents[0].kind,'void');assert.equal(data.products[0].cost,40);assert.equal(data.products[0].stock,3);assert.equal(JSON.stringify(data).includes('private'),false);assert.equal(JSON.stringify(data).includes('hide'),false);
  assert.equal((await fetch(base+'/api/integration/ai/snapshot',{method:'POST',headers})).status,405);
  assert.equal((await fetch(base+'/api/experimental/state',{headers})).status,401);
  assert.equal((await fetch(base+'/api/experimental/receipt',{method:'POST',headers})).status,401);
  assert.equal((await fetch(base+'/api/data',{method:'PUT',headers})).status,401);
  for(const name of names)assert.equal(fs.existsSync(path.join(dir,name))?fs.readFileSync(path.join(dir,name),'utf8'):null,before[name]);
 }finally{proc.kill();await new Promise(r=>proc.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});}
});
