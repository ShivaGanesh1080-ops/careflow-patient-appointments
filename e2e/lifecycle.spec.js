const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { fixtureFile, baseURL } = require('./environment');
let fixture;
test.beforeAll(() => {
  fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
});
test.beforeEach(async ({ context, baseURL: configuredURL }) => {
  expect(configuredURL).toBe(baseURL);
  // Never allow page resources to contact a remote service during this suite.
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === baseURL ? route.continue() : route.abort();
  });
});
async function login(page, role) {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp('^' + role + ' demo', 'i') }).click();
  await expect(page.getByLabel('Email address')).toHaveValue(role.toLowerCase() + '@careflow.demo');
  await page.getByRole('button', { name: /^Sign in to Careflow/ }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
}
async function appointments(page) {
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: /Appointments/ })
    .click();
}
function card(page, reason) {
  return page.locator('article.appointment-card').filter({ hasText: reason });
}
async function save(page, button, method, endpoint) {
  const pending = page.waitForResponse(
    (r) => r.request().method() === method && new URL(r.url()).pathname === endpoint,
  );
  await button.click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function api(request, method, path, token, data) {
  // An absolute fixed loopback origin, not an environment-controlled base URL.
  return request.fetch(baseURL + '/api' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token },
    data,
  });
}
function summary(dialog, label) {
  return dialog.locator('.finance-mini-summary > div').filter({ hasText: label });
}

test('patient demo books a future slot and reschedules the same visit with history', async ({
  page,
  request,
}) => {
  await login(page, 'Patient');
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: /Find a doctor/ })
    .click();
  await page.getByRole('textbox', { name: 'Search doctors' }).fill('Fictional Browser');
  await page
    .locator('article.doctor-card')
    .filter({ hasText: 'Dr. Fictional Browser' })
    .getByRole('button', { name: /Book a visit/ })
    .click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Choose a date').fill(fixture.bookingDate);
  await dialog.getByRole('button', { name: /^10:00/ }).click();
  await dialog.getByLabel(/What brings you in/).fill('E2E browser booked visit');
  const booked = (
    await save(
      page,
      dialog.getByRole('button', { name: /^Confirm appointment/ }),
      'POST',
      '/api/appointments',
    )
  ).appointment;
  expect(booked.slot_id).toBe(fixture.bookSlot);
  const visit = card(page, 'E2E browser booked visit');
  await visit.getByRole('button', { name: 'Reschedule', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('New appointment date (IST)').fill(fixture.bookingDate);
  await dialog.getByRole('button', { name: /^11:00/ }).click();
  await dialog.getByLabel(/Reason.*required/).fill('Fictional patient needs a later time');
  const moved = (
    await save(
      page,
      dialog.getByRole('button', { name: 'Confirm reschedule', exact: true }),
      'PATCH',
      '/api/appointments/' + booked.id + '/reschedule',
    )
  ).appointment;
  expect(moved.id).toBe(booked.id);
  expect(moved.slot_id).toBe(fixture.replacementSlot);
  expect(moved.fee_paise).toBe(booked.fee_paise);
  await visit.getByRole('button', { name: 'Visit history', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Visit history');
  await expect(dialog.locator('.visit-history-entry')).toContainText(
    'Fictional patient needs a later time',
  );
  await expect(dialog.locator('.visit-history-entry')).toContainText('slot #' + fixture.bookSlot);
  await expect(dialog.locator('.visit-history-entry')).toContainText(
    'slot #' + fixture.replacementSlot,
  );
  const history = await api(
    request,
    'GET',
    '/appointments/' + booked.id + '/history',
    fixture.patientToken,
  );
  expect(history.ok()).toBeTruthy();
  expect((await history.json()).history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        old_slot_id: fixture.bookSlot,
        new_slot_id: fixture.replacementSlot,
      }),
    ]),
  );
});

