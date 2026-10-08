import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { sql, type Db } from '@acct/db';
import { APP_CONFIG, type AppConfig } from '../../config';
import { DB } from '../../db/db.module';
import { DepositPartnerService } from './deposit-partner.service';
import { EftpsService } from './eftps.service';

const POLL_MS = 15 * 60_000;

/**
 * Asks EFTPS and the payments partner what changed (ADR 0025): pending enrollments, scheduled
 * tax payments and submitted deposit batches, across companies through the security-definer
 * lookup `app_payroll_partner_waiting` (ids only), each then handled inside its company.
 */
@Injectable()
export class PartnersPollerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('PayrollPartners');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly eftps: EftpsService,
    private readonly deposits: DepositPartnerService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.PAYROLL_PARTNER_POLLER !== 'on') return;
    if (!this.eftps.provider && !this.deposits.partner) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.pollAll()
        .catch((e) => this.logger.error(`Partner poll failed: ${String(e)}`))
        .finally(() => (this.running = null));
    }, POLL_MS);
    this.timer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
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
