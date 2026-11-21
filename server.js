/*
  Greenville POS — общий сервер для нескольких устройств.
  Без внешних библиотек: только Node.js 18+.

  Запуск локально (в магазине, без интернета):
    node server.js
    → открыть http://localhost:8080

  Запуск в облаке:
    PORT и DATA_DIR задаёт хостинг; ADMIN_PASSWORD — свой пароль администратора.
*/
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const telegramNotifications = require('./sync/telegram_notifications');
const telegramTestAttempts = new Map();
let telegramTestCompleted = false;
// The protected protocol is the default. The opt-out is for isolated regression tests.
const experimentalReceiptLedger = process.env.GREENVILLE_EXPERIMENTAL_V3 === '0'
  ? null : require('./sync/receipt_ledger');

/* ---------- настройки ---------- */
const DIR      = __dirname;
const PUBLIC   = path.join(DIR, 'public');
/* Постоянный диск в облаке: если хостинг дал отдельную папку для данных —
   кладём базу туда, иначе она пропадёт при перезапуске. */
function pickDataDir(){
  if(process.env.DATA_DIR) return process.env.DATA_DIR;
  const cands = ['/data', '/var/data', '/mnt/data', path.join(DIR, 'data')];
  for(const d of cands){
    try{
      if(d === path.join(DIR, 'data')) return d;
      const st = fs.statSync(d);
      if(st.isDirectory()){ fs.accessSync(d, fs.constants.W_OK); return d; }
    }catch(e){}
  }
  return path.join(DIR, 'data');
}
const DATA_DIR = pickDataDir();
const PORT     = +(process.env.PORT || 8080);
const HOST     = process.env.HOST || '0.0.0.0';
const FILE_DB   = path.join(DATA_DIR, 'db.json');
const FILE_AUTH = path.join(DATA_DIR, 'staff.json');
const FILE_RATE = path.join(DATA_DIR, 'rate.json');
const FILE_LOG  = path.join(DATA_DIR, 'changes.log');
const FILE_SESS = path.join(DATA_DIR, 'sessions.json');
let experimentalStorageUncertain = false;

function persistExperimentalDb(value){
  const tmp=FILE_DB+'.'+process.pid+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  let fd=null,renamed=false;
  try{
    fd=fs.openSync(tmp,'wx',0o600);
    fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
    fs.renameSync(tmp,FILE_DB);renamed=true;
    if(process.platform!=='win32'){
      const dir=fs.openSync(DATA_DIR,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    }
    return true;
  }catch(error){
    if(renamed)experimentalStorageUncertain=true;
    const wrapped=new Error('Не удалось подтвердить запись на диск');wrapped.storageError=true;throw wrapped;
  }finally{
    if(fd!==null)try{fs.closeSync(fd);}catch(e){}
    if(!renamed)try{fs.unlinkSync(tmp);}catch(e){}
  }
}

function persistWithTelegram(kind,operation,actor){
  return value=>{
    if(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_ENABLED==='1' && process.env.TELEGRAM_TEST_ONLY!=='1'){
      try{telegramNotifications.enqueue(value,telegramNotifications.buildEvent(kind,operation,value,actor));}
      catch(_){console.error('Не удалось подготовить уведомление Telegram');}
    }
    return persistExperimentalDb(value);
  };
}

/* пароль администратора для первого входа: только из окружения (не из .env-файла) */
const CLOUD_PASS = String(process.env.ADMIN_PASSWORD || '').trim();

function ensureDirs(){
  fs.mkdirSync(DATA_DIR, {recursive:true});
}
ensureDirs();

/* ---------- тот же хэш пароля, что и в кассе ---------- */
function hashPass(str){
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = 'gv:' + String(str);
  for(let i=0;i<s.length;i++){
    h1 ^= s.charCodeAt(i); h1 = (h1 * 16777619) >>> 0;
    h2 = ((h2 + s.charCodeAt(i)) * 31 + (h1 >>> 8)) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36));
}

/* ---------- файлы данных ---------- */
function readJson(file, def){
  try{ return JSON.parse(fs.readFileSync(file,'utf8')); }catch(e){ return def; }
}
/* запись через временный файл: диск в облаке может отваливаться,
   поэтому пробуем несколько раз, а при полном отказе — не падаем */
