process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'careflow-test-'));
process.env.DATABASE_PATH = path.join(dir, 'test.sqlite');
process.env.PORT = '0';
process.env.JWT_SECRET = 'isolated-test-secret-not-for-production';
const { app, createHttpServer } = require('../index');
const { io } = require('socket.io-client');
const { processMail } = require('../mail');
process.env.SMTP_USER = '';
process.env.SMTP_APP_PASSWORD = '';
const { init, db, run, localDate } = require('../db');
let server, base, patient, admin, slot, booking;
async function api(url, method = 'GET', body, token) {
  const r = await fetch(base + '/api' + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
before(async () => {
  await init();
  await new Promise((resolve) => {
    server = createHttpServer();
    server.listen(0, '127.0.0.1', resolve);
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
test('Complete appointment lifecycle and authorization', async (t) => {
  await t.test('health endpoint', async () => {
    assert.equal((await api('/health')).body.database, 'SQLite3');
  });
  await t.test('login rejects incorrect password', async () => {
    assert.equal(
      (await api('/auth/login', 'POST', { email: 'patient@careflow.demo', password: 'wrong' }))
        .status,
      401,
    );
  });
  await t.test('patient and admin login', async () => {
    const p = await api('/auth/login', 'POST', {
      email: 'patient@careflow.demo',
      password: 'Patient123!',
    });
    const a = await api('/auth/login', 'POST', {
      email: 'admin@careflow.demo',
      password: 'Admin123!',
    });
    assert.equal(p.status, 200);
    assert.equal(a.status, 200);
    patient = p.body.token;
    admin = a.body.token;
    assert.equal(p.body.user.password_hash, undefined);
  });
  await t.test('registration and duplicate email validation', async () => {
    const b = { name: 'Test Patient', email: 'new@example.com', password: 'Password123!' };
    assert.equal((await api('/auth/register', 'POST', b)).status, 201);
    assert.equal((await api('/auth/register', 'POST', b)).status, 409);
    assert.equal((await api('/auth/register', 'POST', { ...b, email: 'bad' })).status, 400);
  });
  await t.test('protected endpoints and role boundaries', async () => {
    assert.equal((await api('/appointments')).status, 401);
    assert.equal((await api('/admin/stats', 'GET', undefined, patient)).status, 403);
    assert.equal((await api('/doctors?includeInactive=true')).status, 401);
    assert.equal(
      (await api('/doctors?includeInactive=true', 'GET', undefined, patient)).status,
      403,
    );
  });
  await t.test('find doctor and available slots', async () => {
    const doctors = await api('/doctors?search=Ananya');
    assert.equal(doctors.body.doctors.length, 1);
    let d = new Date();
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    const r = await api('/doctors/1/slots?date=' + localDate(d));
    assert.ok(r.body.slots.length > 0);
    slot = r.body.slots.find((x) => x.available);
    assert.ok(slot);
    assert.equal((await api('/doctors/1/slots?date=2026-02-31')).status, 400);
  });
  await t.test('concurrent requests cannot double book a slot', async () => {
    const rs = await Promise.all([
      api('/appointments', 'POST', { slotId: slot.id, reason: 'Routine checkup' }, patient),
      api('/appointments', 'POST', { slotId: slot.id }, patient),
    ]);
    assert.deepEqual(rs.map((x) => x.status).sort(), [201, 409]);
    booking = rs.find((x) => x.status === 201).body.appointment;
  });
  await t.test('patient cannot book overlapping doctor appointments', async () => {
    const r = await run('INSERT INTO slots(doctor_id,start_time,end_time) VALUES(?,?,?)', [
      2,
      slot.start_time.slice(0, 14) + '15:00',
      slot.end_time,
    ]);
    assert.equal((await api('/appointments', 'POST', { slotId: r.id }, patient)).status, 409);
  });
  await t.test('booked slots unavailable and history retained', async () => {
    const r = await api('/doctors/1/slots?date=' + slot.start_time.slice(0, 10));
    assert.equal(r.body.slots.find((x) => x.id === slot.id).available, false);
    assert.equal(
      (await api('/appointments', 'GET', undefined, patient)).body.appointments.length,
      1,
    );
  });
  await t.test('admin cannot complete future appointment', async () => {
    assert.equal(
      (
        await api(
          '/admin/appointments/' + booking.id + '/status',
          'PATCH',
          { status: 'completed' },
          admin,
        )
      ).status,
      409,
    );
  });
  await t.test('other patient cannot cancel another booking', async () => {
    const x = await api('/auth/login', 'POST', {
      email: 'new@example.com',
      password: 'Password123!',
    });
    assert.equal(
      (await api('/appointments/' + booking.id + '/cancel', 'PATCH', {}, x.body.token)).status,
      404,
    );
  });
  await t.test('cancellation frees slot and supports rebooking', async () => {
    assert.equal(
      (await api('/appointments/' + booking.id + '/cancel', 'PATCH', {}, patient)).status,
      200,
    );
    assert.equal(
      (await api('/appointments/' + booking.id + '/cancel', 'PATCH', {}, patient)).status,
      409,
    );
    assert.equal((await api('/appointments', 'POST', { slotId: slot.id }, patient)).status, 201);
  });
  await t.test('admin CRUD, availability and stats', async () => {
    const r = await api(
      '/admin/doctors',
      'POST',
      {
        name: 'Dr. Test',
        specialization: 'Testing',
        qualification: 'MBBS',
        bio: 'Demo',
        experience: 2,
        fee: 100,
      },
      admin,
    );
    assert.equal(r.status, 201);
    const id = r.body.doctor.id;
    let d = new Date();
    d.setDate(d.getDate() + 20);
    const schedule = {
      doctorId: id,
      date: localDate(d),
      startTime: '10:00',
      endTime: '11:00',
      intervalMinutes: 30,
    };
    assert.equal((await api('/admin/slots', 'POST', schedule, admin)).body.created, 2);
    assert.equal((await api('/admin/slots', 'POST', schedule, admin)).body.created, 0);
    assert.equal(
      (await api('/admin/doctors/' + id, 'PUT', { ...r.body.doctor, fee: 200 }, admin)).body.doctor
        .fee,
      200,
    );
    assert.equal((await api('/admin/doctors/' + id, 'DELETE', undefined, admin)).status, 200);
    assert.ok((await api('/admin/stats', 'GET', undefined, admin)).body.stats.patients >= 2);
  });
  await t.test(
    'slot count planning supports more than ten slots and validates capacity safely',
    async () => {
      const doctor = (
        await api(
          '/admin/doctors',
          'POST',
          {
            name: 'Dr. Slot Planner Test',
            specialization: 'Testing',
            qualification: 'MBBS',
            bio: 'Fictional test only',
            experience: 1,
            fee: 100,
          },
          admin,
        )
      ).body.doctor;
      const d = new Date();
      d.setDate(d.getDate() + 30);
      const schedule = {
        doctorId: doctor.id,
        date: localDate(d),
        startTime: '09:00',
        intervalMinutes: 45,
        slotCount: 12,
      };
      assert.equal((await api('/admin/slots', 'POST', schedule, patient)).status, 403);
      const created = await api('/admin/slots', 'POST', schedule, admin);
      assert.equal(created.status, 201);
      assert.deepEqual(created.body, {
        created: 12,
        planned: 12,
        skipped: 0,
        endTime: '18:00',
        unusedMinutes: 0,
      });
      const repeat = await api('/admin/slots', 'POST', schedule, admin);
      assert.equal(repeat.body.created, 0);
      assert.equal(repeat.body.skipped, 12);
      const slots = (await api('/doctors/' + doctor.id + '/slots?date=' + schedule.date)).body
        .slots;
      assert.equal(slots.length, 12);
      assert.ok(slots[11].end_time.endsWith('18:00:00'));
      const booked = await api('/appointments', 'POST', { slotId: slots[0].id }, patient);
      assert.equal(booked.status, 201);
      assert.equal(
        (await api('/admin/slots', 'POST', { ...schedule, slotCount: 2 }, admin)).body.skipped,
        2,
      );
      assert.equal(
        (await api('/appointments', 'GET', undefined, patient)).body.appointments.find(
          (a) => a.id === booked.body.appointment.id,
        ).status,
        'booked',
      );
      assert.equal(
        (await api('/appointments/' + booked.body.appointment.id + '/cancel', 'PATCH', {}, patient))
          .status,
        200,
      );
      for (const slotCount of [0, -1, 1.5, 97, '12', null])
        assert.equal(
          (await api('/admin/slots', 'POST', { ...schedule, slotCount }, admin)).status,
          400,
        );
      assert.equal(
        (
          await api(
            '/admin/slots',
            'POST',
            { ...schedule, startTime: '23:00', slotCount: 2 },
            admin,
          )
        ).status,
        400,
      );
      assert.equal(
        (await api('/admin/slots', 'POST', { ...schedule, date: '2026-02-31' }, admin)).status,
        400,
      );
      assert.equal(
        (await api('/admin/slots', 'POST', { ...schedule, startTime: '25:00' }, admin)).status,
        400,
      );
      assert.equal(
        (await api('/admin/slots', 'POST', { ...schedule, intervalMinutes: 0 }, admin)).status,
        400,
      );
      d.setDate(d.getDate() + 1);
      const range = await api(
        '/admin/slots',
        'POST',
        {
          doctorId: doctor.id,
          date: localDate(d),
          startTime: '09:00',
          endTime: '17:00',
          intervalMinutes: 45,
        },
        admin,
      );
      assert.equal(range.body.planned, 10);
      assert.equal(range.body.unusedMinutes, 30);
      assert.equal(range.body.created, 10);
      const partial = await api(
        '/admin/slots',
        'POST',
        {
          doctorId: doctor.id,
          date: localDate(d),
          startTime: '16:30',
          endTime: '18:00',
          intervalMinutes: 45,
        },
        admin,
      );
      assert.equal(partial.body.created, 2);
      assert.equal(partial.body.skipped, 0);
      const overlap = await api(
        '/admin/slots',
        'POST',
        {
          doctorId: doctor.id,
          date: localDate(d),
          startTime: '16:00',
          slotCount: 2,
          intervalMinutes: 45,
        },
        admin,
      );
      assert.equal(overlap.body.created, 0);
      assert.equal(overlap.body.skipped, 2);
    },
  );
  await t.test(
    'admin arrival checkbox persists and enables early completion without weakening permissions',
    async () => {
      const d = new Date();
      d.setDate(d.getDate() + 40);
      const date = localDate(d);
      const doctor = (
        await api(
          '/admin/doctors',
          'POST',
          {
            name: 'Dr. Attendance Test',
            specialization: 'Testing',
            qualification: 'MBBS',
            bio: 'Fictional attendance verification',
            experience: 1,
            fee: 100,
          },
          admin,
        )
      ).body.doctor;
      await api(
        '/admin/slots',
        'POST',
        { doctorId: doctor.id, date, startTime: '10:00', intervalMinutes: 30, slotCount: 2 },
        admin,
      );
      const slots = (await api('/doctors/' + doctor.id + '/slots?date=' + date)).body.slots;
      const booking = (await api('/appointments', 'POST', { slotId: slots[0].id }, patient)).body
        .appointment;
      assert.equal(booking.checked_in_at, null);
      assert.equal(booking.completed_at, null);
      const route = '/admin/appointments/' + booking.id;
      assert.equal((await api(route + '/arrival', 'PATCH', { arrived: true })).status, 401);
      assert.equal(
        (await api(route + '/arrival', 'PATCH', { arrived: true }, patient)).status,
        403,
      );
      assert.equal(
        (await api(route + '/status', 'PATCH', { status: 'completed' }, patient)).status,
        403,
      );
      assert.equal(
        (await api(route + '/arrival', 'PATCH', { arrived: 'true' }, admin)).status,
        400,
      );
      assert.equal(
        (await api(route + '/status', 'PATCH', { status: 'completed' }, admin)).status,
        409,
      );
      const arrival = (await api(route + '/arrival', 'PATCH', { arrived: true }, admin)).body
        .appointment;
      assert.ok(arrival.checked_in_at.endsWith('Z'));
      assert.ok(arrival.checked_in_by);
      assert.equal(arrival.status, 'booked');
      assert.equal(
        (await api(route + '/arrival', 'PATCH', { arrived: true }, admin)).body.appointment
          .checked_in_at,
        arrival.checked_in_at,
      );
      assert.equal(
        (await api('/appointments', 'GET', undefined, patient)).body.appointments.find(
          (a) => a.id === booking.id,
        ).checked_in_at,
        arrival.checked_in_at,
      );
      const cleared = (await api(route + '/arrival', 'PATCH', { arrived: false }, admin)).body
        .appointment;
      assert.equal(cleared.checked_in_at, null);
      assert.equal(cleared.checked_in_by, null);
      assert.equal(
        (await api(route + '/status', 'PATCH', { status: 'completed' }, admin)).status,
        409,
      );
      await api(route + '/arrival', 'PATCH', { arrived: true }, admin);
      const completed = await api(route + '/status', 'PATCH', { status: 'completed' }, admin);
      assert.equal(completed.status, 200);
      assert.equal(completed.body.appointment.status, 'completed');
      assert.ok(completed.body.appointment.completed_at.endsWith('Z'));
      assert.ok(completed.body.appointment.checked_in_at);
      assert.ok(
        new Date(completed.body.appointment.completed_at).getTime() >=
          new Date(completed.body.appointment.checked_in_at).getTime(),
      );
      assert.equal((await api(route + '/arrival', 'PATCH', { arrived: false }, admin)).status, 409);
      assert.equal(
        (await api(route + '/status', 'PATCH', { status: 'completed' }, admin)).status,
        409,
      );
      const second = (await api('/appointments', 'POST', { slotId: slots[1].id }, patient)).body
        .appointment;
      await api('/appointments/' + second.id + '/cancel', 'PATCH', {}, patient);
      assert.equal(
        (
          await api(
            '/admin/appointments/' + second.id + '/arrival',
            'PATCH',
            { arrived: true },
            admin,
          )
        ).status,
        409,
      );
      assert.equal(
        (await api('/admin/appointments/9999999/arrival', 'PATCH', { arrived: true }, admin))
          .status,
        404,
      );
      const relog = (
        await api('/auth/login', 'POST', {
          email: 'patient@careflow.demo',
          password: 'Patient123!',
        })
      ).body.token;
      assert.equal(
        (await api('/appointments', 'GET', undefined, relog)).body.appointments.find(
          (a) => a.id === booking.id,
        ).status,
        'completed',
      );
    },
  );
  await t.test('cannot deactivate doctor with upcoming bookings', async () => {
    assert.equal((await api('/admin/doctors/1', 'DELETE', undefined, admin)).status, 409);
  });
  await t.test('clinic cancellation requires a meaningful reason', async () => {
    const list = await api('/appointments', 'GET', undefined, patient);
    const a = list.body.appointments.find((x) => x.status === 'booked');
    assert.ok(a);
    assert.equal(
      (
        await api(
          '/admin/appointments/' + a.id + '/status',
          'PATCH',
          { status: 'cancelled' },
          admin,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await api(
          '/admin/appointments/' + a.id + '/status',
          'PATCH',
          { status: 'cancelled', reason: 'no' },
          admin,
        )
      ).status,
      400,
    );
  });
  await t.test(
    'authenticated realtime registration and private durable cancellation notices',
    async () => {
      const connect = (token) =>
        new Promise((resolve, reject) => {
          const socket = io(base, {
            auth: { token },
            transports: ['websocket'],
            reconnection: false,
            timeout: 10000,
          });
          const timer = setTimeout(() => {
            socket.disconnect();
            reject(Error('socket connect timed out'));
          }, 12000);
          socket.once('connect', () => {
            clearTimeout(timer);
            resolve(socket);
          });
          socket.once('connect_error', (e) => {
            clearTimeout(timer);
            socket.disconnect();
            reject(e);
          });
        });
      const other = (
        await api('/auth/login', 'POST', { email: 'new@example.com', password: 'Password123!' })
      ).body.token;
      const sockets = [];
      try {
        const [a, p, o] = await Promise.all([connect(admin), connect(patient), connect(other)]);
        sockets.push(a, p, o);
        const event = (socket, kind) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              socket.off('data:changed', handler);
              reject(Error('event timed out: ' + kind));
            }, 10000);
            const handler = (value) => {
              if (value.kind === kind) {
                clearTimeout(timer);
                socket.off('data:changed', handler);
                resolve(value);
              }
            };
            socket.on('data:changed', handler);
          });
        let otherEvents = 0;
        o.on('data:changed', () => otherEvents++);
        const registration = event(a, 'patients');
        const before = performance.now();
        assert.equal(
          (
            await api('/auth/register', 'POST', {
              name: 'Live Patient',
              email: 'live@example.com',
              password: 'Password123!',
            })
          ).status,
          201,
        );
        const delivered = await registration;
        const elapsed = performance.now() - before;
        console.log('Local registration request + event observed (ms): ' + elapsed.toFixed(1));
        assert.equal(typeof delivered.at, 'string');
        assert.equal((await api('/admin/patients', 'GET', undefined, patient)).status, 403);
        assert.ok(
          (await api('/admin/patients', 'GET', undefined, admin)).body.patients.some(
            (x) => x.email === 'live@example.com',
          ),
        );
        assert.equal(otherEvents, 0);
        const appointment = (
          await api('/appointments', 'GET', undefined, patient)
        ).body.appointments.find((x) => x.status === 'booked');
        const patientEvent = event(p, 'appointments'),
          adminEvent = event(a, 'appointments');
        const reason = 'Doctor unavailable due to an urgent clinic schedule change.';
        const response = await api(
          '/admin/appointments/' + appointment.id + '/status',
          'PATCH',
          { status: 'cancelled', reason },
          admin,
        );
        assert.equal(response.status, 200);
        assert.equal(response.body.appointment.cancellation_reason, reason);
        assert.equal(response.body.appointment.cancelled_by, 'admin');
        await Promise.all([patientEvent, adminEvent]);
        assert.equal(otherEvents, 0);
        const notices = (await api('/notifications', 'GET', undefined, patient)).body.notifications;
        assert.equal(notices.length, 1);
        assert.equal(notices[0].reason, reason);
        assert.equal(notices[0].read_at, null);
        assert.equal(
          (await api('/notifications', 'GET', undefined, other)).body.notifications.length,
          0,
        );
        assert.equal(
          (await api('/notifications/' + notices[0].id + '/read', 'PATCH', {}, other)).status,
          404,
        );
        const relog = (
          await api('/auth/login', 'POST', {
            email: 'patient@careflow.demo',
            password: 'Patient123!',
          })
        ).body.token;
        assert.equal(
          (await api('/notifications', 'GET', undefined, relog)).body.notifications[0].read_at,
          null,
        );
        assert.equal(
          (await api('/notifications/' + notices[0].id + '/read', 'PATCH', {}, relog)).status,
          200,
        );
        assert.ok(
          (await api('/notifications', 'GET', undefined, relog)).body.notifications[0].read_at,
        );
      } finally {
        sockets.forEach((x) => x.disconnect());
      }
    },
  );
  await t.test('invalid websocket token is rejected', async () => {
    await new Promise((resolve, reject) => {
      const socket = io(base, {
        auth: { token: 'invalid' },
        transports: ['websocket'],
        reconnection: false,
        timeout: 5000,
      });
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(Error('missing auth rejection'));
      }, 8000);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.disconnect();
        reject(Error('unauthorized socket connected'));
      });
      socket.once('connect_error', () => {
        clearTimeout(timer);
        socket.disconnect();
        resolve();
      });
    });
  });
  await t.test(
    'email outbox supports simulated delivery and bounded retries without sending real email',
    async () => {
      const sent = [];
      await processMail({
        sendMail: async (mail) => {
          sent.push(mail);
          return { accepted: [mail.to] };
        },
      });
      assert.equal(sent.length, 1);
      assert.ok(sent[0].text.includes('urgent clinic'));
      assert.equal(
        (await api('/notifications', 'GET', undefined, patient)).body.notifications[0].email_status,
        'sent',
      );
      const booking = await api('/appointments', 'POST', { slotId: slot.id }, patient);
      assert.equal(booking.status, 201);
      assert.equal(
        (
          await api(
            '/admin/appointments/' + booking.body.appointment.id + '/status',
            'PATCH',
            { status: 'cancelled', reason: 'Clinic is closed for urgent maintenance.' },
            admin,
          )
        ).status,
        200,
      );
      const failure = {
        sendMail: async () => {
          const e = new Error('fake provider failure');
          e.code = 'ETIMEDOUT';
          throw e;
        },
      };
      for (let n = 0; n < 5; n++) {
        await run(
          "UPDATE email_jobs SET next_attempt_at=datetime('now','-1 minute') WHERE sent_at IS NULL",
        );
        await processMail(failure);
      }
      const latest = (await api('/notifications', 'GET', undefined, patient)).body.notifications[0];
      assert.equal(latest.email_status, 'failed');
      await api('/notifications/read-all', 'PATCH', {}, patient);
      assert.ok(
        (await api('/notifications', 'GET', undefined, patient)).body.notifications.every(
          (x) => x.read_at,
        ),
      );
    },
  );
});
