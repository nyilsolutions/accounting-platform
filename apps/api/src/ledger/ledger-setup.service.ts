import { Injectable } from '@nestjs/common';
import type { Tx } from '@acct/db';
import type { TaxForm } from '@acct/shared';
import {
  DEFAULT_PAYMENT_METHODS,
  DEFAULT_TERMS,
  defaultChartOfAccounts,
  type TemplateAccount,
} from './coa-template';

/** Creates a new company's starter lists: chart of accounts, terms and payment methods. */
@Injectable()
export class LedgerSetupService {
  async seedDefaults(tx: Tx, companyId: string, userId: string, taxForm: TaxForm): Promise<void> {
    await this.seedChartOfAccounts(tx, companyId, userId, taxForm);
    await tx
      .insertInto('terms')
      .values(DEFAULT_TERMS.map((t) => ({ company_id: companyId, ...t })))
      .execute();
    await tx
      .insertInto('payment_methods')
      .values(DEFAULT_PAYMENT_METHODS.map((name) => ({ company_id: companyId, name })))
      .execute();
  }

  async seedChartOfAccounts(
    tx: Tx,
    companyId: string,
    userId: string,
    taxForm: TaxForm,
  ): Promise<number> {
    let count = 0;
    const insert = async (a: TemplateAccount, parentId: string | null): Promise<void> => {
      const row = await tx
        .insertInto('accounts')
        .values({
          company_id: companyId,
          name: a.name,
          number: a.number,
          account_type: a.type,
          detail_type: a.detailType,
          system_role: a.systemRole ?? null,
          parent_id: parentId,
          description: null,
          created_by: userId,
          updated_by: userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      count++;
      for (const child of a.children ?? []) await insert(child, row.id);
    };
    for (const a of defaultChartOfAccounts(taxForm)) await insert(a, null);
    return count;
  }
}
