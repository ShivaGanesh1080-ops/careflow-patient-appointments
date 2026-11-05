// Gmail HTTPS transport for hosts that block SMTP. Credentials stay on the server.
const {randomUUID}=require('node:crypto');
function safeError(code){const e=new Error(code);e.code=code;return e;}
function address(value){
  if(typeof value!=='string'||/[\r\n]/.test(value)||! /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value))throw safeError('GMAIL_INVALID_ADDRESS');
  return value;
}
function gmailConfigured(env=process.env){return !!(env.GMAIL_USER&&env.GMAIL_CLIENT_ID&&env.GMAIL_CLIENT_SECRET&&env.GMAIL_REFRESH_TOKEN);}
function createGmailTransport({env=process.env,fetchImpl=globalThis.fetch,now=Date.now}={}){
  let accessToken;let validUntil=0;
  async function token(){
    if(accessToken&&now()<validUntil)return accessToken;
    const response=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GMAIL_CLIENT_ID,client_secret:env.GMAIL_CLIENT_SECRET,refresh_token:env.GMAIL_REFRESH_TOKEN,grant_type:'refresh_token'}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw safeError('GMAIL_OAUTH_'+response.status);
    const data=await response.json();
    if(typeof data.access_token!=='string'||!data.access_token)throw safeError('GMAIL_OAUTH_RESPONSE');
    accessToken=data.access_token;validUntil=now()+Math.max(0,(Number(data.expires_in)||3600)-60)*1000;
    return accessToken;
  }
  return {async sendMail(message){
    const from=address(env.GMAIL_USER);const to=address(message.to);
    const subject=Buffer.from(String(message.subject||'CareFlow update'),'utf8').toString('base64');
    const body=(Buffer.from(String(message.text||''),'utf8').toString('base64').match(/.{1,76}/g)||[]).join('\r\n');
    const mime=[`From: ${from}`,`To: ${to}`,`Subject: =?UTF-8?B?${subject}?=`,`Date: ${new Date(now()).toUTCString()}`,`Message-ID: <${randomUUID()}@careflow.invalid>`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',body].join('\r\n');
    const bearer=await token();
    const response=await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},body:JSON.stringify({raw:Buffer.from(mime,'utf8').toString('base64url')}),signal:AbortSignal.timeout(15000)});
    if(!response.ok){if(response.status===401){accessToken=undefined;validUntil=0;}throw safeError('GMAIL_SEND_'+response.status);}
    const result=await response.json();if(!result.id)throw safeError('GMAIL_SEND_RESPONSE');
    return {messageId:result.id};
  }};
}
module.exports={createGmailTransport,gmailConfigured};
