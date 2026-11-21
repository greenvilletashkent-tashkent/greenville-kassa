'use strict';
const TEXT='✅ GREENVILLE Kassa — Telegram подключён. Тестовое сообщение, не является продажей';
async function sendSingle({token,chatId,request=fetch}){
 try{
  const response=await request('https://api.telegram.org/bot'+token+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chatId,text:TEXT}),signal:AbortSignal.timeout(10000)});
  if(response.status===429)return {status:'error',code:'rate_limited'};
  if(response.status>=500)return {status:'uncertain'};
  if(!response.ok)return {status:'error',code:'rejected'};
  let body;try{body=await response.json();}catch(_){return {status:'uncertain'};}
  if(body?.ok===true && Number.isSafeInteger(body?.result?.message_id))return {status:'delivered',messageId:body.result.message_id};
  if(body?.ok===false)return {status:'error',code:'rejected'};
  return {status:'uncertain'};
 }catch(_){return {status:'uncertain'};}
}
module.exports={TEXT,sendSingle};
