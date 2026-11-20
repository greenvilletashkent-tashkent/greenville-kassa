"""Two isolated browser profiles; a synthetic cash register is opened once."""
import json,os,socket,subprocess,tempfile,time
from pathlib import Path
import httpx
from browser_devtools import DevTools,wait_for
ROOT=Path(__file__).resolve().parents[1]
NODE=r'C:\Users\kurba\AppData\Local\Programs\Microsoft VS Code\Code.exe'
CHROME=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
with tempfile.TemporaryDirectory(prefix='gv-cash-open-',ignore_cleanup_errors=True) as tmp:
 folder=Path(tmp);db=folder/'data';db.mkdir();(db/'db.json').write_text(json.dumps({'products':[],'sales':[],'customers':[],'counter':1001,'operations':{}}),encoding='utf8')
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 base=f'http://127.0.0.1:{port}';env=os.environ.copy();env.update(ELECTRON_RUN_AS_NODE='1',DATA_DIR=str(db),HOST='127.0.0.1',PORT=str(port),ADMIN_PASSWORD='synthetic-only')
 server=subprocess.Popen([NODE,'server.js'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0));clients=[]
 try:
  def ready():
   try:return httpx.get(base+'/api/health',timeout=1).status_code==200
   except httpx.HTTPError:return False
  wait_for(ready);auth=httpx.post(base+'/api/login',json={'login':'admin','pass':'synthetic-only'}).json();headers={'Authorization':'Bearer '+auth['token']}
  staff=httpx.get(base+'/api/staff',headers=headers).json()['staff'];staff.append({'id':'c2','login':'cashier2','name':'Synthetic cashier','role':'cashier','active':True,'pass':auth['serverHash']});assert httpx.put(base+'/api/staff',headers=headers,json={'staff':staff}).status_code==200
  for num,login in [(1,'admin'),(2,'cashier2')]:
   profile=folder/f'profile-{num}';proc=subprocess.Popen([CHROME,'--headless=new','--no-first-run','--disable-extensions','--remote-debugging-port=0',f'--user-data-dir={profile}',base+'/'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
   active=profile/'DevToolsActivePort'
   def port_ready():
    try:return int(active.read_text().splitlines()[0])
    except (OSError,ValueError,IndexError):return None
   wait_for(port_ready);pages=httpx.get(f'http://127.0.0.1:{port_ready()}/json').json();dev=DevTools(next(p for p in pages if p['url'].startswith(base))['webSocketDebuggerUrl']);clients.append((proc,dev));dev.call('Runtime.enable');dev.call('Emulation.setDeviceMetricsOverride',{'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
   wait_for(lambda:dev.evaluate("document.readyState==='complete' && !!document.querySelector('#loginForm')"));dev.evaluate('new Promise(r=>setTimeout(r,600))');dev.evaluate("document.querySelector('#loginName').value="+json.dumps(login)+";document.querySelector('#loginPass').value='synthetic-only';document.querySelector('#loginForm').requestSubmit()")
   wait_for(lambda:dev.evaluate("CURRENT && typeof window.__gvOpenCash==='function'"));dev.evaluate("document.querySelector('#mobileCash').click()")
   wait_for(lambda:dev.evaluate("document.body.innerText.includes('Касса ещё не открыта')"))
  admin,cashier=clients[0][1],clients[1][1]
  assert cashier.evaluate("![...document.querySelectorAll('button')].some(b=>b.textContent==='Открыть кассу')")
  admin.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Открыть кассу').click();document.querySelector('input[placeholder=\"Фактический остаток (сум)\"]').value='0';window.confirm=()=>true")
  admin.call('Network.enable');admin.call('Network.emulateNetworkConditions',{'offline':True,'latency':0,'downloadThroughput':0,'uploadThroughput':0})
  admin.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Подтвердить открытие').click()")
  wait_for(lambda:admin.evaluate("(async()=>{const q=await new ReceiptOutbox().open();const n=(await q.list()).filter(x=>JSON.parse(x.body).kind==='cash_open').length;q.close();return n===1})()"))
  assert 'cashRegister' not in json.loads((db/'db.json').read_text(encoding='utf8'))
  admin.call('Network.emulateNetworkConditions',{'offline':False,'latency':0,'downloadThroughput':-1,'uploadThroughput':-1});admin.call('Page.reload',{'ignoreCache':True})
  wait_for(lambda:admin.evaluate("typeof window.__gvExperimentalSync==='function'"));admin.evaluate('window.__gvExperimentalSync()')
  wait_for(lambda:json.loads((db/'db.json').read_text(encoding='utf8')).get('cashRegister'))
  state=json.loads((db/'db.json').read_text(encoding='utf8'));assert state['cashRegister']['openingBalance']==0 and len(state['operations'])==1
  admin.evaluate("document.querySelector('#mobileCash').click()")
  wait_for(lambda:admin.evaluate("document.body.innerText.includes('Остаток наличных: 0 сум')"))
  print('admin opens once with zero after offline restart; cashier cannot open: passed')
 finally:
  for proc,dev in clients:
   try:dev.socket.close();proc.terminate();proc.wait(timeout=10)
   except Exception:pass
  server.terminate();server.wait(timeout=10)
