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

const REFUSAL =
  "Washington payroll taxes aren't built in. They need a licensed tax engine, and none is set up on this platform yet.";

test('a state without a built-in engine: registered and worked in, its paychecks refused', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Olive Owner', uniqueEmail('phase11c'));
  await page.getByLabel('Legal business name').fill('Cascade Bakery LLC');
  await page.getByLabel('Employer Identification Number (EIN)').fill('12-3456789');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Cascade Bakery LLC' })).toBeVisible();
  const companyId = /\/c\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const c = `/companies/${companyId}`;

  // --- Payroll setup (earlier phases cover these screens) ---------------------------------------
  const accounts = await api<Array<{ id: string; name: string }>>(page, 'GET', `${c}/accounts`);
  await api(page, 'POST', `${c}/payroll/setup`, {});
  await api(page, 'PUT', `${c}/payroll/settings`, {
    bankAccountId: accounts.find((a) => a.name === 'Checking')!.id,
  });
  const schedule = await api<{ id: string }>(page, 'POST', `${c}/payroll/schedules`, {
    name: 'Biweekly',
    frequency: 'biweekly',
    firstPeriodEnd: '2026-01-09',
    payDateOffset: 6,
  });
  await api(page, 'POST', `${c}/payroll/states`, {
    state: 'TX',
    unemploymentAccountNumber: 'TX-1',
  });

  // --- Any state can be added; Setup says who calculates its taxes ------------------------------
  await page.goto(`/c/${companyId}/payroll/setup`);
  await page.getByRole('button', { name: 'Add state' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add state' });
  await expect(dialog).toContainText("Other states' taxes need a licensed tax engine");
  await dialog.getByLabel('State', { exact: true }).selectOption('WA');
  await dialog.getByLabel('Unemployment account number').fill('000-123456-00-1');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('tax-source-TX')).toHaveText('Built in');
  await expect(page.getByTestId('tax-source-WA')).toHaveText('Needs a licensed tax engine');
  await shot(page, '124-state-tax-sources');

  // --- An employee in Washington: the paycheck is refused, with the reason ----------------------
  const wes = await api<{ id: string }>(page, 'POST', `${c}/payroll/employees`, {
    firstName: 'Wes',
    lastName: 'Hale',
    ssn: '345-67-8901',
    workCity: 'Seattle',
    workState: 'WA',
    hireDate: '2026-01-05',
    payType: 'salary',
    payRate: '52000',
    payScheduleId: schedule.id,
    payMethod: 'check',
  });
  await page.goto(`/c/${companyId}/payroll/employees/${wes.id}`);
  await expect(page.getByTestId('state-certificates')).toContainText(
    "Washington payroll taxes aren't built in: a licensed tax engine calculates them.",
  );
  const run = await api<{ id: string }>(page, 'POST', `${c}/payroll/pay-runs`, {
    kind: 'regular',
    payScheduleId: schedule.id,
    periodEnd: '2026-01-23',
  });
  await page.goto(`/c/${companyId}/payroll/runs/${run.id}`);
  await expect(page.getByTestId('paycheck-problems')).toContainText(REFUSAL);
  await shot(page, '125-state-tax-refused');
});
