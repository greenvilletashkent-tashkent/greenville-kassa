'use strict';

// Isolated prototype: caller supplies synthetic state and an atomic persist function.
// This module is not connected to the production server.
const crypto = require('crypto');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('invalid value');
  return JSON.stringify(value);
}

function receiptHash(receipt) {
  return crypto.createHash('sha256').update(canonical(receipt)).digest('hex');
}

function payment(receipt,total){
  const pay=receipt.pay || 'cash';
  if(!['cash','card','mixed'].includes(pay))throw new Error('invalid payment method');
  const cashSum=pay==='cash'?total:pay==='card'?0:receipt.cashSum;
  const cardSum=pay==='card'?total:pay==='cash'?0:receipt.cardSum;
  if(!Number.isSafeInteger(cashSum) || !Number.isSafeInteger(cardSum) || cashSum<0 || cardSum<0 || cashSum+cardSum!==total)throw new Error('invalid payment amount');
  return {pay,cashSum,cardSum};
}

function awardBonus(state,sale){
  if(!sale.customerId || sale.bonusGiven)return;
  const customer=(state.customers||[]).find(c=>String(c.id)===String(sale.customerId));
  if(!customer)throw new Error('customer not found');
  const visits=Number(customer.visits||0),spent=Number(customer.spent||0),bonus=Number(customer.bonus||0),rate=Number(state.bonusPct||0);
  if(!Number.isSafeInteger(visits) || !Number.isSafeInteger(spent) || !Number.isSafeInteger(bonus) || !Number.isFinite(rate) || rate<0 || rate>100)throw new Error('invalid customer balance');
  const earned=Math.round(sale.total*rate/100);
  if(!Number.isSafeInteger(visits+1) || !Number.isSafeInteger(spent+sale.total) || !Number.isSafeInteger(bonus+earned))throw new Error('invalid customer balance');
  customer.visits=visits+1;customer.spent=spent+sale.total;customer.bonus=bonus+earned;customer.last=new Date().toISOString().slice(0,10);sale.bonusGiven=true;sale.bonusAwarded=earned;
}

function reverseBonus(state,sale){
  if(!sale.customerId || !sale.bonusGiven)return;
  const customer=(state.customers||[]).find(c=>String(c.id)===String(sale.customerId));
  if(!customer || !Number.isSafeInteger(sale.bonusAwarded) || !Number.isSafeInteger(customer.visits) || !Number.isSafeInteger(customer.spent) || !Number.isSafeInteger(customer.bonus) || customer.visits<1 || customer.spent<sale.total || customer.bonus<sale.bonusAwarded)throw new Error('customer bonus requires reconciliation');
  customer.visits--;customer.spent-=sale.total;customer.bonus-=sale.bonusAwarded;sale.bonusGiven=false;
}

