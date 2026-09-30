import { expect, test, type Page } from '@playwright/test';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

/** Sends an API request as the signed-in user (documents the earlier phases' tests cover). */
async function api(
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  data?: unknown,
) {
  return page.request.fetch(`/api${path}`, {
    method,
    headers: { 'x-csrf-protection': '1' },
    data,
  });
}
async function ok<T>(res: ReturnType<typeof api>): Promise<T> {
  const r = await res;
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as T;
}

test('inventory: items and an assembly, buy, build, adjust, refuse to oversell, value it', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Ivan Inventory', uniqueEmail('phase10a'));
  await page.getByLabel('Legal business name').fill('Stoneyard Supply');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Stoneyard Supply' })).toBeVisible();
  const companyId = /\/c\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const c = `/companies/${companyId}`;

  // --- Items, through the product form -------------------------------------------------------
  await page.goto(`/c/${companyId}/sales/products`);
  const addItem = async (name: string, type: string, extra: () => Promise<void>) => {
    await page.getByRole('button', { name: 'New product or service' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Name').fill(name);
    await d.getByLabel('Type').selectOption({ label: type });
    await extra();
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(d).toBeHidden();
  };
  await addItem('Paver', 'Inventory', async () => {
    const d = page.getByRole('dialog');
    await d.getByLabel('Sales price / rate').fill('6');
    await d.getByLabel('Income account').selectOption({ label: 'Sales' });
    await d.getByLabel('Reorder point').fill('50');
  });
  await addItem('Sand bag', 'Inventory', async () => {
    const d = page.getByRole('dialog');
    await d.getByLabel('Reorder point').fill('8');
  });
  await addItem('Patio kit', 'Assembly', async () => {
    const d = page.getByRole('dialog');
    await d.getByLabel('Income account').selectOption({ label: 'Sales' });
    await d.getByRole('button', { name: 'Add component' }).click();
    await d.getByLabel('Component 1', { exact: true }).selectOption({ label: 'Paver' });
    await d.getByLabel('Component 1 qty').fill('4');
    await d.getByRole('button', { name: 'Add component' }).click();
    await d.getByLabel('Component 2', { exact: true }).selectOption({ label: 'Sand bag' });
    await d.getByLabel('Component 2 qty').fill('1');
  });
  await expect(page.getByRole('row', { name: /Patio kit/ })).toContainText('Assembly');

  // --- Buy them (bills are covered by Phase 3's tests) ----------------------------------------
  const items = await ok<Array<{ id: string; name: string }>>(api(page, 'GET', `${c}/items`));
  const id = (n: string) => items.find((i) => i.name === n)!.id;
  const vendor = await ok<{ id: string }>(
    api(page, 'POST', `${c}/vendors`, { displayName: 'Quarry Inc.' }),
  );
  await ok(
    api(page, 'POST', `${c}/purchases/bills`, {
      vendorId: vendor.id,
      txnDate: '2026-09-01',
      lines: [
        { itemId: id('Paver'), quantity: '100', rate: '2' },
        { itemId: id('Sand bag'), quantity: '10', rate: '5' },
      ],
    }),
  );

  // --- Build five kits ---------------------------------------------------------------------------
  await page.goto(`/c/${companyId}/inventory`);
  const stock = page.getByTestId('stock-table');
  await expect(stock.getByRole('row', { name: /Paver/ })).toContainText('200.00');
  await page.getByRole('link', { name: 'Build assembly' }).click();
  await page.getByLabel('Assembly').selectOption({ label: 'Patio kit' });
  await page.getByLabel('Quantity to build').fill('5');
  await page.getByLabel('Build date').fill('2026-09-05');
  const needs = page.getByTestId('build-components');
  await expect(needs.getByRole('row', { name: /Paver/ })).toContainText('20');
  await shot(page, '100-build-assembly');
  await page.getByRole('button', { name: 'Build and close' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${companyId}/inventory$`));
  // Four pavers at $2 and a bag at $5: $13 a kit.
  await expect(stock.getByRole('row', { name: /Patio kit/ })).toContainText('65.00');
  await expect(stock.getByRole('row', { name: /^Paver/ })).toContainText('80');

  // --- Count the stock: 70 pavers, not 80 ----------------------------------------------------
  await page.getByRole('link', { name: 'Adjust quantity' }).click();
  await page.getByLabel('Adjustment date').fill('2026-09-10');
  await page.getByLabel('Product 1').selectOption({ label: 'Paver' });
  await page.getByLabel('New quantity 1').fill('70');
  await expect(page.getByLabel('Change in quantity 1')).toHaveValue('-10');
  await page.getByRole('button', { name: 'Save and close' }).click();
  await expect(page).toHaveURL(new RegExp(`/c/${companyId}/inventory$`));
  await expect(stock.getByRole('row', { name: /^Paver/ })).toContainText('70');
  // Sand is down to 5, under its reorder point of 8.
  await expect(stock.getByRole('row', { name: /Sand bag/ })).toContainText('Reorder');
  await expect(page.getByTestId('inventory-transactions')).toContainText('Inventory Qty Adjust');
  await shot(page, '101-inventory');

  // --- Selling more than is on hand is refused ------------------------------------------------
  const customer = await ok<{ id: string }>(
    api(page, 'POST', `${c}/customers`, { displayName: 'Patio Pros' }),
  );
  const oversell = await api(page, 'POST', `${c}/sales/invoices`, {
    customerId: customer.id,
    txnDate: '2026-09-12',
    lines: [{ itemId: id('Patio kit'), quantity: '6', rate: '40' }],
  });
  expect(oversell.status()).toBe(409);
  expect((await oversell.json()).message).toContain('Not enough "Patio kit" on hand');
  await ok(
    api(page, 'POST', `${c}/sales/invoices`, {
      customerId: customer.id,
      txnDate: '2026-09-12',
      lines: [{ itemId: id('Patio kit'), quantity: '2', rate: '40' }],
    }),
  );

  // --- The valuation matches the balance sheet ----------------------------------------------
  await page.goto(`/c/${companyId}/reports/inventory-valuation-summary?to=2026-09-30`);
  const table = page.getByTestId('report-table');
  // 70 pavers at $2 ($140) + 5 bags at $5 ($25) + 3 kits at $13 ($39) = $204.
  await expect(table.getByRole('row', { name: /TOTAL/ })).toContainText('204.00');
  await shot(page, '102-inventory-valuation');
  await page.goto(`/c/${companyId}/reports/balance-sheet?to=2026-09-30`);
  await expect(
    page.getByTestId('report-table').getByRole('row', { name: /Inventory Asset/ }),
  ).toContainText('204.00');

  // --- The costing method is now fixed ----------------------------------------------------------
  await page.goto(`/c/${companyId}/settings`);
  await expect(page.getByLabel('Inventory costing method')).toBeDisabled();
});
