"""Review synthetic uncertain messages via admin browser; no Telegram connection."""
import json,os,socket,subprocess,tempfile,time
from pathlib import Path
import httpx
from browser_devtools import DevTools,wait_for
ROOT=Path(__file__).resolve().parents[1];NODE=r'C:\Users\kurba\AppData\Local\Programs\Microsoft VS Code\Code.exe';CHROME=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
with tempfile.TemporaryDirectory(prefix='gv-telegram-review-ui-',ignore_cleanup_errors=True) as tmp:
 root=Path(tmp);db=root/'data';db.mkdir();(db/'db.json').write_text(json.dumps({'products':[],'sales':[],'customers':[],'counter':1001,'operations':{},'telegramOutbox':[{'id':'sale:x','status':'uncertain','type':'sale','createdAt':'2026-11-20T10:00:00Z','text':'Синтетическое сообщение'}]}),encoding='utf8')
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 env=os.environ.copy();env.update(ELECTRON_RUN_AS_NODE='1',DATA_DIR=str(db),HOST='127.0.0.1',PORT=str(port),ADMIN_PASSWORD='synthetic-only',TELEGRAM_ENABLED='0');env.pop('TELEGRAM_BOT_TOKEN',None);env.pop('TELEGRAM_CHAT_ID',None)
 server=subprocess.Popen([NODE,'server.js'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0));browser=None;dev=None;base=f'http://127.0.0.1:{port}'
 try:
  def ready():
   try:return httpx.get(base+'/api/health',timeout=1).status_code==200
   except httpx.HTTPError:return False
  wait_for(ready);profile=root/'profile';browser=subprocess.Popen([CHROME,'--headless=new','--no-first-run','--disable-extensions','--remote-debugging-port=0',f'--user-data-dir={profile}',base+'/'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0));active=profile/'DevToolsActivePort'
  def debug_port():
   try:return int(active.read_text().splitlines()[0])
   except (OSError,ValueError,IndexError):return None
  wait_for(debug_port);pages=httpx.get(f'http://127.0.0.1:{debug_port()}/json').json();dev=DevTools(next(p for p in pages if p['url'].startswith(base))['webSocketDebuggerUrl']);dev.call('Runtime.enable');dev.call('Emulation.setDeviceMetricsOverride',{'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
  wait_for(lambda:dev.evaluate("document.readyState==='complete' && !!document.querySelector('#loginForm')"));dev.evaluate('new Promise(r=>setTimeout(r,600))');dev.evaluate("document.querySelector('#loginName').value='admin';document.querySelector('#loginPass').value='synthetic-only';document.querySelector('#loginForm').requestSubmit()")
  wait_for(lambda:dev.evaluate("CURRENT && typeof window.__gvTelegramReview==='function'"));dev.evaluate("document.querySelector('#mobileTelegramReview').click()")
  wait_for(lambda:dev.evaluate("document.body.innerText.includes('Синтетическое сообщение') && document.body.innerText.includes('sale:x')"))
  dev.evaluate("window.confirm=()=>false;[...document.querySelectorAll('button')].find(b=>b.textContent==='Повторить отправку').click()")
  assert json.loads((db/'db.json').read_text(encoding='utf8'))['telegramOutbox'][0]['status']=='uncertain'
  dev.evaluate("window.confirm=()=>true;[...document.querySelectorAll('button')].find(b=>b.textContent==='Отметить доставленным').click()")
  wait_for(lambda:json.loads((db/'db.json').read_text(encoding='utf8'))['telegramOutbox'][0]['status']=='sent')
  assert len(json.loads((db/'db.json').read_text(encoding='utf8'))['telegramOutbox'][0]['reviewHistory'])==1
  print('admin UI displays uncertain notice and requires explicit decision: passed')
 finally:
  if dev:dev.socket.close()
  if browser:browser.terminate();browser.wait(timeout=10)
  server.terminate();server.wait(timeout=10)
