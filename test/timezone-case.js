// No database, browser, network or real clock. Execute production helpers in each TZ.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../client/node_modules/typescript');
const backend = require('../server/clinic-time');
const filename = path.join(__dirname, '../client/src/app/clinic-time.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = new Module(filename, module);
mod._compile(compiled, filename);
const front = mod.exports;
for (const [instant, date, time] of [
  ['2026-11-06T18:29:59.999Z', '2026-11-06', '23:59:59'],
  ['2026-11-06T18:30:00.000Z', '2026-11-07', '00:00:00'],
  ['2026-12-31T18:30:00.000Z', '2027-01-01', '00:00:00'],
  ['2028-02-28T18:30:00.000Z', '2028-02-29', '00:00:00'],
  ['2026-03-08T10:00:00.000Z', '2026-03-08', '15:30:00'],
]) {
  const d = new Date(instant);
  assert.equal(backend.localDate(d), date);
  assert.equal(backend.localNow(d), date + 'T' + time);
  assert.equal(front.clinicDate(d), date);
  assert.equal(front.clinicDate(d, -29), backend.shiftDate(date, -29));
}
assert.equal(backend.shiftDate('2027-01-01', -1), '2026-12-31');
assert.equal(backend.validDate('2026-02-31'), false);
assert.equal(backend.validDate('2028-02-29'), true);
assert.equal(backend.validDate('2026-02-29'), false);
assert.equal(backend.validDate('2026-13-01'), false);
assert.equal(backend.validDate('2026-2-01'), false);
assert.equal(backend.validDate(null), false);
for (const value of ['2026-11-07T09:00', '2026-11-07 09:00:00', '2026-11-07T09:00:00.000']) {
  assert.equal(front.clinicMillis(value), Date.parse('2026-11-07T03:30:00Z'));
  assert.match(front.clinicTimestamp(value), /\+05:30$/);
}
for (const value of [
  '2026-11-07T03:30:00Z',
  '2026-11-07T09:00:00+05:30',
  '2026-11-06T19:30:00-08:00',
]) {
  assert.equal(front.clinicTimestamp(value), value);
  assert.equal(front.clinicMillis(value), Date.parse('2026-11-07T03:30:00Z'));
}
assert.equal(front.clinicTimestamp('not-a-date'), 'not-a-date');
assert.equal(front.isFutureClinicTime('not-a-date', 0), false);
const boundary = Date.parse('2026-11-07T03:30:00Z');
assert.equal(front.isFutureClinicTime('2026-11-07T09:00:00', boundary - 1), true);
assert.equal(front.isFutureClinicTime('2026-11-07T09:00:00', boundary), false);
assert.equal(front.isFutureClinicTime('2026-11-07T09:00:00', boundary + 1), false);
assert.equal(front.isFutureClinicTime('2026-11-07T09:30:00', boundary), true);
assert.equal(
  front.clinicMillis('2026-11-07T09:30:00') - front.clinicMillis('2026-11-07T09:00:00'),
  1800000,
);
const original = {
  slots: [{ start_time: '2026-11-07T09:00:00', end_time: '2026-11-07T09:30:00' }],
  appointment: { start_time: '2026-11-07 09:00:00', checked_in_at: '2026-11-07T03:25:00Z' },
  created_at: '2026-11-01T00:00:00Z',
  recorded_at: '2026-11-01T00:00:00Z',
  value: null,
};
const normalized = front.normalizeClinicResponse(original);
assert.equal(normalized.slots[0].start_time, '2026-11-07T09:00:00+05:30');
assert.equal(normalized.slots[0].end_time, '2026-11-07T09:30:00+05:30');
assert.equal(normalized.appointment.start_time, normalized.slots[0].start_time);
assert.equal(normalized.appointment.checked_in_at, original.appointment.checked_in_at);
assert.equal(normalized.created_at, original.created_at);
assert.equal(normalized.recorded_at, original.recorded_at);
assert.equal(normalized.value, null);
assert.equal(original.slots[0].start_time, '2026-11-07T09:00:00');
assert.deepEqual(front.normalizeClinicResponse(normalized), normalized);
// Use Angular's real formatter and the same options wired into bootstrap.
const clientRequire = Module.createRequire(path.join(__dirname, '../client/package.json'));
clientRequire('@angular/compiler');
const { DatePipe } = clientRequire('@angular/common');
const pipe = new DatePipe('en-US', null, front.CLINIC_DATE_PIPE_OPTIONS);
assert.equal(
  pipe.transform(normalized.slots[0].start_time, 'yyyy-MM-dd HH:mm'),
  '2026-11-07 09:00',
);
assert.equal(pipe.transform(normalized.slots[0].end_time, 'HH:mm'), '09:30');
assert.equal(pipe.transform('2026-11-06T18:29:59Z', 'yyyy-MM-dd HH:mm:ss'), '2026-11-06 23:59:59');
assert.equal(pipe.transform('2026-11-06T18:30:00Z', 'yyyy-MM-dd HH:mm:ss'), '2026-11-07 00:00:00');
const auditInput = {
  created_at: '2026-11-06 18:30:00',
  read_at: '2026-11-06 18:29:59',
  checked_in_at: '2026-11-06T18:30:00.123',
  completed_at: '2026-11-07T00:00:00+05:30',
  recorded_at: '2026-11-06T18:30:00Z',
  arbitrary_at: '2026-11-06 18:30:00',
  nested: { read_at: null, created_at: 'not-a-date' },
};
const audit = front.normalizeClinicResponse(auditInput);
assert.equal(audit.created_at, '2026-11-06T18:30:00Z');
assert.equal(audit.read_at, '2026-11-06T18:29:59Z');
assert.equal(audit.checked_in_at, '2026-11-06T18:30:00.123Z');
assert.equal(audit.completed_at, auditInput.completed_at);
assert.equal(audit.recorded_at, auditInput.recorded_at);
assert.equal(audit.arbitrary_at, auditInput.arbitrary_at);
assert.deepEqual(audit.nested, auditInput.nested);
assert.equal(auditInput.created_at, '2026-11-06 18:30:00');
assert.deepEqual(front.normalizeClinicResponse(audit), audit);
assert.equal(pipe.transform(audit.created_at, 'yyyy-MM-dd HH:mm:ss'), '2026-11-07 00:00:00');
assert.equal(pipe.transform(audit.read_at, 'yyyy-MM-dd HH:mm:ss'), '2026-11-06 23:59:59');
console.log('clinic timezone assertions passed');
