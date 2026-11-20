'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{summarize,revenueEvents,refundTotals,dayKey,inPeriod}=require('../public/payment_reporting');
test('daily reconciliation: mixed sale, debt, repayments, refunds, void and restore',()=>{
 const snap={total:300000,cost:100000,profit:200000,items:[{id:'p',qty:1,price:300000}]};
 const sale={...snap,id:'s',paid:true,date:'2026-10-31T19:00:00Z',payments:{cash:100000,terminal:100000,owner_card:50000,debt:50000},debtOutstanding:0,debtPayments:[{operationId:'p1',at:'2026-11-01T19:00:00Z',method:'terminal',amount:20000},{operationId:'p2',at:'2026-11-02T19:00:00Z',method:'cash',amount:30000}],refunds:[{at:'2026-11-01T19:00:00Z',amounts:{cash:40000,terminal:30000,owner_card:0}},{at:'2026-11-02T19:00:00Z',amounts:{cash:0,terminal:0,owner_card:10000}}],financialEvents:[{kind:'void',at:'2026-11-03T19:00:00Z',snapshot:snap},{kind:'restore',at:'2026-11-04T19:00:00Z',snapshot:snap}]};
 const rows=[
  ['2026-11-01',300000,[100000,100000,50000,50000,0],[0,0,0]],
  ['2026-11-02',0,[0,20000,0,0,20000],[40000,30000,0]],
  ['2026-11-03',0,[30000,0,0,0,30000],[0,0,10000]],
  ['2026-11-04',-300000,[0,0,0,0,0],[0,0,0]],
  ['2026-11-05',300000,[0,0,0,0,0],[0,0,0]]
 ];
 for(const [day,revenue,payments,refunds] of rows){const includes=x=>dayKey(x)===day;const totals=summarize([sale],includes),r=refundTotals([sale],includes);assert.equal(revenueEvents([sale]).events.filter(e=>includes(e.date)).reduce((sum,e)=>sum+e.total,0),revenue);assert.deepEqual([totals.cash,totals.terminal,totals.owner_card,totals.debt,totals.repayments],payments);assert.deepEqual([r.cash,r.terminal,r.owner_card],refunds);}
});
test('Tashkent day and rolling period boundaries',()=>{
 const now=new Date('2026-11-19T12:00:00Z');assert.equal(dayKey('2026-11-18T19:00:00Z'),'2026-11-19');assert.equal(dayKey('2026-11-18T18:59:59Z'),'2026-11-18');
 assert.equal(inPeriod('2026-11-18T19:00:00Z','today',now),true);assert.equal(inPeriod('2026-11-18T18:59:59Z','yesterday',now),true);
 assert.equal(inPeriod('2026-11-12T19:00:00Z','week',now),true);assert.equal(inPeriod('2026-11-12T18:59:59Z','week',now),false);
 assert.equal(inPeriod('2026-10-20T19:00:00Z','month',now),true);assert.equal(inPeriod('2026-10-20T18:59:59Z','month',now),false);
});
test('mixed payment and next-day partial refunds remain distinct from revenue',()=>{
 const s={date:'2026-11-18T08:00:00Z',total:300000,paid:true,payments:{cash:100000,terminal:150000,owner_card:50000,debt:0},refunds:[{at:'2026-11-19T08:00:00Z',amounts:{cash:40000,terminal:30000,owner_card:0}}]};
 const day=d=>x=>dayKey(x)===d;
 assert.deepEqual(summarize([s],day('2026-11-18')),{cash:100000,terminal:150000,owner_card:50000,debt:0,repayments:0,unknown:0});
 assert.deepEqual(refundTotals([s],day('2026-11-19')),{cash:40000,terminal:30000,owner_card:0});
 assert.equal(revenueEvents([s]).events.filter(e=>day('2026-11-19')(e.date)).length,0);
});
test('sale, cancellation and restoration remain in their actual periods',()=>{
 const snapshot={total:300,cost:100,profit:200,items:[{id:'p',qty:1,price:300}],cashier:'A'};
 const sale={...snapshot,id:'1',paid:true,date:'2026-11-01T10:00:00Z',payments:{cash:100,terminal:150,owner_card:0,debt:50},debtPayments:[{operationId:'p',method:'cash',amount:20,at:'2026-11-02T12:00:00Z'}],financialEvents:[{kind:'void',at:'2026-11-02T10:00:00Z',snapshot},{kind:'restore',at:'2026-11-03T10:00:00Z',snapshot}]};
 const day=(events,d)=>events.filter(e=>e.date.startsWith(d)).reduce((n,e)=>n+e.total,0);
 const before=revenueEvents([{...sale,financialEvents:[]}]).events;
 const afterVoid=revenueEvents([{...sale,deleted:true,financialEvents:sale.financialEvents.slice(0,1)}]).events;
 const restored=revenueEvents([sale]).events;
 assert.equal(day(before,'2026-11-01'),300);assert.equal(day(afterVoid,'2026-11-01'),300);assert.equal(day(restored,'2026-11-01'),300);
 assert.equal(day(afterVoid,'2026-11-02'),-300);assert.equal(day(restored,'2026-11-03'),300);
 assert.equal(summarize([sale],d=>d.startsWith('2026-11-02')).cash,20);
 assert.equal(revenueEvents([{...sale,deleted:true,financialEvents:[]}]).uncertain.length,1);
});
test('mixed sale and repayment are separated; old cash/card stay compatible',()=>{
 const sales=[{date:'2026-01-01',total:300,paid:true,payments:{cash:100,terminal:150,owner_card:0,debt:50},debtPayments:[{operationId:'x',method:'owner_card',amount:50,at:'2026-01-02'}]},{date:'2026-01-01',total:20,pay:'cash'},{date:'2026-01-01',total:30,pay:'card'}];
 assert.deepEqual(summarize(sales,()=>true),{cash:120,terminal:180,owner_card:50,debt:50,repayments:50,unknown:0});
 assert.deepEqual(summarize(sales,d=>d==='2026-01-02'),{cash:0,terminal:0,owner_card:50,debt:0,repayments:50,unknown:0});
});
test('payment reversal and correction are reported on their own dates',()=>{
 const initial={cash:100,terminal:0,owner_card:0,debt:200},later={cash:0,terminal:100,owner_card:0,debt:200};
 const sale={date:'2026-01-01',total:300,payments:later,debtPayments:[{operationId:'x',method:'cash',amount:50,at:'2026-01-02'}],debtCorrections:[{action:'correct_initial',at:'2026-01-03',before:{payments:initial},after:{payments:later}},{action:'reverse_repayment',paymentId:'x',at:'2026-01-04'}]};
 assert.deepEqual(summarize([sale],()=>true),{cash:0,terminal:100,owner_card:0,debt:200,repayments:0,unknown:0});
 assert.deepEqual(summarize([sale],d=>d==='2026-01-04'),{cash:-50,terminal:0,owner_card:0,debt:0,repayments:-50,unknown:0});
});