function acceptReceipt(state, receipt, persist, actor = {}) {
  if (!receipt || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.operationId || '')) throw new Error('invalid operation id');
  if(receipt.kind!=null && receipt.kind!=='sale' && receipt.kind!=='park')throw new Error('invalid receipt kind');
  if (!Array.isArray(receipt.items) || !receipt.items.length) throw new Error('empty receipt');
  if (!Array.isArray(state.products) || !Array.isArray(state.sales) || !state.operations || typeof state.operations !== 'object') throw new Error('invalid state');
  const hash = receiptHash(receipt);
  const previous = state.operations[receipt.operationId];
  if (previous) {
    if (previous.actorId && previous.actorId !== actor.id) throw new Error('operation owner conflict');
    if (previous.hash !== hash) throw new Error('operation id conflict');
    return {state, duplicate:true, saleId:previous.saleId};
  }
  if (!Number.isSafeInteger(receipt.total) || receipt.total < 0) throw new Error('invalid total');
  const next = structuredClone(state);
  const seen = new Set();
  const lines = [];
  let cost = 0, unknownGoodsCost = false, unknownServiceCost = false;
  for (const item of receipt.items) {
    if (!item || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !Number.isSafeInteger(item.price) || item.price < 0) throw new Error('invalid item');
    if (item.service === true) {
      lines.push({id:item.productId || 'service',name:String(item.name || 'Услуга'),isService:true,qty:item.quantity,price:item.price});
      unknownServiceCost = true;
      continue;
    }
    if (typeof item.productId !== 'string' || seen.has(item.productId)) throw new Error('invalid product');
    seen.add(item.productId);
    const p = next.products.find(p => p.id === item.productId);
    if (!p || p.deleted || !Number.isSafeInteger(p.stock)) throw new Error('unknown product');
    if (!Number.isSafeInteger(p.cost) || p.cost < 0) unknownGoodsCost = true;
    else cost += p.cost * item.quantity;
    lines.push({id:p.id,name:String(p.name || ''),qty:item.quantity,price:item.price,cost:p.cost,img:p.img,emoji:p.emoji});
    const stock = p.stock - item.quantity;
    if (!Number.isSafeInteger(stock)) throw new Error('invalid stock');
    p.stock = stock;
  }
  const gross = receipt.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(receipt.discount) || receipt.discount < 0 || receipt.discount > gross || receipt.total !== gross - receipt.discount) throw new Error('invalid receipt total');
  const parked=receipt.kind==='park';
  const paid=parked?{pay:'cash',cashSum:0,cardSum:0}:payment(receipt,receipt.total);
  let number=Number(next.counter);
  if(!Number.isSafeInteger(number) || number<1001)number=1001;
  const existing=new Set(next.sales.map(s=>String(s.id)));
  while(existing.has(String(number))){if(number>=Number.MAX_SAFE_INTEGER-1)throw new Error('receipt numbers exhausted');number++;}
  if(number>=Number.MAX_SAFE_INTEGER)throw new Error('receipt numbers exhausted');
  const saleId=String(number);next.counter=number+1;
  const date = typeof receipt.date === 'string' && Number.isFinite(Date.parse(receipt.date)) ? receipt.date : new Date().toISOString();
  const sale={id:saleId,operationId:receipt.operationId,revision:1,date,paidAt:parked?null:date,paid:!parked,
    items:lines,subtotal:gross,total:receipt.total,discountTotal:receipt.discount,discountSum:receipt.discount,
    servicesSum:receipt.items.filter(i=>i.service===true).reduce((sum,i)=>sum+i.price*i.quantity,0),
    cost:unknownGoodsCost?null:cost,profit:(unknownGoodsCost||unknownServiceCost)?null:receipt.total-cost,
    cashier:actor.name || '',byId:actor.id || null,customerId:receipt.customerId?String(receipt.customerId):null,note:receipt.note?structuredClone(receipt.note):null,...paid};
  if(sale.customerId && !(next.customers||[]).some(c=>String(c.id)===sale.customerId))throw new Error('customer not found');
  if(!parked)awardBonus(next,sale);
  next.sales.push(sale);
  next.operations[receipt.operationId] = {hash, saleId, actorId:actor.id || null};
  // A thrown write leaves the caller's original state untouched.
  if (persist(next) === false) throw new Error('persistence failed');
  return {state:next, duplicate:false, saleId};
}

