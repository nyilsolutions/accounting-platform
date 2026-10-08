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

test('payroll partners: EFTPS schedules a tax payment; a partner deposit comes back', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Olive Owner', uniqueEmail('phase11b'));
  await page.getByLabel('Legal business name').fill('Corner Bakery LLC');
  await page.getByLabel('Employer Identification Number (EIN)').fill('12-3456789');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Corner Bakery LLC' })).toBeVisible();
  const companyId = /\/c\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const c = `/companies/${companyId}`;

  // --- Payroll with one direct deposit paycheck (earlier phases cover these screens) -----------
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
    payMethod: 'direct_deposit',
  });
  await api(page, 'POST', `${c}/payroll/employees/${ana.id}/w4`, {
    formVersion: '2020',
    effectiveFrom: '2026-01-05',
    filingStatus: 'single',
  });
  await api(page, 'PUT', `${c}/payroll/employees/${ana.id}/bank-accounts`, {
    accounts: [
      {
        routingNumber: '021000021',
        accountNumber: '000987654321',
        accountType: 'checking',
        amountType: 'remainder',
      },
    ],
  });
  const run = await api<{ id: string }>(page, 'POST', `${c}/payroll/pay-runs`, {
    kind: 'regular',
    payScheduleId: schedule.id,
    periodEnd: '2026-01-23',
  });
  await api(page, 'POST', `${c}/payroll/pay-runs/${run.id}/approve`);
  await api(page, 'POST', `${c}/payroll/pay-runs/${run.id}/post`, {});

  // --- Enroll in EFTPS and schedule the Form 941 deposit ---------------------------------------
  await page.goto(`/c/${companyId}/payroll/liabilities`);
  const card = page.getByTestId('eftps-card');
  await card.getByRole('button', { name: 'Enroll in EFTPS' }).click();
  const enroll = page.getByRole('dialog', { name: 'Enroll in EFTPS' });
  await enroll.getByLabel('Routing number').fill('021000021');
  await enroll.getByLabel('Account number').fill('000555123456');
  await enroll.getByLabel('Authorized by').fill('Olive Owner');
  await enroll.getByLabel('Title').fill('Owner');
  await enroll.getByRole('checkbox').check();
  await enroll.getByRole('button', { name: 'Enroll' }).click();
  await expect(card).toContainText('Waiting for EFTPS');
  await card.getByRole('button', { name: 'Stand-in: enroll' }).click();
  await expect(card).toContainText('Enrolled');
  await expect(card).toContainText('debited from ****3456');

  const owed = page.getByTestId('liabilities');
  await owed.getByRole('button', { name: /^Pay IRS: Form 941/ }).click();
  const pay = page.getByRole('dialog');
  await expect(pay.getByLabel('How you paid')).toHaveValue('eftps');
  await expect(pay).toContainText('scheduled for you and debited from ****3456');
  await pay.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByTestId('payment-recorded')).toContainText('Scheduled in EFTPS');
  const payments = page.getByTestId('liability-payments');
  await expect(payments).toContainText('Scheduled');
  await shot(page, '122-eftps-scheduled');

  // EFTPS (the stand-in) returns it unpaid: it is voided and owed again.
  await payments.getByRole('button', { name: 'Stand-in: returned' }).click();
  await expect(payments).toContainText('Returned unpaid');
  await expect(payments).toContainText('R01: Insufficient funds');
  await expect(owed.getByRole('button', { name: /^Pay IRS: Form 941/ })).toBeVisible();

  // --- Direct deposit through the payments partner ----------------------------------------------
  await page.goto(`/c/${companyId}/payroll/direct-deposit`);
  const rail = page.getByTestId('deposit-rail');
  await rail.getByRole('button', { name: 'Send through the payments partner' }).click();
  await expect(rail).toContainText('Through the payments partner');
  await page.goto(`/c/${companyId}/payroll/runs/${run.id}`);
  const deposits = page.getByTestId('run-deposit-file');
  await deposits.getByRole('button', { name: 'Send direct deposits' }).click();
  await expect(page.getByText('Direct deposits sent through the payments partner.')).toBeVisible();

  await page.goto(`/c/${companyId}/payroll/direct-deposit`);
  const batches = page.getByTestId('ach-batches');
  await expect(batches).toContainText('Payments partner');
  await expect(batches).toContainText('Ana Ruiz');
  await batches.getByRole('button', { name: 'Stand-in: return' }).click();
  await expect(batches).toContainText('Returned R03: No account');
  await shot(page, '123-partner-deposits');

  // The paycheck and the employee's account show it.
  const paycheckId = (
    await api<{ paychecks: Array<{ id: string }> }>(page, 'GET', `${c}/payroll/pay-runs/${run.id}`)
  ).paychecks[0]!.id;
  await page.goto(`/c/${companyId}/payroll/paychecks/${paycheckId}`);
  await expect(page.getByTestId('deposit-returned')).toContainText(
    'Void this paycheck and pay it again by check.',
  );
  await page.goto(`/c/${companyId}/payroll/employees/${ana.id}`);
  const dd = page.getByTestId('direct-deposit');
  await expect(dd).toContainText('A deposit came back: R03: No account');
  await dd.getByRole('button', { name: "It's fixed: use it again" }).click();
  await expect(dd).not.toContainText('A deposit came back');
});
