(function(root){
  'use strict';
  const dateTime=value=>{const d=new Date(value);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Tashkent',dateStyle:'short',timeStyle:'medium'}).format(d):String(value||'');};
  function button(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.style.cssText='min-height:48px;padding:10px;margin:5px;font-size:16px';b.onclick=fn;return b;}
  function dialog(title){const wrap=document.createElement('div');wrap.style.cssText='position:fixed;inset:0;z-index:999999;background:#0009;padding:12px;display:grid;place-items:center';const panel=document.createElement('section');panel.style.cssText='background:white;color:#183328;padding:18px;border-radius:12px;width:100%;max-width:560px;max-height:90vh;overflow:auto;box-sizing:border-box';const h=document.createElement('h2');h.textContent=title;panel.append(h);wrap.append(panel);document.body.append(wrap);return {wrap,panel};}
  root.greenvilleCashDialog=async function(load,send,isAdmin){
    const {wrap,panel}=dialog('Наличная касса'),list=document.createElement('div'),status=document.createElement('p');panel.append(status,list,button('Закрыть',()=>wrap.remove()));
    let state;async function refresh(){try{state=await load();status.textContent=state.opened?'Остаток наличных: '+state.balance+' сум':'Касса ещё не открыта';draw();}catch(_){status.textContent='Наличная касса недоступна. Проверьте связь и настройку начального остатка.';}}
    function expenseForm(existing){
      const sub=dialog(existing?'Изменить расход':'Новый расход'),sum=document.createElement('input'),purpose=document.createElement('textarea'),msg=document.createElement('p');
      sum.type='number';sum.min='1';sum.step='1';sum.placeholder='Сумма расхода (сум)';sum.value=existing?existing.amount:'';
      purpose.placeholder='Куда ушли деньги?';purpose.maxLength=2000;purpose.value=existing?existing.purpose:'';
      for(const x of [sum,purpose])x.style.cssText='display:block;width:100%;min-height:48px;margin:10px 0;font-size:16px;box-sizing:border-box';
      sub.panel.append(sum,purpose,msg);const confirm=button('Подтвердить',async()=>{const n=Number(sum.value);if(!Number.isSafeInteger(n)||n<=0||!purpose.value.trim()){msg.textContent='Укажите сумму и назначение расхода.';return;}confirm.disabled=true;
        try{const result=await send(existing?'edit':'create',{amount:n,purpose:purpose.value,expenseId:existing?.id,expectedRevision:existing?.revision});sub.wrap.remove();status.textContent=result==='confirmed'?'Расход подтверждён.':'Расход сохранён в очереди и ожидает подтверждения.';if(result==='confirmed')await refresh();}catch(_){msg.textContent='Не удалось сохранить расход.';confirm.disabled=false;}
      });sub.panel.append(confirm,button('Отмена',()=>sub.wrap.remove()));
    }
    function draw(){list.replaceChildren();if(!state.opened){if(isAdmin)list.append(button('Открыть кассу',()=>{
        const sub=dialog('Открыть наличную кассу'),amount=document.createElement('input'),msg=document.createElement('p');amount.type='number';amount.min='0';amount.step='1';amount.placeholder='Фактический остаток (сум)';amount.style.cssText='width:100%;min-height:48px;font-size:18px';sub.panel.append(amount,msg);
        const submit=button('Подтвердить открытие',async()=>{if(amount.value.trim()===''){msg.textContent='Введите пересчитанную сумму.';return;}const n=Number(amount.value);if(!Number.isSafeInteger(n)||n<0){msg.textContent='Введите целую неотрицательную сумму.';return;}if(!confirm('Подтвердить открытие кассы с остатком '+n+' сум?'))return;submit.disabled=true;try{const result=await send('open',{openingBalance:n});sub.wrap.remove();status.textContent=result==='confirmed'?'Касса открыта.':'Открытие ожидает подтверждения.';if(result==='confirmed')await refresh();}catch(_){msg.textContent='Открытие не подтверждено. Проверьте соединение и очередь.';submit.disabled=false;}});sub.panel.append(submit,button('Отмена',()=>sub.wrap.remove()));
      }));return;}list.append(button('Новый расход',()=>expenseForm(null)));const h=document.createElement('h3');h.textContent='История движения денег';list.append(h);
      for(const m of state.movements){const line=document.createElement('p');line.textContent=[dateTime(m.at),m.purpose,m.by||m.byId||'',(m.amount>0?'+':'')+m.amount+' сум'].filter(Boolean).join(' · ');list.append(line);}
      if(isAdmin){const eh=document.createElement('h3');eh.textContent='Управление расходами';list.append(eh);for(const e of state.expenses||[]){const row=document.createElement('p');row.textContent=dateTime(e.at)+' · '+e.by+' · '+e.amount+' сум · '+e.purpose+(e.cancelled?' · отменён':'');list.append(row);if(!e.cancelled){list.append(button('Изменить',()=>expenseForm(e)),button('Отменить расход',async()=>{if(!confirm('Отменить этот расход?'))return;const result=await send('cancel',{expenseId:e.id,expectedRevision:e.revision});if(result==='confirmed')await refresh();else status.textContent='Отмена ожидает подтверждения.';}));}for(const entry of e.history||[]){const audit=document.createElement('p');audit.textContent=dateTime(entry.at)+' · '+entry.by+' · '+entry.action+' · '+JSON.stringify(entry.before)+' → '+JSON.stringify(entry.after);list.append(audit);}}}
    }
    await refresh();
  };
})(window);