function changeReceipt(state, change, persist, actor={}) {
  if (!change || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(change.operationId || '')) throw new Error('invalid operation id');
  if (!['void','restore','pay','edit','note'].includes(change.kind) || !Number.isSafeInteger(change.revision) || change.revision < 1) throw new Error('invalid change');
  const hash=receiptHash(change), previous=state.operations[change.operationId];
  if(previous){
    if(previous.hash!==hash || (previous.actorId && previous.actorId!==actor.id))throw new Error('operation id conflict');
    return {state,duplicate:true,saleId:previous.saleId};
  }
  const next=structuredClone(state), sale=next.sales.find(s=>String(s.id)===String(change.saleId));
  if(!sale || !sale.operationId)throw new Error('sale not found or legacy sale');
  if(actor.role!=='admin' && String(sale.byId)!==String(actor.id))throw new Error('forbidden');
  if((sale.revision||1)!==change.revision)throw new Error('sale revision conflict');
  if(change.kind==='note'){
    if(change.note!==null && (!change.note || typeof change.note.text!=='string' || change.note.text.length>2000))throw new Error('invalid note');
    sale.note=change.note?{text:change.note.text}:null;sale.noteAt=new Date().toISOString();sale.noteBy=actor.name||'';
    sale.revision=(sale.revision||1)+1;sale.updatedAt=sale.noteAt;
    next.operations[change.operationId]={hash,saleId:String(sale.id),actorId:actor.id||null};
    if(persist(next)===false)throw new Error('persistence failed');
    return {state:next,duplicate:false,saleId:String(sale.id)};
  }
  if(change.kind==='edit'){
    if(sale.deleted || !Array.isArray(change.items) || !change.items.length)throw new Error('invalid sale edit');
    const oldQty=new Map(),newQty=new Map(),lines=[];
    for(const i of sale.items||[]){if(!i.isService)oldQty.set(String(i.id),(oldQty.get(String(i.id))||0)+i.qty);}
    let gross=0,cost=0,unknownGoods=false,unknownService=false,serviceRevenue=0;
    for(const i of change.items){
      if(!i || !Number.isSafeInteger(i.quantity) || i.quantity<=0 || !Number.isSafeInteger(i.price) || i.price<0)throw new Error('invalid item');
      gross+=i.quantity*i.price;if(!Number.isSafeInteger(gross))throw new Error('invalid total');
      if(i.service===true){unknownService=true;serviceRevenue+=i.price*i.quantity;lines.push({id:i.productId||'service',name:String(i.name||'Услуга'),isService:true,qty:i.quantity,price:i.price});continue;}
      if(typeof i.productId!=='string' || newQty.has(i.productId))throw new Error('invalid product');
      const p=next.products.find(p=>String(p.id)===i.productId);if(!p)throw new Error('unknown product');
      newQty.set(i.productId,i.quantity);
      if(!Number.isSafeInteger(p.cost)||p.cost<0)unknownGoods=true;else cost+=p.cost*i.quantity;
      lines.push({id:p.id,name:String(p.name||''),qty:i.quantity,price:i.price,cost:p.cost,img:p.img,emoji:p.emoji});
    }
    if(!Number.isSafeInteger(change.discount) || change.discount<0 || change.discount>gross || change.total!==gross-change.discount)throw new Error('invalid total');
    if(sale.paid && sale.total!==change.total)throw new Error('paid sale total requires payment reconciliation');
    for(const id of new Set([...oldQty.keys(),...newQty.keys()])){
      const p=next.products.find(p=>String(p.id)===id);if(!p || !Number.isSafeInteger(p.stock))throw new Error('invalid stock');
      const stock=p.stock+(oldQty.get(id)||0)-(newQty.get(id)||0);if(!Number.isSafeInteger(stock))throw new Error('invalid stock');p.stock=stock;
    }
    Object.assign(sale,{items:lines,subtotal:gross,discountTotal:change.discount,discountSum:change.discount,total:change.total,
      servicesSum:serviceRevenue,cost:unknownGoods?null:cost,profit:unknownGoods||unknownService?null:change.total-cost,
      revision:(sale.revision||1)+1,updatedAt:new Date().toISOString()});
    next.operations[change.operationId]={hash,saleId:String(sale.id),actorId:actor.id||null};
    if(persist(next)===false)throw new Error('persistence failed');
    return {state:next,duplicate:false,saleId:String(sale.id)};
  }
  if(change.kind==='pay'){
    if(sale.deleted || sale.paid)throw new Error('sale not payable');
    Object.assign(sale,payment(change,sale.total));sale.paid=true;sale.paidAt=new Date().toISOString();sale.date=sale.paidAt;awardBonus(next,sale);
    sale.revision=(sale.revision||1)+1;sale.updatedAt=sale.paidAt;
    next.operations[change.operationId]={hash,saleId:String(sale.id),actorId:actor.id||null};
    if(persist(next)===false)throw new Error('persistence failed');
    return {state:next,duplicate:false,saleId:String(sale.id)};
  }
  const deleting=change.kind==='void';
  if(!!sale.deleted===deleting)throw new Error('sale already in requested state');
  if(deleting)reverseBonus(next,sale);
  else if(sale.paid)awardBonus(next,sale);
  for(const item of sale.items||[]){
    if(item.isService)continue;
    const p=next.products.find(p=>String(p.id)===String(item.id));
    if(!p || !Number.isSafeInteger(p.stock) || !Number.isSafeInteger(item.qty) || item.qty<=0)throw new Error('invalid stock');
    const stock=p.stock+(deleting?item.qty:-item.qty);
    if(!Number.isSafeInteger(stock))throw new Error('invalid stock');
    p.stock=stock;
  }
  sale.deleted=deleting;sale.revision=(sale.revision||1)+1;
  sale.updatedAt=new Date().toISOString();
  if(deleting){sale.deletedAt=sale.updatedAt;sale.deletedBy=actor.name||'';}else{delete sale.deletedAt;delete sale.deletedBy;}
  next.operations[change.operationId]={hash,saleId:String(sale.id),actorId:actor.id||null};
  if(persist(next)===false)throw new Error('persistence failed');
  return {state:next,duplicate:false,saleId:String(sale.id)};
}

