'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createWorker}=require('../sync/telegram_worker');
function fixture(send){let state={telegramOutbox:[{id:'sale:x',text:'Тест',status:'pending',attempts:0}]},writes=0;const commit=fn=>{let copy=structuredClone(state);if(fn(copy)){state=copy;writes++;}};return {worker:createWorker({readState:()=>state,commit,send}),state:()=>state,writes:()=>writes};}
test('confirmed send marks one event sent and does not resend',async()=>{let calls=0;const f=fixture(async()=>{calls++;return {status:'sent'}});await f.worker.tick();await f.worker.tick();assert.equal(calls,1);assert.equal(f.state().telegramOutbox[0].status,'sent');});
test('explicit retryable rejection stays pending and is retried',async()=>{let calls=0;const f=fixture(async()=>({status:++calls===1?'retry':'sent'}));await f.worker.tick();assert.equal(f.state().telegramOutbox[0].status,'pending');await f.worker.tick();assert.equal(f.state().telegramOutbox[0].status,'sent');});
test('lost response is quarantined without duplicate send',async()=>{let calls=0;const f=fixture(async()=>{calls++;throw Error('network');});await f.worker.tick();await f.worker.tick();assert.equal(calls,1);assert.equal(f.state().telegramOutbox[0].status,'uncertain');});
test('restart preserves in-flight uncertainty',()=>{const f=fixture(async()=>({status:'sent'}));f.state().telegramOutbox[0].status='sending';f.worker.recover();assert.equal(f.state().telegramOutbox[0].status,'uncertain');});
