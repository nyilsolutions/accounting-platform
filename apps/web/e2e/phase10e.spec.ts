import { expect, test, type Page } from '@playwright/test';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

/** Sends an API request as the signed-in user (setup that earlier tests cover). */
async function api<T>(
  page: Page,
  method: 'GET' | 'POST',
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

test('online payments: connect Stripe (stand-in), a customer pays by card, the payout is deposited', async ({
  page,
  browser,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Paula Owner', uniqueEmail('phase10e'));
  await page.getByLabel('Legal business name').fill('Corner Bakery LLC');
  await page.getByLabel('Employer Identification Number (EIN)').fill('12-3456789');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Corner Bakery LLC' })).toBeVisible();
  const companyId = /\/c\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const c = `/companies/${companyId}`;

  // --- Connect Stripe (the stand-in plays Stripe's onboarding) ---------------------------------
  await page.goto(`/c/${companyId}/settings`);
  const card = page.getByTestId('online-payments-settings');
  await card.getByLabel('Bank account for payouts').selectOption({ label: 'Checking' });
  await card.getByRole('button', { name: 'Connect Stripe (stand-in)' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your payments account' })).toBeVisible();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(card.getByText('Taking payments')).toBeVisible();
  await expect(card.getByLabel('Processing fees')).toHaveValue(/.+/);
  await card.scrollIntoViewIfNeeded();
  await shot(page, '113-online-payments-settings');

  // --- An invoice with a payment link -----------------------------------------------------------
  const accounts = await api<Array<{ id: string; name: string }>>(page, 'GET', `${c}/accounts`);
  const cafe = await api<{ id: string }>(page, 'POST', `${c}/customers`, {
    displayName: 'Main Street Cafe',
    email: 'ap@cafe.test',
  });
  const inv = await api<{ id: string }>(page, 'POST', `${c}/sales/invoices`, {
    customerId: cafe.id,
    txnDate: '2026-10-01',
    number: '1042',
    lines: [
      {
        accountId: accounts.find((a) => a.name === 'Sales')!.id,
        description: 'Pastry platters for the open house',
        amount: '250',
      },
    ],
  });
  await page.goto(`/c/${companyId}/sales/invoices/${inv.id}`);
  await page.getByRole('button', { name: 'Get payment link' }).click();
  const link = await page.getByLabel('Payment link').inputValue();
  expect(link).toMatch(/\/pay\/[A-Za-z0-9_-]{43}$/);

  // --- The customer pays (no sign-in) ------------------------------------------------------------
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(new URL(link).pathname);
  await expect(customer.getByRole('heading', { name: 'Invoice #1042' })).toBeVisible();
  await expect(customer.getByTestId('pay-balance')).toHaveText('$250.00');
  await shot(customer, '114-pay-invoice');
  await customer.getByRole('button', { name: 'Pay $250.00 by card' }).click();
  await expect(customer.getByText('Stripe stand-in · test mode')).toBeVisible();
  await customer.getByRole('button', { name: 'Pay with test card 4242' }).click();
  await expect(customer.getByText('Thank you. Your payment was received.')).toBeVisible();
  await customer.context().close();

  // --- The payment, then the payout as a deposit --------------------------------------------------
  await page.goto(`/c/${companyId}/sales/online-payments`);
  const payments = page.getByTestId('online-payment-list');
  await expect(payments.getByRole('row', { name: /1042/ })).toContainText('Paid');
  await page.getByRole('button', { name: 'Pay out now (stand-in)' }).click();
  const payout = page.getByTestId('payout').first();
  // $250.00 less the stand-in's card fee (2.9% + $0.30 = $7.55).
  await expect(payout).toContainText('242.45');
  await expect(payout).toContainText('Deposited');
  await shot(page, '115-online-payments');
  await payout.getByRole('link', { name: 'Deposit' }).click();
  await expect(page.getByText('Stand-in payout')).toBeVisible();

  const invoice = await api<{ balance: string }>(page, 'GET', `${c}/sales/invoices/${inv.id}`);
  expect(invoice.balance).toBe('0.00');
});
