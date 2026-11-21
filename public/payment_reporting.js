(function(root){
  'use strict';
  function dayKey(value){const d=new Date(value);if(!Number.isFinite(d.getTime()))return '';return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}
  function inPeriod(value,period,now=new Date(),from='',to=''){
    const k=dayKey(value),today=dayKey(now);if(!k||!today)return false;if(period==='all')return true;
    const shift=n=>{const d=new Date(today+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
    if(period==='today')return k===today;if(period==='yesterday')return k===shift(-1);
    if(period==='custom')return !!from&&!!to&&from<=to&&k>=from&&k<=to;
    return k>=shift(period==='week'?-6:-29)&&k<=today;
  }
  function revenueEvents(sales){
    const events=[],uncertain=[];
    for(const s of sales){
      if(!s || s.paid===false)continue;
      const history=Array.isArray(s.financialEvents)?s.financialEvents:[];
      if((s.deleted && !history.length) || (history.length && history[0].kind!=='void')){uncertain.push(s.id);continue;}
      const base=history.length?history[0].snapshot:s;
      const event=(data,at,sign)=>({ ...s,...data,date:at,total:(data.total||0)*sign,cost:data.cost==null?null:data.cost*sign,profit:data.profit==null?null:data.profit*sign,subtotal:(data.subtotal||0)*sign,discountTotal:data.discountTotal==null?null:data.discountTotal*sign,items:(data.items||[]).map(i=>({...i,qty:i.qty*sign})),eventSign:sign });
      events.push(event(base,s.date,1));
      for(const e of history)if((e.kind==='void'||e.kind==='restore') && e.snapshot && e.at)events.push(event(e.snapshot,e.at,e.kind==='void'?-1:1));
    }
    return {events,uncertain};
  }
  function summarize(sales,inPeriod){
    const out={cash:0,terminal:0,owner_card:0,debt:0,repayments:0,unknown:0};
    const put=(p,mult)=>{for(const k of ['cash','terminal','owner_card','debt'])out[k]+=mult*(Number(p[k])||0);};
    for(const s of sales){
      if(!s || s.paid===false || (s.deleted && !(s.financialEvents||[]).length))continue;
      if(s.payments){
        const corrections=s.debtCorrections||[];
        const first=corrections.find(c=>c.action==='correct_initial');
        if(inPeriod(s.date))put(first?first.before.payments:s.payments,1);
        for(const c of corrections){
          if(!inPeriod(c.at))continue;
          if(c.action==='correct_initial'){put(c.before.payments,-1);put(c.after.payments,1);}
          if(c.action==='reverse_repayment'){
            const p=(s.debtPayments||[]).find(x=>x.operationId===c.paymentId);
            if(p){out[p.method]-=p.amount;out.repayments-=p.amount;}
          }
        }
        for(const p of s.debtPayments||[]){if(inPeriod(p.at) && ['cash','terminal','owner_card'].includes(p.method)){out[p.method]+=p.amount;out.repayments+=p.amount;}}
        for(const e of s.financialEvents||[])if(inPeriod(e.at) && Number.isSafeInteger(e.debtDelta))out.debt+=e.debtDelta;
      }else if(inPeriod(s.date)){
        if(s.pay==='cash'||!s.pay)out.cash+=s.total||0;
        else if(s.pay==='card')out.terminal+=s.total||0;
        else if(s.pay==='mixed'){out.cash+=s.cashSum||0;out.terminal+=s.cardSum||0;}
        else out.unknown+=s.total||0;
      }
    }
    return out;
  }
  function refundTotals(sales,period){const result={cash:0,terminal:0,owner_card:0};for(const s of sales)for(const r of s.refunds||[])if(period(r.at))for(const k of Object.keys(result))result[k]+=r.amounts[k]||0;return result;}
  function expenseEvents(expenses){
    const events=[];
    for(const e of expenses){
      const history=e.history||[],first=history[0];
      events.push({at:e.at,amount:first?first.before.amount:e.amount,purpose:first?first.before.purpose:e.purpose,byId:e.byId,by:e.by,kind:'create',expenseId:e.id});
      for(const h of history){const before=h.before.cancelled?0:h.before.amount,after=h.after.cancelled?0:h.after.amount;events.push({at:h.at,amount:after-before,purpose:h.after.purpose,byId:h.byId,by:h.by,kind:h.action,expenseId:e.id});}
    }
    return events;
  }
  function knownCost(cost){return Number.isSafeInteger(cost) && cost>=0;}
  function missingCostProducts(events,products){
    const catalog=new Map((products||[]).map(p=>[String(p.id),p])),rows=new Map();
    for(const event of events||[]){
      const items=event.items||[],sign=event.eventSign===-1?-1:1;
      const gross=items.map(i=>Number.isSafeInteger(i.qty)&&Number.isSafeInteger(i.price)&&i.price>=0&&i.qty*sign>=0&&Number.isSafeInteger(i.qty*i.price)?Math.abs(i.qty*i.price):null);
      const sum=gross.every(v=>v!==null)?gross.reduce((a,b)=>a+b,0):NaN,total=event.total*sign;
      let allocated=null;
      if(Number.isSafeInteger(sum)&&Number.isSafeInteger(total)&&total>=0&&total<=sum && (sum>0||total===0)){
        if(sum===0)allocated=gross.map(()=>0);
        else {const den=BigInt(sum),t=BigInt(total),parts=gross.map((g,index)=>{const n=BigInt(g)*t;return {index,value:Number(n/den),remainder:n%den};});let left=total-parts.reduce((n,p)=>n+p.value,0);for(const p of [...parts].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1)){if(left--<=0)break;p.value++;}allocated=parts.map(p=>p.value*sign);}
      }
      for(const [index,item] of items.entries()){
      if(item.isService || knownCost(item.cost))continue;
      const id=item.id==null?'':String(item.id),key=id||'unknown:'+String(item.name||'');
      const product=catalog.get(id),row=rows.get(key)||{id,name:String(item.name||product?.name||'Товар'),sku:String(product?.sku||''),quantity:0,revenue:0,editable:!!product&&!product.deleted};
      const qty=Number(item.qty),price=Number(item.price);if(!Number.isFinite(qty)||!Number.isFinite(price))continue;
      row.quantity+=qty;if(allocated===null)row.revenue=null;else if(row.revenue!==null)row.revenue+=allocated[index];rows.set(key,row);
      }
    }
    return [...rows.values()].filter(row=>row.quantity!==0||row.revenue===null||row.revenue!==0);
  }
  root.greenvillePaymentReporting={summarize,revenueEvents,refundTotals,expenseEvents,dayKey,inPeriod,knownCost,missingCostProducts};
  if(typeof module!=='undefined')module.exports={summarize,revenueEvents,refundTotals,expenseEvents,dayKey,inPeriod,knownCost,missingCostProducts};
})(typeof globalThis!=='undefined'?globalThis:this);
