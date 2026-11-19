'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const http=require('node:http'), fs=require('node:fs'), os=require('node:os'), path=require('node:path'), crypto=require('node:crypto');
const {acceptReceipt,receiptHash}=require('../sync/receipt_ledger');
const {ReceiptQueue}=require('../sync/receipt_queue');
class Memory {constructor(){this.m=new Map()}getItem(k){return this.m.get(k)??null}setItem(k,v){this.m.set(k,v)}}
test('isolated HTTP, simultaneous cashiers, lost response and server restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-synthetic-'));
 const file=path.join(dir,'synthetic.json');
 const original={products:[{id:'synthetic',stock:10}],sales:[{id:'1000',legacy:true}],operations:{},counter:1001};
 fs.writeFileSync(file,JSON.stringify(original));
 let state=JSON.parse(fs.readFileSync(file));
 const persist=s=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s));fs.renameSync(tmp,file)};
 const server=http.createServer((req,res)=>{
  if(req.method==='GET'){
   const id=new URL(req.url,'http://localhost').searchParams.get('id');
   return res.end(JSON.stringify(state.operations[id]||null));
  }
  let body='';req.on('data',x=>body+=x);req.on('end',()=>{
   try {const result=acceptReceipt(state,JSON.parse(body),persist);state=result.state;res.end(JSON.stringify({ok:true,duplicate:result.duplicate}));}
   catch(e){res.statusCode=409;res.end(JSON.stringify({error:e.message}));}
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try {
  const make=()=>({operationId:crypto.randomUUID(),items:[{productId:'synthetic',quantity:1,price:100}],discount:0,total:100});
  const a=make(), b=make();
  const post=body=>fetch(base,{method:'POST',headers:{'content-type':'application/json'},body});
  const [ra,rb]=await Promise.all([post(JSON.stringify(a)),post(JSON.stringify(b))]);assert.equal(ra.status,200);assert.equal(rb.status,200);
  assert.equal(state.sales.length,3);assert.equal(state.products[0].stock,8);
  const queue=new ReceiptQueue(new Memory()), c=make();queue.add(c);
  await assert.rejects(queue.sendOne(c.operationId,{send:async body=>{await post(body);throw Error('lost response')}}));
  const recovered=JSON.parse(fs.readFileSync(file));assert.equal(recovered.products[0].stock,7);state=recovered;
  const result=await queue.sendOne(c.operationId,{status:async(id,body)=>{const r=await fetch(base+'/?id='+id);const o=await r.json();return o && o.hash===receiptHash(JSON.parse(body))?'accepted':o?'unknown':'absent'},send:async()=>{throw Error('must not resend')}});
  assert.equal(result,'accepted');assert.equal(state.sales.length,4);assert.equal(state.products[0].stock,7);
  const conflict=await post(JSON.stringify({...c,total:99}));assert.equal(conflict.status,409);
 } finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
});
