import { expect, test, type Page } from '@playwright/test';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

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

test('accountant tools: fix undeposited funds, reclassify, write off, review, close the month', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Pat Partner', uniqueEmail('phase10d'));
  await page.getByLabel('Legal business name').fill('Corner Bakery LLC');
  await page.getByLabel('Employer Identification Number (EIN)').fill('12-3456789');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Corner Bakery LLC' })).toBeVisible();
  const companyId = /\/c\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const c = `/companies/${companyId}`;

  // --- The client's March: a few mistakes to fix --------------------------------------------
  const accounts = await api<Array<{ id: string; name: string }>>(page, 'GET', `${c}/accounts`);
  const acct = (n: string) => accounts.find((a) => a.name === n)!.id;
  const cafe = await api<{ id: string }>(page, 'POST', `${c}/customers`, {
    displayName: 'Main Street Cafe',
  });
  const inv = await api<{ id: string }>(page, 'POST', `${c}/sales/invoices`, {
    customerId: cafe.id,
    txnDate: '2026-03-02',
    lines: [{ accountId: acct('Sales'), amount: '320' }],
  });
  await api(page, 'POST', `${c}/payments`, {
    customerId: cafe.id,
    txnDate: '2026-03-05',
    amount: '320',
    applications: [{ targetId: inv.id, amount: '320' }],
  });
  await api(page, 'POST', `${c}/deposits`, {
    txnDate: '2026-03-06',
    depositAccountId: acct('Checking'),
    lines: [{ accountId: acct('Sales'), amount: '320', customerId: cafe.id }],
  });
  await api(page, 'POST', `${c}/purchases/expenses`, {
    txnDate: '2026-03-10',
    paymentAccountId: acct('Checking'),
    lines: [
      { accountId: acct('Uncategorized Expense'), description: 'Mixer blades', amount: '64.50' },
    ],
  });
  const old = await api<{ id: string }>(page, 'POST', `${c}/sales/invoices`, {
    customerId: cafe.id,
    txnDate: '2026-01-05',
    dueDate: '2026-01-05',
    number: 'OLD-1',
    lines: [{ accountId: acct('Sales'), amount: '45' }],
  });

  // --- Fix undeposited funds -------------------------------------------------------------------
  await page.goto(`/c/${companyId}/accounting/tools`);
  await page.getByRole('link', { name: /Fix undeposited funds/ }).click();
  await expect(page.getByTestId('deposit-lines')).toContainText('recorded to Sales');
  await shot(page, '110-fix-undeposited');
  await page.getByRole('button', { name: 'Match to 1 payment' }).click();
  await expect(page.getByText(/now takes the payment from Undeposited Funds/)).toBeVisible();
  await expect(page.getByText('No deposit lines were entered straight to income.')).toBeVisible();

  // --- Reclassify the uncategorized expense ------------------------------------------------------
  await page.goto(`/c/${companyId}/accounting/tools/reclassify`);
  await page.getByLabel('Filter by account').selectOption({ label: 'Uncategorized Expense' });
  await page.getByLabel('From').fill('2026-03-01');
  await page.getByLabel('To').fill('2026-03-31');
  const lines = page.getByTestId('reclassify-lines');
  await expect(lines.getByRole('row')).toHaveCount(2);
  await lines.getByRole('checkbox', { name: /Mixer blades/ }).check();
  await page.getByLabel('New account').selectOption({ label: 'Repairs and Maintenance' });
  await shot(page, '111-reclassify');
  await page.getByRole('button', { name: 'Reclassify 1 line' }).click();
  await expect(page.getByText('1 line in 1 transaction reclassified.')).toBeVisible();

  // --- Write off the old invoice ---------------------------------------------------------------
  await page.goto(`/c/${companyId}/accounting/tools/write-off`);
  await page.getByLabel('At least this many days past due').fill('30');
  await page.getByLabel('As of').fill('2026-03-31');
  await page.getByRole('checkbox', { name: 'Write off invoice OLD-1' }).check();
  await page.getByLabel('Write-off date').fill('2026-03-31');
  await page.getByRole('button', { name: 'Write off 1 invoice' }).click();
  await expect(page.getByText('1 invoice written off: $45.00.')).toBeVisible();
  const written = await api<{ balance: string }>(page, 'GET', `${c}/sales/invoices/${old.id}`);
  expect(written.balance).toBe('0.00');

  // --- Review the client's changes -------------------------------------------------------------
  await page.goto(`/c/${companyId}/accounting/tools/review`);
  await expect(page.getByTestId('client-change').first()).toBeVisible();
  await page.getByRole('button', { name: 'Mark all shown reviewed' }).click();
  await expect(page.getByText('Nothing here.')).toBeVisible();

  // --- Close March -----------------------------------------------------------------------------
  await page.goto(`/c/${companyId}/accounting/tools/close`);
  await page.getByLabel('Month to close').fill('2026-03');
  const checklist = page.getByTestId('close-checklist');
  await expect(checklist).toContainText('Undeposited Funds is empty.');
  await expect(checklist).toContainText('Nothing uncategorized this month.');
  await page
    .getByLabel('Note for Reconcile every bank and credit card account')
    .fill('Ties to the March bank statement');
  await page.getByRole('button', { name: 'Mark done' }).first().click();
  await expect(page.getByText(/is marked done/)).toBeVisible();
  await page.getByLabel('Note for Review A/R and A/P aging').fill('Looked over');
  await page.getByRole('button', { name: 'Mark done' }).click();
  await expect(checklist).toContainText('Marked done by Pat Partner: Looked over');
  await page.getByLabel('Closing password (new)').fill('march-is-closed');
  await shot(page, '112-close-books');
  await page.getByRole('button', { name: /^Close / }).click();
  await expect(page.getByText('The books are closed through 03/31/2026.')).toBeVisible();
  await expect(page.getByTestId('closes')).toContainText('by Pat Partner');

  // --- The Adjusted Trial Balance ---------------------------------------------------------------
  await page.goto(`/c/${companyId}/reports/adjusted-trial-balance?to=2026-03-31`);
  await expect(
    page.getByTestId('report-table').getByRole('row', { name: /Repairs and Maintenance/ }),
  ).toContainText('64.50');
});
