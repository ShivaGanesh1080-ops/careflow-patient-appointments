// Public demo email is restricted to explicitly approved recipients.
function recipientAllowed(recipient, env = process.env) {
  const list = (env.MAIL_ALLOWED_RECIPIENTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length
    ? list.includes(String(recipient).trim().toLowerCase())
    : env.NODE_ENV !== 'production';
}
module.exports = { recipientAllowed };
