import { generateTotp } from '@acct/crypto';
import { expect, test } from '@playwright/test';
import { createDb, sql } from '@acct/db';
import { PASSWORD, registerWithMfa, shot, uniqueEmail } from './helpers';

/** Phase 12c: the Security page, the step-up prompt and the strength meter (ADR 0029). */
const E2E_DB = process.env.E2E_DATABASE_NAME ?? 'acct_e2e';

/** Makes the user's last MFA code older than the step-up window, as time passing would. */
async function ageMfa(email: string): Promise<void> {
  const url = new URL(
    process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
  );
  url.pathname = `/${E2E_DB}`;
  const db = createDb(url.toString(), 1);
  await sql`update sessions set mfa_verified_at = now() - interval '1 hour'
            where user_id = (select id from users where email = ${email})`.execute(db);
  await db.destroy();
}

test('security settings: password strength, recovery codes, step-up, password change', async ({
  page,
}) => {
  await page.goto('/register');
  const email = uniqueEmail('phase12c');
  // The strength meter counts the person's own name against the password.
  await page.getByLabel('Full name').fill('Sam Secure');
  await page.getByLabel('Password', { exact: true }).fill('password1234');
  await expect(page.getByTestId('password-strength')).toContainText('Weak');
  await page.getByRole('button', { name: 'Show' }).first().click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByLabel('Password', { exact: true }).fill('');
  const secret = await registerWithMfa(page, 'Sam Secure', email);

  await page.goto('/companies');
  await page.getByTestId('security-settings').click();
  await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
  await expect(page.getByTestId('sessions')).toContainText('This browser');

  // Fresh from signing in: no prompt.
  await page.getByRole('button', { name: 'Make new recovery codes' }).click();
  await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
  await shot(page, '126-security-settings');

  // Later: changing the password asks for a fresh code first, then goes through.
  await ageMfa(email);
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('New password').fill('a-new-and-better-passphrase');
  await page.getByRole('button', { name: 'Change password' }).click();
  const prompt = page.getByTestId('step-up');
  await expect(prompt).toBeVisible();
  await shot(page, '127-step-up');
  await prompt.getByLabel('Authentication code').fill(generateTotp(secret, Date.now() + 30_000));
  await prompt.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Password changed.')).toBeVisible();
});

test('pages carry a nonce CSP and run without violations', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Content-Security-Policy/i.test(m.text()))
      violations.push(m.text());
  });
  const res = await page.goto('/login');
  const csp = res!.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res!.headers()['cache-control']).toContain('no-store');
  // Each page gets its own nonce.
  const again = await page.request.get('/login');
  expect(again.headers()['content-security-policy']).not.toBe(csp);

  await page.goto('/register');
  await registerWithMfa(page, 'Casey Policy', uniqueEmail('phase12c-csp'));
  await page.goto('/companies');
  await expect(page.getByTestId('security-settings')).toBeVisible();
  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
  expect(violations).toEqual([]);
});
