const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..');
function isolated(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'careflow-backend-'));try{return fn(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}}
function envFor(dir,overrides={}){const env={...process.env,NODE_ENV:'test',JWT_SECRET:'backend-test-secret',DATABASE_PATH:path.join(dir,'local.sqlite'),DB_FILE:'',TURSO_DATABASE_URL:'',TURSO_AUTH_TOKEN:'',SEED_DEMO_USERS:'',BOOTSTRAP_ADMIN_EMAIL:'',BOOTSTRAP_ADMIN_PASSWORD:'',BOOTSTRAP_ADMIN_NAME:'',...overrides};delete env.NODE_TEST_CONTEXT;return env;}
function child(source,env){const result=spawnSync(process.execPath,['-e',source],{cwd:root,env,encoding:'utf8',timeout:120000});assert.equal(result.status,0,result.stdout+'\n'+result.stderr);return result.stdout;}

test('original complete API/realtime/outbox suite also passes through libSQL file adapter',()=>isolated(dir=>{
 const result=spawnSync(process.execPath,['--test','test/api.test.js'],{cwd:root,env:envFor(dir,{TURSO_DATABASE_URL:pathToFileURL(path.join(dir,'remote-adapter.sqlite')).href}),encoding:'utf8',timeout:120000});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stdout,/Complete appointment lifecycle and authorization/);
 assert.match(result.stdout,/tests 19/);
 console.log(result.stdout);
}));

for(const adapter of ['sqlite3','libsql'])test(adapter+': repeat initialization, FK enforcement, trigger atomicity, constraints and persistence',()=>isolated(dir=>{
 const env=envFor(dir,adapter==='libsql'?{TURSO_DATABASE_URL:pathToFileURL(path.join(dir,'db.sqlite')).href}:{DB_FILE:path.join(dir,'db.sqlite')});
 child(  "const assert=require('node:assert/strict');const {init,run,get,db,adapter}=require('./db');"+
  "(async()=>{try{await init();const before=await get('SELECT count(*) n FROM slots');await init();assert.equal((await get('SELECT count(*) n FROM slots')).n,before.n);assert.equal((await get('SELECT count(*) n FROM users')).n,2);"+
  "assert.equal((await get('PRAGMA foreign_keys')).foreign_keys,1);await assert.rejects(run('INSERT INTO slots(doctor_id,start_time,end_time) VALUES(99999,?,?)',['2099-01-01T09:00:00','2099-01-01T09:30:00']),e=>e.code==='SQLITE_CONSTRAINT');"+
  "const patient=await get(\"SELECT id FROM users WHERE role='patient'\");const slot=await get('SELECT * FROM slots LIMIT 1');const booking=await run('INSERT INTO appointments(patient_id,doctor_id,slot_id) VALUES(?,?,?)',[patient.id,slot.doctor_id,slot.id]);assert.ok(Number.isSafeInteger(booking.id));assert.equal(booking.changes,1);"+
  "await assert.rejects(run('INSERT INTO appointments(patient_id,doctor_id,slot_id) VALUES(?,?,?)',[patient.id,slot.doctor_id,slot.id]),e=>e.code==='SQLITE_CONSTRAINT');"+
  "await run(\"CREATE TRIGGER test_fail_job BEFORE INSERT ON email_jobs BEGIN SELECT RAISE(ABORT,'simulated outbox failure'); END\");await assert.rejects(run(\"UPDATE appointments SET status='cancelled',cancelled_by='admin',cancellation_reason='Clinic closed' WHERE id=?\",[booking.id]));assert.equal((await get('SELECT status FROM appointments WHERE id=?',[booking.id])).status,'booked');assert.equal((await get('SELECT count(*) n FROM notifications')).n,0);await run('DROP TRIGGER test_fail_job');"+
  "await run(\"UPDATE appointments SET status='cancelled',cancelled_by='admin',cancellation_reason='Clinic closed' WHERE id=?\",[booking.id]);assert.equal((await get('SELECT count(*) n FROM notifications')).n,1);assert.equal((await get('SELECT count(*) n FROM email_jobs')).n,1);const job=await get('SELECT j.notification_id,n.id FROM email_jobs j JOIN notifications n ON n.id=j.notification_id');assert.equal(job.notification_id,job.id);await run(\"UPDATE appointments SET status='cancelled' WHERE id=?\",[booking.id]);assert.equal((await get('SELECT count(*) n FROM notifications')).n,1);"+
  "}finally{db.close();}})().catch(e=>{console.error(e);process.exitCode=1});",env);
 child("const assert=require('node:assert/strict');const {get,db}=require('./db');(async()=>{try{assert.equal((await get('SELECT count(*) n FROM notifications')).n,1);assert.equal((await get('SELECT count(*) n FROM email_jobs')).n,1);}finally{db.close();}})().catch(e=>{console.error(e);process.exitCode=1});",env);
}));

