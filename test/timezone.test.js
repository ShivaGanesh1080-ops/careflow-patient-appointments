const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
  test(`actual clinic helpers are independent of process TZ=${tz}`, () => {
    const child = spawnSync(process.execPath, [path.join(__dirname, 'timezone-case.js')], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stdout, /clinic timezone assertions passed/);
  });
}
