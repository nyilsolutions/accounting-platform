import { expect, test, type Page } from '@playwright/test';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

const SERVICES = 'Services (Income account)';

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

test('multi-currency: a euro customer invoiced and paid, with the gain realized and revalued', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Fran Exchange', uniqueEmail('phase10c'));
  await page.getByLabel('Legal business name').fill('Atlantic Trading LLC');
  await page.getByLabel('Employer Identification Number (EIN)').fill('12-3456789');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Atlantic Trading LLC' })).toBeVisible();
  const companyId = /\/c\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const c = `/companies/${companyId}`;

  // --- Turn on multi-currency and add the euro ----------------------------------------------
  await page.goto(`/c/${companyId}/settings`);
  const card = page.getByTestId('currency-settings');
  await card.getByRole('button', { name: 'Turn on multi-currency' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn on' }).click();
  await expect(card.getByText('Multi-currency is on.')).toBeVisible();
  await card.getByLabel('Add a currency').selectOption('EUR');
  await card.getByRole('button', { name: 'Add' }).click();
  await expect(card.getByTestId('currency-list')).toContainText('EUR – Euro');

  // --- A rate for March ---------------------------------------------------------------------
  await card.getByRole('link', { name: /Exchange rates and revaluation/ }).click();
  await page.getByLabel('Rate currency').selectOption('EUR');
  await page.getByLabel('Date', { exact: true }).fill('2026-03-01');
  await page.getByLabel('US dollars per unit').fill('1.085');
  await page.getByRole('button', { name: 'Save rate' }).click();
  await expect(page.getByText('1 EUR = 1.0850 USD on')).toBeVisible();
  await expect(page.getByTestId('rates-table')).toContainText('1.0850');
  await shot(page, '107-exchange-rates');

  // --- A customer in euros ------------------------------------------------------------------
  await page.goto(`/c/${companyId}/sales/customers`);
  await page.getByRole('button', { name: 'New customer' }).click();
  await page.getByLabel('Customer display name').fill('Rhein Logistik GmbH');
  await page.getByLabel('Currency').selectOption('EUR');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('link', { name: 'Rhein Logistik GmbH' })).toBeVisible();

  // --- An invoice in euros, booked in dollars ------------------------------------------------
  await page.goto(`/c/${companyId}/sales/invoices/new`);
  await page.getByLabel('Customer', { exact: true }).selectOption({ label: 'Rhein Logistik GmbH' });
  await page.getByLabel('Invoice date').fill('2026-03-10');
  await expect(page.getByLabel('Exchange rate')).toHaveValue('1.0850');
  await page.getByLabel('Line 1 product or service').selectOption({ label: SERVICES });
  await page.getByLabel('Line 1 description').fill('Freight forwarding, March');
  await page.getByLabel('Line 1 amount').fill('1000');
  await expect(page.getByTestId('home-amount')).toHaveText('€1,000.00 = $1,085.00');
  await expect(page.getByTestId('document-totals')).toContainText('€1,000.00');
  await shot(page, '108-foreign-invoice');
  await page.getByRole('button', { name: 'Save and close' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${companyId}/sales$`));
  const customers = await api<Array<{ id: string; displayName: string }>>(
    page,
    'GET',
    `${c}/customers`,
  );
  const rhein = customers.find((x) => x.displayName === 'Rhein Logistik GmbH')!;

  // --- Paid at a better rate: a $15 realized gain --------------------------------------------
  await page.goto(`/c/${companyId}/sales/payments/new?customerId=${rhein.id}`);
  await page.getByLabel('Customer').selectOption({ label: 'Rhein Logistik GmbH' });
  await page.getByLabel('Payment date').fill('2026-03-20');
  await page.getByLabel('Amount received').fill('1000');
  await page.getByLabel('Amount received').blur();
  await page.getByLabel('Exchange rate').fill('1.10');
  await page.getByLabel('Deposit to').selectOption({ label: 'Checking' });
  await expect(page.getByTestId('home-amount')).toHaveText('€1,000.00 = $1,100.00');
  await page.getByRole('button', { name: 'Save and close' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${companyId}/sales$`));
  const txns = await api<{ transactions: Array<{ id: string; txnType: string }> }>(
    page,
    'GET',
    `${c}/sales/transactions?type=payment`,
  );
  await page.goto(`/c/${companyId}/sales/payments/${txns.transactions[0]!.id}`);
  await expect(page.getByTestId('exchange-gain-loss')).toHaveText('$15.00');

  // --- An open invoice revalued at month end -------------------------------------------------
  await api(page, 'PUT', `${c}/currencies/rates`, {
    currency: 'EUR',
    rateDate: '2026-03-31',
    rate: '1.12',
  });
  const accounts = await api<Array<{ id: string; name: string }>>(page, 'GET', `${c}/accounts`);
  await api(page, 'POST', `${c}/sales/invoices`, {
    customerId: rhein.id,
    txnDate: '2026-03-15',
    exchangeRate: '1.085',
    lines: [{ accountId: accounts.find((a) => a.name === 'Services')!.id, amount: '500' }],
  });
  await page.goto(`/c/${companyId}/accounting/currencies`);
  const reval = page.getByTestId('revaluation');
  await reval.getByLabel('As of').fill('2026-03-31');
  await reval.getByRole('button', { name: 'Preview' }).click();
  // €500 in the books at $542.50 is worth $560.00 at 1.12.
  await expect(reval.getByTestId('revaluation-preview')).toContainText('$542.50');
  await expect(reval.getByTestId('revaluation-total')).toHaveText('$17.50');
  await shot(page, '109-revaluation');
  await reval.getByRole('button', { name: 'Post revaluation' }).click();
  await expect(page.getByTestId('revaluation-detail')).toContainText('Reversed on');
  await expect(page.getByTestId('revaluation-detail')).toContainText('$17.50');

  // --- The chart of accounts shows A/R (EUR) in euros and dollars ------------------------------
  await page.goto(`/c/${companyId}/accounting`);
  const row = page.getByRole('row', { name: /Accounts Receivable \(EUR\)/ });
  await expect(row).toContainText('€500.00');
});
