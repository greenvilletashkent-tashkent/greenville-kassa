'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
test('existing invalid database stops startup without replacing data',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gv-invalid-db-'));
  try{
    for(const raw of ['{broken',JSON.stringify({products:[],sales:[]})]){
      const file=path.join(dir,'db.json');fs.writeFileSync(file,raw);
      const result=spawnSync(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,ELECTRON_RUN_AS_NODE:'1',DATA_DIR:dir,PORT:'0'},timeout:5000,windowsHide:true,encoding:'utf8'});
      assert.equal(result.status,1);assert.equal(fs.readFileSync(file,'utf8'),raw);
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
