"""Confirm a single fake Telegram request from an isolated admin browser."""
import json,os,socket,subprocess,tempfile
from pathlib import Path
import httpx
from browser_devtools import DevTools,wait_for
ROOT=Path(__file__).resolve().parents[1];NODE=r'C:\Users\kurba\AppData\Local\Programs\Microsoft VS Code\Code.exe';CHROME=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
with tempfile.TemporaryDirectory(prefix='gv-telegram-direct-',ignore_cleanup_errors=True) as tmp:
 root=Path(tmp);db=root/'data';db.mkdir();(db/'db.json').write_text(json.dumps({'products':[],'sales':[],'customers':[],'counter':1001,'operations':{}}),encoding='utf8');capture=root/'capture.jsonl'
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 env=os.environ.copy();env.update(ELECTRON_RUN_AS_NODE='1',DATA_DIR=str(db),HOST='127.0.0.1',PORT=str(port),ADMIN_PASSWORD='synthetic-only',TELEGRAM_ENABLED='0',TELEGRAM_TEST_DIRECT='1',TELEGRAM_BOT_TOKEN='fake-token',TELEGRAM_CHAT_ID='fake-chat',TELEGRAM_TEST_CAPTURE=str(capture))
 server=subprocess.Popen([NODE,'--require',str(ROOT/'tests'/'telegram_fetch_stub.js'),'server.js'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0));browser=None;dev=None;base=f'http://127.0.0.1:{port}'
 try:
  def ready():
   try:return httpx.get(base+'/api/health',timeout=1).status_code==200
   except httpx.HTTPError:return False
  wait_for(ready);profile=root/'profile';browser=subprocess.Popen([CHROME,'--headless=new','--no-first-run','--disable-extensions','--remote-debugging-port=0',f'--user-data-dir={profile}',base+'/'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0));active=profile/'DevToolsActivePort'
  def debug_port():
   try:return int(active.read_text().splitlines()[0])
   except (OSError,ValueError,IndexError):return None
  wait_for(debug_port);pages=httpx.get(f'http://127.0.0.1:{debug_port()}/json').json();dev=DevTools(next(p for p in pages if p['url'].startswith(base))['webSocketDebuggerUrl']);dev.call('Runtime.enable')
  wait_for(lambda:dev.evaluate("document.readyState==='complete' && !!document.querySelector('#loginForm')"));dev.evaluate('new Promise(r=>setTimeout(r,600))');dev.evaluate("document.querySelector('#loginName').value='admin';document.querySelector('#loginPass').value='synthetic-only';document.querySelector('#loginForm').requestSubmit()")
  wait_for(lambda:dev.evaluate("CURRENT && typeof window.__gvTelegramReview==='function'"));before=(db/'db.json').read_bytes();staff=(db/'staff.json').read_bytes();dev.evaluate("document.querySelector('#telegramReviewNav').click()")
  wait_for(lambda:dev.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Отправить одно тестовое сообщение')"))
  dev.evaluate("window.confirm=()=>false;[...document.querySelectorAll('button')].find(b=>b.textContent==='Отправить одно тестовое сообщение').click()")
  assert not capture.exists()
  dev.evaluate("window.confirm=()=>true;[...document.querySelectorAll('button')].find(b=>b.textContent==='Отправить одно тестовое сообщение').click()")
  wait_for(capture.exists);message=json.loads(capture.read_text(encoding='utf8').strip());assert message['text']=='✅ GREENVILLE Kassa — Telegram подключён. Тестовое сообщение, не является продажей'
  assert (db/'db.json').read_bytes()==before and (db/'staff.json').read_bytes()==staff
  assert len(capture.read_text(encoding='utf8').splitlines())==1
  print('administrator confirmation sends one fake request without modifying database: passed')
 finally:
  if dev:dev.socket.close()
  if browser:browser.terminate();browser.wait(timeout=10)
  server.terminate();server.wait(timeout=10)
