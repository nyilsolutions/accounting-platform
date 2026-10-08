import { generateTotp } from '@acct/crypto';
import { expect, test } from '@playwright/test';
import { latestInviteLink, PASSWORD, registerWithMfa, shot, uniqueEmail } from './helpers';

test('owner signs up with MFA, creates a company, invites an accountant who joins', async ({
  page,
  browser,
}) => {
  const ownerEmail = uniqueEmail('owner');
  const accountantEmail = uniqueEmail('cpa');

  // --- Sign up + mandatory MFA -----------------------------------------------------------
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('link', { name: 'Create an account' }).click();
  const secret = await registerWithMfa(page, 'Olivia Owner', ownerEmail, true);

  // --- First company ---------------------------------------------------------------------
  await expect(page.getByRole('heading', { name: 'Set up your first company' })).toBeVisible();
  await page.getByLabel('Legal business name').fill('Sample Landscaping Co.');
  await page.getByLabel('Employer Identification Number (EIN)').fill('12-3456789');
  await page.getByLabel('Street address').fill('100 Main St');
  await page.getByLabel('City').fill('Austin');
  await page.getByLabel('State').selectOption('TX');
  await page.getByLabel('ZIP code').fill('78701');
  await page.getByLabel('Income tax form').selectOption('form_1120s');
  await shot(page, '04-create-company');
  await page.getByRole('button', { name: 'Create company' }).click();

  await expect(page.getByRole('heading', { name: 'Sample Landscaping Co.' })).toBeVisible();
  await expect(page.getByText('**-***6789')).toBeVisible();
  await shot(page, '05-dashboard');

  // --- Payroll starts with its setup ------------------------------------------------------
  await page.getByRole('link', { name: 'Payroll' }).click();
  await expect(page.getByRole('button', { name: 'Set up payroll' })).toBeVisible();

  // --- Keyboard shortcut: g u -> Users & roles -----------------------------------------
  await page.locator('body').click();
  await page.keyboard.press('g');
  await page.keyboard.press('u');
  await expect(page.getByRole('heading', { name: 'Users & roles' })).toBeVisible();
  await page.getByLabel('Email').fill(accountantEmail);
  await page.getByLabel('Role', { exact: true }).selectOption('accountant');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByText(`Invitation sent to ${accountantEmail}.`)).toBeVisible();
  await expect(page.getByText('Pending invitations')).toBeVisible();
  await shot(page, '06-users');

  // --- Company settings: edit + reveal EIN ---------------------------------------------
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(page.getByRole('heading', { name: 'Company settings' })).toBeVisible();
  await page.getByLabel('Phone').fill('(512) 555-0100');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.getByRole('button', { name: /Show full EIN/ }).click();
  await expect(page.getByText('12-3456789')).toBeVisible();

  // --- Command palette: Ctrl+K -> Audit log ------------------------------------------
  await page.keyboard.press('Control+k');
  await page.getByLabel('Search commands').fill('audit');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  for (const action of [
    'company.created',
    'member.invited',
    'company.updated',
    'company.ein_revealed',
  ]) {
    await expect(page.getByRole('cell', { name: action, exact: true })).toBeVisible();
  }
  await shot(page, '07-audit-log');

  // --- Accountant accepts the invitation in a separate browser ------------------------
  const cpaContext = await browser.newContext();
  const cpa = await cpaContext.newPage();
  await cpa.goto(latestInviteLink(accountantEmail));
  await expect(cpa.getByRole('heading', { name: 'Join Sample Landscaping Co.' })).toBeVisible();
  await cpa.getByRole('link', { name: 'Create account' }).click();
  await registerWithMfa(cpa, 'Andy Accountant', accountantEmail);
  await expect(cpa.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
  await cpa.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(cpa.getByRole('heading', { name: 'Sample Landscaping Co.' })).toBeVisible();
  await expect(
    cpa.getByTestId('company-switcher').locator('..').getByText('Accountant'),
  ).toBeVisible();
  await cpaContext.close();

  // --- Owner signs out and back in with the second factor ----------------------------
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  await shot(page, '08-mfa-verify');
  await page.getByLabel(/6-digit code/).fill(generateTotp(secret, Date.now() + 30_000));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Your companies' })).toBeVisible();
  await shot(page, '09-companies');
});

test('protected pages redirect to sign-in', async ({ page }) => {
  await page.goto('/companies');
  await expect(page).toHaveURL(/\/login\?next=%2Fcompanies/);
});
