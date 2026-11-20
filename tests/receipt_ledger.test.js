'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {acceptReceipt,changeReceipt,archiveProduct,importProducts,saveProduct} = require('../sync/receipt_ledger');

function receipt(op=crypto.randomUUID()) { return {operationId:op,items:[{productId:'p',quantity:2,price:50}],discount:10,total:90}; }
function initial() { return {products:[{id:'p',stock:10}],sales:[{id:'1000',legacy:true}],operations:{},counter:1001}; }

test('two cashiers, distinct identities, preserved legacy records and stock',()=>{
  let state=initial();
  for(const r of [receipt(),receipt()]) state=acceptReceipt(state,r,()=>{}).state;
  assert.equal(state.sales.length,3); assert.equal(state.products[0].stock,6); assert.equal(state.sales[0].legacy,true);
});
test('lost response and replay preserve sale and stock',()=>{
  const r=receipt(); let writes=0;
  const first=acceptReceipt(initial(),r,()=>writes++);
  const retry=acceptReceipt(first.state,r,()=>writes++);
  assert.equal(retry.duplicate,true); assert.equal(retry.saleId,first.saleId); assert.equal(writes,1); assert.equal(retry.state.products[0].stock,8);
});
test('same identity with different body fails without changing state',()=>{
  const r=receipt();const s=acceptReceipt(initial(),r,()=>{}).state;const snapshot=JSON.stringify(s);
  assert.throws(()=>acceptReceipt(s,{...r,total:80},()=>{}),/conflict/);assert.equal(JSON.stringify(s),snapshot);
});
test('failed persistence cannot mutate state',()=>{
  const s=initial(), before=JSON.stringify(s);
  assert.throws(()=>acceptReceipt(s,receipt(),()=>{throw Error('disk failure')}),/disk failure/);assert.equal(JSON.stringify(s),before);
});
test('service does not affect stock and incorrect totals rejected',()=>{
  const r={operationId:crypto.randomUUID(),items:[{service:true,quantity:1,price:150}],discount:25,total:125};
  const s=acceptReceipt(initial(),r,()=>{}).state;assert.equal(s.products[0].stock,10);
  assert.throws(()=>acceptReceipt(initial(),{...r,total:0},()=>{}),/total/);
});
test('unknown goods and invalid quantities rejected; occupied receipt number skipped',()=>{
  const s=initial();assert.throws(()=>acceptReceipt(s,{...receipt(),items:[{productId:'other',quantity:1,price:90}]},()=>{}),/unknown/);
  assert.throws(()=>acceptReceipt(s,{...receipt(),items:[{productId:'p',quantity:-1,price:90}]},()=>{}),/item/);
  s.sales.push({id:'1001'});const result=acceptReceipt(s,receipt(),()=>{});assert.equal(result.saleId,'1002');assert.equal(result.state.sales.length,3);
});
test('void and restore are idempotent, revision checked and adjust stock once',()=>{
 const actor={id:'cashier',name:'Test',role:'admin'};let s=acceptReceipt(initial(),receipt(),()=>{},actor).state;
 const change={operationId:crypto.randomUUID(),kind:'void',saleId:'1001',revision:1};
 assert.throws(()=>changeReceipt(s,change,()=>{},{...actor,role:'cashier'}),/forbidden/);
 s=changeReceipt(s,change,()=>{},actor).state;assert.equal(s.products[0].stock,10);
 assert.equal(changeReceipt(s,change,()=>{},actor).duplicate,true);assert.equal(s.products[0].stock,10);
 assert.throws(()=>changeReceipt(s,{...change,operationId:crypto.randomUUID(),kind:'restore'},()=>{},actor),/revision/);
 s=changeReceipt(s,{operationId:crypto.randomUUID(),kind:'restore',saleId:'1001',revision:2},()=>{},actor).state;
 assert.equal(s.products[0].stock,8);assert.equal(s.sales[1].revision,3);assert.equal(s.sales[1].deleted,false);
});
test('parked sale reserves once; payment and retry do not change stock',()=>{
 const actor={id:'cashier',name:'Test',role:'cashier'},r={...receipt(),kind:'park'};
 let s=acceptReceipt(initial(),r,()=>{},actor).state;assert.equal(s.products[0].stock,8);assert.equal(s.sales[1].paid,false);
 const pay={operationId:crypto.randomUUID(),kind:'pay',saleId:'1001',revision:1,pay:'cash'};
 s=changeReceipt(s,pay,()=>{},actor).state;assert.equal(s.products[0].stock,8);assert.equal(s.sales[1].paid,true);
 assert.equal(changeReceipt(s,pay,()=>{},actor).duplicate,true);assert.equal(s.products[0].stock,8);
});
test('edit adjusts stock once and rejects unreconciled paid amount',()=>{
 const actor={id:'cashier',name:'Test',role:'admin'};let s=acceptReceipt(initial(),receipt(),()=>{},actor).state;
 const edit={operationId:crypto.randomUUID(),kind:'edit',saleId:'1001',revision:1,items:[{productId:'p',quantity:1,price:100}],discount:10,total:90};
 s=changeReceipt(s,edit,()=>{},actor).state;assert.equal(s.products[0].stock,9);assert.equal(s.sales[1].revision,2);
 assert.equal(changeReceipt(s,edit,()=>{},actor).duplicate,true);assert.equal(s.products[0].stock,9);
 const invalid={...edit,operationId:crypto.randomUUID(),revision:2,total:100,discount:0};
 assert.throws(()=>changeReceipt(s,invalid,()=>{},actor),/payment reconciliation/);assert.equal(s.products[0].stock,9);
});
test('customer bonuses accrue once for a paid sale and once for deferred payment',()=>{
 const actor={id:'cashier',name:'Test',role:'cashier'},s=initial();s.customers=[{id:'c',visits:0,spent:0,bonus:0}];s.bonusPct=10;
 const r={...receipt(),customerId:'c'};let state=acceptReceipt(s,r,()=>{},actor).state;
 assert.equal(state.customers[0].bonus,9);assert.equal(state.customers[0].visits,1);
 state=acceptReceipt(state,r,()=>{},actor).state;assert.equal(state.customers[0].bonus,9);
 const park={...receipt(),kind:'park',customerId:'c'};state=acceptReceipt(state,park,()=>{},actor).state;assert.equal(state.customers[0].bonus,9);
 const pay={operationId:crypto.randomUUID(),kind:'pay',saleId:'1002',revision:1,pay:'cash'};
 state=changeReceipt(state,pay,()=>{},actor).state;assert.equal(state.customers[0].bonus,18);assert.equal(state.customers[0].visits,2);
 state=changeReceipt(state,pay,()=>{},actor).state;assert.equal(state.customers[0].bonus,18);
 state=changeReceipt(state,{operationId:crypto.randomUUID(),kind:'void',saleId:'1001',revision:1},()=>{},{...actor,role:'admin'}).state;
 assert.equal(state.customers[0].bonus,9);assert.equal(state.customers[0].visits,1);
 state=changeReceipt(state,{operationId:crypto.randomUUID(),kind:'restore',saleId:'1001',revision:2},()=>{},{...actor,role:'admin'}).state;
 assert.equal(state.customers[0].bonus,18);assert.equal(state.customers[0].visits,2);
});
test('archiving preserves existing history and rejects new sales',()=>{
 const actor={id:'admin',name:'Test',role:'admin'};let s=acceptReceipt(initial(),receipt(),()=>{},actor).state;
 const archive={operationId:crypto.randomUUID(),kind:'product_archive',productId:'p',revision:0};
 s=archiveProduct(s,archive,()=>{},actor).state;assert.equal(s.products[0].deleted,true);assert.equal(s.sales.length,2);
 assert.equal(archiveProduct(s,archive,()=>{},actor).duplicate,true);
 assert.throws(()=>acceptReceipt(s,receipt(),()=>{},actor),/unknown product/);
 s=changeReceipt(s,{operationId:crypto.randomUUID(),kind:'void',saleId:'1001',revision:1},()=>{},actor).state;
 assert.equal(s.products[0].stock,10);
});
test('catalog import is atomic, replay-safe and rejects stale rows',()=>{
 const actor={id:'admin',role:'admin'},s=initial();s.products[0].name='Existing';
 const row=(id,name,stock)=>({id,name,price:100,cost:null,stock,sku:id});
 const batch={operationId:crypto.randomUUID(),kind:'product_import',rows:[{mode:'update',revision:0,product:row('p','Existing',3)},{mode:'create',revision:0,product:row('new','New',4)}]};
 let result=importProducts(s,batch,()=>{},actor);assert.equal(result.state.products[0].stock,13);assert.equal(result.state.products.length,2);
 assert.equal(importProducts(result.state,batch,()=>{},actor).duplicate,true);assert.equal(result.state.products[0].stock,13);
 const stale={...batch,operationId:crypto.randomUUID()};const before=JSON.stringify(result.state);
 assert.throws(()=>importProducts(result.state,stale,()=>{},actor),/revision/);assert.equal(JSON.stringify(result.state),before);
});
test('cashier product edit preserves hidden cost and rejects a new duplicate SKU',()=>{
 const actor={id:'cashier',role:'cashier'},s=initial();s.products=[{id:'p',name:'One',sku:'OLD',stock:9,cost:45},{id:'q',name:'Two',sku:'OLD',stock:2,cost:20}];
 const edit={operationId:crypto.randomUUID(),kind:'product_save',revision:0,product:{id:'p',name:'Edited',price:100,cost:null,stock:9,sku:'OLD'}};
 const result=saveProduct(s,edit,()=>{},actor);assert.equal(result.state.products[0].cost,45);assert.equal(result.state.products[0].stock,9);
 const other={...edit,operationId:crypto.randomUUID(),product:{...edit.product,id:'new',sku:'old'}};
 assert.throws(()=>saveProduct(result.state,other,()=>{},actor),/sku already exists/);
});
