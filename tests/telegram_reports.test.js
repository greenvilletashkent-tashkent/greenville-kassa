'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ownerIds,report,handleUpdate}=require('../sync/telegram_reports');
const {enqueue}=require('../sync/telegram_notifications');
const now=new Date('2026-11-20T12:00:00Z');
const state=()=>({sales:[{id:'1',date:'2026-11-20T10:00:00Z',total:300,paid:true,cost:100,profit:200,items:[],payments:{cash:100,terminal:150,owner_card:50,debt:0}}],expenses:[]});
const update=(id,uid,type,text,chat=uid)=>({update_id:id,message:{from:{id:uid},chat:{id:chat,type},text}});
test('only allowlisted owner in private chat can request reports',()=>{
 const s=state(),allowed=ownerIds('123, 456,invalid');assert.deepEqual([...allowed],['123','456']);
 assert.equal(handleUpdate(s,update(1,999,'private','Сегодня'),allowed,now,enqueue),false);
 assert.equal(handleUpdate(s,update(2,123,'group','Сегодня',-55),allowed,now,enqueue),false);
 assert.equal(handleUpdate(s,update(3,123,'private','Сегодня'),allowed,now,enqueue),true);
 assert.equal(s.telegramOutbox[0].destination,'123');assert.match(s.telegramOutbox[0].text,/Выручка: 300 сум/);assert.match(s.telegramOutbox[0].text,/Терминал: 150 сум/);
});
test('update remembers selection and repeat update is idempotent',()=>{
 const s=state(),allowed=ownerIds('123');assert.equal(handleUpdate(s,update(10,123,'private','Вчера'),allowed,now,enqueue),true);
 assert.equal(handleUpdate(s,update(11,123,'private','Обновить'),allowed,now,enqueue),true);
 assert.match(s.telegramOutbox[1].text,/Вчера/);assert.equal(handleUpdate(s,update(11,123,'private','Обновить'),allowed,now,enqueue),false);
});
test('period reports use the same cash payment and revenue aggregation as the app',()=>{
 const text=report(state(),'Сегодня',now);assert.match(text,/Выручка: 300 сум/);assert.match(text,/Наличные поступления: 100 сум/);assert.match(text,/Карта руководителя: 50 сум/);
});
