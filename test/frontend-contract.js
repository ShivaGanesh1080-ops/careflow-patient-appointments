const fs = require('fs'),
  vm = require('vm'),
  assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '..');
const ts = require(root + '/client/node_modules/typescript');
const calls = [];
let response, failure;
const api = Object.fromEntries(
  ['get', 'post', 'patch'].map((method) => [
    method,
    (path, body) => {
      calls.push({ method, path, body });
      return failure ? Promise.reject(failure) : Promise.resolve(response);
    },
  ]),
);
const signal = (value) => {
  const f = () => value;
  f.set = (v) => (value = v);
  f.update = (fn) => (value = fn(value));
  return f;
};
class HttpErrorResponse extends Error {
  constructor(error) {
    super();
    this.error = error;
    this.status = 400;
  }
}
function load(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
    },
  }).outputText;
  const req = (name) => {
    if (name === '@angular/core') return { Component: () => (c) => c, inject: () => api, signal };
    if (name === '@angular/common' || name === '@angular/forms') return {};
    if (name === '@angular/common/http') return { HttpErrorResponse };
    if (name === 'rxjs') return { firstValueFrom: (v) => v };
    if (name === './clinic-time') return load(root + '/client/src/app/clinic-time.ts');
    return {};
  };
  vm.runInNewContext(
    code,
    {
      module,
      exports: module.exports,
      require: req,
      console,
      Date,
      Intl,
      Math,
      Number,
      String,
      JSON,
      crypto: require('node:crypto').webcrypto,
      setTimeout,
      clearTimeout,
      document: {},
      requestAnimationFrame: () => {},
    },
    { filename: file },
  );
  return module.exports;
}
const { AppComponent } = load(root + '/client/src/app/app.component.ts');
const app = new AppComponent();
app.focusDialog = () => {};
app.restoreFocus = () => {};
app.tryShowCancellationNotice = () => {};
app.refresh = async () => {};
const a = {
  id: 7,
  doctor_id: 2,
  slot_id: 14,
  status: 'booked',
  start_time: '2099-11-07T10:00:00+05:30',
  end_time: '2099-11-07T10:30:00+05:30',
  fee_paise: 10000,
  paid_paise: 8000,
  effective_charge_paise: 7000,
  waived_paise: 3000,
  outstanding_paise: 0,
  refundable_paise: 1000,
};
let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log('PASS', name);
};
(async () => {
  check('money parser rejects unsafe/coerced amounts', () => {
    for (const s of ['', '-1', '1e3', '0x20', '1.234', 'NaN', 'Infinity'])
      assert.equal(app.paise(s), null);
    assert.equal(app.paise('10.25'), 1025);
  });
  check('server financial fields and fallback cancellation', () => {
    assert.equal(app.effectiveCharge(a), 7000);
    assert.equal(app.outstanding(a), 0);
    assert.equal(app.refundable(a), 1000);
    assert.equal(
      app.effectiveCharge({ ...a, status: 'cancelled', effective_charge_paise: undefined }),
      0,
    );
  });
  check('eligibility excludes arrived and terminal visits', () => {
    assert.equal(app.canReschedule(a), true);
    for (const status of ['cancelled', 'completed', 'no_show']) {
      assert.equal(app.canReschedule({ ...a, status }), false);
      assert.equal(app.isUpcoming({ ...a, status }), false);
      assert.equal(app.canComplete({ ...a, status, checked_in_at: '2026-11-01T00:00:00Z' }), false);
    }
    assert.equal(app.canReschedule({ ...a, checked_in_at: 'x' }), false);
  });
  app.user.set({ role: 'admin' });
  check('no-show only after end and unarrived', () => {
    assert.equal(app.canNoShow(a), false);
    assert.equal(app.canNoShow({ ...a, end_time: '2020-01-01T10:00:00+05:30' }), true);
    assert.equal(
      app.canNoShow({ ...a, end_time: '2020-01-01T10:00:00+05:30', checked_in_at: 'x' }),
      false,
    );
  });
  app.paymentTarget.set(a);
  app.paymentDetails.set({
    appointment: a,
    entries: [{ id: 3, kind: 'payment', method: 'upi', refundable_paise: 8000 }],
  });
  app.paymentKind = 'refund';
  app.refundPaymentId = 3;
  app.paymentAmount = '30';
  app.paymentNotes = 'Service discount';
  app.paymentConfirmed = true;
  app.refundType = 'goodwill';
  check('goodwill refund limited by charge and original receipt', () => {
    assert.equal(app.paymentLimit, 7000);
    assert.equal(app.paymentFormValid, true);
    app.paymentAmount = '75';
    assert.equal(app.paymentFormValid, false);
    app.paymentAmount = '30';
  });
  failure = new HttpErrorResponse({ error: 'temporary problem' });
  await app.recordPayment();
  const first = calls.at(-1);
  check('refund errors preserve form and clear busy', () => {
    assert.equal(app.busy(), false);
    assert.equal(app.paymentAmount, '30');
    assert.equal(app.paymentError(), 'temporary problem');
    assert.equal(first.body.refund_type, 'goodwill');
    assert.equal(first.body.method, 'upi');
    assert.equal(first.body.original_payment_id, 3);
  });
  await app.recordPayment();
  check('refund retry reuses UUID key', () => {
    assert.equal(calls.at(-1).body.idempotency_key, first.body.idempotency_key);
    assert.match(first.body.idempotency_key, /^[0-9a-f-]{36}$/);
  });
  failure = undefined;
  response = { appointment: a, entries: [] };
  await app.recordPayment();
  check('successful refund clears intent and form', () => {
    assert.equal(app.paymentAmount, '');
    assert.equal(app.paymentIntent, null);
    assert.equal(app.busy(), false);
  });
  app.waiverAmount = '20';
  app.waiverReason = 'Partial consultation waiver';
  failure = new HttpErrorResponse({ error: 'try again' });
  await app.recordWaiver();
  const waiver = calls.at(-1);
  await app.recordWaiver();
  check('waiver retry retains UUID and reason without mutating snapshot', () => {
    assert.equal(calls.at(-1).body.idempotency_key, waiver.body.idempotency_key);
    assert.equal(waiver.body.amount_paise, 2000);
    assert.equal(app.paymentTarget().fee_paise, 10000);
    assert.equal(app.busy(), false);
    assert.equal(app.waiverAmount, '20');
  });
  app.paymentTarget.set(null);
  app.visitTarget.set(a);
  app.visitAction = 'reschedule';
  app.visitReason = 'Need a different appointment time';
  const slot = { id: 55, doctor_id: 2, start_time: '2099-11-08T10:00:00+05:30', available: 1 };
  app.selectedSlot.set(slot);
  await app.confirmVisitAction();
  const res = calls.at(-1);
  check('reschedule sends optimistic slot and preserves original on failure', () => {
    assert.equal(res.path, '/appointments/7/reschedule');
    assert.equal(res.body.expected_slot_id, 14);
    assert.equal(res.body.slotId, 55);
    assert.equal(app.visitTarget().slot_id, 14);
    assert.equal(app.selectedSlot().id, 55);
    assert.equal(app.busy(), false);
  });
  failure = undefined;
  response = { appointment: { ...a, slot_id: 55 } };
  await app.confirmVisitAction();
  check('successful reschedule closes dialog without money request', () => {
    assert.equal(app.visitTarget(), null);
    assert.equal(calls.at(-1).path, '/appointments/7/reschedule');
    assert.equal(app.busy(), false);
  });
  app.visitTarget.set({ ...a, end_time: '2020-01-01T10:00:00+05:30' });
  app.visitAction = 'no_show';
  app.visitReason = 'Patient did not attend';
  await app.confirmVisitAction();
  check('no-show sends explicit reason without financial entries', () => {
    assert.equal(calls.at(-1).path, '/admin/appointments/7/no-show');
    assert.equal(calls.at(-1).body.reason, 'Patient did not attend');
    assert.equal(app.visitTarget(), null);
    assert.equal(app.busy(), false);
  });
  console.log(`${passed} isolated frontend checks passed`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
