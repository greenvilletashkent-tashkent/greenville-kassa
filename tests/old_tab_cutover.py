"""Exercise a page loaded before a server upgrade on synthetic data."""
import json,os,socket,subprocess,tempfile,time
from pathlib import Path
import httpx
from browser_devtools import DevTools,wait_for
ROOT=Path(__file__).resolve().parents[1]
guarded=os.environ.get('GV_TEST_GUARD')=='1'
OLD=Path(r'C:\GREENVILLE-AI\greenville-kassa-guard' if guarded else r'C:\GREENVILLE-AI\greenville-kassa-catalog-fix')
NODE=r'C:\Users\kurba\AppData\Local\Programs\Microsoft VS Code\Code.exe'
CHROME=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
with tempfile.TemporaryDirectory(prefix='gv-cutover-',ignore_cleanup_errors=True) as tmp:
    root=Path(tmp);data=root/'data';data.mkdir();profile=root/'browser'
    (data/'db.json').write_text(json.dumps({'products':[{'id':'p','name':'Synthetic','sku':'TEST','barcode':'123456','price':100,'cost':50,'stock':10,'cat':'Тест'}],'customers':[],'sales':[],'counter':1001,'bonusPct':5}),encoding='utf8')
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    base=f'http://127.0.0.1:{port}';env=os.environ.copy();env.update(ELECTRON_RUN_AS_NODE='1',DATA_DIR=str(data),HOST='127.0.0.1',PORT=str(port),ADMIN_PASSWORD='synthetic-only')
    proc=None;browser=None;dev=None
    def start(folder):
        global proc
        proc=subprocess.Popen([NODE,'server.js'],cwd=folder,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        def ready():
            try:return httpx.get(base+'/api/health',timeout=1).status_code==200
            except httpx.HTTPError:return False
        wait_for(ready)
    try:
        start(OLD)
        browser=subprocess.Popen([CHROME,'--headless=new','--no-first-run','--disable-extensions','--remote-debugging-port=0',f'--user-data-dir={profile}',base+'/'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        active=profile/'DevToolsActivePort';wait_for(active.exists);portdev=int(active.read_text().splitlines()[0]);pages=httpx.get(f'http://127.0.0.1:{portdev}/json').json()
        dev=DevTools(next(p for p in pages if p['url'].startswith(base))['webSocketDebuggerUrl']);dev.call('Runtime.enable');dev.call('Emulation.setDeviceMetricsOverride',{'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
        wait_for(lambda:dev.evaluate("document.readyState==='complete' && !!document.querySelector('#loginForm')"));dev.evaluate("new Promise(r=>setTimeout(r,700))")
        dev.evaluate("document.querySelector('#loginName').value='admin';document.querySelector('#loginPass').value='synthetic-only';document.querySelector('#loginForm').requestSubmit()")
        wait_for(lambda:dev.evaluate("typeof CURRENT!=='undefined' && CURRENT && DB.products.some(p=>p.id==='p')"))
        dev.evaluate("window.__cutoverWarning='';window.alert=(message)=>{window.__cutoverWarning=message};addToCart('p')")
        proc.terminate();proc.wait(timeout=10);start(ROOT)
        dev.evaluate("document.querySelector('#btnCheckout').click()")
        time.sleep(3)
        state=json.loads((data/'db.json').read_text(encoding='utf8'))
        warning=dev.evaluate("window.__cutoverWarning==='Касса обновлена. Перезагрузите страницу'")
        localSale=dev.evaluate("DB.sales.length>0")
        print('old page: local sale visible:',localSale,'server sales:',len(state['sales']),'server stock:',state['products'][0]['stock'],'reload warning:',warning,flush=True)
        assert len(state['sales'])==0 and state['products'][0]['stock']==10
        if guarded:
            assert warning and not localSale
            dev.call('Page.reload',{'ignoreCache':True})
            wait_for(lambda:dev.evaluate("document.readyState==='complete' && !!document.querySelector('#loginForm')"))
            if dev.evaluate("!document.querySelector('#loginScreen').hidden"):
                dev.evaluate("document.querySelector('#loginName').value='admin';document.querySelector('#loginPass').value='synthetic-only';document.querySelector('#loginForm').requestSubmit()")
            try:wait_for(lambda:dev.evaluate("typeof window.__gvExperimentalCheckout==='function' && typeof window.__gvExperimentalSync==='function' && CURRENT && DB.products.some(p=>p.id==='p')"))
            except AssertionError:
                print('transition state:',dev.evaluate("JSON.stringify({checkout:typeof window.__gvExperimentalCheckout,sync:typeof window.__gvExperimentalSync,logged:!!CURRENT,loginHidden:document.querySelector('#loginScreen').hidden,legacy:!!document.querySelector('#gvLegacyTransition'),products:DB.products.length})"),flush=True)
                raise
            dev.evaluate("addToCart('p');document.querySelector('#btnCheckout').click()")
            wait_for(lambda:len(json.loads((data/'db.json').read_text(encoding='utf8'))['sales'])==1)
            saved=json.loads((data/'db.json').read_text(encoding='utf8'));assert saved['products'][0]['stock']==9
            dev.evaluate("window.__gvExperimentalSync()")
            saved=json.loads((data/'db.json').read_text(encoding='utf8'));assert len(saved['sales'])==1 and saved['products'][0]['stock']==9
            print('refreshed page: new sale and repeat synchronization passed',flush=True)
    finally:
        if(dev):dev.socket.close()
        if(browser):browser.terminate();browser.wait(timeout=10)
        if(proc):proc.terminate();proc.wait(timeout=10)