function addStock(state, change, persist, actor={}){
  if(actor.role!=='admin')throw new Error('forbidden');
  if(!change || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(change.operationId||''))throw new Error('invalid operation id');
  if(change.kind!=='stock_add' || typeof change.productId!=='string' || !Number.isSafeInteger(change.quantity) || change.quantity<=0)throw new Error('invalid stock change');
  const hash=receiptHash(change),previous=state.operations[change.operationId];
  if(previous){if(previous.hash!==hash || (previous.actorId && previous.actorId!==actor.id))throw new Error('operation id conflict');return {state,duplicate:true};}
  const next=structuredClone(state),p=next.products.find(p=>String(p.id)===change.productId);
  if(!p || !Number.isSafeInteger(p.stock) || !Number.isSafeInteger(p.stock+change.quantity))throw new Error('invalid stock');
  p.stock+=change.quantity;
  next.operations[change.operationId]={hash,actorId:actor.id||null,productId:change.productId};
  if(persist(next)===false)throw new Error('persistence failed');
  return {state:next,duplicate:false};
}

function addCustomer(state,change,persist,actor={}){
  if(!actor.id || !change || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(change.operationId||''))throw new Error('invalid operation id');
  const c=change.customer;
  if(change.kind!=='customer_add' || !c || typeof c.id!=='string' || !c.id || typeof c.name!=='string' || !c.name.trim() || c.name.length>200 || typeof c.phone!=='string' || c.phone.length>100)throw new Error('invalid customer');
  const hash=receiptHash(change),previous=state.operations[change.operationId];
  if(previous){if(previous.hash!==hash || (previous.actorId && previous.actorId!==actor.id))throw new Error('operation id conflict');return {state,duplicate:true};}
  const next=structuredClone(state);if(!Array.isArray(next.customers))next.customers=[];
  if(next.customers.some(existing=>String(existing.id)===c.id))throw new Error('customer id conflict');
  next.customers.push({id:c.id,name:c.name.trim(),phone:c.phone,visits:0,spent:0,bonus:0,last:null});
  next.operations[change.operationId]={hash,actorId:actor.id,customerId:c.id};
  if(persist(next)===false)throw new Error('persistence failed');
  return {state:next,duplicate:false};
}

function saveProduct(state, change, persist, actor={}){
  if(actor.role!=='admin' && actor.role!=='cashier')throw new Error('forbidden');
  if(!change || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(change.operationId||''))throw new Error('invalid operation id');
  const input=change.product;
  if(change.kind!=='product_save' || !input || typeof input.id!=='string' || !input.id || typeof input.name!=='string' || !input.name.trim() || !Number.isSafeInteger(input.price) || input.price<=0 || (input.cost!==null && (!Number.isSafeInteger(input.cost) || input.cost<0)) || !Number.isSafeInteger(change.revision) || change.revision<0)throw new Error('invalid product');
  const hash=receiptHash(change),previous=state.operations[change.operationId];
  if(previous){if(previous.hash!==hash || (previous.actorId && previous.actorId!==actor.id))throw new Error('operation id conflict');return {state,duplicate:true};}
  const next=structuredClone(state),p=next.products.find(p=>String(p.id)===input.id);
  const allowed=['name','cat','img','price','cost','sku','barcode'];
  for(const field of ['cat','img','sku','barcode'])if(input[field]!=null && typeof input[field]!=='string')throw new Error('invalid product field');
  const sku=String(input.sku||'').trim().toLowerCase(), oldSku=String(p&&p.sku||'').trim().toLowerCase();
  if(sku && (!p || sku!==oldSku) && next.products.some(x=>x && String(x.id)!==input.id && String(x.sku||'').trim().toLowerCase()===sku))throw new Error('product sku already exists');
  if(p){
    if((p.catalogRevision||0)!==change.revision)throw new Error('product revision conflict');
    for(const key of allowed)if(Object.hasOwn(input,key) && !(actor.role==='cashier' && key==='cost' && input.cost===null))p[key]=input[key];
    p.catalogRevision=(p.catalogRevision||0)+1;
  }else{
    if(change.revision!==0 || !Number.isSafeInteger(input.stock) || input.stock<0)throw new Error('invalid initial stock');
    const created={id:input.id,stock:input.stock,catalogRevision:1};
    for(const key of allowed)if(Object.hasOwn(input,key))created[key]=input[key];
    next.products.push(created);
  }
  next.operations[change.operationId]={hash,actorId:actor.id||null,productId:input.id};
  if(persist(next)===false)throw new Error('persistence failed');
  return {state:next,duplicate:false};
}

