'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildEvent,enqueue,daily,dueDaily,scheduleDaily,resolveUncertain}=require('../sync/telegram_notifications');
test('missed daily report is recovered once after a restart',()=>{
 const state={sales:[],expenses:[]};assert.equal(scheduleDaily(state,new Date('2026-11-20T10:00:00Z')),true);assert.equal(state.telegramOutbox,undefined);
 const restarted=structuredClone(state);assert.equal(scheduleDaily(restarted,new Date('2026-11-21T04:00:00Z')),true);assert.equal(restarted.telegramOutbox[0].id,'daily:2026-11-20');
 assert.equal(scheduleDaily(restarted,new Date('2026-11-21T04:05:00Z')),false);assert.equal(restarted.telegramOutbox.length,1);
});
test('uncertain messages require admin decision and record idempotent audit',()=>{
 const s={telegramOutbox:[{id:'sale:x',status:'uncertain'}]},admin={id:'a',role:'admin'},id='00000000-0000-4000-8000-000000000001';
 assert.throws(()=>resolveUncertain(s,'sale:x','retry',{id:'c',role:'cashier'},id),/forbidden/);
 assert.equal(resolveUncertain(s,'sale:x','retry',admin,id),true);assert.equal(s.telegramOutbox[0].status,'pending');
 assert.equal(resolveUncertain(s,'sale:x','retry',admin,id),false);assert.equal(s.telegramOutbox[0].reviewHistory.length,1);
});
test('daily due time is 21:00 Asia/Tashkent independent of host timezone',()=>{
 assert.equal(dueDaily(new Date('2026-11-20T15:59:59Z')),null);
 assert.equal(dueDaily(new Date('2026-11-20T16:00:00Z')),'2026-11-20');
 assert.equal(dueDaily(new Date('2026-11-20T19:00:00Z')),null);
});
test('sale with debt produces one notification and enqueue is idempotent',()=>{
 const op={operationId:'op1'},state={operations:{op1:{saleId:'1'}},sales:[{id:'1',date:'2026-11-20T12:00:00Z',paid:true,total:300,items:[{name:'Грунт',qty:1}],payments:{cash:100,terminal:150,owner_card:0,debt:50},cost:80,profit:220,customerId:'c'}],customers:[{id:'c',name:'Тест'}]};
 const e=buildEvent('sale',op,state,{id:'u',name:'Кассир'});assert.match(e.text,/Новый долг: 50 сум/);assert.match(e.text,/Терминал: 150 сум/);
 assert.equal(enqueue(state,e),true);assert.equal(enqueue(state,e),false);assert.equal(state.telegramOutbox.length,1);
});
test('daily report distinguishes debt payments from revenue',()=>{
 const state={sales:[{id:'1',date:'2026-11-20T12:00:00Z',paid:true,total:300,cost:100,profit:200,items:[],payments:{cash:100,terminal:150,owner_card:0,debt:50},debtOutstanding:0,debtPayments:[{operationId:'p',at:'2026-11-20T13:00:00Z',method:'cash',amount:50}]}],expenses:[]};
 const report=daily(state,'2026-11-20');assert.match(report.text,/Выручка: 300 сум/);assert.match(report.text,/Погашения долгов \(в составе поступлений\): 50 сум/);assert.equal(report.id,'daily:2026-11-20');
});
test('late reconstruction excludes activity after 21:00 and reconstructs historical balances',()=>{
 const s={cashRegister:{openingBalance:1000,openedAt:'2026-11-20T09:00:00Z'},sales:[{id:'1',date:'2026-11-20T12:00:00Z',cashReceivedAt:'2026-11-20T12:00:00Z',paid:true,total:300,cost:100,profit:200,items:[],payments:{cash:100,terminal:100,owner_card:0,debt:100},debtOutstanding:0,debtPayments:[{operationId:'p',at:'2026-11-20T17:00:00Z',method:'cash',amount:100}]}],expenses:[{id:'e',at:'2026-11-20T17:00:00Z',amount:20,purpose:'После 21',history:[]}]};
 const r=daily(s,'2026-11-20');assert.match(r.text,/Выручка: 300 сум/);assert.match(r.text,/Погашения долгов \(в составе поступлений\): 0 сум/);assert.match(r.text,/Расходы: 0 сум/);assert.match(r.text,/Остаток наличных на 21:00: 1100 сум/);assert.match(r.text,/Задолженность на 21:00: 100 сум/);
});
test('expense and full repayment carry the correct person, reason and resulting balances',()=>{
 const e={operationId:'expense1',action:'create'},p={operationId:'payment1'},s={cashRegister:{openingBalance:1000,openedAt:'2026-01-01T00:00:00Z'},operations:{payment1:{saleId:'s'}},customers:[{id:'c',name:'Покупатель'}],sales:[{id:'s',date:'2026-11-20T12:00:00Z',paid:true,total:100,payments:{cash:0,terminal:0,owner_card:0,debt:100},customerId:'c',debtOutstanding:0,debtPayments:[{operationId:'payment1',at:'2026-11-20T13:00:00Z',amount:100,method:'cash'}]}],expenses:[{id:'expense1',at:'2026-11-20T14:00:00Z',amount:50,purpose:'Доставка'}]};
 const expense=buildEvent('expense',e,s,{id:'u',name:'Продавец'}),repayment=buildEvent('debt_payment',p,s,{id:'u',name:'Продавец'});
 assert.match(expense.text,/Назначение: Доставка/);assert.match(expense.text,/Остаток наличных: 1050 сум/);assert.match(repayment.text,/Долг погашен/);assert.match(repayment.text,/Покупатель: Покупатель/);assert.match(repayment.text,/Остаток долга: 0 сум/);
});
test('long notifications are split without truncation and not duplicated on replay',()=>{
 const s={},event={id:'long',text:'🌿'.repeat(4000)};assert.equal(enqueue(s,event),true);assert.equal(enqueue(s,event),false);assert.equal(s.telegramOutbox.length,3);
 assert.equal(s.telegramOutbox.map(x=>x.text.replace(/^Часть \d+\/\d+\n/,'')).join(''),event.text);
});
