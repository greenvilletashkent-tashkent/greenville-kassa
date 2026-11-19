import json, os, socket, subprocess, tempfile
from pathlib import Path
import httpx
from browser_devtools import DevTools, wait_for

ROOT=Path(__file__).resolve().parents[1]
NODE=r'C:\Users\kurba\AppData\Local\Programs\Microsoft VS Code\Code.exe'
CHROME=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
with tempfile.TemporaryDirectory(prefix='gv-mobile-',ignore_cleanup_errors=True) as tmp:
    root=Path(tmp); data=root/'data';data.mkdir();profile=root/'browser'
    products=[{'id':str(i),'name':'Тестовый длинный товар '+str(i),'sku':'SKU-'+str(i),'barcode':str(100000+i),'price':100,'cost':50,'stock':5,'cat':'Тест'} for i in range(20)]
    (data/'db.json').write_text(json.dumps({'products':products,'customers':[],'sales':[],'counter':1001,'bonusPct':5}),encoding='utf8')
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    base=f'http://127.0.0.1:{port}';env=os.environ.copy();env.update(ELECTRON_RUN_AS_NODE='1',DATA_DIR=str(data),HOST='127.0.0.1',PORT=str(port),ADMIN_PASSWORD='synthetic-only')
    server=subprocess.Popen([NODE,'server.js'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0));browser=None;dev=None
    try:
        def ready():
            try:return httpx.get(base+'/api/health',timeout=1).status_code==200
            except httpx.HTTPError:return False
        wait_for(ready)
        browser=subprocess.Popen([CHROME,'--headless=new','--no-first-run','--disable-extensions','--remote-debugging-port=0',f'--user-data-dir={profile}',base+'/'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        active=profile/'DevToolsActivePort';wait_for(active.exists);dp=int(active.read_text().splitlines()[0]);pages=httpx.get(f'http://127.0.0.1:{dp}/json').json()
        dev=DevTools(next(p for p in pages if p['url'].startswith(base))['webSocketDebuggerUrl']);dev.call('Runtime.enable')
        dev.call('Emulation.setDeviceMetricsOverride',{'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
        wait_for(lambda:dev.evaluate("document.readyState==='complete' && !!document.querySelector('#loginForm')"));dev.evaluate("new Promise(r=>setTimeout(r,700))")
        dev.evaluate("document.querySelector('#loginName').value='admin';document.querySelector('#loginPass').value='synthetic-only';document.querySelector('#loginForm').requestSubmit()")
        wait_for(lambda:dev.evaluate("typeof DB!=='undefined' && DB.products.length===20 && CURRENT && document.querySelector('#loginScreen').hidden && typeof window.__gvExperimentalSync==='function'"))
        for width,height in [(320,568),(360,800),(390,844),(414,896)]:
            dev.call('Emulation.setDeviceMetricsOverride',{'width':width,'height':height,'deviceScaleFactor':1,'mobile':True})
            dev.evaluate("body=document.body;body.classList.add('gv-phone');cart=[];for(let i=0;i<12;i++)addToCart(String(i));renderPos()")
            r=dev.evaluate("(()=>{let sel=['#posSearch','#btnScan','.ci-qty button','#btnCheckout','.pay-btn'];let x={};for(const s of sel){let r=document.querySelector(s).getBoundingClientRect();x[s]=[r.width,r.height,r.left,r.right,r.top,r.bottom]}x.scroll=document.documentElement.scrollWidth;x.viewport=innerWidth;return x})()")
            assert r['#posSearch'][1]>=48 and r['#btnScan'][1]>=48 and r['.ci-qty button'][1]>=48 and r['#btnCheckout'][1]>=48 and r['.pay-btn'][1]>=48,(width,r)
            assert r['scroll']<=r['viewport'] and r['#btnCheckout'][5]<=height,(width,r)
            print(width,height,'passed',flush=True)
    finally:
        if(dev):dev.socket.close()
        if(browser):browser.terminate();browser.wait(timeout=10)
        server.terminate();server.wait(timeout=10)
