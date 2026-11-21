'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWorker}=require('../sync/telegram_worker');
test('transient queue claim failure retries without a duplicate send',async()=>{
 let state={telegramOutbox:[{id:'report',type:'telegram_update',text:'report',status:'pending',attempts:0}]},fail=true,calls=0;
 const worker=createWorker({readState:()=>state,commit:fn=>{const next=structuredClone(state);if(fn(next)){if(fail){fail=false;const e=new Error('synthetic');e.storageError=true;throw e;}state=next;}},send:async()=>{calls++;return {status:'sent'};}});
 worker.wake();await new Promise(r=>setTimeout(r,800));assert.equal(calls,1);assert.equal(state.telegramOutbox[0].status,'sent');
});
test('failure recording a confirmed send never resends an in-flight message',async()=>{
 let state={telegramOutbox:[{id:'report',type:'telegram_update',text:'report',status:'pending',attempts:0}]},writes=0,calls=0;
 const worker=createWorker({readState:()=>state,commit:fn=>{const next=structuredClone(state);if(fn(next)){if(++writes===2){const e=new Error('synthetic');e.storageError=true;throw e;}state=next;}},send:async()=>{calls++;return {status:'sent'};}});
 worker.wake();await new Promise(r=>setTimeout(r,800));assert.equal(calls,1);assert.equal(state.telegramOutbox[0].status,'sending');worker.recover();assert.equal(state.telegramOutbox[0].status,'uncertain');
});
test('wakeup during a send delivers the queued report without waiting for the timer',async()=>{
 let state={telegramOutbox:[{id:'a',type:'telegram_update',text:'a',status:'pending',attempts:0}]},release;
 const started=new Promise(r=>release=r),sent=[];
 const worker=createWorker({readState:()=>state,commit:fn=>{const next=structuredClone(state);if(fn(next))state=next;},send:async text=>{sent.push(text);if(text==='a')await started;return {status:'sent'};}});
 worker.wake();state.telegramOutbox.push({id:'b',type:'telegram_update',text:'b',status:'pending',attempts:0});worker.wake();release();
 for(let i=0;i<50 && sent.length<2;i++)await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(sent,['a','b']);
});
function fixture(send){let state={telegramOutbox:[{id:'sale:x',text:'Тест',status:'pending',attempts:0}]},writes=0;const commit=fn=>{let copy=structuredClone(state);if(fn(copy)){state=copy;writes++;}};return {worker:createWorker({readState:()=>state,commit,send}),state:()=>state,writes:()=>writes};}
test('confirmed send marks one event sent and does not resend',async()=>{let calls=0;const f=fixture(async()=>{calls++;return {status:'sent'}});await f.worker.tick();await f.worker.tick();assert.equal(calls,1);assert.equal(f.state().telegramOutbox[0].status,'sent');});
test('explicit retryable rejection stays pending and is retried',async()=>{let calls=0;const f=fixture(async()=>({status:++calls===1?'retry':'sent'}));await f.worker.tick();assert.equal(f.state().telegramOutbox[0].status,'pending');await f.worker.tick();assert.equal(f.state().telegramOutbox[0].status,'sent');});
test('lost response is quarantined without duplicate send',async()=>{let calls=0;const f=fixture(async()=>{calls++;throw Error('network');});await f.worker.tick();await f.worker.tick();assert.equal(calls,1);assert.equal(f.state().telegramOutbox[0].status,'uncertain');});
test('restart preserves in-flight uncertainty',()=>{const f=fixture(async()=>({status:'sent'}));f.state().telegramOutbox[0].status='sending';f.worker.recover();assert.equal(f.state().telegramOutbox[0].status,'uncertain');});