test('admin demo records a fictional receipt and partial waiver with clear balances', async ({
  page,
}) => {
  await login(page, 'Admin');
  await appointments(page);
  await card(page, 'E2E finance visit').getByRole('button', { name: 'Payments / refunds' }).click();
  const dialog = page.getByRole('dialog');
  await expect(summary(dialog, 'Original charge snapshot')).toContainText('500.00');
  await dialog.getByLabel(/^Amount/).fill('200.00');
  await dialog.getByLabel('Payment method', { exact: true }).selectOption('cash');
  await dialog.getByRole('checkbox').check();
  await save(
    page,
    dialog.getByRole('button', { name: 'Record received payment', exact: true }),
    'POST',
    '/api/admin/appointments/' + fixture.financeId + '/payments',
  );
  await expect(summary(dialog, 'Net money recorded')).toContainText('200.00');
  await dialog.getByLabel('Charge reduction (INR)', { exact: true }).fill('100.00');
  await dialog.getByLabel(/Reason.*5/).fill('Fictional student-project discount');
  await save(
    page,
    dialog.getByRole('button', { name: 'Record charge reduction', exact: true }),
    'POST',
    '/api/admin/appointments/' + fixture.financeId + '/waivers',
  );
  await expect(summary(dialog, 'Original charge snapshot')).toContainText('500.00');
  await expect(summary(dialog, 'Recorded charge reductions')).toContainText('100.00');
  await expect(summary(dialog, 'Effective charge')).toContainText('400.00');
  await expect(summary(dialog, 'Outstanding')).toContainText('200.00');
  await dialog.locator('summary').filter({ hasText: 'Charge adjustment history' }).click();
  await expect(dialog.locator('.visit-history-entry')).toContainText(
    'Fictional student-project discount',
  );
  await expect(dialog).toContainText('No bank transfer');
});

test('ended unarrived no-show waives charge and exposes manual refundable excess', async ({
  page,
  request,
}) => {
  await login(page, 'Admin');
  await appointments(page);
  const visit = card(page, 'E2E unarrived past visit');
  await visit.getByRole('button', { name: 'Mark no-show', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('No refund is created or sent');
  await dialog.getByLabel(/Reason.*required/).fill('Fictional patient did not attend');
  await save(
    page,
    dialog.getByRole('button', { name: 'Confirm no-show and waive charge', exact: true }),
    'PATCH',
    '/api/admin/appointments/' + fixture.noShowId + '/no-show',
  );
  await expect(visit.locator('.status')).toHaveText('No-show');
  await expect(visit.getByRole('checkbox')).toHaveCount(0);
  await expect(visit.getByRole('button', { name: 'Complete visit' })).toHaveCount(0);
  await visit.getByRole('button', { name: 'Payments / refunds' }).click();
  dialog = page.getByRole('dialog');
  await expect(summary(dialog, 'Effective charge')).toContainText('0.00');
  await expect(summary(dialog, 'Excess refundable')).toContainText('200.00');
  const response = await api(
    request,
    'GET',
    '/admin/appointments/' + fixture.noShowId + '/payments',
    fixture.adminToken,
  );
  expect(response.ok()).toBeTruthy();
  const ledger = await response.json();
  expect(ledger.appointment.refundable_paise).toBe(20000);
  expect(ledger.entries.filter((entry) => entry.kind === 'refund')).toHaveLength(0);
});

test('future and arrived visits cannot be marked no-show in UI or API', async ({
  page,
  request,
}) => {
  await login(page, 'Admin');
  await appointments(page);
  await expect(
    card(page, 'E2E future visit').getByRole('button', { name: 'Mark no-show' }),
  ).toHaveCount(0);
  await expect(
    card(page, 'E2E arrived past visit').getByRole('button', { name: 'Mark no-show' }),
  ).toHaveCount(0);
  for (const id of [fixture.futureId, fixture.arrivedId]) {
    const response = await api(
      request,
      'PATCH',
      '/admin/appointments/' + id + '/no-show',
      fixture.adminToken,
      { reason: 'Must reject ineligible fictional visit' },
    );
    expect(response.status()).toBe(409);
  }
});
