require('dotenv').config({path:require('node:path').join(__dirname,'.env'),quiet:true});
if(process.env.NODE_ENV==='production'&&!process.env.JWT_SECRET?.trim()) {
  throw new Error('JWT_SECRET is required in production. Set a persistent secret in the hosting environment.');
}
if(process.env.RENDER==='true'&&(!process.env.TURSO_DATABASE_URL?.trim()||process.env.TURSO_DATABASE_URL.startsWith('file:'))) {
  throw new Error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN on Render; local database files are not durable.');
}
const express = require('express');
const helmet = require('helmet');
const {rateLimit} = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {run,get,all,init,localNow,localDate,adapter} = require('./db');
const {Server}=require('socket.io');
const http=require('node:http');
const {kickMail,startMailWorker,onMailChange}=require('./mail');
const app = express();
let realtime;
function changed(kind,userId,allUsers=false){const payload={kind,at:new Date().toISOString()};if(!realtime)return;if(allUsers)realtime.emit('data:changed',payload);else{realtime.to('admins').emit('data:changed',payload);if(userId)realtime.to('user:'+userId).emit('data:changed',payload);}}
onMailChange(userId=>changed('notifications',userId));
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'32kb'}));
const secretPath=path.join(__dirname,'data','.jwt-secret');
if(!process.env.JWT_SECRET){
  fs.mkdirSync(path.dirname(secretPath),{recursive:true});
  if(!fs.existsSync(secretPath))fs.writeFileSync(secretPath,crypto.randomBytes(48).toString('hex'),{mode:0o600});
}
const secret=process.env.JWT_SECRET||fs.readFileSync(secretPath,'utf8');
const fail=(res,code,error)=>res.status(code).json({error});
const safeUser=u=>({id:u.id,name:u.name,email:u.email,phone:u.phone,role:u.role});
const token=u=>jwt.sign({id:u.id},secret,{expiresIn:'8h'});
const auth=async(req,res,next)=>{try{const raw=req.headers.authorization||'';if(!raw.startsWith('Bearer '))return fail(res,401,'Please sign in to continue.');const data=jwt.verify(raw.slice(7),secret);req.user=await get('SELECT * FROM users WHERE id=?',[data.id]);if(!req.user)return fail(res,401,'Your account was not found.');next();}catch{return fail(res,401,'Your session has expired. Please sign in again.');}};
const admin=(req,res,next)=>req.user.role==='admin'?next():fail(res,403,'Administrator access required.');
const patient=(req,res,next)=>req.user.role==='patient'?next():fail(res,403,'Sign in with a patient account to book an appointment.');
const authLimit=rateLimit({windowMs:15*60*1000,limit:100,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Too many sign-in attempts. Please try again later.'}});
app.get('/api/health',(req,res)=>res.json({status:'ok',database:'SQLite3',adapter}));
app.post('/api/auth/register',authLimit,async(req,res)=>{
  const {name,email,password,phone=''}=req.body;
  if(typeof name!=='string'||name.trim().length<2||name.length>80)return fail(res,400,'Enter a name between 2 and 80 characters.');
  if(typeof email!=='string'||email.length>150||!/^\S+@\S+\.\S+$/.test(email))return fail(res,400,'Enter a valid email address.');
  if(typeof password!=='string'||password.length<8||password.length>100)return fail(res,400,'Use a password between 8 and 100 characters.');
  if(typeof phone!=='string'||phone.length>20)return fail(res,400,'Enter a valid phone number (up to 20 characters).');
  try{const result=await run('INSERT INTO users(name,email,password_hash,phone) VALUES(?,?,?,?)',[name.trim(),email.trim().toLowerCase(),await bcrypt.hash(password,10),phone.trim()]);const user=await get('SELECT * FROM users WHERE id=?',[result.id]);changed('patients');res.status(201).json({token:token(user),user:safeUser(user)});}catch(e){if(e.code==='SQLITE_CONSTRAINT')return fail(res,409,'This email address is already registered.');throw e;}
});
app.post('/api/auth/login',authLimit,async(req,res)=>{const {email,password}=req.body;if(typeof email!=='string'||typeof password!=='string')return fail(res,400,'Enter your email and password.');const user=await get('SELECT * FROM users WHERE email=?',[email.trim().toLowerCase()]);if(!user||!await bcrypt.compare(password,user.password_hash))return fail(res,401,'Incorrect email or password.');res.json({token:token(user),user:safeUser(user)});});
app.get('/api/auth/me',auth,(req,res)=>res.json({user:safeUser(req.user)}));
app.get('/api/specializations',async(req,res)=>res.json({specializations:(await all('SELECT DISTINCT specialization FROM doctors WHERE active=1 ORDER BY specialization')).map(x=>x.specialization)}));
app.get('/api/doctors',async(req,res)=>{
  let include=false;if(req.query.includeInactive==='true'){try{const raw=req.headers.authorization||'';const data=jwt.verify(raw.startsWith('Bearer ')?raw.slice(7):'',secret);const user=await get('SELECT role FROM users WHERE id=?',[data.id]);if(!user||user.role!=='admin')return fail(res,403,'Administrator access required.');include=true;}catch{return fail(res,401,'Please sign in as an administrator.');}}
  let sql='SELECT * FROM doctors WHERE '+(include?'1=1':'active=1');const params=[];
  if(req.query.search){sql+=' AND (name LIKE ? OR specialization LIKE ?)';params.push(`%${String(req.query.search).slice(0,100)}%`,`%${String(req.query.search).slice(0,100)}%`);}
  if(req.query.specialization){sql+=' AND specialization=?';params.push(String(req.query.specialization));}
  res.json({doctors:await all(sql+' ORDER BY id',params)});
});
app.get('/api/doctors/:id/slots',async(req,res)=>{
  const date=String(req.query.date||localDate());if(!validDate(date))return fail(res,400,'Choose a valid date.');
  const doctor=await get('SELECT id FROM doctors WHERE id=? AND active=1',[req.params.id]);if(!doctor)return fail(res,404,'Doctor not found.');
  const slots=await all(`SELECT s.*, CASE WHEN s.start_time>? AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a.slot_id=s.id AND a.status IN ('booked','completed')) THEN 1 ELSE 0 END AS available FROM slots s WHERE s.doctor_id=? AND substr(s.start_time,1,10)=? ORDER BY s.start_time`,[localNow(),req.params.id,date]);
  res.json({slots:slots.map(s=>({...s,available:!!s.available}))});
});
const appointmentQuery=`SELECT a.*,d.name AS doctor_name,d.specialization,d.fee,s.start_time,s.end_time,u.name AS patient_name,u.email AS patient_email FROM appointments a JOIN doctors d ON a.doctor_id=d.id JOIN slots s ON a.slot_id=s.id JOIN users u ON a.patient_id=u.id`;
app.get('/api/appointments',auth,async(req,res)=>res.json({appointments:await all(appointmentQuery+' WHERE a.patient_id=? ORDER BY s.start_time DESC',[req.user.id])}));
app.post('/api/appointments',auth,patient,async(req,res)=>{
  const {slotId,reason=''}=req.body;if(!Number.isInteger(Number(slotId))||Number(slotId)<1||typeof reason!=='string'||reason.length>500)return fail(res,400,'Select a slot and keep your reason within 500 characters.');
  // A single atomic INSERT + partial unique index protects against concurrent double booking.
  try{const result=await run(`INSERT INTO appointments(patient_id,doctor_id,slot_id,reason) SELECT ?,s.doctor_id,s.id,? FROM slots s JOIN doctors d ON d.id=s.doctor_id WHERE s.id=? AND d.active=1 AND s.start_time>? AND NOT EXISTS(SELECT 1 FROM appointments a JOIN slots existing ON existing.id=a.slot_id WHERE a.patient_id=? AND a.status='booked' AND existing.start_time<s.end_time AND existing.end_time>s.start_time)`,[req.user.id,reason.trim(),slotId,localNow(),req.user.id]);
  if(!result.changes)return fail(res,409,'This slot is unavailable, in the past, or overlaps one of your bookings.');
  changed('appointments',req.user.id);res.status(201).json({appointment:await get(appointmentQuery+' WHERE a.id=?',[result.id])});}catch(e){if(e.code==='SQLITE_CONSTRAINT')return fail(res,409,'That slot has just been booked. Please choose another.');throw e;}
});
app.patch('/api/appointments/:id/cancel',auth,async(req,res)=>{
  const a=await get(appointmentQuery+' WHERE a.id=? AND a.patient_id=?',[req.params.id,req.user.id]);if(!a)return fail(res,404,'Appointment not found.');
  if(a.status!=='booked'||a.start_time<=localNow())return fail(res,409,'Only upcoming booked appointments can be cancelled.');
  const result=await run("UPDATE appointments SET status='cancelled',cancellation_reason='Cancelled by patient',cancelled_by='patient' WHERE id=? AND status='booked'",[a.id]);if(!result.changes)return fail(res,409,'This appointment has already changed. Refresh and try again.');changed('appointments',a.patient_id);res.json({appointment:await get(appointmentQuery+' WHERE a.id=?',[a.id])});
});
app.get('/api/notifications',auth,async(req,res)=>res.json({notifications:await all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 200',[req.user.id])}));
app.patch('/api/notifications/read-all',auth,async(req,res)=>{await run('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE user_id=? AND read_at IS NULL',[req.user.id]);changed('notification_read',req.user.id);res.json({message:'Notifications marked as read.'});});
app.patch('/api/notifications/:id/read',auth,async(req,res)=>{const notice=await get('SELECT id FROM notifications WHERE id=? AND user_id=?',[req.params.id,req.user.id]);if(!notice)return fail(res,404,'Notification not found.');await run('UPDATE notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE id=? AND user_id=?',[notice.id,req.user.id]);changed('notification_read',req.user.id);res.json({notification:await get('SELECT * FROM notifications WHERE id=?',[notice.id])});});
app.use('/api/admin',auth,admin);
app.get('/api/admin/patients',async(req,res)=>res.json({patients:await all("SELECT id,name,email,phone,created_at FROM users WHERE role='patient' ORDER BY id DESC")}));
app.get('/api/admin/stats',async(req,res)=>res.json({stats:{doctors:(await get('SELECT count(*) n FROM doctors WHERE active=1')).n,patients:(await get("SELECT count(*) n FROM users WHERE role='patient'")).n,upcoming:(await get("SELECT count(*) n FROM appointments a JOIN slots s ON s.id=a.slot_id WHERE a.status='booked' AND s.start_time>?",[localNow()])).n,completed:(await get("SELECT count(*) n FROM appointments WHERE status='completed'")).n}}));
app.get('/api/admin/appointments',async(req,res)=>res.json({appointments:await all(appointmentQuery+' ORDER BY s.start_time DESC')}));
function doctorFields(body){const {name,specialization,qualification,bio='',experience,fee}=body;if([name,specialization,qualification].some(x=>typeof x!=='string'||!x.trim()||x.length>120)||typeof bio!=='string'||bio.length>1000||!Number.isInteger(Number(experience))||Number(experience)<0||Number(experience)>70||!Number.isFinite(Number(fee))||Number(fee)<0||Number(fee)>100000)return null;return [name.trim(),specialization.trim(),qualification.trim(),bio.trim(),Number(experience),Number(fee)];}
app.post('/api/admin/doctors',async(req,res)=>{const fields=doctorFields(req.body);if(!fields)return fail(res,400,'Enter valid doctor details, experience, and consultation fee.');const result=await run('INSERT INTO doctors(name,specialization,qualification,bio,experience,fee) VALUES(?,?,?,?,?,?)',fields);changed('doctors',null,true);res.status(201).json({doctor:await get('SELECT * FROM doctors WHERE id=?',[result.id])});});
app.put('/api/admin/doctors/:id',async(req,res)=>{const fields=doctorFields(req.body);if(!fields)return fail(res,400,'Enter valid doctor details.');const result=await run('UPDATE doctors SET name=?,specialization=?,qualification=?,bio=?,experience=?,fee=? WHERE id=?',[...fields,req.params.id]);if(!result.changes)return fail(res,404,'Doctor not found.');changed('doctors',null,true);res.json({doctor:await get('SELECT * FROM doctors WHERE id=?',[req.params.id])});});
app.delete('/api/admin/doctors/:id',async(req,res)=>{const future=await get("SELECT count(*) n FROM appointments a JOIN slots s ON s.id=a.slot_id WHERE a.doctor_id=? AND a.status='booked' AND s.start_time>?",[req.params.id,localNow()]);if(future.n)return fail(res,409,'Cancel this doctor’s upcoming appointments before deactivating the profile.');const result=await run('UPDATE doctors SET active=0 WHERE id=?',[req.params.id]);if(!result.changes)return fail(res,404,'Doctor not found.');changed('doctors',null,true);res.json({message:'Doctor deactivated. Appointment history is preserved.'});});
function validDate(date){if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;const d=new Date(date+'T12:00:00');return !isNaN(d)&&localDate(d)===date;}
app.post('/api/admin/slots',async(req,res)=>{
  const {doctorId,date,startTime,endTime,intervalMinutes=30,slotCount}=req.body;
  const timeOK=x=>typeof x==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(x);
  const byCount=slotCount!==undefined;
  if(!validDate(date)||!timeOK(startTime)||(!byCount&&!timeOK(endTime))||![15,20,30,45,60].includes(Number(intervalMinutes)))return fail(res,400,'Choose a valid date, start time, and duration (15, 20, 30, 45, or 60 minutes).');
  if(byCount&&(typeof slotCount!=='number'||!Number.isInteger(slotCount)||slotCount<1||slotCount>96))return fail(res,400,'Number of slots must be a whole number between 1 and 96.');
  const minutes=t=>Number(t.slice(0,2))*60+Number(t.slice(3));const start=minutes(startTime),step=Number(intervalMinutes),end=byCount?start+slotCount*step:minutes(endTime);
  if(end>1439)return fail(res,400,'These slots would reach or cross midnight. Choose fewer slots, a shorter duration, or an earlier start.');
  if(end<=start||end-start<step||date+'T'+startTime+':00'<=localNow())return fail(res,400,'Choose a future time range that fits at least one slot.');
  const doctor=await get('SELECT id FROM doctors WHERE id=? AND active=1',[doctorId]);if(!doctor)return fail(res,404,'Active doctor not found.');
  const planned=Math.floor((end-start)/step);let created=0;
  for(let m=start;m+step<=end;m+=step){const fmt=n=>date+'T'+String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0')+':00';const s=fmt(m),e=fmt(m+step);const result=await run(`INSERT OR IGNORE INTO slots(doctor_id,start_time,end_time) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM slots WHERE doctor_id=? AND start_time<? AND end_time>?)`,[doctorId,s,e,doctorId,e,s]);created+=result.changes;}
  changed('slots',null,true);res.status(201).json({created,planned,skipped:planned-created,endTime:String(Math.floor(end/60)).padStart(2,'0')+':'+String(end%60).padStart(2,'0'),unusedMinutes:(end-start)%step});
});
app.patch('/api/admin/appointments/:id/arrival',async(req,res)=>{
  const {arrived}=req.body;
  if(typeof arrived!=='boolean')return fail(res,400,'Patient arrived must be true or false.');
  const a=await get('SELECT id,status FROM appointments WHERE id=?',[req.params.id]);
  if(!a)return fail(res,404,'Appointment not found.');
  if(a.status!=='booked')return fail(res,409,'Arrival can be changed only for booked appointments.');
  const now=new Date().toISOString();
  const result=await run(arrived?
    "UPDATE appointments SET checked_in_at=COALESCE(checked_in_at,?),checked_in_by=COALESCE(checked_in_by,?) WHERE id=? AND status='booked'":
    "UPDATE appointments SET checked_in_at=NULL,checked_in_by=NULL WHERE id=? AND status='booked'",
    arrived?[now,req.user.id,a.id]:[a.id]);
  if(!result.changes)return fail(res,409,'Appointment already changed. Refresh and try again.');
  changed('appointments',(await get('SELECT patient_id FROM appointments WHERE id=?',[a.id])).patient_id);
  res.json({appointment:await get(appointmentQuery+' WHERE a.id=?',[a.id])});
});
app.patch('/api/admin/appointments/:id/status',async(req,res)=>{
  const {status,reason=''}=req.body;
  if(!['completed','cancelled'].includes(status))return fail(res,400,'Status must be completed or cancelled.');
  if(status==='cancelled'&&(typeof reason!=='string'||reason.trim().length<5||reason.trim().length>500))return fail(res,400,'Provide a cancellation reason between 5 and 500 characters.');
  const a=await get(appointmentQuery+' WHERE a.id=?',[req.params.id]);if(!a)return fail(res,404,'Appointment not found.');
  if(a.status!=='booked')return fail(res,409,'Only booked appointments can change status.');
  if(status==='completed'&&!a.checked_in_at)return fail(res,409,'Mark the patient as arrived before completing the visit.');
  const result=await run("UPDATE appointments SET status=?,cancellation_reason=?,cancelled_by=?,completed_at=? WHERE id=? AND status='booked' AND (?!='completed' OR checked_in_at IS NOT NULL)",[status,status==='cancelled'?reason.trim():'',status==='cancelled'?'admin':'',status==='completed'?new Date().toISOString():null,a.id,status]);
  if(!result.changes)return fail(res,409,'Appointment already changed.');
  changed('appointments',a.patient_id);if(status==='cancelled')kickMail();
  res.json({appointment:await get(appointmentQuery+' WHERE a.id=?',[a.id])});
});
app.use('/api',(req,res)=>fail(res,404,'API endpoint not found.'));
const clientPath=path.join(__dirname,'../client/dist/client/browser');
if(fs.existsSync(clientPath)){app.use(express.static(clientPath));app.get('/{*path}',(req,res)=>res.sendFile(path.join(clientPath,'index.html')));}else app.get('/',(req,res)=>res.type('text').send('CareFlow API is running. Build the frontend or open http://localhost:4200 during development.'));
app.use((err,req,res,next)=>{console.error(err.message);if(err instanceof SyntaxError&&'body' in err)return fail(res,400,'Request contains invalid JSON.');fail(res,500,'Something went wrong. Please try again.');});
function createHttpServer(){
  const server=http.createServer(app);
  const io=new Server(server,{maxHttpBufferSize:16384});realtime=io;
  io.use(async(socket,next)=>{try{const raw=socket.handshake.auth?.token;if(typeof raw!=='string')throw Error('token required');const payload=jwt.verify(raw,secret);const user=await get('SELECT id,role FROM users WHERE id=?',[payload.id]);if(!user)throw Error('account missing');socket.data.user=user;socket.data.expires=payload.exp;next();}catch{next(new Error('Authentication expired or invalid. Sign in again to enable live updates.'));}});
  io.on('connection',socket=>{const user=socket.data.user;socket.join('user:'+user.id);if(user.role==='admin')socket.join('admins');const timer=setTimeout(()=>socket.disconnect(true),Math.max(0,socket.data.expires*1000-Date.now()));timer.unref();socket.on('disconnect',()=>clearTimeout(timer));});
  return server;
}
async function start(){await init();const port=process.env.PORT===undefined?3000:Number(process.env.PORT);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('PORT must be an integer between 0 and 65535.');const host=process.env.HOST||(process.env.NODE_ENV==='production'?'0.0.0.0':'127.0.0.1');const server=createHttpServer();const timer=startMailWorker();server.on('close',()=>clearInterval(timer));return server.listen(port,host,()=>console.log(`CareFlow running at http://${host}:${server.address().port}`));}
if(require.main===module)start().catch(e=>{console.error(e);process.exit(1);});
module.exports={app,start,createHttpServer};
