'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildEvent,daily,enqueue,scheduleDaily}=require('../sync/telegram_notifications');
test('zero or missing cost is not presented as known profit',()=>{
 const s={operations:{x:{saleId:'1'}},sales:[{id:'1',date:'2026-11-20T12:00:00Z',total:100,profit:100,cost:0,paid:true,items:[{name:'p',qty:1,cost:0}],payments:{cash:100}}]};
 assert.match(buildEvent('sale',{operationId:'x'},s,{name:'A'}).text,/Валовая прибыль: Неизвестно/);
 assert.match(daily(s,'2026-11-20').text,/Валовая прибыль: Неизвестно/);
});
test('cash day boundaries include opening, receipts, expenses and separate refunds',()=>{
 const s={cashRegister:{openingBalance:1000,openedAt:'2026-11-19T10:00:00Z'},sales:[{id:'1',date:'2026-11-20T06:00:00Z',cashReceivedAt:'2026-11-20T06:00:00Z',paid:true,total:100,cost:50,profit:50,items:[{id:'p',qty:1,price:100,cost:50}],payments:{cash:100,terminal:0,owner_card:0,debt:0},refunds:[{at:'2026-11-20T07:00:00Z',amounts:{cash:20}}]}],expenses:[{id:'e',amount:30,purpose:'Тест',at:'2026-11-20T08:00:00Z',history:[]}]};
 const text=daily(s,'2026-11-20').text;for(const line of ['Наличные на начало дня: 1000 сум','Наличные от продаж и погашений: 100 сум','Расходы из наличной кассы: 30 сум','Прочие движения наличных: -20 сум','Остаток наличных на 21:00: 1050 сум'])assert.ok(text.includes(line),line);
});
test('opening at local midnight is the start balance and is not counted twice',()=>{
 const state={cashRegister:{openingBalance:100,openedAt:'2026-11-19T19:00:00Z'},sales:[],expenses:[]},text=daily(state,'2026-11-20').text;
 assert.match(text,/Наличные на начало дня: 100 сум/);assert.match(text,/Прочие движения наличных: 0 сум/);assert.match(text,/Остаток наличных на 21:00: 100 сум/);
});
test('void and corrections are distinct idempotent notifications',()=>{
 const state={operations:{v:{saleId:'1'},c:{saleId:'1'}},sales:[{id:'1',paid:true,total:300,updatedAt:'2026-11-20T10:00:00Z',debtCorrections:[{operationId:'c',at:'2026-11-20T10:00:00Z',reason:'исправление',after:{debtOutstanding:40}}]}]},actor={id:'a',name:'Администратор'};
 for(const [kind,op] of [['sale_change',{operationId:'v',kind:'void'}],['debt_correction',{operationId:'c'}]]){const event=buildEvent(kind,op,state,actor);assert.ok(event);assert.equal(enqueue(state,event),true);assert.equal(enqueue(state,event),false);}
 assert.deepEqual(state.telegramOutbox.map(e=>e.eventId),['sale_change:v','debt_correction:c']);
});
test('first enable never schedules historical days; after 21 it schedules today only',()=>{
 const s={sales:[],expenses:[]};scheduleDaily(s,new Date('2026-11-20T17:00:00Z'));assert.deepEqual(s.telegramOutbox.map(e=>e.id),['daily:2026-11-20']);scheduleDaily(s,new Date('2026-11-20T18:00:00Z'));assert.equal(s.telegramOutbox.length,1);
});
