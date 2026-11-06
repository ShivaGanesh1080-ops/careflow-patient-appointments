const { isolateEnvironment, runtime } = require('./environment');
isolateEnvironment();
(async () => {
  await require('./seed').seed();
  const server = await require('../server/index').start();
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      server.close(() => require('../server/db').db.close(() => process.exit(0)));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  console.log('Playwright fictional database only: ' + runtime);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
