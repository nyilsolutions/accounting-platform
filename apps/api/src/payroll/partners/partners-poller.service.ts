import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { sql, type Db } from '@acct/db';
import { DB } from '../../db/db.module';
import { JobQueue } from '../../jobs/job-queue.service';
import { DepositPartnerService } from './deposit-partner.service';
import { EftpsService } from './eftps.service';

/**
 * Asks EFTPS and the payments partner what changed (ADR 0025): pending enrollments, scheduled
 * tax payments and submitted deposit batches, across companies through the security-definer
 * lookup `app_payroll_partner_waiting` (ids only), each then handled inside its company. The
 * 'payroll.partners' job runs it every 15 minutes (ADR 0027); **Check now** runs it for one company.
 */
@Injectable()
export class PartnersPollerService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly eftps: EftpsService,
    private readonly deposits: DepositPartnerService,
    private readonly jobs: JobQueue,
  ) {}

  onModuleInit(): void {
    this.jobs.register('payroll.partners', async () =>
      this.eftps.provider || this.deposits.partner ? this.pollAll() : 0,
    );
  }

  /** Everything waiting on a provider, optionally for one company; returns the changes made. */
  async pollAll(companyId?: string): Promise<number> {
    const { rows } = await sql<{
      kind: 'enrollment' | 'payment' | 'batch';
      company_id: string;
      id: string;
      reference: string;
    }>`select * from app_payroll_partner_waiting(${this.eftps.provider?.name ?? ''}, ${this.deposits.partner?.name ?? ''})`.execute(
      this.db,
    );
    const byCompany = new Map<string, typeof rows>();
    for (const r of rows) {
      if (companyId && r.company_id !== companyId) continue;
      byCompany.set(r.company_id, [...(byCompany.get(r.company_id) ?? []), r]);
    }
    let applied = 0;
    for (const [company, list] of byCompany) {
      applied += await this.eftps.collect(
        company,
        list
          .filter((r) => r.kind !== 'batch')
          .map((r) => ({ kind: r.kind as 'enrollment' | 'payment', reference: r.reference })),
      );
      applied += await this.deposits.collect(
        company,
        list.filter((r) => r.kind === 'batch').map((r) => r.reference),
      );
    }
    return applied;
  }
}