test('production requires persistent JWT_SECRET before opening database',()=>isolated(dir=>{
 const result=spawnSync(process.execPath,['-e',"require('./index')"],{cwd:root,env:envFor(dir,{NODE_ENV:'production',JWT_SECRET:''}),encoding:'utf8',timeout:10000});
 assert.notEqual(result.status,0);assert.match(result.stderr,/JWT_SECRET is required in production/);assert.equal(fs.existsSync(path.join(dir,'local.sqlite')),false);
}));

test('production disables demo users by default and explicit opt-in enables them',()=>isolated(dir=>{
 for(const enabled of [false,true])child("const assert=require('node:assert/strict');const {init,get,db}=require('./db');(async()=>{try{await init();await init();assert.equal((await get('SELECT count(*) n FROM users')).n,"+(enabled?2:0)+");}finally{db.close();}})().catch(e=>{console.error(e);process.exitCode=1});",envFor(dir,{NODE_ENV:'production',DATABASE_PATH:path.join(dir,enabled?'optin.sqlite':'default.sqlite'),SEED_DEMO_USERS:enabled?'true':''}));
}));

test('startup honors ephemeral PORT and local/production default HOST',()=>isolated(dir=>{
 for(const production of [false,true])child("const assert=require('node:assert/strict');const {start}=require('./index');const {db}=require('./db');(async()=>{const server=await start();if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));assert.equal(server.address().address,'"+(production?'0.0.0.0':'127.0.0.1')+"');assert.ok(server.address().port>0);await new Promise(resolve=>server.close(resolve));db.close();})().catch(e=>{console.error(e);process.exitCode=1});",envFor(dir,{NODE_ENV:production?'production':'test',PORT:'0',HOST:'',DATABASE_PATH:path.join(dir,production?'prod.sqlite':'dev.sqlite')}));
}));

test('incomplete remote configuration fails clearly',()=>isolated(dir=>{
 for(const overrides of [{TURSO_AUTH_TOKEN:'fake'},{TURSO_DATABASE_URL:'libsql://invalid.example'}]){
 const result=spawnSync(process.execPath,['-e',"require('./db')"],{cwd:root,env:envFor(dir,overrides),encoding:'utf8',timeout:10000});assert.notEqual(result.status,0);assert.match(result.stderr,/TURSO_AUTH_TOKEN/);
 }
}));

