"""Synthetic local browser-to-server integration; no external service is contacted."""
import json, os, socket, subprocess, sys, tempfile, time
from pathlib import Path
import httpx
sys.path.insert(0, r'C:\GREENVILLE-POS\server\tests')
sys.path.insert(0, r'C:\GREENVILLE-POS\server')
from browser_devtools import DevTools, wait_for

ROOT=Path(__file__).resolve().parents[1]
NODE=r'C:\Users\kurba\AppData\Local\Programs\Microsoft VS Code\Code.exe'
CHROME=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
with tempfile.TemporaryDirectory(prefix='gv-synthetic-e2e-',ignore_cleanup_errors=True) as tmp:
    root=Path(tmp); db=root/'db';db.mkdir();profile=root/'browser'
    (db/'db.json').write_text(json.dumps({'products':[{'id':'p1','name':'Тестовый грунт','sku':'SOIL','barcode':'123456','price':10000,'cost':5000,'stock':10,'cat':'Тест','emoji':'🌱'}],'customers':[],'sales':[],'counter':1001,'bonusPct':5,'cashRegister':{'openingBalance':10500,'openedAt':'2026-01-01T00:00:00Z'}}),encoding='utf8')
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1',0));port=reservation.getsockname()[1]
    env=os.environ.copy();env.update(ELECTRON_RUN_AS_NODE='1',DATA_DIR=str(db),HOST='127.0.0.1',PORT=str(port),ADMIN_PASSWORD='synthetic-only',GREENVILLE_EXPERIMENTAL_V3='1')
    server=subprocess.Popen([NODE,'server.js'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    browser=None;dev=None;browser2=None;dev2=None
    base=f'http://127.0.0.1:{port}'
    try:
        def ready():
            try:return httpx.get(base+'/api/health',timeout=1).status_code==200
            except httpx.HTTPError:return False
        wait_for(ready)
        bootstrap=httpx.post(base+'/api/login',json={'login':'admin','pass':'synthetic-only'})
        assert bootstrap.status_code==200
        browser=subprocess.Popen([CHROME,'--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--remote-debugging-port=0','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',f'--user-data-dir={profile}',base+'/'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        active=profile/'DevToolsActivePort'
        def debug_port():
            try:return int(active.read_text().splitlines()[0])
            except (OSError,ValueError,IndexError):return None
        wait_for(debug_port);devport=debug_port()
        pages=httpx.get(f'http://127.0.0.1:{devport}/json').json()
        dev=DevTools(next(p for p in pages if p['url'].startswith(base))['webSocketDebuggerUrl'])
        dev.call('Runtime.enable');dev.call('Emulation.setDeviceMetricsOverride',{'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
        wait_for(lambda:dev.evaluate("document.readyState==='complete' && !!document.querySelector('#loginForm')"))
        dev.evaluate("new Promise(resolve=>setTimeout(resolve,600))")
        dev.evaluate("document.querySelector('#loginName').value='admin';document.querySelector('#loginPass').value='synthetic-only';document.querySelector('#loginForm').requestSubmit()")
        wait_for(lambda:dev.evaluate("typeof CURRENT!=='undefined' && CURRENT!==null && document.querySelector('#loginScreen').hidden"))
        try:wait_for(lambda:dev.evaluate("typeof window.__gvExperimentalCheckout==='function' && typeof window.__gvExperimentalSync==='function'"))
        except AssertionError:
            print(dev.evaluate("JSON.stringify({checkout:typeof window.__gvExperimentalCheckout,sync:typeof window.__gvExperimentalSync,outbox:typeof ReceiptOutbox,cloud:window.cloudInfo&&window.cloudInfo(),pending:window.cloudPending&&window.cloudPending(),badge:document.querySelector('#cloudChip')?.textContent})"))
            raise
        wait_for(lambda:dev.evaluate("DB.products.some(p=>p.id==='p1')"))
        dev.evaluate("document.querySelector('#mobileCash').click()")
        wait_for(lambda:dev.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Новый расход')"))
        assert dev.evaluate("document.body.innerText.includes('Остаток наличных: 10500 сум')")
        dev.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Новый расход').click()")
        dev.evaluate("{const i=document.querySelector('input[placeholder=\"Сумма расхода (сум)\"]'),d=i.closest('section');i.value='500';d.querySelector('textarea').value='Тестовая упаковка';[...d.querySelectorAll('button')].find(b=>b.textContent==='Подтвердить').click()}")
        wait_for(lambda:json.loads((db/'db.json').read_text(encoding='utf8')).get('expenses'))
        wait_for(lambda:dev.evaluate("document.body.innerText.includes('Остаток наличных: 10000 сум') && document.body.innerText.includes('Тестовая упаковка')"))
        dev.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Закрыть').click()")
        print('cash expense UI, history and balance: passed')
        dev.evaluate("{const s=document.querySelector('#posSearch');s.value='грунт';s.dispatchEvent(new Event('input',{bubbles:true}))}")
        wait_for(lambda:dev.evaluate("document.querySelectorAll('#matchList .m-row').length===1"))
        dev.evaluate("document.querySelector('#matchList .m-row').click()")
        assert dev.evaluate("cart.length===1 && cart[0].id==='p1'")
        dev.evaluate("document.querySelector('#btnCheckout').click();[...document.querySelectorAll('#gvPaymentDialog button')].find(b=>b.textContent==='Подтвердить продажу')?.click()")
        wait_for(lambda:json.loads((db/'db.json').read_text(encoding='utf8')).get('sales'))
        saved=json.loads((db/'db.json').read_text(encoding='utf8'))
        assert len(saved['sales'])==1 and saved['products'][0]['stock']==9
        assert saved['sales'][0]['items'][0]['id']=='p1'
        print('real UI login/search/checkout/server stock: passed')
        dev.call('Network.enable')
        dev.call('Network.emulateNetworkConditions',{'offline':True,'latency':0,'downloadThroughput':0,'uploadThroughput':0})
        dev.evaluate("{const s=document.querySelector('#posSearch');s.value='грунт';s.dispatchEvent(new Event('input',{bubbles:true}))}")
        wait_for(lambda:dev.evaluate("document.querySelectorAll('#matchList .m-row').length===1"))
        dev.evaluate("document.querySelector('#matchList .m-row').click();document.querySelector('#btnCheckout').click();[...document.querySelectorAll('#gvPaymentDialog button')].find(b=>b.textContent==='Подтвердить продажу')?.click()")
        wait_for(lambda:dev.evaluate("(async()=>{let q=await new ReceiptOutbox().open();let n=(await q.list()).length;q.close();return n>0})()"))
        wait_for(lambda:dev.evaluate("!document.querySelector('#syncQueueStatus').hidden && document.querySelector('#syncQueueStatus').textContent.includes('1')"))
        assert len(json.loads((db/'db.json').read_text(encoding='utf8'))['sales'])==1
        dev.call('Network.emulateNetworkConditions',{'offline':False,'latency':0,'downloadThroughput':-1,'uploadThroughput':-1})
        dev.call('Page.reload',{'ignoreCache':True})
        wait_for(lambda:dev.evaluate("typeof window.__gvExperimentalSync==='function'"))
        dev.evaluate("window.__gvExperimentalSync()")
        wait_for(lambda:len(json.loads((db/'db.json').read_text(encoding='utf8'))['sales'])==2)
        wait_for(lambda:dev.evaluate("document.querySelector('#syncQueueStatus').hidden"))
        saved=json.loads((db/'db.json').read_text(encoding='utf8'))
        assert saved['products'][0]['stock']==8
        dev.evaluate("window.__gvExperimentalSync()")
        assert len(json.loads((db/'db.json').read_text(encoding='utf8'))['sales'])==2
        print('offline queue/reload/retry: passed')
        wait_for(lambda:dev.evaluate("DB.sales.length===2"))
        dev.evaluate("window.confirm=()=>true;setSaleDeleted('1001',true)")
        wait_for(lambda:json.loads((db/'db.json').read_text(encoding='utf8'))['products'][0]['stock']==9)
        wait_for(lambda:dev.evaluate("DB.sales.some(s=>s.id==='1001' && s.deleted && s.revision===2)"))
        dev.evaluate("setSaleDeleted('1001',false)")
        wait_for(lambda:json.loads((db/'db.json').read_text(encoding='utf8'))['products'][0]['stock']==8)
        wait_for(lambda:dev.evaluate("DB.sales.some(s=>s.id==='1001' && !s.deleted && s.revision===3)"))
        print('void and restore adjust stock once: passed')
        dev.evaluate("{const s=document.querySelector('#posSearch');s.value='пересадка';s.dispatchEvent(new Event('input',{bubbles:true}))}")
        wait_for(lambda:dev.evaluate("document.querySelectorAll('#matchList [data-service]').length===1"))
        dev.evaluate("document.querySelector('#matchList [data-service]').click()")
        wait_for(lambda:dev.evaluate("!!document.querySelector('[data-sprice]')"))
        dev.evaluate("{const i=document.querySelector('[data-sprice]');i.value='15000';i.dispatchEvent(new Event('input',{bubbles:true}))}")
        dev.evaluate("document.querySelector('#btnCheckout').click();[...document.querySelectorAll('#gvPaymentDialog button')].find(b=>b.textContent==='Подтвердить продажу')?.click()")
        wait_for(lambda:len(json.loads((db/'db.json').read_text(encoding='utf8'))['sales'])==3)
        assert json.loads((db/'db.json').read_text(encoding='utf8'))['products'][0]['stock']==8
        wait_for(lambda:dev.evaluate("DB.sales.length===3"))
        print('service sale leaves goods stock unchanged: passed')
        dev.evaluate("{const s=document.querySelector('#posSearch');s.value='грунт';s.dispatchEvent(new Event('input',{bubbles:true}))}")
        wait_for(lambda:dev.evaluate("document.querySelectorAll('#matchList .m-row').length===1"))
        dev.evaluate("document.querySelector('#matchList .m-row').click();document.querySelector('#btnSaveOrder').click()")
        wait_for(lambda:len(json.loads((db/'db.json').read_text(encoding='utf8'))['sales'])==4)
        wait_for(lambda:dev.evaluate("cartOrder && cartOrder.id==='1004'"))
        saved=json.loads((db/'db.json').read_text(encoding='utf8'))
        assert saved['products'][0]['stock']==7 and not saved['sales'][-1]['paid']
        dev.evaluate("openEditSale('1004');document.querySelector('[data-ei-plus=\"0\"]').click();applyEditSale()")
        wait_for(lambda:json.loads((db/'db.json').read_text(encoding='utf8'))['products'][0]['stock']==6)
        wait_for(lambda:dev.evaluate("DB.sales.some(s=>s.id==='1004' && s.revision===2 && s.total===20000)"))
        dev.evaluate("loadOrderIntoCart('1004')")
        selected=dev.evaluate("(()=>{document.querySelector('#btnCheckout').click();[...document.querySelectorAll('#gvPaymentDialog button')].find(b=>b.textContent==='Банковский терминал').click();const fields=[...document.querySelectorAll('#gvPaymentDialog input')].slice(0,4).map(x=>x.value);[...document.querySelectorAll('#gvPaymentDialog button')].find(b=>b.textContent==='Подтвердить продажу').click();return fields})()")
        assert selected[:2]==['0','20000'],selected
        wait_for(lambda:json.loads((db/'db.json').read_text(encoding='utf8'))['sales'][-1]['paid'])
        assert json.loads((db/'db.json').read_text(encoding='utf8'))['products'][0]['stock']==6
        saved_pay=json.loads((db/'db.json').read_text(encoding='utf8'))['sales'][-1]['payments']
        assert saved_pay['terminal']==20000, saved_pay
        wait_for(lambda:dev.evaluate("DB.sales.length===4 && DB.sales.some(s=>s.id==='1004' && s.paid)"))
        print('park, edit and pay do not double-deduct: passed')
        dev.evaluate("document.querySelector('#mobileReports').click()")
        assert dev.evaluate("document.querySelector('#view-reports').classList.contains('active') && getComputedStyle(document.querySelector('#view-reports')).display!=='none'")
        print('report content:',dev.evaluate("document.querySelector('#repStats').innerText"))
        assert dev.evaluate("document.querySelector('#repStats').textContent.includes('Неизвестна') && document.querySelector('#repStaff').textContent.includes('Администратор')")
        dev.evaluate("document.querySelector('#periodSwitch [data-period=yesterday]').click()")
        assert dev.evaluate("document.querySelector('#repStats .stat.blue .stat-value').textContent==='0'")
        dev.evaluate("document.querySelector('#periodSwitch [data-period=custom]').click();document.querySelector('#reportFrom').value=reportDayKey(new Date());document.querySelector('#reportTo').value=reportDayKey(new Date());document.querySelector('#reportTo').dispatchEvent(new Event('change'))")
        assert dev.evaluate("document.querySelector('#repStats .stat.blue .stat-value').textContent==='4'")
        assert dev.evaluate("document.querySelector('#payBreakdown').textContent.includes('Расходы наличных') && document.querySelector('#payBreakdown').textContent.includes('Тестовая упаковка')")
        print('mobile report: passed')
        headers={'Authorization':'Bearer '+bootstrap.json()['token']}
        staff=httpx.get(base+'/api/staff',headers=headers).json()['staff']
        staff.append({'id':'cashier-2','login':'cashier2','name':'Тестовый кассир','role':'cashier','active':True,'pass':bootstrap.json()['serverHash']})
        assert httpx.put(base+'/api/staff',headers=headers,json={'staff':staff}).status_code==200
        profile2=root/'browser2'
        browser2=subprocess.Popen([CHROME,'--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--remote-debugging-port=0','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',f'--user-data-dir={profile2}',base+'/'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        active2=profile2/'DevToolsActivePort';wait_for(active2.exists);devport2=int(active2.read_text().splitlines()[0])
        pages2=httpx.get(f'http://127.0.0.1:{devport2}/json').json();dev2=DevTools(next(p for p in pages2 if p['url'].startswith(base))['webSocketDebuggerUrl'])
        dev2.call('Runtime.enable');dev2.call('Emulation.setDeviceMetricsOverride',{'width':360,'height':800,'deviceScaleFactor':1,'mobile':True})
        wait_for(lambda:dev2.evaluate("document.readyState==='complete' && !!document.querySelector('#loginForm')"))
        dev2.evaluate("new Promise(resolve=>setTimeout(resolve,600))")
        dev2.evaluate("document.querySelector('#loginName').value='cashier2';document.querySelector('#loginPass').value='synthetic-only';document.querySelector('#loginForm').requestSubmit()")
        wait_for(lambda:dev2.evaluate("typeof CURRENT!=='undefined' && CURRENT && CURRENT.role==='cashier' && document.querySelector('#loginScreen').hidden && typeof window.__gvExperimentalSync==='function'"))
        assert dev2.evaluate("document.querySelector('#mobileReports').hidden && DB.sales.length===0")
        dev2.evaluate("document.querySelector('#mobileCash').click()")
        wait_for(lambda:dev2.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Новый расход')"))
        assert dev2.evaluate("![...document.querySelectorAll('button')].some(b=>b.textContent==='Отменить расход')")
        dev2.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Новый расход').click();const i=document.querySelector('input[placeholder=\"Сумма расхода (сум)\"]'),d=i.closest('section');i.value='200';d.querySelector('textarea').value='Тестовый расход продавца';[...d.querySelectorAll('button')].find(b=>b.textContent==='Подтвердить').click()")
        wait_for(lambda:len(json.loads((db/'db.json').read_text(encoding='utf8')).get('expenses',[]))==2)
        dev2.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Закрыть').click()")
        dev2.evaluate("go('reports')")
        assert dev2.evaluate("!document.querySelector('#view-reports').classList.contains('active')")
        dev.evaluate("go('pos')")
        for client in (dev,dev2):
            client.evaluate("{const s=document.querySelector('#posSearch');s.value='грунт';s.dispatchEvent(new Event('input',{bubbles:true}))}")
            wait_for(lambda:client.evaluate("document.querySelectorAll('#matchList .m-row').length===1"))
            client.evaluate("document.querySelector('#matchList .m-row').click()")
        dev.evaluate("document.querySelector('#btnCheckout').click();[...document.querySelectorAll('#gvPaymentDialog button')].find(b=>b.textContent==='Подтвердить продажу')?.click()")
        dev2.evaluate("document.querySelector('#btnCheckout').click();[...document.querySelectorAll('#gvPaymentDialog button')].find(b=>b.textContent==='Подтвердить продажу')?.click()")
        wait_for(lambda:len(json.loads((db/'db.json').read_text(encoding='utf8'))['sales'])==6)
        saved=json.loads((db/'db.json').read_text(encoding='utf8'));assert saved['products'][0]['stock']==4
        assert {s['byId'] for s in saved['sales']}=={'u1','cashier-2'}
        dev.evaluate("window.__gvExperimentalSync()")
        wait_for(lambda:dev.evaluate("DB.sales.length===6"))
        dev2.call('Browser.close');browser2.wait(timeout=10);browser2=None;dev2=None
        print('two cashier browsers and cashier report restriction: passed')
        dev.call('Browser.close')
        browser.wait(timeout=10);browser=None
        browser=subprocess.Popen([CHROME,'--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--remote-debugging-port=0','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',f'--user-data-dir={profile}',base+'/'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        wait_for(lambda:active.exists() and browser.poll() is None)
        time.sleep(1);devport=int(active.read_text().splitlines()[0])
        pages=httpx.get(f'http://127.0.0.1:{devport}/json').json()
        dev=DevTools(next(p for p in pages if p['url'].startswith(base))['webSocketDebuggerUrl'])
        dev.call('Runtime.enable')
        wait_for(lambda:dev.evaluate("typeof CURRENT!=='undefined' && CURRENT && CURRENT.role==='admin' && document.querySelector('#loginScreen').hidden"))
        assert dev.evaluate("DB.sales.length===6")
        print('browser restart and session restoration: passed')
        dev.call('Network.enable')
        dev.call('Network.emulateNetworkConditions',{'offline':True,'latency':0,'downloadThroughput':0,'uploadThroughput':0})
        dev.evaluate("window.__origOutboxAdd=ReceiptOutbox.prototype.add;ReceiptOutbox.prototype.add=async function(r){const v=await window.__origOutboxAdd.call(this,r);await new Promise(resolve=>setTimeout(resolve,500));return v};addToCart('p1');void window.__gvExperimentalCheckout();setTimeout(()=>changeQty('p1',1),100)")
        wait_for(lambda:dev.evaluate("window.__gvCartCommitConflict===true"))
        assert dev.evaluate("(async()=>{let q=await new ReceiptOutbox().open();let n=(await q.list()).length;q.close();return n===1})()")
        dev.evaluate("void window.__gvExperimentalCheckout()")
        dev.evaluate("new Promise(resolve=>setTimeout(resolve,700))")
        assert dev.evaluate("(async()=>{let q=await new ReceiptOutbox().open();let n=(await q.list()).length;q.close();return n===1})()")
        dev.call('Browser.close');browser.wait(timeout=10);browser=None;dev=None
        assert len(json.loads((db/'db.json').read_text(encoding='utf8'))['sales'])==6
        browser=subprocess.Popen([CHROME,'--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--remote-debugging-port=0','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',f'--user-data-dir={profile}',base+'/'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        wait_for(lambda:active.exists() and browser.poll() is None);time.sleep(1);devport=int(active.read_text().splitlines()[0])
        pages=httpx.get(f'http://127.0.0.1:{devport}/json').json();dev=DevTools(next(p for p in pages if p['url'].startswith(base))['webSocketDebuggerUrl']);dev.call('Runtime.enable')
        wait_for(lambda:dev.evaluate("typeof cart!=='undefined' && cart.length===0"))
        wait_for(lambda:dev.evaluate("typeof window.__gvExperimentalSync==='function'"))
        dev.evaluate("window.__gvExperimentalSync()")
        wait_for(lambda:len(json.loads((db/'db.json').read_text(encoding='utf8'))['sales'])==7)
        assert json.loads((db/'db.json').read_text(encoding='utf8'))['products'][0]['stock']==3
        print('queue commit plus cart conflict/reload sends only once: passed')
        result=dev.evaluate("(async()=>{const a=await new ReceiptOutbox().open(),b=await new ReceiptOutbox().open(),r={operationId:crypto.randomUUID(),cashierId:'u1',items:[{productId:'p1',quantity:1,price:10000}],discount:0,total:10000};await a.add(r);const transport={status:async body=>{const x=await fetch('/api/experimental/receipt-status',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+localStorage.getItem('greenville_server_token')},body:JSON.stringify({receipt:JSON.parse(body)})});const o=await x.json();return o.status||'unknown'},send:async body=>{const x=await fetch('/api/experimental/receipt',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+localStorage.getItem('greenville_server_token')},body:JSON.stringify({receipt:JSON.parse(body)})});return x.ok?'accepted':'unknown'}};await Promise.all([a.flush(transport),b.flush(transport)]);const n=(await a.list()).length;a.close();b.close();return n})()")
        assert result==0
        wait_for(lambda:len(json.loads((db/'db.json').read_text(encoding='utf8'))['sales'])==8)
        assert json.loads((db/'db.json').read_text(encoding='utf8'))['products'][0]['stock']==2
        print('two IndexedDB connections flush same operation once: passed')
        dev.evaluate("window.confirm=()=>true;document.querySelector('#btnLogout').click()")
        assert dev.evaluate("!document.querySelector('#loginScreen').hidden && localStorage.getItem('greenville_server_token')===null")
        dev.call('Page.reload',{'ignoreCache':True})
        wait_for(lambda:dev.evaluate("document.readyState==='complete' && !document.querySelector('#loginScreen').hidden"))
        print('manual logout requires login: passed')
        dev.evaluate("localStorage.setItem('greenville_pos_v1',JSON.stringify({products:[{id:'p1',name:'Тестовый грунт',sku:'SOIL',barcode:'123456',price:10000,cost:5000,stock:9,cat:'Тест'}],customers:[],sales:[{id:'legacy-unconfirmed',date:'2026-11-16T10:00:00.000Z',items:[{id:'p1',name:'Тестовый грунт',qty:1,price:10000}],paid:true,total:10000}],counter:1002,bonusPct:5}));localStorage.setItem('greenville_sent_v1','{}')")
        dev.call('Page.reload',{'ignoreCache':True})
        wait_for(lambda:dev.evaluate("document.readyState==='complete' && !!document.querySelector('#loginForm')"))
        dev.evaluate("new Promise(resolve=>setTimeout(resolve,600))")
        dev.evaluate("document.querySelector('#loginName').value='admin';document.querySelector('#loginPass').value='synthetic-only';document.querySelector('#loginForm').requestSubmit()")
        wait_for(lambda:dev.evaluate("typeof window.__gvExperimentalCheckout==='function'"))
        assert dev.evaluate("typeof window.__gvExperimentalSync!=='function' && JSON.parse(localStorage.getItem('greenville_pos_v1')).sales.some(s=>s.id==='legacy-unconfirmed')")
        assert dev.evaluate("!!document.querySelector('#gvLegacyTransition') && !!document.querySelector('#gvLegacyTransition button')")
        for width,height in [(360,800),(1280,800)]:
            dev.call('Emulation.setDeviceMetricsOverride',{'width':width,'height':height,'deviceScaleFactor':1,'mobile':width<500})
            assert dev.evaluate("[...document.querySelectorAll('#gvLegacyTransition button')].every(b=>b.getBoundingClientRect().height>=48 && getComputedStyle(b).borderTopWidth!=='0px' && getComputedStyle(b).backgroundColor!=='rgba(0, 0, 0, 0)') && document.documentElement.scrollWidth<=innerWidth")
        assert len(json.loads((db/'db.json').read_text(encoding='utf8'))['sales'])==8
        dev.call('Page.setDownloadBehavior',{'behavior':'allow','downloadPath':str(root)})
        dev.evaluate("[...document.querySelectorAll('#gvLegacyTransition button')].find(b=>b.textContent.includes('Скачать')).click()")
        download=root/'greenville-local-backup.json';wait_for(download.exists)
        wait_for(lambda:download.stat().st_size>0)
        assert any(s['id']=='legacy-unconfirmed' for s in json.loads(download.read_text(encoding='utf8'))['sales'])
        dev.evaluate("window.confirm=()=>false;[...document.querySelectorAll('#gvLegacyTransition button')].find(b=>b.textContent.includes('перейти')).click()")
        wait_for(lambda:dev.evaluate("![...document.querySelectorAll('#gvLegacyTransition button')].find(b=>b.textContent.includes('перейти')).disabled"))
        assert dev.evaluate("localStorage.getItem('greenville_legacy_isolated_v1')===null && JSON.parse(localStorage.getItem('greenville_pos_v1')).sales.some(s=>s.id==='legacy-unconfirmed')")
        assert len(json.loads((db/'db.json').read_text(encoding='utf8'))['sales'])==8
        dev.evaluate("window.confirm=()=>true;[...document.querySelectorAll('#gvLegacyTransition button')].find(b=>b.textContent.includes('перейти')).click()")
        wait_for(lambda:dev.evaluate("localStorage.getItem('greenville_legacy_isolated_v1')==='1' && typeof window.__gvExperimentalSync==='function'"))
        assert dev.evaluate("new Promise((resolve,reject)=>{const r=indexedDB.open('greenville_legacy_archives_v1');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,q=db.transaction('archives').objectStore('archives').getAll();q.onsuccess=()=>resolve(q.result.some(x=>JSON.parse(x.snapshot).sales.some(s=>s.id==='legacy-unconfirmed')));q.onerror=()=>reject(q.error)}})")
        assert len(json.loads((db/'db.json').read_text(encoding='utf8'))['sales'])==8
        print('legacy download, cancelled confirmation and admin archive without replay: passed')
        if dev.evaluate("!document.querySelector('#loginScreen').hidden"):
            dev.evaluate("document.querySelector('#loginName').value='admin';document.querySelector('#loginPass').value='synthetic-only';document.querySelector('#loginForm').requestSubmit()")
            wait_for(lambda:dev.evaluate("CURRENT && document.querySelector('#loginScreen').hidden"))
        assert dev.evaluate("window.__gvCloudVerificationPending!==true"),'payment remains blocked after re-login following transition'
        stock_before=json.loads((db/'db.json').read_text(encoding='utf8'))['products'][0]['stock']
        dev.evaluate("addToCart('p1');document.querySelector('#btnCheckout').click();document.querySelector('#btnCheckout').click();[...document.querySelectorAll('#gvPaymentDialog button')].find(b=>b.textContent==='Подтвердить продажу')?.click()")
        wait_for(lambda:len(json.loads((db/'db.json').read_text(encoding='utf8'))['sales'])==9)
        time.sleep(1)
        after=json.loads((db/'db.json').read_text(encoding='utf8'));assert len(after['sales'])==9 and after['products'][0]['stock']==stock_before-1
        print('post-transition re-login and repeated checkout: passed')
        dev.evaluate("window.greenvilleLegacyTransition.show([{}],{role:'cashier'},async()=>({ok:false}),()=>{})")
        assert dev.evaluate("[...document.querySelectorAll('#gvLegacyTransition button')].some(b=>b.textContent.includes('Войти как администратор') && b.getBoundingClientRect().height>=48 && getComputedStyle(b).backgroundColor!=='rgba(0, 0, 0, 0)')")
        dev.evaluate("document.querySelector('#gvLegacyTransition').remove()")
        print('transition buttons styled for administrator and cashier: passed')
    finally:
        if dev2:
            try:dev2.call('Browser.close')
            except Exception:pass
        if browser2:
            try:browser2.wait(timeout=10)
            except subprocess.TimeoutExpired:browser2.terminate()
        if dev:
            try:dev.call('Browser.close')
            except Exception:pass
        if browser:
            try:browser.wait(timeout=10)
            except subprocess.TimeoutExpired:browser.terminate()
        server.terminate();server.wait(timeout=10)
