import { expect, test, type Page } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTBOX_DIR, registerWithMfa, shot, uniqueEmail } from './helpers';

const SERVICES = 'Services (Income account)';

async function go(page: Page, key: string) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('g');
  await page.keyboard.press(key);
}

async function newTransaction(page: Page, name: string) {
  await page.getByRole('button', { name: /New transaction/ }).click();
  await page.getByRole('menuitem', { name }).click();
}

test('sales: invoice, payment, receipt, deposit, estimate, statement and A/R reports', async ({
  page,
}) => {
  // --- Company and a customer ----------------------------------------------------------------
  await page.goto('/register');
  await registerWithMfa(page, 'Sam Sales', uniqueEmail('sales'));
  await page.getByLabel('Legal business name').fill('Sample Landscaping Co.');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Sample Landscaping Co.' })).toBeVisible();

  await go(page, 's');
  await page.getByRole('link', { name: 'Customers', exact: true }).click();
  await page.getByRole('button', { name: 'New customer' }).click();
  await page.getByLabel('Customer display name').fill('Green Acres HOA');
  await page.getByLabel('Email').fill('board@greenacres.test');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('link', { name: 'Green Acres HOA' })).toBeVisible();

  // --- Invoice (g n): quantity × rate, totals --------------------------------------------------
  await go(page, 'n');
  await expect(page.getByRole('heading', { name: 'New invoice' })).toBeVisible();
  await page.getByLabel('Customer', { exact: true }).selectOption({ label: 'Green Acres HOA' });
  await expect(page.getByLabel('Bill to')).toHaveValue(/Green Acres HOA/);
  await expect(page.getByLabel('Invoice no.')).toHaveValue('1001');
  await page.getByLabel('Line 1 product or service').selectOption({ label: SERVICES });
  await page.getByLabel('Line 1 description').fill('Weekly mowing');
  await page.getByLabel('Line 1 quantity').fill('10');
  await page.getByLabel('Line 1 rate').fill('45.50');
  await expect(page.getByLabel('Line 1 amount')).toHaveValue('455.00');
  await page.getByLabel('Line 2 product or service').selectOption({ label: SERVICES });
  await page.getByLabel('Line 2 description').fill('Hedge trimming');
  await page.getByLabel('Line 2 amount').fill('100');
  await expect(page.getByTestId('lines-total')).toHaveText('555.00');
  await shot(page, '20-invoice');
  await page.getByRole('button', { name: 'Save and close' }).click();

  const list = page.getByTestId('sales-transactions');
  await expect(list.getByRole('row', { name: /Invoice.*1001/ })).toContainText('555.00');
  await expect(page.getByTestId('sales-money-bar')).toContainText('555.00');

  // --- Print view and email -------------------------------------------------------------------
  await list.getByRole('row', { name: /Invoice.*1001/ }).click();
  await expect(page.getByTestId('balance-due')).toHaveText('$555.00');
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('document-print')).toBeVisible();
  await expect(page.getByTestId('document-print')).toContainText('Balance due');
  await shot(page, '21-invoice-print');
  await page.emulateMedia({ media: 'screen' });

  await page.getByRole('button', { name: 'Email' }).click();
  const send = page.getByRole('dialog', { name: /Email invoice/ });
  await expect(send.getByLabel('To')).toHaveValue('board@greenacres.test');
  await send.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Invoice sent to board@greenacres.test.')).toBeVisible();
  const mail = readdirSync(OUTBOX_DIR)
    .map(
      (f) => JSON.parse(readFileSync(join(OUTBOX_DIR, f), 'utf8')) as { to: string; text: string },
    )
    .find((m) => String(m.to).includes('board@greenacres.test'));
  expect(mail?.text).toContain('555.00');

  // --- Receive a partial payment from the invoice ---------------------------------------------
  await page.getByRole('link', { name: 'Receive payment' }).click();
  await expect(page.getByLabel('Amount received')).toHaveValue('555.00');
  await page.getByLabel('Amount received').fill('300');
  await page.getByLabel('Reference no.').fill('1042');
  await page.getByLabel('Amount received').blur();
  await expect(page.getByLabel('Payment for 1001')).toHaveValue('300.00');
  await expect(page.getByTestId('amount-to-credit')).toHaveText('0.00');
  await shot(page, '22-receive-payment');
  await page.getByRole('button', { name: 'Save and close' }).click();
  await expect(list.getByRole('row', { name: /Invoice.*1001/ })).toContainText('Partially paid');
  await expect(list.getByRole('row', { name: /Invoice.*1001/ })).toContainText('255.00');

  // --- Cash sale into Undeposited Funds, then a bank deposit (g k) --------------------------
  await newTransaction(page, 'Sales receipt');
  await page.getByLabel('Line 1 product or service').selectOption({ label: SERVICES });
  await page.getByLabel('Line 1 description').fill('Leaf cleanup');
  await page.getByLabel('Line 1 amount').fill('80');
  await page.getByRole('button', { name: 'Save and close' }).click();
  await expect(list.getByRole('row', { name: /Sales Receipt/ })).toContainText('80.00');

  await go(page, 'k');
  await expect(page.getByRole('heading', { name: 'Bank deposit' })).toBeVisible();
  await page.getByLabel('Select all payments').check();
  await expect(page.getByTestId('deposit-total')).toHaveText('$380.00');
  await shot(page, '23-bank-deposit');
  await page.getByRole('button', { name: 'Save and close' }).click();
  await expect(list.getByRole('row', { name: /Payment/ }).first()).toContainText('Deposited');

  // --- Estimate converted to an invoice -------------------------------------------------------
  await newTransaction(page, 'Estimate');
  await page.getByLabel('Customer', { exact: true }).selectOption({ label: 'Green Acres HOA' });
  await page.getByLabel('Line 1 product or service').selectOption({ label: SERVICES });
  await page.getByLabel('Line 1 description').fill('Spring planting');
  await page.getByLabel('Line 1 amount').fill('200');
  await page.getByRole('button', { name: 'Save and close' }).click();
  await page
    .getByTestId('estimates-table')
    .getByRole('row', { name: /Green Acres HOA/ })
    .click();
  await page.getByRole('button', { name: 'Convert to invoice' }).click();
  await expect(page.getByTestId('balance-due')).toHaveText('$200.00');
  await expect(page.getByLabel('Invoice no.')).toHaveValue('1002');

  // --- Customer page and statement --------------------------------------------------------
  await go(page, 's');
  await page.getByRole('link', { name: 'Customers', exact: true }).click();
  await page.getByRole('link', { name: 'Green Acres HOA' }).click();
  await expect(page.getByTestId('customer-balances')).toContainText('$455.00');
  await shot(page, '24-customer');
  await page.getByRole('button', { name: 'Statement' }).click();
  await page.getByRole('button', { name: 'View statement' }).click();
  await expect(page.getByTestId('statement-aging')).toContainText('455.00');
  await shot(page, '25-statement');

  // --- Reports: A/R aging and cash vs accrual ------------------------------------------------
  await go(page, 'r');
  await page.getByRole('link', { name: /A\/R Aging Summary/ }).click();
  const aging = page.getByTestId('report-table');
  await expect(aging.getByRole('row', { name: /Green Acres HOA/ })).toContainText('455.00');
  await shot(page, '26-ar-aging');
  await aging
    .getByRole('row', { name: /Green Acres HOA/ })
    .getByRole('link')
    .first()
    .click();
  await expect(page.getByTestId('customer-name')).toHaveText('Green Acres HOA');

  await go(page, 'r');
  await page.getByRole('link', { name: /Profit and Loss/ }).click();
  const pl = page.getByTestId('report-table');
  await expect(pl.getByRole('row', { name: /Net Income/ })).toContainText('835.00');
  await page.getByLabel('Accounting method').selectOption('cash');
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(page.getByText('Cash basis')).toBeVisible();
  await expect(pl.getByRole('row', { name: /Net Income/ })).toContainText('380.00');
  await shot(page, '27-profit-and-loss-cash');

  // --- Dashboard ------------------------------------------------------------------------------
  await go(page, 'd');
  await expect(page.getByTestId('dashboard-ar')).toContainText('455.00');
});