for(const adapter of ['sqlite3','libsql'])test(adapter+': read-only inspector supports the selected backend',()=>isolated(dir=>{
 const env=envFor(dir,adapter==='libsql'?{TURSO_DATABASE_URL:pathToFileURL(path.join(dir,'db.sqlite')).href}:{DB_FILE:path.join(dir,'db.sqlite')});
 child("const {init,db}=require('./db');init().then(()=>db.close()).catch(e=>{console.error(e);process.exitCode=1});",env);
 const result=spawnSync(process.execPath,['inspect-db.js','users'],{cwd:root,env,encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 assert.match(result.stdout,/Showing latest 2 rows. No data was changed./);
 assert.doesNotMatch(result.stdout,/password_hash/);
}));

for(const adapter of ['sqlite3','libsql'])test(adapter+': production bootstrap creates only first admin and never overwrites a password',()=>isolated(dir=>{
 const env=envFor(dir,{NODE_ENV:'production',BOOTSTRAP_ADMIN_EMAIL:'  FIRST@example.test  ',BOOTSTRAP_ADMIN_PASSWORD:'FictionalPassword123!',BOOTSTRAP_ADMIN_NAME:'Fictional Admin',...(adapter==='libsql'?{TURSO_DATABASE_URL:pathToFileURL(path.join(dir,'db.sqlite')).href}:{DB_FILE:path.join(dir,'db.sqlite')})});
 child("const assert=require('node:assert/strict'),bcrypt=require('bcryptjs');const {init,get,db}=require('./db');(async()=>{try{await init();const first=await get(\"SELECT * FROM users WHERE role='admin'\");assert.equal(first.email,'first@example.test');assert.equal(first.name,'Fictional Admin');assert.ok(await bcrypt.compare('FictionalPassword123!',first.password_hash));assert.equal((await get('SELECT count(*) n FROM users')).n,1);process.env.BOOTSTRAP_ADMIN_EMAIL='second@example.test';process.env.BOOTSTRAP_ADMIN_PASSWORD='short';await init();assert.equal((await get('SELECT count(*) n FROM users')).n,1);assert.equal((await get('SELECT password_hash FROM users WHERE id=?',[first.id])).password_hash,first.password_hash);}finally{db.close();}})().catch(e=>{console.error(e);process.exitCode=1});",env);
 child("const assert=require('node:assert/strict'),bcrypt=require('bcryptjs');const {init,get,db}=require('./db');(async()=>{try{await init();const first=await get(\"SELECT * FROM users WHERE role='admin'\");assert.equal(first.email,'first@example.test');assert.ok(await bcrypt.compare('FictionalPassword123!',first.password_hash));assert.equal((await get('SELECT count(*) n FROM users')).n,1);}finally{db.close();}})().catch(e=>{console.error(e);process.exitCode=1});",{...env,BOOTSTRAP_ADMIN_EMAIL:'replacement@example.test',BOOTSTRAP_ADMIN_PASSWORD:'DifferentPassword123!'});
}));

test('bootstrap rejects partial or invalid configuration without creating an admin',()=>isolated(dir=>{
 const configurations=[{BOOTSTRAP_ADMIN_EMAIL:'fake@example.test'},{BOOTSTRAP_ADMIN_PASSWORD:'FictionalPassword123!'},{BOOTSTRAP_ADMIN_EMAIL:'bad-email',BOOTSTRAP_ADMIN_PASSWORD:'FictionalPassword123!'},{BOOTSTRAP_ADMIN_EMAIL:'fake@example.test',BOOTSTRAP_ADMIN_PASSWORD:'short'},{BOOTSTRAP_ADMIN_EMAIL:'fake@example.test',BOOTSTRAP_ADMIN_PASSWORD:'FictionalPassword123!',BOOTSTRAP_ADMIN_NAME:'x'}];
 for(let i=0;i<configurations.length;i++)child("const assert=require('node:assert/strict');const {init,get,db}=require('./db');(async()=>{try{await assert.rejects(init(),/BOOTSTRAP_ADMIN_EMAIL/);assert.equal((await get(\"SELECT count(*) n FROM users WHERE role='admin'\")).n,0);}finally{db.close();}})().catch(e=>{console.error(e);process.exitCode=1});",envFor(dir,{NODE_ENV:'production',DB_FILE:path.join(dir,'invalid-'+i+'.sqlite'),...configurations[i]}));
}));
