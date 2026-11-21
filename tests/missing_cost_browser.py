"""Browser-only checks against a synthetic local preview."""
import os, sys, tempfile, subprocess, threading
from pathlib import Path
from http.server import ThreadingHTTPServer
import httpx
sys.path.insert(0, r'C:\GREENVILLE-POS\server\tests')
sys.path.insert(0, r'C:\GREENVILLE-POS\server')
from test_admin_browser import DevTools, wait_for
from android_preview_server import Preview
class AssetsPreview(Preview):
    def do_GET(self):
        path=self.path.split('?',1)[0]
        if path.startswith('/public/') and '/' not in path[len('/public/'):]:
            file=Path(__file__).resolve().parents[1]/'public'/path[len('/public/'):]
            if file.is_file():
                data=file.read_bytes();self.send_response(200);self.send_header('Content-Type','text/javascript; charset=utf-8');self.end_headers();self.wfile.write(data);return
        super().do_GET()
server=ThreadingHTTPServer(('127.0.0.1',0),AssetsPreview)
threading.Thread(target=server.serve_forever,daemon=True).start()
with tempfile.TemporaryDirectory(prefix='gv-cost-browser-') as profile:
    browser=subprocess.Popen([r'C:\Program Files\Google\Chrome\Application\chrome.exe','--headless=new','--no-first-run','--disable-background-networking','--disable-extensions','--remote-debugging-port=0','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',f'--user-data-dir={profile}',f'http://127.0.0.1:{server.server_port}/'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    try:
        active=Path(profile)/'DevToolsActivePort';wait_for(active.exists);port=int(active.read_text().splitlines()[0])
        pages=httpx.get(f'http://127.0.0.1:{port}/json').json();dev=DevTools(next(p for p in pages if p['url'].startswith('http://127.0.0.1:'))['webSocketDebuggerUrl']);dev.call('Runtime.enable')
        wait_for(lambda:dev.evaluate("document.readyState==='complete' && typeof CURRENT!=='undefined' && CURRENT && CURRENT.id==='preview'"))
        for width in (360,390,1440):
            dev.call('Emulation.setDeviceMetricsOverride',{'width':width,'height':844,'deviceScaleFactor':1,'mobile':width<500})
            dev.evaluate("""CURRENT={name:'Test',role:'admin'};applyRole();DB.products=[{id:'p',name:'Без закупки',sku:'MISSING',barcode:'123456',price:100,cost:null,stock:3,cat:'Тест'},{id:'z',name:'Ноль',sku:'ZERO',barcode:'789',price:100,cost:0,stock:2,cat:'Тест'}];DB.sales=[{id:'s',date:'2026-11-21T08:00:00Z',paid:true,total:200,subtotal:200,cost:null,profit:null,cashier:'Test',items:[{id:'p',name:'Без закупки',qty:2,price:100,cost:null}]}];DB.customers=[];go('products');document.querySelector('[data-filter="missing-cost"]').click();""")
            assert dev.evaluate("document.querySelector('#invBody').innerText.includes('MISSING') && document.querySelector('#invBody').innerText.includes('123456') && document.querySelector('#invBody').innerText.includes('ZERO')")
            dev.evaluate("go('reports');reportPeriod='all';renderReports();document.querySelector('#findMissingCosts').click()")
            assert dev.evaluate("document.querySelector('#missingCostReport').innerText.includes('MISSING') && document.querySelector('#missingCostReport').innerText.includes('200')")
            dev.evaluate("document.querySelector('[data-missing-edit]').click()")
            assert dev.evaluate("document.querySelector('#f-cost').value==='' && document.querySelector('#formTitle').innerText.includes('Изменить')")
            dev.evaluate("closeModals()")
            print('Width',width,'passed')
        dev.call('Browser.close')
    finally:
        browser.terminate()
        try:browser.wait(timeout=10)
        except subprocess.TimeoutExpired:browser.terminate()
        server.shutdown()
