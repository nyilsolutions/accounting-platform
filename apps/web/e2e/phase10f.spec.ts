import { expect, test, type Page } from '@playwright/test';
import { latestInviteLink, latestLink, registerWithMfa, shot, uniqueEmail } from './helpers';

/** Sends an API request as the signed-in user (setup that earlier tests cover). */
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

test('portals: an employee sees pay stubs and asks for a W-4 change; a customer signs in by email', async ({
  page,
  browser,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Olive Owner', uniqueEmail('phase10f'));
  await page.getByLabel('Legal business name').fill('Corner Bakery LLC');
  await page.getByLabel('Employer Identification Number (EIN)').fill('12-3456789');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Corner Bakery LLC' })).toBeVisible();
  const companyId = /\/c\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const c = `/companies/${companyId}`;

  // --- Payroll with one paycheck (earlier phases cover these screens) ----------------------------
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
  const anaEmail = uniqueEmail('ana');
  const ana = await api<{ id: string }>(page, 'POST', `${c}/payroll/employees`, {
    firstName: 'Ana',
    lastName: 'Ruiz',
    email: anaEmail,
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

  // --- Invite Ana from her employee page -------------------------------------------------------
  await page.goto(`/c/${companyId}/payroll/employees/${ana.id}`);
  const access = page.getByTestId('portal-access');
  await expect(access.getByLabel('Their email')).toHaveValue(anaEmail);
  await access.getByRole('button', { name: 'Invite to the portal' }).click();
  await expect(access.getByText(`Invitation sent to ${anaEmail}.`)).toBeVisible();

  // --- Ana accepts, sees her pay stub, asks for a new W-4 --------------------------------------
  const anaPage = await (await browser.newContext()).newPage();
  await anaPage.goto(latestInviteLink(anaEmail));
  await expect(anaPage.getByRole('heading', { name: 'Corner Bakery LLC portal' })).toBeVisible();
  await anaPage.getByRole('link', { name: 'Create account' }).click();
  await registerWithMfa(anaPage, 'Ana Ruiz', anaEmail);
  await anaPage.getByRole('button', { name: 'Accept and open the portal' }).click();
  await expect(anaPage.getByText('Ana Ruiz · Employee portal')).toBeVisible();
  const stubs = anaPage.getByTestId('portal-paychecks');
  await expect(stubs).toContainText('1,600.00');
  await stubs.getByRole('link').first().click();
  await expect(anaPage.getByTestId('pay-stub')).toContainText('Ana Ruiz');
  await shot(anaPage, '116-portal-pay-stub');
  await anaPage.getByRole('link', { name: 'W-4 and direct deposit' }).click();
  await expect(anaPage.getByTestId('portal-w4')).toContainText(
    'Single or Married filing separately',
  );
  await anaPage.getByRole('button', { name: 'Change my W-4' }).click();
  await anaPage.getByLabel('Effective from').fill('2026-03-01');
  await anaPage.getByLabel('Filing status').selectOption('married_jointly');
  await anaPage.getByLabel('Step 3: dependents amount').fill('2000');
  await anaPage.getByRole('button', { name: 'Send W-4 for approval' }).click();
  await expect(anaPage.getByTestId('portal-requests')).toContainText('Waiting for approval');
  // Ana can't open the company's books.
  const books = await anaPage.request.get(`/api/companies/${companyId}/accounts`);
  expect(books.status()).toBe(404);

  // --- The owner approves it -------------------------------------------------------------------
  await page.goto(`/c/${companyId}/payroll/requests`);
  const request = page.getByTestId('change-request').first();
  await expect(request).toContainText('Ana Ruiz');
  await expect(request).toContainText('Step 3 dependents: 2,000.00');
  await shot(page, '117-employee-requests');
  await request.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText("Approved Ana Ruiz's W-4 request.")).toBeVisible();
  await anaPage.goto(`/portal/c/${companyId}/details`);
  await expect(anaPage.getByTestId('portal-w4')).toContainText('Married filing jointly');
  await anaPage.context().close();

  // --- A customer signs in with an emailed link -------------------------------------------------
  const cafeEmail = uniqueEmail('cafe');
  const cafe = await api<{ id: string }>(page, 'POST', `${c}/customers`, {
    displayName: 'Main Street Cafe',
    email: cafeEmail,
  });
  await api(page, 'POST', `${c}/sales/invoices`, {
    customerId: cafe.id,
    txnDate: '2026-09-01',
    dueDate: '2099-12-31',
    number: '1042',
    lines: [{ accountId: acct('Sales'), description: 'Pastry platters', amount: '250' }],
  });
  const estimate = await api<{ id: string }>(page, 'POST', `${c}/estimates`, {
    customerId: cafe.id,
    txnDate: '2026-09-25',
    number: 'E-7',
    lines: [{ accountId: acct('Sales'), description: 'Holiday platters', amount: '800' }],
  });
  await api(page, 'POST', `${c}/estimates/${estimate.id}/send`, { to: cafeEmail });

  const customer = await (await browser.newContext()).newPage();
  await customer.goto('/portal/customer');
  await customer.getByLabel('Your email address').fill(cafeEmail);
  await customer.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(customer.getByText('Check your email')).toBeVisible();
  await customer.goto(latestLink(cafeEmail, '/portal/customer/sign-in'));
  await expect(customer.getByRole('heading', { name: 'Main Street Cafe' })).toBeVisible();
  await expect(customer.getByTestId('customer-balance')).toHaveText('$250.00');
  await expect(customer.getByTestId('customer-invoices')).toContainText('1042');
  await shot(customer, '118-customer-portal');
  await customer.getByRole('button', { name: 'Estimates' }).click();
  await customer.getByRole('button', { name: 'Accept estimate E-7' }).click();
  await expect(customer.getByTestId('customer-estimates')).toContainText('Accepted');
  const est = await api<{ status: string }>(page, 'GET', `${c}/estimates/${estimate.id}`);
  expect(est.status).toBe('accepted');
});