function writeJsonAtomic(file, obj, tries){
  tries = tries || 4;
  for(let a=1;a<=tries;a++){
    try{ return writeJsonOnce(file, obj); }
    catch(e){
      if(a === tries){ console.error('Не удалось сохранить ' + path.basename(file) + ': ' + e.message); return false; }
      const until = Date.now() + 40*a;
      while(Date.now() < until){}
    }
  }
}
function writeJsonOnce(file, obj){
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

let DB;
if(fs.existsSync(FILE_DB)){
  try{
    DB=JSON.parse(fs.readFileSync(FILE_DB,'utf8'));
    if(!DB || typeof DB!=='object' || Array.isArray(DB) || !Array.isArray(DB.products) || !Array.isArray(DB.sales) || !Array.isArray(DB.customers))
      throw new Error('Некорректная структура базы');
  }catch(e){
    console.error('Невозможно открыть существующую базу; запуск остановлен:',e.message);
    process.exit(1);
  }
}else DB={products:[],customers:[],sales:[],counter:1001,bonusPct:5};
let AUTH = readJson(FILE_AUTH, null);
if(!AUTH) AUTH = {staff:[]};
let REV = 0;
let dbDirty = false;

function saveDb(){ dbDirty = true; writeJsonAtomic(FILE_DB, DB); dbDirty = false; }
function saveAuth(){ writeJsonAtomic(FILE_AUTH, AUTH); }
/* Товары с телефонов объединяем по id: новый добавляем, существующий
   принимаем только если он изменён позже, чем лежит на сервере.
   Иначе телефон с устаревшей базой стирал товары, заведённые с другого. */
function mergeProducts(list){
  if(!Array.isArray(DB.products)) DB.products = [];
  const idx = new Map(DB.products.map((p,i)=>[String(p&&p.id), i]));
  list.forEach(p=>{
    if(!p || !p.id) return;
    if((DB._gvDeletedProducts||{})[String(p.id)])return;
    const i = idx.get(String(p.id));
    if(i === undefined){ idx.set(String(p.id), DB.products.length); DB.products.push(p); return; }
    const cur = DB.products[i] || {};
    const ct = Date.parse(cur.updatedAt || cur.changedAt || 0);
    const nt = Date.parse(p.updatedAt || p.changedAt || 0);
    if(cur._gvCatalogVersion && (Number(p._gvCatalogVersion)||0)<cur._gvCatalogVersion){
      if((nt && (!ct || nt > ct)) || (!nt && !ct))
        DB.products[i]={...cur,stock:typeof p.stock==='number' && Number.isFinite(p.stock)?p.stock:cur.stock};
      return;
    }
    if(nt && (!ct || nt > ct)) DB.products[i] = p;
    else if(!nt && !ct) DB.products[i] = p;
  });
}

function bump(){ REV++; saveDb(); }

/* Сколько уже было на сервере: если пришло пусто, а тут товары есть —
   это пустая база с нового телефона, а не удаление. Не затираем. */
function isEmptyCatalog(list){
  if(!Array.isArray(list) || !list.length) return true;
  for(const p of list){ if(p && String(p.name||'').trim()) return false; }
  return true;
}
function isEmptyList(list){ return !Array.isArray(list) || !list.length; }
// Preserve acknowledged product cards when an older device sends a whole catalog.
// Stock remains governed by the pre-existing synchronization path.
function protectAcknowledgedProducts(incoming){
  const tombstones=DB._gvDeletedProducts||{};
  const out=incoming.filter(p=>!p || !tombstones[String(p.id)]), positions=new Map(out.map((p,i)=>[String(p && p.id),i]));
  for(const current of (DB.products||[])){
    if(!current || !current._gvCatalogVersion)continue;
    const i=positions.get(String(current.id));
    if(i===undefined){positions.set(String(current.id),out.length);out.push(current);continue;}
    const old=out[i];
    if((Number(old._gvCatalogVersion)||0)<current._gvCatalogVersion){
      out[i]={...current,stock:typeof old.stock==='number' && Number.isFinite(old.stock)?old.stock:current.stock};
    }
  }
  return out;
}
function keepNewest(a, b){
  const ta = Date.parse(a || 0), tb = Date.parse(b || 0);
  if(tb && (!ta || tb > ta)) return b;
  return a;
}

/* ---------- сессии в памяти ---------- */
const sessions = new Map();   // token -> {id, login, role, name, at}
const TTL = 1000*60*60*24*30;

function normPhone(v){ return String(v||'').replace(/\D/g,''); }
function toPhone(v){ let d = normPhone(v); if(d.length===9) d = '998'+d; return d; }

function findStaff(login){
  const raw = String(login||'').trim();
  const list = Array.isArray(AUTH.staff) ? AUTH.staff : [];
  let u = list.find(x=> String(x.login).toLowerCase() === raw.toLowerCase());
  if(u) return u;
  const tel = toPhone(raw);
  if(/^998[0-9]{9}$/.test(tel)) u = list.find(x=> normPhone(x.login) === tel);
  return u || null;
}

function saveSessions(){
  const out = {};
  const now = Date.now();
  for(const [k,v] of sessions){ if(now - v.at <= TTL) out[k] = v; }
  writeJsonAtomic(FILE_SESS, out);
}
function loadSessions(){
  const o = readJson(FILE_SESS, {});
  const now = Date.now();
  for(const k of Object.keys(o || {})){
    const v = o[k];
    if(v && now - (v.at||0) <= TTL) sessions.set(k, v);
  }
}
function issue(u){
  const t = crypto.randomBytes(24).toString('hex');
  sessions.set(t, {id:u.id, login:u.login, role:u.role, name:u.name, at:Date.now()});
  try{ saveSessions(); }catch(e){}
  return t;
}
function who(req){
  const h = req.headers['authorization'] || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const s = sessions.get(t);
  if(!s) return null;
  if(Date.now() - s.at > TTL){ sessions.delete(t); try{ saveSessions(); }catch(e){} return null; }
  if(experimentalReceiptLedger){
    const current = (AUTH.staff || []).find(u => String(u.id) === String(s.id));
    if(!current || current.active === false){ sessions.delete(t); try{ saveSessions(); }catch(e){} return null; }
    s.role = current.role; s.name = current.name; s.login = current.login;
  }
  // раз в час продлеваем отметку на диске, чтобы перезапуск сервиса не выбивал из кассы
  if(Date.now() - s.at > 3600*1000){ s.at = Date.now(); try{ saveSessions(); }catch(e){} }
  return s;
}

try{ loadSessions(); }catch(e){ console.error('сессии', e.message); }

/* ---------- защита от подбора пароля ---------- */
let rate = readJson(FILE_RATE, {});
function rateKey(req){ return (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket.remoteAddress || 'local'; }
function rateCheck(k){
  const r = rate[k];
  if(!r) return true;
  if(Date.now() - r.t > 1000*60*10){ delete rate[k]; return true; }
  return r.n < 12;
}
// небольшая задержка на неверный пароль — чтобы не подбирали перебором
function waitAFew(){ const t = Date.now()+450; while(Date.now()<t){} }
function rateFail(k){
  const r = rate[k] || {n:0, t:Date.now()};
  if(Date.now() - r.t > 1000*60*10){ r.n = 0; r.t = Date.now(); }
  r.n++; rate[k] = r;
  try{ writeJsonAtomic(FILE_RATE, rate); }catch(e){}
}
function rateOk(k){ if(rate[k]){ delete rate[k]; try{ writeJsonAtomic(FILE_RATE, rate); }catch(e){} } }

/* ---------- журнал изменений (кто что изменил) ---------- */
function logChange(actor, kind, info){
  const line = JSON.stringify({at:new Date().toISOString(), who:(actor&&actor.login)||'-', kind, info:info||''}) + '\n';
  try{ fs.appendFileSync(FILE_LOG, line); }catch(e){}
}

/* ---------- утилиты ответов ---------- */
function cors(){
  return {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type,x-gv-protocol','Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS'};
}
function json(res, code, obj){
  res.writeHead(code, Object.assign({'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}, cors()));
  res.end(JSON.stringify(obj));
}
function readBody(req, limit){
  return new Promise((resolve, reject)=>{
    let size = 0; const chunks = [];
    req.on('data', c=>{ size += c.length; if(size > (limit||8*1024*1024)){ reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', ()=>{ try{ resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }catch(e){ reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

/* ---------- статика ---------- */
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.ico':'image/x-icon','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8'};
function serveFile(res, file){
  fs.stat(file, (err, st)=>{
    if(err || !st.isFile()){ res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); res.end('Не найдено'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': ext==='.html' ? 'no-cache' : 'public, max-age=3600'});
    fs.createReadStream(file).pipe(res);
  });
}
function safeJoin(root, urlPath){
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/\/+$/,'') || '/';
  const full = path.normalize(path.join(root, clean));
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

/* ---------- сервер ---------- */
const server = http.createServer(async (req, res)=>{
  const url = req.url || '/';
  const p = url.split('?')[0];

  if(req.method === 'OPTIONS'){ res.writeHead(204, cors()); return res.end(); }

  try{
    if(url.indexOf('/api/health') === 0) return json(res, 200, {ok:true, app:'greenville-pos', ver:1, receiptProtocol:experimentalReceiptLedger?1:0, rev:REV, staff:(AUTH.staff||[]).length, at:new Date().toISOString()});

    /* --- вход --- */
    if(p === '/api/login' && req.method === 'POST'){
      const k = rateKey(req);
      if(!rateCheck(k)) return json(res, 429, {ok:false, msg:'Слишком много попыток. Подождите 10 минут'});
      const b = await readBody(req, 4096);
      const login = String(b.login||'').trim();
      const pass  = String(b.pass||'');
      if(!login || !pass) return json(res, 400, {ok:false, msg:'Введите логин и пароль'});

      /* первый запуск в облаке: сотрудников ещё нет, но задан пароль администратора */
      if(!(AUTH.staff||[]).length && CLOUD_PASS && pass === CLOUD_PASS){
        rateOk(k);
        const nm = String(b.name || '').trim();
        const admin = {id:'u1', login:(login.toLowerCase()==='admin' ? 'admin' : login.toLowerCase().replace(/\s+/g,'')),
                       name: nm || 'Администратор', role:'admin', active:true, pass: hashPass(CLOUD_PASS), created:new Date().toISOString()};
        AUTH.staff = [admin]; saveAuth();
        const token = issue(admin);
        logChange(admin, 'login', 'первый вход в облако');
        return json(res, 200, {ok:true, token, id:admin.id, login:admin.login, role:admin.role, name:admin.name, serverHash: admin.pass});
      }

      // 1) сотрудник, заведённый в кассе (добавлен администратором на сервере)
      const u = findStaff(login);
      if(u){
        if(!u.active) return json(res, 403, {ok:false, msg:'Доступ закрыт. Обратитесь к администратору'});
        if(u.pass !== hashPass(pass)){ rateFail(k); waitAFew(); return json(res, 401, {ok:false, msg:'Неверный пароль'}); }
        rateOk(k);
        const token = issue(u);
        logChange(u, 'login', '');
        return json(res, 200, {ok:true, token, id:u.id, login:u.login, role:u.role, name:u.name, serverHash: u.pass});
      }
      rateFail(k);
      waitAFew();
      return json(res, 401, {ok:false, msg:'Такого логина нет или неверный пароль'});
    }

    /* --- выход --- */
    if(p === '/api/logout' && req.method === 'POST'){
      const h = req.headers['authorization'] || '';
      if(h.startsWith('Bearer ')){ sessions.delete(h.slice(7)); try{ saveSessions(); }catch(e){} }
      return json(res, 200, {ok:true});
    }

    /* --- создать первого администратора, если его ещё нет --- */
    if(p === '/api/setup' && req.method === 'POST'){
      if(!CLOUD_PASS) return json(res, 400, {ok:false, msg:'Не задан пароль для первого запуска'});
      if((AUTH.staff||[]).length) return json(res, 409, {ok:false, msg:'Сотрудники уже заведены'});
      const b = await readBody(req, 4096);
      const k = rateKey(req);
      if(!rateCheck(k)) return json(res, 429, {ok:false, msg:'Слишком много попыток. Подождите 10 минут'});
      if(String(b.pass||'') !== CLOUD_PASS){ rateFail(k); waitAFew(); return json(res, 401, {ok:false, msg:'Неверный пароль первого запуска'}); }
      rateOk(k);
      const login = String(b.login||'admin').toLowerCase().replace(/\s+/g,'') || 'admin';
      const name = String(b.name||'').trim() || 'Администратор';
      const admin = {id:'u1', login, name, role:'admin', active:true, pass: hashPass(CLOUD_PASS), created:new Date().toISOString()};
      AUTH.staff = [admin]; saveAuth();
      const token = issue(admin);
      logChange(admin, 'setup', 'первый администратор');
      return json(res, 200, {ok:true, token, id:admin.id, login:admin.login, role:admin.role, name:admin.name, serverHash: admin.pass});
    }

    /* --- есть ли сотрудники: касса спрашивает это до входа, чтобы показать «первый вход» --- */
    if(p === '/api/who' && req.method === 'GET'){
      return json(res, 200, {ok:true, firstRun: !(AUTH.staff||[]).length, canCreate: !!CLOUD_PASS, count:(AUTH.staff||[]).length});
    }

    const me = who(req);
    if(p.startsWith('/api/') && !me) return json(res, 401, {ok:false, msg:'Нужно войти'});
    if(experimentalReceiptLedger && experimentalStorageUncertain && p.startsWith('/api/experimental/')) return json(res,503,{ok:false,msg:'Запись на диск не подтверждена; требуется перезапуск тестового сервера'});

    if(experimentalReceiptLedger && p === '/api/experimental/capabilities' && req.method === 'GET'){
      return json(res, 200, {ok:true, receiptProtocol:1});
    }

    if(experimentalReceiptLedger && (p==='/api/experimental/legacy-evidence' || p==='/api/experimental/legacy-decision'))
      return json(res,410,{ok:false,msg:'Перенос старых локальных чеков отключён'});

    if(experimentalReceiptLedger && p === '/api/experimental/session' && req.method === 'GET'){
      return json(res, 200, {ok:true, id:me.id, login:me.login, name:me.name, role:me.role});
    }

    if(experimentalReceiptLedger && p === '/api/experimental/state' && req.method === 'GET'){
      const products=(DB.products||[]).map(p=>{
        if(me.role === 'admin') return p;
        const safe={...p}; delete safe.cost; return safe;
      });
      const sales=me.role === 'admin' ? DB.sales : (DB.sales||[]).filter(s=>String(s.byId)===String(me.id)).map(s=>{
        const safe={...s}; delete safe.cost; delete safe.profit;
        safe.items=(safe.items||[]).map(i=>{const item={...i};delete item.cost;return item;});
        return safe;
      });
      return json(res, 200, {ok:true, db:{products,sales,customers:DB.customers||[],counter:DB.counter,bonusPct:DB.bonusPct}, role:me.role});
    }

    if(experimentalReceiptLedger && p === '/api/experimental/receipt' && req.method === 'POST'){
      const b = await readBody(req, 4*1024*1024);
      if(!b.receipt || String(b.receipt.cashierId || '') !== String(me.id)) return json(res, 403, {ok:false, msg:'Чек принадлежит другому сотруднику'});
      const state = Object.assign({}, DB, {operations:DB.operations || {}});
      try{
        const result = experimentalReceiptLedger.acceptReceipt(state, b.receipt, persistWithTelegram('sale',b.receipt,me), me);
        DB = result.state;
        if(!result.duplicate) REV++;
        return json(res, 200, {ok:true, duplicate:result.duplicate, saleId:result.saleId});
      }catch(error){
        return json(res, error.storageError ? 503 : 409, {ok:false, msg:error.message});
      }
    }

    if(experimentalReceiptLedger && p === '/api/experimental/cash' && req.method === 'GET'){
      if(!DB.cashRegister)return json(res,200,{ok:true,opened:false});
      try{return json(res,200,{ok:true,opened:true,...require('./sync/cash_register').cashRegister(DB)});}
      catch(e){return json(res,409,{ok:false,msg:'Наличная касса не настроена'});}
    }
    if(experimentalReceiptLedger && p === '/api/experimental/cash-open' && req.method === 'POST'){
      const b=await readBody(req,1024*1024);
      if(me.role!=='admin' || !b.receipt || String(b.receipt.cashierId||'')!==String(me.id))return json(res,403,{ok:false,msg:'Только администратор'});
      try{const result=experimentalReceiptLedger.openCash(Object.assign({},DB,{operations:DB.operations||{}}),b.receipt,persistExperimentalDb,me);DB=result.state;if(!result.duplicate)REV++;return json(res,200,{ok:true,duplicate:result.duplicate});}
      catch(e){return json(res,e.storageError?503:409,{ok:false,msg:'Не удалось открыть кассу. Обновите данные и проверьте, не открыта ли она.'});}
    }
    if(experimentalReceiptLedger && p === '/api/experimental/expenses' && req.method === 'GET'){
      return json(res,200,{ok:true,expenses:DB.expenses||[]});
    }
    if(experimentalReceiptLedger && p === '/api/experimental/expense' && req.method === 'POST'){
      const b=await readBody(req,1024*1024);
      if(!b.receipt || String(b.receipt.cashierId||'')!==String(me.id))return json(res,403,{ok:false,msg:'Операция принадлежит другому сотруднику'});
      try{const result=experimentalReceiptLedger.changeExpense(Object.assign({},DB,{operations:DB.operations||{}}),b.receipt,persistWithTelegram('expense',b.receipt,me),me);DB=result.state;if(!result.duplicate)REV++;return json(res,200,{ok:true,duplicate:result.duplicate,expenseId:result.expenseId});}
      catch(e){return json(res,e.message==='forbidden'?403:e.storageError?503:409,{ok:false,msg:e.message==='forbidden'?'Только администратор может изменить расход':'Расход не сохранён. Проверьте данные или обновите список.'});}
    }
    if(experimentalReceiptLedger && p === '/api/experimental/telegram-status' && req.method === 'GET'){
      if(me.role!=='admin')return json(res,403,{ok:false,msg:'Только администратор'});
      const counts={pending:0,sending:0,sent:0,uncertain:0};for(const e of DB.telegramOutbox||[])if(Object.hasOwn(counts,e.status))counts[e.status]++;
      return json(res,200,{ok:true,enabled:!!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_ENABLED==='1'),counts});
    }
    if(experimentalReceiptLedger && p === '/api/experimental/telegram-review' && req.method === 'GET'){
      if(me.role!=='admin')return json(res,403,{ok:false,msg:'Только администратор'});
      return json(res,200,{ok:true,testMode:!telegramTestCompleted && process.env.TELEGRAM_ENABLED!=='1' && process.env.TELEGRAM_TEST_DIRECT==='1' && !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID,notifications:(DB.telegramOutbox||[]).filter(e=>e.status==='uncertain').map(e=>({id:e.id,type:e.type||e.id.split(':')[0],createdAt:e.createdAt||null,text:e.text}))});
    }
    if(experimentalReceiptLedger && p === '/api/experimental/telegram-review' && req.method === 'POST'){
      if(me.role!=='admin')return json(res,403,{ok:false,msg:'Только администратор'});
      const body=await readBody(req,1024*1024);
      try{const next=structuredClone(DB);const changed=telegramNotifications.resolveUncertain(next,body.id,body.decision,me,body.decisionId);if(changed){persistExperimentalDb(next);DB=next;}return json(res,200,{ok:true,duplicate:!changed});}
      catch(e){return json(res,e.storageError?503:409,{ok:false,msg:'Уведомление изменилось или не может быть обработано'});}
    }
    if(experimentalReceiptLedger && p === '/api/experimental/telegram-test' && req.method === 'POST'){
      if(me.role!=='admin')return json(res,403,{ok:false,msg:'Только администратор'});
      if(process.env.TELEGRAM_ENABLED==='1'||process.env.TELEGRAM_TEST_DIRECT!=='1'||!process.env.TELEGRAM_BOT_TOKEN||!process.env.TELEGRAM_CHAT_ID)return json(res,409,{ok:false,msg:'Прямой тест Telegram не включён или уведомления активны'});
      const body=await readBody(req,1024*1024);
      if(body.confirm!==true || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operationId||''))return json(res,400,{ok:false,msg:'Требуется подтверждение'});
      const key=String(me.id)+':'+body.operationId;
      if(!telegramTestAttempts.has(key)){
        if(telegramTestCompleted)return json(res,409,{ok:false,msg:'Тест уже выполнен; отключите временный режим'});
        if(telegramTestAttempts.size>=1000)return json(res,429,{ok:false,msg:'Лимит тестов до перезапуска сервера'});
        telegramTestCompleted=true;
        telegramTestAttempts.set(key,require('./sync/telegram_single_test').sendSingle({token:process.env.TELEGRAM_BOT_TOKEN,chatId:process.env.TELEGRAM_CHAT_ID}));
      }
      const result=await telegramTestAttempts.get(key);return json(res,200,{ok:true,...result});
    }
    if(experimentalReceiptLedger && p === '/api/experimental/debts' && req.method === 'GET'){
      const debts=(DB.sales||[]).filter(s=>s.payments && (s.payments.debt>0 || (s.debtPayments||[]).length || (s.debtCorrections||[]).some(c=>(c.before?.payments?.debt||0)>0))).map(s=>{
        const c=(DB.customers||[]).find(x=>String(x.id)===String(s.customerId));
        return {id:s.id,operationId:s.operationId,date:s.date,customerId:s.customerId,customer:c?{id:c.id,name:c.name,phone:c.phone}:null,total:s.total,payments:s.payments,debtOutstanding:s.debtOutstanding,debtPayments:s.debtPayments,debtCorrections:s.debtCorrections||[],financialRevision:s.financialRevision||1,byId:s.byId,cashier:s.cashier,status:s.deleted?'cancelled':s.debtOutstanding===0?'closed':'open'};
      });
      return json(res,200,{ok:true,debts});
    }
    if(experimentalReceiptLedger && p === '/api/experimental/debt-payment' && req.method === 'POST'){
      const b=await readBody(req,1024*1024);
      if(!b.receipt || String(b.receipt.cashierId||'')!==String(me.id))return json(res,403,{ok:false,msg:'Операция принадлежит другому сотруднику'});
      const state=Object.assign({},DB,{operations:DB.operations||{}});
      try{const result=experimentalReceiptLedger.repayDebt(state,b.receipt,persistWithTelegram('debt_payment',b.receipt,me),me);DB=result.state;if(!result.duplicate)REV++;return json(res,200,{ok:true,duplicate:result.duplicate,saleId:result.saleId});}
      catch(e){const stale=e.message.startsWith('Операция изменилась.');return json(res,e.storageError?503:409,{ok:false,code:stale?'STALE_FINANCIAL_REVISION':'FINANCIAL_OPERATION_REJECTED',msg:e.storageError?'Не удалось сохранить операцию':stale?'Данные продажи изменились. Обновите информацию.':'Операция отклонена. Проверьте данные и доступные суммы.'});}
    }
    if(experimentalReceiptLedger && p === '/api/experimental/refund' && req.method === 'POST'){
      const b=await readBody(req,1024*1024);
      if(me.role!=='admin' || !b.receipt || String(b.receipt.cashierId||'')!==String(me.id))return json(res,403,{ok:false,msg:'Только администратор'});
      try{const result=experimentalReceiptLedger.refundPayment(Object.assign({},DB,{operations:DB.operations||{}}),b.receipt,persistExperimentalDb,me);DB=result.state;if(!result.duplicate)REV++;return json(res,200,{ok:true,duplicate:result.duplicate,saleId:result.saleId});}
      catch(e){const stale=e.message.startsWith('Операция изменилась.');return json(res,e.storageError?503:409,{ok:false,code:stale?'STALE_FINANCIAL_REVISION':'FINANCIAL_OPERATION_REJECTED',msg:e.storageError?'Не удалось сохранить операцию':stale?'Данные продажи изменились. Обновите информацию.':'Операция отклонена. Проверьте данные и доступные суммы.'});}
    }
    if(experimentalReceiptLedger && p === '/api/experimental/debt-correction' && req.method === 'POST'){
      const b=await readBody(req,1024*1024);
      if(me.role!=='admin' || !b.receipt || String(b.receipt.cashierId||'')!==String(me.id))return json(res,403,{ok:false,msg:'Только администратор'});
      const state=Object.assign({},DB,{operations:DB.operations||{}});
      try{const result=experimentalReceiptLedger.correctDebt(state,b.receipt,persistExperimentalDb,me);DB=result.state;if(!result.duplicate)REV++;return json(res,200,{ok:true,duplicate:result.duplicate,saleId:result.saleId});}
      catch(e){const stale=e.message.startsWith('Операция изменилась.');return json(res,e.storageError?503:409,{ok:false,code:stale?'STALE_FINANCIAL_REVISION':'FINANCIAL_OPERATION_REJECTED',msg:e.storageError?'Не удалось сохранить операцию':stale?'Данные продажи изменились. Обновите информацию.':'Операция отклонена. Проверьте данные и доступные суммы.'});}
    }

    if(experimentalReceiptLedger && p === '/api/experimental/receipt-change' && req.method === 'POST'){
      const b=await readBody(req, 1024*1024);
      if(!b.receipt || String(b.receipt.cashierId || '')!==String(me.id)) return json(res,403,{ok:false,msg:'Операция принадлежит другому сотруднику'});
      const state=Object.assign({}, DB, {operations:DB.operations || {}});
      try{
        const result=experimentalReceiptLedger.changeReceipt(state,b.receipt,b.receipt.kind==='pay'?persistWithTelegram('sale',b.receipt,me):persistExperimentalDb,me);
        DB=result.state;if(!result.duplicate)REV++;
        return json(res,200,{ok:true,duplicate:result.duplicate,saleId:result.saleId});
      }catch(error){return json(res,error.storageError?503:409,{ok:false,msg:error.message});}
    }

    if(experimentalReceiptLedger && p === '/api/experimental/stock-add' && req.method === 'POST'){
      const b=await readBody(req,1024*1024);
      if(me.role!=='admin' || !b.receipt || String(b.receipt.cashierId||'')!==String(me.id))return json(res,403,{ok:false,msg:'Только администратор'});
      const state=Object.assign({},DB,{operations:DB.operations||{}});
      try{
        const result=experimentalReceiptLedger.addStock(state,b.receipt,persistExperimentalDb,me);
        DB=result.state;if(!result.duplicate)REV++;
        return json(res,200,{ok:true,duplicate:result.duplicate});
      }catch(error){return json(res,error.storageError?503:409,{ok:false,msg:error.message});}
    }

    if(experimentalReceiptLedger && p === '/api/experimental/product-save' && req.method === 'POST'){
      const b=await readBody(req,4*1024*1024);
      if(!['admin','cashier'].includes(me.role) || !b.receipt || String(b.receipt.cashierId||'')!==String(me.id))return json(res,403,{ok:false,msg:'Нет доступа'});
      const state=Object.assign({},DB,{operations:DB.operations||{}});
      try{
        const result=experimentalReceiptLedger.saveProduct(state,b.receipt,persistExperimentalDb,me);
        DB=result.state;if(!result.duplicate)REV++;
        return json(res,200,{ok:true,duplicate:result.duplicate});
      }catch(error){return json(res,error.storageError?503:409,{ok:false,msg:error.message});}
    }

    if(experimentalReceiptLedger && p === '/api/experimental/customer-add' && req.method === 'POST'){
      const b=await readBody(req,1024*1024);
      if(!b.receipt || String(b.receipt.cashierId||'')!==String(me.id))return json(res,403,{ok:false,msg:'Операция принадлежит другому сотруднику'});
      const state=Object.assign({},DB,{operations:DB.operations||{}});
      try{
        const result=experimentalReceiptLedger.addCustomer(state,b.receipt,persistExperimentalDb,me);
        DB=result.state;if(!result.duplicate)REV++;
        return json(res,200,{ok:true,duplicate:result.duplicate});
      }catch(error){return json(res,error.storageError?503:409,{ok:false,msg:error.message});}
    }

    if(experimentalReceiptLedger && p === '/api/experimental/product-archive' && req.method === 'POST'){
      const b=await readBody(req,1024*1024);
      if(me.role!=='admin' || !b.receipt || String(b.receipt.cashierId||'')!==String(me.id))return json(res,403,{ok:false,msg:'Только администратор'});
      const state=Object.assign({},DB,{operations:DB.operations||{}});
      try{
        const result=experimentalReceiptLedger.archiveProduct(state,b.receipt,persistExperimentalDb,me);
        DB=result.state;if(!result.duplicate)REV++;
        return json(res,200,{ok:true,duplicate:result.duplicate});
      }catch(error){return json(res,error.storageError?503:409,{ok:false,msg:error.message});}
    }

    if(experimentalReceiptLedger && p === '/api/experimental/product-import' && req.method === 'POST'){
      const b=await readBody(req,32*1024*1024);
      if(me.role!=='admin' || !b.receipt || String(b.receipt.cashierId||'')!==String(me.id))return json(res,403,{ok:false,msg:'Только администратор'});
      const state=Object.assign({},DB,{operations:DB.operations||{}});
      try{
        const result=experimentalReceiptLedger.importProducts(state,b.receipt,persistExperimentalDb,me);
        DB=result.state;if(!result.duplicate)REV++;
        return json(res,200,{ok:true,duplicate:result.duplicate});
      }catch(error){return json(res,error.storageError?503:409,{ok:false,msg:error.message});}
    }

    if(experimentalReceiptLedger && p === '/api/experimental/receipt-status' && req.method === 'POST'){
      const b = await readBody(req, 4*1024*1024);
      const receipt = b.receipt;
      if(!receipt || String(receipt.cashierId || '') !== String(me.id)) return json(res, 403, {ok:false, msg:'Чек принадлежит другому сотруднику'});
      const op = receipt && DB.operations && DB.operations[receipt.operationId];
      if(!op) return json(res, 200, {ok:true, status:'absent'});
      if(op.actorId && op.actorId !== me.id) return json(res, 403, {ok:false, msg:'Операция принадлежит другому сотруднику'});
      const hash = experimentalReceiptLedger.receiptHash(receipt);
      return json(res, 200, {ok:true, status:op.hash === hash ? 'accepted' : 'conflict', saleId:op.hash === hash ? op.saleId : undefined});
    }

    /* --- вся база --- */
    if(url.indexOf('/api/data') === 0 && req.method === 'GET'){
      if(experimentalReceiptLedger) return json(res, me.role==='admin'?409:403, {ok:false, msg:'Старый протокол отключён; обновите кассу'});
      return json(res, 200, {ok:true, rev:REV, at:new Date().toISOString(), db:DB, staff:(AUTH.staff||[]).map(x=>({id:x.id, login:x.login, name:x.name, role:x.role, active:x.active, created:x.created}))});
    }

    /* --- только каталог ---
       Телефону нужен короткий список товаров: если общий ответ пришёл
       с пустым каталогом, устройство добирает товары этим запросом. */
    if(p === '/api/catalog' && req.method === 'GET'){
      if(experimentalReceiptLedger && req.headers['x-gv-protocol']!=='3')return json(res,409,{ok:false,msg:'Старый протокол отключён; обновите кассу'});
      let list = Array.isArray(DB.products) ? DB.products : [];
      if(experimentalReceiptLedger && me.role!=='admin')list=list.map(p=>{const safe={...p};delete safe.cost;return safe;});
      return json(res, 200, {ok:true, rev:REV, count:list.length, products:list});
    }

    /* --- найти товар по штрихкоду или артикулу ---
       Нужно телефону: каталог на устройстве мог устареть, а товар на месте.
       Отдаём ровно один товар, всю базу наружу не выкладываем. */
    if(p === '/api/find' && req.method === 'GET'){
      if(experimentalReceiptLedger && req.headers['x-gv-protocol']!=='3')return json(res,409,{ok:false,msg:'Старый протокол отключён; обновите кассу'});
      const code = String((url.split('code=')[1] || '').split('&')[0] || '').trim();
      const c = decodeURIComponent(code).trim();
      if(!c) return json(res, 400, {ok:false, msg:'Пустой код'});
      const cl = c.toLowerCase();
      const norm = v => String(v||'').replace(/\s+/g,'').toLowerCase();
      const list = Array.isArray(DB.products) ? DB.products : [];
      const prod = list.find(x=> norm(x.barcode) === cl)
                || list.find(x=> norm(x.sku) === cl)
                || list.find(x=> norm(x.barcode).endsWith(cl))
                || list.find(x=> norm(x.sku).endsWith(cl))
                || null;
      let result=prod;
      if(experimentalReceiptLedger && me.role!=='admin' && prod){result={...prod};delete result.cost;}
      return json(res, 200, {ok:true, product:result});
    }

    /* --- сохранить всю базу --- */
    if(p === '/api/data' && req.method === 'PUT'){
      if(me.role !== 'admin') return json(res, 403, {ok:false, msg:'Изменять данные может администратор'});
      if(experimentalReceiptLedger) return json(res, 409, {ok:false, msg:'Полная замена базы отключена в экспериментальном режиме'});
      const b = await readBody(req, 32*1024*1024);
      const db = b.db;
      if(!db || typeof db !== 'object') return json(res, 400, {ok:false, msg:'Пустые данные'});
      db.products = Array.isArray(db.products) ? db.products : [];
      db.customers = Array.isArray(db.customers) ? db.customers : [];
      db.sales = Array.isArray(db.sales) ? db.sales : [];
      if(!db.counter) db.counter = 1001;
      /* Защита от пустой базы: свежий телефон, который ещё не скачал данные,
         присылает товары:[] и чеки:[] — это не означает «удалить всё».
         Такое пустое не принимаем, если на сервере уже что-то есть. */
      let guarded = false;
      if(isEmptyCatalog(db.products) && !isEmptyCatalog(DB.products)){ db.products = DB.products; guarded = true; }
      if(isEmptyList(db.sales) && !isEmptyList(DB.sales)){ db.sales = DB.sales; guarded = true; }
      if(isEmptyList(db.customers) && !isEmptyList(DB.customers)){ db.customers = DB.customers; guarded = true; }
      db.products = protectAcknowledgedProducts(db.products);
      db._gvDeletedProducts = DB._gvDeletedProducts || {};
      if(guarded) logChange(me, 'save-guard', 'пустая база с устройства не затёрла общую');
      DB = db; bump();
      logChange(me, 'save', 'товаров '+db.products.length+', чеков '+db.sales.length);
      return json(res, 200, {ok:true, rev:REV});
    }

    /* A single product is acknowledged only after its JSON snapshot is saved. */
    if(p === '/api/product/save' && req.method === 'POST'){
      if(experimentalReceiptLedger) return json(res, 409, {ok:false, msg:'Используйте защищённый протокол каталога'});
      const b=await readBody(req, 4*1024*1024), product=b.product, expected=b.expected;
      const keys=['name','cat','img','price','cost','stock','sku','barcode'];
      if(!product || typeof product.id!=='string' || !product.id || !product.name || typeof product.name!=='string' ||
        typeof product.sku!=='string' || !product.sku.trim() || !Number.isFinite(product.price) || product.price<=0 ||
        !Number.isFinite(product.cost) || product.cost<0 || !Number.isSafeInteger(product.stock))
        return json(res,400,{ok:false,msg:'Проверьте название, артикул, цену и остаток'});
      if((DB._gvDeletedProducts||{})[product.id])return json(res,409,{ok:false,msg:'Этот товар уже удалён. Обновите каталог.'});
      const current=(DB.products||[]).find(p=>String(p.id)===product.id);
      const duplicate=(DB.products||[]).find(p=>String(p.id)!==product.id && String(p.sku||'').trim().toLowerCase()===product.sku.trim().toLowerCase());
      const skuChanged=!current || String(current.sku||'').trim().toLowerCase()!==product.sku.trim().toLowerCase();
      if(duplicate && skuChanged)return json(res,409,{ok:false,msg:'Такой артикул уже существует'});
      if(current && keys.every(k=>JSON.stringify(current[k]??'')===JSON.stringify(product[k]??'')))return json(res,200,{ok:true,product:current});
      if(current && !expected){
        return json(res,409,{ok:false,msg:'Товар с этим идентификатором уже существует'});
      }
      if(expected && (!current || keys.some(k=>JSON.stringify(current[k]??'')!==JSON.stringify(expected[k]??''))))
        return json(res,409,{ok:false,msg:'Товар изменился на другом устройстве. Обновите карточку и повторите.'});
      const updated={...(current||{}),...Object.fromEntries(keys.map(k=>[k,product[k]??''])),id:product.id,
        _gvCatalogVersion:(Number(current && current._gvCatalogVersion)||0)+1};
      const next={...DB,products:(DB.products||[]).slice()};
      const idx=next.products.findIndex(p=>String(p.id)===product.id);
      if(idx<0)next.products.push(updated);else next.products[idx]=updated;
      if(writeJsonAtomic(FILE_DB,next)===false)return json(res,503,{ok:false,msg:'Не удалось сохранить товар на сервере'});
      DB=next;REV++;logChange(me,'product-save','товар '+product.id);
      return json(res,200,{ok:true,product:updated,rev:REV});
    }

    if(p === '/api/product/delete' && req.method === 'POST'){
      if(experimentalReceiptLedger) return json(res, 409, {ok:false, msg:'Используйте защищённый протокол каталога'});
      const b=await readBody(req,4*1024*1024),expected=b.expected;
      if(!expected || typeof expected.id!=='string')return json(res,400,{ok:false,msg:'Не указан товар'});
      const current=(DB.products||[]).find(p=>String(p.id)===expected.id);
      if(!current && (DB._gvDeletedProducts||{})[expected.id])return json(res,200,{ok:true});
      const keys=['name','cat','img','price','cost','stock','sku','barcode'];
      if(!current || keys.some(k=>JSON.stringify(current[k]??'')!==JSON.stringify(expected[k]??'')))return json(res,409,{ok:false,msg:'Товар изменился на другом устройстве. Обновите каталог.'});
      const next={...DB,products:DB.products.filter(p=>String(p.id)!==expected.id),_gvDeletedProducts:{...(DB._gvDeletedProducts||{}),[expected.id]:true}};
      if(writeJsonAtomic(FILE_DB,next)===false)return json(res,503,{ok:false,msg:'Не удалось сохранить изменение на сервере'});
      DB=next;REV++;logChange(me,'product-delete','товар '+expected.id);
      return json(res,200,{ok:true,rev:REV});
    }

    /* --- чеки: по одному, можно и изменить, и удалить ---
       Чек не перезаписывается «вслепую»: берём тот, что пришёл с устройства,
       и заменяем версию на сервере (так правка и пометка «удалён» видны всем). */
    if(p === '/api/sale' && req.method === 'POST'){
      if(experimentalReceiptLedger) return json(res, 409, {ok:false, msg:'Старый протокол чеков отключён в экспериментальном режиме'});
      const b = await readBody(req, 4*1024*1024);
      const s = b.sale;
      if(!s || !s.id) return json(res, 400, {ok:false, msg:'Пустой чек'});
      if(!Array.isArray(DB.sales)) DB.sales = [];
      const idx = DB.sales.findIndex(x=> String(x.id) === String(s.id));
      const prev = idx >= 0 ? DB.sales[idx] : null;
      // более старую версию (по времени правки) не затираем более новой
      const pt = prev ? Date.parse(prev.updatedAt || prev.date || 0) : 0;
      const st = Date.parse(s.updatedAt || s.date || 0);
      if(prev && pt > st + 1000) return json(res, 200, {ok:true, rev:REV, skipped:true, sale:prev});
      // номер уже занят чужим чеком (другое устройство выдало такой же) — выдаём свободный
      if(!prev && DB.sales.some(x=> String(x.id) === String(s.id))){
        DB.counter = Math.max(+DB.counter||1001, 1001) + 1;
        s.id = String(DB.counter);
      }
      const i2 = DB.sales.findIndex(x=> String(x.id) === String(s.id));
      if(i2 >= 0) DB.sales[i2] = s; else DB.sales.push(s);
      DB.counter = Math.max(+DB.counter||1001, (+s.id||0) + 1);
      bump();
      logChange(me, 'sale', '#' + s.id + (s.deleted ? ' удалён' : s.paid ? ' оплачен' : ' отложен'));
      return json(res, 200, {ok:true, rev:REV, sale:s});
    }

    /* --- только новые чеки (старый вариант, оставлен для совместимости) --- */
    if(p === '/api/push' && req.method === 'POST'){
      if(experimentalReceiptLedger) return json(res, 409, {ok:false, msg:'Старый протокол чеков отключён в экспериментальном режиме'});
      const b = await readBody(req, 4*1024*1024);
      const sales = Array.isArray(b.sales) ? b.sales : [];
      const have = new Set((DB.sales||[]).map(s=>String(s.id)));
      let added = 0;
      for(const s of sales){ if(s && !have.has(String(s.id))){ DB.sales.push(s); added++; } }
      DB.counter = Math.max(+DB.counter||1001, +b.counter||0);
      if(added) bump(); else saveDb();
      if(added) logChange(me, 'push', 'чеков '+added);
      return json(res, 200, {ok:true, rev:REV, added});
    }

    /* --- номер нового чека ---
       У каждого телефона свой счётчик, поэтому номер выдаёт облако:
       два продавца одновременно не получат одинаковый номер. */
    if(p === '/api/nextid' && req.method === 'POST'){
      if(experimentalReceiptLedger) return json(res, 409, {ok:false, msg:'Старый протокол отключён'});
      DB.counter = Math.max(+DB.counter||1001, 1001) + 1;
      saveDb();
      return json(res, 200, {ok:true, counter:DB.counter, rev:REV});
    }

    /* --- правка ассортимента и настроек с любого логина ---
       Продавец тоже может добавить товар или изменить цену; данные сразу у всех. */
    if(p === '/api/edit' && req.method === 'POST'){
      if(experimentalReceiptLedger) return json(res, 409, {ok:false, msg:'Изменения каталога через старый протокол отключены в экспериментальном режиме'});
      const b = await readBody(req, 16*1024*1024);
      const m = b.meta || {};
      if(Array.isArray(m.products)) mergeProducts(m.products);
      if(Array.isArray(m.customers) && !(isEmptyList(m.customers) && !isEmptyList(DB.customers))) DB.customers = m.customers;
      if(m.counter) DB.counter = Math.max(+DB.counter||1001, +m.counter||0);
      if(m.bonusPct != null) DB.bonusPct = +m.bonusPct || 5;
      bump();
      logChange(me, 'edit', 'товаров ' + (DB.products||[]).length);
      return json(res, 200, {ok:true, rev:REV});
    }

    /* --- обновить только служебные данные (клиенты, скидка, счётчик) --- */
    if(p === '/api/meta' && req.method === 'POST'){
      if(experimentalReceiptLedger) return json(res, 409, {ok:false, msg:'Старый протокол обновления данных отключён'});
      const b = await readBody(req, 8*1024*1024);
      if(Array.isArray(b.customers)) DB.customers = b.customers;
      if(b.counter) DB.counter = Math.max(+DB.counter||1001, +b.counter||0);
      if(b.bonusPct != null) DB.bonusPct = +b.bonusPct || 5;
      bump();
      logChange(me, 'meta', 'клиентов ' + (DB.customers||[]).length);
      return json(res, 200, {ok:true, rev:REV});
    }

    /* --- пароли сотрудников: чтобы вход работал и без интернета --- */
    if(p === '/api/passes' && req.method === 'GET'){
      if(experimentalReceiptLedger && me.role !== 'admin') return json(res, 403, {ok:false, msg:'Только администратор'});
      return json(res, 200, {ok:true, staff:(AUTH.staff||[]).map(x=>({id:x.id, login:x.login, name:x.name, role:x.role, active:x.active, created:x.created, pass:x.pass}))});
    }

    /* --- сотрудники: список с паролями (только админ) --- */
    if(p === '/api/staff' && req.method === 'GET'){
      if(me.role !== 'admin') return json(res, 403, {ok:false, msg:'Только администратор'});
      return json(res, 200, {ok:true, staff:AUTH.staff||[]});
    }
    if(p === '/api/staff' && req.method === 'PUT'){
      if(me.role !== 'admin') return json(res, 403, {ok:false, msg:'Только администратор'});
      const b = await readBody(req, 512*1024);
      const list = Array.isArray(b.staff) ? b.staff : [];
      const before = new Map((AUTH.staff||[]).map(x=>[String(x.id), x]));
      const out = [];
      for(const x of list){
        if(!x || !x.login) continue;
        const login = String(x.login).trim().toLowerCase();
        const old = before.get(String(x.id));
        // пароль: если пришёл прежний хэш — оставляем как есть; если новый — сохраняем
        const pass = (x.pass && x.pass !== (old && old.pass)) ? x.pass : ((old && old.pass) || x.pass || '');
        if(!pass) continue;                        // без пароля сотрудник не сможет войти
        out.push({id:String(x.id), login, name:String(x.name||login).trim(), role:(x.role==='admin'?'admin':'cashier'),
                  active:x.active !== false, pass, created:x.created || new Date().toISOString()});
      }
      // не даём остаться без администратора
      if(!out.some(x=>x.role==='admin')) return json(res, 400, {ok:false, msg:'Должен остаться хотя бы один администратор'});
      AUTH.staff = out;
      saveAuth();
      logChange(me, 'staff', 'сотрудников '+AUTH.staff.length);
      return json(res, 200, {ok:true, staff:AUTH.staff.length});
    }

    /* --- кто сейчас работает --- */
    if(p === '/api/online' && req.method === 'GET'){
      const now = Date.now();
      const list = [...sessions.values()].filter(s=> now - s.at < 1000*60*10).map(s=>({name:s.name, login:s.login, role:s.role, at:new Date(s.at).toISOString()}));
      return json(res, 200, {ok:true, online:list});
    }

    /* --- резервная копия базы --- */
    if(p === '/api/backup' && req.method === 'GET'){
      if(me.role !== 'admin') return json(res, 403, {ok:false});
      const name = 'greenville-backup-' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.json';
      res.writeHead(200, Object.assign({'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="'+name+'"'}, cors()));
      return res.end(JSON.stringify({app:'greenville-pos', ver:2, at:new Date().toISOString(), auth:AUTH, db:DB}, null, 1));
    }

    if(p.startsWith('/api/')) return json(res, 404, {ok:false, msg:'Неизвестный запрос'});

    /* --- страницы --- */
    if(req.method !== 'GET'){ res.writeHead(405); return res.end(); }
    if(p === '/' || p === '/index.html' || p.startsWith('/Greenville')){
      const f1 = path.join(PUBLIC, 'index.html');
      const f2 = path.join(DIR, 'Greenville-касса.html');
      return serveFile(res, fs.existsSync(f1) ? f1 : f2);
    }
    const file = safeJoin(PUBLIC, p.startsWith('/public/') ? p.slice('/public'.length) : p);
    if(file && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file);
    return serveFile(res, fs.existsSync(path.join(PUBLIC,'index.html')) ? path.join(PUBLIC,'index.html') : path.join(DIR, 'Greenville-касса.html'));
  }catch(e){
    return json(res, 500, {ok:false, msg:'Ошибка сервера: ' + e.message});
  }
});

/* данные в памяти всегда свежие; если запись не удалась — дописываем при следующем изменении */
process.on('uncaughtException', e=>{ console.error('Ошибка: ' + (e && e.message)); });
/* Если при запуске что-то пошло не так, сервер не должен «молча умереть» —
   иначе хостинг показывает только 502 без причины. Пишем причину в журнал. */
process.on('unhandledRejection', e=>{ console.error('Необработанная ошибка: ' + (e && (e.stack || e.message || e))); });
for(const sig of ['SIGTERM','SIGINT','SIGHUP']){
  process.on(sig, ()=>{ console.log('Получен сигнал ' + sig + ' — завершаемся'); process.exit(0); });
}

server.on('error', e=>{
  console.error('Не удалось занять порт ' + PORT + ': ' + (e && e.message));
  process.exit(1);
});

server.listen(PORT, HOST, ()=>{
  console.log('Greenville касса запущена на порту ' + PORT);
  console.log('Данные: ' + DATA_DIR);
  if(!CLOUD_PASS && !(AUTH.staff||[]).length){
    console.log('ВНИМАНИЕ: пароль администратора не задан — при первом входе используется заводской (admin/admin).');
    console.log('Задайте ADMIN_PASSWORD в настройках хостинга и перезапустите.');
  }
  const normalTelegram=process.env.TELEGRAM_ENABLED==='1' && !!process.env.TELEGRAM_CHAT_ID;
  const privateTelegram=process.env.TELEGRAM_REPORTS_ENABLED==='1';
  if(process.env.TELEGRAM_BOT_TOKEN && (normalTelegram || privateTelegram)){
    const {createWorker,telegramSend,telegramGetUpdates}=require('./sync/telegram_worker');
    const telegramReports=require('./sync/telegram_reports'),owners=telegramReports.ownerIds(process.env.TELEGRAM_OWNER_IDS);
    const commit=fn=>{const next=structuredClone(DB);if(!fn(next))return;persistExperimentalDb(next);DB=next;};
    const testOnly=normalTelegram && process.env.TELEGRAM_TEST_ONLY==='1';
    const reportsActive=!testOnly && (normalTelegram || privateTelegram);
    const eligible=e=>{if(testOnly)return e.type==='test';if(e.type==='telegram_update')return reportsActive && owners.has(String(e.destination||''));return normalTelegram;};
    const worker=createWorker({readState:()=>DB,commit,send:(text,destination,markup)=>telegramSend(process.env.TELEGRAM_BOT_TOKEN,destination||process.env.TELEGRAM_CHAT_ID,text,markup),eligible,log:message=>console.error(message),measure:(ms,queueMs)=>console.info('Telegram report delivery_ms='+ms+' queue_total_ms='+queueMs)});
    try{worker.recover();}catch(_){console.error('Не удалось восстановить очередь Telegram');}
    let polling=false,failures=0;
    const poll=async()=>{if(polling||!owners.size)return;polling=true;const started=performance.now();let ok=false;try{
      const updates=await telegramGetUpdates(process.env.TELEGRAM_BOT_TOKEN,DB.telegramUpdateOffset||0);
      for(const update of updates){if(!Number.isSafeInteger(update.update_id))continue;let queued=false;commit(state=>{
        if(update.update_id<(state.telegramUpdateOffset||0))return false;
        const reportStarted=performance.now();queued=telegramReports.handleUpdate(state,update,owners,new Date(),telegramNotifications.enqueue);if(queued)console.info('Telegram report compute_ms='+Math.round(performance.now()-reportStarted));state.telegramUpdateOffset=update.update_id+1;return true;
      });if(queued)worker.wake();}ok=true;failures=0;
    }catch(_){failures++;console.error('Не удалось получить команды Telegram');}finally{polling=false;const delay=ok?Math.max(0,1000-(performance.now()-started)):Math.min(30000,1000*2**Math.min(failures-1,5));setTimeout(poll,delay).unref();}};
    const run=()=>{
      try{
        if(normalTelegram && !testOnly)commit(state=>telegramNotifications.scheduleDaily(state,new Date()));
      }catch(_){console.error('Не удалось подготовить дневной отчёт Telegram');}
      worker.tick().catch(()=>console.error('Ошибка обработки очереди Telegram'));
    };
    setInterval(run,15000).unref();run();if(reportsActive)void poll();
  }
});
