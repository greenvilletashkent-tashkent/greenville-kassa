'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {knownCost,missingCostProducts,revenueEvents,inPeriod}=require('../public/payment_reporting');
test('zero is known and missing or invalid cost is unknown',()=>{
 assert.equal(knownCost(0),true);for(const value of [null,undefined,-1,'0',NaN])assert.equal(knownCost(value),false);
});
test('historical costs remain unchanged after catalogue update, with dated void and restore',()=>{
 const snapshot={total:200,cost:null,profit:null,items:[{id:'p',name:'Тест',qty:2,price:100,cost:null},{id:'zero',name:'Нулевая',qty:1,price:0,cost:0},{id:'svc',name:'Услуга',qty:1,price:0,isService:true}]};
 const sale={...snapshot,id:'s',paid:true,date:'2026-11-01T08:00:00Z',financialEvents:[{kind:'void',at:'2026-11-02T08:00:00Z',snapshot},{kind:'restore',at:'2026-11-03T08:00:00Z',snapshot}]};
 const catalogue=[{id:'p',sku:'SKU-1',cost:45},{id:'zero',sku:'ZERO',cost:0}],events=revenueEvents([sale]).events;
 const select=(day)=>missingCostProducts(events.filter(e=>inPeriod(e.date,'custom',new Date(),day,day)),catalogue);
 assert.deepEqual(select('2026-11-01').map(r=>[r.id,r.sku,r.quantity,r.revenue]),[['p','SKU-1',2,200]]);
 assert.deepEqual(select('2026-11-02').map(r=>[r.quantity,r.revenue]),[[-2,-200]]);
 assert.deepEqual(select('2026-11-03').map(r=>[r.quantity,r.revenue]),[[2,200]]);
 assert.deepEqual(missingCostProducts(events.slice(0,2),catalogue),[]);
 assert.equal(sale.items[0].cost,null);
});
test('discount is apportioned over goods and services and reverses on void',()=>{
 const snap={total:200,items:[{id:'p',qty:1,price:100,cost:null},{id:'q',qty:1,price:100,cost:0},{id:'service',qty:1,price:100,isService:true}]};
 const sale={...snap,paid:true,date:'2026-11-01T00:00:00Z',financialEvents:[{kind:'void',at:'2026-11-02T00:00:00Z',snapshot:snap}]};const events=revenueEvents([sale]).events;
 assert.equal(missingCostProducts([events[0]],[])[0].revenue,67);assert.equal(missingCostProducts([events[1]],[])[0].revenue,-67);
 assert.deepEqual(missingCostProducts(events,[]),[]);
 assert.equal(missingCostProducts([{total:999,items:snap.items}],[])[0].revenue,null);
});
test('old cancelled sales with uncertain history remain excluded',()=>{
 const data=revenueEvents([{id:'old',paid:true,deleted:true,date:'2026-11-01T00:00:00Z',items:[{id:'p',qty:1,price:10,cost:null}]}]);
 assert.deepEqual(data.uncertain,['old']);assert.deepEqual(missingCostProducts(data.events,[]),[]);
});
