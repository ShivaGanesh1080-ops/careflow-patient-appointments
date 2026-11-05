const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawnSync}=require('node:child_process');
for(const adapter of ['sqlite3','libsql'])test(adapter+': manual ledger, concurrency, snapshots, reports and repeat migration',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'careflow-ledger-'));
 try{
  const env={...process.env,NODE_ENV:'test',JWT_SECRET:'isolated-ledger-secret',DB_FILE:path.join(dir,'ledger.sqlite'),DATABASE_PATH:'',TURSO_DATABASE_URL:adapter==='libsql'?pathToFileURL(path.join(dir,'ledger.sqlite')).href:'',TURSO_AUTH_TOKEN:'',SEED_DEMO_USERS:'true',BOOTSTRAP_ADMIN_EMAIL:'',BOOTSTRAP_ADMIN_PASSWORD:'',SMTP_USER:'',SMTP_APP_PASSWORD:''};
  delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['test/ledger-runner.js'],{cwd:path.join(__dirname,'..'),env,encoding:'utf8',timeout:120000});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);console.log(result.stdout);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
