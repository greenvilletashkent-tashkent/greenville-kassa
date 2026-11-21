'use strict';
// A transport error may have occurred after Telegram accepted the message.
// Such messages are quarantined rather than resent automatically.
function createWorker({readState,commit,send,log=()=>{},eligible=()=>true}){
 let busy=false;
 function recover(){commit(state=>{let changed=false;for(const e of state.telegramOutbox||[])if(e.status==='sending' && eligible(e)){e.status='uncertain';changed=true;}return changed;});}
 async function tick(){
  if(busy)return;const pending=(readState().telegramOutbox||[]).find(e=>e.status==='pending' && eligible(e));if(!pending)return;
  busy=true;
  try{
   let claimed=false;commit(state=>{const e=(state.telegramOutbox||[]).find(x=>x.id===pending.id);if(!e||e.status!=='pending')return false;e.status='sending';e.attempts++;claimed=true;return true;});
   if(!claimed)return;
   let result;try{result=await send(pending.text,pending.destination,pending.replyMarkup);}catch(_){result={status:'uncertain'};}
   commit(state=>{const e=(state.telegramOutbox||[]).find(x=>x.id===pending.id);if(!e||e.status!=='sending')return false;
    e.status=result.status==='sent'?'sent':result.status==='retry'?'pending':'uncertain';
    if(e.status==='sent')e.sentAt=new Date().toISOString();return true;});
   if(result.status!=='sent')log('Ошибка отправки Telegram; статус '+result.status);
  }finally{busy=false;}
 }
 return {tick,recover};
}
async function telegramSend(token,chatId,text,replyMarkup){
 let response;
 try{response=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text,...(replyMarkup?{reply_markup:replyMarkup}:{})}),signal:AbortSignal.timeout(10000)});}
 catch(error){if(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ENETUNREACH'].includes(error?.cause?.code))return {status:'retry'};throw error;}
 if(response.status===429)return {status:'retry'};
 if(!response.ok)return {status:'uncertain'};
 const payload=await response.json();return {status:payload.ok?'sent':'uncertain'};
}
async function telegramGetUpdates(token,offset){
 const response=await fetch('https://api.telegram.org/bot'+token+'/getUpdates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({offset,timeout:0,allowed_updates:['message']}),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('telegram update request failed');const result=await response.json();if(!result.ok||!Array.isArray(result.result))throw Error('telegram updates invalid');return result.result;
}
module.exports={createWorker,telegramSend,telegramGetUpdates};
