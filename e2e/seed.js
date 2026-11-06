const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { runtime, database, fixtureFile } = require('./environment');
async function seed() {
  if (
    process.env.NODE_ENV !== 'test' ||
    process.env.DB_FILE !== database ||
    process.env.TURSO_DATABASE_URL ||
    process.env.TURSO_AUTH_TOKEN
  )
    throw Error('E2E fixture requires its disposable local test database.');
  if (
    path.dirname(runtime) !== os.tmpdir() ||
    !path.basename(runtime).startsWith('careflow-playwright-')
  )
    throw Error('Unsafe fixture cleanup path.');
  // Fresh DB per run; append-only payment triggers are never bypassed for cleanup.
  fs.rmSync(runtime, { recursive: true, force: true });
  fs.mkdirSync(runtime, { recursive: true });
  const { init, run, get } = require('../server/db');
  const { localDate, shiftDate } = require('../server/clinic-time');
  await init();
  const patient = await get("SELECT id FROM users WHERE email='patient@careflow.demo'");
  const admin = await get("SELECT id FROM users WHERE email='admin@careflow.demo'");
  const doctor = await run(
    'INSERT INTO doctors(name,specialization,qualification,bio,experience,fee) VALUES(?,?,?,?,?,?)',
    [
      'Dr. Fictional Browser',
      'E2E Fictional Care',
      'Student fixture',
      'Fictional test data only',
      1,
      500,
    ],
  );
  const bookingDate = shiftDate(localDate(), 21);
  async function slot(date, hour) {
    return (
      await run('INSERT INTO slots(doctor_id,start_time,end_time) VALUES(?,?,?)', [
        doctor.id,
        date + 'T' + hour + ':00:00',
        date + 'T' + hour + ':30:00',
      ])
    ).id;
  }
  const bookSlot = await slot(bookingDate, '10');
  const replacementSlot = await slot(bookingDate, '11');
  async function appointment(date, hour, reason, arrived = false) {
    const slotId = await slot(date, hour);
    return (
      await run(
        "INSERT INTO appointments(patient_id,doctor_id,slot_id,reason,fee_paise,fee_basis,checked_in_at,checked_in_by) VALUES(?,?,?,?,50000,'booking_snapshot',?,?)",
        [
          patient.id,
          doctor.id,
          slotId,
          reason,
          arrived ? new Date().toISOString() : null,
          arrived ? admin.id : null,
        ],
      )
    ).id;
  }
  const financeId = await appointment(shiftDate(localDate(), 22), '09', 'E2E finance visit');
  const futureId = await appointment(shiftDate(localDate(), 23), '09', 'E2E future visit');
  const noShowId = await appointment(shiftDate(localDate(), -2), '09', 'E2E unarrived past visit');
  const arrivedId = await appointment(
    shiftDate(localDate(), -2),
    '10',
    'E2E arrived past visit',
    true,
  );
  await run(
    "INSERT INTO payment_entries(appointment_id,kind,amount_paise,method,reference,notes,recorded_by,recorded_at,idempotency_key) VALUES(?,'payment',20000,'cash','E2E fictional receipt','Fictional money already received',?,?,?)",
    [noShowId, admin.id, new Date().toISOString(), randomUUID()],
  );
  const jwt = require('../server/node_modules/jsonwebtoken');
  const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const fixtures = {
    bookingDate,
    bookSlot,
    replacementSlot,
    financeId,
    futureId,
    noShowId,
    arrivedId,
    doctorId: doctor.id,
    patientToken: token(patient.id),
    adminToken: token(admin.id),
  };
  fs.writeFileSync(fixtureFile, JSON.stringify(fixtures), { mode: 0o600 });
  return fixtures;
}
module.exports = { seed };
