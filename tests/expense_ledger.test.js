'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {changeExpense,openCash}=require('../sync/receipt_ledger');
const {expenseEvents}=require('../public/payment_reporting');
const {cashRegister}=require('../sync/cash_register');
const cashier={id:'cashier',name:'Продавец',role:'cashier'},admin={id:'admin',name:'Администратор',role:'admin'};
const initial=()=>({products:[{id:'p',stock:5}],sales:[],operations:{},cashRegister:{openingBalance:10500,openedAt:'2026-01-01T00:00:00Z'}});
test('opening is admin-only, accepts zero and cannot be repeated with another ID',()=>{
 const state={products:[],sales:[],operations:{}},op={operationId:crypto.randomUUID(),openingBalance:0};
 assert.throws(()=>openCash(state,op,()=>true,cashier),/forbidden/);
 const opened=openCash(state,op,()=>true,admin).state;
 assert.equal(opened.cashRegister.openingBalance,0);assert.equal(opened.cashRegister.openedById,'admin');assert.equal(opened.cashRegister.operationId,op.operationId);
 assert.equal(openCash(opened,op,()=>{throw Error('duplicate write')},admin).duplicate,true);
 assert.throws(()=>openCash(opened,{...op,operationId:crypto.randomUUID()},()=>true,admin),/already opened/);
 assert.equal(cashRegister(opened).balance,0);
});
test('old sales stay excluded while subsequent old-debt repayment is included',()=>{
 const state={products:[],operations:{},sales:[{id:'old',date:'2099-01-01T00:00:00Z',paid:true,total:300,payments:{cash:100,terminal:100,owner_card:0,debt:100},debtOutstanding:50,debtPayments:[{operationId:'old-p',at:'2099-01-01T00:00:00Z',method:'cash',amount:50}]}]};
 const opened=openCash(state,{operationId:crypto.randomUUID(),openingBalance:10500},()=>true,admin).state;
 assert.equal(cashRegister(opened).balance,10500);
 opened.sales[0].debtPayments.push({operationId:'new-p',at:new Date(Date.now()+1000).toISOString(),method:'cash',amount:50});
 assert.equal(cashRegister(opened).balance,10550);
});
test('expense is persisted once, retains full purpose and is replay-safe',()=>{
 const op={operationId:crypto.randomUUID(),action:'create',amount:50000,purpose:'Упаковка и доставка покупателю'};
 const saved=changeExpense(initial(),op,()=>true,cashier).state;
 assert.equal(saved.expenses[0].purpose,op.purpose);assert.equal(saved.expenses[0].amount,50000);assert.equal(saved.expenses[0].byId,cashier.id);assert.ok(saved.expenses[0].at);
 assert.equal(changeExpense(saved,op,()=>{throw Error('unexpected write')},cashier).duplicate,true);
 assert.throws(()=>changeExpense(saved,{...op,amount:1},()=>true,cashier),/conflict/);assert.equal(saved.products[0].stock,5);
});
test('only administrator may edit or cancel; revision and audit protect history',()=>{
 const op={operationId:crypto.randomUUID(),action:'create',amount:100,purpose:'Тест'};
 const original=changeExpense(initial(),op,()=>true,cashier).state;
 const edit={operationId:crypto.randomUUID(),action:'edit',expenseId:op.operationId,expectedRevision:1,amount:80,purpose:'Исправление'};
 assert.throws(()=>changeExpense(original,edit,()=>true,cashier),/forbidden/);
 const updated=changeExpense(original,edit,()=>true,admin).state;
 assert.equal(updated.expenses[0].history[0].before.amount,100);assert.equal(updated.expenses[0].history[0].after.amount,80);
 assert.throws(()=>changeExpense(updated,{...edit,operationId:crypto.randomUUID()},()=>true,admin),/revision/);
 const cancel={operationId:crypto.randomUUID(),action:'cancel',expenseId:op.operationId,expectedRevision:2};
 const result=changeExpense(updated,cancel,()=>true,admin).state;
 assert.equal(result.expenses[0].cancelled,true);assert.equal(result.expenses[0].history.length,2);assert.equal(result.products[0].stock,5);
});
test('invalid amounts and failed persistence cannot change state',()=>{
 const state=initial(),before=JSON.stringify(state),op={operationId:crypto.randomUUID(),action:'create',amount:0,purpose:'Тест'};
 assert.throws(()=>changeExpense(state,op,()=>true,cashier),/invalid/);
 assert.throws(()=>changeExpense(state,{...op,amount:1},()=>{throw Error('disk')},cashier),/disk/);
 assert.equal(JSON.stringify(state),before);
});
test('expense history preserves original day and emits correction deltas',()=>{
 const rows=expenseEvents([{id:'x',at:'2026-11-01T00:00:00Z',amount:80,purpose:'После исправления',byId:'cashier',cancelled:true,history:[{action:'edit',at:'2026-11-02T00:00:00Z',byId:'admin',before:{amount:100,purpose:'Исходный',cancelled:false},after:{amount:80,purpose:'После исправления',cancelled:false}},{action:'cancel',at:'2026-11-03T00:00:00Z',byId:'admin',before:{amount:80,purpose:'После исправления',cancelled:false},after:{amount:80,purpose:'После исправления',cancelled:true}}]}]);
 assert.deepEqual(rows.map(x=>x.amount),[100,-20,-80]);assert.equal(rows[0].purpose,'Исходный');
});
test('cash balance includes cash receipts, repayments, refunds and expense changes once',()=>{
 const state=initial();state.sales=[{date:'2026-01-02T00:00:00Z',total:1000,paid:true,payments:{cash:400,terminal:400,owner_card:100,debt:100},debtPayments:[{at:'2026-01-03T00:00:00Z',method:'cash',amount:100}],refunds:[{at:'2026-01-04T00:00:00Z',amounts:{cash:50}}]}];
 const op={operationId:crypto.randomUUID(),action:'create',amount:500,purpose:'Тест'};const created=changeExpense(state,op,()=>true,cashier).state;
 assert.equal(cashRegister(created).balance,10450);
 const fixed=changeExpense(created,{operationId:crypto.randomUUID(),action:'edit',expenseId:op.operationId,expectedRevision:1,amount:300,purpose:'Тест'},()=>true,admin).state;
 assert.equal(cashRegister(fixed).balance,10650);assert.equal(cashRegister(fixed).movements.filter(m=>m.kind.startsWith('expense_')).length,2);
 const cancelled=changeExpense(fixed,{operationId:crypto.randomUUID(),action:'cancel',expenseId:op.operationId,expectedRevision:2},()=>true,admin).state;
 assert.equal(cashRegister(cancelled).balance,10950);
});
test('cash receipt queued before opening is counted when server accepts it afterwards',()=>{
 const state=initial();state.sales=[{date:'2025-12-31T23:00:00Z',cashReceivedAt:'2026-01-01T01:00:00Z',total:100,paid:true,payments:{cash:100,terminal:0,owner_card:0,debt:0}}];
 assert.equal(cashRegister(state).balance,10600);
});
