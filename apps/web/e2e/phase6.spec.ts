import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

const CSV = join(__dirname, '..', '..', 'api', 'test', 'fixtures', 'quickbooks', 'csv');

async function go(page: Page, key: string) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('g');
  await page.keyboard.press(key);
}

async function newCompany(page: Page, name: string) {
  await page.goto('/companies');
  await page.getByRole('button', { name: 'New company' }).click();
  await page.getByLabel('Legal business name').fill(name);
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

test('QuickBooks migration: connect, pull, import, tie out, match attachments, complete; CSV wizard', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Quinn Migrator', uniqueEmail('migration'));
  await page.getByLabel('Legal business name').fill('Sunrise Landscaping LLC');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Sunrise Landscaping LLC' })).toBeVisible();

  // --- Start a QuickBooks Online migration (g i) ----------------------------------------------
  await go(page, 'i');
  await expect(page.getByRole('heading', { name: 'Import from QuickBooks' })).toBeVisible();
  await shot(page, '60-import-hub');
  await page.getByRole('button', { name: 'Start with QuickBooks Online' }).click();
  await page.getByRole('button', { name: 'Connect to QuickBooks Online' }).click();
  // The development connector stands in for Intuit's sign-in and comes straight back.
  await expect(
    page.getByText('Connected to QuickBooks Online. Pull the company next.'),
  ).toBeVisible();
  await expect(page.getByTestId('qbo-panel')).toContainText('Connected to Sunrise Landscaping');
  await page.getByRole('button', { name: 'Pull from QuickBooks' }).click();
  const counts = page.getByTestId('record-counts');
  await expect(counts.getByRole('row', { name: /Invoices/ })).toContainText('3');

  // --- Import and the Migration Report -------------------------------------------------------
  await page.getByRole('button', { name: 'Run the import' }).click();
  const report = page.getByTestId('tie-out');
  await expect(report).toContainText('Every figure ties out', { timeout: 30_000 });
  await expect(page.getByTestId('tb-2024-12-31')).toContainText('Ties out');
  await expect(page.getByTestId('ar-aging')).toContainText('Ties out');
  // The record list refreshes when the import finishes.
  await expect(page.getByTestId('records')).not.toContainText('pending');
  await expect(page.getByTestId('records')).toContainText('imported');
  await shot(page, '61-migration-report');

  // Drill into an account: the transactions behind its balance.
  await page
    .getByTestId('tb-2025-02-15')
    .getByRole('button', { name: /All \d+ rows/ })
    .click();
  await page.getByTestId('tb-2025-02-15').getByRole('button', { name: 'Utilities' }).click();
  const drill = page.getByTestId('drill');
  await expect(drill).toContainText('CU-2025-01');
  await expect(drill).toContainText('180.25');
  await shot(page, '62-drill-down');
  await page.keyboard.press('Escape');

  // --- Match the one attachment QuickBooks had on a time activity ---------------------------
  await page.getByRole('link', { name: 'Match attachments (1)' }).click();
  await expect(page.getByTestId('attachment-files')).toContainText(
    'Oak Hills invoice 1050 signed.pdf',
  );
  const choices = page.getByTestId('attachment-choices');
  await expect(choices).toContainText('Invoice 1050');
  await expect(choices).toContainText('Matches number 1050');
  await shot(page, '63-match-attachments');
  await choices
    .getByRole('listitem')
    .filter({ hasText: 'Invoice 1050' })
    .getByRole('button', { name: 'Attach' })
    .click();
  await expect(page.getByText('Every file is attached or set aside.')).toBeVisible();
  await page.getByRole('tab', { name: /Attached/ }).click();
  await expect(page.getByTestId('attachment-files')).toContainText('Metro Fuel receipt 1002.pdf');
  await page.getByRole('link', { name: /Back to Sunrise Landscaping/ }).click();

  // --- Complete ------------------------------------------------------------------------------
  await page.getByRole('button', { name: 'Mark the migration complete' }).click();
  await expect(page.getByText(/Completed .*tied out/)).toBeVisible();
  // The imported invoice is an ordinary invoice, with its discount and sales tax.
  await page.getByTestId('records').getByRole('link', { name: /^1037/ }).click();
  await expect(page.getByLabel('Invoice no.')).toHaveValue('1037');

  // --- CSV: map columns by their names, preview, add --------------------------------------------
  await newCompany(page, 'Harbor Bakery');
  await go(page, 'i');
  await page.getByRole('button', { name: 'Start with CSV and Excel exports' }).click();
  const wizard = page.getByTestId('csv-wizard');
  await wizard.getByLabel('File contents').selectOption('customers');
  await wizard.getByLabel('Choose a CSV file').setInputFiles({
    name: 'customers.csv',
    mimeType: 'text/csv',
    buffer: readFileSync(join(CSV, 'customers.csv')),
  });
  await expect(wizard.getByLabel('Column for Customer (full name)')).toHaveValue('0');
  await expect(wizard.getByLabel('Column for ZIP')).toHaveValue('7');
  await wizard.getByRole('button', { name: 'Preview' }).click();
  await expect(wizard.getByTestId('stage-result')).toContainText('2 records found');
  await shot(page, '64-csv-mapping');
  await wizard.getByRole('button', { name: 'Add 2 records' }).click();
  await expect(
    page.getByTestId('record-counts').getByRole('row', { name: /Customers/ }),
  ).toContainText('2');
  await page.getByRole('button', { name: 'Run the import' }).click();
  await expect(
    page.getByTestId('record-counts').getByRole('row', { name: /Customers/ }),
  ).toContainText(/2\s*2/);
});
