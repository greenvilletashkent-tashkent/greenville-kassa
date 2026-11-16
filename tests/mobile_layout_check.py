"""Local browser checks with synthetic data; never connects to the cloud."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer

import httpx

sys.path.insert(0, r'C:\GREENVILLE-POS\server\tests')
sys.path.insert(0, r'C:\GREENVILLE-POS\server')
from test_admin_browser import DevTools, wait_for
from android_preview_server import Preview

ROOT = Path(__file__).resolve().parents[1]
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'

server = ThreadingHTTPServer(('127.0.0.1', 0), Preview)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='gv-browser-') as profile:
    browser = subprocess.Popen([CHROME, '--headless=new', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-extensions', '--remote-debugging-port=0',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', f'--user-data-dir={profile}',
        f'http://127.0.0.1:{server.server_port}/'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        active = Path(profile) / 'DevToolsActivePort'
        wait_for(active.exists)
        port = int(active.read_text().splitlines()[0])
        pages = httpx.get(f'http://127.0.0.1:{port}/json').json()
        dev = DevTools(next(p for p in pages if p['url'].startswith('http://127.0.0.1:'))['webSocketDebuggerUrl'])
        dev.call('Runtime.enable')
        try:
            wait_for(lambda: dev.evaluate("typeof renderPos === 'function' && !!document.getElementById('posSearch')"))
        except AssertionError:
            print(dev.evaluate("JSON.stringify({url:location.href,title:document.title,ready:document.readyState,body:document.body&&document.body.innerText.slice(0,300)})"))
            raise
        wait_for(lambda: dev.evaluate("document.readyState==='complete' && typeof CURRENT!=='undefined' && CURRENT && CURRENT.id==='preview'"))
        assert dev.evaluate("DB.products.length===2 && DB.products[0].id==='demo1'")
        for label, width, height, mobile in [('Android', 360, 800, True), ('iPhone', 390, 844, True), ('desktop', 1440, 900, False)]:
            dev.call('Emulation.setDeviceMetricsOverride', {'width':width,'height':height,'deviceScaleFactor':1,'mobile':mobile})
            dev.evaluate("""CURRENT={name:'Test Cashier',role:'admin'}; applyRole();
              DB={products:[{id:'a',name:'Тестовый грунт',sku:'SOIL',barcode:'123456',price:45000,cost:20000,stock:5,cat:'Земля',emoji:'🌱'},
              {id:'b',name:'Тестовый горшок',sku:'POT',barcode:'789012',price:35000,cost:10000,stock:6,cat:'Горшки',emoji:'🪴'}],customers:[],sales:[],counter:1001,bonusPct:5};
              cart=[]; activeCat='Все'; document.getElementById('posSearch').value=''; document.getElementById('loginScreen').hidden=true;
              document.getElementById('loginScreen').style.display='none'; renderPos();""")
            state = dev.evaluate("""(()=>{const b=x=>document.querySelector(x).getBoundingClientRect();
              return {phone:document.body.classList.contains('gv-phone'),grid:getComputedStyle(document.querySelector('#productGrid')).display,
              results:document.querySelector('#matchList').hidden,search:b('#posSearch').toJSON(),cart:b('.pos-cart').toJSON(),
              total:b('#sumTotal').toJSON(),pay:b('#btnCheckout').toJSON()}})()""")
            assert state['phone'] == mobile, (label, state)
            if mobile:
                assert state['grid'] == 'none' and state['results'], (label, state)
                assert state['cart']['top'] >= state['search']['bottom'] and state['pay']['bottom'] <= height, (label, state)
                dev.evaluate("{const s=document.querySelector('#posSearch');s.value='грунт';s.dispatchEvent(new Event('input',{bubbles:true}))}")
                assert dev.evaluate("document.querySelectorAll('#matchList .m-row').length") == 1
                dev.evaluate("document.querySelector('#matchList .m-row').click()")
                assert dev.evaluate("document.querySelector('#matchList').hidden && document.querySelector('#posSearch').value==='' && cart.length===1 && cart[0].qty===1")
                assert dev.evaluate("document.querySelector('#sumTotal').textContent.includes('45')")
                dev.evaluate("document.querySelector('[data-plus=\"a\"]').click()")
                assert dev.evaluate("cart[0].qty===2 && document.querySelector('#sumTotal').textContent.includes('90')")
                dev.evaluate("document.querySelector('[data-minus=\"a\"]').click();document.querySelector('[data-minus=\"a\"]').click()")
                assert dev.evaluate("cart.length===0")
                dev.evaluate("{const s=document.querySelector('#posSearch');s.value='789012';s.dispatchEvent(new Event('input',{bubbles:true}))}")
                assert dev.evaluate("document.querySelectorAll('#matchList .m-row').length") == 1
                assert dev.evaluate("getComputedStyle(document.querySelector('#btnScan')).display!=='none'")
                dev.evaluate("document.querySelector('#matchList .m-row').click(); for(let i=0;i<15;i++){let p={...DB.products[0],id:'extra'+i,name:'Товар '+i};DB.products.push(p);addToCart(p.id)}")
                assert dev.evaluate("document.querySelector('#cartItems').scrollHeight > document.querySelector('#cartItems').clientHeight")
                assert dev.evaluate(f"document.querySelector('#btnCheckout').getBoundingClientRect().bottom <= {height}")
                img = dev.call('Page.captureScreenshot', {'format':'png'})['data']
                (ROOT / f'mobile-preview-{label.lower()}.png').write_bytes(base64.b64decode(img))
            else:
                assert state['grid'] != 'none', state
            print(label + ': passed')
        dev.call('Browser.close')
    finally:
        try: browser.wait(timeout=10)
        except subprocess.TimeoutExpired: browser.terminate()
        server.shutdown()
