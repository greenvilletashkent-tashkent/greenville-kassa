"""Serve a loopback-only, synthetic cashier preview; no API or production data."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HTML = (Path(__file__).resolve().parents[1] / 'public' / 'index.html').read_text(encoding='utf-8')
BLOCK_NETWORK = """<script>window.fetch=()=>Promise.reject(new Error('Preview: network disabled'));</script>"""
DEMO = """<script>
window.addEventListener('load',()=>{
  CURRENT={id:'preview',name:'Тестовый кассир',role:'admin'};
  DB={products:[{id:'demo1',name:'Тестовый грунт',sku:'SOIL',barcode:'1234567890123',price:45000,cost:20000,stock:9,cat:'Тест',emoji:'🌱'},
    {id:'demo2',name:'Тестовый горшок',sku:'POT',barcode:'9876543210123',price:35000,cost:10000,stock:9,cat:'Тест',emoji:'🪴'}],customers:[],sales:[],counter:1001,bonusPct:5};
  cart=[]; activeCat='Все'; applyRole();
  const login=document.getElementById('loginScreen'); login.hidden=true; login.style.display='none';
  renderPos();
  const pay=document.getElementById('btnCheckout'); pay.disabled=true;
  pay.addEventListener('click',e=>{e.stopImmediatePropagation();e.preventDefault()},true);
});
</script>"""
HTML = HTML.replace('<head>', '<head>' + BLOCK_NETWORK, 1)
head, tail = HTML.rsplit('</body>', 1)
HTML = head + DEMO + '</body>' + tail

class Preview(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ('/', '/index.html'):
            self.send_error(404)
            return
        data = HTML.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

if __name__ == '__main__':
    print('Тестовая касса: http://127.0.0.1:18763/ — только синтетические товары.', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 18763), Preview).serve_forever()
