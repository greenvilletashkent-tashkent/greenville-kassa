(function(root){
  'use strict';
  const labels={cash:'Наличные',terminal:'Банковский терминал',owner_card:'Карта руководителя',debt:'Долг'};
  function dialog(title){
    const wrap=document.createElement('div');wrap.style.cssText='position:fixed;inset:0;z-index:999999;background:#0009;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box';
    const panel=document.createElement('section');panel.style.cssText='background:#fff;color:#183328;border-radius:14px;width:100%;max-width:540px;max-height:90vh;overflow:auto;padding:20px;box-sizing:border-box;font:16px/1.4 system-ui,sans-serif';
    const h=document.createElement('h2');h.textContent=title;panel.appendChild(h);wrap.appendChild(panel);document.body.appendChild(wrap);
    return {wrap,panel};
  }
  function button(text,handler){const b=document.createElement('button');b.type='button';b.textContent=text;b.style.cssText='min-height:48px;padding:10px 16px;border:1px solid #17694a;border-radius:8px;background:#17694a;color:white;margin:6px;cursor:pointer;font:600 16px system-ui';b.onclick=handler;return b;}
  root.greenvillePaymentDialog=function(total,customers,selected,onConfirm){
    if(document.getElementById('gvPaymentDialog'))return;
    const {wrap,panel}=dialog('Оплата: '+total+' сум'),fields={},summary=document.createElement('p'),choice=document.createElement('select'),newName=document.createElement('input'),newPhone=document.createElement('input');
    wrap.id='gvPaymentDialog';
    choice.style.cssText='min-height:48px;width:100%;font:16px system-ui';const blank=document.createElement('option');blank.value='';blank.textContent='Выберите покупателя для долга';choice.appendChild(blank);
    for(const c of customers){const o=document.createElement('option');o.value=String(c.id);o.textContent=String(c.name||'')+' '+String(c.phone||'');choice.appendChild(o);}if(selected)choice.value=String(selected.id);
    function update(){let sum=0;for(const input of Object.values(fields))sum+=Number(input.value||0);summary.textContent='Осталось распределить: '+(total-sum)+' сум';}
    for(const [key,label] of Object.entries(labels)){
      const line=document.createElement('label');line.style.cssText='display:block;margin:10px 0';line.appendChild(document.createTextNode(label+' '));
      const input=document.createElement('input');input.type='number';input.min='0';input.step='1';input.value=key==='cash'?String(total):'0';input.style.cssText='display:block;min-height:48px;width:100%;box-sizing:border-box;font:18px system-ui';input.oninput=update;fields[key]=input;line.appendChild(input);panel.appendChild(line);
    }
    const modes=document.createElement('div');
    for(const [key,label] of [...Object.entries(labels),['mixed','Смешанная оплата']])modes.appendChild(button(label,()=>{for(const [name,input] of Object.entries(fields))input.value=(key!=='mixed' && name===key)?String(total):'0';update();}));
    panel.insertBefore(modes,panel.children[1]);
    newName.placeholder='Новый покупатель: имя';newPhone.placeholder='Телефон (необязательно)';
    for(const input of [newName,newPhone])input.style.cssText='display:block;min-height:48px;width:100%;box-sizing:border-box;font:16px system-ui;margin:8px 0';
    panel.appendChild(summary);panel.appendChild(choice);panel.append(newName,newPhone);update();
    const submit=button('Подтвердить продажу',()=>{
      const payments={};for(const [key,input] of Object.entries(fields)){const value=Number(input.value);if(!Number.isSafeInteger(value)||value<0){summary.textContent='Введите целые неотрицательные суммы';return;}payments[key]=value;}
      if(Object.values(payments).reduce((a,b)=>a+b,0)!==total){summary.textContent='Сумма платежей и долга должна равняться сумме чека';return;}
      if(payments.debt && !choice.value && !newName.value.trim()){summary.textContent='Укажите покупателя';return;}
      let customer=customers.find(c=>String(c.id)===choice.value)||null;
      if(!customer && newName.value.trim())customer={id:crypto.randomUUID(),name:newName.value.trim(),phone:newPhone.value.trim(),isNew:true};
      submit.disabled=true;wrap.remove();onConfirm(payments,customer);
    });panel.appendChild(submit);panel.appendChild(button('Отмена',()=>wrap.remove()));
  };
  root.greenvilleDebtsDialog=async function(load,pay,correct,isAdmin){
    const {wrap,panel}=dialog('Долги'),search=document.createElement('input'),list=document.createElement('div');
    search.placeholder='Поиск по имени или телефону';search.style.cssText='min-height:48px;width:100%;box-sizing:border-box;font:16px system-ui';panel.appendChild(search);panel.appendChild(list);panel.appendChild(button('Закрыть',()=>wrap.remove()));
    let debts=[];try{debts=await load();}catch(e){list.textContent='Нет связи. Повторите после восстановления интернета.';return;}
    function draw(){list.replaceChildren();const q=search.value.trim().toLowerCase();
      for(const debt of debts.filter(d=>!q||((d.customer?.name||'')+' '+(d.customer?.phone||'')).toLowerCase().includes(q))){
        const card=document.createElement('article');card.style.cssText='padding:12px;border:1px solid #ddd;border-radius:8px;margin:10px 0';
        const text=document.createElement('p');text.textContent=(debt.customer?.name||'Покупатель')+' · '+(debt.customer?.phone||'')+' · '+String(debt.date||'')+' · Долг: '+debt.payments.debt+' · Погашено: '+(debt.payments.debt-debt.debtOutstanding)+' · Остаток: '+debt.debtOutstanding+' · '+(debt.debtOutstanding?'Открыт':'Погашен');card.appendChild(text);
        const hist=document.createElement('div');for(const p of debt.debtPayments||[]){const row=document.createElement('p'),reversed=(debt.debtCorrections||[]).some(c=>c.action==='reverse_repayment' && c.paymentId===p.operationId);row.textContent=p.at+' · '+(labels[p.method]||p.method)+' · '+p.amount+' · '+p.byId+(reversed?' · отменён':'');hist.appendChild(row);
          if(isAdmin && !reversed)hist.appendChild(button('Отменить платёж',async()=>{const reason=prompt('Причина исправления (не менее 3 символов):');if(!reason || reason.trim().length<3)return;try{const status=await correct(debt.id,'reverse_repayment',reason,p.operationId,null,debt.financialRevision);if(status==='confirmed'){debts=await load();draw();}else list.textContent=status==='conflict'?'Операция изменилась. Обновите данные и проверьте конфликт очереди.':'Исправление ожидает подтверждения.';}catch(e){alert('Не удалось сохранить исправление');}}));
        }
        for(const c of debt.debtCorrections||[]){const row=document.createElement('p');row.textContent=c.at+' · '+c.byId+' · '+c.reason+' · '+JSON.stringify(c.before)+' → '+JSON.stringify(c.after);hist.appendChild(row);}card.appendChild(hist);
        if(isAdmin)card.appendChild(button('Исправить первоначальную оплату',()=>{
          const reason=prompt('Причина исправления (не менее 3 символов):');if(!reason || reason.trim().length<3)return;
          root.greenvillePaymentDialog(debt.total,debt.customer?[debt.customer]:[],debt.customer,async payments=>{
            try{const status=await correct(debt.id,'correct_initial',reason,null,payments,debt.financialRevision);if(status==='confirmed'){debts=await load();draw();}else list.textContent=status==='conflict'?'Операция изменилась. Обновите данные и проверьте конфликт очереди.':'Исправление ожидает подтверждения.';}catch(e){alert('Не удалось сохранить исправление');}
          });
        }));
        if(debt.debtOutstanding>0)card.appendChild(button('Принять платёж',()=>{
          const sub=dialog('Погашение долга'),amount=document.createElement('input'),method=document.createElement('select'),message=document.createElement('p');
          amount.type='number';amount.min='1';amount.max=String(debt.debtOutstanding);amount.step='1';amount.placeholder='Сумма в сумах';amount.style.cssText='min-height:48px;font-size:18px;width:100%';
          for(const key of ['cash','terminal','owner_card']){const o=document.createElement('option');o.value=key;o.textContent=labels[key];method.appendChild(o);}method.style.cssText='min-height:48px;font-size:16px;width:100%';
          sub.panel.append(amount,method,message);const confirm=button('Сохранить платёж',async()=>{
            const n=Number(amount.value);if(!Number.isSafeInteger(n)||n<=0||n>debt.debtOutstanding){message.textContent='Проверьте сумму платежа';return;}
            confirm.disabled=true;try{const status=await pay(debt.id,method.value,n);sub.wrap.remove();if(status==='confirmed'){debts=await load();draw();}else list.textContent=status==='conflict'?'Долг изменился. Обновите данные и проверьте конфликт очереди.':'Платёж в очереди; обновите после подтверждения.';}catch(e){message.textContent='Не удалось сохранить платёж';confirm.disabled=false;}
          });sub.panel.append(confirm,button('Отмена',()=>sub.wrap.remove()));
        }));list.appendChild(card);
      }
    }search.oninput=draw;draw();
  };
})(window);
