// Manual accounting records only. These entries do not move money or verify bank settlement.
const express = require('express');
const { run, get, all, localDate } = require('./db');
const { waived, effective } = require('./release-schema');
const net =
  "COALESCE((SELECT SUM(CASE WHEN p.kind='payment' THEN p.amount_paise ELSE -p.amount_paise END) FROM payment_entries p WHERE p.appointment_id=a.id),0)";
const entryQuery = `SELECT p.*, CASE WHEN p.kind='payment' THEN p.amount_paise-COALESCE((SELECT SUM(r.amount_paise) FROM payment_entries r WHERE r.original_payment_id=p.id),0) ELSE 0 END AS refundable_paise FROM payment_entries p`;
const validAmount = (n, min = 1) =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= 10000000;
const { validDate, shiftDate: shift } = require('./clinic-time');
module.exports = ({ appointmentQuery, changed }) => {
  const router = express.Router();
  const fail = (res, status, error) => res.status(status).json({ error });
  async function details(id) {
    return {
      appointment: await get(appointmentQuery + ' WHERE a.id=?', [id]),
      adjustments: await all(
        'SELECT * FROM charge_adjustments WHERE appointment_id=? ORDER BY id DESC',
        [id],
      ),
      entries: await all(entryQuery + ' WHERE p.appointment_id=? ORDER BY p.id DESC', [id]),
    };
  }
  router.get('/appointments/:id/payments', async (req, res) => {
    const result = await details(req.params.id);
    if (!result.appointment) return fail(res, 404, 'Appointment not found.');
    res.json(result);
  });
  router.patch('/appointments/:id/fee', async (req, res) => {
    if (!validAmount(req.body.fee_paise, 0))
      return fail(res, 400, 'Fee must be integer paise between 0 and 10000000.');
    const result = await run(
      "UPDATE appointments SET fee_paise=?,fee_basis='admin_set' WHERE id=? AND fee_basis='legacy_estimate' AND no_show_at IS NULL AND NOT EXISTS(SELECT 1 FROM payment_entries WHERE appointment_id=appointments.id) AND NOT EXISTS(SELECT 1 FROM charge_adjustments WHERE appointment_id=appointments.id)",
      [req.body.fee_paise, req.params.id],
    );
    if (!result.changes)
      return fail(
        res,
        (await get('SELECT id FROM appointments WHERE id=?', [req.params.id])) ? 409 : 404,
        'Only an untouched legacy estimate can be confirmed once, before any ledger entry or no-show.',
      );
    const data = await details(req.params.id);
    changed('payments', data.appointment.patient_id);
    res.json(data);
  });
  router.post('/appointments/:id/waivers', async (req, res) => {
    const { amount_paise, reason, idempotency_key } = req.body;
    if (
      !validAmount(amount_paise) ||
      typeof reason !== 'string' ||
      reason.trim().length < 5 ||
      reason.trim().length > 500 ||
      typeof idempotency_key !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        idempotency_key,
      )
    )
      return fail(
        res,
        400,
        'Provide integer paise, a UUID key and a reason between 5 and 500 characters.',
      );
    const a = await get('SELECT id,patient_id FROM appointments WHERE id=?', [req.params.id]);
    if (!a) return fail(res, 404, 'Appointment not found.');
    const key = idempotency_key.toLowerCase();
    async function duplicate() {
      const row = await get('SELECT * FROM charge_adjustments WHERE idempotency_key=?', [key]);
      if (!row) return false;
      if (
        row.appointment_id !== a.id ||
        row.amount_paise !== amount_paise ||
        row.reason !== reason.trim() ||
        row.recorded_by !== req.user.id ||
        row.kind !== 'waiver'
      )
        fail(res, 409, 'Key already used for another adjustment.');
      else res.json(await details(a.id));
      return true;
    }
    if (await duplicate()) return;
    try {
      const r = await run(
        "INSERT INTO charge_adjustments(appointment_id,amount_paise,reason,recorded_by,recorded_at,kind,idempotency_key) SELECT a.id,?,?,?,?, 'waiver',? FROM appointments a WHERE a.id=? AND a.status!='cancelled' AND a.no_show_at IS NULL AND ?<=a.fee_paise-" +
          waived,
        [
          amount_paise,
          reason.trim(),
          req.user.id,
          new Date().toISOString(),
          key,
          a.id,
          amount_paise,
        ],
      );
      if (!r.changes) {
        if (await duplicate()) return;
        return fail(res, 409, 'Waiver exceeds remaining charge or visit has no charge.');
      }
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT') {
        if (await duplicate()) return;
        return fail(res, 409, 'Charge changed; refresh and retry.');
      }
      throw e;
    }
    changed('payments', a.patient_id);
    res.status(201).json(await details(a.id));
  });
  router.post('/appointments/:id/payments', async (req, res) => {
    const {
      kind,
      refund_type = 'correction',
      amount_paise,
      method,
      reference = '',
      notes = '',
      original_payment_id,
      idempotency_key,
    } = req.body;
    if (
      !['payment', 'refund'].includes(kind) ||
      !['correction', 'goodwill'].includes(refund_type) ||
      (kind === 'payment' && refund_type !== 'correction') ||
      !validAmount(amount_paise) ||
      !['cash', 'upi', 'card', 'bank'].includes(method) ||
      typeof reference !== 'string' ||
      reference.length > 120 ||
      typeof notes !== 'string' ||
      notes.length > 500 ||
      typeof idempotency_key !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        idempotency_key,
      )
    )
      return fail(
        res,
        400,
        'Enter a valid kind, integer paise amount (1â€“10000000), method, UUID key, reference (up to 120) and notes (up to 500).',
      );
    if (
      kind === 'refund' &&
      (!Number.isSafeInteger(original_payment_id) ||
        original_payment_id < 1 ||
        notes.trim().length < 5)
    )
      return fail(
        res,
        400,
        'Refunds require an original payment and notes of at least 5 characters.',
      );
    if (kind === 'payment' && original_payment_id != null)
      return fail(res, 400, 'Payments cannot reference an original payment.');
    const a = await get('SELECT id,patient_id FROM appointments WHERE id=?', [req.params.id]);
    if (!a) return fail(res, 404, 'Appointment not found.');
    const original =
      kind === 'refund'
        ? await get(
            "SELECT * FROM payment_entries WHERE id=? AND appointment_id=? AND kind='payment'",
            [original_payment_id, a.id],
          )
        : null;
    if (kind === 'refund' && (!original || method !== original.method))
      return fail(
        res,
        400,
        'Refund must reference a payment on this appointment and use its original method.',
      );
    const key = idempotency_key.toLowerCase(),
      ref = reference.trim(),
      note = notes.trim(),
      originalId = kind === 'refund' ? original_payment_id : null;
    const same = (p) =>
      p.appointment_id === a.id &&
      p.kind === kind &&
      p.amount_paise === amount_paise &&
      p.method === method &&
      p.reference === ref &&
      p.notes === note &&
      p.original_payment_id === originalId &&
      p.recorded_by === req.user.id &&
      p.refund_type === refund_type;
    async function duplicate() {
      const previous = await get('SELECT * FROM payment_entries WHERE idempotency_key=?', [key]);
      if (!previous) return false;
      if (!same(previous))
        fail(res, 409, 'This idempotency key was already used for a different entry.');
      else res.status(200).json(await details(a.id));
      return true;
    }
    if (await duplicate()) return;
    let result;
    try {
      // The balance/status check and insert are ONE statement: concurrent requests cannot both spend the same capacity.
      result = await run(
        `INSERT INTO payment_entries(appointment_id,kind,amount_paise,method,reference,notes,original_payment_id,recorded_by,recorded_at,idempotency_key,refund_type)
     SELECT a.id,?,?,?,?,?,?,?,?,?,? FROM appointments a WHERE a.id=? AND ${kind === 'payment' ? `a.status!='cancelled' AND a.no_show_at IS NULL AND ?<=${effective}-${net}` : `EXISTS(SELECT 1 FROM payment_entries o WHERE o.id=? AND o.appointment_id=a.id AND o.kind='payment' AND o.method=? AND ?<=o.amount_paise-COALESCE((SELECT SUM(r.amount_paise) FROM payment_entries r WHERE r.original_payment_id=o.id),0)) AND (?='correction' OR ?<=${effective})`}`,
        [
          kind,
          amount_paise,
          method,
          ref,
          note,
          originalId,
          req.user.id,
          new Date().toISOString(),
          key,
          refund_type,
          a.id,
          ...(kind === 'payment'
            ? [amount_paise]
            : [originalId, method, amount_paise, refund_type, amount_paise]),
        ],
      );
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT') {
        if (await duplicate()) return;
        return fail(res, 409, 'Financial capacity changed; nothing recorded.');
      }
      throw error;
    }
    if (!result.changes) {
      if (await duplicate()) return;
      return fail(
        res,
        409,
        'Payment exceeds the outstanding fee or visit is cancelled; refund exceeds the original receipt remaining balance.',
      );
    }
    changed('payments', a.patient_id);
    res.status(201).json(await details(a.id));
  });
  router.get('/revenue', async (req, res) => {
    // Clinic date defaults explicitly to IST rather than the host machine timezone.
    const today = localDate();
    const to = req.query.to === undefined ? today : req.query.to;
    const from =
      req.query.from === undefined ? (validDate(to) ? shift(to, -29) : '') : req.query.from;
    if (
      !validDate(from) ||
      !validDate(to) ||
      from > to ||
      (Date.parse(to) - Date.parse(from)) / 86400000 >= 366
    )
      return fail(res, 400, 'Choose valid ordered dates spanning no more than 366 days.');
    const where = "date(p.recorded_at,'+330 minutes') BETWEEN ? AND ?",
      args = [from, to];
    const sums =
      "COALESCE(SUM(CASE WHEN p.kind='payment' THEN p.amount_paise ELSE 0 END),0) AS payments_paise,COALESCE(SUM(CASE WHEN p.kind='refund' THEN p.amount_paise ELSE 0 END),0) AS refunds_paise,COALESCE(SUM(CASE WHEN p.kind='payment' THEN p.amount_paise ELSE -p.amount_paise END),0) AS net_paise";
    const totals = await get(
      `SELECT ${sums},COUNT(*) AS transaction_count FROM payment_entries p WHERE ${where}`,
      args,
    );
    const balances = await get(
      `SELECT COALESCE(SUM(CASE WHEN a.status IN ('booked','completed') THEN MAX(${effective}-${net},0) ELSE 0 END),0) AS outstanding_paise,COALESCE(SUM(CASE WHEN a.status='cancelled' THEN ${net} ELSE 0 END),0) AS cancelled_balance_paise,COALESCE(SUM(${waived}),0) AS waived_paise,COALESCE(SUM(${effective}),0) AS effective_charge_paise,COALESCE(SUM(MAX(${net}-${effective},0)),0) AS refundable_paise,COALESCE(SUM(CASE WHEN a.fee_basis='legacy_estimate' THEN ${effective} ELSE 0 END),0) AS estimated_charge_paise,COALESCE(SUM(CASE WHEN a.fee_basis!='legacy_estimate' THEN ${effective} ELSE 0 END),0) AS confirmed_charge_paise FROM appointments a`,
    );
    const rows = await all(
      `SELECT date(p.recorded_at,'+330 minutes') AS date,${sums} FROM payment_entries p WHERE ${where} GROUP BY date(p.recorded_at,'+330 minutes') ORDER BY date`,
      args,
    );
    const map = new Map(rows.map((r) => [r.date, r])),
      daily = [];
    for (let date = from; date <= to; date = shift(date, 1))
      daily.push(map.get(date) || { date, payments_paise: 0, refunds_paise: 0, net_paise: 0 });
    const by_doctor = await all(
      `SELECT d.id AS doctor_id,d.name AS doctor_name,${sums} FROM payment_entries p JOIN appointments a ON a.id=p.appointment_id JOIN doctors d ON d.id=a.doctor_id WHERE ${where} GROUP BY d.id ORDER BY d.id`,
      args,
    );
    const methods = await all(
      `SELECT p.method,${sums} FROM payment_entries p WHERE ${where} GROUP BY p.method`,
      args,
    );
    const by_method = ['cash', 'upi', 'card', 'bank'].map(
      (method) =>
        methods.find((m) => m.method === method) || {
          method,
          payments_paise: 0,
          refunds_paise: 0,
          net_paise: 0,
        },
    );
    const statusRows = await all(
      "SELECT CASE WHEN a.no_show_at IS NOT NULL THEN 'no_show' ELSE a.status END AS status,COUNT(*) AS count FROM appointments a JOIN slots s ON s.id=a.slot_id WHERE substr(s.start_time,1,10) BETWEEN ? AND ? GROUP BY CASE WHEN a.no_show_at IS NOT NULL THEN 'no_show' ELSE a.status END",
      args,
    );
    const appointment_status = ['booked', 'completed', 'cancelled', 'no_show'].map(
      (status) => statusRows.find((r) => r.status === status) || { status, count: 0 },
    );
    const recent = await all(
      `SELECT e.*,d.name AS doctor_name,u.name AS patient_name FROM (${entryQuery}) e JOIN appointments a ON a.id=e.appointment_id JOIN doctors d ON d.id=a.doctor_id JOIN users u ON u.id=a.patient_id WHERE date(e.recorded_at,'+330 minutes') BETWEEN ? AND ? ORDER BY e.recorded_at DESC,e.id DESC LIMIT 100`,
      args,
    );
    res.json({
      from,
      to,
      timezone: 'Asia/Kolkata',
      summary: {
        gross_paise: totals.payments_paise,
        refunds_paise: totals.refunds_paise,
        net_paise: totals.net_paise,
        transaction_count: totals.transaction_count,
        ...balances,
      },
      daily,
      by_doctor,
      by_method,
      appointment_status,
      recent,
    });
  });
  return router;
};
