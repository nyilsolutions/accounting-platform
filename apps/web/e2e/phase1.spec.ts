import { expect, test, type Page } from '@playwright/test';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

const NBSP3 = '   ';

async function go(page: Page, key: string) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('g');
  await page.keyboard.press(key);
}

test('ledger: chart of accounts, journal entries, reports with drill-down, closing date, lists', async ({
  page,
}) => {
  // --- Sign up and create an S-corp company -------------------------------------------
  await page.goto('/register');
  await registerWithMfa(page, 'Lena Ledger', uniqueEmail('ledger'));
  await page.getByLabel('Legal business name').fill('Sample Landscaping Co.');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Sample Landscaping Co.' })).toBeVisible();

  // --- Chart of accounts (g a) ---------------------------------------------------------
  await go(page, 'a');
  await expect(page.getByRole('heading', { name: 'Accounting' })).toBeVisible();
  await expect(page.getByTestId('account-Checking')).toBeVisible();
  await expect(page.getByTestId('account-Shareholder Distributions')).toBeVisible();
  await expect(page.getByTestId('account-Payroll Expenses:Wages')).toBeVisible();

  await page.getByRole('button', { name: 'New account' }).click();
  const dialog = page.getByRole('dialog', { name: 'New account' });
  await dialog.getByLabel('Account type').selectOption('expense');
  await dialog.getByLabel('Name').fill('Fuel');
  await dialog.getByLabel('Make this a sub-account').check();
  await dialog.getByLabel('Parent account').selectOption({ label: 'Car and Truck' });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('account-Car and Truck:Fuel')).toBeVisible();
  await shot(page, '10-chart-of-accounts');

  // --- Journal entry (g j): the balancing amount is pre-filled -----------------------------
  await go(page, 'j');
  await expect(page.getByLabel('Line 1 account')).toBeVisible();
  await page.getByLabel('Line 1 account').selectOption({ label: 'Checking' });
  await page.getByLabel('Line 1 debit').fill('5000');
  await page.getByLabel('Line 1 description').fill('Initial capital');
  await page.getByLabel('Line 2 account').selectOption({ label: 'Common Stock' });
  await expect(page.getByLabel('Line 2 credit')).toHaveValue('5000.00');
  await expect(page.getByTestId('je-total-debit')).toHaveText('5,000.00');
  await expect(page.getByTestId('je-total-credit')).toHaveText('5,000.00');
  await shot(page, '11-journal-entry');
  await page.getByRole('button', { name: 'Save and new' }).click();
  await expect(page.getByText(/Journal entry 1 saved/)).toBeVisible();

  // Second entry, saved with Ctrl+S.
  await page.getByLabel('Line 1 account').selectOption({ label: `${NBSP3}Fuel` });
  await page.getByLabel('Line 1 debit').fill('120');
  await page.getByLabel('Line 2 account').selectOption({ label: 'Credit Card' });
  await expect(page.getByLabel('Line 2 credit')).toHaveValue('120.00');
  await page.getByLabel('Line 1 description').click();
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('heading', { name: 'Accounting' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /Fuel, Credit Card/ })).toBeVisible();

  // --- Reports: P&L, drill-down to the general ledger and back to the entry --------------
  await go(page, 'r');
  await page.getByRole('link', { name: 'Profit and Loss', exact: true }).click();
  const table = page.getByTestId('report-table');
  await expect(table.getByRole('row', { name: /Net Income/ })).toContainText('-120.00');
  await expect(table.getByRole('row', { name: /Total Car and Truck/ })).toContainText('120.00');
  await shot(page, '12-profit-and-loss');

  await table.getByRole('row', { name: /^Fuel/ }).getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'General Ledger' })).toBeVisible();
  const gl = page.getByTestId('report-table');
  await expect(gl.getByRole('row', { name: /Credit Card/ })).toContainText('120.00');
  await shot(page, '13-general-ledger');
  await gl
    .getByRole('row', { name: /Credit Card/ })
    .getByRole('link')
    .click();
  await expect(page.getByLabel('Line 1 debit')).toHaveValue('120.00');

  // Balance sheet balances.
  await go(page, 'r');
  await page.getByRole('link', { name: 'Balance Sheet', exact: true }).click();
  const bs = page.getByTestId('report-table');
  await expect(bs.getByRole('row', { name: /^TOTAL ASSETS/ })).toContainText('5,000.00');
  await expect(bs.getByRole('row', { name: /TOTAL LIABILITIES AND EQUITY/ })).toContainText(
    '5,000.00',
  );
  await shot(page, '14-balance-sheet');

  // --- Close the books through today, then edit an entry in the closed period ------------
  await go(page, 'c');
  await page.getByLabel('Closing date').fill(new Date().toLocaleDateString('en-CA'));
  await page.getByLabel('Closing password').fill('closed-period-pw');
  await page.getByRole('button', { name: 'Save closing date' }).click();
  await expect(page.getByText(/Books closed through/)).toBeVisible();

  await go(page, 'a');
  await page.getByRole('link', { name: 'Journal entries' }).click();
  await page.getByRole('cell', { name: /Checking, Common Stock/ }).click();
  await page.getByLabel('Memo').fill('Initial capital contribution');
  await page.getByRole('button', { name: 'Save and close' }).click();
  const closed = page.getByRole('dialog', { name: 'Closed period' });
  await expect(closed).toContainText('The books are closed');
  await closed.getByLabel('Closing date password').fill('wrong-password');
  await closed.getByRole('button', { name: 'Continue' }).click();
  await expect(closed).toContainText('incorrect');
  await closed.getByLabel('Closing date password').fill('closed-period-pw');
  await closed.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('cell', { name: 'Initial capital contribution' })).toBeVisible();

  // --- Lists: customer, vendor with encrypted TIN, class ------------------------------------
  await go(page, 's');
  await page.getByRole('link', { name: 'Customers', exact: true }).click();
  await page.getByRole('button', { name: 'New customer' }).click();
  await page.getByLabel('Customer display name').fill('Acme Corp');
  await page.getByLabel('Email').fill('ap@acme.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'Acme Corp', exact: true })).toBeVisible();

  await go(page, 'e');
  await page.getByRole('link', { name: 'Vendors', exact: true }).click();
  await page.getByRole('button', { name: 'New vendor' }).click();
  await page.getByLabel('Vendor display name').fill('Joe Plumbing');
  await page.getByLabel('Track payments for 1099').check();
  await page.getByLabel('Tax ID type').selectOption('ssn');
  await page.getByLabel('Tax ID (TIN)').fill('123-45-6789');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: '***-**-6789' })).toBeVisible();
  await expect(page.getByText('123-45-6789')).toHaveCount(0);

  await go(page, 't');
  await page.getByLabel('New Classes').fill('Residential');
  await page.getByTestId('list-classes').locator('..').getByRole('button', { name: 'Add' }).click();
  await expect(page.getByTestId('list-classes')).toContainText('Residential');
  await shot(page, '15-lists');

  // --- Audit trail records the closed-period change -------------------------------------
  await go(page, 'l');
  await expect(
    page.getByRole('cell', { name: 'journal_entry.updated', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'company.ledger_settings_updated', exact: true }),
  ).toBeVisible();
});
