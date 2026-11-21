"""Isolated end-to-end catalogue updates; all data and ports are synthetic."""
import json,os,socket,subprocess,sys,tempfile
from pathlib import Path
import httpx
sys.path.insert(0,r'C:\GREENVILLE-POS\server\tests');sys.path.insert(0,r'C:\GREENVILLE-POS\server')
from browser_devtools import DevTools,wait_for
ROOT=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='gv-catalog-refresh-',ignore_cleanup_errors=True) as tmp:
    root=Path(tmp);db=root/'db';db.mkdir();profile=root/'browser'
    products=[{'id':i,'name':name,'sku':i,'barcode':i+'123','price':100,'cost':0,'stock':5,'cat':'Грунты','emoji':'🌱'} for i,name in [('p1','Первый'),('p2','Второй')]]
    (db/'db.json').write_text(json.dumps({'products':products,'customers':[],'sales':[],'counter':1001,'bonusPct':0}),encoding='utf8')
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    env=os.environ.copy();env.update(ELECTRON_RUN_AS_NODE='1',DATA_DIR=str(db),HOST='127.0.0.1',PORT=str(port),ADMIN_PASSWORD='synthetic-only',GREENVILLE_EXPERIMENTAL_V3='1')
    server=subprocess.Popen([r'C:\Users\kurba\AppData\Local\Programs\Microsoft VS Code\Code.exe','server.js'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0));browser=None;dev=None;base=f'http://127.0.0.1:{port}'
    try:
        def ready():
            try:return httpx.get(base+'/api/health',timeout=1).status_code==200
            except httpx.HTTPError:return False
        wait_for(ready)
        browser=subprocess.Popen([r'C:\Program Files\Google\Chrome\Application\chrome.exe','--headless=new','--no-first-run','--disable-background-networking','--disable-extensions','--remote-debugging-port=0','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',f'--user-data-dir={profile}',base+'/'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        active=profile/'DevToolsActivePort';wait_for(active.exists);port2=int(active.read_text().splitlines()[0]);pages=httpx.get(f'http://127.0.0.1:{port2}/json').json();dev=DevTools(next(p for p in pages if p['url'].startswith(base))['webSocketDebuggerUrl']);dev.call('Runtime.enable')
        wait_for(lambda:dev.evaluate("document.readyState==='complete' && !!document.querySelector('#loginForm')"))
        dev.evaluate("document.querySelector('#loginName').value='admin';document.querySelector('#loginPass').value='synthetic-only';document.querySelector('#loginForm').requestSubmit()")
        wait_for(lambda:dev.evaluate("typeof window.__gvExperimentalSync==='function' && DB.products.some(p=>p.id==='p1')"))
        for width in (390,1440):
            dev.call('Emulation.setDeviceMetricsOverride',{'width':width,'height':844,'deviceScaleFactor':1,'mobile':width<500})
            dev.evaluate("go('products');document.querySelector('[data-filter=\"missing-cost\"]').click()")
            assert dev.evaluate("document.querySelector('#invBody').innerText.includes('Первый')")
        dev.evaluate("go('pos');addToCart('p1');go('products');document.querySelector('[data-filter=\"all\"]').click();openProductForm('p1');document.querySelector('#f-name').value='Изменённый';document.querySelector('#f-price').value='120';document.querySelector('#f-cost').value='50';saveProduct()")
        wait_for(lambda:dev.evaluate("document.querySelector('#invBody').innerText.includes('Изменённый') && DB.products.find(p=>p.id==='p1').price===120"))
        assert dev.evaluate("cart[0].name==='Изменённый' && cart[0].price===100 && document.querySelector('#cartItems').innerText.includes('Цена в каталоге изменилась')")
        dev.evaluate("openProductForm('p2');document.querySelector('#f-name').value='Другой';saveProduct()")
        wait_for(lambda:dev.evaluate("document.querySelector('#invBody').innerText.includes('Другой')"))
        dev.evaluate("addToCart('p2');window.confirm=()=>true;window.__gvArchiveProduct('p2')")
        wait_for(lambda:dev.evaluate("!document.querySelector('#invBody').innerText.includes('Другой') && DB.products.find(p=>p.id==='p2').deleted"))
        assert dev.evaluate("cart.some(i=>i.id==='p2') && document.querySelector('#cartItems').innerText.includes('Товар недоступен в каталоге')")
        assert dev.evaluate("(()=>{go('pos');window.__gvScannedId='p2';document.querySelector('#posSearch').value='p2123';renderProductGrid();return !document.querySelector('#matchList').innerText.includes('Другой')})()")
        dev.evaluate("go('products')")
        dev.evaluate("window.__gvExperimentalSync()")
        assert dev.evaluate("!document.querySelector('#invBody').innerText.includes('Другой') && DB.products.find(p=>p.id==='p1').stock===5 && DB.sales.length===0")
        overlap=dev.evaluate("""(async()=>{const original=window.fetch;let active=0,max=0;window.fetch=async(...a)=>{if(String(a[0]).includes('/api/experimental/state')){active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,100));try{return await original(...a)}finally{active--}}return original(...a)};try{await Promise.all([window.__gvExperimentalSync(),window.__gvExperimentalSync()]);return max}finally{window.fetch=original}})()""")
        assert overlap==1
        dev.evaluate("""window.__originalFetch=window.fetch;window.fetch=(...a)=>String(a[0]).includes('/api/experimental/product-save')?Promise.resolve(new Response(JSON.stringify({ok:false}),{status:409,headers:{'content-type':'application/json'}})):window.__originalFetch(...a);openProductForm('p1');document.querySelector('#f-name').value='Отклонено';saveProduct()""")
        wait_for(lambda:dev.evaluate("document.querySelector('#syncQueueStatus').textContent.includes('1')"))
        assert dev.evaluate("DB.products.find(p=>p.id==='p1').name==='Изменённый' && !document.querySelector('#invBody').innerText.includes('Отклонено')")
        dev.evaluate("window.fetch=window.__originalFetch")
        print('Catalogue edit, cart, sequential edits, archive and refresh: passed')
    finally:
        if dev:
            try:dev.call('Browser.close')
            except Exception:pass
        if browser:
            try:browser.wait(timeout=10)
            except subprocess.TimeoutExpired:browser.terminate();browser.wait(timeout=10)
        server.terminate();server.wait(timeout=10)
