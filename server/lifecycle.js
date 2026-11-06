const { randomUUID } = require('node:crypto');
const { run, get, all, localNow } = require('./db');
module.exports = ({ app, auth, admin, appointmentQuery, changed, kickMail }) => {
  const fail = (res, status, error) => res.status(status).json({ error });
  const reasonOK = (r) => typeof r === 'string' && r.trim().length >= 5 && r.trim().length <= 500;
  const owned = (req) =>
    get('SELECT * FROM appointments WHERE id=? AND (patient_id=? OR ?=1)', [
      req.params.id,
      req.user.id,
      req.user.role === 'admin' ? 1 : 0,
    ]);
  app.get('/api/appointments/:id/history', auth, async (req, res) => {
    if (!(await owned(req))) return fail(res, 404, 'Appointment not found.');
    res.json({
      history: await all('SELECT * FROM appointment_history WHERE appointment_id=? ORDER BY id', [
        req.params.id,
      ]),
    });
  });
  app.patch('/api/appointments/:id/reschedule', auth, async (req, res) => {
    const { slotId, reason, expected_slot_id } = req.body;
    if (
      !Number.isSafeInteger(slotId) ||
      slotId < 1 ||
      !Number.isSafeInteger(expected_slot_id) ||
      expected_slot_id < 1 ||
      !reasonOK(reason)
    )
      return fail(
        res,
        400,
        'Provide slotId, expected_slot_id and a reason between 5 and 500 characters.',
      );
    const a = await owned(req);
    if (!a) return fail(res, 404, 'Appointment not found.');
    try {
      const result = await run(
        `UPDATE appointments SET slot_id=?,change_reason=?,change_by=?,change_at=? WHERE id=? AND slot_id=? AND slot_id!=? AND status='booked' AND no_show_at IS NULL AND checked_in_at IS NULL
        AND EXISTS(SELECT 1 FROM slots old WHERE old.id=appointments.slot_id AND old.start_time>?)
        AND EXISTS(SELECT 1 FROM slots target JOIN doctors d ON d.id=target.doctor_id WHERE target.id=? AND target.doctor_id=appointments.doctor_id AND d.active=1 AND target.start_time>?
          AND NOT EXISTS(SELECT 1 FROM appointments other JOIN slots busy ON busy.id=other.slot_id WHERE other.id!=appointments.id AND other.status IN ('booked','completed') AND (other.slot_id=target.id OR (other.patient_id=appointments.patient_id AND busy.start_time<target.end_time AND busy.end_time>target.start_time) OR (other.doctor_id=appointments.doctor_id AND busy.start_time<target.end_time AND busy.end_time>target.start_time))))`,
        [
          slotId,
          reason.trim(),
          req.user.id,
          new Date().toISOString(),
          a.id,
          expected_slot_id,
          slotId,
          localNow(),
          slotId,
          localNow(),
        ],
      );
      if (!result.changes)
        return fail(
          res,
          409,
          'Appointment changed or target is unavailable. Refresh and choose a future same-doctor slot.',
        );
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT')
        return fail(res, 409, 'Appointment or target changed; original booking retained.');
      throw e;
    }
    changed('appointments', a.patient_id);
    kickMail();
    res.json({ appointment: await get(appointmentQuery + ' WHERE a.id=?', [a.id]) });
  });
  app.patch('/api/admin/appointments/:id/no-show', auth, admin, async (req, res) => {
    const { reason } = req.body;
    if (!reasonOK(reason)) return fail(res, 400, 'Provide a reason between 5 and 500 characters.');
    const a = await get('SELECT * FROM appointments WHERE id=?', [req.params.id]);
    if (!a) return fail(res, 404, 'Appointment not found.');
    const result = await run(
      `UPDATE appointments SET no_show_at=?,no_show_reason=?,no_show_by=?,no_show_key=? WHERE id=? AND status='booked' AND checked_in_at IS NULL AND no_show_at IS NULL AND EXISTS(SELECT 1 FROM slots WHERE id=appointments.slot_id AND end_time<?)`,
      [new Date().toISOString(), reason.trim(), req.user.id, randomUUID(), a.id, localNow()],
    );
    if (!result.changes)
      return fail(
        res,
        409,
        'Only unarrived booked visits after their scheduled end can be marked no-show.',
      );
    changed('appointments', a.patient_id);
    res.json({ appointment: await get(appointmentQuery + ' WHERE a.id=?', [a.id]) });
  });
};
