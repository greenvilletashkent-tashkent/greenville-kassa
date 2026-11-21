'use strict';
const fs=require('node:fs');
globalThis.fetch=async (url,options)=>{
 if(!String(url).startsWith('https://api.telegram.org/'))throw Error('Unexpected external request');
 if(String(url).endsWith('/getUpdates')){
  const offset=JSON.parse(options.body).offset||0;
  const updates=process.env.TELEGRAM_TEST_UPDATES?JSON.parse(process.env.TELEGRAM_TEST_UPDATES):[];
  return {ok:true,status:200,json:async()=>({ok:true,result:updates.filter(x=>x.update_id>=offset)})};
 }
 fs.appendFileSync(process.env.TELEGRAM_TEST_CAPTURE,JSON.stringify(JSON.parse(options.body))+'\n');
 return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:1}})};
};
