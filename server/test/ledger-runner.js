const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const jwt=require('jsonwebtoken');
const {init,run,get,all,db}=require('../db');
const {createHttpServer}=require('../index');
let server,base,admin,patient,patientId,adminId;
async function api(url,method='GET',body,token=admin){const response=await fetch(base+'/api'+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
const payment=(amount_paise,extra={})=>({kind:'payment',amount_paise,method:'cash',reference:'Manual receipt',notes:'Manual record, not verified bank settlement',idempotency_key:randomUUID(),...extra});
async function booking(hour){const slot=await run('INSERT INTO slots(doctor_id,start_time,end_time) VALUES(1,?,?)',[`2099-01-01T${hour}:00:00`,`2099-01-01T${hour}:30:00`]);const result=await api('/appointments','POST',{slotId:slot.id},patient);assert.equal(result.status,201,JSON.stringify(result));return result.body.appointment;}
(async()=>{try{
 await init();
 const p=await get("SELECT id FROM users WHERE role='patient'"),a=await get("SELECT id FROM users WHERE role='admin'");patientId=p.id;adminId=a.id;patient=jwt.sign({id:p.id},process.env.JWT_SECRET);admin=jwt.sign({id:a.id},process.env.JWT_SECRET);
 server=createHttpServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 const legacySlot=await run("INSERT INTO slots(doctor_id,start_time,end_time) VALUES(1,'2098-01-01T09:00:00','2098-01-01T09:30:00')");
 const legacy=await run('INSERT INTO appointments(patient_id,doctor_id,slot_id) VALUES(?,1,?)',[patientId,legacySlot.id]);await init();
 assert.deepEqual(await get('SELECT fee_paise,fee_basis,status FROM appointments WHERE id=?',[legacy.id]),{fee_paise:50000,fee_basis:'legacy_estimate',status:'booked'});
 const first=await booking('09'),second=await booking('10'),third=await booking('11');const url='/admin/appointments/'+first.id;
 assert.equal(first.fee_paise,50000);assert.equal(first.fee_basis,'booking_snapshot');assert.equal(first.paid_paise,0);
 await run('UPDATE doctors SET fee=700 WHERE id=1');assert.equal((await api(url+'/payments')).body.appointment.fee,500);
 for(const endpoint of [url+'/payments','/admin/revenue']){assert.equal((await api(endpoint,'GET',undefined,null)).status,401);assert.equal((await api(endpoint,'GET',undefined,patient)).status,403);}
 assert.equal((await api(url+'/fee','PATCH',{fee_paise:40000},patient)).status,403);
 assert.equal((await api(url+'/payments','POST',payment(100),patient)).status,403);
 await api(url+'/arrival','PATCH',{arrived:true});await api(url+'/status','PATCH',{status:'completed'});assert.equal((await api(url+'/payments')).body.appointment.paid_paise,0);
 assert.equal((await api(url+'/fee','PATCH',{fee_paise:40000})).body.appointment.fee_basis,'admin_set');
 for(const amount of [0,-1,0.5,'100',10000001,null])assert.equal((await api(url+'/payments','POST',payment(amount))).status,400);
 for(const fee of [-1,1.2,'100',10000001])assert.equal((await api(url+'/fee','PATCH',{fee_paise:fee})).status,400);
 const intent=payment(10000);const initial=await api(url+'/payments','POST',intent);assert.equal(initial.status,201,JSON.stringify(initial));assert.equal(initial.body.appointment.paid_paise,10000);const receipt=initial.body.entries[0];assert.equal(receipt.refundable_paise,10000);assert.ok(receipt.recorded_at.endsWith('Z'));assert.equal(receipt.recorded_by,adminId);
 assert.equal((await api(url+'/payments','POST',intent)).status,200);assert.equal((await api(url+'/payments','POST',{...intent,amount_paise:9999})).status,409);
 assert.equal((await api(url+'/fee','PATCH',{fee_paise:50000})).status,409);
 const concurrent=await Promise.all([api(url+'/payments','POST',payment(30000)),api(url+'/payments','POST',payment(30000))]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[201,409]);assert.equal((await api(url+'/payments')).body.appointment.paid_paise,40000);
 assert.equal((await api(url+'/payments','POST',payment(1))).status,409);
 const refund=payment(7000,{kind:'refund',original_payment_id:receipt.id,notes:'Correction of receipt'});
 assert.equal((await api(url+'/payments','POST',{...refund,notes:'bad'})).status,400);
 assert.equal((await api(url+'/payments','POST',{...refund,method:'upi'})).status,400);
 assert.equal((await api('/admin/appointments/'+second.id+'/payments','POST',refund)).status,400);
 const refundRace=await Promise.all([api(url+'/payments','POST',refund),api(url+'/payments','POST',{...refund,idempotency_key:randomUUID()})]);assert.deepEqual(refundRace.map(r=>r.status).sort(),[201,409]);
 assert.equal((await api(url+'/payments','POST',refund)).status,200);
 assert.equal((await api(url+'/payments')).body.entries.find(e=>e.id===receipt.id).refundable_paise,3000);
 assert.equal((await api(url+'/payments','POST',payment(3001,{kind:'refund',original_payment_id:receipt.id,notes:'Excess receipt refund'}))).status,409);
 const other='/admin/appointments/'+second.id;const paid=await api(other+'/payments','POST',payment(10000,{method:'upi'}));const otherReceipt=paid.body.entries[0];
 await api(other+'/status','PATCH',{status:'cancelled',reason:'Clinic closed today'});
 assert.equal((await api(other+'/payments','POST',payment(1))).status,409);
 const cancelledRefund=await api(other+'/payments','POST',payment(2000,{kind:'refund',method:'upi',original_payment_id:otherReceipt.id,notes:'Clinic cancellation refund'}));assert.equal(cancelledRefund.status,201);
 // Same-key concurrency records exactly once, and zero-fee appointments accept no payment.
 const thirdUrl='/admin/appointments/'+third.id;const same=payment(1000);const sameRace=await Promise.all([api(thirdUrl+'/payments','POST',same),api(thirdUrl+'/payments','POST',same)]);assert.deepEqual(sameRace.map(r=>r.status).sort(),[200,201]);
 const fourth=await booking('12');assert.equal((await api('/admin/appointments/'+fourth.id+'/fee','PATCH',{fee_paise:0})).status,200);assert.equal((await api('/admin/appointments/'+fourth.id+'/payments','POST',payment(1))).status,409);
 const before=await all('SELECT * FROM payment_entries ORDER BY id');await init();await init();assert.deepEqual(await all('SELECT * FROM payment_entries ORDER BY id'),before);assert.equal((await api(url+'/payments')).body.appointment.fee_paise,40000);assert.equal((await get('SELECT fee_paise FROM appointments WHERE id=?',[legacy.id])).fee_paise,50000);
 await assert.rejects(run('UPDATE payment_entries SET amount_paise=1 WHERE id=?',[receipt.id]));await assert.rejects(run('DELETE FROM payment_entries WHERE id=?',[receipt.id]));
 // Insert explicitly dated fictional receipts, never modify append-only records, to exercise IST midnight.
 const insertDate=async(amount,date)=>run("INSERT INTO payment_entries(appointment_id,kind,amount_paise,method,reference,notes,recorded_by,recorded_at,idempotency_key) VALUES(?,'payment',?,'bank','','Fictional date-boundary test',?,?,?)",[legacy.id,amount,adminId,date,randomUUID()]);
 await insertDate(100,'2099-01-01T18:29:59.000Z');await insertDate(200,'2099-01-01T18:30:00.000Z');
 const one=(await api('/admin/revenue?from=2099-01-01&to=2099-01-01')).body;assert.equal(one.summary.gross_paise,100);assert.equal(one.daily[0].payments_paise,100);assert.equal(one.summary.transaction_count,1);assert.equal(one.appointment_status.find(r=>r.status==='cancelled').count,1);assert.equal(one.summary.cancelled_balance_paise,8000);
 // All-time due excludes cancelled second visit; first 7000 + third 49000 + legacy 49700 + fourth 0.
 assert.equal(one.summary.outstanding_paise,105700);
 const two=(await api('/admin/revenue?from=2099-01-02&to=2099-01-03')).body;assert.equal(two.summary.gross_paise,200);assert.equal(two.daily.length,2);assert.equal(two.daily[1].net_paise,0);assert.equal(two.recent[0].patient_name,'Demo Patient');assert.ok(two.recent[0].doctor_name);assert.equal(two.by_method.find(m=>m.method==='bank').payments_paise,200);
 const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});const report=(await api('/admin/revenue?from='+today+'&to='+today)).body;assert.equal(report.summary.gross_paise,51000);assert.equal(report.summary.refunds_paise,9000);assert.equal(report.summary.net_paise,42000);assert.equal(report.summary.transaction_count,6);assert.equal(report.by_doctor[0].net_paise,42000);
 for(const query of ['from=2026-02-31&to=2026-03-01','from=2026-11-02&to=2026-11-01','from=2020-01-01&to=2022-01-01','from=bad','from=2026-11-01&from=2026-11-02'])assert.equal((await api('/admin/revenue?'+query)).status,400);
 assert.equal((await api('/admin/revenue')).body.daily.length,30);
 // Aggregate totals must cover the full interval even when recent is capped at 100.
 for(let i=0;i<101;i++)await insertDate(1,'2099-02-01T00:00:00.000Z');const many=(await api('/admin/revenue?from=2099-02-01&to=2099-02-01')).body;assert.equal(many.recent.length,100);assert.equal(many.summary.gross_paise,101);assert.equal(many.summary.transaction_count,101);
 assert.equal((await api(url+'/payments','DELETE')).status,404);
 console.log('All ledger scenarios passed (authorization, snapshots/legacy, completion unpaid, partial/full, concurrency, refunds, idempotency, cancellation, IST reporting, recent cap, repeat migration).');
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
