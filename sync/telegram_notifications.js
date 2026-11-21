'use strict';
// No credentials are stored in notification records.
const {summarize,revenueEvents,refundTotals,expenseEvents,dayKey}=require('../public/payment_reporting');
const {cashRegister}=require('./cash_register');
const money=n=>Number.isSafeInteger(n)?String(n)+' сум':'Неизвестно';
const date=at=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Tashkent',dateStyle:'short',timeStyle:'medium'}).format(new Date(at));
const methods={cash:'Наличные',terminal:'Терминал',owner_card:'Карта руководителя',debt:'Долг'};
function paymentLines(s){
 if(s.payments)return Object.entries(methods).filter(([k])=>s.payments[k]>0).map(([k,v])=>v+': '+money(s.payments[k]));
 return ['Оплата: '+String(s.pay||'не указана')];
}
function reliableProfit(s){return Number.isSafeInteger(s.profit) && Array.isArray(s.items) && s.items.length>0 && s.items.every(i=>!i.isService && Number.isSafeInteger(i.cost) && i.cost>0);}
function buildEvent(kind,op,state,actor){
 const sale=state.sales?.find(s=>String(s.id)===String(state.operations?.[op.operationId]?.saleId));
 if(kind==='sale'){
  if(!sale || sale.paid===false)return null;
  const lines=['Продажа №'+sale.id+' · '+date(sale.paidAt||sale.date),'Сотрудник: '+String(actor.name||actor.id),...(sale.items||[]).map(i=>String(i.name)+' × '+i.qty),'Итого: '+money(sale.total),...paymentLines(sale),'Себестоимость: '+money(reliableProfit(sale)?sale.cost:null),'Валовая прибыль: '+money(reliableProfit(sale)?sale.profit:null)];
  if(sale.payments?.debt>0){const customer=(state.customers||[]).find(c=>String(c.id)===String(sale.customerId));lines.push('Новый долг: '+money(sale.payments.debt)+' · '+String(customer?.name||'покупатель не указан'));}
  return {id:'sale:'+op.operationId,text:lines.join('\n')};
 }
 if(kind==='sale_change' && sale && sale.paid!==false && ['void','restore','edit'].includes(op.kind))return {id:'sale_change:'+op.operationId,text:[({void:'Отмена продажи',restore:'Восстановление продажи',edit:'Исправление продажи'})[op.kind]+' №'+sale.id,'Сотрудник: '+String(actor.name||actor.id),date(sale.updatedAt),'Итого: '+money(sale.total)].join('\n')};
 if(kind==='expense' && op.action!=='create'){
  const e=(state.expenses||[]).find(x=>x.id===op.expenseId),h=e?.history?.find(x=>x.operationId===op.operationId);if(!h)return null;
  return {id:'expense_change:'+op.operationId,text:[op.action==='cancel'?'Отмена расхода':'Исправление расхода','Сотрудник: '+String(actor.name||actor.id),date(h.at),'Было: '+money(h.before.amount)+' · '+h.before.purpose,'Стало: '+(h.after.cancelled?'отменён':money(h.after.amount)+' · '+h.after.purpose)].join('\n')};
 }
 if(kind==='refund' && sale){const r=(sale.refunds||[]).find(x=>x.operationId===op.operationId);if(!r)return null;return {id:'refund:'+op.operationId,text:['Возврат по чеку №'+sale.id,'Сотрудник: '+String(actor.name||actor.id),date(r.at),...Object.entries(r.amounts).filter(([,v])=>v>0).map(([k,v])=>methods[k]+': '+money(v)),'Причина: '+r.reason].join('\n')};}
 if(kind==='debt_correction' && sale){const c=(sale.debtCorrections||[]).find(x=>x.operationId===op.operationId);if(!c)return null;return {id:'debt_correction:'+op.operationId,text:['Исправление оплаты по чеку №'+sale.id,'Сотрудник: '+String(actor.name||actor.id),date(c.at),'Причина: '+c.reason,'Остаток долга: '+money(c.after.debtOutstanding)].join('\n')};}
 if(kind==='expense' && op.action==='create'){
  const e=(state.expenses||[]).find(x=>x.id===op.operationId);if(!e)return null;
  let balance='Неизвестен';try{balance=money(cashRegister(state).balance);}catch(_){}
  return {id:'expense:'+op.operationId,text:['Расход: '+money(e.amount),'Назначение: '+e.purpose,'Сотрудник: '+String(actor.name||actor.id),date(e.at),'Остаток наличных: '+balance].join('\n')};
 }
 if(kind==='debt_payment'){
  if(!sale)return null;const pay=(sale.debtPayments||[]).find(p=>p.operationId===op.operationId);if(!pay)return null;
  const customer=(state.customers||[]).find(c=>String(c.id)===String(sale.customerId));
  return {id:'debt_payment:'+op.operationId,text:[sale.debtOutstanding===0?'Долг погашен':'Частичное погашение долга','Покупатель: '+String(customer?.name||'не указан'),'Платёж: '+money(pay.amount)+' · '+(methods[pay.method]||pay.method),'Остаток долга: '+money(sale.debtOutstanding),'Сотрудник: '+String(actor.name||actor.id),date(pay.at)].join('\n')};
 }
 return null;
}
function enqueue(state,event){
 if(!event)return false;if(typeof event.id!=='string'||typeof event.text!=='string'||!event.id||!event.text)throw Error('invalid notification');
 state.telegramOutbox=state.telegramOutbox||[];if(state.telegramOutbox.some(x=>x.eventId===event.id || x.id===event.id))return false;
 const chars=Array.from(event.text),chunks=[];for(let i=0;i<chars.length;i+=1800)chunks.push(chars.slice(i,i+1800).join(''));
 chunks.forEach((text,i)=>state.telegramOutbox.push({id:chunks.length===1?event.id:event.id+':'+(i+1),eventId:event.id,type:event.id.split(':')[0],createdAt:new Date().toISOString(),text:chunks.length===1?text:'Часть '+(i+1)+'/'+chunks.length+'\n'+text,...(event.destination?{destination:event.destination}:{}),...(event.replyMarkup?{replyMarkup:event.replyMarkup}:{}),status:'pending',attempts:0}));return true;
}
function resolveUncertain(state,id,decision,actor,decisionId){
 if(!actor?.id || actor.role!=='admin')throw Error('forbidden');
 if(!['delivered','retry'].includes(decision) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decisionId||''))throw Error('invalid decision');
 const event=(state.telegramOutbox||[]).find(x=>x.id===id);if(!event)throw Error('notification missing');
 const history=event.reviewHistory||[];const previous=history.find(x=>x.id===decisionId);
 if(previous){if(previous.decision!==decision||previous.byId!==actor.id)throw Error('decision conflict');return false;}
 if(event.status!=='uncertain')throw Error('notification not uncertain');
 event.reviewHistory=[...history,{id:decisionId,at:new Date().toISOString(),byId:actor.id,decision}];event.status=decision==='delivered'?'sent':'pending';return true;
}
function daily(state,day){
 const cutoff=Date.parse(day+'T16:00:00.000Z');if(!Number.isFinite(cutoff))throw Error('invalid report day');
 const include=v=>dayKey(v)===day && Date.parse(v)<=cutoff,events=revenueEvents(state.sales||[]).events.filter(e=>include(e.date)),sums=summarize(state.sales||[],include),refunds=refundTotals(state.sales||[],include),expenses=expenseEvents(state.expenses||[]).filter(e=>include(e.at));
 const revenue=events.reduce((n,e)=>n+(e.total||0),0),count=events.reduce((n,e)=>n+(e.eventSign||1),0);
 // Old edits do not carry enough snapshots to recover their original cost.
 const historicalEditUnknown=(state.sales||[]).some(s=>include(s.date) && Number.isFinite(Date.parse(s.updatedAt)) && Date.parse(s.updatedAt)>cutoff);
 const unknownCost=historicalEditUnknown||events.some(x=>x.cost==null||(x.items||[]).some(i=>!i.isService&&(!Number.isSafeInteger(i.cost)||i.cost<=0))),unknownProfit=unknownCost||events.some(x=>!reliableProfit(x));
 const cost=unknownCost?null:events.reduce((n,e)=>n+e.cost,0),profit=unknownProfit?null:events.reduce((n,e)=>n+e.profit,0);
 let debt=0,debtUnknown=false;
 for(const s of state.sales||[]){
  if(!s.payments || !Number.isFinite(Date.parse(s.date)) || Date.parse(s.date)>cutoff)continue;
  if(s.deleted && !(s.financialEvents||[]).length){debtUnknown=true;continue;}
  const corrections=s.debtCorrections||[],first=corrections.find(c=>c.action==='correct_initial');let value=first?first.before.payments.debt:s.payments.debt;
  for(const p of s.debtPayments||[])if(Date.parse(p.at)<=cutoff)value-=p.amount;
  for(const c of corrections)if(Date.parse(c.at)<=cutoff){if(c.action==='correct_initial')value+=c.after.payments.debt-c.before.payments.debt;else if(c.action==='reverse_repayment'){const p=(s.debtPayments||[]).find(x=>x.operationId===c.paymentId);if(p)value+=p.amount;else debtUnknown=true;}}
  for(const event of s.financialEvents||[])if(Date.parse(event.at)<=cutoff)value+=event.debtDelta||0;
  if(!Number.isSafeInteger(value)||value<0)debtUnknown=true;else debt+=value;
 }
 const newDebt=(state.sales||[]).filter(s=>s.paid!==false && include(s.date)).reduce((n,s)=>{const first=(s.debtCorrections||[]).find(c=>c.action==='correct_initial');return n+(first?first.before.payments.debt:(s.payments?.debt||0));},0);
 let cash='Неизвестен',cashStart='Неизвестен',cashIn='Неизвестны',cashExpenses='Неизвестны',cashOther='Неизвестны';try{const m=cashRegister(state).movements,start=Date.parse(day+'T00:00:00+05:00'),opened=Date.parse(state.cashRegister.openedAt);if(opened<=cutoff){cash=money(m.filter(x=>Date.parse(x.at)<=cutoff).reduce((n,x)=>n+x.amount,0));if(opened<=start)cashStart=money(m.filter(x=>Date.parse(x.at)<start || (x.kind==='opening'&&Date.parse(x.at)===start)).reduce((n,x)=>n+x.amount,0));const dayMoves=m.filter(x=>Date.parse(x.at)>=start&&Date.parse(x.at)<=cutoff);cashIn=money(dayMoves.filter(x=>x.kind==='sale'||x.kind==='debt_payment').reduce((n,x)=>n+x.amount,0));cashExpenses=money(-dayMoves.filter(x=>x.kind.startsWith('expense_')).reduce((n,x)=>n+x.amount,0));cashOther=money(dayMoves.filter(x=>x.kind==='refund'||x.kind==='correction'||(x.kind==='opening'&&opened>start)).reduce((n,x)=>n+x.amount,0));}}catch(_){}
 const lines=['Итог за '+day+' на 21:00 (Ташкент)','Выручка: '+money(revenue),'Количество продаж с учётом отмен: '+count,'Себестоимость: '+money(cost),'Валовая прибыль: '+money(profit),'Наличные поступления: '+money(sums.cash),'Терминал: '+money(sums.terminal),'Карта руководителя: '+money(sums.owner_card),'Новые долги: '+money(newDebt),'Погашения долгов (в составе поступлений): '+money(sums.repayments),'Возвраты: '+money(refunds.cash+refunds.terminal+refunds.owner_card),'Расходы: '+money(expenses.reduce((n,e)=>n+e.amount,0)),...expenses.map(e=>e.purpose+': '+money(e.amount)),'Наличные на начало дня: '+cashStart,'Наличные от продаж и погашений: '+cashIn,'Расходы из наличной кассы: '+cashExpenses,'Прочие движения наличных: '+cashOther,'Остаток наличных на 21:00: '+cash,'Задолженность на 21:00: '+(debtUnknown?'Неизвестна':money(debt))];
 return {id:'daily:'+day,text:lines.join('\n')};
}
function dueDaily(now){const hour=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tashkent',hour:'2-digit',hourCycle:'h23'}).format(now);return Number(hour)>=21?dayKey(now):null;}
function scheduleDaily(state,now){
 const today=dayKey(now);if(!state.telegramNextDaily)state.telegramNextDaily=today;
 const shift=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
 const last=dueDaily(now)||shift(today,-1);let changed=false;
 for(let i=0;i<31 && state.telegramNextDaily<=last;i++){
  const day=state.telegramNextDaily;enqueue(state,daily(state,day));state.telegramNextDaily=shift(day,1);changed=true;
 }
 // Persist the activation cursor even before the first scheduled report.
 if(!state.telegramScheduleInitialized){state.telegramScheduleInitialized=true;changed=true;}return changed;
}
module.exports={buildEvent,enqueue,resolveUncertain,daily,dueDaily,scheduleDaily};
