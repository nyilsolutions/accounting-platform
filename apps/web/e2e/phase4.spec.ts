import { expect, test, type Page } from '@playwright/test';
import { registerWithMfa, shot, uniqueEmail } from './helpers';

const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD
<BANKACCTFROM><BANKID>121000248<ACCTID>000123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260503<TRNAMT>-42.17<FITID>F1<NAME>SHELL OIL 5741</STMTTRN>
<STMTTRN><TRNTYPE>XFER<DTPOSTED>20260503<TRNAMT>-500.00<FITID>F2<NAME>ONLINE TRANSFER TO CARD</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260510<TRNAMT>3500.00<FITID>F3<NAME>MOBILE DEPOSIT</STMTTRN>
<STMTTRN><TRNTYPE>FEE<DTPOSTED>20260528<TRNAMT>-18.50<FITID>F4<NAME>MONTHLY SERVICE FEE</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>2939.33<DTASOF>20260531</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

async function go(page: Page, key: string) {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('g');
  await page.keyboard.press(key);
}

test('banking: transfer, upload, review, rules, register, reconcile, bank connection', async ({
  page,
}) => {
  await page.goto('/register');
  await registerWithMfa(page, 'Bea Banker', uniqueEmail('banking'));
  await page.getByLabel('Legal business name').fill('Sample Landscaping Co.');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await page.getByRole('button', { name: 'Create company' }).click();
  await expect(page.getByRole('heading', { name: 'Sample Landscaping Co.' })).toBeVisible();

  // --- Pay the credit card with a transfer (g f) ---------------------------------------------
  await go(page, 'f');
  await page.getByLabel('Transfer from').selectOption({ label: 'Checking' });
  await page.getByLabel('Transfer to').selectOption({ label: 'Credit Card' });
  await expect(page.getByText('This pays down the credit card.')).toBeVisible();
  await page.getByLabel('Transfer date').fill('2026-05-02');
  await page.getByLabel('Transfer amount').fill('500');
  await page.getByRole('button', { name: 'Save and close' }).click();
  await expect(page.getByRole('heading', { name: 'Banking' })).toBeVisible();

  // --- Upload a Web Connect file ---------------------------------------------------------------
  await page.getByRole('link', { name: 'Upload transactions' }).click();
  await page.getByLabel('Bank file').setInputFiles({
    name: 'May.qbo',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(OFX),
  });
  await expect(page.getByTestId('import-preview')).toContainText('SHELL OIL 5741');
  await shot(page, '40-upload');
  await page.getByRole('button', { name: 'Import 4 transactions' }).click();
  await expect(page.getByText(/4 transactions added for review/)).toBeVisible();
  await page.getByRole('link', { name: 'Review them' }).click();

  const feed = page.getByTestId('bank-feed');
  await expect(feed.getByRole('row', { name: /ONLINE TRANSFER/ })).toContainText('1 match');
  await shot(page, '41-for-review');

  // Match the bank transfer to the one entered.
  await feed.getByRole('button', { name: 'Match ONLINE TRANSFER TO CARD' }).click();
  await expect(page.getByText('1 done.')).toBeVisible();

  // Categorize the fuel purchase as an expense.
  await feed
    .getByRole('row', { name: /SHELL OIL/ })
    .getByRole('button', { name: 'Review' })
    .click();
  const editor = page.getByTestId('feed-editor');
  await editor.getByLabel('Category').selectOption({ label: 'Car and Truck' });
  await shot(page, '42-categorize');
  await editor.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Added.')).toBeVisible();

  // Split the deposit between two income accounts.
  await feed
    .getByRole('row', { name: /MOBILE DEPOSIT/ })
    .getByRole('button', { name: 'Review' })
    .click();
  await editor.getByRole('button', { name: 'Split' }).click();
  await editor.getByLabel('Split 1 category').selectOption({ label: 'Services' });
  await editor.getByLabel('Split 1 amount').fill('3000');
  await editor.getByRole('button', { name: 'Add split line' }).click();
  await editor.getByLabel('Split 2 category').selectOption({ label: 'Sales' });
  await expect(editor.getByLabel('Split 2 amount')).toHaveValue('500.00');
  await editor.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Added.')).toBeVisible();

  // --- A bank rule categorizes the service fee -------------------------------------------------
  await page.getByRole('link', { name: 'Rules' }).click();
  await page.getByRole('button', { name: 'New rule' }).click();
  const rule = page.getByRole('dialog', { name: 'New rule' });
  await rule.getByLabel('Rule name').fill('Bank fees');
  await rule.getByLabel('Condition 1 value').fill('service fee');
  await rule.getByLabel('Category').selectOption({ label: 'Bank Charges and Fees' });
  await rule.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByTestId('bank-rules')).toContainText('Description contains "service fee"');
  await page.getByRole('link', { name: 'Bank transactions' }).click();
  const fee = feed.getByRole('row', { name: /MONTHLY SERVICE FEE/ });
  await expect(fee).toContainText('Rule: Bank fees');
  await fee.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Accept 1' }).click();
  await expect(page.getByText('1 done.')).toBeVisible();
  await expect(page.getByRole('tab', { name: /For review/ })).toContainText('(0)');
  await page.getByRole('tab', { name: /Categorized/ }).click();
  await expect(feed.getByRole('row')).toHaveCount(5);

  // --- Register --------------------------------------------------------------------------------
  await page.getByRole('link', { name: 'Go to register' }).click();
  await expect(page.getByTestId('register-balance')).toHaveText('$2,939.33');
  await expect(
    page.getByTestId('register').getByRole('row', { name: /Car and Truck/ }),
  ).toContainText('C');
  await shot(page, '43-register');

  // --- Reconcile (g z): everything the bank sent arrives ticked --------------------------------
  await go(page, 'z');
  await page.getByLabel('Statement ending date').fill('2026-05-31');
  await page.getByLabel('Ending balance').fill('2939.33');
  await page.getByRole('button', { name: 'Start reconciling' }).click();
  await expect(page.getByTestId('reconcile-difference')).toHaveText('0.00');
  await page.getByLabel(/Tick Expense .* -42.17/).click();
  await expect(page.getByTestId('reconcile-difference')).toHaveText('-42.17');
  await expect(page.getByRole('button', { name: 'Finish now' })).toBeDisabled();
  await page.getByLabel(/Tick Expense .* -42.17/).click();
  await expect(page.getByTestId('reconcile-difference')).toHaveText('0.00');
  await shot(page, '44-reconcile');
  await page.getByRole('button', { name: 'Finish now' }).click();
  await expect(page.getByTestId('reconciliation-report')).toContainText('Reconciliation Report');
  await expect(page.getByText('Cleared checks and payments (3)')).toBeVisible();
  await shot(page, '45-reconciliation-report');

  // --- Link a bank (development provider) --------------------------------------------------------
  await go(page, 'b');
  await page.getByRole('button', { name: 'Link account' }).click();
  await page.getByRole('button', { name: 'Connect First Mock Bank' }).click();
  const map = page.getByRole('dialog', { name: 'Connect First Mock Bank accounts' });
  await map.getByLabel('Books account for Business Checking').selectOption({ label: 'Savings' });
  await map.getByLabel('Books account for Business Visa').selectOption({ label: 'Credit Card' });
  await shot(page, '46-connect-bank');
  await map.getByRole('button', { name: 'Connect and download' }).click();
  await expect(map).toBeHidden();
  const savings = page.getByTestId('bank-account-card').filter({ hasText: 'Savings' });
  await expect(savings).toContainText('••1234');
  await expect(savings).toContainText('7');
  await expect(savings).toContainText('$8,650.00');
  await savings.click();
  await expect(feed.getByRole('row', { name: /GREEN SUPPLY CO/ })).toBeVisible();
  await shot(page, '47-bank-feed');

  // --- Dashboard ---------------------------------------------------------------------------------
  await go(page, 'd');
  await expect(page.getByTestId('dashboard-bank')).toContainText('Checking');
  await expect(page.getByTestId('dashboard-bank')).toContainText('2,939.33');
});
