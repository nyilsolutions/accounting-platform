import { expect, test, type Page } from '@playwright/test';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

/** Sends an API request as the signed-in user (setup that earlier tests cover). */
async function api<T>(
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  data?: unknown,
): Promise<T> {
  const res = await page.request.fetch(`/api${path}`, {
    method,
    headers: { 'x-csrf-protection': '1' },
    data,
  });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

test('time: a weekly timesheet, approval, billing the time, and a progress invoice', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Tess Timekeeper', uniqueEmail('phase10b'));
  await page.getByLabel('Legal business name').fill('Hourly Gardens');
  await page.getByLabel('Employer Identification Number (EIN)').fill('12-3456789');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Hourly Gardens' })).toBeVisible();
  const companyId = /\/c\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const c = `/companies/${companyId}`;

  // --- Setup: payroll with one hourly employee, a customer and a service ----------------------
  const accounts = await api<{ id: string; name: string }[]>(page, 'GET', `${c}/accounts`);
  const acct = (n: string) => accounts.find((a) => a.name === n)!.id;
  await api(page, 'POST', `${c}/payroll/setup`, {});
  await api(page, 'PUT', `${c}/payroll/settings`, { bankAccountId: acct('Checking') });
  const schedule = await api<{ id: string }>(page, 'POST', `${c}/payroll/schedules`, {
    name: 'Every other Friday',
    frequency: 'biweekly',
    firstPeriodEnd: '2026-01-09',
    payDateOffset: 6,
  });
  await api(page, 'POST', `${c}/payroll/employees`, {
    firstName: 'Maria',
    lastName: 'Lopez',
    workState: 'TX',
    hireDate: '2026-01-05',
    payType: 'hourly',
    payRate: '25',
    payScheduleId: schedule.id,
  });
  await api(page, 'POST', `${c}/customers`, { displayName: 'Hillside HOA' });
  await api(page, 'POST', `${c}/items`, {
    name: 'Lawn care',
    itemType: 'service',
    salesPrice: '45',
    incomeAccountId: acct('Services'),
  });

  // --- A week of time through the timesheet ------------------------------------------------------
  await page.goto(`/c/${companyId}/time`);
  await page.getByLabel('Week of').fill('2026-03-04');
  await expect(page.getByLabel('Week of')).toHaveValue('2026-03-02');
  await page.getByLabel('Row 1 customer').selectOption({ label: 'Hillside HOA' });
  await page.getByLabel('Row 1 service').selectOption({ label: 'Lawn care' });
  await page.getByLabel('Row 1 billable').check();
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu']) await page.getByLabel(`Row 1 ${day}`).fill('8');
  await page.getByLabel('Row 1 Fri').fill('7:30');
  await page.getByRole('button', { name: 'Add row' }).click();
  await page.getByLabel('Row 2 notes').fill('Shop cleanup');
  await page.getByLabel('Row 2 Mon').fill('1');
  await expect(page.getByTestId('week-total')).toHaveText('40.5 hours');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Submitted for approval.')).toBeVisible();
  await expect(page.getByTestId('timesheet')).toContainText('Waiting for approval');
  await shot(page, '104-timesheet');

  // --- Approve it ---------------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Approve time' }).click();
  const approvals = page.getByTestId('time-approvals');
  await expect(approvals.getByRole('row', { name: /Maria Lopez/ })).toContainText('40.5');
  await shot(page, '105-approve-time');
  await approvals.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/Maria Lopez's time for the week of .* was approved/)).toBeVisible();

  // --- Bill it on an invoice ----------------------------------------------------------------------
  await page.goto(`/c/${companyId}/sales/invoices/new`);
  await page.getByLabel('Customer', { exact: true }).selectOption({ label: 'Hillside HOA' });
  await page.getByRole('button', { name: 'Add billable time' }).click();
  const time = page.getByTestId('billable-time');
  await expect(time.getByRole('row')).toHaveCount(6); // header + 5 billable entries
  await page.getByRole('button', { name: 'Add 5 to the invoice' }).click();
  await page.getByRole('button', { name: 'Save and close' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${companyId}/sales$`));
  const unbilled = await api<unknown[]>(page, 'GET', `${c}/time/entries?unbilled=true`);
  expect(unbilled).toEqual([]);

  // --- A progress invoice from an estimate ------------------------------------------------------
  const customers = await api<{ id: string; displayName: string }[]>(page, 'GET', `${c}/customers`);
  const estimate = await api<{ id: string }>(page, 'POST', `${c}/estimates`, {
    customerId: customers[0]!.id,
    txnDate: '2026-03-01',
    number: 'E-7',
    lines: [
      { accountId: acct('Services'), description: 'Garden design', amount: '1000' },
      { accountId: acct('Services'), description: 'Planting', quantity: '20', rate: '50' },
    ],
  });
  await page.goto(`/c/${companyId}/sales/estimates/${estimate.id}`);
  await page.getByRole('button', { name: 'Create progress invoice' }).click();
  await page.getByLabel('Percent to invoice').fill('30');
  await page.getByLabel('Invoice date').fill('2026-03-15');
  await shot(page, '106-progress-invoice');
  await page.getByRole('button', { name: 'Create invoice' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${companyId}/sales/invoices/[0-9a-f-]{36}$`));
  await expect(page.getByText('Progress invoice 1 for estimate E-7')).toBeVisible();
  await page.goto(`/c/${companyId}/sales/estimates/${estimate.id}`);
  await expect(page.getByTestId('estimate-progress')).toContainText('Invoiced 600.00');
  await expect(page.getByTestId('estimate-progress')).toContainText('Remaining 1,400.00');

  // --- The Estimates Progress report ------------------------------------------------------------
  await page.goto(`/c/${companyId}/reports/estimates-progress?to=2026-12-31`);
  await expect(page.getByTestId('report-table').getByRole('row', { name: /E-7/ })).toContainText(
    '30.00%',
  );
});
