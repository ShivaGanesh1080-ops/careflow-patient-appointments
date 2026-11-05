const nodemailer=require('nodemailer');
const {createGmailTransport,gmailConfigured}=require('./mail-gmail-api');
const {all,run}=require('./db');
let working=false;
let transport;
let changeHandler=()=>{};
const {recipientAllowed}=require('./mail-recipient-policy');
function configured(){
  if(process.env.NODE_ENV==='production'&&!process.env.MAIL_ALLOWED_RECIPIENTS?.trim())return false;
  return process.env.MAIL_PROVIDER==='gmail_api'?gmailConfigured():!!(process.env.SMTP_USER&&process.env.SMTP_APP_PASSWORD);
}
function getTransport(){
  if(!configured())return null;
  if(process.env.MAIL_PROVIDER==='gmail_api')return createGmailTransport();
  if(!transport)transport=nodemailer.createTransport({host:process.env.SMTP_HOST||'smtp.gmail.com',port:Number(process.env.SMTP_PORT)||465,secure:(process.env.SMTP_PORT||'465')==='465',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_APP_PASSWORD},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000});
  return transport;
}
function onMailChange(handler){changeHandler=handler;}
async function processMail(testTransport){
  if(working)return {processed:0};working=true;let processed=0;
  try{
    const sender=testTransport||getTransport();
    if(!sender){await run("UPDATE notifications SET email_status='not_configured' WHERE email_status='pending'");return {processed:0,configured:false};}
    const jobs=await all(`SELECT j.*,n.title,n.message,n.user_id FROM email_jobs j JOIN notifications n ON n.id=j.notification_id WHERE j.sent_at IS NULL AND j.attempts<5 AND j.next_attempt_at<=CURRENT_TIMESTAMP ORDER BY j.id LIMIT 10`);
    for(const job of jobs){
      if(!testTransport&&!recipientAllowed(job.recipient)){
        await run("UPDATE email_jobs SET attempts=5,last_error='RECIPIENT_NOT_ALLOWED' WHERE id=?",[job.id]);
        await run("UPDATE notifications SET email_status='failed' WHERE id=?",[job.notification_id]);changeHandler(job.user_id);continue;
      }
      // Fictional .demo/.invalid addresses must never be submitted to an email provider.
      if(/\.(demo|invalid)$/i.test(job.recipient)&&!testTransport){await run("UPDATE email_jobs SET attempts=5,last_error='Fictional demo address; delivery skipped' WHERE id=?",[job.id]);await run("UPDATE notifications SET email_status='failed' WHERE id=?",[job.notification_id]);changeHandler(job.user_id);continue;}
      try{
        await sender.sendMail({from:process.env.SMTP_FROM||process.env.SMTP_USER||'CareFlow Test <test@example.invalid>',to:job.recipient,subject:job.title,text:job.message+'\n\nPlease sign in to CareFlow to review your appointments. This is a student demonstration system.'});
        await run("UPDATE email_jobs SET sent_at=CURRENT_TIMESTAMP,attempts=attempts+1,last_error='' WHERE id=?",[job.id]);
        await run("UPDATE notifications SET email_status='sent' WHERE id=?",[job.notification_id]);
      }catch(error){
        const attempts=job.attempts+1;const seconds=Math.min(900,15*Math.pow(2,attempts-1));
        // Store a safe diagnostic code, never SMTP credentials or full server responses.
        const diagnostic=String(error.code||'SMTP_ERROR').replace(/[^A-Z0-9_]/gi,'').slice(0,60);
        await run("UPDATE email_jobs SET attempts=?,next_attempt_at=datetime('now',?),last_error=? WHERE id=?",[attempts,'+'+seconds+' seconds',diagnostic,job.id]);
        await run('UPDATE notifications SET email_status=? WHERE id=?',[attempts>=5?'failed':'pending',job.notification_id]);
      }
      processed++;changeHandler(job.user_id);
    }
    return {processed,configured:true};
  }finally{working=false;}
}
function kickMail(){if(process.env.NODE_ENV==='test')return;setImmediate(()=>processMail().catch(e=>console.error('Email worker:',e.code||'worker error')));}
function startMailWorker(){kickMail();const timer=setInterval(kickMail,15000);timer.unref();return timer;}
module.exports={processMail,kickMail,startMailWorker,onMailChange,configured,recipientAllowed};
