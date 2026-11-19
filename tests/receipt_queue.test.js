'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {ReceiptQueue}=require('../sync/receipt_queue');
class Memory { constructor(){this.m=new Map()} getItem(k){return this.m.has(k)?this.m.get(k):null} setItem(k,v){this.m.set(k,v)} }
test('offline and restart preserve identical body and operation id',async()=>{
 const storage=new Memory(),q=new ReceiptQueue(storage), r={operationId:'unique',total:90};q.add(r);
 await assert.rejects(q.sendOne('unique',{send:async()=>{throw Error('offline')}}));
 const again=new ReceiptQueue(storage);assert.equal(again.read().entries[0].status,'uncertain');assert.equal(again.read().entries[0].body,JSON.stringify(r));
});
test('lost reply: check status before repeat and never send twice',async()=>{
 const q=new ReceiptQueue(new Memory());q.add({operationId:'id',total:90});let writes=0, checks=0;
 await assert.rejects(q.sendOne('id',{send:async()=>{writes++;throw Error('lost response')}}));
 assert.equal(await q.sendOne('id',{status:async()=>{checks++;return 'accepted'},send:async()=>{writes++;return 'accepted'}}),'accepted');
 assert.equal(checks,1);assert.equal(writes,1);assert.equal(q.read().entries.length,0);
});
test('unknown outcome remains queued; absent outcome allows retry',async()=>{
 const q=new ReceiptQueue(new Memory());q.add({operationId:'id'});await assert.rejects(q.sendOne('id',{send:async()=>{throw Error('error')}}));
 assert.equal(await q.sendOne('id',{status:async()=> 'unknown'}),'waiting');assert.equal(q.read().entries.length,1);
 assert.equal(await q.sendOne('id',{status:async()=> 'absent',send:async()=> 'accepted'}),'accepted');assert.equal(q.read().entries.length,0);
});
test('legacy items are preserved for review without false confirmation',()=>{
 const q=new ReceiptQueue(new Memory()), old={id:'1',date:'2026-01-01T00:00:00Z',total:20};q.importLegacy([old],{});q.importLegacy([old],{});
 assert.equal(q.read().entries.length,1);assert.equal(q.read().entries[0].status,'legacy_review');assert.deepEqual(JSON.parse(q.read().entries[0].legacyBody),old);
});
test('storage error prevents pretending an operation was queued',()=>{
 const q=new ReceiptQueue({getItem:()=>null,setItem:()=>{throw Error('storage full')}});assert.throws(()=>q.add({operationId:'id'}),/storage full/);
});
