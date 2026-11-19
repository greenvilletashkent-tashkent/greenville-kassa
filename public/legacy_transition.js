(function(root){
  'use strict';
  const marker='greenville_legacy_isolated_v1';
  function backup(snapshot,admin){
    return new Promise((resolve,reject)=>{
      const open=indexedDB.open('greenville_legacy_archives_v1',1);
      open.onupgradeneeded=()=>open.result.createObjectStore('archives',{keyPath:'id'});
      open.onerror=()=>reject(open.error);
      open.onblocked=()=>reject(new Error('Архив недоступен'));
      open.onsuccess=()=>{
        const db=open.result,tx=db.transaction('archives','readwrite');
        tx.objectStore('archives').add({id:crypto.randomUUID(),at:new Date().toISOString(),admin,snapshot});
        tx.oncomplete=()=>{db.close();resolve();};
        tx.onabort=()=>{db.close();reject(tx.error||new Error('Не удалось сохранить архив'));};
      };
    });
  }
  root.greenvilleLegacyTransition={
    approved(){try{return localStorage.getItem(marker)==='1';}catch(e){return false;}},
    async show(sales,current,api,resume){
      let screen=document.getElementById('gvLegacyTransition');
      if(screen)return;
      screen=document.createElement('div');screen.id='gvLegacyTransition';
      screen.style.cssText='position:fixed;inset:0;z-index:999999;background:#fff;overflow:auto;padding:24px;color:#183328';
      const title=document.createElement('h2');title.textContent='Переход на новую кассу';screen.appendChild(title);
      const text=document.createElement('p');text.textContent='На устройстве найдены старые локальные чеки: '+sales.length+'. Они будут сохранены отдельно и не будут проведены повторно. Переход подтверждает администратор.';screen.appendChild(text);
      const download=document.createElement('button');download.textContent='Скачать копию старых данных';download.onclick=()=>{
        const raw=localStorage.getItem('greenville_pos_v1');if(!raw)return;
        const url=URL.createObjectURL(new Blob([raw],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='greenville-local-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      };screen.appendChild(download);
      if(current && current.role==='admin'){
        const approve=document.createElement('button');approve.textContent='Сохранить архив и перейти';screen.appendChild(approve);
        approve.onclick=async()=>{
          approve.disabled=true;
          try{
            const session=await api('GET','/api/experimental/session');
            if(!session || !session.ok || session.role!=='admin')throw new Error('Требуется действующая сессия администратора');
            if(!confirm('Сохранить старые данные отдельно и начать работу в новой кассе? Старые локальные чеки не будут проведены автоматически.')){approve.disabled=false;return;}
            const raw=localStorage.getItem('greenville_pos_v1');if(!raw)throw new Error('Исходные данные не найдены');
            await backup(raw,String(session.id));
            localStorage.setItem(marker,'1');
            screen.remove();resume();
          }catch(e){text.textContent='Переход не выполнен: '+String(e.message||e);approve.disabled=false;}
        };
      }else{
        const logout=document.createElement('button');logout.textContent='Войти как администратор';logout.onclick=()=>{screen.remove();root.logout();};screen.appendChild(logout);
      }
      document.body.appendChild(screen);
    }
  };
})(window);
