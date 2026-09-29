import { expect, test, type Page } from '@playwright/test';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

const COGS = 'Cost of Goods Sold (Cost of goods sold)';
const LABOR = 'Contract Labor (Expenses)';

async function go(page: Page, key: string) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('g');
  await page.keyboard.press(key);
}

async function newVendor(page: Page, name: string, opts: { tin?: string } = {}) {
  await page.getByRole('button', { name: 'New vendor' }).click();
  const dialog = page.getByRole('dialog', { name: 'New vendor' });
  await dialog.getByLabel('Vendor display name').fill(name);
  await dialog.getByLabel('Street address').fill('5 Pipe St');
  await dialog.getByLabel('City').fill('Austin');
  await dialog.getByLabel('State').selectOption('TX');
  await dialog.getByLabel('ZIP code').fill('78701');
  if (opts.tin) {
    await dialog.getByLabel('Track payments for 1099').check();
    await dialog.getByLabel('Tax ID type').selectOption('ssn');
    await dialog.getByLabel('Tax ID (TIN)').fill(opts.tin);
  }
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('link', { name })).toBeVisible();
}

test('purchases: bill, pay bills, print checks, write check, 1099, purchase order, A/P reports', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Pat Payables', uniqueEmail('payables'));
  await page.getByLabel('Legal business name').fill('Sample Landscaping Co.');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Sample Landscaping Co.' })).toBeVisible();

  // --- Vendors -----------------------------------------------------------------------------
  await go(page, 'e');
  await page.getByRole('link', { name: 'Vendors', exact: true }).click();
  await newVendor(page, 'Green Supply Co.');
  await newVendor(page, 'Joe Plumbing', { tin: '123-45-6789' });

  // --- Bill (g m) ------------------------------------------------------------------------------
  await go(page, 'm');
  await expect(page.getByRole('heading', { name: 'New bill' })).toBeVisible();
  await page.getByLabel('Vendor', { exact: true }).selectOption({ label: 'Green Supply Co.' });
  await page.getByLabel('Bill no.').fill('GS-100');
  await page.getByLabel('Line 1 category or product').selectOption({ label: COGS });
  await page.getByLabel('Line 1 description').fill('Mulch');
  await page.getByLabel('Line 1 quantity').fill('10');
  await page.getByLabel('Line 1 rate').fill('30');
  await expect(page.getByLabel('Line 1 amount')).toHaveValue('300.00');
  await expect(page.getByTestId('lines-total')).toHaveText('300.00');
  await shot(page, '30-bill');
  await page.getByRole('button', { name: 'Save and close' }).click();
  const list = page.getByTestId('purchase-transactions');
  await expect(list.getByRole('row', { name: /Bill.*GS-100/ })).toContainText('300.00');
  await expect(page.getByTestId('expenses-money-bar')).toContainText('300.00');

  // --- Pay bills (g v), printing the check later -------------------------------------------------
  await go(page, 'v');
  await expect(page.getByRole('heading', { name: 'Pay bills' })).toBeVisible();
  await page.getByLabel('Pay Green Supply Co. Bill GS-100').check();
  await expect(page.getByTestId('pay-bills-total')).toContainText('300.00');
  await page.getByLabel('Print later').check();
  await shot(page, '31-pay-bills');
  await page.getByRole('button', { name: 'Save payments' }).click();
  await expect(page.getByText(/1 bill payment recorded/)).toBeVisible();

  // --- Print checks --------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Print checks' }).click();
  await expect(page.getByTestId('checks-to-print')).toContainText('Green Supply Co.');
  await page.getByLabel('First check number').fill('1001');
  await page.getByRole('button', { name: /Print 1 check/ }).click();
  await expect(page.getByTestId('printed-checks')).toBeVisible();
  await expect(page.getByTestId('check-number')).toHaveText('1001');
  await expect(page.getByTestId('amount-in-words')).toContainText('Three hundred and 00/100');
  await shot(page, '32-printed-check');
  await expect(page.getByTestId('checks-to-print')).toContainText('No checks are waiting');

  // --- Write a check (g w) to a 1099 contractor -------------------------------------------------
  await go(page, 'w');
  await page.getByLabel('Payee', { exact: true }).selectOption({ label: 'Joe Plumbing' });
  await expect(page.getByLabel('Mailing address')).toHaveValue(/5 Pipe St/);
  await expect(page.getByLabel('Check no.')).toHaveValue('1002');
  await page.getByLabel('Line 1 category or product').selectOption({ label: LABOR });
  await page.getByLabel('Line 1 amount').fill('2500');
  await page.getByRole('button', { name: 'Save and close' }).click();
  await expect(list.getByRole('row', { name: /Check.*1002/ })).toContainText('2,500.00');

  // --- 1099: map Contract Labor to NEC box 1 ------------------------------------------------------
  await page.getByRole('link', { name: '1099 contractors' }).click();
  await page.getByLabel('1099 box for Contract Labor').selectOption('nec_1');
  await page.getByRole('button', { name: 'Save 1099 accounts' }).click();
  await expect(page.getByText('1099 accounts saved.')).toBeVisible();
  const summary = page.getByTestId('vendor-1099-summary');
  await expect(summary.getByRole('row', { name: /Joe Plumbing/ })).toContainText('2,500.00');
  await expect(summary.getByRole('row', { name: /Joe Plumbing/ })).toContainText('Needs a 1099');
  await shot(page, '33-1099');

  // --- Purchase order copied to a bill ---------------------------------------------------------
  await page.getByRole('button', { name: /New transaction/ }).click();
  await page.getByRole('menuitem', { name: 'Purchase order' }).click();
  await page.getByLabel('Vendor', { exact: true }).selectOption({ label: 'Green Supply Co.' });
  await page.getByLabel('Line 1 category or product').selectOption({ label: COGS });
  await page.getByLabel('Line 1 amount').fill('400');
  await page.getByRole('button', { name: 'Save and close' }).click();
  await page
    .getByTestId('purchase-orders-table')
    .getByRole('row', { name: /Green Supply/ })
    .click();
  await page.getByRole('button', { name: 'Copy to bill' }).click();
  await expect(page.getByTestId('balance-due')).toHaveText('$400.00');

  // --- A/P reports and the vendor page ------------------------------------------------------------
  await go(page, 'r');
  await page.getByRole('link', { name: /A\/P Aging Summary/ }).click();
  const aging = page.getByTestId('report-table');
  await expect(aging.getByRole('row', { name: /Green Supply Co\./ })).toContainText('400.00');
  await shot(page, '34-ap-aging');
  await aging
    .getByRole('row', { name: /Green Supply Co\./ })
    .getByRole('link')
    .first()
    .click();
  await expect(page.getByTestId('vendor-name')).toContainText('Green Supply Co.');
  await expect(page.getByTestId('vendor-balances')).toContainText('$400.00');

  await go(page, 'd');
  await expect(page.getByTestId('dashboard-ap')).toContainText('400.00');
});
