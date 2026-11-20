"""Isolated two-browser payment and debt checks using synthetic data only."""
import json,os,socket,subprocess,tempfile,time
from pathlib import Path
import httpx
from browser_devtools import DevTools,wait_for

ROOT=Path(__file__).resolve().parents[1]
NODE=r'C:\Users\kurba\AppData\Local\Programs\Microsoft VS Code\Code.exe'
CHROME=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
with tempfile.TemporaryDirectory(prefix='gv-debt-ui-',ignore_cleanup_errors=True) as tmp:
    root=Path(tmp);data=root/'data';data.mkdir()
    seed={'products':[{'id':'p','name':'Synthetic','sku':'SYN','barcode':'123456','price':300,'cost':100,'stock':50,'cat':'Test'}],'customers':[{'id':'c','name':'Synthetic buyer','phone':'111','visits':0,'spent':0,'bonus':0}],'sales':[],'counter':1001,'bonusPct':5}
    (data/'db.json').write_text(json.dumps(seed),encoding='utf8')
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    base=f'http://127.0.0.1:{port}';env=os.environ.copy();env.update(ELECTRON_RUN_AS_NODE='1',DATA_DIR=str(data),HOST='127.0.0.1',PORT=str(port),ADMIN_PASSWORD='synthetic-only')
    server=subprocess.Popen([NODE,'server.js'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0));clients=[]
    def state():return json.loads((data/'db.json').read_text(encoding='utf8'))
    try:
        def ready():
            try:return httpx.get(base+'/api/health',timeout=1).status_code==200
            except httpx.HTTPError:return False
        wait_for(ready)
        auth=httpx.post(base+'/api/login',json={'login':'admin','pass':'synthetic-only'}).json();headers={'Authorization':'Bearer '+auth['token']}
        staff=httpx.get(base+'/api/staff',headers=headers).json()['staff'];staff.append({'id':'cashier-2','login':'cashier2','name':'Synthetic cashier','role':'cashier','active':True,'pass':auth['serverHash']});staff.append({'id':'admin-2','login':'admin2','name':'Synthetic admin 2','role':'admin','active':True,'pass':auth['serverHash']});assert httpx.put(base+'/api/staff',headers=headers,json={'staff':staff}).status_code==200
        for num,login in [(1,'admin'),(2,'cashier2'),(3,'admin2')]:
            profile=root/('browser'+str(num));browser=subprocess.Popen([CHROME,'--headless=new','--no-first-run','--disable-extensions','--remote-debugging-port=0',f'--user-data-dir={profile}',base+'/'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            active=profile/'DevToolsActivePort'
            def debug_port():
                try:return int(active.read_text().splitlines()[0])
                except (OSError,ValueError,IndexError):return None
            wait_for(debug_port);dp=debug_port();pages=httpx.get(f'http://127.0.0.1:{dp}/json').json();dev=DevTools(next(p for p in pages if p['url'].startswith(base))['webSocketDebuggerUrl']);clients.append((browser,dev));dev.call('Runtime.enable');dev.call('Emulation.setDeviceMetricsOverride',{'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
            wait_for(lambda:dev.evaluate("document.readyState==='complete' && !!document.querySelector('#loginForm')"));dev.evaluate("new Promise(r=>setTimeout(r,600))")
            dev.evaluate("document.querySelector('#loginName').value="+json.dumps(login)+";document.querySelector('#loginPass').value='synthetic-only';document.querySelector('#loginForm').requestSubmit()")
            wait_for(lambda:dev.evaluate("CURRENT && typeof window.__gvExperimentalSync==='function' && DB.products.some(p=>p.id==='p')"))
        a,b,c=clients[0][1],clients[1][1],clients[2][1]
        for index,parts in enumerate(([300,0,0,0],[0,300,0,0],[0,0,300,0],[100,150,50,0],[100,100,0,100])):
            dev=a
            dev.evaluate("addToCart('p');document.querySelector('#btnCheckout').click()")
            assert dev.evaluate("!!document.querySelector('#gvPaymentDialog')")
            dev.evaluate("{const x=[...document.querySelectorAll('#gvPaymentDialog input')];"+''.join(f"x[{i}].value='{v}';" for i,v in enumerate(parts))+"document.querySelector('#gvPaymentDialog select').value='c';[...document.querySelectorAll('#gvPaymentDialog button')].find(b=>b.textContent==='Подтвердить продажу').click()}")
            try:wait_for(lambda:len(state()['sales'])==index+1)
            except AssertionError:
                print('sale index',index,'browser',dev.evaluate("JSON.stringify({cart:cart.length,dialog:!!document.querySelector('#gvPaymentDialog'),pending:window.__gvCloudVerificationPending,queue:document.querySelector('#syncQueueStatus')?.textContent,toast:document.body.innerText.slice(-400)})"));raise
        assert state()['products'][0]['stock']==45 and state()['sales'][-1]['debtOutstanding']==100
        for dev in (a,c):
            dev.evaluate('window.__gvExperimentalSync()');wait_for(lambda:dev.evaluate('DB.sales.length===5'))
            dev.evaluate("showReceipt(DB.sales.find(s=>s.payments && s.payments.cash===300));document.querySelector('#btnRefundPayment').click()")
            wait_for(lambda:dev.evaluate("!!document.querySelector('#gvRefundDialog')"))
        def submit_refund(dev):
            dev.evaluate("{let d=document.querySelector('#gvRefundDialog');d.querySelector('[data-method=cash]').value='10';d.querySelector('textarea').value='Проверка конфликта';[...d.querySelectorAll('button')].find(x=>x.textContent==='Подтвердить возврат').click()}")
        submit_refund(a);wait_for(lambda:len(state()['sales'][0].get('refunds',[]))==1)
        submit_refund(c)
        wait_for(lambda:c.evaluate("(async()=>{const q=await new ReceiptOutbox().open();const e=(await q.list()).find(x=>x.status==='conflict');q.close();return !!e})()"))
        assert len(state()['sales'][0]['refunds'])==1
        c.evaluate("document.querySelector('#syncQueueStatus').click()")
        wait_for(lambda:c.evaluate("document.body.innerText.includes('Данные продажи изменились. Обновите информацию.')"))
        assert c.evaluate("document.body.innerText.includes('Исходное состояние:') && document.body.innerText.includes('Актуальное состояние:')")
        c.evaluate("[...document.querySelectorAll('button')].find(x=>x.textContent==='Обновить данные').click()")
        wait_for(lambda:c.evaluate("[...document.querySelectorAll('pre')].some(x=>x.textContent.includes('financialRevision'))"))
        assert len(state()['sales'][0]['refunds'])==1
        old=c.evaluate("(async()=>{const q=await new ReceiptOutbox().open();const e=(await q.list()).find(x=>x.status==='conflict');q.close();return e.operationId})()")
        c.evaluate("window.confirm=()=>true;[...document.querySelectorAll('button')].find(x=>x.textContent==='Повторить с актуальными данными').click()")
        wait_for(lambda:len(state()['sales'][0]['refunds'])==2)
        assert state()['sales'][0]['refunds'][1]['operationId']!=old
        print('two admins stale refund, conflict review and explicitly confirmed retry: passed')
        a.evaluate('window.__gvExperimentalSync()');wait_for(lambda:a.evaluate('DB.sales.length===5'))
        a.evaluate("showReceipt(DB.sales.find(s=>s.payments && s.payments.owner_card===50));document.querySelector('#btnRefundPayment').click()")
        wait_for(lambda:a.evaluate("!!document.querySelector('#gvRefundDialog')"))
        a.evaluate("{let d=document.querySelector('#gvRefundDialog');d.querySelector('[data-method=cash]').value='40';d.querySelector('[data-method=terminal]').value='30';d.querySelector('textarea').value='Тест возврата';let b=[...d.querySelectorAll('button')].find(x=>x.textContent==='Подтвердить возврат');b.click();b.click()}")
        wait_for(lambda:len(state()['sales'][3].get('refunds',[]))==1)
        assert state()['sales'][3]['refunds'][0]['reason']=='Тест возврата' and state()['products'][0]['stock']==45
        a.call('Page.reload',{'ignoreCache':True});wait_for(lambda:a.evaluate("typeof window.__gvExperimentalSync==='function'"));a.evaluate('window.__gvExperimentalSync()');wait_for(lambda:a.evaluate("DB.sales.some(s=>s.refunds && s.refunds.length===1)"))
        assert len(state()['sales'][3]['refunds'])==1
        print('GUI mixed partial refund, double click and reload: passed')
        a.evaluate("showReceipt(DB.sales.find(s=>s.payments && s.payments.owner_card===50));document.querySelector('#btnRefundPayment').click()")
        wait_for(lambda:a.evaluate("!!document.querySelector('#gvRefundDialog')"))
        a.call('Network.enable');a.call('Network.emulateNetworkConditions',{'offline':True,'latency':0,'downloadThroughput':0,'uploadThroughput':0})
        a.evaluate("{let d=document.querySelector('#gvRefundDialog');d.querySelector('[data-method=owner_card]').value='10';d.querySelector('textarea').value='Возврат офлайн';[...d.querySelectorAll('button')].find(x=>x.textContent==='Подтвердить возврат').click()}")
        wait_for(lambda:a.evaluate("(async()=>{const q=await new ReceiptOutbox().open();const yes=(await q.list()).some(e=>JSON.parse(e.body).kind==='refund');q.close();return yes})()"))
        assert len(state()['sales'][3]['refunds'])==1
        a.call('Network.emulateNetworkConditions',{'offline':False,'latency':0,'downloadThroughput':-1,'uploadThroughput':-1});a.call('Page.reload',{'ignoreCache':True})
        wait_for(lambda:a.evaluate("typeof window.__gvExperimentalSync==='function'"));a.evaluate('window.__gvExperimentalSync()')
        wait_for(lambda:len(state()['sales'][3]['refunds'])==2)
        a.evaluate('window.__gvExperimentalSync()');assert len(state()['sales'][3]['refunds'])==2 and state()['products'][0]['stock']==45
        print('offline refund survives reload and is sent once: passed')
        a.evaluate("document.querySelector('#debtNav').click()")
        wait_for(lambda:a.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Принять платёж')"))
        a.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Принять платёж').click()")
        a.evaluate("{const d=[...document.querySelectorAll('section')].find(s=>s.querySelector('input[placeholder=\"Сумма в сумах\"]'));d.querySelector('input').value='50';[...d.querySelectorAll('button')].find(b=>b.textContent==='Сохранить платёж').click()}")
        wait_for(lambda:state()['sales'][-1]['debtOutstanding']==50)
        assert state()['products'][0]['stock']==45 and len(state()['sales'])==5
        print('five GUI payment modes, two browser sessions and partial debt repayment: passed')
        a.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Закрыть').click()")
        for dev in (a,c):
            dev.evaluate("document.querySelector('#mobileDebt').click()")
            wait_for(lambda:dev.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Принять платёж')"))
            dev.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Принять платёж').click()")
        for dev in (a,c):
            dev.evaluate("{const d=[...document.querySelectorAll('section')].find(s=>s.querySelector('input[placeholder=\"Сумма в сумах\"]'));d.querySelector('input').value='40';[...d.querySelectorAll('button')].find(b=>b.textContent==='Сохранить платёж').click()}")
        wait_for(lambda:state()['sales'][-1]['debtOutstanding']==10)
        wait_for(lambda:sum(len(d.get('debtPayments',[])) for d in state()['sales'])==2)
        time.sleep(1);assert state()['products'][0]['stock']==45 and len(state()['sales'])==5 and state()['sales'][-1]['debtOutstanding']==10
        print('simultaneous debt repayments reject overpayment: passed')
        a.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Закрыть').click();document.querySelector('#mobileDebt').click()")
        wait_for(lambda:a.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Принять платёж')"))
        a.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Принять платёж').click()")
        a.call('Network.enable');a.call('Network.emulateNetworkConditions',{'offline':True,'latency':0,'downloadThroughput':0,'uploadThroughput':0})
        a.evaluate("{const d=[...document.querySelectorAll('section')].find(s=>s.querySelector('input[placeholder=\"Сумма в сумах\"]'));d.querySelector('input').value='10';[...d.querySelectorAll('button')].find(b=>b.textContent==='Сохранить платёж').click()}")
        wait_for(lambda:a.evaluate("(async()=>{let q=await new ReceiptOutbox().open();let n=(await q.list()).length;q.close();return n>0})()"))
        assert state()['sales'][-1]['debtOutstanding']==10
        a.call('Network.emulateNetworkConditions',{'offline':False,'latency':0,'downloadThroughput':-1,'uploadThroughput':-1});a.call('Page.reload',{'ignoreCache':True})
        wait_for(lambda:a.evaluate("typeof window.__gvExperimentalSync==='function'"));a.evaluate("window.__gvExperimentalSync()")
        wait_for(lambda:state()['sales'][-1]['debtOutstanding']==0)
        a.evaluate("window.__gvExperimentalSync()")
        assert len(state()['sales'])==5 and state()['products'][0]['stock']==45 and len(state()['sales'][-1]['debtPayments'])==3
        print('offline repayment persists through reload and is applied once: passed')
        a.evaluate("addToCart('p');document.querySelector('#btnCheckout').click()")
        a.evaluate("{const d=document.querySelector('#gvPaymentDialog'),x=d.querySelectorAll('input');x[0].value='0';x[3].value='300';d.querySelector('input[placeholder=\"Новый покупатель: имя\"]').value='New synthetic buyer';d.querySelector('input[placeholder=\"Телефон (необязательно)\"]').value='222';[...d.querySelectorAll('button')].find(b=>b.textContent==='Подтвердить продажу').click()}")
        wait_for(lambda:len(state()['sales'])==6)
        saved=state();assert len(saved['customers'])==2 and saved['sales'][-1]['debtOutstanding']==300 and saved['sales'][-1]['customerId']==saved['customers'][-1]['id'] and saved['products'][0]['stock']==44
        print('new buyer and debt sale committed together: passed')
        a.call('Network.emulateNetworkConditions',{'offline':True,'latency':0,'downloadThroughput':0,'uploadThroughput':0})
        a.evaluate("addToCart('p');document.querySelector('#btnCheckout').click()")
        a.evaluate("{const d=document.querySelector('#gvPaymentDialog'),x=d.querySelectorAll('input');x[0].value='0';x[3].value='300';d.querySelector('select').value='c';[...d.querySelectorAll('button')].find(b=>b.textContent==='Подтвердить продажу').click()}")
        wait_for(lambda:a.evaluate("(async()=>{let q=await new ReceiptOutbox().open();let n=(await q.list()).length;q.close();return n>0})()"))
        assert len(state()['sales'])==6 and state()['products'][0]['stock']==44
        a.call('Network.emulateNetworkConditions',{'offline':False,'latency':0,'downloadThroughput':-1,'uploadThroughput':-1});a.call('Page.reload',{'ignoreCache':True})
        wait_for(lambda:a.evaluate("typeof window.__gvExperimentalSync==='function'"));a.evaluate("window.__gvExperimentalSync()")
        wait_for(lambda:len(state()['sales'])==7)
        a.evaluate("window.__gvExperimentalSync()")
        assert len(state()['sales'])==7 and state()['products'][0]['stock']==43 and state()['sales'][-1]['debtOutstanding']==300
        print('offline debt sale survives reload and posts once: passed')
        a.evaluate("""(()=>{const snap={total:300000,cost:100000,profit:200000,subtotal:300000,discountTotal:0,items:[{id:'p',name:'Тест',qty:1,price:300000,cost:100000}],cashier:'Тест'};DB.sales=[{...snap,id:'fixture',paid:true,date:'2026-11-01T05:00:00Z',payments:{cash:100000,terminal:150000,owner_card:50000,debt:0},debtOutstanding:0,debtPayments:[],refunds:[{at:'2026-11-02T05:00:00Z',amounts:{cash:40000,terminal:30000,owner_card:0}},{at:'2026-11-03T05:00:00Z',amounts:{cash:0,terminal:0,owner_card:10000}}],financialEvents:[{kind:'void',at:'2026-11-04T05:00:00Z',snapshot:snap}]}];reportPeriod='custom';document.querySelector('#reportFrom').value='2026-11-01';document.querySelector('#reportTo').value='2026-11-01';renderReports()})()""")
        assert a.evaluate("document.querySelector('#chartTotal').textContent.includes('300') && document.querySelector('#payBreakdown').textContent.includes('150')")
        a.evaluate("document.querySelector('#reportFrom').value='2026-11-02';document.querySelector('#reportTo').value='2026-11-02';renderReports()")
        assert a.evaluate("document.querySelector('#payBreakdown').textContent.includes('40') && document.querySelector('#payBreakdown').textContent.includes('30')")
        a.evaluate("document.querySelector('#reportFrom').value='2026-11-03';document.querySelector('#reportTo').value='2026-11-03';renderReports()")
        assert a.evaluate("document.querySelector('#payBreakdown').textContent.includes('10')")
        a.evaluate("document.querySelector('#reportFrom').value='2026-11-04';document.querySelector('#reportTo').value='2026-11-04';renderReports()")
        assert a.evaluate("document.querySelector('#chartTotal').textContent.includes('300')")
        print('fixed-date report UI with synthetic sale, refunds and void: passed')
    finally:
        for browser,dev in clients:
            try:dev.socket.close();browser.terminate();browser.wait(timeout=10)
            except Exception:pass
        server.terminate();server.wait(timeout=10)
