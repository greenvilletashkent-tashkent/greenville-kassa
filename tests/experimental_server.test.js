'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');

test('actual isolated server: parallel transactions, repeat, conflict and restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-actual-synthetic-'));
 fs.writeFileSync(path.join(dir,'db.json'),JSON.stringify({products:[{id:'p',stock:10,cost:40}],customers:[],sales:[],counter:1001}));
 const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const base='http://127.0.0.1:'+port;
 let proc;
 async function start(){
  proc=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),ADMIN_PASSWORD:'synthetic-only',GREENVILLE_EXPERIMENTAL_V3:'1'},windowsHide:true,stdio:'ignore'});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)return}catch{}await new Promise(r=>setTimeout(r,50))}throw Error('server not ready');
 }
 async function stop(){if(!proc || proc.exitCode!==null)return;proc.kill();await new Promise(r=>proc.once('exit',r));}
 async function post(route,body,token){const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
 const receipt=()=>({operationId:crypto.randomUUID(),cashierId:'u1',items:[{productId:'p',quantity:1,price:100}],discount:0,total:100});
 try{
  await start();const login=await post('/api/login',{login:'admin',pass:'synthetic-only'});assert.equal(login.status,200);const token=login.body.token;
  assert.equal((await post('/api/experimental/legacy-evidence',{},token)).status,410);
  assert.equal((await post('/api/experimental/legacy-decision',{},token)).status,410);
  const source=await fetch(base+'/server.js');assert.ok(!(await source.text()).includes('const FILE_AUTH'));
  const a=receipt(),b=receipt();const [one,two]=await Promise.all([post('/api/experimental/receipt',{receipt:a},token),post('/api/experimental/receipt',{receipt:b},token)]);
  assert.equal(one.status,200);assert.equal(two.status,200);assert.notEqual(one.body.saleId,two.body.saleId);
  const retry=await post('/api/experimental/receipt',{receipt:a},token);assert.equal(retry.body.duplicate,true);
  const conflict=await post('/api/experimental/receipt',{receipt:{...a,total:50}},token);assert.equal(conflict.status,409);
  const legacy=await post('/api/sale',{sale:{id:'1001'}},token);assert.equal(legacy.status,409);
  assert.equal((await post('/api/product/save',{product:{id:'p',stock:999}},token)).status,409);
  assert.equal((await post('/api/product/delete',{expected:{id:'p'}},token)).status,409);
  const replace=await fetch(base+'/api/data',{method:'PUT',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({db:{products:[{id:'p',stock:10}],sales:[]}})});assert.equal(replace.status,409);
  const staffRequest=()=>fetch(base+'/api/staff',{headers:{authorization:'Bearer '+token}}).then(r=>r.json());
  const staff=(await staffRequest()).staff;
  function hashPass(value){let h1=0x811c9dc5,h2=0x01000193;for(const c of 'gv:'+value){h1^=c.charCodeAt(0);h1=(h1*16777619)>>>0;h2=((h2+c.charCodeAt(0))*31+(h1>>>8))>>>0}return h1.toString(36)+h2.toString(36)}
  staff.push({id:'cashier-synthetic',login:'cashier-synthetic',name:'Тест',role:'cashier',active:true,pass:hashPass('synthetic-only')});
  const putStaff=list=>fetch(base+'/api/staff',{method:'PUT',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({staff:list})});
  assert.equal((await putStaff(staff)).status,200);
  const cashier=await post('/api/login',{login:'cashier-synthetic',pass:'synthetic-only'});assert.equal(cashier.status,200);
  const asCashier={headers:{authorization:'Bearer '+cashier.body.token}};
  assert.equal((await fetch(base+'/api/data',asCashier)).status,403);
  assert.equal((await fetch(base+'/api/passes',asCashier)).status,403);
  assert.equal((await fetch(base+'/api/catalog',asCashier)).status,409);
  assert.equal((await fetch(base+'/api/data',{headers:{authorization:'Bearer '+token}})).status,409);
  const cashierCatalog=await (await fetch(base+'/api/catalog',{headers:{authorization:'Bearer '+cashier.body.token,'X-GV-Protocol':'3'}})).json();assert.equal('cost' in cashierCatalog.products[0],false);
  const c=receipt(),d={...receipt(),cashierId:'cashier-synthetic'};
  const [adminSale,cashierSale]=await Promise.all([post('/api/experimental/receipt',{receipt:c},token),post('/api/experimental/receipt',{receipt:d},cashier.body.token)]);
  assert.equal(adminSale.status,200);assert.equal(cashierSale.status,200);assert.notEqual(adminSale.body.saleId,cashierSale.body.saleId);
  assert.equal((await post('/api/experimental/receipt-status',{receipt:c},cashier.body.token)).status,403);
  const stock={operationId:crypto.randomUUID(),cashierId:'u1',kind:'stock_add',productId:'p',quantity:3};
  assert.equal((await post('/api/experimental/stock-add',{receipt:stock},cashier.body.token)).status,403);
  assert.equal((await post('/api/experimental/stock-add',{receipt:stock},token)).status,200);
  assert.equal((await post('/api/experimental/stock-add',{receipt:stock},token)).body.duplicate,true);
  const cashierEdit={operationId:crypto.randomUUID(),cashierId:'cashier-synthetic',kind:'product_save',revision:0,product:{id:'p',name:'Касса',price:140,cost:null,stock:9,sku:'TEST'}};
  assert.equal((await post('/api/experimental/product-save',{receipt:cashierEdit},cashier.body.token)).status,200);
  assert.equal((await post('/api/experimental/product-save',{receipt:cashierEdit},cashier.body.token)).body.duplicate,true);
  let check=JSON.parse(fs.readFileSync(path.join(dir,'db.json')));assert.equal(check.products[0].cost,40);assert.equal(check.products[0].stock,9);
  const product={operationId:crypto.randomUUID(),cashierId:'u1',kind:'product_save',revision:1,product:{id:'p',name:'Синтетический товар',price:150,cost:null,stock:10,sku:'TEST'}};
  assert.equal((await post('/api/experimental/product-save',{receipt:product},cashier.body.token)).status,403);
  assert.equal((await post('/api/experimental/product-save',{receipt:product},token)).status,200);
  assert.equal((await post('/api/experimental/product-save',{receipt:product},token)).body.duplicate,true);
  assert.equal((await post('/api/experimental/product-save',{receipt:{...product,operationId:crypto.randomUUID()}},token)).status,409);
  const cashierState=await (await fetch(base+'/api/experimental/state',asCashier)).json();
  assert.equal(cashierState.db.sales.length,1);assert.equal(cashierState.db.sales[0].byId,'cashier-synthetic');
  assert.equal('cost' in cashierState.db.sales[0],false);assert.equal('cost' in cashierState.db.products[0],false);
  const customer={operationId:crypto.randomUUID(),cashierId:'cashier-synthetic',kind:'customer_add',customer:{id:'synthetic-customer',name:'Тест',phone:'000'}};
  assert.equal((await post('/api/experimental/customer-add',{receipt:customer},cashier.body.token)).status,200);
  assert.equal((await post('/api/experimental/customer-add',{receipt:customer},cashier.body.token)).body.duplicate,true);
  const withCustomer={...receipt(),cashierId:'cashier-synthetic',customerId:'synthetic-customer'};
  assert.equal((await post('/api/experimental/receipt',{receipt:withCustomer},cashier.body.token)).status,200);
  assert.equal((await post('/api/experimental/receipt',{receipt:withCustomer},cashier.body.token)).body.duplicate,true);
  const changed=await staffRequest();changed.staff.find(u=>u.id==='cashier-synthetic').active=false;
  assert.equal((await putStaff(changed.staff)).status,200);
  assert.equal((await fetch(base+'/api/catalog',asCashier)).status,401);
  await stop();await start();const status=await post('/api/experimental/receipt-status',{receipt:a},token);assert.equal(status.body.status,'accepted');
  const state=JSON.parse(fs.readFileSync(path.join(dir,'db.json')));assert.equal(state.products[0].stock,8);assert.equal(state.sales.length,5);
  assert.equal(state.customers.length,1);assert.equal(state.customers[0].visits,1);assert.equal(state.customers[0].spent,100);

 }finally{await stop();fs.rmSync(dir,{recursive:true,force:true})}
});
