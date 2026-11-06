const test = require('node:test');
const assert = require('node:assert/strict');
const { createGmailTransport, gmailConfigured } = require('../mail-gmail-api');
const env = {
  GMAIL_USER: 'sender@example.invalid',
  GMAIL_CLIENT_ID: 'fake-client',
  GMAIL_CLIENT_SECRET: 'fake-secret',
  GMAIL_REFRESH_TOKEN: 'fake-refresh',
};
const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const { recipientAllowed } = require('../mail-recipient-policy');
test('production demo mail fails closed without a recipient allowlist', () => {
  assert.equal(recipientAllowed('a@example.invalid', { NODE_ENV: 'production' }), false);
  assert.equal(
    recipientAllowed('a@example.invalid', {
      NODE_ENV: 'production',
      MAIL_ALLOWED_RECIPIENTS: 'A@example.invalid',
    }),
    true,
  );
  assert.equal(
    recipientAllowed('other@example.invalid', {
      NODE_ENV: 'production',
      MAIL_ALLOWED_RECIPIENTS: 'a@example.invalid',
    }),
    false,
  );
});
test('Gmail HTTPS transport builds MIME, uses headers, and reuses an access token', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return url.includes('oauth2')
      ? ok({ access_token: 'fake-access', expires_in: 3600 })
      : ok({ id: 'fake-message' });
  };
  const sender = createGmailTransport({ env, fetchImpl });
  const message = {
    to: 'recipient@example.invalid',
    subject: 'Clinic cancellation',
    text: 'Fictional test only.\nReason: schedule changed.',
  };
  await sender.sendMail(message);
  await sender.sendMail(message);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.body.get('grant_type'), 'refresh_token');
  assert.equal(calls[1].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer fake-access');
  const mime = Buffer.from(JSON.parse(calls[1].options.body).raw, 'base64url').toString('utf8');
  assert.match(mime, /From: sender@example.invalid\r\nTo: recipient@example.invalid/);
  assert.match(mime, /Content-Transfer-Encoding: base64/);
  const content = mime.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(content, 'base64').toString('utf8'), message.text);
  assert(!mime.includes('fake-refresh'));
  assert(!mime.includes('fake-secret'));
});
test('Gmail OAuth errors expose a safe code, not response contents', async () => {
  const sender = createGmailTransport({
    env,
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'private-provider-details' }),
    }),
  });
  await assert.rejects(sender.sendMail({ to: 'recipient@example.invalid', text: 'test' }), {
    code: 'GMAIL_OAUTH_400',
    message: 'GMAIL_OAUTH_400',
  });
});
test('Gmail send failure expires the token after HTTP 401', async () => {
  let tokenCalls = 0;
  let sendCalls = 0;
  const sender = createGmailTransport({
    env,
    fetchImpl: async (url) => {
      if (url.includes('oauth2')) {
        tokenCalls++;
        return ok({ access_token: 'fake-access', expires_in: 3600 });
      }
      if (++sendCalls === 1) return { ok: false, status: 401 };
      return ok({ id: 'retry-message' });
    },
  });
  await assert.rejects(sender.sendMail({ to: 'recipient@example.invalid', text: 'test' }), {
    code: 'GMAIL_SEND_401',
  });
  await sender.sendMail({ to: 'recipient@example.invalid', text: 'test' });
  assert.equal(tokenCalls, 2);
});
test('Gmail rejects injected recipient headers before requesting tokens', async () => {
  let calls = 0;
  const sender = createGmailTransport({
    env,
    fetchImpl: async () => {
      calls++;
      throw Error('unexpected network');
    },
  });
  await assert.rejects(
    sender.sendMail({ to: 'recipient@example.invalid\r\nBcc: other@example.invalid' }),
    { code: 'GMAIL_INVALID_ADDRESS' },
  );
  assert.equal(calls, 0);
});
test('Gmail stays unconfigured unless all server-side OAuth settings exist', () => {
  assert.equal(gmailConfigured({}), false);
  assert.equal(gmailConfigured({ ...env, GMAIL_REFRESH_TOKEN: '' }), false);
  assert.equal(gmailConfigured(env), true);
});
