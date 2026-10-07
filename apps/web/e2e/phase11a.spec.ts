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

test('e-file: Form 941 is rejected, fixed and accepted; Forms 1099 go through IRIS', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Olive Owner', uniqueEmail('phase11a'));
  await page.getByLabel('Legal business name').fill('Corner Bakery LLC');
  await page.getByLabel('Employer Identification Number (EIN)').fill('12-3456789');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Corner Bakery LLC' })).toBeVisible();
  const companyId = /\/c\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const c = `/companies/${companyId}`;

  // --- Payroll with one paycheck in Q1 (earlier phases cover these screens) --------------------
  const accounts = await api<Array<{ id: string; name: string }>>(page, 'GET', `${c}/accounts`);
  const acct = (n: string) => accounts.find((a) => a.name === n)!.id;
  await api(page, 'POST', `${c}/payroll/setup`, {});
  await api(page, 'PUT', `${c}/payroll/settings`, {
    bankAccountId: acct('Checking'),
    achOdfiRouting: '021000021',
    achOdfiName: 'First Example Bank',
    achCompanyName: 'Corner Bakery',
  });
  const schedule = await api<{ id: string }>(page, 'POST', `${c}/payroll/schedules`, {
    name: 'Biweekly',
    frequency: 'biweekly',
    firstPeriodEnd: '2026-01-09',
    payDateOffset: 6,
  });
  const tx = await api<{ id: string }>(page, 'POST', `${c}/payroll/states`, {
    state: 'TX',
    unemploymentAccountNumber: 'TX-1',
  });
  await api(page, 'PUT', `${c}/payroll/states/${tx.id}/unemployment-rates`, {
    year: 2026,
    rate: '2.7',
  });
  const ana = await api<{ id: string }>(page, 'POST', `${c}/payroll/employees`, {
    firstName: 'Ana',
    lastName: 'Ruiz',
    ssn: '123-45-6789',
    workState: 'TX',
    hireDate: '2026-01-05',
    payType: 'hourly',
    payRate: '20',
    defaultHours: '80',
    payScheduleId: schedule.id,
    payMethod: 'check',
  });
  await api(page, 'POST', `${c}/payroll/employees/${ana.id}/w4`, {
    formVersion: '2020',
    effectiveFrom: '2026-01-05',
    filingStatus: 'single',
  });
  const run = await api<{ id: string }>(page, 'POST', `${c}/payroll/pay-runs`, {
    kind: 'regular',
    payScheduleId: schedule.id,
    periodEnd: '2026-01-23',
  });
  await api(page, 'POST', `${c}/payroll/pay-runs/${run.id}/approve`);
  await api(page, 'POST', `${c}/payroll/pay-runs/${run.id}/post`, {});

  // --- Form 941: the address is missing first ---------------------------------------------------
  await page.goto(`/c/${companyId}/payroll/forms`);
  await page.getByLabel('Year').selectOption('2026');
  await page.getByLabel('Quarter').selectOption('1');
  const efile = page.getByTestId('efile-form_941');
  await expect(efile.getByTestId('efile-problems')).toContainText(
    "Add the company's full address in Company settings.",
  );
  await api(page, 'PATCH', c, {
    addressLine1: '1 Main St',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
  });
  await page.reload();
  await page.getByLabel('Quarter').selectOption('1');

  // Send it, signed.
  await efile.getByRole('button', { name: 'E-file Form 941 for Q1 2026' }).click();
  const dialog = page.getByRole('dialog', { name: 'E-file Form 941 for Q1 2026' });
  await expect(dialog.getByLabel('Signer name')).toHaveValue('Olive Owner');
  await dialog.getByLabel('Title').fill('Owner');
  await dialog.getByLabel('Daytime phone').fill('512-555-0100');
  await dialog.getByRole('button', { name: 'Send to the IRS' }).click();
  await expect(dialog.getByText('Confirm the statement to send the return')).toBeVisible();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Send to the IRS' }).click();
  await expect(efile.getByText('Waiting for the IRS')).toBeVisible();

  // The stand-in IRS rejects it; it is sent again and accepted.
  await efile.getByRole('button', { name: 'Stand-in: reject' }).click();
  await page
    .getByRole('dialog', { name: 'Stand-in: reject the return' })
    .getByRole('button', {
      name: 'Reject',
    })
    .click();
  await expect(efile.getByTestId('efile-errors')).toContainText(
    'SI-0001: The business name does not match the EIN.',
  );
  await efile.getByRole('button', { name: 'Send again' }).click();
  await expect(dialog.getByLabel('Title')).toHaveValue('Owner');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Send to the IRS' }).click();
  await efile.getByRole('button', { name: 'Stand-in: accept' }).click();
  await expect(efile.getByText('Accepted')).toBeVisible();
  const filing = page.getByTestId('filing-form_941');
  await expect(filing).toContainText('Filed electronically');
  await expect(filing).toContainText('confirmation SI');
  // The IRS accepted it: its filing record stays.
  await expect(filing.getByRole('button', { name: 'Void filing record' })).toHaveCount(0);
  await shot(page, '119-efile-941');

  // The log lists both attempts.
  await page.getByRole('link', { name: 'E-file' }).click();
  const log = page.getByTestId('efile-log');
  await expect(log.getByRole('row')).toHaveCount(3);
  await expect(log).toContainText('Rejected');
  await expect(log).toContainText('Accepted');
  await shot(page, '120-efile-log');

  // --- Forms 1099 for 2025 through IRIS --------------------------------------------------------
  const joe = await api<{ id: string }>(page, 'POST', `${c}/vendors`, {
    displayName: 'Joe Plumbing',
    is1099: true,
    tinType: 'ssn',
    tin: '123-45-6789',
    addressLine1: '5 Pipe St',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
  });
  await api(page, 'PUT', `${c}/1099/mappings`, {
    mappings: [{ accountId: acct('Contract Labor'), box: 'nec_1' }],
  });
  await api(page, 'POST', `${c}/purchases/checks`, {
    vendorId: joe.id,
    txnDate: '2025-06-01',
    paymentAccountId: acct('Checking'),
    lines: [{ accountId: acct('Contract Labor'), amount: '1000' }],
  });
  await page.goto(`/c/${companyId}/expenses/1099`);
  await page.getByLabel('1099 year').selectOption('2025');
  const iris = page.getByTestId('efile-form_1099');
  await iris.getByRole('button', { name: 'E-file Forms 1099 for 2025' }).click();
  const d1099 = page.getByRole('dialog', { name: 'E-file Forms 1099 for 2025' });
  await d1099.getByLabel('Title').fill('Owner');
  await d1099.getByLabel('Daytime phone').fill('512-555-0100');
  await d1099.getByRole('checkbox').check();
  await d1099.getByRole('button', { name: 'Send to the IRS' }).click();
  await iris.getByRole('button', { name: 'Stand-in: accept' }).click();
  await expect(page.getByTestId('filing-form_1099')).toContainText('Filed electronically');
  await shot(page, '121-efile-1099');
});
