'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {acceptReceipt,repayDebt,correctDebt,changeReceipt,refundPayment}=require('../sync/receipt_ledger');
const actor={id:'cashier',name:'Test',role:'cashier'};
const seed=()=>({products:[{id:'p',name:'Test',stock:10,cost:40}],sales:[],customers:[{id:'c',visits:0,spent:0,bonus:0}],counter:1001,operations:{},bonusPct:0});
const create=(payments,customerId='c')=>({operationId:crypto.randomUUID(),items:[{productId:'p',quantity:1,price:300}],discount:0,total:300,payments,customerId});
test('partial mixed refunds are idempotent and limited per payment method',()=>{
 const admin={id:'admin',role:'admin'},s=acceptReceipt(seed(),create({cash:100,terminal:150,owner_card:50}),()=>true,actor).state;
 const op={operationId:crypto.randomUUID(),saleId:s.sales[0].id,expectedRevision:1,reason:'Возврат',amounts:{cash:40,terminal:30}},done=refundPayment(s,op,()=>true,admin).state;
 assert.equal(done.sales[0].refunds.length,1);assert.equal(done.products[0].stock,9);
 assert.equal(refundPayment(done,op,()=>{throw Error('duplicate write')},admin).duplicate,true);
 assert.throws(()=>refundPayment(done,{...op,operationId:crypto.randomUUID()},()=>true,admin),/Обновите/);
 assert.throws(()=>refundPayment(done,{...op,operationId:crypto.randomUUID(),expectedRevision:2,amounts:{cash:61}},()=>true,admin),/exceeds/);
 const again=refundPayment(done,{...op,operationId:crypto.randomUUID(),expectedRevision:2},()=>true,admin).state;assert.equal(again.sales[0].refunds.length,2);
 assert.throws(()=>refundPayment(done,{...op,operationId:crypto.randomUUID()},()=>true,actor),/forbidden/);
 assert.equal(done.sales[0].debtOutstanding,0);
});
test('parked sale retains mixed payment and uses its saved customer for debt',()=>{
 const parked=acceptReceipt(seed(),{...create({cash:300}),kind:'park'},()=>true,actor).state;
 const change={operationId:crypto.randomUUID(),kind:'pay',saleId:parked.sales[0].id,revision:1,payments:{cash:100,terminal:100,debt:100}};
 const done=changeReceipt(parked,change,()=>true,actor).state;
 assert.equal(done.sales[0].debtOutstanding,100);assert.equal(done.sales[0].payments.terminal,100);assert.equal(done.products[0].stock,9);
 assert.equal(changeReceipt(done,change,()=>{throw Error('duplicate persisted')},actor).duplicate,true);
 const without=acceptReceipt(seed(),{...create({cash:300},null),kind:'park'},()=>true,actor).state;
 assert.throws(()=>changeReceipt(without,{...change,operationId:crypto.randomUUID(),saleId:without.sales[0].id,customerId:'c'},()=>true,actor),/customer/);
});
test('cash, terminal, owner card, debt and mixed totals preserve stock and legacy fields',()=>{
 for(const payments of [{cash:300},{terminal:300},{owner_card:300},{debt:300},{cash:100,terminal:150,debt:50}]){
  const original=seed(),r=create(payments),first=acceptReceipt(original,r,()=>true,actor),again=acceptReceipt(first.state,r,()=>{throw Error('duplicate persisted')},actor);
  assert.equal(first.state.products[0].stock,9);assert.equal(first.state.sales.length,1);assert.equal(again.duplicate,true);assert.equal(again.state.sales[0].debtOutstanding,payments.debt||0);assert.equal(original.products[0].stock,10);
 }
});
test('invalid payment and missing customer are rejected without mutation',()=>{
 for(const p of [{cash:-1,debt:301},{cash:301},{cash:100,debt:100},{cash:1.5,debt:298.5}]){const s=seed();assert.throws(()=>acceptReceipt(s,create(p),()=>true,actor));assert.equal(s.products[0].stock,10);}
 assert.throws(()=>acceptReceipt(seed(),create({debt:300},null),()=>true,actor),/customer/);
});
test('new buyer and credit sale are created atomically and not duplicated',()=>{
 const s=seed(),id=crypto.randomUUID(),r={...create({debt:300},id),newCustomer:{id,name:'New buyer',phone:''}};
 const done=acceptReceipt(s,r,()=>true,actor).state;assert.equal(done.customers.length,2);assert.equal(done.sales[0].customerId,id);assert.equal(done.products[0].stock,9);
 assert.equal(acceptReceipt(done,r,()=>{throw Error('duplicate write')},actor).duplicate,true);assert.equal(done.customers.length,2);
});
test('partial repayment and retries close balance without touching inventory',()=>{
 let s=acceptReceipt(seed(),create({cash:100,debt:200}),()=>true,actor).state;const id=s.sales[0].id;
 for(const [method,amount] of [['cash',50],['owner_card',100],['terminal',50]]){
  const op={operationId:crypto.randomUUID(),saleId:id,method,amount,cashierId:actor.id},result=repayDebt(s,op,()=>true,actor);s=result.state;
  assert.equal(repayDebt(s,op,()=>{throw Error('duplicate persisted')},actor).duplicate,true);assert.equal(s.products[0].stock,9);
 }
 assert.equal(s.sales[0].debtOutstanding,0);assert.equal(s.sales[0].debtPayments.length,3);
 assert.throws(()=>repayDebt(s,{operationId:crypto.randomUUID(),saleId:id,method:'cash',amount:1},()=>true,actor));
});
test('overpayment, conflicting replay and unauthorized repayment rejected',()=>{
 const s=acceptReceipt(seed(),create({debt:300}),()=>true,actor).state,id=s.sales[0].id;
 assert.throws(()=>repayDebt(s,{operationId:crypto.randomUUID(),saleId:id,method:'cash',amount:301},()=>true,actor));
 assert.throws(()=>repayDebt(s,{operationId:crypto.randomUUID(),saleId:id,method:'cash',amount:1},()=>true,{id:'x',role:'other'}),/forbidden/);
 const op={operationId:crypto.randomUUID(),saleId:id,method:'cash',amount:1},done=repayDebt(s,op,()=>true,actor).state;
 assert.throws(()=>repayDebt(done,{...op,amount:2},()=>true,actor),/conflict/);
 assert.throws(()=>changeReceipt(done,{operationId:crypto.randomUUID(),saleId:id,kind:'void',revision:1},()=>true,{id:'admin',role:'admin'}),/reconciliation/);
});
test('storage failure does not mutate sale, debt, stock or operation ledger',()=>{
 const s=acceptReceipt(seed(),create({debt:300}),()=>true,actor).state,before=JSON.stringify(s);
 assert.throws(()=>repayDebt(s,{operationId:crypto.randomUUID(),saleId:s.sales[0].id,method:'cash',amount:50},()=>{throw Error('disk failed')},actor),/disk failed/);
 assert.equal(JSON.stringify(s),before);
});
test('admin corrections preserve original payment and audit; cashier denied',()=>{
 const admin={id:'admin',role:'admin'},s=acceptReceipt(seed(),create({cash:100,debt:200}),()=>true,actor).state,id=s.sales[0].id;
 const op={operationId:crypto.randomUUID(),saleId:id,method:'cash',amount:50},paid=repayDebt(s,op,()=>true,actor).state;
 const correction={operationId:crypto.randomUUID(),saleId:id,action:'reverse_repayment',paymentId:op.operationId,reason:'Ошибка ввода',expectedRevision:2};
 assert.throws(()=>correctDebt(paid,correction,()=>true,actor),/forbidden/);
 const fixed=correctDebt(paid,correction,()=>true,admin).state;assert.equal(fixed.sales[0].debtOutstanding,200);assert.equal(fixed.sales[0].debtPayments.length,1);assert.equal(fixed.sales[0].debtCorrections[0].before.debtOutstanding,150);assert.equal(fixed.products[0].stock,9);
 assert.equal(correctDebt(fixed,correction,()=>{throw Error('duplicate write')},admin).duplicate,true);
 assert.throws(()=>correctDebt(fixed,{...correction,operationId:crypto.randomUUID()},()=>true,admin),/Обновите/);
 assert.throws(()=>correctDebt(fixed,{...correction,operationId:crypto.randomUUID(),expectedRevision:3},()=>true,admin),/already reversed/);
});
test('stale correction is rejected after another employee records repayment',()=>{
 const admin={id:'admin',role:'admin'},s=acceptReceipt(seed(),create({debt:300}),()=>true,actor).state,id=s.sales[0].id;
 const change={operationId:crypto.randomUUID(),saleId:id,action:'correct_initial',reason:'Исправление',expectedRevision:1,payments:{cash:100,debt:200}};
 const changed=repayDebt(s,{operationId:crypto.randomUUID(),saleId:id,method:'cash',amount:50},()=>true,actor).state,before=JSON.stringify(changed);
 assert.throws(()=>correctDebt(changed,change,()=>true,admin),/Обновите/);assert.equal(JSON.stringify(changed),before);
});
