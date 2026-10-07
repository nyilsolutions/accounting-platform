import { generateTotp } from '@acct/crypto';
import { expect, type Page } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const OUTBOX_DIR = join(__dirname, '..', 'test-results', 'outbox');
export const SCREENSHOT_DIR = join(__dirname, '..', '..', '..', 'docs', 'screenshots');
export const PASSWORD = 'e2e-correct-horse-battery';

export function uniqueEmail(prefix: string): string {
  return `${prefix}+${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

/** Registers through the UI and completes MFA enrollment. Returns the TOTP secret. */
export async function registerWithMfa(
  page: Page,
  fullName: string,
  email: string,
  screenshots = false,
): Promise<string> {
  await page.getByLabel('Full name').fill(fullName);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  if (screenshots) await shot(page, '01-register');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible();
  const secret = (await page.getByTestId('mfa-secret').innerText()).replace(/\s/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  if (screenshots) await shot(page, '02-mfa-setup');
  await page.getByLabel('6-digit code').fill(generateTotp(secret));
  await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
  await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
  if (screenshots) await shot(page, '03-recovery-codes');
  await page.getByRole('button', { name: /I saved my codes/ }).click();
  return secret;
}

export function latestInviteLink(to: string): string {
  const files = readdirSync(OUTBOX_DIR).sort().reverse();
  for (const f of files) {
    const msg = JSON.parse(readFileSync(join(OUTBOX_DIR, f), 'utf8')) as {
      to: string;
      text: string;
    };
    if (msg.to === to) {
      const m = msg.text.match(/https?:\/\/[^\s]+\/invite\/[\w-]+/);
      if (m) return new URL(m[0]).pathname;
    }
  }
  throw new Error(`No invitation email for ${to}`);
}

/** The path of the latest emailed link to `to` under `path` (e.g. '/portal/customer/sign-in'). */
export function latestLink(to: string, path: string): string {
  const files = readdirSync(OUTBOX_DIR).sort().reverse();
  for (const f of files) {
    const msg = JSON.parse(readFileSync(join(OUTBOX_DIR, f), 'utf8')) as {
      to: string;
      text: string;
    };
    if (msg.to === to) {
      const m = msg.text.match(new RegExp(`https?://[^\\s]+${path}/[\\w-]+`));
      if (m) return new URL(m[0]).pathname;
    }
  }
  throw new Error(`No ${path} email for ${to}`);
}