function archiveProduct(state,change,persist,actor={}){
  if(actor.role!=='admin')throw new Error('forbidden');
  if(!change || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(change.operationId||'') || change.kind!=='product_archive' || typeof change.productId!=='string' || !Number.isSafeInteger(change.revision) || change.revision<0)throw new Error('invalid product archive');
  const hash=receiptHash(change),previous=state.operations[change.operationId];
  if(previous){if(previous.hash!==hash || (previous.actorId && previous.actorId!==actor.id))throw new Error('operation id conflict');return {state,duplicate:true};}
  const next=structuredClone(state),p=next.products.find(p=>String(p.id)===change.productId);
  if(!p || p.deleted)throw new Error('product not available');
  if((p.catalogRevision||0)!==change.revision)throw new Error('product revision conflict');
  p.deleted=true;p.catalogRevision=(p.catalogRevision||0)+1;
  next.operations[change.operationId]={hash,actorId:actor.id,productId:change.productId};
  if(persist(next)===false)throw new Error('persistence failed');
  return {state:next,duplicate:false};
}

function importProducts(state,change,persist,actor={}){
  if(actor.role!=='admin')throw new Error('forbidden');
  if(!change || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(change.operationId||'') || change.kind!=='product_import' || !Array.isArray(change.rows) || !change.rows.length || change.rows.length>10000)throw new Error('invalid import');
  const hash=receiptHash(change),previous=state.operations[change.operationId];
  if(previous){if(previous.hash!==hash || (previous.actorId && previous.actorId!==actor.id))throw new Error('operation id conflict');return {state,duplicate:true};}
  const next=structuredClone(state),seen=new Set();
  for(const row of change.rows){
    if(!row || !row.product || typeof row.product.id!=='string' || seen.has(row.product.id) || !['create','update'].includes(row.mode))throw new Error('duplicate or invalid import row');
    seen.add(row.product.id);
    const p=row.product,existing=next.products.find(x=>String(x.id)===p.id);
    if(typeof p.name!=='string' || !p.name.trim() || !Number.isSafeInteger(p.price) || p.price<=0 || (p.cost!==null && (!Number.isSafeInteger(p.cost)||p.cost<0)) || !Number.isSafeInteger(p.stock) || p.stock<0)throw new Error('invalid import product');
    for(const field of ['cat','img','imgUrl','sku','barcode'])if(p[field]!=null && typeof p[field]!=='string')throw new Error('invalid import field');
    if(row.mode==='create'){
      if(existing)throw new Error('product id conflict');
      const name=p.name.trim().replace(/\s+/g,' ').toLowerCase(),sku=String(p.sku||'').trim().toLowerCase();
      if(next.products.some(x=>!x.deleted && ((sku && String(x.sku||'').trim().toLowerCase()===sku) || String(x.name||'').trim().replace(/\s+/g,' ').toLowerCase()===name)))throw new Error('product already exists');
      next.products.push({id:p.id,name:p.name,cat:p.cat||'',img:p.img||'',imgUrl:p.imgUrl||'',emoji:'🌿',price:p.price,cost:p.cost,stock:p.stock,sku:p.sku||'',barcode:p.barcode||'',catalogRevision:1});
    }else{
      if(!existing || existing.deleted || (existing.catalogRevision||0)!==row.revision)throw new Error('product revision conflict');
      if(!Number.isSafeInteger(existing.stock) || !Number.isSafeInteger(existing.stock+p.stock))throw new Error('invalid stock');
      existing.stock+=p.stock;existing.price=p.price;
      if(p.cost!==null)existing.cost=p.cost;
      if(p.barcode)existing.barcode=p.barcode;
      if(p.cat && p.cat!=='Без категории')existing.cat=p.cat;
      existing.catalogRevision=(existing.catalogRevision||0)+1;
    }
  }
  next.operations[change.operationId]={hash,actorId:actor.id,count:change.rows.length};
  if(persist(next)===false)throw new Error('persistence failed');
  return {state:next,duplicate:false};
}

module.exports = {acceptReceipt,changeReceipt,addStock,saveProduct,archiveProduct,importProducts,addCustomer,receiptHash};
