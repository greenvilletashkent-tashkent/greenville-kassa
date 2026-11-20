'use strict';
const {expenseEvents}=require('../public/payment_reporting');
function cashRegister(state){
  const reg=state.cashRegister;
  if(!reg || !Number.isSafeInteger(reg.openingBalance) || reg.openingBalance<0 || !Number.isFinite(Date.parse(reg.openedAt)))throw Error('cash register not initialized');
  const from=Date.parse(reg.openedAt), movements=[{at:reg.openedAt,kind:'opening',amount:reg.openingBalance,purpose:'Начальный остаток',by:reg.openedBy||'',byId:reg.openedById||'',operationId:reg.operationId||null}];
  const push=(sale,at,kind,amount,purpose,by)=>{if(amount && Number.isFinite(Date.parse(at)) && Date.parse(at)>=from)movements.push({at,kind,amount,purpose,saleId:sale.id,by:by||sale.cashier||''});};
  for(const sale of state.sales||[]){
    if(sale.paid===false)continue;
    const baseline=reg.baselineSales?.[String(sale.id)]||{},corrections=sale.debtCorrections||[],repayments=sale.debtPayments||[],refunds=sale.refunds||[];
    const first=corrections.find(c=>c.action==='correct_initial');
    const initial=sale.payments?(first?first.before.payments.cash:sale.payments.cash):(sale.pay==='mixed'?sale.cashSum:(sale.pay==='cash'||!sale.pay?sale.total:0));
    if(!baseline.paid)push(sale,sale.cashReceivedAt||sale.date,'sale',Number(initial)||0,'Продажа наличными');
    for(const p of repayments.slice(baseline.repayments||0))if(p.method==='cash')push(sale,p.at,'debt_payment',p.amount,'Погашение долга',p.byId);
    for(const c of corrections.slice(baseline.corrections||0)){
      if(c.action==='correct_initial')push(sale,c.at,'correction',(c.after.payments.cash||0)-(c.before.payments.cash||0),'Исправление оплаты',c.byId);
      if(c.action==='reverse_repayment'){const p=repayments.find(x=>x.operationId===c.paymentId);if(p?.method==='cash')push(sale,c.at,'correction',-p.amount,'Отмена погашения',c.byId);}
    }
    for(const r of refunds.slice(baseline.refunds||0))push(sale,r.at,'refund',-(r.amounts.cash||0),'Возврат наличных',r.by||r.byId);
  }
  for(const e of expenseEvents(state.expenses||[]))if(Number.isFinite(Date.parse(e.at)) && Date.parse(e.at)>=from)movements.push({...e,kind:'expense_'+e.kind,amount:-e.amount});
  movements.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  const balance=movements.reduce((n,m)=>n+m.amount,0);if(!Number.isSafeInteger(balance))throw Error('invalid cash balance');
  return {balance,movements};
}
module.exports={cashRegister};
