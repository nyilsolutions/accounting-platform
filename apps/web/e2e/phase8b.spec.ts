import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

/** Sends an API request as the signed-in user (setup that Phase 8 part 1's test already covers). */
async function api<T>(
  page: Page,
  method: 'GET' | 'POST' | 'PUT',
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

test('run payroll: fix a paycheck, approve, post, deposit file, pay stub, pay the IRS, reports', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Rita Runner', uniqueEmail('phase8b'));
  await page.getByLabel('Legal business name').fill('Lone Star Lawns');
  await page.getByLabel('Employer Identification Number (EIN)').fill('12-3456789');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Lone Star Lawns' })).toBeVisible();
  const companyId = /\/c\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const p = `/companies/${companyId}/payroll`;

  // --- Setup through the API: payroll starting January 2026, Texas and Florida, two employees.
  const accounts = await api<{ id: string; name: string }[]>(
    page,
    'GET',
    `/companies/${companyId}/accounts`,
  );
  const checking = accounts.find((a) => a.name === 'Checking')!.id;
  await api(page, 'POST', `${p}/setup`, {});
  await api(page, 'PUT', `${p}/settings`, {
    payrollStartDate: '2026-01-01',
    bankAccountId: checking,
    achOdfiRouting: '021000021',
    achOdfiName: 'First Example Bank',
    achCompanyName: 'Lone Star Lawns',
  });
  const schedule = await api<{ id: string }>(page, 'POST', `${p}/schedules`, {
    name: 'Every other Friday',
    frequency: 'biweekly',
    firstPeriodEnd: '2026-01-09',
    payDateOffset: 6,
  });
  for (const state of ['TX', 'FL']) {
    const reg = await api<{ id: string }>(page, 'POST', `${p}/states`, { state });
    await api(page, 'PUT', `${p}/states/${reg.id}/unemployment-rates`, { year: 2026, rate: '2.7' });
  }
  const k401 = await api<{ id: string }>(page, 'POST', `${p}/items`, {
    name: '401(k)',
    kind: 'traditional_401k',
  });
  const maria = await api<{ id: string }>(page, 'POST', `${p}/employees`, {
    firstName: 'Maria',
    lastName: 'Lopez',
    ssn: '123-45-6789',
    workState: 'TX',
    hireDate: '2025-04-01',
    payType: 'hourly',
    payRate: '24.50',
    defaultHours: '80',
    payScheduleId: schedule.id,
    payMethod: 'direct_deposit',
  });
  await api(page, 'POST', `${p}/employees/${maria.id}/w4`, {
    formVersion: '2020',
    effectiveFrom: '2025-04-01',
    filingStatus: 'single',
  });
  await api(page, 'PUT', `${p}/employees/${maria.id}/bank-accounts`, {
    accounts: [
      {
        routingNumber: '021000021',
        accountNumber: '000123456789',
        accountType: 'checking',
        amountType: 'remainder',
      },
    ],
  });
  const ben = await api<{ id: string }>(page, 'POST', `${p}/employees`, {
    firstName: 'Ben',
    lastName: 'Carter',
    workState: 'FL',
    hireDate: '2025-06-01',
    payType: 'salary',
    payRate: '52000',
    defaultHours: '80',
    payScheduleId: schedule.id,
  });
  await api(page, 'POST', `${p}/employees/${ben.id}/w4`, {
    formVersion: '2020',
    effectiveFrom: '2025-06-01',
    filingStatus: 'married_jointly',
  });
  await api(page, 'PUT', `${p}/employees/${ben.id}/pay-items`, {
    items: [{ payrollItemId: k401.id, percent: '5' }],
  });

  // --- Start the first regular run -----------------------------------------------------------
  await page.goto(`/c/${companyId}/payroll/runs`);
  const start = page.getByRole('form', { name: 'Run payroll' });
  await start.getByLabel('Pay schedule').selectOption({ label: 'Every other Friday' });
  await start.getByRole('button', { name: 'Start pay run' }).click();
  const summary = page.getByTestId('run-summary');
  await expect(summary).toContainText('Regular pay run: Every other Friday');
  await expect(summary).toContainText('Draft');

  // Ben's 401(k) can't be taxed for Florida unemployment yet, so the run can't be approved.
  const paychecks = page.getByTestId('paychecks');
  await expect(paychecks.getByTestId('paycheck-problems')).toContainText(
    "Florida unemployment tax: the treatment of 401(k) isn't sourced yet.",
  );
  await expect(summary.getByRole('button', { name: 'Approve' })).toBeDisabled();

  // Skip the 401(k) on this paycheck.
  await paychecks
    .getByRole('row', { name: /Ben Carter/ })
    .getByRole('button', { name: 'Edit' })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Deductions 1 amount')).toHaveAttribute(
    'placeholder',
    '$100.00 (recurring)',
  );
  await dialog.getByLabel('Deductions 1 amount').fill('0');
  await dialog.getByRole('button', { name: 'Save and recalculate' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(paychecks.getByTestId('paycheck-problems')).toHaveCount(0);
  const benRow = paychecks.getByRole('row', { name: /Ben Carter/ });
  await expect(benRow).toContainText('$2,000.00');
  await expect(benRow).toContainText('$1,770.85');
  await expect(paychecks.getByRole('row', { name: /Maria Lopez/ })).toContainText('$1,658.71');
  await expect(summary).toContainText('$3,960.00');
  await expect(summary).toContainText('$3,429.56');

  // Approve and post.
  await summary.getByRole('button', { name: 'Approve' }).click();
  await expect(summary).toContainText('Approved');
  await summary.getByRole('button', { name: 'Post paychecks' }).click();
  await expect(page.getByText('Paychecks posted to the books.')).toBeVisible();
  await expect(summary).toContainText('Posted');
  await expect(page.getByTestId('run-taxes')).toContainText('TX unemployment');
  await shot(page, '83-pay-run');

  // The direct deposit file.
  const depositSection = page.getByTestId('run-deposit-file');
  const download = page.waitForEvent('download');
  await depositSection.getByRole('button', { name: 'Create direct deposit file' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^payroll-\d{4}-\d{2}-\d{2}\.ach$/);
  const content = readFileSync((await file.path())!, 'ascii');
  expect(
    content
      .split('\r\n')
      .find((r) => r.startsWith('622'))!
      .slice(29, 39),
  ).toBe('0000165871');
  await expect(depositSection).toContainText('has been created');

  // Maria's pay stub.
  await paychecks.getByRole('link', { name: 'Maria Lopez' }).click();
  const stub = page.getByTestId('pay-stub');
  await expect(stub).toContainText('Earnings statement');
  await expect(stub.getByRole('table', { name: 'Earnings' })).toContainText('Hourly wage');
  await expect(stub.getByRole('table', { name: 'Taxes withheld' })).toContainText('$151.35');
  await expect(page.getByTestId('stub-totals')).toContainText('$1,658.71');
  await expect(page.getByTestId('stub-totals')).toContainText('YTD $1,658.71');
  await expect(stub).toContainText('Checking ****6789: $1,658.71');
  await shot(page, '84-pay-stub');

  // --- Pay the IRS ----------------------------------------------------------------------------
  const tabs = page.getByRole('navigation', { name: 'Section' });
  await tabs.getByRole('link', { name: 'Taxes & liabilities' }).click();
  const owed = page.getByTestId('liabilities');
  await expect(owed).toContainText('IRS: Form 941 taxes');
  await owed.getByRole('button', { name: /^Pay IRS: Form 941/ }).click();
  const pay = page.getByRole('dialog');
  await expect(pay.getByLabel('How you paid')).toHaveValue('eftps');
  await pay.getByLabel('Reference').fill('270654321098765');
  await pay.getByRole('button', { name: 'Record payment' }).click();
  const recorded = page.getByTestId('payment-recorded');
  await expect(recorded).toContainText('Form 941, Federal Tax Deposit, quarter 1 of 2026');
  await expect(page.getByTestId('liability-payments')).toContainText('270654321098765');
  await shot(page, '85-liabilities');

  // --- Reports ----------------------------------------------------------------------------------
  await tabs.getByRole('link', { name: 'Reports' }).click();
  await page.getByLabel('From (pay date)').fill('2026-01-01');
  await page.getByLabel('To', { exact: true }).fill('2026-01-31');
  const table = page.getByTestId('report-table');
  await expect(table).toContainText('Ben Carter');
  await expect(table.getByRole('row', { name: /Net pay/ })).toContainText('3,429.56');
  await shot(page, '86-payroll-reports');
});
