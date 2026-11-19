/* Experimental IndexedDB outbox. Not wired to the live checkout yet. */
(function(root){
  'use strict';
  class ReceiptOutbox {
    constructor(name='greenville_outbox_v1'){this.name=name;this.db=null;}
    open(){
      return new Promise((resolve,reject)=>{
        const request=indexedDB.open(this.name,1);
        request.onupgradeneeded=()=>request.result.createObjectStore('receipts',{keyPath:'operationId'});
        request.onerror=()=>reject(request.error);
        request.onblocked=()=>reject(new Error('outbox database upgrade blocked'));
        request.onsuccess=()=>{this.db=request.result;this.db.onversionchange=()=>this.db.close();resolve(this);};
      });
    }
    close(){if(this.db)this.db.close();this.db=null;}
    transaction(mode,action){
      if(!this.db) return Promise.reject(new Error('outbox not open'));
      return new Promise((resolve,reject)=>{
        const tx=this.db.transaction('receipts',mode), store=tx.objectStore('receipts');
        let value;
        try{action(store, result=>{value=result;}, tx);}catch(error){tx.abort();reject(error);return;}
        tx.oncomplete=()=>resolve(value);
        tx.onabort=()=>reject(tx.error || new Error('outbox transaction aborted'));
        tx.onerror=()=>{};
      });
    }
    add(receipt){
      const operationId=receipt && receipt.operationId;
      if(!operationId || typeof operationId!=='string')return Promise.reject(new Error('operation id required'));
      const body=JSON.stringify(receipt);
      return this.transaction('readwrite',(store,done,tx)=>{
        const read=store.get(operationId);
        read.onsuccess=()=>{
          if(read.result){if(read.result.body!==body){tx.abort();return}done(false);return;}
          store.add({operationId,body,status:'pending'});done(true);
        };
      });
    }
    list(){return this.transaction('readonly',(store,done)=>{const req=store.getAll();req.onsuccess=()=>done(req.result);});}
    setUncertain(operationId,body){
      return this.transaction('readwrite',(store,done,tx)=>{
        const r=store.get(operationId);r.onsuccess=()=>{const e=r.result;if(!e || e.body!==body){tx.abort();return}e.status='uncertain';store.put(e);done(e);};
      });
    }
    setConflict(operationId,body){
      return this.transaction('readwrite',(store,done,tx)=>{
        const r=store.get(operationId);r.onsuccess=()=>{const e=r.result;if(!e || e.body!==body){tx.abort();return}e.status='conflict';store.put(e);done(e);};
      });
    }
    acknowledge(operationId,body){
      return this.transaction('readwrite',(store,done,tx)=>{
        const r=store.get(operationId);r.onsuccess=()=>{const e=r.result;if(!e || e.body!==body){tx.abort();return}store.delete(operationId);done(true);};
      });
    }
    async flush(transport){
      const entries=await this.list();
      for(const entry of entries){
        if(entry.status==='legacy_review' || entry.status==='conflict') continue;
        try{
          if(entry.status==='uncertain'){
            const state=await transport.status(entry.body);
            if(state==='accepted'){await this.acknowledge(entry.operationId,entry.body);continue;}
            if(state==='conflict'){await this.setConflict(entry.operationId,entry.body);continue;}
            if(state!=='absent')continue;
          }
          await this.setUncertain(entry.operationId,entry.body);
          const result=await transport.send(entry.body);
          if(result==='accepted')await this.acknowledge(entry.operationId,entry.body);
          else if(result==='conflict')await this.setConflict(entry.operationId,entry.body);
        }catch(error){
          // A network or storage error leaves the immutable entry for review/retry.
        }
      }
    }
  }
  root.ReceiptOutbox=ReceiptOutbox;
})(globalThis);
