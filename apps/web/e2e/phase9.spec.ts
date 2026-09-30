import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

/** Sends an API request as the signed-in user (setup the earlier payroll tests already cover). */
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

test('tax forms: enter prior payroll, check the quarter and the W-2s, mark a Form 941 filed', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Fran Forms', uniqueEmail('phase9'));
  await page.getByLabel('Legal business name').fill('Prairie Forms Co');
  await page.getByLabel('Employer Identification Number (EIN)').fill('12-3456789');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Prairie Forms Co' })).toBeVisible();
  const companyId = /\/c\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const p = `/companies/${companyId}/payroll`;

  // --- Setup through the API: an Illinois company that started payroll here on April 1, 2026.
  await api(page, 'PATCH', `/companies/${companyId}`, {
    addressLine1: '100 Main St',
    city: 'Springfield',
    state: 'IL',
    postalCode: '62701',
  });
  const accounts = await api<{ id: string; name: string }[]>(
    page,
    'GET',
    `/companies/${companyId}/accounts`,
  );
  await api(page, 'POST', `${p}/setup`, {});
  await api(page, 'PUT', `${p}/settings`, {
    payrollStartDate: '2026-04-01',
    bankAccountId: accounts.find((a) => a.name === 'Checking')!.id,
  });
  const schedule = await api<{ id: string }>(page, 'POST', `${p}/schedules`, {
    name: 'Every other Friday',
    frequency: 'biweekly',
    firstPeriodEnd: '2026-04-03',
    payDateOffset: 6,
  });
  const il = await api<{ id: string }>(page, 'POST', `${p}/states`, {
    state: 'IL',
    withholdingAccountNumber: '1234-5678',
  });
  await api(page, 'PUT', `${p}/states/${il.id}/unemployment-rates`, { year: 2026, rate: '3.525' });
  const ana = await api<{ id: string }>(page, 'POST', `${p}/employees`, {
    firstName: 'Ana',
    lastName: 'Ruiz',
    ssn: '123-45-6789',
    addressLine1: '12 Elm St',
    city: 'Springfield',
    state: 'IL',
    postalCode: '62701',
    workState: 'IL',
    hireDate: '2025-06-01',
    payType: 'hourly',
    payRate: '25',
    defaultHours: '80',
    payScheduleId: schedule.id,
  });
  await api(page, 'POST', `${p}/employees/${ana.id}/w4`, {
    formVersion: '2020',
    effectiveFrom: '2025-06-01',
    filingStatus: 'single',
  });

  // --- Prior payroll: Ana's first quarter from the old payroll service ------------------------
  await page.goto(`/c/${companyId}/payroll/forms/prior`);
  await page.getByRole('button', { name: 'Add prior payroll' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Employee').selectOption({ label: 'Ana Ruiz' });
  await dialog.getByLabel('Pay date').fill('2026-03-27');
  await dialog.getByLabel('Item 1', { exact: true }).selectOption({ label: 'Hourly wage' });
  await dialog.getByLabel('Item 1 amount').fill('6000');
  const taxes: [string, string][] = [
    ['6000', '500'],
    ['6000', '372'],
    ['6000', '372'],
    ['6000', '87'],
    ['6000', '87'],
    ['6000', '36'],
  ];
  for (const [i, [wages, amount]] of taxes.entries()) {
    await dialog.getByLabel(`Tax ${i + 1} taxable wages`).fill(wages);
    await dialog.getByLabel(`Tax ${i + 1} amount`).fill(amount);
  }
  await dialog.getByRole('button', { name: 'Add tax' }).click();
  await dialog.getByLabel('Tax 7 state').selectOption('IL');
  await dialog.getByLabel('Tax 7 taxable wages').fill('6000');
  await dialog.getByLabel('Tax 7 amount').fill('297');
  await dialog.getByRole('button', { name: 'Add tax' }).click();
  await dialog.getByLabel('Tax 8', { exact: true }).selectOption('state_unemployment');
  await dialog.getByLabel('Tax 8 state').selectOption('IL');
  await dialog.getByLabel('Tax 8 taxable wages').fill('6000');
  await dialog.getByLabel('Tax 8 amount').fill('211.50');
  await dialog.getByRole('button', { name: 'Save prior payroll' }).click();
  await expect(dialog).toHaveCount(0);
  const prior = page.getByTestId('prior-payroll');
  await expect(prior.getByRole('row', { name: /Ana Ruiz/ })).toContainText('$6,000.00');

  // The old service's Form 941 deposit for March, paid after the switch.
  const deposits = page.getByTestId('prior-deposits');
  await deposits.getByRole('button', { name: 'Add deposit' }).click();
  const depositDialog = page.getByRole('dialog');
  await depositDialog.getByLabel('Payment date').fill('2026-04-15');
  await depositDialog.getByLabel('Amount').fill('918');
  await depositDialog.getByRole('button', { name: 'Save deposit' }).click();
  await expect(depositDialog).toHaveCount(0);
  await expect(deposits.getByRole('row', { name: /Form 941 taxes/ })).toContainText('$918.00');

  // --- The first payroll here --------------------------------------------------------------
  const run = await api<{ id: string }>(page, 'POST', `${p}/pay-runs`, {
    kind: 'regular',
    payScheduleId: schedule.id,
  });
  await api(page, 'POST', `${p}/pay-runs/${run.id}/approve`);
  await api(page, 'POST', `${p}/pay-runs/${run.id}/post`, {});

  // --- Quarterly: the first quarter is all prior payroll ------------------------------------
  await page
    .getByRole('navigation', { name: 'Tax forms' })
    .getByRole('link', { name: 'Quarterly' })
    .click();
  await page.getByLabel('Year').selectOption('2026');
  await page.getByLabel('Quarter').selectOption('1');
  const federal = page.getByTestId('federal-quarter');
  await expect(federal).toContainText('Federal quarterly summary (Form 941), Q1 2026');
  await expect(federal).toContainText('$6,000.00');
  await expect(federal).toContainText('$1,418.00');
  await expect(
    federal.locator('div', { has: page.getByText('Balance due', { exact: true }) }).last(),
  ).toContainText('$500.00');
  const ilQuarter = page.getByTestId('state-quarter-IL');
  await expect(ilQuarter.getByRole('table', { name: 'IL withholding' })).toContainText('$297.00');
  await expect(ilQuarter.getByRole('table', { name: 'IL unemployment wages' })).toContainText(
    '***-**-6789',
  );

  // The wage detail for the state has full SSNs.
  const download = page.waitForEvent('download');
  await ilQuarter.getByRole('button', { name: 'Wage detail (CSV)' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('il-wages-2026-q1.csv');
  expect(readFileSync((await file.path())!, 'utf8')).toMatch(/Ana Ruiz,6000\.00,0\.00,6000\.00/);

  // Mark Form 941 filed.
  await federal.getByRole('button', { name: 'Mark filed' }).click();
  const fileDialog = page.getByRole('dialog');
  await fileDialog.getByLabel('Filed on').fill('2026-04-28');
  await fileDialog.getByLabel('Confirmation number').fill('EFILE-941-Q1');
  await fileDialog.getByRole('button', { name: 'Mark filed' }).click();
  await expect(federal.getByTestId('filing-form_941')).toContainText('EFILE-941-Q1');
  await shot(page, '90-quarterly-forms');

  // --- Year end: the W-2 adds prior payroll and the paycheck posted here ----------------------
  await page
    .getByRole('navigation', { name: 'Tax forms' })
    .getByRole('link', { name: 'Year end' })
    .click();
  await page.getByLabel('Year').selectOption('2026');
  const w2 = page.getByTestId('w2-forms');
  const anaRow = w2
    .getByRole('table', { name: 'Forms W-2' })
    .getByRole('row', { name: /Ana Ruiz/ });
  await expect(anaRow).toContainText('$8,000.00');
  await expect(anaRow).toContainText('Ready');
  await expect(w2).toContainText('Q1');
  await expect(page.getByTestId('futa-annual')).toContainText('$7,000.00');
  await shot(page, '91-w2-forms');

  // Prior payroll in the filed quarter is locked.
  await page
    .getByRole('navigation', { name: 'Tax forms' })
    .getByRole('link', { name: 'Prior payroll' })
    .click();
  await expect(prior.getByRole('row', { name: /Ana Ruiz/ })).toContainText(
    'Form 941 for Q1 2026 filed',
  );
  await expect(deposits.getByRole('row', { name: /Form 941 taxes/ })).toContainText(
    'Form 941 for Q1 2026 filed',
  );
  await shot(page, '92-prior-payroll');
});
