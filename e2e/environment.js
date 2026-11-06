const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const suffix = createHash('sha256').update(root).digest('hex').slice(0, 12);
const runtime = path.join(os.tmpdir(), 'careflow-playwright-' + suffix);
const database = path.join(runtime, 'fictional.sqlite');
const fixtureFile = path.join(runtime, 'fixtures.json');
const baseURL = 'http://127.0.0.1:4317';
function isolateEnvironment() {
  // An allowlist prevents inherited production DB/mail/bootstrap variables reaching the app.
  for (const key of Object.keys(process.env)) {
    if (!/^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|CI)$/i.test(key))
      delete process.env[key];
  }
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DB_FILE: database,
    SEED_DEMO_USERS: 'true',
    JWT_SECRET: 'careflow-playwright-fictional-only-not-a-deployment-secret',
    HOST: '127.0.0.1',
    PORT: '4317',
  });
  // index.js normally reads server/.env. Tests must NEVER load that file.
  require('../server/node_modules/dotenv').config = () => ({ parsed: {} });
}
module.exports = { root, runtime, database, fixtureFile, baseURL, isolateEnvironment };
