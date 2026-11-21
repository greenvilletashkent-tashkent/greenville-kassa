'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sendSingle,TEXT}=require('../sync/telegram_single_test');
test('one call sends exact text and returns confirmed message ID',async()=>{
 let calls=0;const r=await sendSingle({token:'secret',chatId:'-1',request:async(_url,opts)=>{calls++;const b=JSON.parse(opts.body);assert.equal(b.text,TEXT);assert.equal(b.chat_id,'-1');return {status:200,ok:true,json:async()=>({ok:true,result:{message_id:123}})};}});
 assert.equal(calls,1);assert.deepEqual(r,{status:'delivered',messageId:123});assert.ok(!JSON.stringify(r).includes('secret'));
});
test('429 is an error without retry; timeout and server failures are uncertain',async()=>{
 for(const [request,expected] of [[async()=>({status:429,ok:false}),'error'],[async()=>({status:500,ok:false}),'uncertain'],[async()=>{throw Error('secret');},'uncertain']]){let calls=0;const r=await sendSingle({token:'secret',chatId:'-1',request:async(...a)=>{calls++;return request(...a);}});assert.equal(calls,1);assert.equal(r.status,expected);assert.ok(!JSON.stringify(r).includes('secret'));}
});
