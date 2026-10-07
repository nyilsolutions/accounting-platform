import { createHash, randomBytes } from 'node:crypto';
import { sql, type Tx } from '@acct/db';
import type { AppConfig } from '../config';

/**
 * Pay links (ADR 0022). A link is the customer's credential for one invoice: 32 random bytes,
 * of which only the SHA-256 is stored. Links are made when an invoice is emailed (or copied from
 * the invoice) and only while the company can take online payments.
 */
export function hashPayToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function payUrl(config: Pick<AppConfig, 'WEB_ORIGIN'>, token: string): string {
  return `${config.WEB_ORIGIN}/pay/${token}`;
}

/** Why the company can't take an online payment for this invoice, or null when it can. */
export async function payLinkRefusal(
  tx: Tx,
  config: Pick<AppConfig, 'PAYMENTS_PROVIDER'>,
  companyId: string,
  invoiceId: string,
): Promise<string | null> {
  if (config.PAYMENTS_PROVIDER === 'none') return 'Online payments are off.';
  const r = await sql<{
    status: string | null;
    charges_enabled: boolean | null;
    txn_type: string;
    txn_status: string;
    currency: string | null;
  }>`
    select pa.status, pa.charges_enabled, t.txn_type, t.status as txn_status, t.currency
    from transactions t
    left join payment_accounts pa on pa.company_id = t.company_id and pa.provider = ${config.PAYMENTS_PROVIDER}
    where t.company_id = ${companyId} and t.id = ${invoiceId}`.execute(tx);
  const row = r.rows[0];
  if (!row || row.txn_type !== 'invoice') return 'Only invoices can be paid online.';
  if (row.txn_status !== 'posted') return 'This invoice is void.';
  if (row.currency) return 'Online payments are in US dollars only.';
  if (row.status !== 'active' || !row.charges_enabled)
    return 'Connect Stripe in Company settings to take online payments.';
  return null;
}

/** A new link to pay the invoice (the token is returned once and never stored). */
export async function createPayLink(
  tx: Tx,
  companyId: string,
  invoiceId: string,
  userId: string | null,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await tx
    .insertInto('pay_links')
    .values({
      company_id: companyId,
      invoice_id: invoiceId,
      token_hash: hashPayToken(token),
      created_by: userId,
    })
    .execute();
  return token;
}
