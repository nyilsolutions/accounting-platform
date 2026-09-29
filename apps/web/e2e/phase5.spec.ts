import { expect, test, type Page } from '@playwright/test';
import { makePdf } from '../../api/src/documents/pdf-fixture';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

async function go(page: Page, key: string) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('g');
  await page.keyboard.press(key);
}

const pdf = (name: string, lines: string[]) => ({
  name,
  mimeType: 'application/pdf',
  buffer: makePdf(lines),
});

test('documents: library, folders, tags, preview, ZIP, receipts inbox, expense from a receipt, attachments', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Dana Docs', uniqueEmail('documents'));
  await page.getByLabel('Legal business name').fill('Sample Landscaping Co.');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Sample Landscaping Co.' })).toBeVisible();

  // A vendor for the receipt.
  await go(page, 'e');
  await page.getByRole('link', { name: 'Vendors', exact: true }).click();
  await page.getByRole('button', { name: 'New vendor' }).click();
  const vendor = page.getByRole('dialog', { name: 'New vendor' });
  await vendor.getByLabel('Vendor display name').fill('Home Depot');
  await vendor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('link', { name: 'Home Depot' })).toBeVisible();

  // --- Library (g o) ---------------------------------------------------------------------------
  await go(page, 'o');
  await expect(page.getByRole('heading', { name: 'Documents' })).toBeVisible();
  await page.getByLabel('Choose files').setInputFiles([
    pdf('Office lease.pdf', ['Office lease', '123 Main St', 'Term 12 months']),
    {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Landlord: call before June'),
    },
  ]);
  await expect(page.getByText('2 files uploaded.')).toBeVisible();
  const table = page.getByTestId('documents');
  await expect(table.getByRole('row', { name: /Office lease\.pdf/ })).toContainText('PDF');

  // A file that isn't accepted is refused by what it is.
  await page.getByLabel('Choose files').setInputFiles({
    name: 'invoice.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('<html><script>x</script>'),
  });
  await expect(page.getByText(/isn’t accepted/)).toBeVisible();

  // Preview, tags.
  await table.getByRole('button', { name: 'Office lease.pdf' }).click();
  const dialog = page.getByTestId('document-dialog');
  await expect(dialog.getByTitle('Preview of Office lease.pdf')).toBeVisible();
  await dialog.getByLabel('Tags').fill('lease, contracts');
  await dialog.getByRole('button', { name: 'Save details' }).click();
  await shot(page, '50-document-preview');
  await page.keyboard.press('Escape');

  // Full-text search reads inside the PDF.
  await page.getByLabel('Search documents').fill('term months');
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table).toContainText('Office lease.pdf');
  await page.getByLabel('Search documents').fill('');

  // Folders and moving.
  page.once('dialog', (d) => d.accept('Contracts'));
  await page.getByRole('button', { name: '+ New folder' }).click();
  await expect(page.getByRole('navigation', { name: 'Folders' })).toContainText('Contracts');
  await page.getByLabel('Select Office lease.pdf').check();
  await page.getByLabel('Move to folder').selectOption({ label: 'Contracts' });
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name: /Contracts/ })
    .click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table).toContainText('Office lease.pdf');

  // ZIP download of the chosen documents.
  await page.getByLabel('Select Office lease.pdf').check();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download 1 as ZIP' }).click();
  expect((await download).suggestedFilename()).toMatch(/^documents-\d{4}-\d{2}-\d{2}\.zip$/);
  await shot(page, '51-documents');

  // --- Receipts inbox (g q) ----------------------------------------------------------------------
  await go(page, 'q');
  await expect(page.getByTestId('receipts-inbox')).toBeVisible();
  await page
    .getByLabel('Choose files')
    .setInputFiles(
      pdf('hd-receipt.pdf', [
        'Home Depot #4410',
        '05/18/2026 14:02',
        'Lumber $89.97',
        'Sales Tax $7.42',
        'TOTAL $97.39',
      ]),
    );
  const inbox = page.getByTestId('receipts-inbox');
  const row = inbox.getByRole('row', { name: /hd-receipt\.pdf/ });
  await expect(row).toContainText('Home Depot #4410');
  await expect(row).toContainText('97.39');
  await shot(page, '52-receipts-inbox');
  await row.getByRole('link', { name: 'Review' }).click();

  // The proposed expense: vendor matched by name, amount and date from the receipt.
  await expect(page.getByTestId('draft-notes')).toContainText('Vendor matched by name: Home Depot');
  await expect(page.getByLabel('Payee', { exact: true })).toHaveValue(/.+/);
  await expect(page.getByLabel('Line 1 amount')).toHaveValue('97.39');
  await page
    .getByLabel('Line 1 category or product')
    .selectOption({ label: 'Repairs and Maintenance (Expenses)' });
  await shot(page, '53-receipt-review');
  await page.getByRole('button', { name: 'Create expense' }).click();
  await expect(inbox).toContainText('The inbox is empty.');

  // --- The expense has the receipt attached ------------------------------------------------------
  await go(page, 'e');
  await page
    .getByTestId('purchase-transactions')
    .getByRole('row', { name: /Expense/ })
    .click();
  await expect(page.getByTestId('attachments')).toContainText('hd-receipt.pdf');
  await shot(page, '54-attachments');

  // --- Settings: retention and email-in ------------------------------------------------------------
  await go(page, 'c');
  await expect(page.getByLabel('Retention years')).toHaveValue('7');
});
