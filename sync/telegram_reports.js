'use strict';
const {summarize,revenueEvents,refundTotals,expenseEvents,inPeriod}=require('../public/payment_reporting');
const {cashRegister}=require('./cash_register');
const keyboard={keyboard:[[{text:'Сегодня'},{text:'Вчера'}],[{text:'7 дней'},{text:'30 дней'}],[{text:'Наличная касса'},{text:'Расходы'}],[{text:'Продажи'},{text:'Долги'}],[{text:'Обновить'}]],resize_keyboard:true};
function ownerIds(value){return new Set(String(value||'').split(',').map(x=>x.trim()).filter(x=>/^\d+$/.test(x)));}
function report(state,choice,now){
 const periods={'Сегодня':'today','Вчера':'yesterday','7 дней':'week','30 дней':'month'},period=periods[choice]||'today',include=v=>inPeriod(v,period,now);
 const events=revenueEvents(state.sales||[]).events.filter(e=>include(e.date)),payment=summarize(state.sales||[],include),refunds=refundTotals(state.sales||[],include),expenses=expenseEvents(state.expenses||[]).filter(e=>include(e.at));
 if(choice==='Наличная касса'){try{const cash=cashRegister(state);return 'Наличная касса: '+cash.balance+' сум';}catch(_){return 'Наличная касса ещё не открыта.';}}
 if(choice==='Расходы')return ['Расходы сегодня: '+expenses.reduce((n,e)=>n+e.amount,0)+' сум',...expenses.map(e=>e.purpose+' · '+e.amount+' сум')].join('\n');
 if(choice==='Долги')return ['Открытые долги:',...(state.sales||[]).filter(s=>!s.deleted && s.debtOutstanding>0).map(s=>{const c=(state.customers||[]).find(x=>String(x.id)===String(s.customerId));return String(c?.name||'Покупатель')+' · '+s.debtOutstanding+' сум';})].join('\n');
 if(choice==='Продажи')return ['Продажи сегодня:',...events.map(s=>'Чек №'+s.id+' · '+s.total+' сум')].join('\n');
 const revenue=events.reduce((n,e)=>n+(e.total||0),0),unknownCost=events.some(x=>x.cost==null||(x.items||[]).some(i=>!i.isService&&i.cost==null)),unknownProfit=unknownCost||events.some(x=>x.profit==null||(x.items||[]).some(i=>i.isService));
 const cost=unknownCost?null:events.reduce((n,x)=>n+x.cost,0),profit=unknownProfit?null:events.reduce((n,x)=>n+x.profit,0);
 return [choice,'Выручка: '+revenue+' сум','Продаж с учётом отмен: '+events.reduce((n,e)=>n+(e.eventSign||1),0),'Себестоимость: '+(cost===null?'Неизвестна':cost+' сум'),'Валовая прибыль: '+(profit===null?'Неизвестна':profit+' сум'),'Наличные поступления: '+payment.cash+' сум','Терминал: '+payment.terminal+' сум','Карта руководителя: '+payment.owner_card+' сум','Долги: '+payment.debt+' сум','Погашения в составе поступлений: '+payment.repayments+' сум','Возвраты: '+(refunds.cash+refunds.terminal+refunds.owner_card)+' сум','Расходы: '+expenses.reduce((n,e)=>n+e.amount,0)+' сум'].join('\n');
}
function handleUpdate(state,update,allowed,now,enqueue){
 if(!Number.isSafeInteger(update?.update_id))return false;
 const m=update.message,uid=String(m?.from?.id||''),chat=String(m?.chat?.id||'');
 if(m?.chat?.type!=='private' || uid!==chat || !allowed.has(uid))return false;
 const input=String(m.text||'').trim(),choices=['Сегодня','Вчера','7 дней','30 дней','Наличная касса','Расходы','Продажи','Долги'];
 state.telegramSelections=state.telegramSelections||{};
 let choice=input==='Обновить'?(state.telegramSelections[uid]||'Сегодня'):input;
 if(!choices.includes(choice))choice='Сегодня';state.telegramSelections[uid]=choice;
 const text=report(state,choice,now);return enqueue(state,{id:'telegram_update:'+update.update_id,text,destination:chat,replyMarkup:keyboard});
}
module.exports={ownerIds,report,handleUpdate};
