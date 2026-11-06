const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { init, run, get, all, db } = require('../db');
const { createHttpServer } = require('../index');
let server, base, admin, patient, other, patientId, adminId;
async function api(url, method = 'GET', body, token = admin) {
  const r = await fetch(base + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
const pay = (amount_paise, extra = {}) => ({
  kind: 'payment',
  amount_paise,
  method: 'cash',
  notes: 'Fictional receipt entry',
  idempotency_key: randomUUID(),
  ...extra,
});
const waive = (amount_paise) => ({
  amount_paise,
  reason: 'Approved service discount',
  idempotency_key: randomUUID(),
});
let counter = 0;
async function slot(day = '2099-02-01', doctor = 1, hour) {
  const h = hour === undefined ? String(8 + counter++).padStart(2, '0') : hour;
  return (
    await run('INSERT INTO slots(doctor_id,start_time,end_time) VALUES(?,?,?)', [
      doctor,
      `${day}T${h}:00:00`,
      `${day}T${h}:30:00`,
    ])
  ).id;
}
async function booking(s) {
  const r = await api('/appointments', 'POST', { slotId: s }, patient);
  assert.equal(r.status, 201, JSON.stringify(r));
  return r.body.appointment;
}
const url = (a) => '/admin/appointments/' + a.id;
(async () => {
  try {
    // Exact pre-release CHECK, plus unrelated schema objects and rows to retain.
    await run('PRAGMA foreign_keys=ON');
    await run(
      "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,phone TEXT DEFAULT '',role TEXT NOT NULL DEFAULT 'patient',created_at TEXT DEFAULT CURRENT_TIMESTAMP)",
    );
    await run(
      "CREATE TABLE doctors(id INTEGER PRIMARY KEY,name TEXT NOT NULL,specialization TEXT NOT NULL,qualification TEXT NOT NULL,bio TEXT DEFAULT '',experience INTEGER NOT NULL,fee REAL NOT NULL,active INTEGER NOT NULL DEFAULT 1)",
    );
    await run(
      'CREATE TABLE slots(id INTEGER PRIMARY KEY,doctor_id INTEGER NOT NULL REFERENCES doctors(id),start_time TEXT NOT NULL,end_time TEXT NOT NULL,UNIQUE(doctor_id,start_time))',
    );
    await run(
      "CREATE TABLE appointments(id INTEGER PRIMARY KEY,patient_id INTEGER NOT NULL REFERENCES users(id),doctor_id INTEGER NOT NULL REFERENCES doctors(id),slot_id INTEGER NOT NULL REFERENCES slots(id),reason TEXT DEFAULT '',status TEXT NOT NULL DEFAULT 'booked' CHECK(status IN ('booked','cancelled','completed')),created_at TEXT DEFAULT CURRENT_TIMESTAMP)",
    );
    await run(
      "INSERT INTO users(id,name,email,password_hash,role) VALUES(101,'Legacy patient','legacy@example.test','fictional','patient')",
    );
    await run("INSERT INTO doctors VALUES(1,'Fictional doctor','General','MBBS','',10,500,1)");
    await run("INSERT INTO slots VALUES(101,1,'2020-01-01T09:00:00','2020-01-01T09:30:00')");
    await run(
      "INSERT INTO appointments(id,patient_id,doctor_id,slot_id,status) VALUES(101,101,1,101,'cancelled')",
    );
    await run('CREATE INDEX custom_legacy_reason ON appointments(reason)');
    await run(
      "CREATE TRIGGER custom_legacy_guard BEFORE DELETE ON appointments BEGIN SELECT RAISE(ABORT,'retain custom trigger'); END",
    );
    // Existing receipt/refund foreign keys and unknown ledger objects also survive migration.
    await run(
      `CREATE TABLE payment_entries(id INTEGER PRIMARY KEY,appointment_id INTEGER NOT NULL REFERENCES appointments(id),kind TEXT NOT NULL CHECK(kind IN ('payment','refund')),amount_paise INTEGER NOT NULL CHECK(typeof(amount_paise)='integer' AND amount_paise BETWEEN 1 AND 10000000),method TEXT NOT NULL CHECK(method IN ('cash','upi','card','bank')),reference TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',original_payment_id INTEGER REFERENCES payment_entries(id),recorded_by INTEGER NOT NULL REFERENCES users(id),recorded_at TEXT NOT NULL,idempotency_key TEXT UNIQUE NOT NULL)`,
    );
    await run(
      "INSERT INTO payment_entries VALUES(201,101,'payment',5000,'cash','','Legacy receipt',NULL,101,'2020-01-01T04:00:00.000Z',?)",
      [randomUUID()],
    );
    await run(
      "INSERT INTO payment_entries VALUES(202,101,'refund',1000,'cash','','Legacy correction',201,101,'2020-01-01T05:00:00.000Z',?)",
      [randomUUID()],
    );
    await run('CREATE INDEX custom_legacy_payment ON payment_entries(reference)');
    await run(
      "CREATE TRIGGER custom_ledger_guard BEFORE DELETE ON payment_entries BEGIN SELECT RAISE(ABORT,'retain ledger trigger'); END",
    );
    const oldLedger = await all('SELECT * FROM payment_entries ORDER BY id');
    const schema = await all(
      "SELECT name,sql FROM sqlite_master WHERE name IN ('appointments','custom_legacy_reason','custom_legacy_guard') ORDER BY name",
    );
    await init();
    await init();
    assert.deepEqual(
      await all(
        "SELECT name,sql FROM sqlite_master WHERE name IN ('custom_legacy_reason','custom_legacy_guard') ORDER BY name",
      ),
      schema.filter((r) => r.name !== 'appointments'),
    );
    assert.ok(
      (await get("SELECT sql FROM sqlite_master WHERE name='appointments'")).sql.includes(
        "CHECK(status IN ('booked','cancelled','completed'))",
      ),
    );
    assert.equal((await get('SELECT status FROM appointments WHERE id=101')).status, 'cancelled');
    const migratedLedger = await all('SELECT * FROM payment_entries ORDER BY id');
    assert.deepEqual(
      migratedLedger.map(({ refund_type, ...r }) => r),
      oldLedger,
    );
    assert.ok(migratedLedger.every((r) => r.refund_type === 'correction'));
    assert.equal(
      (
        await get(
          "SELECT count(*) n FROM sqlite_master WHERE name IN ('custom_legacy_payment','custom_ledger_guard')",
        )
      ).n,
      2,
    );
    const p = await get("SELECT id FROM users WHERE email='patient@careflow.demo'"),
      a = await get("SELECT id FROM users WHERE role='admin'");
    patientId = p.id;
    adminId = a.id;
    patient = jwt.sign({ id: p.id }, process.env.JWT_SECRET);
    admin = jwt.sign({ id: a.id }, process.env.JWT_SECRET);
    other = jwt.sign({ id: 101 }, process.env.JWT_SECRET);
    server = createHttpServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + server.address().port;
    const first = await booking(await slot()),
      u = url(first);
    assert.equal((await api(u + '/waivers', 'POST', waive(100), patient)).status, 403);
    for (const amount of [0, -1, 0.5, '100', 10000001])
      assert.equal((await api(u + '/waivers', 'POST', waive(amount))).status, 400);
    const intent = waive(10000),
      race = await Promise.all([
        api(u + '/waivers', 'POST', intent),
        api(u + '/waivers', 'POST', intent),
      ]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 201]);
    assert.equal((await api(u + '/waivers', 'POST', { ...intent, amount_paise: 1 })).status, 409);
    assert.equal((await api(u + '/fee', 'PATCH', { fee_paise: 60000 })).status, 409);
    assert.equal((await api(u + '/payments', 'POST', pay(40001))).status, 409);
    let paid = await api(u + '/payments', 'POST', pay(40000));
    assert.equal(paid.status, 201);
    const receipt = paid.body.entries[0];
    assert.equal(paid.body.appointment.effective_charge_paise, 40000);
    assert.equal(paid.body.appointment.fee_paise, 50000);
    let reduced = await api(u + '/waivers', 'POST', waive(5000));
    assert.equal(reduced.status, 201);
    assert.equal(reduced.body.appointment.refundable_paise, 5000);
    assert.equal(reduced.body.appointment.outstanding_paise, 0);
    const goodwill = pay(10000, {
      kind: 'refund',
      refund_type: 'goodwill',
      original_payment_id: receipt.id,
      notes: 'Goodwill service reduction',
    });
    const gr = await Promise.all([
      api(u + '/payments', 'POST', goodwill),
      api(u + '/payments', 'POST', goodwill),
    ]);
    assert.deepEqual(gr.map((r) => r.status).sort(), [200, 201]);
    let data = (await api(u + '/payments')).body;
    assert.equal(data.appointment.waived_paise, 25000);
    assert.equal(data.appointment.paid_paise, 30000);
    assert.equal(data.appointment.refundable_paise, 5000);
    assert.equal(data.adjustments.filter((r) => r.kind === 'goodwill').length, 1);
    const correction = pay(5000, {
      kind: 'refund',
      original_payment_id: receipt.id,
      notes: 'Correction of excess receipt',
    });
    assert.equal((await api(u + '/payments', 'POST', correction)).status, 201);
    data = (await api(u + '/payments')).body;
    assert.equal(data.appointment.effective_charge_paise, 25000);
    assert.equal(data.appointment.refundable_paise, 0);
    assert.equal(
      (
        await api(u + '/payments', 'POST', {
          ...goodwill,
          idempotency_key: randomUUID(),
          amount_paise: 25001,
        })
      ).status,
      409,
    );
    // A failed matching reduction must roll back the refund too, even if failure is in the trigger.
    await run(
      "CREATE TRIGGER reject_test_goodwill BEFORE INSERT ON charge_adjustments WHEN NEW.kind='goodwill' BEGIN SELECT RAISE(ABORT,'simulated compound failure'); END",
    );
    const before = await all('SELECT * FROM payment_entries ORDER BY id');
    assert.equal(
      (
        await api(u + '/payments', 'POST', {
          ...goodwill,
          idempotency_key: randomUUID(),
          amount_paise: 1000,
        })
      ).status,
      409,
    );
    assert.deepEqual(await all('SELECT * FROM payment_entries ORDER BY id'), before);
    await run('DROP TRIGGER reject_test_goodwill');
    for (const table of ['payment_entries', 'charge_adjustments', 'appointment_history']) {
      if (table !== 'appointment_history') {
        await assert.rejects(run(`UPDATE ${table} SET amount_paise=1`));
        await assert.rejects(run(`DELETE FROM ${table}`));
      }
    }
    // Rescheduling preserves the ID, snapshot, ledger and creates exactly one history + notice.
    assert.ok(first.created_at.endsWith('Z'));
    const target = await slot();
    const move = {
      slotId: target,
      expected_slot_id: first.slot_id,
      reason: 'Patient requested another time',
    };
    assert.equal(
      (await api('/appointments/' + first.id + '/reschedule', 'PATCH', move, other)).status,
      404,
    );
    assert.equal(
      (await api('/appointments/' + first.id + '/history', 'GET', undefined, other)).status,
      404,
    );
    assert.equal(
      (
        await api(
          '/appointments/' + first.id + '/reschedule',
          'PATCH',
          { slotId: target, reason: move.reason },
          patient,
        )
      ).status,
      400,
    );
    let moved = await api('/appointments/' + first.id + '/reschedule', 'PATCH', move, patient);
    assert.equal(moved.status, 200, JSON.stringify(moved));
    assert.equal(moved.body.appointment.id, first.id);
    assert.equal(moved.body.appointment.fee_paise, 50000);
    assert.equal(moved.body.appointment.paid_paise, 25000);
    assert.equal(
      (await api('/appointments/' + first.id + '/reschedule', 'PATCH', move, patient)).status,
      409,
    );
    let history = (await api('/appointments/' + first.id + '/history', 'GET', undefined, patient))
      .body.history;
    assert.equal(history.length, 1);
    assert.equal(history[0].old_slot_id, first.slot_id);
    assert.equal(history[0].new_slot_id, target);
    assert.equal(history[0].recorded_by, patientId);
    assert.ok(history[0].recorded_at.endsWith('Z'));
    assert.equal(
      (
        await get(
          "SELECT count(*) n FROM notifications WHERE appointment_id=? AND title='Appointment rescheduled'",
          [first.id],
        )
      ).n,
      1,
    );
    assert.equal(
      (
        await get(
          'SELECT count(*) n FROM email_jobs e JOIN notifications n ON n.id=e.notification_id WHERE n.appointment_id=?',
          [first.id],
        )
      ).n,
      1,
    );
    const mail = await require('../mail').processMail({
      sendMail: async () => ({ messageId: 'fictional-reschedule' }),
    });
    assert.equal(mail.processed, 1);
    assert.ok(
      (
        await get(
          'SELECT sent_at FROM email_jobs e JOIN notifications n ON n.id=e.notification_id WHERE n.appointment_id=?',
          [first.id],
        )
      ).sent_at.endsWith('Z'),
    );
    await assert.rejects(run('DELETE FROM appointment_history'));
    await assert.rejects(run("UPDATE appointment_history SET reason='rewrite'"));
    const blocker = await booking(await slot());
    const blockedMove = { ...move, slotId: blocker.slot_id, expected_slot_id: target };
    assert.equal(
      (await api('/appointments/' + first.id + '/reschedule', 'PATCH', blockedMove, patient))
        .status,
      409,
    );
    const doc = await run(
      "INSERT INTO doctors(name,specialization,qualification,experience,fee) VALUES('Other doctor','General','MBBS',1,800)",
    );
    const cross = await slot('2099-02-02', doc.id, '09');
    assert.equal(
      (
        await api(
          '/appointments/' + first.id + '/reschedule',
          'PATCH',
          { ...blockedMove, slotId: cross },
          patient,
        )
      ).status,
      409,
    );
    // Deliberately overlapping raw slots exercise interval checks, not only unique slot IDs.
    const overlap = (
      await run(
        "INSERT INTO slots(doctor_id,start_time,end_time) SELECT 1,substr(start_time,1,14)||'10:00',substr(start_time,1,14)||'40:00' FROM slots WHERE id=?",
        [blocker.slot_id],
      )
    ).id;
    assert.equal(
      (
        await api(
          '/appointments/' + first.id + '/reschedule',
          'PATCH',
          { ...blockedMove, slotId: overlap },
          patient,
        )
      ).status,
      409,
    );
    const t1 = await slot(),
      t2 = await slot();
    const mr = await Promise.all(
      [t1, t2].map((slotId) =>
        api(
          '/appointments/' + first.id + '/reschedule',
          'PATCH',
          { ...blockedMove, slotId },
          patient,
        ),
      ),
    );
    assert.deepEqual(mr.map((r) => r.status).sort(), [200, 409]);
    const latest = (await api(u + '/payments')).body.appointment;
    await run(
      "CREATE TRIGGER reject_test_notice BEFORE INSERT ON notifications WHEN NEW.title='Appointment rescheduled' BEGIN SELECT RAISE(ABORT,'simulated outbox failure'); END",
    );
    const failTarget = await slot();
    assert.equal(
      (
        await api(
          '/appointments/' + first.id + '/reschedule',
          'PATCH',
          { ...move, expected_slot_id: latest.slot_id, slotId: failTarget },
          patient,
        )
      ).status,
      409,
    );
    assert.equal(
      (await get('SELECT slot_id FROM appointments WHERE id=?', [first.id])).slot_id,
      latest.slot_id,
    );
    await run('DROP TRIGGER reject_test_notice');
    assert.equal(
      (await api(u + '/no-show', 'PATCH', { reason: 'Did not attend consultation' })).status,
      409,
    );
    const { localNow } = require('../clinic-time');
    const stamp = localNow();
    const start = localNow(new Date(Date.now() - 10 * 60000)),
      end = localNow(new Date(Date.now() + 10 * 60000));
    const currentSlot = (
      await run('INSERT INTO slots(doctor_id,start_time,end_time) VALUES(1,?,?)', [start, end])
    ).id;
    const currentId = (
      await run(
        "INSERT INTO appointments(patient_id,doctor_id,slot_id,fee_paise,fee_basis) VALUES(?,1,?,50000,'booking_snapshot')",
        [patientId, currentSlot],
      )
    ).id;
    assert.equal(
      (
        await api('/admin/appointments/' + currentId + '/no-show', 'PATCH', {
          reason: 'Must wait until scheduled end',
        })
      ).status,
      409,
    );
    await api(url(blocker) + '/arrival', 'PATCH', { arrived: true });
    assert.equal(
      (
        await api(
          '/appointments/' + blocker.id + '/reschedule',
          'PATCH',
          {
            slotId: failTarget,
            expected_slot_id: blocker.slot_id,
            reason: 'Arrived cannot reschedule',
          },
          patient,
        )
      ).status,
      409,
    );
    // Paid past visit: mark no-show only after END, leave receipt intact and excess refundable.
    const pastSlot = await slot('2020-02-01', 1, '10');
    const pastId = (
      await run(
        "INSERT INTO appointments(patient_id,doctor_id,slot_id,fee_paise,fee_basis) VALUES(?,1,?,50000,'booking_snapshot')",
        [patientId, pastSlot],
      )
    ).id;
    const past = { id: pastId },
      pu = url(past);
    const pastPaid = await api(pu + '/payments', 'POST', pay(12000));
    assert.equal(pastPaid.status, 201);
    assert.equal(
      (await api(pu + '/no-show', 'PATCH', { reason: 'Did not attend consultation' }, patient))
        .status,
      403,
    );
    assert.equal((await api(pu + '/waivers', 'POST', waive(5000))).status, 201);
    const nr = await Promise.all([
      api(pu + '/no-show', 'PATCH', { reason: 'Did not attend consultation' }),
      api(pu + '/arrival', 'PATCH', { arrived: true }),
    ]);
    // Either arrival wins (no waiver) or no-show wins (arrival cannot reopen).
    assert.deepEqual(nr.map((r) => r.status).sort(), [200, 409]);
    let no = (await api(pu + '/payments')).body.appointment;
    if (no.status === 'booked') {
      assert.ok(no.checked_in_at);
      await api(pu + '/arrival', 'PATCH', { arrived: false });
      assert.equal(
        (await api(pu + '/no-show', 'PATCH', { reason: 'Did not attend consultation' })).status,
        200,
      );
    }
    no = (await api(pu + '/payments')).body.appointment;
    assert.equal(no.status, 'no_show');
    assert.equal(no.waived_paise, 50000);
    assert.equal(
      (
        await get(
          "SELECT amount_paise FROM charge_adjustments WHERE appointment_id=? AND kind='no_show'",
          [pastId],
        )
      ).amount_paise,
      45000,
    );
    assert.equal(no.effective_charge_paise, 0);
    assert.equal(no.refundable_paise, 12000);
    assert.equal(no.outstanding_paise, 0);
    assert.ok(no.no_show_at.endsWith('Z'));
    assert.equal(
      (await api(pu + '/no-show', 'PATCH', { reason: 'Retry is not a new classification' })).status,
      409,
    );
    for (const [endpoint, body] of [
      ['arrival', { arrived: true }],
      ['status', { status: 'completed' }],
      ['status', { status: 'cancelled', reason: 'Cannot cancel a no show' }],
    ])
      assert.equal((await api(pu + '/' + endpoint, 'PATCH', body)).status, 409);
    assert.equal((await api(pu + '/payments', 'POST', pay(1))).status, 409);
    assert.equal(
      (
        await api(
          '/appointments/' + pastId + '/reschedule',
          'PATCH',
          { ...move, expected_slot_id: pastSlot },
          patient,
        )
      ).status,
      409,
    );
    assert.equal(
      (await api('/appointments/' + pastId + '/history', 'GET', undefined, patient)).body.history[0]
        .kind,
      'no_show',
    );
    assert.equal(
      (
        await api(
          pu + '/payments',
          'POST',
          pay(12000, {
            kind: 'refund',
            original_payment_id: pastPaid.body.entries[0].id,
            notes: 'Refund of no show receipt',
          }),
        )
      ).status,
      201,
    );
    assert.equal((await api(pu + '/payments')).body.appointment.refundable_paise, 0);
    const waiverRaceVisit = await booking(await slot('2099-02-04', 1, '09'));
    const wr = await Promise.all([
      api(url(waiverRaceVisit) + '/waivers', 'POST', waive(30000)),
      api(url(waiverRaceVisit) + '/waivers', 'POST', waive(30000)),
    ]);
    assert.deepEqual(wr.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await api(url(waiverRaceVisit) + '/payments', 'POST', pay(20001))).status, 409);
    // Cancellation's effective charge is zero: no goodwill refund or reduction can be appended.
    const cancelledUrl = '/admin/appointments/101';
    const cancelledIntent = pay(1000, {
      kind: 'refund',
      refund_type: 'goodwill',
      original_payment_id: 201,
      notes: 'Cancelled visit has no charge to reduce',
    });
    const cancelledBefore = (await api(cancelledUrl + '/payments')).body;
    assert.equal(cancelledBefore.appointment.effective_charge_paise, 0);
    assert.equal((await api(cancelledUrl + '/payments', 'POST', cancelledIntent)).status, 409);
    assert.deepEqual((await api(cancelledUrl + '/payments')).body, cancelledBefore);
    // Bypassing the API predicate still cannot commit a goodwill receipt without its valid reduction.
    await assert.rejects(
      run(
        "INSERT INTO payment_entries(appointment_id,kind,amount_paise,method,notes,original_payment_id,recorded_by,recorded_at,idempotency_key,refund_type) VALUES(101,'refund',1000,'cash',?,201,?,?,?,'goodwill')",
        [cancelledIntent.notes, adminId, new Date().toISOString(), randomUUID()],
      ),
    );
    assert.deepEqual((await api(cancelledUrl + '/payments')).body, cancelledBefore);
    assert.equal(
      (
        await api(cancelledUrl + '/payments', 'POST', {
          ...cancelledIntent,
          refund_type: 'correction',
          idempotency_key: randomUUID(),
        })
      ).status,
      201,
    );
    assert.equal((await api(cancelledUrl + '/payments')).body.adjustments.length, 0);

    // Race order may vary; its ledger invariants must not. Cancellation always succeeds;
    // goodwill either commits its refund+adjustment BEFORE cancellation or appends neither.
    for (let i = 1; i <= 4; i++) {
      const visit = await booking(await slot('2099-03-0' + i, 1, '09')),
        ru = url(visit);
      const receipt = (await api(ru + '/payments', 'POST', pay(10000))).body.entries[0];
      const gi = pay(2000, {
        kind: 'refund',
        refund_type: 'goodwill',
        original_payment_id: receipt.id,
        notes: 'Goodwill concurrent with cancellation',
      });
      const cancel = () =>
        api(ru + '/status', 'PATCH', {
          status: 'cancelled',
          reason: 'Clinic cancellation race test',
        });
      const refund = () => api(ru + '/payments', 'POST', gi);
      const results = await Promise.all(i % 2 ? [cancel(), refund()] : [refund(), cancel()]);
      const cr = results[i % 2 ? 0 : 1],
        gr = results[i % 2 ? 1 : 0];
      assert.equal(cr.status, 200, JSON.stringify(results));
      assert.ok([201, 409].includes(gr.status), JSON.stringify(results));
      const final = (await api(ru + '/payments')).body,
        won = gr.status === 201;
      assert.equal(final.appointment.status, 'cancelled');
      assert.equal(final.appointment.effective_charge_paise, 0);
      assert.equal(final.appointment.outstanding_paise, 0);
      assert.equal(final.entries.length, won ? 2 : 1);
      assert.equal(final.adjustments.length, won ? 1 : 0);
      assert.equal(final.appointment.paid_paise, won ? 8000 : 10000);
      assert.equal(final.appointment.refundable_paise, final.appointment.paid_paise);
      if (won) {
        assert.equal(final.adjustments[0].amount_paise, 2000);
        assert.equal(
          final.adjustments[0].payment_entry_id,
          final.entries.find((e) => e.kind === 'refund').id,
        );
      }
      assert.equal((await api(ru + '/payments', 'POST', gi)).status, won ? 200 : 409);
      assert.equal(
        (await api(ru + '/payments', 'POST', { ...gi, idempotency_key: randomUUID() })).status,
        409,
      );
      assert.deepEqual((await api(ru + '/payments')).body, final);
    }
    // Atomic one-time confirmation: two concurrent confirmations cannot both succeed.
    const confirmSlot = await slot('2099-03-06', 1, '09');
    const confirmId = (
      await run(
        "INSERT INTO appointments(patient_id,doctor_id,slot_id,fee_paise,fee_basis) VALUES(?,1,?,50000,'legacy_estimate')",
        [patientId, confirmSlot],
      )
    ).id;
    const confirmUrl = '/admin/appointments/' + confirmId;
    const confirmations = await Promise.all(
      [30000, 40000].map((fee_paise) => api(confirmUrl + '/fee', 'PATCH', { fee_paise })),
    );
    assert.deepEqual(confirmations.map((r) => r.status).sort(), [200, 409]);
    const confirmed = (await api(confirmUrl + '/payments')).body.appointment;
    assert.equal(confirmed.fee_basis, 'admin_set');
    assert.ok([30000, 40000].includes(confirmed.fee_paise));
    assert.equal((await api(confirmUrl + '/fee', 'PATCH', { fee_paise: 10000 })).status, 409);
    // Preserve all rows, payment links and schema objects over repeated migrations.
    const preserved = {
      appointments: await all('SELECT * FROM appointments ORDER BY id'),
      payments: await all('SELECT * FROM payment_entries ORDER BY id'),
      adjustments: await all('SELECT * FROM charge_adjustments ORDER BY id'),
      history: await all('SELECT * FROM appointment_history ORDER BY id'),
      schema: await all(
        "SELECT name,sql FROM sqlite_master WHERE type IN ('trigger','index') ORDER BY name",
      ),
    };
    await init();
    await init();
    assert.deepEqual(await all('SELECT * FROM appointments ORDER BY id'), preserved.appointments);
    assert.deepEqual(await all('SELECT * FROM payment_entries ORDER BY id'), preserved.payments);
    assert.deepEqual(
      await all('SELECT * FROM charge_adjustments ORDER BY id'),
      preserved.adjustments,
    );
    assert.deepEqual(await all('SELECT * FROM appointment_history ORDER BY id'), preserved.history);
    assert.deepEqual(
      await all(
        "SELECT name,sql FROM sqlite_master WHERE type IN ('trigger','index') ORDER BY name",
      ),
      preserved.schema,
    );
    assert.deepEqual(await all('PRAGMA foreign_key_check'), []);
    const report = (await api('/admin/revenue')).body;
    assert.ok(report.summary.waived_paise >= 75000);
    assert.ok(report.summary.effective_charge_paise >= 0);
    assert.ok(report.appointment_status.some((r) => r.status === 'no_show'));
    console.log(
      'Release scenarios passed: additive legacy migration, preserved custom objects and ledgers, waiver and goodwill limits/retry/rollback, ownership, stale reschedule races, interval collisions, outbox rollback, no-show arrival race, paid no-show and refund, both repeated migrations.',
    );
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await new Promise((r) => db.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
