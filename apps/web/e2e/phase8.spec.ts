import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

test('payroll setup, an employee with W-4, state certificate and direct deposit, prenote file', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Pat Payroll', uniqueEmail('phase8'));
  await page.getByLabel('Legal business name').fill('Hudson Valley Gardens');
  await page.getByLabel('Employer Identification Number (EIN)').fill('12-3456789');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Hudson Valley Gardens' })).toBeVisible();
  const year = new Date().getFullYear();

  // --- Turn payroll on ------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Payroll' }).click();
  await page.getByLabel('Federal deposit schedule').selectOption('monthly');
  await page.getByRole('button', { name: 'Set up payroll' }).click();
  const tabs = page.getByRole('navigation', { name: 'Section' });
  await expect(page.getByText('Add a pay schedule')).toBeVisible();
  await tabs.getByRole('link', { name: 'Setup' }).click();

  // Settings: the bank that sends direct deposits.
  const settings = page.getByTestId('payroll-settings');
  // The selects start on the saved accounts (not the first option).
  await expect(settings.getByLabel('Wage expense account').locator('option:checked')).toHaveText(
    'Payroll Expenses:Wages',
  );
  await expect(
    settings.getByLabel('Payroll tax expense account').locator('option:checked'),
  ).toHaveText('Payroll Expenses:Payroll Taxes');
  await settings.getByLabel('Pay employees from').selectOption({ label: 'Checking' });
  await settings.getByLabel("Your bank's routing number (ODFI)").fill('021000021');
  await settings.getByLabel("Your bank's name").fill('First Example Bank');
  await settings.getByLabel('Company name on deposits').fill('Hudson Valley');
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(settings.getByText('Payroll settings saved.')).toBeVisible();
  await page.reload();
  await expect(settings.getByLabel('Wage expense account').locator('option:checked')).toHaveText(
    'Payroll Expenses:Wages',
  );

  // A biweekly schedule.
  await page.getByRole('button', { name: 'Add pay schedule' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Every other Friday');
  await dialog.getByLabel('How often').selectOption('biweekly');
  await dialog.getByLabel('A pay period ends on').fill(`${year}-01-09`);
  await dialog.getByLabel('Days from period end to pay date').fill('6');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('pay-schedules')).toContainText('Every other Friday');

  // New York, with this year's unemployment rate.
  await page.getByRole('button', { name: 'Add state' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('State').selectOption('NY');
  await dialog.getByLabel('Withholding account number').fill('NY-1234567');
  await dialog.getByLabel('Unemployment account number').fill('49-12345');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const states = page.getByTestId('payroll-states');
  await expect(states).toContainText('New York');
  await states.getByRole('button', { name: 'Set rate' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Rate (%)').fill('3.4');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(states).toContainText(`${year}: 3.4%`);

  // A 401(k) deduction.
  await page.getByRole('button', { name: 'Add payroll item' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Kind').selectOption('traditional_401k');
  await dialog.getByLabel('Name').fill('401(k)');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('payroll-items')).toContainText('Pre-tax deductions');
  await shot(page, '80-payroll-setup');

  // --- An employee -------------------------------------------------------------------------------
  await tabs.getByRole('link', { name: 'Employees' }).click();
  await page.getByRole('link', { name: 'Add employee' }).click();
  const form = page.getByRole('form', { name: 'Employee details' });
  await form.getByLabel('First name').fill('Ana');
  await form.getByLabel('Last name').fill('Ruiz');
  await form.getByLabel('Employee ID').fill('E-1');
  await form.getByLabel('Social Security number').fill('123-45-6789');
  await form.getByLabel('Street', { exact: true }).fill('12 Elm St');
  await form.getByLabel('City', { exact: true }).fill('Albany');
  await form.getByLabel('State', { exact: true }).selectOption('NY');
  await form.getByLabel('ZIP code', { exact: true }).fill('12207');
  await form.getByLabel('Work state').selectOption('NY');
  await form.getByLabel('Hire date').fill(`${year}-03-02`);
  await form.getByLabel('Pay type').selectOption('hourly');
  await form.getByLabel('Hourly rate').fill('24.50');
  await form.getByLabel('Usual hours per paycheck').fill('80');
  await form.getByLabel('Pay method').selectOption('direct_deposit');
  await form.getByRole('button', { name: 'Save employee' }).click();

  await expect(page.getByRole('heading', { name: 'Ana Ruiz' })).toBeVisible();
  await expect(page.getByTestId('employee-missing')).toContainText(
    'Form W-4, Form IT-2104, Direct deposit account',
  );
  await expect(form.getByLabel('Social Security number')).toHaveAttribute(
    'placeholder',
    '***-**-6789',
  );

  // Form W-4 (2020+).
  await page.getByRole('button', { name: 'Add Form W-4' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Effective from').fill(`${year}-03-02`);
  await dialog.getByLabel('Filing status (Step 1c)').selectOption('married_jointly');
  await dialog.getByLabel('Step 3: dependents amount').fill('4000');
  await dialog.getByRole('button', { name: 'Save Form W-4' }).click();
  await expect(page.getByTestId('w4')).toContainText('Married filing jointly');
  await expect(page.getByTestId('w4')).toContainText('Dependents $4,000.00');

  // New York IT-2104.
  await page.getByRole('button', { name: 'Add state certificate' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Effective from').fill(`${year}-03-02`);
  await dialog.getByLabel('IT-2104 filing status').selectOption('married');
  await dialog.getByLabel('State allowances (line 1)').fill('2');
  await dialog.getByRole('button', { name: 'Save certificate' }).click();
  await expect(page.getByTestId('state-certificates')).toContainText('2 state allowances');

  // Direct deposit to one checking account, with a prenote.
  const dd = page.getByTestId('direct-deposit');
  await dd.getByRole('button', { name: 'Add account' }).click();
  await dd.getByLabel('Account 1 routing number').fill('021000021');
  await dd.getByLabel('Account 1 account number').fill('000123456789');
  await dd.getByRole('button', { name: 'Save direct deposit' }).click();
  await expect(dd.getByText('Direct deposit saved.')).toBeVisible();
  await expect(dd.getByLabel('Account 1 account number')).toHaveAttribute(
    'placeholder',
    '****6789',
  );
  await expect(page.getByTestId('employee-missing')).toHaveCount(0);
  await shot(page, '81-employee');

  // --- The prenote file -----------------------------------------------------------------------------
  await tabs.getByRole('link', { name: 'Direct deposit' }).click();
  const prenotes = page.getByTestId('prenotes');
  await expect(prenotes).toContainText('Ana Ruiz');
  await expect(prenotes).toContainText('****6789');
  const download = page.waitForEvent('download');
  await prenotes.getByRole('button', { name: 'Create prenote file' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^prenote-\d{4}-\d{2}-\d{2}\.ach$/);
  const content = readFileSync((await file.path())!, 'ascii');
  expect(content.split('\r\n')[0]!.slice(0, 13)).toBe('101 021000021');
  await expect(prenotes).toContainText('No accounts are waiting for a prenote.');
  await expect(page.getByTestId('ach-batches')).toContainText('Prenotes');
  await shot(page, '82-direct-deposit');
});
