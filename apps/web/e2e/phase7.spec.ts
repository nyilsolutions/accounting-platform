import { expect, test, type Page } from '@playwright/test';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

const SALES = 'Sales (Income account)';

async function go(page: Page, key: string) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('g');
  await page.keyboard.press(key);
}

test('sales tax, report columns and exports, memorized and scheduled reports, budgets, custom report', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Tara Tax', uniqueEmail('phase7'));
  await page.getByLabel('Legal business name').fill('Harbor Garden Supply');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Harbor Garden Supply' })).toBeVisible();
  const companyPath = new URL(page.url()).pathname.replace(/\/$/, '');
  // Last year, so every date is in the past whenever the test runs.
  const year = new Date().getFullYear() - 1;

  // --- Sales tax: an agency, two rates and a combined rate -----------------------------------
  await page.getByRole('link', { name: 'Sales tax' }).click();
  await expect(page.getByRole('heading', { name: 'Sales tax' })).toBeVisible();
  await page.getByRole('button', { name: 'Add agency' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('State Revenue Department');
  await dialog.getByLabel('Filing frequency').selectOption('quarterly');
  await dialog.getByRole('button', { name: 'Save' }).click();
  for (const [name, rate] of [
    ['State', '6.25'],
    ['Harbor City', '2'],
  ]) {
    await page.getByRole('button', { name: 'Add rate' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(name!);
    await dialog
      .getByLabel('Agency', { exact: true })
      .selectOption({ label: 'State Revenue Department' });
    await dialog.getByLabel('Rate (%)').fill(rate!);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('tax-rates')).toContainText(name!);
  }
  await page.getByRole('button', { name: 'Add rate' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Combined rate (state + county + city…)').check();
  await dialog.getByLabel('Name', { exact: true }).fill('Harbor 8.25%');
  await dialog.getByLabel(/^State \(6\.25%/).check();
  await dialog.getByLabel(/^Harbor City \(2%/).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByTestId('tax-rates').getByRole('row', { name: /Harbor 8\.25%/ }),
  ).toContainText('8.25%');
  await shot(page, '70-sales-tax-setup');

  // --- An invoice with sales tax on its taxable line -----------------------------------------
  await go(page, 's');
  await page.getByRole('link', { name: 'Customers', exact: true }).click();
  await page.getByRole('button', { name: 'New customer' }).click();
  await page.getByLabel('Customer display name').fill('Bayside Cafe');
  await page.getByLabel('Default sales tax rate').selectOption({ label: 'Harbor 8.25% (8.25%)' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('link', { name: 'Bayside Cafe' })).toBeVisible();

  await go(page, 'n');
  await page.getByLabel('Customer', { exact: true }).selectOption({ label: 'Bayside Cafe' });
  await page.getByLabel('Invoice date').fill(`${year}-01-15`);
  await expect(page.getByLabel('Sales tax rate')).toHaveValue(/.+/);
  await page.getByLabel('Line 1 product or service').selectOption({ label: SALES });
  await page.getByLabel('Line 1 description').fill('Planters');
  await page.getByLabel('Line 1 amount').fill('200');
  await page.getByLabel('Line 1 taxable').check();
  await page.getByLabel('Line 2 product or service').selectOption({ label: SALES });
  await page.getByLabel('Line 2 description').fill('Delivery');
  await page.getByLabel('Line 2 amount').fill('50');
  const totals = page.getByTestId('document-totals');
  await expect(totals).toContainText('Subtotal250.00');
  await expect(page.getByTestId('sales-tax')).toContainText('12.50'); // state 6.25% of 200
  await expect(page.getByTestId('sales-tax')).toContainText('4.00'); // city 2%
  await expect(totals).toContainText('$266.50');
  await shot(page, '71-invoice-sales-tax');
  await page.getByRole('button', { name: 'Save and close' }).click();
  await expect(
    page.getByTestId('sales-transactions').getByRole('row', { name: /Invoice/ }),
  ).toContainText('266.50');

  // --- Pay the agency ---------------------------------------------------------------------------
  await page.goto(`${companyPath}/sales-tax`);
  const summary = page.getByTestId('agency-summaries');
  await expect(summary).toContainText('Owed to date');
  await expect(summary).toContainText('$16.50');
  await page.getByRole('button', { name: 'Record payment' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Date').fill(`${year}-04-15`);
  await dialog.getByLabel('Amount').fill('16.50');
  await dialog.getByLabel('Paid from').selectOption({ label: 'Checking' });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('tax-activity')).toContainText('16.50');
  await shot(page, '72-sales-tax-owed');

  // --- Profit and Loss by month, exported to Excel ------------------------------------------
  await go(page, 'r');
  await page.getByRole('link', { name: 'Profit and Loss', exact: true }).click();
  await page.getByLabel('From', { exact: true }).fill(`${year}-01-01`);
  await page.getByLabel('To', { exact: true }).fill(`${year}-03-31`);
  await page.getByLabel('Display columns by').selectOption('months');
  await page.getByRole('button', { name: 'Run report' }).click();
  const table = page.getByTestId('report-table');
  await expect(table).toContainText(`Jan ${year}`);
  await expect(table.getByRole('row', { name: /^Sales/ })).toContainText('250.00');
  await shot(page, '73-pl-by-month');
  await page.getByLabel('Export').click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel' }).click();
  expect((await download).suggestedFilename()).toBe(`Profit-and-Loss-${year}-03-31.xlsx`);

  // --- Memorize it and email it every Monday ------------------------------------------------
  await page.getByRole('button', { name: 'Memorize' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Quarter P&L by month');
  await dialog.getByRole('button', { name: 'Memorize' }).click();
  const memorized = page.getByTestId('memorized-reports');
  await expect(memorized).toContainText('Quarter P&L by month');
  await memorized.getByRole('button', { name: 'Email on a schedule…' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Frequency').selectOption('weekly');
  await dialog.getByLabel('Day').selectOption('1');
  await dialog.getByLabel('Hour').selectOption('7');
  await dialog.getByLabel('Time zone').fill('America/Chicago');
  await dialog.getByLabel('Email to').fill('books@harbor.example');
  await dialog.getByRole('button', { name: 'Save schedule' }).click();
  await expect(memorized).toContainText(
    'Emailed every Monday at 7:00 AM (America/Chicago) to books@harbor.example',
  );
  await shot(page, '74-memorized-reports');
  await memorized.getByRole('link', { name: 'Quarter P&L by month' }).click();
  await expect(page.getByTestId('report-table')).toContainText(`Mar ${year}`);

  // --- A budget, and Budget vs. Actuals ------------------------------------------------------
  await page.goto(`${companyPath}/reports/budgets`);
  await page.getByLabel('Budget name').fill(`FY${year}`);
  await page.getByLabel('First month').fill(`${year}-01`);
  await page.getByRole('button', { name: 'Create budget' }).click();
  await expect(page.getByTestId('budget-grid')).toBeVisible();
  const jan = `Jan ${String(year).slice(2)}`;
  await page.getByLabel(`Sales ${jan}`).fill('300');
  await page.getByRole('button', { name: 'Copy Sales across' }).click();
  await expect(page.getByTestId('budget-net-income')).toHaveText('3,600.00');
  await page.getByRole('button', { name: 'Save budget' }).click();
  await expect(page.getByText('Budget saved.')).toBeVisible();
  await page.getByRole('link', { name: 'Budget vs. Actuals' }).click();
  await page.getByLabel('To', { exact: true }).fill(`${year}-03-31`);
  await page.getByRole('button', { name: 'Run report' }).click();
  const bva = page.getByTestId('report-table');
  // Sales: 250 actual against 900 budgeted for January–March.
  await expect(bva.getByRole('row', { name: /^Sales/ })).toContainText('250.00');
  await expect(bva.getByRole('row', { name: /^Sales/ })).toContainText('900.00');
  await expect(bva.getByRole('row', { name: /^Sales/ })).toContainText('27.78%');
  await shot(page, '75-budget-vs-actuals');

  // --- Custom report --------------------------------------------------------------------------
  await page.goto(`${companyPath}/reports/custom`);
  const builder = page.getByTestId('custom-builder');
  await builder.getByLabel('Report title').fill('Sales tax postings');
  await builder.getByLabel('From', { exact: true }).fill(`${year}-01-01`);
  await builder.getByLabel('To', { exact: true }).fill(`${year}-12-31`);
  await builder.getByLabel('Group by').selectOption('account');
  await builder.getByRole('button', { name: 'Run report' }).click();
  const custom = page.getByTestId('report-table');
  await expect(custom).toContainText('Total for Sales Tax Payable');
  await expect(page.getByRole('heading', { name: 'Sales tax postings' })).toBeVisible();
  await shot(page, '76-custom-report');

  // --- Sales Tax Liability ---------------------------------------------------------------------
  await page.goto(`${companyPath}/reports/sales-tax-liability?from=${year}-01-01&to=${year}-03-31`);
  const liability = page.getByTestId('report-table');
  await expect(liability.getByRole('row', { name: /State \(6\.25%\)/ })).toContainText('12.50');
  await expect(liability.getByRole('row', { name: /^TOTAL/ })).toContainText('16.50');
  await shot(page, '77-sales-tax-liability');
});
