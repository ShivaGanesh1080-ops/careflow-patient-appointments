const { defineConfig, devices } = require('@playwright/test');
const { baseURL } = require('./e2e/environment');
module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 45000,
  expect: { timeout: 10000 },
  outputDir: './e2e/results',
  reporter: [['list'], ['html', { outputFolder: './e2e/report', open: 'never' }]],
  use: {
    baseURL,
    timezoneId: 'Asia/Kolkata',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/start-server.js',
    url: baseURL + '/api/health',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
