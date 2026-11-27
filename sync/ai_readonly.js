'use strict';
// A separate credential, accepted only by the integration GET route.
const crypto=require('crypto');
function authorized(header,key){
  if(typeof key!=='string'||!/^[a-f0-9]{64}$/i.test(key)||typeof header!=='string'||!header.startsWith('Bearer '))return false;
  const digest=x=>crypto.createHash('sha256').update(x,'utf8').digest();
  return crypto.timingSafeEqual(digest(header.slice(7)),digest(key));
}
function pick(value,keys){const out={};if(value&&typeof value==='object'&&!Array.isArray(value))for(const key of keys)if(Object.hasOwn(value,key))out[key]=value[key];return out;}
const itemKeys=['id','name','qty','price','cost','isService'];
const saleKeys=['id','date','paid','paidAt','deleted','deletedAt','voided','total','subtotal','discountPct','discountSum','discountTotal','cost','profit','servicesSum','servicesQty','updatedAt','editedAt'];
const productKeys=['id','name','sku','barcode','cat','price','cost','stock','deleted'];
function item(i){return pick(i,itemKeys)}
function sale(s){const out=pick(s,saleKeys);out.items=Array.isArray(s?.items)?s.items.map(item):[];return out}
function snapshot(db){
 const products=(Array.isArray(db.products)?db.products:[]).map(p=>({...pick(p,productKeys),deleted:!!(p?.deleted||(db._gvDeletedProducts||{})[String(p?.id)])}));
 const sales=(Array.isArray(db.sales)?db.sales:[]).map(s=>{const out=sale(s);out.financialEvents=(Array.isArray(s?.financialEvents)?s.financialEvents:[]).map(e=>({...pick(e,['kind','at']),snapshot:sale(e?.snapshot)}));out.refunds=(Array.isArray(s?.refunds)?s.refunds:[]).map(r=>({...pick(r,['at']),amounts:pick(r?.amounts,['cash','terminal','owner_card'])}));return out});
 const payload={schema:1,products,sales};const revision=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 return {...payload,revision,observed_at:new Date().toISOString()};
}
module.exports={authorized,snapshot};
